import { buildContext, buildWorkspaceSnapshot, WorkspaceSnapshot } from "./context.js";
import { runAST } from "../ast/engine.js";
import { RuleRegistry } from "../rules/registry.js";
import { compileControlPlaneToRules } from "../dsl/compiler.js";
import { Diagnostic, Trace } from "./types.js";
import { ControlPlane } from "../schema.js";
import { buildState, createEmptyExecutionState, createEmptyStatePlane, persistStatePlane, readStatePlane } from "./state.js";
import { runSemantic } from "../semantic/engine.js";
import { runCode } from "../code/engine.js";
import { runStrategy } from "../strategy/engine.js";
import { normalizeAST } from "../ast/model.js";
import { applyPatchesWithRoundTrip } from "../fix/engine.js";
import { Fix, FixConflict, PatchResult, isTextPatch } from "../fix/types.js";
import { ConflictTrace, RejectedFix, runConflictResolutionEngine } from "../fix/conflictEngine.js";
import { createZeroLengthLocation, makeDiagnosticId } from "./diagnostics.js";
import { createHash } from "crypto";
import path from "path";

function toStableFilePath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) {
    return filePath.split(path.sep).join("/");
  }

  return relative;
}

function createDeterministicRunId(input: PipelineInput): string {
  const serialized = JSON.stringify({
    controlPlane: input.controlPlane,
    workspace: {
      files: [...input.workspace.files]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((file) => ({
          path: toStableFilePath(input.workspace.root, file.path),
          content: file.content,
        })),
    },
  });

  return `run-${createHash("sha256").update(serialized).digest("hex").slice(0, 16)}`;
}

function applyFixesSafely(
  context: ReturnType<typeof buildContext>,
  astResult: ReturnType<typeof runAST>,
  fixes: Fix[],
  selectedFixes: Fix[],
  rejectedFixes: RejectedFix[],
  traceId: string
): { diagnostics: Diagnostic[]; appliedPatches: PatchResult[]; rolledBack: boolean } {
  if (selectedFixes.length === 0 && rejectedFixes.length === 0) {
    return {
      diagnostics: [],
      appliedPatches: [],
      rolledBack: false,
    };
  }

  const diagnostics: Diagnostic[] = [];
  const patchResults = new Map<string, PatchResult>();
  const rejectedById = new Map(rejectedFixes.map((rejection) => [rejection.fixId, rejection.reason]));
  const fixesById = new Map(fixes.map((fix) => [fix.id, fix]));
  const workingSourceByFile = new Map<string, { sourceFile: ReturnType<typeof normalizeAST>["sourceFile"]; normalizedAst: ReturnType<typeof normalizeAST> }>();

  for (const [filePath, normalizedAst] of Object.entries(astResult.normalizedAsts)) {
    const sourceFile = context.astMap.get(filePath) as ReturnType<typeof normalizeAST>["sourceFile"] | undefined;
    if (!sourceFile) {
      continue;
    }

    workingSourceByFile.set(filePath, {
      sourceFile,
      normalizedAst,
    });
  }

  for (const fix of selectedFixes) {
    rejectedById.delete(fix.id);
  }

  for (const [fixId, rejectionReason] of rejectedById.entries()) {
    const rejectedFix = fixesById.get(fixId);
    const patchCount = rejectedFix?.patches.length ?? 0;

    if (!rejectionReason) {
      continue;
    }

    if (patchCount === 0) {
      patchResults.set(`${fixId}:0`, {
        patchId: `${fixId}:0`,
        success: false,
        error: `Rejected fix (${rejectionReason})`,
      });
      continue;
    }

    for (let patchIndex = 0; patchIndex < patchCount; patchIndex += 1) {
      const patchId = `${fixId}:${patchIndex + 1}`;
      patchResults.set(patchId, {
        patchId,
        success: false,
        error: `Rejected fix (${rejectionReason})`,
      });
    }
  }

  let rollbackRequired = false;

  for (const fix of selectedFixes) {
    for (let patchIndex = 0; patchIndex < fix.patches.length; patchIndex += 1) {
      const patch = fix.patches[patchIndex];
      const patchId = `${fix.id}:${patchIndex + 1}`;

      if (rollbackRequired) {
        patchResults.set(patchId, {
          patchId,
          success: false,
          error: "Skipped due to rollback",
        });
        continue;
      }

      if (!isTextPatch(patch)) {
        patchResults.set(patchId, { patchId, success: true });
        continue;
      }

      const filePath = patch.location.file;
      const working = workingSourceByFile.get(filePath);
      if (!working) {
        patchResults.set(patchId, {
          patchId,
          success: false,
          error: `No AST context available for ${filePath}`,
        });

        diagnostics.push({
          id: makeDiagnosticId(["patch-resolution", patchId, filePath]),
          ruleId: "patch-resolution",
          message: `Unable to resolve patch target for ${filePath}`,
          severity: "error",
          location: createZeroLengthLocation(filePath),
          category: "AST",
          traceId,
        });
        rollbackRequired = true;
        continue;
      }

      const applyResult = applyPatchesWithRoundTrip(working.sourceFile, working.normalizedAst, [patch]);
      const firstPatchResult = applyResult.results?.[0];

      if (!applyResult.roundTripSafe || !firstPatchResult?.success) {
        const rawError = firstPatchResult?.error
          ?? applyResult.patchValidation.issues.map((issue) => issue.message).join(" | ")
          ?? applyResult.validation.issues.map((issue) => issue.message).join(" | ");
        const error = rawError.length > 0 ? rawError : "Unknown patch application error";

        patchResults.set(patchId, {
          patchId,
          success: false,
          error,
        });

        diagnostics.push({
          id: makeDiagnosticId(["patch-roundtrip", patchId, filePath]),
          ruleId: "patch-roundtrip",
          message: `Patch validation failed for ${filePath}: ${error}`,
          severity: "error",
          location: patch.location,
          category: "AST",
          traceId,
        });
        rollbackRequired = true;
        continue;
      }

      patchResults.set(patchId, { patchId, success: true });
      const updatedNormalized = normalizeAST(applyResult.ast, filePath);
      workingSourceByFile.set(filePath, {
        sourceFile: applyResult.ast,
        normalizedAst: updatedNormalized,
      });
    }
  }

  if (rollbackRequired) {
    for (const [patchId, result] of patchResults.entries()) {
      if (!result.success) {
        continue;
      }

      patchResults.set(patchId, {
        patchId,
        success: false,
        error: "Rolled back due to patch application failure",
      });
    }
  }

  return {
    diagnostics,
    appliedPatches: [...patchResults.values()].sort((left, right) => left.patchId.localeCompare(right.patchId)),
    rolledBack: rollbackRequired,
  };
}

