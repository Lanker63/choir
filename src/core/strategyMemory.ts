import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { ControlPlane, Plan, Task } from "../schema.js";
import { StatePlane } from "./state.js";
import { deterministicTimestampFromString } from "./deterministicCore.js";
import type { StrategyMetrics, StrategyMutation, StrategyOutcome, StrategyType } from "./strategyPlanner.js";
import { cloneJson } from "../utils/clone.js";

export type ContextSignature = {
  goals: string[];
  constraints: string[];
  violationSummary: {
    ruleId: string;
    count: number;
  }[];
  modules?: string[];
};

export type StrategyMemoryEntry = {
  id: string;
  signature: ContextSignature;
  strategyId: string;
  strategyType?: StrategyType;
  plan: Plan;
  outcome: {
    metrics: StrategyMetrics;
    success: boolean;
    deterministic?: boolean;
  };
  adaptive?: {
    iteration?: number;
    parentId?: string;
    mutation?: StrategyMutation;
    selected?: boolean;
    finalSelected?: boolean;
  };
  createdAt: string;
};

export type StrategyMemoryTrace = {
  signature: ContextSignature;
  matchedEntries: number;
  reused: boolean;
  selectedStrategyId?: string;
  fallbackToEvaluation: boolean;
};

type StrategyMemoryFile = {
  entries: StrategyMemoryEntry[];
};

const MAX_MEMORY_ENTRIES = 512;

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function normalizeTask(task: Task): Task {
  const dependsOn = sortedUnique(task.dependsOn ?? []);
  const successCriteria = sortedUnique(task.successCriteria ?? []);
  const files = sortedUnique((task.scope?.files ?? []).map((file) => normalizePath(file)));

  return {
    ...task,
    dependsOn,
    successCriteria,
    ...(task.scope
      ? {
        scope: {
          ...task.scope,
          ...(files.length > 0 ? { files } : {}),
        },
      }
      : {}),
  };
}

function normalizeMutationForMemory(mutation: StrategyMutation): StrategyMutation {
  if (mutation.type === "reorder") {
    return {
      type: "reorder",
      units: sortedUnique(mutation.units ?? []),
    };
  }

  if (mutation.type === "split-stage") {
    return {
      type: "split-stage",
      stageId: mutation.stageId,
    };
  }

  if (mutation.type === "reduce-scope") {
    return {
      type: "reduce-scope",
      units: sortedUnique(mutation.units ?? []),
    };
  }

  if (mutation.type === "add-validation") {
    return {
      type: "add-validation",
      stageId: mutation.stageId,
    };
  }

  return {
    type: "adjust-batching",
    size: Math.max(1, Math.floor(mutation.size)),
  };
}

function normalizeAdaptiveFeedback(feedback: StrategyMemoryEntry["adaptive"] | undefined): StrategyMemoryEntry["adaptive"] | undefined {
  if (!feedback) {
    return undefined;
  }

  return {
    ...(typeof feedback.iteration === "number" && Number.isFinite(feedback.iteration)
      ? { iteration: Math.max(1, Math.floor(feedback.iteration)) }
      : {}),
    ...(typeof feedback.parentId === "string" && feedback.parentId.length > 0
      ? { parentId: feedback.parentId }
      : {}),
    ...(feedback.mutation ? { mutation: normalizeMutationForMemory(feedback.mutation) } : {}),
    ...(feedback.selected === true ? { selected: true } : {}),
    ...(feedback.finalSelected === true ? { finalSelected: true } : {}),
  };
}

export function normalizePlan(plan: Plan): Plan {
  return {
    ...cloneJson(plan),
    tasks: plan.tasks.map((task) => normalizeTask(task)),
  };
}

function normalizeSignature(signature: ContextSignature): ContextSignature {
  return {
    goals: sortedUnique(signature.goals ?? []),
    constraints: sortedUnique(signature.constraints ?? []),
    violationSummary: [...(signature.violationSummary ?? [])]
      .map((entry) => ({ ruleId: entry.ruleId, count: entry.count }))
      .sort((left, right) => left.ruleId.localeCompare(right.ruleId) || left.count - right.count),
    ...(signature.modules
      ? {
        modules: sortedUnique(signature.modules),
      }
      : {}),
  };
}

