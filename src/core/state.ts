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

export type TaskExecutionStatus = "pending" | "in-progress" | "complete" | "failed";

export type ExecutionEvent = {
  planId: string;
  taskId?: string;
  status: TaskExecutionStatus;
  detail: string;
};

export type ExecutionState = {
  activePlanId?: string;
  taskStatus: Record<string, TaskExecutionStatus>;
  taskResults: Record<string, unknown>;
  history: ExecutionEvent[];
};

export type StatePlane = {
  astIndex: Record<string, AST>;
  symbolGraph: SymbolGraph;
  violations: Diagnostic[];
  metrics: Record<string, number>;
  dependencyGraph: Graph;
  execution: ExecutionState;
};

type UnknownRecord = Record<string, unknown>;

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskExecutionStatus(value: unknown): value is TaskExecutionStatus {
  return value === "pending" || value === "in-progress" || value === "complete" || value === "failed";
}

function sortUnknownRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(record)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => [key, record[key]])
  );
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

export function createEmptyExecutionState(): ExecutionState {
  return {
    activePlanId: undefined,
    taskStatus: {},
    taskResults: {},
    history: [],
  };
}

function materializeExecutionState(input?: Partial<ExecutionState>): ExecutionState {
  const activePlanId = typeof input?.activePlanId === "string" && input.activePlanId.trim().length > 0
    ? input.activePlanId
    : undefined;

  const rawStatus = isRecord(input?.taskStatus) ? input.taskStatus : {};
  const taskStatus = Object.fromEntries(
    Object.keys(rawStatus)
      .filter((taskId) => isTaskExecutionStatus(rawStatus[taskId]))
      .sort((a, b) => a.localeCompare(b))
      .map((taskId) => [taskId, rawStatus[taskId] as TaskExecutionStatus])
  );

  const rawResults = isRecord(input?.taskResults) ? input.taskResults : {};
  const taskResults = sortUnknownRecord(rawResults);

  const rawHistory = Array.isArray(input?.history) ? input.history : [];
  const history = rawHistory.flatMap((event) => {
    if (!isRecord(event)) {
      return [];
    }

    const planId = typeof event.planId === "string" && event.planId.trim().length > 0 ? event.planId : null;
    if (!planId) {
      return [];
    }

    const status = isTaskExecutionStatus(event.status) ? event.status : "pending";
    const detail = typeof event.detail === "string" ? event.detail : "";
    const taskId = typeof event.taskId === "string" && event.taskId.trim().length > 0
      ? event.taskId
      : undefined;

    return [{
      planId,
      ...(taskId ? { taskId } : {}),
      status,
      detail,
    } satisfies ExecutionEvent];
  });

  return {
    ...(activePlanId ? { activePlanId } : {}),
    taskStatus,
    taskResults,
    history,
  };
}

function parseGraph(value: unknown): Graph {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => {
        const entries = Array.isArray(value[key])
          ? (value[key] as unknown[]).filter((entry): entry is string => typeof entry === "string")
          : [];

        return [key, sortedUnique(entries)] as const;
      })
  );
}

function parseMetrics(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => typeof value[key] === "number" && Number.isFinite(value[key]))
      .sort((a, b) => a.localeCompare(b))
      .map((key) => [key, value[key] as number])
  );
}

function parseAstIndex(value: unknown): Record<string, AST> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .flatMap((key) => {
        const entry = value[key];
        if (!isRecord(entry)) {
          return [];
        }

        const rootNodeId = typeof entry.rootNodeId === "string" ? entry.rootNodeId : "";
        const nodeCount = typeof entry.nodeCount === "number" && Number.isFinite(entry.nodeCount) ? entry.nodeCount : 0;
        const parseDiagnostics = typeof entry.parseDiagnostics === "number" && Number.isFinite(entry.parseDiagnostics)
          ? entry.parseDiagnostics
          : 0;
        const validationIssues = typeof entry.validationIssues === "number" && Number.isFinite(entry.validationIssues)
          ? entry.validationIssues
          : 0;
        const imports = Array.isArray(entry.imports)
          ? (entry.imports as unknown[]).filter((item): item is string => typeof item === "string")
          : [];
        const functions = Array.isArray(entry.functions)
          ? (entry.functions as unknown[]).filter((item): item is string => typeof item === "string")
          : [];
        const callExpressions = Array.isArray(entry.callExpressions)
          ? (entry.callExpressions as unknown[]).filter((item): item is string => typeof item === "string")
          : [];

        return [[key, {
          rootNodeId,
          nodeCount,
          parseDiagnostics,
          validationIssues,
          imports,
          functions,
          callExpressions,
        } satisfies AST] as const];
      })
  );
}

function parseViolations(value: unknown): Diagnostic[] {
  return Array.isArray(value) ? value as Diagnostic[] : [];
}

function getStatePath(root: string): string {
  return path.join(root, ".choir", "state.json");
}

export function createEmptyStatePlane(): StatePlane {
  return {
    astIndex: {},
    symbolGraph: {},
    violations: [],
    metrics: {},
    dependencyGraph: {},
    execution: createEmptyExecutionState(),
  };
}

export function readStatePlane(root: string): StatePlane | null {
  const statePath = getStatePath(root);
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const record = isRecord(parsed) ? parsed : {};

    return materializeStatePlane({
      astIndex: parseAstIndex(record.astIndex),
      symbolGraph: parseGraph(record.symbolGraph),
      violations: parseViolations(record.violations),
      metrics: parseMetrics(record.metrics),
      dependencyGraph: parseGraph(record.dependencyGraph),
      execution: materializeExecutionState(isRecord(record.execution) ? record.execution as Partial<ExecutionState> : undefined),
    });
  } catch {
    return null;
  }
}

export function updateExecutionState(
  root: string,
  updater: (current: ExecutionState) => ExecutionState
): { statePath: string; state: StatePlane } {
  const currentState = readStatePlane(root) ?? createEmptyStatePlane();
  const nextExecution = materializeExecutionState(updater(currentState.execution));
  const nextState = materializeStatePlane({
    ...currentState,
    execution: nextExecution,
  });
  const statePath = persistStatePlane(root, nextState);

  return {
    statePath,
    state: nextState,
  };
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
    execution: materializeExecutionState(input.execution),
  };
}

export function persistStatePlane(root: string, state: StatePlane): string {
  const statePath = getStatePath(root);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(materializeStatePlane(state), null, 2), "utf-8");
  return statePath;
}
