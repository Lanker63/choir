import fs from "fs";
import path from "path";
import { Diagnostic } from "./types.js";
import type { YAMLDiff } from "./policyEngine.js";

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

export type PreviewApproval = {
  hash: string;
  planId: string;
  strategyId?: string;
};

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
  lastPreview?: PreviewApproval;
};

export type ApprovalRecord = {
  id: string;
  diffHash: string;
  approvedBy: string;
  timestamp: string;
};

export type PendingApprovalRecord = {
  id: string;
  diffHash: string;
  diffs: YAMLDiff[];
  createdAt: string;
  command: string;
};

export type StrategyHistoryMetrics = {
  filesChanged: number;
  patchesCount: number;
  remainingViolations: number;
  introducedErrors: number;
};

export type FailurePatternRecord = {
  type:
    | "validation-failure"
    | "high-remaining-violations"
    | "too-many-patches"
    | "too-many-files"
    | "conflict-heavy";
  strategyId: string;
  metrics: StrategyHistoryMetrics;
  details?: string;
};

export type StrategyHistory = {
  planId?: string;
  strategyId: string;
  strategyType?: string;
  patterns: FailurePatternRecord[];
  outcomeMetrics: StrategyHistoryMetrics;
};

export type StatePlane = {
  astIndex: Record<string, AST>;
  symbolGraph: SymbolGraph;
  violations: Diagnostic[];
  metrics: Record<string, number>;
  dependencyGraph: Graph;
  execution: ExecutionState;
  strategyHistory: StrategyHistory[];
  approvals: ApprovalRecord[];
  pendingApprovals: PendingApprovalRecord[];
};

const MAX_STRATEGY_HISTORY = 256;

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

function parseStrategyMetrics(value: unknown): StrategyHistoryMetrics {
  const record = isRecord(value) ? value : {};
  return {
    filesChanged: typeof record.filesChanged === "number" && Number.isFinite(record.filesChanged) ? record.filesChanged : 0,
    patchesCount: typeof record.patchesCount === "number" && Number.isFinite(record.patchesCount) ? record.patchesCount : 0,
    remainingViolations: typeof record.remainingViolations === "number" && Number.isFinite(record.remainingViolations)
      ? record.remainingViolations
      : Number.MAX_SAFE_INTEGER,
    introducedErrors: typeof record.introducedErrors === "number" && Number.isFinite(record.introducedErrors)
      ? record.introducedErrors
      : Number.MAX_SAFE_INTEGER,
  };
}

function failurePatternRank(type: FailurePatternRecord["type"]): number {
  if (type === "validation-failure") return 0;
  if (type === "high-remaining-violations") return 1;
  if (type === "conflict-heavy") return 2;
  if (type === "too-many-patches") return 3;
  return 4;
}

function sortFailurePatterns(patterns: FailurePatternRecord[]): FailurePatternRecord[] {
  return [...patterns].sort((left, right) =>
    failurePatternRank(left.type) - failurePatternRank(right.type)
    || left.strategyId.localeCompare(right.strategyId)
    || left.metrics.remainingViolations - right.metrics.remainingViolations
    || left.metrics.introducedErrors - right.metrics.introducedErrors
    || left.metrics.patchesCount - right.metrics.patchesCount
    || left.metrics.filesChanged - right.metrics.filesChanged
    || (left.details ?? "").localeCompare(right.details ?? "")
  );
}

function parseFailurePatternRecord(value: unknown): FailurePatternRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const type = value.type;
  const strategyId = typeof value.strategyId === "string" ? value.strategyId.trim() : "";
  if (
    (type !== "validation-failure"
      && type !== "high-remaining-violations"
      && type !== "too-many-patches"
      && type !== "too-many-files"
      && type !== "conflict-heavy")
    || strategyId.length === 0
  ) {
    return null;
  }

  const details = typeof value.details === "string" && value.details.trim().length > 0
    ? value.details
    : undefined;

  return {
    type,
    strategyId,
    metrics: parseStrategyMetrics(value.metrics),
    ...(details ? { details } : {}),
  };
}

function parseStrategyHistory(value: unknown): StrategyHistory[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsed = value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const strategyId = typeof entry.strategyId === "string" ? entry.strategyId.trim() : "";
    if (strategyId.length === 0) {
      return [];
    }

    const planId = typeof entry.planId === "string" && entry.planId.trim().length > 0 ? entry.planId : undefined;
    const strategyType = typeof entry.strategyType === "string" && entry.strategyType.trim().length > 0
      ? entry.strategyType
      : undefined;
    const patterns = Array.isArray(entry.patterns)
      ? entry.patterns
        .map((pattern) => parseFailurePatternRecord(pattern))
        .filter((pattern): pattern is FailurePatternRecord => pattern !== null)
      : [];

    return [{
      ...(planId ? { planId } : {}),
      strategyId,
      ...(strategyType ? { strategyType } : {}),
      patterns: sortFailurePatterns(patterns),
      outcomeMetrics: parseStrategyMetrics(entry.outcomeMetrics),
    } satisfies StrategyHistory];
  });

  return materializeStrategyHistory(parsed);
}

