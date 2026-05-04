import fs from "fs";
import path from "path";
import { Violation } from "./types.js";

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
  violations: Violation[];
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

function sortViolations(violations: Violation[]): Violation[] {
  return [...violations].sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return a.end - b.end;
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
