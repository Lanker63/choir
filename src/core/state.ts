import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { Diagnostic } from "./types.js";
import {
  canonicalizeUnknown,
  deterministicId,
  deterministicTimestampFromCounter,
  deterministicTimestampFromString,
  stableStringify as deterministicStableStringify,
} from "./deterministicCore.js";
import type { YAMLDiff } from "./policyEngine.js";
import type { AST as DSLAST, ActionNode } from "./choirRouter.js";
import type { RuleResult } from "./astValidation.js";
import type { ControlPlane, Plan } from "../schema.js";
import { isNonNull, isRecord } from "../utils/guards.js";
import { cloneJson, cloneJsonOrUndefined } from "../utils/clone.js";

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
  previewHash?: string;
  approvedBy: string;
  timestamp: string;
};

export type PendingApprovalRecord = {
  id: string;
  diffHash: string;
  previewHash?: string;
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

export type ASTStateNode = {
  id: string;
  type: ActionNode["type"];
};

export type StatePlan = {
  id: string;
  status: string;
  taskIds: string[];
  nodeRefs: string[];
};

export type StateIntent = {
  goals: string[];
  constraints: string[];
  nonGoals: string[];
};

export type RuleViolation = {
  ruleId: string;
  severity: "error" | "warning";
  message: string;
  actionIndex?: number;
};

export type StateValidationIssue = {
  code: string;
  message: string;
  path: string;
};

export type ValidationResult = {
  valid: boolean;
  issues: StateValidationIssue[];
};

export type StateSnapshot = {
  id: string;
  timestamp: string;
  state: StatePlane;
  hash: string;
};

export type StatePatch = {
  path: string;
  op: "set" | "delete";
  before: unknown;
  after?: unknown;
};

export type StateTransitionDiff = {
  patchCount: number;
  patches: StatePatch[];
};

export type StateMetadata = {
  command: string;
  policyDecision: string;
  auditId: string;
  ruleTriggers?: string[];
  dependencyChain?: string[];
  unitId?: string;
};

export type StateTransition = {
  id: string;
  logicalTime: number;
  unitId: string;
  fromHash: string;
  toHash: string;
  action: string;
  timestamp: string;
  diff: StateTransitionDiff;
  metadata?: StateMetadata;
};

export type TimelineEvent = {
  id: string;
  type: "transition" | "rollback";
  timestamp: number;
  unitId: string;
  action: string;
  stateHashBefore: string;
  stateHashAfter: string;
  diff: StateTransitionDiff;
};

export type GlobalTimeline = {
  events: TimelineEvent[];
};

export type UnitTimeline = {
  unitId: string;
  events: TimelineEvent[];
};

export type StateTimeline = {
  snapshots: StateSnapshot[];
  transitions: StateTransition[];
};

export type ReplayTrace = {
  visitedStates: string[];
  replayTime: number;
  consistencyCheck: boolean;
  fallbackUsed: boolean;
};

export type ReplayResult = {
  state: StatePlane;
  index: number;
  trace: ReplayTrace;
  transition?: StateTransition;
};

export type StateAudit = {
  id: string;
  previousHash: string;
  newHash: string;
  diff: Record<string, unknown>;
};

export type ConsistencyInput = {
  yaml?: ControlPlane;
  ast?: DSLAST;
  state: StatePlane;
  ruleResults?: RuleResult[];
};

export type BuildStateInput = {
  yaml?: ControlPlane;
  ast?: DSLAST;
  ruleResults?: RuleResult[];
  plans?: Plan[];
  previous?: StatePlane;
};

export type PersistStateOptions = {
  action?: string;
  consistency?: Omit<ConsistencyInput, "state">;
  skipSnapshot?: boolean;
  metadata?: Partial<StateMetadata>;
};

export type StatePlane = {
  version: string;
  intent: StateIntent;
  ast: ASTStateNode[];
  graph: {
    dependencies: Record<string, string[]>;
  };
  ruleViolations: RuleViolation[];
  plans: StatePlan[];
  stateHash: string;
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
const STATE_VERSION = "2.0.0-alpha";
const SNAPSHOT_INTERVAL = 5;
const DEFAULT_WORKSPACE_UNIT_ID = "workspace:root";

type UnknownRecord = Record<string, unknown>;

function stableSortUnknown(value: unknown): unknown {
  return canonicalizeUnknown(value);
}

function stableStringify(value: unknown): string {
  return deterministicStableStringify(stableSortUnknown(value));
}

function deepClone<T>(value: T): T {
  return cloneJson(value);
}

function cloneUnknown<T>(value: T): T {
  return cloneJsonOrUndefined(value);
}

function splitPath(pathValue: string): string[] {
  return pathValue.split(".").filter((segment) => segment.length > 0);
}

function normalizeUnitId(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_WORKSPACE_UNIT_ID;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_WORKSPACE_UNIT_ID;
}

function setAtPath(target: UnknownRecord, pathValue: string, value: unknown): void {
  const segments = splitPath(pathValue);
  if (segments.length === 0) {
    return;
  }

  let current: UnknownRecord = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = current[segment];
    if (!isRecord(next)) {
      current[segment] = {};
    }

    current = current[segment] as UnknownRecord;
  }

  const lastSegment = segments[segments.length - 1];
  current[lastSegment] = cloneUnknown(value);
}

function deleteAtPath(target: UnknownRecord, pathValue: string): void {
  const segments = splitPath(pathValue);
  if (segments.length === 0) {
    return;
  }

  let current: UnknownRecord = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = current[segment];
    if (!isRecord(next)) {
      return;
    }

    current = next;
  }

  const lastSegment = segments[segments.length - 1];
  delete current[lastSegment];
}