function strategyHistoryKey(entry: StrategyHistory): string {
  return JSON.stringify({
    planId: entry.planId ?? "",
    strategyId: entry.strategyId,
    strategyType: entry.strategyType ?? "",
    patterns: sortFailurePatterns(entry.patterns),
    outcomeMetrics: entry.outcomeMetrics,
  });
}

function materializeStrategyHistory(entries: StrategyHistory[]): StrategyHistory[] {
  const byKey = new Map<string, StrategyHistory>();

  for (const entry of entries) {
    const normalized: StrategyHistory = {
      ...(entry.planId ? { planId: entry.planId } : {}),
      strategyId: entry.strategyId,
      ...(entry.strategyType ? { strategyType: entry.strategyType } : {}),
      patterns: sortFailurePatterns(entry.patterns),
      outcomeMetrics: parseStrategyMetrics(entry.outcomeMetrics),
    };

    const key = strategyHistoryKey(normalized);
    if (!byKey.has(key)) {
      byKey.set(key, normalized);
    }
  }

  return [...byKey.values()]
    .sort((left, right) =>
      (left.planId ?? "").localeCompare(right.planId ?? "")
      || left.strategyId.localeCompare(right.strategyId)
      || (left.strategyType ?? "").localeCompare(right.strategyType ?? "")
      || JSON.stringify(left.outcomeMetrics).localeCompare(JSON.stringify(right.outcomeMetrics))
    )
    .slice(0, MAX_STRATEGY_HISTORY);
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

  const rawPreview = isRecord(input?.lastPreview) ? input.lastPreview : undefined;
  const previewHash = typeof rawPreview?.hash === "string" && rawPreview.hash.trim().length > 0
    ? rawPreview.hash
    : undefined;
  const previewPlanId = typeof rawPreview?.planId === "string" && rawPreview.planId.trim().length > 0
    ? rawPreview.planId
    : undefined;
  const previewStrategyId = typeof rawPreview?.strategyId === "string" && rawPreview.strategyId.trim().length > 0
    ? rawPreview.strategyId
    : undefined;

  const lastPreview = previewHash && previewPlanId
    ? {
      hash: previewHash,
      planId: previewPlanId,
      ...(previewStrategyId ? { strategyId: previewStrategyId } : {}),
    } satisfies PreviewApproval
    : undefined;

  return {
    ...(activePlanId ? { activePlanId } : {}),
    taskStatus,
    taskResults,
    history,
    ...(lastPreview ? { lastPreview } : {}),
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

function parseApprovalRecord(value: unknown): ApprovalRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const diffHash = typeof value.diffHash === "string" ? value.diffHash.trim() : "";
  const approvedBy = typeof value.approvedBy === "string" ? value.approvedBy.trim() : "";
  const timestamp = typeof value.timestamp === "string" ? value.timestamp.trim() : "";

  if (id.length === 0 || diffHash.length === 0 || approvedBy.length === 0 || timestamp.length === 0) {
    return null;
  }

  return {
    id,
    diffHash,
    approvedBy,
    timestamp,
  };
}

function parsePendingApprovalRecord(value: unknown): PendingApprovalRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const diffHash = typeof value.diffHash === "string" ? value.diffHash.trim() : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt.trim() : "";
  const command = typeof value.command === "string" ? value.command.trim() : "";
  const diffs = Array.isArray(value.diffs) ? value.diffs as YAMLDiff[] : [];

  if (id.length === 0 || diffHash.length === 0 || createdAt.length === 0 || command.length === 0) {
    return null;
  }

  return {
    id,
    diffHash,
    diffs: [...diffs].sort((left, right) =>
      left.path.localeCompare(right.path)
      || left.operation.localeCompare(right.operation)
    ),
    createdAt,
    command,
  };
}

function materializeApprovals(records: ApprovalRecord[]): ApprovalRecord[] {
  const byDiffHash = new Map<string, ApprovalRecord>();

  for (const record of records) {
    if (!record.id || !record.diffHash || !record.approvedBy || !record.timestamp) {
      continue;
    }

    if (!byDiffHash.has(record.diffHash)) {
      byDiffHash.set(record.diffHash, {
        id: record.id,
        diffHash: record.diffHash,
        approvedBy: record.approvedBy,
        timestamp: record.timestamp,
      });
    }
  }

  return [...byDiffHash.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
    || left.diffHash.localeCompare(right.diffHash)
    || left.timestamp.localeCompare(right.timestamp)
  );
}

