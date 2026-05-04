import { buildContext, buildWorkspaceSnapshot, WorkspaceSnapshot } from "./context.js";
import { runAST } from "../ast/engine.js";
import { RuleRegistry } from "../rules/registry.js";
import { compileControlPlaneToRules } from "../dsl/compiler.js";
import { Diagnostic, SourceLocation, Trace } from "./types.js";
import { ControlPlane } from "../schema.js";
import { persistStatePlane } from "./state.js";
import { runSemantic } from "../semantic/engine.js";
import { runCode } from "../code/engine.js";
import { runStrategy } from "../strategy/engine.js";
import { normalizeAST } from "../ast/model.js";
import { applyPatchesWithRoundTrip } from "../fix/engine.js";
import { Fix, FixConflict, PatchResult, isTextPatch } from "../fix/types.js";
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

function comparePosition(left: SourceLocation["start"], right: SourceLocation["start"]): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }

  return left.character - right.character;
}

function rangesOverlap(left: SourceLocation, right: SourceLocation): boolean {
  if (left.file !== right.file) {
    return false;
  }

  const leftStartsBeforeRightEnds = comparePosition(left.start, right.end) < 0;
  const rightStartsBeforeLeftEnds = comparePosition(right.start, left.end) < 0;
  return leftStartsBeforeRightEnds && rightStartsBeforeLeftEnds;
}

function detectFixConflicts(fixes: Fix[]): FixConflict[] {
  const conflicts: FixConflict[] = [];

  for (const fix of fixes) {
    for (const conflictId of fix.conflictsWith ?? []) {
      if (fix.id < conflictId) {
        conflicts.push({
          fixA: fix.id,
          fixB: conflictId,
          reason: "semantic-conflict",
        });
      }
    }
  }

  for (let i = 0; i < fixes.length; i += 1) {
    const left = fixes[i];
    const leftPatches = left.patches.filter(isTextPatch);

    for (let j = i + 1; j < fixes.length; j += 1) {
      const right = fixes[j];
      const rightPatches = right.patches.filter(isTextPatch);
      const hasOverlap = leftPatches.some((leftPatch) =>
        rightPatches.some((rightPatch) => rangesOverlap(leftPatch.location, rightPatch.location))
      );

      if (hasOverlap) {
        conflicts.push({
          fixA: left.id,
          fixB: right.id,
          reason: "overlapping-range",
        });
      }
    }
  }

  return conflicts
    .sort((left, right) => {
      if (left.fixA !== right.fixA) {
        return left.fixA.localeCompare(right.fixA);
      }

      if (left.fixB !== right.fixB) {
        return left.fixB.localeCompare(right.fixB);
      }

      return left.reason.localeCompare(right.reason);
    })
    .filter((conflict, index, all) => {
      const previous = all[index - 1];
      return !previous
        || previous.fixA !== conflict.fixA
        || previous.fixB !== conflict.fixB
        || previous.reason !== conflict.reason;
    });
}

function selectAcceptedFixes(fixes: Fix[], conflicts: FixConflict[]): { accepted: Fix[]; rejected: Set<string> } {
  const rejected = new Set<string>();

  for (const conflict of conflicts) {
    const loser = conflict.fixA.localeCompare(conflict.fixB) <= 0 ? conflict.fixB : conflict.fixA;
    rejected.add(loser);
  }

  return {
    accepted: fixes.filter((fix) => !rejected.has(fix.id)),
    rejected,
  };
}

