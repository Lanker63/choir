import { EnforcementContext } from "../core/context.js";
import { Diagnostic } from "../core/types.js";
import ts from "typescript";
import path from "path";
import { NormalizedAST } from "../ast/model.js";
import {
  SemanticBuildResult,
  SemanticGraph,
  buildSemanticGraph,
  createEmptySemanticGraph,
} from "./graph.js";
import { makeDiagnosticId, sortDiagnostics, sourceLocationFromOffsets } from "../core/diagnostics.js";

export interface SemanticRunResult {
  diagnostics: Diagnostic[];
  semanticGraph: SemanticGraph;
  semanticDiagnostics: readonly ts.Diagnostic[];
}

function toStableFilePath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) {
    return filePath.split(path.sep).join("/");
  }

  return relative;
}

function toDiagnostic(
  diagnostic: ts.Diagnostic,
  traceId: string,
  index: number,
  workspaceRoot: string
): Diagnostic {
  const file = diagnostic.file?.fileName
    ? toStableFilePath(workspaceRoot, diagnostic.file.fileName)
    : "unknown";
  const start = diagnostic.start ?? 0;
  const end = (diagnostic.start ?? 0) + (diagnostic.length ?? 1);

  return {
    id: makeDiagnosticId(["semantic-diagnostic", file, start, end, index]),
    ruleId: "semantic-diagnostic",
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    location: diagnostic.file
      ? sourceLocationFromOffsets(diagnostic.file, file, start, end)
      : {
          file,
          start: { line: 0, character: start },
          end: { line: 0, character: end },
        },
    severity: "error",
    category: "semantic",
    traceId,
  };
}

export function runSemantic(
  context: EnforcementContext,
  normalizedAsts: Record<string, NormalizedAST>,
  traceId: string,
  prebuilt?: SemanticBuildResult
): SemanticRunResult {
  if (Object.keys(normalizedAsts).length === 0) {
    return {
      diagnostics: [],
      semanticGraph: createEmptySemanticGraph(),
      semanticDiagnostics: [],
    };
  }

  const semanticBuild = prebuilt ?? buildSemanticGraph(context, normalizedAsts);
  const diagnostics = sortDiagnostics(
    semanticBuild.diagnostics.map((diagnostic, index) => toDiagnostic(diagnostic, traceId, index, context.root))
  );

  return {
    diagnostics,
    semanticGraph: semanticBuild.graph,
    semanticDiagnostics: semanticBuild.diagnostics,
  };
}