function materializePendingApprovals(records: PendingApprovalRecord[]): PendingApprovalRecord[] {
  const byId = new Map<string, PendingApprovalRecord>();

  for (const record of records) {
    if (!record.id || !record.diffHash || !record.createdAt || !record.command) {
      continue;
    }

    byId.set(record.id, {
      id: record.id,
      diffHash: record.diffHash,
      diffs: [...record.diffs].sort((left, right) =>
        left.path.localeCompare(right.path)
        || left.operation.localeCompare(right.operation)
      ),
      createdAt: record.createdAt,
      command: record.command,
    });
  }

  return [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
    || left.diffHash.localeCompare(right.diffHash)
    || left.createdAt.localeCompare(right.createdAt)
  );
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
    strategyHistory: [],
    approvals: [],
    pendingApprovals: [],
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
      strategyHistory: parseStrategyHistory(record.strategyHistory),
      approvals: Array.isArray(record.approvals)
        ? record.approvals
          .map((entry) => parseApprovalRecord(entry))
          .filter((entry): entry is ApprovalRecord => entry !== null)
        : [],
      pendingApprovals: Array.isArray(record.pendingApprovals)
        ? record.pendingApprovals
          .map((entry) => parsePendingApprovalRecord(entry))
          .filter((entry): entry is PendingApprovalRecord => entry !== null)
        : [],
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
    strategyHistory: materializeStrategyHistory(input.strategyHistory),
    approvals: materializeApprovals(input.approvals),
    pendingApprovals: materializePendingApprovals(input.pendingApprovals),
  };
}

export function appendStrategyHistory(
  root: string,
  entries: StrategyHistory[]
): { statePath: string; state: StatePlane } {
  const current = readStatePlane(root) ?? createEmptyStatePlane();
  const nextState = materializeStatePlane({
    ...current,
    strategyHistory: [...current.strategyHistory, ...entries],
  });
  const statePath = persistStatePlane(root, nextState);

  return {
    statePath,
    state: nextState,
  };
}

export function persistStatePlane(root: string, state: StatePlane): string {
  const statePath = getStatePath(root);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(materializeStatePlane(state), null, 2), "utf-8");
  return statePath;
}

export function hasApprovalForDiff(root: string, diffHash: string): boolean {
  const state = readStatePlane(root) ?? createEmptyStatePlane();
  return state.approvals.some((entry) => entry.diffHash === diffHash);
}

export function listPendingApprovals(root: string): PendingApprovalRecord[] {
  const state = readStatePlane(root) ?? createEmptyStatePlane();
  return [...state.pendingApprovals];
}

export function upsertPendingApproval(root: string, pending: PendingApprovalRecord): { statePath: string; state: StatePlane } {
  const current = readStatePlane(root) ?? createEmptyStatePlane();
  const nextState = materializeStatePlane({
    ...current,
    pendingApprovals: [
      ...current.pendingApprovals.filter((entry) => entry.id !== pending.id),
      pending,
    ],
  });

  const statePath = persistStatePlane(root, nextState);
  return { statePath, state: nextState };
}

export function approvePendingDiff(
  root: string,
  id: string,
  approvedBy: string,
  timestamp: string
): { statePath: string; state: StatePlane; approved?: ApprovalRecord } {
  const current = readStatePlane(root) ?? createEmptyStatePlane();
  const pending = current.pendingApprovals.find((entry) => entry.id === id);
  if (!pending) {
    return {
      statePath: getStatePath(root),
      state: current,
    };
  }

  const approval: ApprovalRecord = {
    id,
    diffHash: pending.diffHash,
    approvedBy,
    timestamp,
  };

  const nextState = materializeStatePlane({
    ...current,
    approvals: [
      ...current.approvals.filter((entry) => entry.diffHash !== pending.diffHash),
      approval,
    ],
    pendingApprovals: current.pendingApprovals.filter((entry) => entry.id !== id),
  });

  const statePath = persistStatePlane(root, nextState);
  return {
    statePath,
    state: nextState,
    approved: approval,
  };
}

export function rejectPendingDiff(root: string, id: string): { statePath: string; state: StatePlane; removed: boolean } {
  const current = readStatePlane(root) ?? createEmptyStatePlane();
  const nextPending = current.pendingApprovals.filter((entry) => entry.id !== id);
  const removed = nextPending.length !== current.pendingApprovals.length;
  const nextState = materializeStatePlane({
    ...current,
    pendingApprovals: nextPending,
  });

  const statePath = persistStatePlane(root, nextState);
  return {
    statePath,
    state: nextState,
    removed,
  };
}