function diffUnknown(before: unknown, after: unknown, pathValue = ""): StatePatch[] {
  if (stableStringify(before) === stableStringify(after)) {
    return [];
  }

  if (Array.isArray(before) || Array.isArray(after) || !isRecord(before) || !isRecord(after)) {
    const op: StatePatch["op"] = typeof after === "undefined" ? "delete" : "set";
    return [{
      path: pathValue,
      op,
      before: cloneUnknown(before),
      ...(op === "set" ? { after: cloneUnknown(after) } : {}),
    }];
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const sortedKeys = [...keys].sort((left, right) => left.localeCompare(right));

  return sortedKeys.flatMap((key) => {
    const nextPath = pathValue.length > 0 ? `${pathValue}.${key}` : key;
    const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(after, key);

    if (!hasAfter) {
      return [{
        path: nextPath,
        op: "delete" as const,
        before: cloneUnknown(before[key]),
      } satisfies StatePatch];
    }

    if (!hasBefore) {
      return [{
        path: nextPath,
        op: "set" as const,
        before: undefined,
        after: cloneUnknown(after[key]),
      } satisfies StatePatch];
    }

    return diffUnknown(before[key], after[key], nextPath);
  });
}

function applyTransitionDiff(state: StatePlane, diff: StateTransitionDiff): StatePlane {
  const working = cloneUnknown(materializeStatePlane(state)) as UnknownRecord;

  for (const patch of diff.patches) {
    if (patch.op === "delete") {
      deleteAtPath(working, patch.path);
      continue;
    }

    setAtPath(working, patch.path, patch.after);
  }

  return materializeStatePlane(working as StatePlane);
}

function stateWithoutHash(state: StatePlane): Omit<StatePlane, "stateHash"> {
  const { stateHash: _ignored, ...rest } = state;
  return rest;
}

function hashStateContent(state: Omit<StatePlane, "stateHash">): string {
  return createHash("sha256").update(stableStringify(state)).digest("hex");
}

function normalizeStateIntent(intent?: Partial<StateIntent>): StateIntent {
  return {
    goals: sortedUnique((intent?.goals ?? []).filter((entry): entry is string => typeof entry === "string")),
    constraints: sortedUnique((intent?.constraints ?? []).filter((entry): entry is string => typeof entry === "string")),
    nonGoals: sortedUnique((intent?.nonGoals ?? []).filter((entry): entry is string => typeof entry === "string")),
  };
}

function parseStateIntent(value: unknown): StateIntent {
  if (!isRecord(value)) {
    return normalizeStateIntent();
  }

  return normalizeStateIntent({
    goals: Array.isArray(value.goals) ? value.goals.filter((entry): entry is string => typeof entry === "string") : [],
    constraints: Array.isArray(value.constraints)
      ? value.constraints.filter((entry): entry is string => typeof entry === "string")
      : [],
    nonGoals: Array.isArray(value.nonGoals) ? value.nonGoals.filter((entry): entry is string => typeof entry === "string") : [],
  });
}

function normalizeAstNodes(nodes: unknown): ASTStateNode[] {
  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes
    .flatMap((node) => {
      if (!isRecord(node)) {
        return [];
      }

      const id = typeof node.id === "string" ? node.id.trim() : "";
      const type = typeof node.type === "string" ? node.type.trim() : "";
      if (id.length === 0 || type.length === 0) {
        return [];
      }

      return [{
        id,
        type: type as ActionNode["type"],
      } satisfies ASTStateNode];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function parseAstNodes(value: unknown): ASTStateNode[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const nodes = value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const type = typeof entry.type === "string" ? entry.type.trim() : "";
    if (!id || !type) {
      return [];
    }

    return [{
      id,
      type: type as ActionNode["type"],
    } satisfies ASTStateNode];
  });

  return normalizeAstNodes(nodes);
}

function normalizeStatePlans(plans: StatePlan[]): StatePlan[] {
  return [...plans]
    .filter((plan) => typeof plan.id === "string" && plan.id.trim().length > 0)
    .map((plan) => ({
      id: plan.id,
      status: typeof plan.status === "string" ? plan.status : "draft",
      taskIds: sortedUnique((plan.taskIds ?? []).filter((entry): entry is string => typeof entry === "string")),
      nodeRefs: sortedUnique((plan.nodeRefs ?? []).filter((entry): entry is string => typeof entry === "string")),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function parseStatePlans(value: unknown): StatePlan[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsed = value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) {
      return [];
    }

    const status = typeof entry.status === "string" ? entry.status : "draft";
    const taskIds = Array.isArray(entry.taskIds)
      ? entry.taskIds.filter((task): task is string => typeof task === "string")
      : [];
    const nodeRefs = Array.isArray(entry.nodeRefs)
      ? entry.nodeRefs.filter((node): node is string => typeof node === "string")
      : [];

    return [{ id, status, taskIds, nodeRefs } satisfies StatePlan];
  });

  return normalizeStatePlans(parsed);
}

function normalizeRuleViolations(violations: RuleViolation[]): RuleViolation[] {
  return [...violations]
    .filter((violation) => typeof violation.ruleId === "string" && violation.ruleId.trim().length > 0)
    .map((violation) => ({
      ruleId: violation.ruleId,
      severity: (violation.severity === "error" ? "error" : "warning") as "error" | "warning",
      message: typeof violation.message === "string" ? violation.message : "",
      ...(typeof violation.actionIndex === "number" && Number.isFinite(violation.actionIndex)
        ? { actionIndex: violation.actionIndex }
        : {}),
    }))
    .sort((left, right) =>
      left.ruleId.localeCompare(right.ruleId)
      || (left.actionIndex ?? Number.MAX_SAFE_INTEGER) - (right.actionIndex ?? Number.MAX_SAFE_INTEGER)
      || left.message.localeCompare(right.message)
    );
}

function parseRuleViolations(value: unknown): RuleViolation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsed = value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const ruleId = typeof entry.ruleId === "string" ? entry.ruleId.trim() : "";
    const severity = entry.severity === "error" ? "error" : entry.severity === "warning" ? "warning" : null;
    const message = typeof entry.message === "string" ? entry.message : "";
    const actionIndex = typeof entry.actionIndex === "number" && Number.isFinite(entry.actionIndex)
      ? entry.actionIndex
      : undefined;

    if (!ruleId || !severity) {
      return [];
    }

    return [{
      ruleId,
      severity,
      message,
      ...(actionIndex !== undefined ? { actionIndex } : {}),
    } satisfies RuleViolation];
  });

  return normalizeRuleViolations(parsed);
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
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
        .filter(isNonNull)
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
  const previewHash = typeof value.previewHash === "string" && value.previewHash.trim().length > 0
    ? value.previewHash.trim()
    : undefined;
  const approvedBy = typeof value.approvedBy === "string" ? value.approvedBy.trim() : "";
  const timestamp = typeof value.timestamp === "string" ? value.timestamp.trim() : "";

  if (id.length === 0 || diffHash.length === 0 || approvedBy.length === 0 || timestamp.length === 0) {
    return null;
  }

  return {
    id,
    diffHash,
    ...(previewHash ? { previewHash } : {}),
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
  const previewHash = typeof value.previewHash === "string" && value.previewHash.trim().length > 0
    ? value.previewHash.trim()
    : undefined;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt.trim() : "";
  const command = typeof value.command === "string" ? value.command.trim() : "";
  const diffs = Array.isArray(value.diffs) ? value.diffs as YAMLDiff[] : [];

  if (id.length === 0 || diffHash.length === 0 || createdAt.length === 0 || command.length === 0) {
    return null;
  }

  return {
    id,
    diffHash,
    ...(previewHash ? { previewHash } : {}),
    diffs: [...diffs].sort((left, right) =>
      left.path.localeCompare(right.path)
      || left.operation.localeCompare(right.operation)
    ),
    createdAt,
    command,
  };
}

function materializeApprovals(records: ApprovalRecord[]): ApprovalRecord[] {
  const byApprovalHash = new Map<string, ApprovalRecord>();

  for (const record of records) {
    if (!record.id || !record.diffHash || !record.approvedBy || !record.timestamp) {
      continue;
    }

    const approvalHash = record.previewHash ?? record.diffHash;

    if (!byApprovalHash.has(approvalHash)) {
      byApprovalHash.set(approvalHash, {
        id: record.id,
        diffHash: record.diffHash,
        ...(record.previewHash ? { previewHash: record.previewHash } : {}),
        approvedBy: record.approvedBy,
        timestamp: record.timestamp,
      });
    }
  }

  return [...byApprovalHash.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
    || left.diffHash.localeCompare(right.diffHash)
    || (left.previewHash ?? "").localeCompare(right.previewHash ?? "")
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
      ...(record.previewHash ? { previewHash: record.previewHash } : {}),
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
    version: STATE_VERSION,
    intent: {
      goals: [],
      constraints: [],
      nonGoals: [],
    },
    ast: [],
    graph: {
      dependencies: {},
    },
    ruleViolations: [],
    plans: [],
    stateHash: "",
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
  recoverStatePersistenceIfNeeded(root);
  const statePath = getStatePath(root);
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const record = isRecord(parsed) ? parsed : {};

    const state = materializeStatePlane({
      version: typeof record.version === "string" && record.version.trim().length > 0 ? record.version : STATE_VERSION,
      intent: parseStateIntent(record.intent),
      ast: parseAstNodes(record.ast),
      graph: {
        dependencies: parseGraph(isRecord(record.graph) ? record.graph.dependencies : undefined),
      },
      ruleViolations: parseRuleViolations(record.ruleViolations),
      plans: parseStatePlans(record.plans),
      stateHash: typeof record.stateHash === "string" ? record.stateHash : "",
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
          .filter(isNonNull)
        : [],
      pendingApprovals: Array.isArray(record.pendingApprovals)
        ? record.pendingApprovals
          .map((entry) => parsePendingApprovalRecord(entry))
          .filter(isNonNull)
        : [],
    });

    const validation = validateState(state);
    if (!validation.valid) {
      throw new Error(`Invalid state.json at ${statePath}: ${validation.issues.map((issue) => `${issue.path}:${issue.code}`).join(", ")}`);
    }

    return state;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`Unable to read valid state.json at ${statePath}: ${reason}`);
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
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
  const statePath = persistStatePlane(root, nextState, { action: "update-execution-state" });

  return {
    statePath,
    state: nextState,
  };
}

export function materializeStatePlane(input: StatePlane): StatePlane {
  const filesAnalyzed = typeof input.metrics?.filesAnalyzed === "number" && Number.isFinite(input.metrics.filesAnalyzed)
    ? input.metrics.filesAnalyzed
    : typeof input.metrics?.filesScanned === "number" && Number.isFinite(input.metrics.filesScanned)
      ? input.metrics.filesScanned
      : 0;
  const rulesEvaluated = typeof input.metrics?.rulesEvaluated === "number" && Number.isFinite(input.metrics.rulesEvaluated)
    ? input.metrics.rulesEvaluated
    : 0;
  const normalizedMetrics = {
    ...input.metrics,
    filesAnalyzed,
    rulesEvaluated,
  };

  const normalized: Omit<StatePlane, "stateHash"> = {
    version: typeof input.version === "string" && input.version.trim().length > 0 ? input.version : STATE_VERSION,
    intent: normalizeStateIntent(input.intent),
    ast: normalizeAstNodes(input.ast),
    graph: {
      dependencies: sortRecordValues(input.graph?.dependencies ?? input.dependencyGraph ?? {}),
    },
    ruleViolations: normalizeRuleViolations(input.ruleViolations ?? []),
    plans: normalizeStatePlans(input.plans ?? []),
    astIndex: sortAstIndex(input.astIndex),
    symbolGraph: sortRecordValues(input.symbolGraph),
    violations: sortViolations(input.violations),
    metrics: Object.fromEntries(
      Object.keys(normalizedMetrics)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => [key, (normalizedMetrics as Record<string, number>)[key]])
    ),
    dependencyGraph: sortRecordValues(input.dependencyGraph),
    execution: materializeExecutionState(input.execution),
    strategyHistory: materializeStrategyHistory(input.strategyHistory),
    approvals: materializeApprovals(input.approvals),
    pendingApprovals: materializePendingApprovals(input.pendingApprovals),
  };

  const stateHash = hashStateContent(normalized);

  return {
    ...normalized,
    stateHash,
  };
}

