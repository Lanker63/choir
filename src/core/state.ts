import fs from "fs";
import path from "path";
import { Diagnostic } from "./types.js";

export type AST = {
  rootNodeId: string;
  nodeCount: number;
  parseDiagnostics: number;
  validationIssues: number;
  imports: string[];
  functions: string[];
  callExpressions: string[];
};

export type SymbolGraph = Record<string, string[]>;
export type Graph = Record<string, string[]>;

export type StatePlane = {
  astIndex: Record<string, AST>;
  symbolGraph: SymbolGraph;
  violations: Diagnostic[];
  metrics: Record<string, number>;
  dependencyGraph: Graph;
};

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function sortRecordValues(record: Record<string, string[]>): Record<string, string[]> {
  const sortedEntries = Object.keys(record)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => [key, sortedUnique(record[key] ?? [])] as const);

  return Object.fromEntries(sortedEntries);
}

function sortAstIndex(astIndex: Record<string, AST>): Record<string, AST> {
  const entries = Object.keys(astIndex)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const ast = astIndex[key];
      return [
        key,
        {
          rootNodeId: ast.rootNodeId,
          nodeCount: ast.nodeCount,
          parseDiagnostics: ast.parseDiagnostics,
          validationIssues: ast.validationIssues,
          imports: sortedUnique(ast.imports),
          functions: sortedUnique(ast.functions),
          callExpressions: sortedUnique(ast.callExpressions),
        } satisfies AST,
      ] as const;
    });

  return Object.fromEntries(entries);
}

function sortViolations(violations: Diagnostic[]): Diagnostic[] {
  return [...violations].sort((a, b) => {
    if (a.location.file !== b.location.file) return a.location.file.localeCompare(b.location.file);
    if (a.location.start.line !== b.location.start.line) return a.location.start.line - b.location.start.line;
    if (a.location.start.character !== b.location.start.character) {
      return a.location.start.character - b.location.start.character;
    }
    if (a.location.end.line !== b.location.end.line) return a.location.end.line - b.location.end.line;
    if (a.location.end.character !== b.location.end.character) {
      return a.location.end.character - b.location.end.character;
    }
    if (a.ruleId !== b.ruleId) return a.ruleId.localeCompare(b.ruleId);
    return a.message.localeCompare(b.message);
  });
}

export function materializeStatePlane(input: StatePlane): StatePlane {
  return {
    astIndex: sortAstIndex(input.astIndex),
    symbolGraph: sortRecordValues(input.symbolGraph),
    violations: sortViolations(input.violations),
    metrics: Object.fromEntries(
      Object.keys(input.metrics)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => [key, input.metrics[key]])
    ),
    dependencyGraph: sortRecordValues(input.dependencyGraph),
  };
}

export function persistStatePlane(root: string, state: StatePlane): string {
  const statePath = path.join(root, ".choir", "state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(materializeStatePlane(state), null, 2), "utf-8");
  return statePath;
}
