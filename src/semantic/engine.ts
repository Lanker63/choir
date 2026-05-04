import { EnforcementContext } from "../core/context.js";
import { Violation } from "../core/types.js";
import ts from "typescript";
import { NormalizedAST } from "../ast/model.js";
import {
  SemanticBuildResult,
  SemanticGraph,
  buildSemanticGraph,
  createEmptySemanticGraph,
} from "./graph.js";

export interface SemanticRunResult {
  violations: Violation[];
  semanticGraph: SemanticGraph;
  diagnostics: readonly ts.Diagnostic[];
}

function toViolation(diagnostic: ts.Diagnostic): Violation {
  const file = diagnostic.file?.fileName ?? "unknown";
  const start = diagnostic.start ?? 0;
  const end = (diagnostic.start ?? 0) + (diagnostic.length ?? 1);

  return {
    ruleId: "semantic-diagnostic",
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    file,
    start,
    end,
    severity: "error",
  };
}

function sortViolations(violations: Violation[]): Violation[] {
  return [...violations].sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return a.end - b.end;
    return a.message.localeCompare(b.message);
  });
}

export function runSemantic(
  context: EnforcementContext,
  normalizedAsts: Record<string, NormalizedAST>,
  prebuilt?: SemanticBuildResult
): SemanticRunResult {
  if (Object.keys(normalizedAsts).length === 0) {
    return {
      violations: [],
      semanticGraph: createEmptySemanticGraph(),
      diagnostics: [],
    };
  }

  const semanticBuild = prebuilt ?? buildSemanticGraph(context, normalizedAsts);
  const violations = sortViolations(semanticBuild.diagnostics.map(toViolation));

  return {
    violations,
    semanticGraph: semanticBuild.graph,
    diagnostics: semanticBuild.diagnostics,
  };
}