import { createHash } from "crypto";
import { ControlPlane, Plan, Task } from "../schema.js";
import { computeLayers } from "./orchestration.js";
import { Patch } from "../fix/types.js";
import { ValidationResult } from "./scheduler.js";
import { StatePlane, StrategyHistory } from "./state.js";
import { Diagnostic } from "./types.js";
import { FileChange, simulatePlanOutcome } from "./executionPreview.js";

export type StrategyType = "minimal" | "grouped" | "layered" | "aggressive" | "adaptive";

export type StrategyMetrics = {
  filesChanged: number;
  patchesCount: number;
  remainingViolations: number;
  introducedErrors: number;
};

export type Strategy = {
  id: string;
  type: StrategyType;
  description: string;
  transform: (basePlan: Plan, state: StatePlane) => Plan;
};

export type StrategyOutcome = {
  strategyId: string;
  strategyType: StrategyType;
  plan: Plan;
  patches: Patch[];
  diagnostics: Diagnostic[];
  validation: ValidationResult;
  metrics: StrategyMetrics;
  success: boolean;
  fileChanges: FileChange[];
  previewHash: string;
};

export type FailurePattern = {
  type:
    | "validation-failure"
    | "high-remaining-violations"
    | "too-many-patches"
    | "too-many-files"
    | "conflict-heavy";
  strategyId: string;
  metrics: StrategyMetrics;
  details?: string;
};

export type StrategyMutation = {
  id: string;
  fromStrategy: StrategyType;
  condition: (pattern: FailurePattern) => boolean;
  mutate: (plan: Plan, state: StatePlane) => Plan;
};

export type AdaptiveTrace = {
  iterations: number;
  strategiesEvaluated: number;
  mutationsApplied: number;
  selectedStrategyId: string;
  decisions: string[];
};

export type StrategySelectionTrace = {
  evaluated: {
    strategyId: string;
    metrics: StrategyOutcome["metrics"];
    success: boolean;
  }[];
  selectedStrategyId: string;
  decision: string;
  adaptive?: AdaptiveTrace;
};

export type StrategyTrace = StrategySelectionTrace;

export const MAX_STRATEGIES = 4;
export const MAX_ADAPTIVE_ITERATIONS = 3;

const PATCH_THRESHOLD = 25;
const FILE_THRESHOLD = 8;
const CONFLICT_THRESHOLD = 0;
const MAX_NEW_STRATEGIES_PER_ITERATION = 6;
const MAX_STRATEGY_POOL = 16;

type EvaluateStrategyOptions = {
  controlPlane: ControlPlane;
  root: string;
};

type EvaluateStrategiesOptions = EvaluateStrategyOptions & {
  maxStrategies?: number;
  strategies?: Strategy[];
};

type RefineStrategiesOptions = {
  existingStrategies: Strategy[];
  historicalPatterns?: FailurePattern[];
  maxNewStrategies?: number;
};

export type AdaptiveStrategySelection = {
  selected: StrategyOutcome;
  outcomes: StrategyOutcome[];
  adaptiveTrace: AdaptiveTrace;
  history: StrategyHistory[];
};

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function clonePlan(plan: Plan): Plan {
  return JSON.parse(JSON.stringify(plan)) as Plan;
}

function cloneState(state: StatePlane): StatePlane {
  return JSON.parse(JSON.stringify(state)) as StatePlane;
}

function filesForTask(task: Task): string[] {
  return sortedUnique((task.scope?.files ?? []).map((file) => normalizePath(file)));
}

