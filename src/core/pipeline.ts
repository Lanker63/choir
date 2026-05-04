import { buildContext, buildWorkspaceSnapshot, WorkspaceSnapshot } from "./context.js";
import { runAST } from "../ast/engine.js";
import { RuleRegistry } from "../rules/registry.js";
import { compileControlPlaneToRules } from "../dsl/compiler.js";
import { Violation } from "./types.js";
import { ControlPlane } from "../schema.js";
import { persistStatePlane } from "./state.js";
import { runSemantic } from "../semantic/engine.js";
import { runCode } from "../code/engine.js";
import { runStrategy } from "../strategy/engine.js";
import ts from "typescript";
import { Patch } from "../fix/types.js";
import { applyPatchesWithRoundTrip } from "../fix/engine.js";

function resolvePatchFilePath(
  patch: Patch,
  normalizedAsts: ReturnType<typeof runAST>["normalizedAsts"]
): string | null {
  for (const filePath of Object.keys(normalizedAsts).sort((a, b) => a.localeCompare(b))) {
    if (normalizedAsts[filePath]?.nodes.has(patch.targetNodeId)) {
      return filePath;
    }
  }

  return null;
}

function applyRulePatchesSafely(
  context: ReturnType<typeof buildContext>,
  astResult: ReturnType<typeof runAST>
): { violations: Violation[]; appliedPatchCount: number } {
  if (astResult.patches.length === 0) {
    return {
      violations: [],
      appliedPatchCount: 0,
    };
  }

  const grouped = new Map<string, Patch[]>();

  for (const patch of astResult.patches) {
    const filePath = resolvePatchFilePath(patch, astResult.normalizedAsts);
    if (!filePath) {
      return {
        violations: [
          {
            ruleId: "patch-resolution",
            message: `Unable to resolve patch target ${patch.targetNodeId} to a source file`,
            file: context.root,
            start: 0,
            end: 1,
            severity: "error",
          },
        ],
        appliedPatchCount: 0,
      };
    }

    const bucket = grouped.get(filePath) ?? [];
    bucket.push(patch);
    grouped.set(filePath, bucket);
  }

  const violations: Violation[] = [];
  let appliedPatchCount = 0;

  for (const [filePath, filePatches] of grouped.entries()) {
    const sourceFile = context.astMap.get(filePath) as ts.SourceFile | undefined;
    const normalizedAst = astResult.normalizedAsts[filePath];

    if (!sourceFile || !normalizedAst) {
      continue;
    }

    const applyResult = applyPatchesWithRoundTrip(sourceFile, normalizedAst, filePatches);
    if (!applyResult.roundTripSafe) {
      const message = applyResult.validation.issues
        .map((issue) => issue.message)
        .slice(0, 5)
        .join(" | ");

      violations.push({
        ruleId: "patch-roundtrip",
        message: `Patch round-trip validation failed for ${filePath}: ${message}`,
        file: filePath,
        start: 0,
        end: 1,
        severity: "error",
      });
      continue;
    }

    appliedPatchCount += filePatches.length;
  }

  return {
    violations,
    appliedPatchCount,
  };
}

export type Trace = {
  phases: string[];
  rulesEvaluated: string[];
  rulesTriggered: string[];
  conflicts: string[];
  fixes: string[];
  decisions: string[];
};

export type PipelineInput = {
  controlPlane: ControlPlane;
  workspace: WorkspaceSnapshot;
};

export type PipelineResult = {
  violations: Violation[];
  statePath: string;
  trace: Trace;
};

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const context = buildContext(input.workspace);
  const registry = new RuleRegistry();
  const executableRules = compileControlPlaneToRules(input.controlPlane);
  const phases = ["AST", "SEMANTIC", "CODE", "STRATEGY"];

  for (const rule of executableRules) {
    registry.registerAST(rule);
  }

  // Enforce deterministic stage ordering across all runs.
  const astResult = runAST(context, registry);
  const semanticResult = runSemantic(context, astResult.normalizedAsts, {
    graph: astResult.semanticGraph,
    diagnostics: astResult.semanticDiagnostics,
  });
  const semanticViolations = semanticResult.violations;
  const patchResult = applyRulePatchesSafely(context, astResult);
  const codeViolations = runCode(context);
  const strategyViolations = await runStrategy(context);

  const violations = [
    ...astResult.violations,
    ...semanticViolations,
    ...patchResult.violations,
    ...codeViolations,
    ...strategyViolations,
  ];

  const triggeredRuleIds = Array.from(new Set(violations.map((violation) => violation.ruleId)));
  const astOverrideApplied = executableRules.some((rule) => rule.priority < 100);

  const statePath = persistStatePlane(input.workspace.root, {
    astIndex: astResult.astIndex,
    symbolGraph: astResult.symbolGraph,
    violations,
    metrics: {
      filesScanned: input.workspace.files.length,
      rulesEvaluated: executableRules.length,
      astViolations: astResult.violations.length,
      semanticViolations: semanticViolations.length,
      semanticDiagnostics: semanticResult.diagnostics.length,
      patchViolations: patchResult.violations.length,
      appliedPatches: patchResult.appliedPatchCount,
      codeViolations: codeViolations.length,
      strategyViolations: strategyViolations.length,
      violations: violations.length,
    },
    dependencyGraph: astResult.dependencyGraph,
  });

  return {
    violations,
    statePath,
    trace: {
      phases,
      rulesEvaluated: executableRules.map((rule) => rule.id),
      rulesTriggered: triggeredRuleIds,
      conflicts: [],
      fixes: [],
      decisions: [
        astOverrideApplied ? "AST override applied" : "AST default precedence retained",
        "Pipeline stage order: AST -> Semantic -> Code -> Strategy",
        `Evaluated ${executableRules.length} executable rules`,
        `Triggered ${triggeredRuleIds.length} rule(s)`,
        `State materialized at ${statePath}`,
      ],
    },
  };
}

export async function runEnforcer(root: string) {
  const { readControlPlane } = await import("../choirManager.js");
  const controlPlane = readControlPlane();
  if (!controlPlane) {
    console.warn("No control plane found in workspace");
    return [] as Violation[];
  }

  const workspace = buildWorkspaceSnapshot(root);
  const result = await runPipeline({ controlPlane, workspace });
  return result.violations;
}