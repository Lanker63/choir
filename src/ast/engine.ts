import { EnforcementContext } from "../core/context.js";
import { Violation } from "../core/types.js";
import { parseAST } from "./parser.js";
import ts from "typescript";
import { RuleRegistry } from "../rules/registry.js";
import { AST, Graph, SymbolGraph } from "../core/state.js";
import {
  NormalizedAST,
  createReadonlyNormalizedAST,
  formatValidationIssues,
} from "./model.js";
import {
  SemanticGraph,
  buildSemanticGraph,
  createEmptySemanticGraph,
  createReadonlySemanticGraph,
} from "../semantic/graph.js";
import { deepFreeze } from "../utils/deepFreeze.js";
import { RuleContext, RuleResult } from "../dsl/types.js";
import { Patch } from "../fix/types.js";

export interface ASTRunResult {
  violations: Violation[];
  astIndex: Record<string, AST>;
  symbolGraph: SymbolGraph;
  dependencyGraph: Graph;
  normalizedAsts: Record<string, NormalizedAST>;
  semanticGraph: SemanticGraph;
  semanticDiagnostics: readonly ts.Diagnostic[];
  patches: Patch[];
}

function sortViolations(violations: Violation[]): Violation[] {
  return [...violations].sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return a.end - b.end;
    if (a.ruleId !== b.ruleId) return a.ruleId.localeCompare(b.ruleId);
    if (a.severity !== b.severity) return a.severity.localeCompare(b.severity);
    return a.message.localeCompare(b.message);
  });
}

function normalizeRuleResult(result: RuleResult): RuleResult {
  return {
    violations: sortViolations(result.violations),
  };
}

function serializeRuleResult(result: RuleResult): string {
  return JSON.stringify(result);
}

export function runAST(
  context: EnforcementContext,
  registry: RuleRegistry
): ASTRunResult {
  const parsed = parseAST(context);

  if (parsed.validationFailures.length > 0) {
    const firstFailure = parsed.validationFailures[0];
    const details = formatValidationIssues(firstFailure.result)
      .slice(0, 5)
      .join(" | ");

    return {
      violations: [
        {
          ruleId: "ast-validation",
          message: `AST validation failed for ${firstFailure.filePath}: ${details}`,
          file: firstFailure.filePath,
          start: 0,
          end: 1,
          severity: "error",
        },
      ],
      astIndex: parsed.astIndex,
      symbolGraph: parsed.symbolGraph,
      dependencyGraph: parsed.dependencyGraph,
      normalizedAsts: parsed.normalizedAsts,
      semanticGraph: createEmptySemanticGraph(),
      semanticDiagnostics: [],
      patches: [],
    };
  }

  const semanticBuild = buildSemanticGraph(context, parsed.normalizedAsts);
  const readonlySemanticGraph = createReadonlySemanticGraph(semanticBuild.graph);

  const violations: Violation[] = [];
  const patches: Patch[] = [];

  const rules = registry.getASTRules();

  for (const file of context.files) {
    const ast = context.astMap.get(file.path) as ts.SourceFile;
    const normalizedAst = parsed.normalizedAsts[file.path];
    if (!normalizedAst) {
      continue;
    }

    for (const rule of rules) {
      const ruleContext: RuleContext = {
        filePath: file.path,
        sourceFile: ast,
        normalizedAst: createReadonlyNormalizedAST(normalizedAst),
        semanticGraph: readonlySemanticGraph,
        resolveNodeId(node) {
          return normalizedAst.nodeIdByNode.get(node);
        },
      };

      const first = normalizeRuleResult(rule.evaluate(deepFreeze({ ...ruleContext })));
      const second = normalizeRuleResult(rule.evaluate(deepFreeze({ ...ruleContext })));

      if (serializeRuleResult(first) !== serializeRuleResult(second)) {
        violations.push({
          ruleId: "rule-nondeterministic",
          message: `Rule ${rule.id} is not idempotent for file ${file.path}`,
          file: file.path,
          start: 0,
          end: 1,
          severity: "error",
        });
      }

      violations.push(...first.violations);
      if (first.patches && first.patches.length > 0) {
        patches.push(...first.patches);
      }
    }
  }

  return {
    violations: sortViolations(violations),
    astIndex: parsed.astIndex,
    symbolGraph: parsed.symbolGraph,
    dependencyGraph: parsed.dependencyGraph,
    normalizedAsts: parsed.normalizedAsts,
    semanticGraph: semanticBuild.graph,
    semanticDiagnostics: semanticBuild.diagnostics,
    patches,
  };
}