function normalizeTask(task: Task): Task {
  const dependsOn = sortedUnique(task.dependsOn ?? []);
  const files = filesForTask(task);

  return {
    ...task,
    dependsOn,
    successCriteria: sortedUnique(task.successCriteria ?? []),
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

function refactorIdSet(plan: Plan): Set<string> {
  return new Set(plan.tasks.filter((task) => task.type === "refactor").map((task) => task.id));
}

function remapTaskDependencies(task: Task, mapping: Map<string, string>): Task {
  const nextDepends = sortedUnique((task.dependsOn ?? [])
    .map((dependencyId) => mapping.get(dependencyId) ?? dependencyId)
    .filter((dependencyId) => dependencyId !== task.id));

  return normalizeTask({
    ...task,
    dependsOn: nextDepends,
  });
}

function composePlan(basePlan: Plan, refactors: Task[], remap: Map<string, string>): Plan {
  const prefix = basePlan.tasks
    .filter((task) => task.type !== "refactor" && task.type !== "enforce")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((task) => remapTaskDependencies(task, remap));

  const normalizedRefactors = [...refactors]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((task) => remapTaskDependencies(task, remap));

  const suffix = basePlan.tasks
    .filter((task) => task.type === "enforce")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((task) => remapTaskDependencies(task, remap));

  return {
    ...clonePlan(basePlan),
    tasks: [...prefix, ...normalizedRefactors, ...suffix],
  };
}

function overlaps(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }

  const rightSet = new Set(right);
  return left.some((file) => rightSet.has(file));
}

export function minimalStrategy(basePlan: Plan, _state: StatePlane): Plan {
  return clonePlan(basePlan);
}

export function groupedStrategy(basePlan: Plan, _state: StatePlane): Plan {
  const plan = clonePlan(basePlan);
  const refactors = plan.tasks
    .filter((task) => task.type === "refactor")
    .map((task) => normalizeTask(task))
    .sort((left, right) => left.id.localeCompare(right.id));

  if (refactors.length <= 1) {
    return plan;
  }

  const oldRefactors = refactorIdSet(plan);
  const groups: Array<{ tasks: Task[]; files: Set<string> }> = [];

  for (const task of refactors) {
    const taskFiles = filesForTask(task);
    let matched = false;

    for (const group of groups) {
      if (!overlaps(taskFiles, sortedUnique([...group.files]))) {
        continue;
      }

      group.tasks.push(task);
      taskFiles.forEach((file) => group.files.add(file));
      matched = true;
      break;
    }

    if (!matched) {
      groups.push({
        tasks: [task],
        files: new Set(taskFiles),
      });
    }
  }

  const remap = new Map<string, string>();
  const groupedTasks = groups.map((group, index) => {
    const id = `t-refactor-g${index + 1}`;
    group.tasks.forEach((task) => remap.set(task.id, id));

    const dependsOn = sortedUnique(group.tasks
      .flatMap((task) => task.dependsOn ?? [])
      .filter((dependencyId) => !oldRefactors.has(dependencyId)));
    const files = sortedUnique([...group.files]);
    const successCriteria = sortedUnique(group.tasks.flatMap((task) => task.successCriteria ?? []));

    return normalizeTask({
      id,
      title: `Grouped refactor ${index + 1}`,
      description: `Grouped strategy merged ${group.tasks.length} refactor task(s).`,
      type: "refactor",
      ...(files.length > 0 ? { scope: { files } } : {}),
      dependsOn,
      successCriteria: successCriteria.length > 0 ? successCriteria : ["grouped refactor complete"],
    });
  });

  return composePlan(plan, groupedTasks, remap);
}

function taskLayerIndex(task: Task, layerByFile: Map<string, number>): number {
  const layers = filesForTask(task).map((file) => layerByFile.get(file) ?? Number.MAX_SAFE_INTEGER);
  return layers.length > 0 ? Math.min(...layers) : Number.MAX_SAFE_INTEGER;
}

export function layeredStrategy(basePlan: Plan, state: StatePlane): Plan {
  const plan = clonePlan(basePlan);
  const refactors = plan.tasks
    .filter((task) => task.type === "refactor")
    .map((task) => normalizeTask(task))
    .sort((left, right) => left.id.localeCompare(right.id));

  if (refactors.length <= 1) {
    return plan;
  }

  const layers = computeLayers(sortedUnique(refactors.flatMap((task) => filesForTask(task))), state.dependencyGraph);
  const layerByFile = new Map<string, number>();

  layers.forEach((layer, index) => {
    layer.forEach((file) => {
      if (!layerByFile.has(file)) {
        layerByFile.set(file, index);
      }
    });
  });

  const oldRefactors = refactorIdSet(plan);
  const sortedByLayer = [...refactors].sort((left, right) =>
    taskLayerIndex(left, layerByFile) - taskLayerIndex(right, layerByFile)
    || left.id.localeCompare(right.id)
  );

  const remap = new Map<string, string>();
  const layeredTasks = sortedByLayer.map((task, index) => {
    const layerIndex = taskLayerIndex(task, layerByFile);
    const normalizedLayer = Number.isFinite(layerIndex) && layerIndex < Number.MAX_SAFE_INTEGER
      ? layerIndex + 1
      : 0;
    const id = `t-refactor-l${normalizedLayer}-${index + 1}`;
    remap.set(task.id, id);

    const dependsOn = sortedUnique((task.dependsOn ?? [])
      .filter((dependencyId) => !oldRefactors.has(dependencyId)));

    return normalizeTask({
      ...task,
      id,
      title: `Layered ${task.title}`,
      dependsOn,
    });
  });

  return composePlan(plan, layeredTasks, remap);
}

export function aggressiveStrategy(basePlan: Plan, _state: StatePlane): Plan {
  const plan = clonePlan(basePlan);
  const refactors = plan.tasks
    .filter((task) => task.type === "refactor")
    .map((task) => normalizeTask(task))
    .sort((left, right) => left.id.localeCompare(right.id));

  if (refactors.length <= 1) {
    return plan;
  }

  const oldRefactors = refactorIdSet(plan);
  const mergedId = "t-refactor-aggressive";
  const remap = new Map<string, string>(refactors.map((task) => [task.id, mergedId] as const));

  const mergedTask = normalizeTask({
    id: mergedId,
    title: "Aggressive merged refactor",
    description: `Aggressive strategy merged ${refactors.length} refactor task(s).`,
    type: "refactor",
    scope: {
      files: sortedUnique(refactors.flatMap((task) => filesForTask(task))),
    },
    dependsOn: sortedUnique(refactors
      .flatMap((task) => task.dependsOn ?? [])
      .filter((dependencyId) => !oldRefactors.has(dependencyId))),
    successCriteria: sortedUnique(refactors.flatMap((task) => task.successCriteria ?? [])),
  });

  if (mergedTask.successCriteria.length === 0) {
    mergedTask.successCriteria = ["aggressive refactor complete"];
  }

  return composePlan(plan, [mergedTask], remap);
}

const STRATEGY_REGISTRY: Strategy[] = [
  {
    id: "s-aggressive",
    type: "aggressive",
    description: "Merge most refactors into a single broad transformation.",
    transform: aggressiveStrategy,
  },
  {
    id: "s-grouped",
    type: "grouped",
    description: "Merge refactors by overlapping file sets.",
    transform: groupedStrategy,
  },
  {
    id: "s-layered",
    type: "layered",
    description: "Order refactors by dependency layers.",
    transform: layeredStrategy,
  },
  {
    id: "s-minimal",
    type: "minimal",
    description: "Preserve base structure with minimal transformation.",
    transform: minimalStrategy,
  },
];

export const STRATEGIES: Strategy[] = [...STRATEGY_REGISTRY].sort((left, right) => left.id.localeCompare(right.id));

function failurePatternTypeRank(type: FailurePattern["type"]): number {
  if (type === "validation-failure") return 0;
  if (type === "high-remaining-violations") return 1;
  if (type === "conflict-heavy") return 2;
  if (type === "too-many-patches") return 3;
  return 4;
}

function patternSort(left: FailurePattern, right: FailurePattern): number {
  return failurePatternTypeRank(left.type) - failurePatternTypeRank(right.type)
    || left.strategyId.localeCompare(right.strategyId)
    || left.metrics.remainingViolations - right.metrics.remainingViolations
    || left.metrics.introducedErrors - right.metrics.introducedErrors
    || left.metrics.patchesCount - right.metrics.patchesCount
    || left.metrics.filesChanged - right.metrics.filesChanged
    || (left.details ?? "").localeCompare(right.details ?? "");
}

function patternKey(pattern: FailurePattern): string {
  return JSON.stringify({
    type: pattern.type,
    strategyId: pattern.strategyId,
    metrics: pattern.metrics,
    details: pattern.details ?? "",
  });
}

function dedupePatterns(patterns: FailurePattern[]): FailurePattern[] {
  const byKey = new Map<string, FailurePattern>();

  for (const pattern of patterns) {
    const key = patternKey(pattern);
    if (!byKey.has(key)) {
      byKey.set(key, pattern);
    }
  }

  return [...byKey.values()].sort(patternSort);
}

function planSignature(plan: Plan): unknown {
  const tasks = [...plan.tasks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((task) => ({
      id: task.id,
      type: task.type,
      dependsOn: sortedUnique(task.dependsOn ?? []),
      files: filesForTask(task),
      successCriteria: sortedUnique(task.successCriteria ?? []),
    }));

  return {
    id: plan.id,
    derivedFrom: plan.derivedFrom,
    status: plan.status,
    tasks,
  };
}

function generateStrategyId(
  outcome: StrategyOutcome,
  mutation: StrategyMutation,
  pattern: FailurePattern,
  plan: Plan
): string {
  const payload = JSON.stringify({
    fromStrategyId: outcome.strategyId,
    fromStrategyType: outcome.strategyType,
    mutationId: mutation.id,
    patternType: pattern.type,
    plan: planSignature(plan),
  });

  const digest = createHash("sha256").update(payload).digest("hex").slice(0, 12);
  return `s-adaptive-${digest}`;
}

function splitRefactorTasks(plan: Plan, idPrefix: string): Plan {
  const cloned = clonePlan(plan);
  const refactors = cloned.tasks
    .filter((task) => task.type === "refactor")
    .map((task) => normalizeTask(task))
    .sort((left, right) => left.id.localeCompare(right.id));

  if (refactors.length === 0) {
    return cloned;
  }

  const oldRefactorIds = new Set(refactors.map((task) => task.id));
  const remap = new Map<string, string>();
  const expanded: Task[] = [];
  let counter = 1;
  let splitApplied = false;

  for (const task of refactors) {
    const files = filesForTask(task);
    if (files.length <= 1) {
      expanded.push(task);
      remap.set(task.id, task.id);
      continue;
    }

    splitApplied = true;
    const externalDepends = sortedUnique((task.dependsOn ?? [])
      .filter((dependencyId) => !oldRefactorIds.has(dependencyId)));
    let previousId: string | undefined;
    let lastId = task.id;

    for (const file of files) {
      const splitId = `${idPrefix}-${counter}`;
      counter += 1;
      const dependsOn = previousId ? [previousId] : externalDepends;

      expanded.push(normalizeTask({
        ...task,
        id: splitId,
        title: `${task.title} [${file}]`,
        description: `Adaptive split of ${task.id} for ${file}`,
        scope: {
          ...(task.scope ?? {}),
          files: [file],
        },
        dependsOn,
        successCriteria: task.successCriteria.length > 0
          ? task.successCriteria
          : [`Adaptive split complete for ${file}`],
      }));

      previousId = splitId;
      lastId = splitId;
    }

    remap.set(task.id, lastId);
  }

  if (!splitApplied) {
    return cloned;
  }

  return composePlan(cloned, expanded, remap);
}

function splitLargeTasks(plan: Plan, _state: StatePlane): Plan {
  return splitRefactorTasks(plan, "t-refactor-adp-aggressive");
}

function breakIntoSmallerTasks(plan: Plan, _state: StatePlane): Plan {
  return splitRefactorTasks(plan, "t-refactor-adp-grouped");
}

function reorderByDependency(plan: Plan, state: StatePlane): Plan {
  return layeredStrategy(plan, state);
}

const splitLargeTasksMutation: StrategyMutation = {
  id: "split-large-tasks",
  fromStrategy: "aggressive",
  condition: (pattern) => pattern.type === "too-many-patches" || pattern.type === "too-many-files",
  mutate: splitLargeTasks,
};

const increaseGranularityMutation: StrategyMutation = {
  id: "increase-granularity",
  fromStrategy: "grouped",
  condition: (pattern) => pattern.type === "validation-failure" || pattern.type === "conflict-heavy",
  mutate: breakIntoSmallerTasks,
};

const enforceLayeringMutation: StrategyMutation = {
  id: "enforce-layering",
  fromStrategy: "minimal",
  condition: (pattern) => pattern.type === "conflict-heavy" || pattern.type === "validation-failure",
  mutate: reorderByDependency,
};

export const MUTATIONS: StrategyMutation[] = [
  enforceLayeringMutation,
  increaseGranularityMutation,
  splitLargeTasksMutation,
].sort((left, right) => left.id.localeCompare(right.id));

function failedOutcome(strategyId: string, strategyType: StrategyType, plan: Plan, message: string): StrategyOutcome {
  return {
    strategyId,
    strategyType,
    plan,
    patches: [],
    diagnostics: [],
    validation: {
      passed: false,
      diagnostics: [],
      conflicts: [],
      invariantChecks: [],
      errors: [message],
    },
    metrics: {
      filesChanged: 0,
      patchesCount: 0,
      remainingViolations: Number.MAX_SAFE_INTEGER,
      introducedErrors: Number.MAX_SAFE_INTEGER,
    },
    success: false,
    fileChanges: [],
    previewHash: "",
  };
}

function dedupeStrategies(strategies: Strategy[]): Strategy[] {
  const byId = new Map<string, Strategy>();

  for (const strategy of [...strategies].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!byId.has(strategy.id)) {
      byId.set(strategy.id, strategy);
    }
  }

  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function mergeStrategies(base: Strategy[], refined: Strategy[]): Strategy[] {
  const merged = dedupeStrategies([...base, ...refined]);
  return merged.slice(0, MAX_STRATEGY_POOL);
}

function historyPatternToFailurePattern(entry: StrategyHistory): FailurePattern[] {
  return entry.patterns.map((pattern) => ({
    type: pattern.type,
    strategyId: pattern.strategyId,
    metrics: {
      filesChanged: pattern.metrics.filesChanged,
      patchesCount: pattern.metrics.patchesCount,
      remainingViolations: pattern.metrics.remainingViolations,
      introducedErrors: pattern.metrics.introducedErrors,
    },
    details: pattern.details,
  }));
}

function collectHistoricalPatterns(state: StatePlane, outcomes: StrategyOutcome[]): FailurePattern[] {
  if (state.strategyHistory.length === 0) {
    return [];
  }

  const strategyIds = new Set(outcomes.map((outcome) => outcome.strategyId));
  const relevant = state.strategyHistory
    .filter((entry) => strategyIds.has(entry.strategyId))
    .flatMap((entry) => historyPatternToFailurePattern(entry));

  return dedupePatterns(relevant);
}

export function analyzeOutcome(outcome: StrategyOutcome): FailurePattern[] {
  const patterns: FailurePattern[] = [];

  if (!outcome.success) {
    patterns.push({
      type: "validation-failure",
      strategyId: outcome.strategyId,
      metrics: outcome.metrics,
      details: (outcome.validation.errors ?? [])[0],
    });
  }

  if (outcome.metrics.remainingViolations > 0) {
    patterns.push({
      type: "high-remaining-violations",
      strategyId: outcome.strategyId,
      metrics: outcome.metrics,
    });
  }

  if (outcome.metrics.patchesCount > PATCH_THRESHOLD) {
    patterns.push({
      type: "too-many-patches",
      strategyId: outcome.strategyId,
      metrics: outcome.metrics,
      details: `patches>${PATCH_THRESHOLD}`,
    });
  }

  if (outcome.metrics.filesChanged > FILE_THRESHOLD) {
    patterns.push({
      type: "too-many-files",
      strategyId: outcome.strategyId,
      metrics: outcome.metrics,
      details: `files>${FILE_THRESHOLD}`,
    });
  }

  if (outcome.validation.conflicts.length > CONFLICT_THRESHOLD) {
    patterns.push({
      type: "conflict-heavy",
      strategyId: outcome.strategyId,
      metrics: outcome.metrics,
      details: `${outcome.validation.conflicts.length} conflict(s)`,
    });
  }

  return dedupePatterns(patterns);
}

export function isGoodEnough(outcome: StrategyOutcome): boolean {
  return outcome.success && outcome.metrics.remainingViolations === 0;
}

export function refineStrategies(
  outcomes: StrategyOutcome[],
  state: StatePlane,
  options: RefineStrategiesOptions
): {
  strategies: Strategy[];
  mutationsApplied: number;
  decisions: string[];
} {
  const existingIds = new Set(options.existingStrategies.map((strategy) => strategy.id));
  const historicalByStrategy = new Map<string, FailurePattern[]>();

  for (const pattern of options.historicalPatterns ?? []) {
    const entry = historicalByStrategy.get(pattern.strategyId) ?? [];
    entry.push(pattern);
    historicalByStrategy.set(pattern.strategyId, entry);
  }

  const created: Strategy[] = [];
  const decisions: string[] = [];
  const maxNew = options.maxNewStrategies ?? MAX_NEW_STRATEGIES_PER_ITERATION;

  for (const outcome of [...outcomes].sort((left, right) => left.strategyId.localeCompare(right.strategyId))) {
    const patterns = dedupePatterns([
      ...analyzeOutcome(outcome),
      ...(historicalByStrategy.get(outcome.strategyId) ?? []),
    ]);

    for (const pattern of patterns) {
      for (const mutation of MUTATIONS) {
        if (created.length >= maxNew) {
          break;
        }

        if (mutation.fromStrategy !== outcome.strategyType || !mutation.condition(pattern)) {
          continue;
        }

        const mutatedPlan = mutation.mutate(outcome.plan, state);
        const strategyId = generateStrategyId(outcome, mutation, pattern, mutatedPlan);
        if (existingIds.has(strategyId)) {
          continue;
        }

        existingIds.add(strategyId);
        created.push({
          id: strategyId,
          type: "adaptive",
          description: `Adaptive strategy from ${outcome.strategyId} via ${mutation.id}`,
          transform: () => clonePlan(mutatedPlan),
        });
        decisions.push(`Applied ${mutation.id} to ${outcome.strategyId} due to ${pattern.type} -> ${strategyId}`);
      }

      if (created.length >= maxNew) {
        break;
      }
    }

    if (created.length >= maxNew) {
      break;
    }
  }

  return {
    strategies: dedupeStrategies(created),
    mutationsApplied: created.length,
    decisions,
  };
}

export function buildStrategyHistory(planId: string, outcomes: StrategyOutcome[]): StrategyHistory[] {
  return [...outcomes]
    .sort((left, right) => left.strategyId.localeCompare(right.strategyId))
    .map((outcome) => ({
      planId,
      strategyId: outcome.strategyId,
      strategyType: outcome.strategyType,
      patterns: analyzeOutcome(outcome),
      outcomeMetrics: outcome.metrics,
    }));
}

async function evaluateTransformedPlan(
  strategyId: string,
  strategyType: StrategyType,
  plan: Plan,
  state: StatePlane,
  options: EvaluateStrategyOptions
): Promise<StrategyOutcome> {

  try {
    const outcome = await simulatePlanOutcome(plan, {
      root: options.root,
      controlPlane: options.controlPlane,
      state: cloneState(state),
    });

    return {
      strategyId,
      strategyType,
      plan,
      patches: outcome.patches,
      diagnostics: outcome.diagnostics,
      validation: outcome.validation,
      metrics: outcome.metrics,
      success: outcome.success,
      fileChanges: outcome.fileChanges,
      previewHash: outcome.previewHash,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failedOutcome(strategyId, strategyType, plan, message);
  }
}

export async function evaluateStrategy(
  strategy: Strategy,
  basePlan: Plan,
  state: StatePlane,
  options: EvaluateStrategyOptions
): Promise<StrategyOutcome> {
  return evaluateTransformedPlan(strategy.id, strategy.type, strategy.transform(basePlan, state), state, options);
}

export async function evaluateStrategies(
  basePlan: Plan,
  state: StatePlane,
  options: EvaluateStrategiesOptions
): Promise<StrategyOutcome[]> {
  const maxStrategies = options.maxStrategies ?? MAX_STRATEGIES;
  const strategies = [...(options.strategies ?? STRATEGIES)]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, maxStrategies);

  const results: StrategyOutcome[] = [];

  for (const strategy of strategies) {
    const transformedPlan = strategy.transform(basePlan, state);
    results.push(await evaluateTransformedPlan(strategy.id, strategy.type, transformedPlan, state, options));
  }

  return [...results].sort((left, right) => left.strategyId.localeCompare(right.strategyId));
}

export async function adaptiveStrategySelection(
  basePlan: Plan,
  state: StatePlane,
  options: EvaluateStrategiesOptions & { maxIterations?: number }
): Promise<AdaptiveStrategySelection> {
  const maxIterations = options.maxIterations ?? MAX_ADAPTIVE_ITERATIONS;
  let strategies = dedupeStrategies([...(options.strategies ?? STRATEGIES)]);

  let iterations = 0;
  let strategiesEvaluated = 0;
  let mutationsApplied = 0;
  const decisions: string[] = [];
  let latestOutcomes: StrategyOutcome[] = [];

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    iterations = iteration + 1;
    const outcomes = await evaluateStrategies(basePlan, state, {
      ...options,
      strategies,
      maxStrategies: strategies.length,
    });

    latestOutcomes = outcomes;
    strategiesEvaluated += outcomes.length;

    const best = selectBestOutcome(outcomes);
    decisions.push(`Iteration ${iterations}: best=${best.strategyId} remaining=${best.metrics.remainingViolations} introduced=${best.metrics.introducedErrors}`);

    if (isGoodEnough(best)) {
      decisions.push(`Stop: ${best.strategyId} satisfied isGoodEnough`);
      const adaptiveTrace: AdaptiveTrace = {
        iterations,
        strategiesEvaluated,
        mutationsApplied,
        selectedStrategyId: best.strategyId,
        decisions,
      };

      return {
        selected: best,
        outcomes,
        adaptiveTrace,
        history: buildStrategyHistory(basePlan.id, outcomes),
      };
    }

    const historicalPatterns = collectHistoricalPatterns(state, outcomes);
    const refined = refineStrategies(outcomes, state, {
      existingStrategies: strategies,
      historicalPatterns,
      maxNewStrategies: MAX_NEW_STRATEGIES_PER_ITERATION,
    });

    mutationsApplied += refined.mutationsApplied;
    decisions.push(...refined.decisions);

    if (refined.strategies.length === 0) {
      decisions.push(`Stop: no new deterministic mutations generated at iteration ${iterations}`);
      break;
    }

    const merged = mergeStrategies(strategies, refined.strategies);
    if (merged.length === strategies.length) {
      decisions.push(`Stop: strategy pool unchanged at iteration ${iterations}`);
      break;
    }

    decisions.push(`Iteration ${iterations}: merged ${refined.strategies.length} adaptive strategies (pool=${merged.length})`);
    strategies = merged;
  }

  const finalBest = selectBestOutcome(latestOutcomes);
  const adaptiveTrace: AdaptiveTrace = {
    iterations,
    strategiesEvaluated,
    mutationsApplied,
    selectedStrategyId: finalBest.strategyId,
    decisions,
  };

  return {
    selected: finalBest,
    outcomes: latestOutcomes,
    adaptiveTrace,
    history: buildStrategyHistory(basePlan.id, latestOutcomes),
  };
}

export function selectBestOutcome(results: StrategyOutcome[]): StrategyOutcome {
  if (results.length === 0) {
    throw new Error("Cannot select best strategy from an empty result list");
  }

  const valid = results.filter((result) => result.success);
  const candidates = valid.length > 0 ? valid : results;

  return [...candidates]
    .sort((left, right) =>
      left.metrics.remainingViolations - right.metrics.remainingViolations
      || left.metrics.introducedErrors - right.metrics.introducedErrors
      || left.metrics.patchesCount - right.metrics.patchesCount
      || left.metrics.filesChanged - right.metrics.filesChanged
      || left.strategyId.localeCompare(right.strategyId)
    )[0] as StrategyOutcome;
}

export function selectBestStrategy(results: StrategyOutcome[]): StrategyOutcome {
  return selectBestOutcome(results);
}

export function buildStrategyTrace(
  results: StrategyOutcome[],
  selected: StrategyOutcome,
  adaptive?: AdaptiveTrace
): StrategyTrace {
  const evaluated = [...results]
    .sort((left, right) => left.strategyId.localeCompare(right.strategyId))
    .map((result) => ({
      strategyId: result.strategyId,
      metrics: result.metrics,
      success: result.success,
    }));

  const decision = selected.success
    ? `${selected.strategyId} selected by outcome priority (remaining=${selected.metrics.remainingViolations}, introducedErrors=${selected.metrics.introducedErrors}, patches=${selected.metrics.patchesCount}, files=${selected.metrics.filesChanged})`
    : `${selected.strategyId} selected as deterministic fallback after all strategies failed validation`;

  return {
    evaluated,
    selectedStrategyId: selected.strategyId,
    decision,
    ...(adaptive ? { adaptive } : {}),
  };
}
