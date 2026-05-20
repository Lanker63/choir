import { EnforcementContext } from "../core/context.js";
import { Diagnostic } from "../core/types.js";
import { parseAST } from "./parser.js";
import ts from "typescript";
import path from "path";
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
import { Fix } from "../fix/types.js";
import { createZeroLengthLocation, makeDiagnosticId, sortDiagnostics } from "../core/diagnostics.js";

function toStableFilePath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) {
    return filePath.split(path.sep).join("/");
  }

  return relative;
}

export interface ASTRunResult {
  diagnostics: Diagnostic[];
  fixes: Fix[];
  astIndex: Record<string, AST>;
  symbolGraph: SymbolGraph;
  dependencyGraph: Graph;
  normalizedAsts: Record<string, NormalizedAST>;
  semanticGraph: SemanticGraph;
  semanticDiagnostics: readonly ts.Diagnostic[];
}

function sortFixes(fixes: Fix[]): Fix[] {
  return [...fixes].sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeRuleResult(result: RuleResult): RuleResult {
  return {
    diagnostics: sortDiagnostics(result.diagnostics),
    fixes: sortFixes(result.fixes ?? []),
  };
}

function serializeRuleResult(result: RuleResult): string {
  return JSON.stringify(result);
}

export function runAST(
  context: EnforcementContext,
  registry: RuleRegistry,
  traceId: string
): ASTRunResult {
  const parsed = parseAST(context);

  if (parsed.validationFailures.length > 0) {
    const firstFailure = parsed.validationFailures[0];
    const stableFilePath = toStableFilePath(context.root, firstFailure.filePath);
    const details = formatValidationIssues(firstFailure.result)
      .slice(0, 5)
      .join(" | ");

    return {
      diagnostics: [
        {
          id: makeDiagnosticId(["ast-validation", stableFilePath, 0, 0]),
          ruleId: "ast-validation",
          message: `AST validation failed for ${stableFilePath}: ${details}`,
          location: createZeroLengthLocation(stableFilePath),
          severity: "error",
          category: "AST",
          traceId,
        },
      ],
      fixes: [],
      astIndex: parsed.astIndex,
      symbolGraph: parsed.symbolGraph,
      dependencyGraph: parsed.dependencyGraph,
      normalizedAsts: parsed.normalizedAsts,
      semanticGraph: createEmptySemanticGraph(),
      semanticDiagnostics: [],
    };
  }

  const diagnostics: Diagnostic[] = [];
  const fixes: Fix[] = [];

  const rules = registry.getASTRules();
  const semanticBuild = buildSemanticGraph(context, parsed.normalizedAsts, {
    includeGraph: rules.length > 0,
  });
  const readonlySemanticGraph = createReadonlySemanticGraph(semanticBuild.graph);

  for (const file of context.files) {
    const ast = context.astMap.get(file.path) as ts.SourceFile;
    const stableFilePath = toStableFilePath(context.root, file.path);
    const normalizedAst = parsed.normalizedAsts[file.path];
    if (!normalizedAst) {
      continue;
    }

    for (const rule of rules) {
      const ruleContext: RuleContext = {
        filePath: stableFilePath,
        sourceFile: ast,
        normalizedAst: createReadonlyNormalizedAST(normalizedAst),
        semanticGraph: readonlySemanticGraph,
        traceId,
        resolveNodeId(node) {
          return normalizedAst.nodeIdByNode.get(node);
        },
      };

      const first = normalizeRuleResult(rule.evaluate(deepFreeze({ ...ruleContext })));
      const second = normalizeRuleResult(rule.evaluate(deepFreeze({ ...ruleContext })));

      if (serializeRuleResult(first) !== serializeRuleResult(second)) {
        diagnostics.push({
          id: makeDiagnosticId(["rule-nondeterministic", stableFilePath, 0, 0, rule.id]),
          ruleId: "rule-nondeterministic",
          message: `Rule ${rule.id} is not idempotent for file ${stableFilePath}`,
          location: createZeroLengthLocation(stableFilePath),
          severity: "error",
          category: "AST",
          traceId,
        });
      }

      diagnostics.push(...first.diagnostics);
      if (first.fixes && first.fixes.length > 0) {
        fixes.push(...first.fixes);
      }
    }
  }

  return {
    diagnostics: sortDiagnostics(diagnostics),
    fixes: sortFixes(fixes),
    astIndex: parsed.astIndex,
    symbolGraph: parsed.symbolGraph,
    dependencyGraph: parsed.dependencyGraph,
    normalizedAsts: parsed.normalizedAsts,
    semanticGraph: semanticBuild.graph,
    semanticDiagnostics: semanticBuild.diagnostics,
  };
}