function summarizeViolations(state: StatePlane): ContextSignature["violationSummary"] {
  const counts = new Map<string, number>();

  for (const violation of state.violations) {
    const current = counts.get(violation.ruleId) ?? 0;
    counts.set(violation.ruleId, current + 1);
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ruleId, count]) => ({ ruleId, count }));
}

function extractModules(state: StatePlane): string[] {
  const modules = new Set<string>();

  const addFromPath = (input: string) => {
    const normalized = normalizePath(input);
    const segment = normalized.split("/").filter((part) => part.length > 0)[0];
    if (!segment || segment.includes(".")) {
      return;
    }
    modules.add(segment);
  };

  for (const file of Object.keys(state.dependencyGraph)) {
    addFromPath(file);
    const deps = state.dependencyGraph[file] ?? [];
    for (const dep of deps) {
      addFromPath(dep);
    }
  }

  return sortedUnique([...modules]);
}

export function buildSignature(control: ControlPlane, state: StatePlane): ContextSignature {
  const modules = extractModules(state);

  return {
    goals: sortedUnique(control.intent.goals ?? []),
    constraints: sortedUnique(control.intent.constraints ?? []),
    violationSummary: summarizeViolations(state),
    ...(modules.length > 0 ? { modules } : {}),
  };
}

export function matchSignature(left: ContextSignature, right: ContextSignature): boolean {
  return JSON.stringify(normalizeSignature(left)) === JSON.stringify(normalizeSignature(right));
}

function partialMatch(left: ContextSignature, right: ContextSignature): boolean {
  const normalizedLeft = normalizeSignature(left);
  const normalizedRight = normalizeSignature(right);

  if (normalizedLeft.goals.join("|") !== normalizedRight.goals.join("|")) {
    return false;
  }

  const leftRules = new Set(normalizedLeft.violationSummary.map((entry) => entry.ruleId));
  const rightRules = normalizedRight.violationSummary.map((entry) => entry.ruleId);
  return rightRules.some((ruleId) => leftRules.has(ruleId));
}

export function findMatchingStrategies(
  signature: ContextSignature,
  memory: StrategyMemoryEntry[]
): StrategyMemoryEntry[] {
  return [...memory]
    .filter((entry) => matchSignature(entry.signature, signature))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function canReuse(entry: StrategyMemoryEntry): boolean {
  return entry.outcome.success
    && entry.outcome.metrics.remainingViolations === 0
    && entry.outcome.deterministic !== false;
}

export function selectFromMemory(entries: StrategyMemoryEntry[]): StrategyMemoryEntry | null {
  if (entries.length === 0) {
    return null;
  }

  return [...entries]
    .sort((left, right) =>
      left.outcome.metrics.patchesCount - right.outcome.metrics.patchesCount
      || left.id.localeCompare(right.id)
    )[0] ?? null;
}

function memoryPath(root: string): string {
  return path.join(root, ".choir", "memory.json");
}

function normalizeMemoryEntry(entry: StrategyMemoryEntry): StrategyMemoryEntry {
  return {
    ...entry,
    signature: normalizeSignature(entry.signature),
    plan: normalizePlan(entry.plan),
    ...(normalizeAdaptiveFeedback(entry.adaptive) ? { adaptive: normalizeAdaptiveFeedback(entry.adaptive) } : {}),
  };
}

function parseMemory(raw: unknown): StrategyMemoryEntry[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }

  const asRecord = raw as Record<string, unknown>;
  const entries = Array.isArray(asRecord.entries) ? asRecord.entries : [];

  return entries.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return [];
    }

    const entry = candidate as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : "";
    const strategyId = typeof entry.strategyId === "string" ? entry.strategyId : "";
    const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : "";

    const signature = entry.signature;
    const plan = entry.plan;
    const outcome = entry.outcome;

    if (!id || !strategyId || !createdAt || !signature || !plan || !outcome) {
      return [];
    }

    const parsed = {
      id,
      strategyId,
      strategyType: typeof entry.strategyType === "string" ? entry.strategyType as StrategyType : undefined,
      createdAt,
      signature: signature as ContextSignature,
      plan: plan as Plan,
      outcome: outcome as StrategyMemoryEntry["outcome"],
      adaptive: (entry.adaptive && typeof entry.adaptive === "object")
        ? entry.adaptive as StrategyMemoryEntry["adaptive"]
        : undefined,
    } satisfies StrategyMemoryEntry;

    return [normalizeMemoryEntry(parsed)];
  });
}