export type PipelineInput = {
  controlPlane: ControlPlane;
  workspace: WorkspaceSnapshot;
  persistState?: boolean;
};

export type PipelineResult = {
  diagnostics: Diagnostic[];
  fixes: Fix[];
  selectedFixes: Fix[];
  rejectedFixes: RejectedFix[];
  appliedPatches: PatchResult[];
  conflicts: FixConflict[];
  conflictTrace: ConflictTrace;
  statePath: string;
  trace: Trace;
};

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const startTime = Date.now();
  const runId = createDeterministicRunId(input);
  const context = buildContext(input.workspace);
  const registry = new RuleRegistry();
  const executableRules = compileControlPlaneToRules(input.controlPlane);
  const phases: Trace["phases"] = ["AST", "SEMANTIC", "CODE", "STRATEGY"];

  for (const rule of executableRules) {
    registry.registerAST(rule);
  }

  // Enforce deterministic stage ordering across all runs.
  const astResult = runAST(context, registry, runId);
  const semanticResult = runSemantic(context, astResult.normalizedAsts, runId, {
    graph: astResult.semanticGraph,
    diagnostics: astResult.semanticDiagnostics,
  });
  const codeDiagnostics = runCode(context, runId);
  const strategyDiagnostics = await runStrategy(context, runId);

  const allFixes = [...astResult.fixes].sort((left, right) => left.id.localeCompare(right.id));
  const prePatchDiagnostics = [
    ...astResult.diagnostics,
    ...semanticResult.diagnostics,
    ...codeDiagnostics,
    ...strategyDiagnostics,
  ].sort((left, right) => left.id.localeCompare(right.id));

  const conflictResult = runConflictResolutionEngine({
    fixes: allFixes,
    diagnostics: prePatchDiagnostics,
    controlPlane: input.controlPlane,
  });

  const patchResult = applyFixesSafely(
    context,
    astResult,
    allFixes,
    conflictResult.selectedFixes,
    conflictResult.rejectedFixes,
    runId
  );

  const diagnostics = [
    ...prePatchDiagnostics,
    ...patchResult.diagnostics,
  ].sort((left, right) => left.id.localeCompare(right.id));

  const triggeredRuleIds = Array.from(new Set(diagnostics.map((diagnostic) => diagnostic.ruleId))).sort((a, b) => a.localeCompare(b));
  const astOverrideApplied = executableRules.some((rule) => rule.priority < 100);
  const shouldPersistState = input.persistState !== false;
  const previousState = shouldPersistState ? readStatePlane(input.workspace.root) : null;

  const projectedState = buildState({
    yaml: input.controlPlane,
    plans: input.controlPlane.execution.plans,
    previous: previousState ?? createEmptyStatePlane(),
  });

  const nextState = {
    ...projectedState,
    astIndex: astResult.astIndex,
    symbolGraph: astResult.symbolGraph,
    violations: diagnostics,
    metrics: {
      filesScanned: input.workspace.files.length,
      rulesEvaluated: executableRules.length,
      astDiagnostics: astResult.diagnostics.length,
      semanticDiagnostics: semanticResult.diagnostics.length,
      semanticCompilerDiagnostics: semanticResult.semanticDiagnostics.length,
      patchDiagnostics: patchResult.diagnostics.length,
      appliedPatches: patchResult.appliedPatches.filter((patch) => patch.success).length,
      codeDiagnostics: codeDiagnostics.length,
      strategyDiagnostics: strategyDiagnostics.length,
      diagnostics: diagnostics.length,
    },
    dependencyGraph: astResult.dependencyGraph,
    execution: previousState?.execution ?? createEmptyExecutionState(),
    strategyHistory: previousState?.strategyHistory ?? [],
    approvals: previousState?.approvals ?? [],
    pendingApprovals: previousState?.pendingApprovals ?? [],
  };

  const statePath = shouldPersistState
    ? persistStatePlane(input.workspace.root, nextState, {
      action: "pipeline-run",
      consistency: {
        yaml: input.controlPlane,
      },
    })
    : path.join(input.workspace.root, ".choir", "state.json");

  const trace: Trace = {
    runId,
    phases,
    rulesEvaluated: executableRules.map((rule) => rule.id),
    rulesTriggered: triggeredRuleIds,
    diagnosticsEmitted: diagnostics.map((diagnostic) => diagnostic.id),
    fixesGenerated: allFixes.map((fix) => fix.id),
    conflictsDetected: conflictResult.conflicts,
    decisions: [
      astOverrideApplied ? "AST override applied" : "AST default precedence retained",
      "Pipeline stage order: AST -> Semantic -> Code -> Strategy",
      `Evaluated ${executableRules.length} executable rules`,
      `Triggered ${triggeredRuleIds.length} rule(s)`,
      `Generated ${allFixes.length} fix(es)`,
      `Conflict resolution selected ${conflictResult.selectedFixes.length} fix(es) and rejected ${conflictResult.rejectedFixes.length}`,
      `Detected ${conflictResult.conflicts.length} conflict(s)`,
      ...(patchResult.rolledBack ? ["Patch apply rollback triggered"] : []),
      ...conflictResult.trace.decisions,
      shouldPersistState ? `State materialized at ${statePath}` : `State materialization skipped for simulation at ${statePath}`,
    ],
    durationMs: Date.now() - startTime,
  };

  return {
    diagnostics,
    fixes: allFixes,
    selectedFixes: conflictResult.selectedFixes,
    rejectedFixes: conflictResult.rejectedFixes,
    appliedPatches: patchResult.appliedPatches,
    conflicts: conflictResult.conflicts,
    conflictTrace: conflictResult.trace,
    statePath,
    trace,
  };
}

export async function runEnforcer(root: string) {
  const { readControlPlane } = await import("../choirManager.js");
  const controlPlane = readControlPlane();
  if (!controlPlane) {
    console.warn("No control plane found in workspace");
    return [] as Diagnostic[];
  }

  const workspace = buildWorkspaceSnapshot(root);
  const result = await runPipeline({ controlPlane, workspace });
  return result.diagnostics;
}