function applyFixesSafely(
  context: ReturnType<typeof buildContext>,
  astResult: ReturnType<typeof runAST>,
  fixes: Fix[],
  conflicts: FixConflict[],
  traceId: string
): { diagnostics: Diagnostic[]; appliedPatches: PatchResult[] } {
  if (fixes.length === 0) {
    return {
      diagnostics: [],
      appliedPatches: [],
    };
  }

  const diagnostics: Diagnostic[] = [];
  const patchResults: PatchResult[] = [];
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

  const { accepted, rejected } = selectAcceptedFixes(fixes, conflicts);

  for (const fix of fixes) {
    if (rejected.has(fix.id)) {
      for (let patchIndex = 0; patchIndex < fix.patches.length; patchIndex += 1) {
        patchResults.push({
          patchId: `${fix.id}:${patchIndex + 1}`,
          success: false,
          error: "Rejected due to fix conflict",
        });
      }
    }
  }

  for (const fix of accepted.sort((left, right) => left.id.localeCompare(right.id))) {
    for (let patchIndex = 0; patchIndex < fix.patches.length; patchIndex += 1) {
      const patch = fix.patches[patchIndex];
      const patchId = `${fix.id}:${patchIndex + 1}`;

      if (!isTextPatch(patch)) {
        patchResults.push({ patchId, success: true });
        continue;
      }

      const filePath = patch.location.file;
      const working = workingSourceByFile.get(filePath);
      if (!working) {
        patchResults.push({
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
        continue;
      }

      const applyResult = applyPatchesWithRoundTrip(working.sourceFile, working.normalizedAst, [patch]);
      const firstPatchResult = applyResult.results?.[0];

      if (!applyResult.roundTripSafe || !firstPatchResult?.success) {
        const rawError = firstPatchResult?.error
          ?? applyResult.patchValidation.issues.map((issue) => issue.message).join(" | ")
          ?? applyResult.validation.issues.map((issue) => issue.message).join(" | ");
        const error = rawError.length > 0 ? rawError : "Unknown patch application error";

        patchResults.push({
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
        continue;
      }

      patchResults.push({ patchId, success: true });
      const updatedNormalized = normalizeAST(applyResult.ast, filePath);
      workingSourceByFile.set(filePath, {
        sourceFile: applyResult.ast,
        normalizedAst: updatedNormalized,
      });
    }
  }

  return {
    diagnostics,
    appliedPatches: patchResults,
  };
}

export type PipelineInput = {
  controlPlane: ControlPlane;
  workspace: WorkspaceSnapshot;
};

export type PipelineResult = {
  diagnostics: Diagnostic[];
  fixes: Fix[];
  appliedPatches: PatchResult[];
  conflicts: FixConflict[];
  statePath: string;
  trace: Trace;
  // Legacy compatibility for existing callers and tests.
  violations: Diagnostic[];
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
  const conflicts = detectFixConflicts(allFixes);
  const patchResult = applyFixesSafely(context, astResult, allFixes, conflicts, runId);

  const diagnostics = [
    ...astResult.diagnostics,
    ...semanticResult.diagnostics,
    ...patchResult.diagnostics,
    ...codeDiagnostics,
    ...strategyDiagnostics,
  ].sort((left, right) => left.id.localeCompare(right.id));

  const triggeredRuleIds = Array.from(new Set(diagnostics.map((diagnostic) => diagnostic.ruleId))).sort((a, b) => a.localeCompare(b));
  const astOverrideApplied = executableRules.some((rule) => rule.priority < 100);

  const statePath = persistStatePlane(input.workspace.root, {
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
  });

  const trace: Trace = {
    runId,
    phases,
    rulesEvaluated: executableRules.map((rule) => rule.id),
    rulesTriggered: triggeredRuleIds,
    diagnosticsEmitted: diagnostics.map((diagnostic) => diagnostic.id),
    fixesGenerated: allFixes.map((fix) => fix.id),
    conflictsDetected: conflicts,
    decisions: [
      astOverrideApplied ? "AST override applied" : "AST default precedence retained",
      "Pipeline stage order: AST -> Semantic -> Code -> Strategy",
      `Evaluated ${executableRules.length} executable rules`,
      `Triggered ${triggeredRuleIds.length} rule(s)`,
      `Generated ${allFixes.length} fix(es)`,
      `Detected ${conflicts.length} conflict(s)`,
      `State materialized at ${statePath}`,
    ],
    durationMs: Date.now() - startTime,
  };

  return {
    diagnostics,
    fixes: allFixes,
    appliedPatches: patchResult.appliedPatches,
    conflicts,
    statePath,
    trace,
    violations: diagnostics,
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