export function readStrategyMemory(root: string): StrategyMemoryEntry[] {
  const filePath = memoryPath(root);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return dedupeMemory(parseMemory(parsed));
  } catch {
    return [];
  }
}

export function signatureHash(signature: ContextSignature): string {
  const normalized = normalizeSignature(signature);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function memoryEntryHash(entry: StrategyMemoryEntry): string {
  return createHash("sha256")
    .update(JSON.stringify({
      signature: normalizeSignature(entry.signature),
      strategyId: entry.strategyId,
      strategyType: entry.strategyType,
      plan: normalizePlan(entry.plan),
      outcome: entry.outcome,
      adaptive: normalizeAdaptiveFeedback(entry.adaptive),
    }))
    .digest("hex");
}

export function dedupeMemory(memory: StrategyMemoryEntry[]): StrategyMemoryEntry[] {
  const byKey = new Map<string, StrategyMemoryEntry>();

  for (const entry of [...memory].map(normalizeMemoryEntry).sort((left, right) => left.id.localeCompare(right.id))) {
    const key = `${signatureHash(entry.signature)}:${entry.strategyId}:${memoryEntryHash(entry)}`;
    if (!byKey.has(key)) {
      byKey.set(key, entry);
    }
  }

  return [...byKey.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, MAX_MEMORY_ENTRIES);
}

export function persistStrategyMemory(root: string, entries: StrategyMemoryEntry[]): string {
  const filePath = memoryPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const normalizedEntries = dedupeMemory(entries);
  const payload: StrategyMemoryFile = {
    entries: normalizedEntries,
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
  return filePath;
}

function inferredStrategyType(strategyId: string): StrategyType | undefined {
  if (strategyId.startsWith("s-aggressive")) return "aggressive";
  if (strategyId.startsWith("s-grouped")) return "grouped";
  if (strategyId.startsWith("s-layered")) return "layered";
  if (strategyId.startsWith("s-minimal")) return "minimal";
  if (strategyId.startsWith("s-adaptive")) return "adaptive";
  return undefined;
}

export function generateMemoryEntryId(
  signature: ContextSignature,
  strategyId: string,
  plan: Plan,
  outcome: StrategyMemoryEntry["outcome"],
  adaptive?: StrategyMemoryEntry["adaptive"]
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      signature: normalizeSignature(signature),
      strategyId,
      plan: normalizePlan(plan),
      outcome,
      adaptive: normalizeAdaptiveFeedback(adaptive),
    }))
    .digest("hex")
    .slice(0, 20);

  return `sm-${digest}`;
}

export function recordStrategy(
  root: string,
  signature: ContextSignature,
  outcome: StrategyOutcome,
  options?: {
    deterministic?: boolean;
    adaptive?: StrategyMemoryEntry["adaptive"];
  }
): StrategyMemoryEntry {
  const existing = readStrategyMemory(root);
  const adaptive = normalizeAdaptiveFeedback(options?.adaptive);
  const entryOutcome: StrategyMemoryEntry["outcome"] = {
    metrics: outcome.metrics,
    success: outcome.success,
    deterministic: options?.deterministic ?? true,
  };
  const id = generateMemoryEntryId(signature, outcome.strategyId, outcome.plan, entryOutcome, adaptive);
  const existingEntry = existing.find((entry) => entry.id === id);

  const entry: StrategyMemoryEntry = normalizeMemoryEntry({
    id,
    signature,
    strategyId: outcome.strategyId,
    strategyType: outcome.strategyType ?? inferredStrategyType(outcome.strategyId),
    plan: outcome.plan,
    outcome: entryOutcome,
    ...(adaptive ? { adaptive } : {}),
    createdAt: existingEntry?.createdAt ?? deterministicTimestampFromString(id),
  });

  persistStrategyMemory(root, [...existing, entry]);
  return entry;
}