function toActionNodeId(index: number): string {
  return `action:${index}`;
}

function astNodesFromDslAst(ast?: DSLAST): ASTStateNode[] {
  if (!ast) {
    return [];
  }

  const actions = ast.type === "sequence" ? ast.actions : [ast];
  return actions.map((action, index) => ({
    id: toActionNodeId(index),
    type: action.type,
  } satisfies ASTStateNode));
}

function dependenciesFromDslAst(ast?: DSLAST): Record<string, string[]> {
  if (!ast) {
    return {};
  }

  const actions = ast.type === "sequence" ? ast.actions : [ast];
  const dependencies: Record<string, string[]> = {};

  for (let index = 0; index < actions.length; index += 1) {
    const nodeId = toActionNodeId(index);
    const next = index < actions.length - 1 ? [toActionNodeId(index + 1)] : [];
    dependencies[nodeId] = next;
  }

  return dependencies;
}

function statePlansFromControlPlans(plans: Plan[] | undefined, astNodes: ASTStateNode[]): StatePlan[] {
  const nodes = astNodes.map((node) => node.id);
  return normalizeStatePlans((plans ?? []).map((plan) => ({
    id: plan.id,
    status: plan.status,
    taskIds: plan.tasks.map((task) => task.id),
    nodeRefs: nodes,
  })));
}

function ruleViolationsFromRuleResults(ruleResults?: RuleResult[]): RuleViolation[] {
  if (!ruleResults) {
    return [];
  }

  return normalizeRuleViolations(ruleResults.map((result) => ({
    ruleId: result.ruleId,
    severity: result.severity,
    message: result.message,
    ...(typeof result.actionIndex === "number" ? { actionIndex: result.actionIndex } : {}),
  })));
}

function validationIssue(code: string, message: string, pathValue: string): StateValidationIssue {
  return {
    code,
    message,
    path: pathValue,
  };
}

function valuesEqual<T>(left: T, right: T): boolean {
  return stableStringify(left) === stableStringify(right);
}