export function recordStrategies(
  root: string,
  signature: ContextSignature,
  outcomes: Array<{
    outcome: StrategyOutcome;
    deterministic?: boolean;
    adaptive?: StrategyMemoryEntry["adaptive"];
  }>
): StrategyMemoryEntry[] {
  const existing = readStrategyMemory(root);
  const created: StrategyMemoryEntry[] = [];
  const pending = [...existing];

  for (const item of outcomes
    .sort((left, right) => left.outcome.strategyId.localeCompare(right.outcome.strategyId))) {
    const adaptive = normalizeAdaptiveFeedback(item.adaptive);
    const entryOutcome: StrategyMemoryEntry["outcome"] = {
      metrics: item.outcome.metrics,
      success: item.outcome.success,
      deterministic: item.deterministic ?? true,
    };

    const id = generateMemoryEntryId(signature, item.outcome.strategyId, item.outcome.plan, entryOutcome, adaptive);
    const existingEntry = pending.find((entry) => entry.id === id);

    const entry = normalizeMemoryEntry({
      id,
      signature,
      strategyId: item.outcome.strategyId,
      strategyType: item.outcome.strategyType ?? inferredStrategyType(item.outcome.strategyId),
      plan: item.outcome.plan,
      outcome: entryOutcome,
      ...(adaptive ? { adaptive } : {}),
      createdAt: existingEntry?.createdAt ?? deterministicTimestampFromString(id),
    });

    pending.push(entry);
    created.push(entry);
  }

  persistStrategyMemory(root, pending);
  return created;
}

export function validatePlanStillApplies(
  plan: Plan,
  state: StatePlane,
  options: { root: string; expectedPlanId?: string }
): boolean {
  if (options.expectedPlanId && plan.id !== options.expectedPlanId) {
    return false;
  }

  const taskIds = new Set(plan.tasks.map((task) => task.id));
  if (taskIds.size !== plan.tasks.length) {
    return false;
  }

  for (const task of plan.tasks) {
    for (const dependencyId of task.dependsOn ?? []) {
      if (!taskIds.has(dependencyId)) {
        return false;
      }
    }

    const files = task.scope?.files ?? [];
    for (const file of files) {
      const absolute = path.join(options.root, normalizePath(file));
      if (!fs.existsSync(absolute)) {
        return false;
      }
    }
  }

  const summary = summarizeViolations(state);
  if (summary.length === 0) {
    return true;
  }

  const refactorFiles = sortedUnique(plan.tasks
    .filter((task) => task.type === "refactor")
    .flatMap((task) => (task.scope?.files ?? []).map((file) => normalizePath(file))));

  if (refactorFiles.length === 0) {
    return true;
  }

  const violationFiles = new Set(state.violations.map((violation) => normalizePath(violation.location.file)));
  return refactorFiles.some((file) => violationFiles.has(file));
}

export function buildMemoryTrace(
  signature: ContextSignature,
  matchedEntries: number,
  options: {
    reused: boolean;
    selectedStrategyId?: string;
    fallbackToEvaluation: boolean;
  }
): StrategyMemoryTrace {
  return {
    signature: normalizeSignature(signature),
    matchedEntries,
    reused: options.reused,
    ...(options.selectedStrategyId ? { selectedStrategyId: options.selectedStrategyId } : {}),
    fallbackToEvaluation: options.fallbackToEvaluation,
  };
}