export function buildState(input: BuildStateInput): StatePlane {
  const previous = input.previous ?? createEmptyStatePlane();
  const astNodes = astNodesFromDslAst(input.ast);
  const effectiveAstNodes = astNodes.length > 0 ? astNodes : previous.ast;
  const dependencies = dependenciesFromDslAst(input.ast);
  const intent = input.yaml
    ? normalizeStateIntent({
      goals: input.yaml.intent.goals,
      constraints: input.yaml.intent.constraints,
      nonGoals: input.yaml.intent["non-goals"],
    })
    : normalizeStateIntent(previous.intent);

  const plans = input.plans
    ? statePlansFromControlPlans(input.plans, effectiveAstNodes)
    : input.yaml
      ? statePlansFromControlPlans(input.yaml.execution.plans, effectiveAstNodes)
      : normalizeStatePlans(previous.plans);

  const next = materializeStatePlane({
    ...previous,
    version: STATE_VERSION,
    intent,
    ast: effectiveAstNodes,
    graph: {
      dependencies: Object.keys(dependencies).length > 0
        ? dependencies
        : previous.graph.dependencies,
    },
    ruleViolations: input.ruleResults
      ? ruleViolationsFromRuleResults(input.ruleResults)
      : previous.ruleViolations,
    plans,
  });

  return next;
}

export function hashState(state: StatePlane): string {
  return hashStateContent(stateWithoutHash(materializeStatePlane(state)));
}

export function validateState(state: StatePlane): ValidationResult {
  const issues: StateValidationIssue[] = [];
  const normalized = materializeStatePlane(state);

  if (!normalized.version || typeof normalized.version !== "string") {
    issues.push(validationIssue("missing-version", "Missing state version", "version"));
  }

  if (!Array.isArray(normalized.intent.goals) || !Array.isArray(normalized.intent.constraints) || !Array.isArray(normalized.intent.nonGoals)) {
    issues.push(validationIssue("intent-invalid", "Intent arrays are required", "intent"));
  }

  const nodeIds = new Set(normalized.ast.map((node) => node.id));
  for (const node of normalized.ast) {
    if (!node.id || !node.type) {
      issues.push(validationIssue("ast-node-invalid", "AST node requires id and type", "ast"));
    }
  }

  for (const [nodeId, refs] of Object.entries(normalized.graph.dependencies)) {
    if (!nodeIds.has(nodeId)) {
      issues.push(validationIssue("graph-source-missing", `Graph source node does not exist: ${nodeId}`, `graph.dependencies.${nodeId}`));
    }

    for (const ref of refs) {
      if (!nodeIds.has(ref)) {
        issues.push(validationIssue("graph-target-missing", `Graph dependency node does not exist: ${ref}`, `graph.dependencies.${nodeId}`));
      }
    }
  }

  for (let index = 0; index < normalized.plans.length; index += 1) {
    const plan = normalized.plans[index];
    if (!plan.id) {
      issues.push(validationIssue("plan-id-missing", "Plan id is required", `plans[${index}].id`));
    }

    for (const nodeRef of plan.nodeRefs) {
      if (!nodeIds.has(nodeRef)) {
        issues.push(validationIssue("plan-node-ref-missing", `Plan nodeRef does not exist: ${nodeRef}`, `plans[${index}].nodeRefs`));
      }
    }
  }

  if (normalized.stateHash !== hashState(normalized)) {
    issues.push(validationIssue("state-hash-mismatch", "State hash integrity check failed", "stateHash"));
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function validateConsistency(input: ConsistencyInput): ValidationResult {
  const issues: StateValidationIssue[] = [];
  const state = materializeStatePlane(input.state);

  if (input.yaml) {
    const yamlIntent = normalizeStateIntent({
      goals: input.yaml.intent.goals,
      constraints: input.yaml.intent.constraints,
      nonGoals: input.yaml.intent["non-goals"],
    });

    if (!valuesEqual(yamlIntent, state.intent)) {
      issues.push(validationIssue("yaml-intent-divergence", "YAML intent diverges from state intent", "intent"));
    }

    const expectedPlans = statePlansFromControlPlans(input.yaml.execution.plans, state.ast);
    if (!valuesEqual(expectedPlans, state.plans)) {
      issues.push(validationIssue("yaml-plan-divergence", "YAML plans diverge from state plans", "plans"));
    }
  }

  if (input.ast) {
    const expectedAst = normalizeAstNodes(astNodesFromDslAst(input.ast));
    const expectedGraph = sortRecordValues(dependenciesFromDslAst(input.ast));

    if (!valuesEqual(expectedAst, state.ast)) {
      issues.push(validationIssue("ast-divergence", "State AST projection diverges from DSL AST", "ast"));
    }

    if (!valuesEqual(expectedGraph, state.graph.dependencies)) {
      issues.push(validationIssue("graph-divergence", "State dependency graph diverges from DSL AST", "graph.dependencies"));
    }
  }

  if (input.ruleResults) {
    const expectedViolations = ruleViolationsFromRuleResults(input.ruleResults);
    if (!valuesEqual(expectedViolations, state.ruleViolations)) {
      issues.push(validationIssue("rule-divergence", "State rule violations diverge from rule output", "ruleViolations"));
    }

    const maxNodeIndex = state.ast.length - 1;
    for (let index = 0; index < input.ruleResults.length; index += 1) {
      const result = input.ruleResults[index];
      if (result.actionIndex === undefined) {
        continue;
      }

      if (result.actionIndex < 0 || result.actionIndex > maxNodeIndex) {
        issues.push(validationIssue(
          "rule-action-index-out-of-range",
          `Rule action index out of range: ${result.actionIndex}`,
          `ruleResults[${index}].actionIndex`
        ));
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function validateFullVsIncrementalState(
  current: StatePlane,
  recomputed: StatePlane
): ValidationResult {
  const issues: StateValidationIssue[] = [];
  const left = materializeStatePlane(current);
  const right = materializeStatePlane(recomputed);

  if (!valuesEqual(left.intent, right.intent)) {
    issues.push(validationIssue("recompute-intent-divergence", "Incremental state intent differs from full recomputation", "intent"));
  }

  if (!valuesEqual(left.ast, right.ast)) {
    issues.push(validationIssue("recompute-ast-divergence", "Incremental state AST differs from full recomputation", "ast"));
  }

  if (!valuesEqual(left.graph, right.graph)) {
    issues.push(validationIssue("recompute-graph-divergence", "Incremental state graph differs from full recomputation", "graph"));
  }

  if (!valuesEqual(left.ruleViolations, right.ruleViolations)) {
    issues.push(validationIssue("recompute-rule-divergence", "Incremental rule violations differ from full recomputation", "ruleViolations"));
  }

  if (!valuesEqual(left.plans, right.plans)) {
    issues.push(validationIssue("recompute-plan-divergence", "Incremental plans differ from full recomputation", "plans"));
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

function stateSnapshotsPath(root: string): string {
  return path.join(root, ".choir", "state.snapshots.jsonl");
}

function stateTransitionsPath(root: string): string {
  return path.join(root, ".choir", "state.transitions.jsonl");
}

function stateAuditPath(root: string): string {
  return path.join(root, ".choir", "state.audit.jsonl");
}

type StatePersistJournal = {
  schemaVersion: 1;
  transition: StateTransition;
  snapshot?: StateSnapshot;
  audit: StateAudit;
  previousRaw: string | null;
  nextPayload: string;
};

function statePersistJournalPath(root: string): string {
  return path.join(root, ".choir", "state.persist.journal.json");
}

function readJsonLines<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs.readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${stableStringify(value)}\n`, "utf-8");
}

function buildStateSnapshot(state: StatePlane, logicalTime: number): StateSnapshot {
  const normalized = materializeStatePlane(state);
  const timestamp = deterministicTimestampFromCounter(logicalTime);
  return {
    id: deterministicId("state", {
      hash: normalized.stateHash,
      logicalTime,
      timestamp,
    }, 12),
    timestamp,
    state: deepClone(normalized),
    hash: normalized.stateHash,
  };
}

function readStatePersistJournal(root: string): StatePersistJournal | null {
  const filePath = statePersistJournalPath(root);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (raw.length === 0) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<StatePersistJournal>;
    if (
      parsed.schemaVersion !== 1
      || !parsed.transition
      || !parsed.audit
      || (parsed.previousRaw !== null && typeof parsed.previousRaw !== "string")
      || typeof parsed.nextPayload !== "string"
    ) {
      return null;
    }

    const transition = normalizeStateTransition(parsed.transition);
    if (!transition) {
      return null;
    }

    const snapshot = parsed.snapshot
      ? {
        id: String((parsed.snapshot as StateSnapshot).id),
        timestamp: String((parsed.snapshot as StateSnapshot).timestamp),
        state: materializeStatePlane((parsed.snapshot as StateSnapshot).state),
        hash: String((parsed.snapshot as StateSnapshot).hash),
      } satisfies StateSnapshot
      : undefined;

    const auditRecord = parsed.audit as Partial<StateAudit>;
    if (
      typeof auditRecord.id !== "string"
      || typeof auditRecord.previousHash !== "string"
      || typeof auditRecord.newHash !== "string"
      || !isRecord(auditRecord.diff)
    ) {
      return null;
    }

    return {
      schemaVersion: 1,
      transition,
      ...(snapshot ? { snapshot } : {}),
      audit: {
        id: auditRecord.id,
        previousHash: auditRecord.previousHash,
        newHash: auditRecord.newHash,
        diff: cloneUnknown(auditRecord.diff),
      },
      previousRaw: parsed.previousRaw ?? null,
      nextPayload: parsed.nextPayload,
    };
  } catch {
    return null;
  }
}

function persistStatePersistJournal(root: string, journal: StatePersistJournal): void {
  atomicWriteJson(statePersistJournalPath(root), `${stableStringify(journal)}\n`);
}

function removeStatePersistJournal(root: string): void {
  try {
    fs.rmSync(statePersistJournalPath(root), { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

function transitionExists(root: string, transitionId: string): boolean {
  return listStateTransitions(root).some((entry) => entry.id === transitionId);
}

function snapshotExists(root: string, snapshotId: string): boolean {
  return readJsonLines<unknown>(stateSnapshotsPath(root)).some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }

    return typeof entry.id === "string" && entry.id === snapshotId;
  });
}

function auditExists(root: string, auditId: string): boolean {
  return readJsonLines<StateAudit>(stateAuditPath(root)).some((entry) => entry.id === auditId);
}

function applyStatePersistJournal(root: string, journal: StatePersistJournal): void {
  const statePath = getStatePath(root);
  atomicWriteJson(statePath, journal.nextPayload);

  if (!transitionExists(root, journal.transition.id)) {
    recordStateTransition(root, journal.transition);
  }

  if (journal.snapshot && !snapshotExists(root, journal.snapshot.id)) {
    appendJsonLine(stateSnapshotsPath(root), journal.snapshot);
  }

  if (!auditExists(root, journal.audit.id)) {
    recordStateAudit(root, journal.audit);
  }

  removeStatePersistJournal(root);
}

function recoverStatePersistenceIfNeeded(root: string): void {
  const journal = readStatePersistJournal(root);
  if (!journal) {
    return;
  }

  applyStatePersistJournal(root, journal);
}

function computeStateDiff(previous: StatePlane | null, next: StatePlane): StateTransitionDiff {
  const base = materializeStatePlane(previous ?? createEmptyStatePlane());
  const target = materializeStatePlane(next);
  const patches = diffUnknown(base, target);

  return {
    patchCount: patches.length,
    patches,
  };
}

function normalizeTransitionDiff(value: unknown): StateTransitionDiff {
  if (!isRecord(value) || !Array.isArray(value.patches)) {
    return {
      patchCount: 0,
      patches: [],
    };
  }

  const patches = value.patches.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const pathValue = typeof entry.path === "string" ? entry.path.trim() : "";
    if (pathValue.length === 0) {
      return [];
    }

    const op = entry.op === "delete" ? "delete" : entry.op === "set" ? "set" : null;
    if (!op) {
      return [];
    }

    return [{
      path: pathValue,
      op,
      before: cloneUnknown(entry.before),
      ...(op === "set" ? { after: cloneUnknown(entry.after) } : {}),
    } satisfies StatePatch];
  }).sort((left, right) => left.path.localeCompare(right.path) || left.op.localeCompare(right.op));

  return {
    patchCount: patches.length,
    patches,
  };
}

function normalizeStateMetadata(value: unknown): StateMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const command = typeof value.command === "string" && value.command.trim().length > 0
    ? value.command
    : undefined;
  const policyDecision = typeof value.policyDecision === "string" && value.policyDecision.trim().length > 0
    ? value.policyDecision
    : undefined;
  const auditId = typeof value.auditId === "string" && value.auditId.trim().length > 0
    ? value.auditId
    : undefined;

  if (!command || !policyDecision || !auditId) {
    return undefined;
  }

  const ruleTriggers = Array.isArray(value.ruleTriggers)
    ? sortedUnique(value.ruleTriggers.filter((entry): entry is string => typeof entry === "string"))
    : [];
  const dependencyChain = Array.isArray(value.dependencyChain)
    ? value.dependencyChain.filter((entry): entry is string => typeof entry === "string")
    : [];
  const unitId = normalizeUnitId(value.unitId);

  return {
    command,
    policyDecision,
    auditId,
    ...(ruleTriggers.length > 0 ? { ruleTriggers } : {}),
    ...(dependencyChain.length > 0 ? { dependencyChain } : {}),
    unitId,
  };
}

function normalizeStateTransition(value: unknown): StateTransition | null {
  if (!isRecord(value)) {
    return null;
  }

  const fromHash = typeof value.fromHash === "string"
    ? value.fromHash
    : typeof value.from === "string"
      ? value.from
      : "";
  const toHash = typeof value.toHash === "string"
    ? value.toHash
    : typeof value.to === "string"
      ? value.to
      : "";
  const action = typeof value.action === "string" && value.action.trim().length > 0
    ? value.action
    : typeof value.operation === "string" && value.operation.trim().length > 0
      ? value.operation
      : "persist-state";

  if (fromHash.trim().length === 0 || toHash.trim().length === 0) {
    return null;
  }

  const numericTimestamp = typeof value.timestamp === "number" && Number.isFinite(value.timestamp) && value.timestamp > 0
    ? Math.floor(value.timestamp)
    : 0;
  const logicalTime = typeof value.logicalTime === "number" && Number.isFinite(value.logicalTime) && value.logicalTime > 0
    ? Math.floor(value.logicalTime)
    : numericTimestamp;
  const timestamp = typeof value.timestamp === "string" && value.timestamp.trim().length > 0
    ? value.timestamp
    : deterministicTimestampFromCounter(logicalTime > 0 ? logicalTime : numericTimestamp);
  const id = typeof value.id === "string" && value.id.trim().length > 0
    ? value.id
    : deterministicId("transition", { fromHash, toHash, action, logicalTime }, 12);
  const metadata = normalizeStateMetadata(value.metadata);
  const unitId = normalizeUnitId(
    typeof value.unitId === "string"
      ? value.unitId
      : metadata?.unitId
  );

  return {
    id,
    logicalTime,
    unitId,
    fromHash,
    toHash,
    action,
    timestamp,
    diff: normalizeTransitionDiff(value.diff),
    ...(metadata ? { metadata } : {}),
  };
}

export function validateTransition(previous: StatePlane | null, next: StatePlane, action: string): ValidationResult {
  const issues: StateValidationIssue[] = [];
  if (!action || action.trim().length === 0) {
    issues.push(validationIssue("transition-action-missing", "State transition action is required", "action"));
  }

  if (!previous) {
    return {
      valid: issues.length === 0,
      issues,
    };
  }

  const allowedKeys = new Set([
    "version",
    "intent",
    "ast",
    "graph",
    "ruleViolations",
    "plans",
    "stateHash",
    "astIndex",
    "symbolGraph",
    "violations",
    "metrics",
    "dependencyGraph",
    "execution",
    "strategyHistory",
    "approvals",
    "pendingApprovals",
  ]);

  for (const key of Object.keys(next)) {
    if (!allowedKeys.has(key)) {
      issues.push(validationIssue("transition-unexpected-field", `Unexpected state field mutation: ${key}`, key));
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

function saveSnapshot(root: string, state: StatePlane, logicalTime?: number): StateSnapshot {
  const normalized = materializeStatePlane(state);
  const timestamp = typeof logicalTime === "number" && Number.isFinite(logicalTime) && logicalTime > 0
    ? deterministicTimestampFromCounter(Math.floor(logicalTime))
    : deterministicTimestampFromString(normalized.stateHash);
  const snapshot: StateSnapshot = {
    id: deterministicId("state", {
      hash: normalized.stateHash,
      logicalTime: typeof logicalTime === "number" && Number.isFinite(logicalTime) ? Math.floor(logicalTime) : 0,
      timestamp,
    }, 12),
    timestamp,
    state: deepClone(normalized),
    hash: normalized.stateHash,
  };

  appendJsonLine(stateSnapshotsPath(root), snapshot);
  return snapshot;
}

function recordStateTransition(root: string, transition: StateTransition): void {
  appendJsonLine(stateTransitionsPath(root), transition);
}

function recordStateAudit(root: string, audit: StateAudit): void {
  appendJsonLine(stateAuditPath(root), audit);
}

export function listSnapshots(root: string): StateSnapshot[] {
  return readJsonLines<unknown>(stateSnapshotsPath(root))
    .flatMap((entry) => {
      if (!isRecord(entry)) {
        return [];
      }

      if (typeof entry.id !== "string" || typeof entry.timestamp !== "string" || typeof entry.hash !== "string" || !isRecord(entry.state)) {
        return [];
      }

      try {
        return [{
          id: entry.id,
          timestamp: entry.timestamp,
          state: materializeStatePlane(entry.state as StatePlane),
          hash: entry.hash,
        } satisfies StateSnapshot];
      } catch {
        return [];
      }
    })
    .sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp)
      || left.id.localeCompare(right.id)
    );
}

export function listStateTransitions(root: string): StateTransition[] {
  return readJsonLines<unknown>(stateTransitionsPath(root))
    .map((entry) => normalizeStateTransition(entry))
    .filter(isNonNull)
    .sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp)
      || left.id.localeCompare(right.id)
    );
}

function toTimelineEvent(transition: StateTransition, index: number): TimelineEvent {
  const eventType: TimelineEvent["type"] = transition.action.startsWith("rollback") ? "rollback" : "transition";
  return {
    id: transition.id,
    type: eventType,
    timestamp: transition.logicalTime > 0 ? transition.logicalTime : index + 1,
    unitId: normalizeUnitId(transition.unitId),
    action: transition.action,
    stateHashBefore: transition.fromHash,
    stateHashAfter: transition.toHash,
    diff: transition.diff,
  };
}

export function buildGlobalTimeline(root: string): GlobalTimeline {
  const transitions = listStateTransitions(root);
  return {
    events: transitions.map((transition, index) => toTimelineEvent(transition, index)),
  };
}

export function buildUnitTimeline(root: string, unitId: string): UnitTimeline {
  const normalizedUnitId = normalizeUnitId(unitId);
  const global = buildGlobalTimeline(root);
  return {
    unitId: normalizedUnitId,
    events: global.events.filter((event) => event.unitId === normalizedUnitId),
  };
}

export function buildStateTimeline(root: string): StateTimeline {
  return {
    snapshots: listSnapshots(root),
    transitions: listStateTransitions(root),
  };
}

function fallbackToSnapshot(
  snapshots: StateSnapshot[],
  transitions: StateTransition[],
  targetIndex: number,
  visitedStates: string[]
): ReplayResult {
  const targetTransition = transitions[targetIndex];
  const targetHash = targetTransition.toHash;
  const direct = snapshots.find((snapshot) => snapshot.hash === targetHash);
  if (direct) {
    const replayTime = visitedStates.length + 1;
    return {
      state: materializeStatePlane(direct.state),
      index: targetIndex,
      transition: targetTransition,
      trace: {
        visitedStates: [...visitedStates, direct.hash],
        replayTime,
        consistencyCheck: true,
        fallbackUsed: true,
      },
    };
  }

  let best: { snapshot: StateSnapshot; index: number } | null = null;
  for (let index = 0; index <= targetIndex; index += 1) {
    const hash = transitions[index]?.toHash;
    if (!hash) {
      continue;
    }

    const snapshot = snapshots.find((entry) => entry.hash === hash);
    if (!snapshot) {
      continue;
    }

    if (!best || index > best.index) {
      best = { snapshot, index };
    }
  }

  if (!best) {
    throw new Error("Replay failed and no fallback snapshot is available");
  }

  const replayTime = visitedStates.length + 1;
  return {
    state: materializeStatePlane(best.snapshot.state),
    index: targetIndex,
    transition: targetTransition,
    trace: {
      visitedStates: [...visitedStates, best.snapshot.hash],
      replayTime,
      consistencyCheck: best.snapshot.hash === targetHash,
      fallbackUsed: true,
    },
  };
}

export function jumpTo(root: string, index: number): ReplayResult {
  const timeline = buildStateTimeline(root);

  if (timeline.transitions.length === 0) {
    const state = readStatePlane(root) ?? createEmptyStatePlane();
    return {
      state,
      index: -1,
      trace: {
        visitedStates: [state.stateHash],
        replayTime: 0,
        consistencyCheck: true,
        fallbackUsed: false,
      },
    };
  }

  const clampedIndex = Math.max(0, Math.min(index, timeline.transitions.length - 1));
  const transitions = timeline.transitions;
  const snapshots = timeline.snapshots;
  const target = transitions[clampedIndex];
  const targetHash = target.toHash;

  const directSnapshot = snapshots.find((snapshot) => snapshot.hash === targetHash);
  if (directSnapshot) {
    return {
      state: materializeStatePlane(directSnapshot.state),
      index: clampedIndex,
      transition: target,
      trace: {
        visitedStates: [directSnapshot.hash],
        replayTime: 1,
        consistencyCheck: true,
        fallbackUsed: false,
      },
    };
  }

  let baseSnapshot: StateSnapshot | null = null;
  let baseIndex = -1;
  for (let candidateIndex = clampedIndex - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const hash = transitions[candidateIndex]?.toHash;
    if (!hash) {
      continue;
    }

    const snapshot = snapshots.find((entry) => entry.hash === hash);
    if (!snapshot) {
      continue;
    }

    baseSnapshot = snapshot;
    baseIndex = candidateIndex;
    break;
  }

  if (!baseSnapshot) {
    baseSnapshot = snapshots[0] ?? null;
    if (baseSnapshot) {
      const foundIndex = transitions.findIndex((entry) => entry.toHash === baseSnapshot?.hash);
      baseIndex = foundIndex;
    }
  }

  if (!baseSnapshot) {
    throw new Error("Replay requires at least one snapshot");
  }

  const visitedStates: string[] = [baseSnapshot.hash];
  try {
    let current = materializeStatePlane(baseSnapshot.state);

    for (let currentIndex = baseIndex + 1; currentIndex <= clampedIndex; currentIndex += 1) {
      const transition = transitions[currentIndex];
      current = applyTransitionDiff(current, transition.diff);
      const computedHash = hashState(current);
      visitedStates.push(computedHash);
      if (computedHash !== transition.toHash) {
        throw new Error(`Replay hash mismatch at transition ${transition.id}`);
      }
    }

    return {
      state: materializeStatePlane(current),
      index: clampedIndex,
      transition: target,
      trace: {
        visitedStates,
        replayTime: visitedStates.length,
        consistencyCheck: true,
        fallbackUsed: false,
      },
    };
  } catch {
    return fallbackToSnapshot(snapshots, transitions, clampedIndex, visitedStates);
  }
}

function replayTo(root: string, snapshotId: string): ReplayResult {
  const transitions = listStateTransitions(root);
  const index = transitions.findIndex((entry) => entry.id === snapshotId || entry.toHash === snapshotId);
  if (index < 0) {
    throw new Error(`Replay target not found: ${snapshotId}`);
  }

  return jumpTo(root, index);
}

export function stepForward(root: string, currentIndex: number): ReplayResult {
  const transitions = listStateTransitions(root);
  if (transitions.length === 0) {
    return jumpTo(root, -1);
  }

  const nextIndex = Math.min(currentIndex + 1, transitions.length - 1);
  return jumpTo(root, nextIndex);
}

export function stepBackward(root: string, currentIndex: number): ReplayResult {
  const transitions = listStateTransitions(root);
  if (transitions.length === 0) {
    return jumpTo(root, -1);
  }

  const previousIndex = Math.max(currentIndex - 1, 0);
  return jumpTo(root, previousIndex);
}

export function resolveDeterministicRollbackTarget(root: string): {
  state: StatePlane;
  fromHash: string;
  toHash: string;
  sourceTransitionId?: string;
} {
  const current = readStatePlane(root) ?? createEmptyStatePlane();
  const transitions = listStateTransitions(root);
  if (transitions.length === 0) {
    return {
      state: current,
      fromHash: current.stateHash,
      toHash: current.stateHash,
    };
  }

  const latest = transitions[transitions.length - 1] as StateTransition;
  const fromHash = latest.toHash;

  if (latest.fromHash === "GENESIS") {
    const genesis = createEmptyStatePlane();
    return {
      state: genesis,
      fromHash,
      toHash: genesis.stateHash,
      sourceTransitionId: latest.id,
    };
  }

  let previousIndex = -1;
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    if (transitions[index]?.toHash === latest.fromHash) {
      previousIndex = index;
      break;
    }
  }
  if (previousIndex < 0) {
    throw new Error(`Rollback target not found for transition ${latest.id}`);
  }

  const replayed = jumpTo(root, previousIndex);
  return {
    state: replayed.state,
    fromHash,
    toHash: replayed.state.stateHash,
    sourceTransitionId: latest.id,
  };
}

export function rollbackState(root: string, snapshotId: string): StatePlane {
  const snapshots = listSnapshots(root);
  const target = snapshots.find((snapshot) => snapshot.id === snapshotId);
  if (!target) {
    throw new Error(`Snapshot not found: ${snapshotId}`);
  }

  const validated = materializeStatePlane(target.state);
  const result = validateState(validated);
  if (!result.valid) {
    throw new Error(`Snapshot is invalid: ${result.issues.map((issue) => issue.code).join(", ")}`);
  }

  persistStatePlane(root, validated, {
    action: "rollback",
    skipSnapshot: false,
  });

  return validated;
}

export function replaySnapshots(root: string, snapshotIds: string[]): StatePlane[] {
  const snapshotMap = new Map(listSnapshots(root).map((snapshot) => [snapshot.id, snapshot] as const));
  const states: StatePlane[] = [];

  for (const id of snapshotIds) {
    const snapshot = snapshotMap.get(id);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${id}`);
    }

    states.push(materializeStatePlane(snapshot.state));
  }

  return states;
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
  const statePath = persistStatePlane(root, nextState, { action: "append-strategy-history" });

  return {
    statePath,
    state: nextState,
  };
}

function atomicWriteJson(filePath: string, payload: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${createHash("sha256").update(payload).digest("hex").slice(0, 12)}`;
  fs.writeFileSync(tempPath, payload, "utf-8");
  fs.renameSync(tempPath, filePath);
}

export function persistStatePlane(root: string, state: StatePlane, options?: PersistStateOptions): string {
  recoverStatePersistenceIfNeeded(root);
  const statePath = getStatePath(root);
  const previousRaw = fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf-8") : null;
  const previousState = previousRaw ? readStatePlane(root) : null;
  const transitionCountBeforeWrite = listStateTransitions(root).length;

  const nextState = materializeStatePlane(state);
  const validation = validateState(nextState);
  if (!validation.valid) {
    throw new Error(`State validation failed: ${validation.issues.map((issue) => `[${issue.code}] ${issue.path}`).join(", ")}`);
  }

  if (options?.consistency) {
    const consistency = validateConsistency({
      ...options.consistency,
      state: nextState,
    });

    if (!consistency.valid) {
      throw new Error(`State consistency validation failed: ${consistency.issues.map((issue) => `[${issue.code}] ${issue.path}`).join(", ")}`);
    }
  }

  const transitionValidation = validateTransition(previousState, nextState, options?.action ?? "persist-state");
  if (!transitionValidation.valid) {
    throw new Error(`Invalid state transition: ${transitionValidation.issues.map((issue) => `[${issue.code}] ${issue.path}`).join(", ")}`);
  }

  const nextPayload = `${JSON.stringify(nextState, null, 2)}\n`;
  const previousHash = previousState?.stateHash ?? "GENESIS";
  const transitionNumber = transitionCountBeforeWrite + 1;
  const timestamp = deterministicTimestampFromCounter(transitionNumber);
  const transitionId = deterministicId("transition", {
    fromHash: previousHash,
    toHash: nextState.stateHash,
    action: options?.action ?? "persist-state",
    logicalTime: transitionNumber,
  }, 12);
  const transitionDiff = computeStateDiff(previousState, nextState);
  const unitId = normalizeUnitId(options?.metadata?.unitId);
  const metadata: StateMetadata = {
    command: options?.metadata?.command ?? options?.action ?? "persist-state",
    policyDecision: options?.metadata?.policyDecision ?? "allow",
    auditId: options?.metadata?.auditId ?? `state-transition-${transitionId}`,
    ...(options?.metadata?.ruleTriggers && options.metadata.ruleTriggers.length > 0
      ? { ruleTriggers: sortedUnique(options.metadata.ruleTriggers) }
      : {}),
    ...(options?.metadata?.dependencyChain && options.metadata.dependencyChain.length > 0
      ? { dependencyChain: [...options.metadata.dependencyChain] }
      : { dependencyChain: transitionDiff.patches.map((patch) => patch.path) }
    ),
    unitId,
  };

  const transition: StateTransition = {
    id: transitionId,
    logicalTime: transitionNumber,
    unitId,
    fromHash: previousHash,
    toHash: nextState.stateHash,
    action: options?.action ?? "persist-state",
    timestamp,
    diff: transitionDiff,
    metadata,
  };

  const shouldSaveSnapshot = !options?.skipSnapshot
    && (transitionCountBeforeWrite === 0 || transitionNumber % SNAPSHOT_INTERVAL === 0);
  const snapshot = shouldSaveSnapshot ? buildStateSnapshot(nextState, transitionNumber) : undefined;

  const stateAudit: StateAudit = {
    id: deterministicId("state-audit", {
      transitionId,
      fromHash: previousHash,
      toHash: nextState.stateHash,
    }, 12),
    previousHash,
    newHash: nextState.stateHash,
    diff: {
      patchCount: transitionDiff.patchCount,
      patchedPaths: transitionDiff.patches.map((patch) => patch.path),
    },
  };

  const journal: StatePersistJournal = {
    schemaVersion: 1,
    transition,
    ...(snapshot ? { snapshot } : {}),
    audit: stateAudit,
    previousRaw,
    nextPayload,
  };

  persistStatePersistJournal(root, journal);
  applyStatePersistJournal(root, journal);

  const reloaded = readStatePlane(root);
  if (!reloaded) {
    throw new Error("State persistence validation failed: state file missing after write");
  }

  const postValidation = validateState(reloaded);
  if (!postValidation.valid) {
    throw new Error(`State persistence validation failed: ${postValidation.issues.map((issue) => issue.code).join(", ")}`);
  }

  return statePath;
}

export function hasApprovalForDiff(root: string, diffHash: string): boolean {
  const state = readStatePlane(root) ?? createEmptyStatePlane();
  return state.approvals.some((entry) => entry.diffHash === diffHash);
}

export function hasApprovalForPreview(root: string, previewHash: string): boolean {
  const state = readStatePlane(root) ?? createEmptyStatePlane();
  return state.approvals.some((entry) => (entry.previewHash ?? entry.diffHash) === previewHash);
}

export function revokeApprovalForPreview(
  root: string,
  previewHash: string
): { statePath: string; state: StatePlane; revoked: boolean } {
  const current = readStatePlane(root) ?? createEmptyStatePlane();
  const nextApprovals = current.approvals.filter((entry) => (entry.previewHash ?? entry.diffHash) !== previewHash);
  const revoked = nextApprovals.length !== current.approvals.length;
  if (!revoked) {
    return {
      statePath: getStatePath(root),
      state: current,
      revoked: false,
    };
  }

  const nextState = materializeStatePlane({
    ...current,
    approvals: nextApprovals,
  });

  const statePath = persistStatePlane(root, nextState, { action: "revoke-preview-approval" });
  return {
    statePath,
    state: nextState,
    revoked: true,
  };
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

  const statePath = persistStatePlane(root, nextState, { action: "upsert-pending-approval" });
  return { statePath, state: nextState };
}

export function upsertPendingPreviewApproval(
  root: string,
  previewHash: string,
  command: string
): { statePath: string; state: StatePlane; pendingId: string } {
  const normalizedHash = previewHash.replace(/[^a-zA-Z0-9]/g, "");
  const pendingId = `preview-${normalizedHash.slice(-12)}`;
  const result = upsertPendingApproval(root, {
    id: pendingId,
    diffHash: previewHash,
    previewHash,
    diffs: [],
    createdAt: new Date().toISOString(),
    command,
  });

  return {
    ...result,
    pendingId,
  };
}

export function approvePendingDiff(
  root: string,
  id: string,
  approvedBy: string,
  timestamp: string
): { statePath: string; state: StatePlane; approved?: ApprovalRecord } {
  const current = readStatePlane(root) ?? createEmptyStatePlane();
  const pending = current.pendingApprovals.find((entry) => {
    if (entry.id === id) {
      return true;
    }

    if (entry.diffHash === id) {
      return true;
    }

    return entry.previewHash === id;
  });
  if (!pending) {
    return {
      statePath: getStatePath(root),
      state: current,
    };
  }

  const approval: ApprovalRecord = {
    id,
    diffHash: pending.diffHash,
    ...(pending.previewHash ? { previewHash: pending.previewHash } : {}),
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

  const statePath = persistStatePlane(root, nextState, { action: "approve-pending-diff" });
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

  const statePath = persistStatePlane(root, nextState, { action: "reject-pending-diff" });
  return {
    statePath,
    state: nextState,
    removed,
  };
}
