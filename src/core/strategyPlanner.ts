import { createHash } from "crypto";
import { ControlPlane, Plan, Task } from "../schema.js";
import { computeLayers } from "./orchestration.js";
import { Patch } from "../fix/types.js";
import { ValidationResult } from "./scheduler.js";
import { FailurePatternRecord, StatePlane, StrategyHistory } from "./state.js";
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
  failures?: {
    type: string;
    unitId?: string;
  }[];
};

export type FailurePattern = {
  type:
    | "validation-failure"
    | "high-remaining-violations"
    | "too-many-patches"
    | "too-many-files"
    | "conflict-heavy"
    | "dependency-ordering"
    | "policy-violation"
    | "high-risk";
  strategyId: string;
  metrics: StrategyMetrics;
  details?: string;
  units?: string[];
  rule?: string;
  thresholdExceeded?: number;
};

export type StrategyMutation = {
  type: "reorder";
  units: string[];
} | {
  type: "split-stage";
  stageId: string;
} | {
  type: "reduce-scope";
  units: string[];
} | {
  type: "add-validation";
  stageId: string;
} | {
  type: "adjust-batching";
  size: number;
};

export type StrategyEvolution = {
  parentId: string;
  childId: string;
  mutation: StrategyMutation;
};

export type AdaptiveTrace = {
  iterations: number;
  strategiesEvaluated: number;
  mutationsApplied: number;
  strategiesTested: string[];
  mutationsAppliedDetails: StrategyMutation[];
  evolution: StrategyEvolution[];
  finalStrategy: string;
  selectedStrategyId: string;
  decisions: string[];
};

export type AdaptiveIterationResult = {
  iteration: number;
  selectedStrategyId: string;
  outcomes: StrategyOutcome[];
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

const HISTORY_PATTERN_TYPES = new Set<FailurePatternRecord["type"]>([
  "validation-failure",
  "high-remaining-violations",
  "too-many-patches",
  "too-many-files",
  "conflict-heavy",
]);

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

type MutationRule = {
  id: string;
  fromStrategy: StrategyType;
  condition: (pattern: FailurePattern) => boolean;
  buildMutation: (pattern: FailurePattern) => StrategyMutation;
};

export type AdaptiveStrategySelection = {
  selected: StrategyOutcome;
  outcomes: StrategyOutcome[];
  adaptiveTrace: AdaptiveTrace;
  history: StrategyHistory[];
  iterations: AdaptiveIterationResult[];
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
  if (type === "dependency-ordering") return 0;
  if (type === "policy-violation") return 1;
  if (type === "high-risk") return 2;
  if (type === "validation-failure") return 0;
  if (type === "high-remaining-violations") return 3;
  if (type === "conflict-heavy") return 4;
  if (type === "too-many-patches") return 5;
  return 6;
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
    units: sortedUnique(pattern.units ?? []),
    rule: pattern.rule ?? "",
    thresholdExceeded: pattern.thresholdExceeded ?? 0,
  });
}

function mutationRank(type: StrategyMutation["type"]): number {
  if (type === "reorder") return 0;
  if (type === "split-stage") return 1;
  if (type === "reduce-scope") return 2;
  if (type === "add-validation") return 3;
  return 4;
}

function mutationKey(mutation: StrategyMutation): string {
  if (mutation.type === "reorder") {
    return JSON.stringify({ type: mutation.type, units: sortedUnique(mutation.units) });
  }

  if (mutation.type === "split-stage") {
    return JSON.stringify({ type: mutation.type, stageId: mutation.stageId });
  }

  if (mutation.type === "reduce-scope") {
    return JSON.stringify({ type: mutation.type, units: sortedUnique(mutation.units) });
  }

  if (mutation.type === "add-validation") {
    return JSON.stringify({ type: mutation.type, stageId: mutation.stageId });
  }

  return JSON.stringify({ type: mutation.type, size: mutation.size });
}

function mutationSort(left: StrategyMutation, right: StrategyMutation): number {
  return mutationRank(left.type) - mutationRank(right.type)
    || mutationKey(left).localeCompare(mutationKey(right));
}

function dedupeMutations(mutations: StrategyMutation[]): StrategyMutation[] {
  const byKey = new Map<string, StrategyMutation>();
  for (const mutation of mutations) {
    const key = mutationKey(mutation);
    if (!byKey.has(key)) {
      byKey.set(key, mutation);
    }
  }

  return [...byKey.values()].sort(mutationSort);
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
    mutation: mutationKey(mutation),
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

function adjustBatchingPlan(plan: Plan, size: number): Plan {
  const batchSize = Math.max(1, Math.floor(size));
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

  for (const task of refactors) {
    const files = filesForTask(task);
    if (files.length <= batchSize) {
      expanded.push(task);
      remap.set(task.id, task.id);
      continue;
    }

    const externalDepends = sortedUnique((task.dependsOn ?? [])
      .filter((dependencyId) => !oldRefactorIds.has(dependencyId)));
    let previousId: string | undefined;
    let lastId = task.id;

    for (let index = 0; index < files.length; index += batchSize) {
      const chunk = files.slice(index, index + batchSize);
      const splitId = `t-refactor-adp-batch-${counter}`;
      counter += 1;
      const dependsOn = previousId ? [previousId] : externalDepends;
      expanded.push(normalizeTask({
        ...task,
        id: splitId,
        title: `${task.title} [batch ${counter - 1}]`,
        description: `Adaptive batch split of ${task.id}`,
        scope: {
          ...(task.scope ?? {}),
          files: chunk,
        },
        dependsOn,
      }));
      previousId = splitId;
      lastId = splitId;
    }

    remap.set(task.id, lastId);
  }

  return composePlan(cloned, expanded, remap);
}

function reduceScopePlan(plan: Plan, units: string[]): Plan {
  const selectedUnits = new Set(units);
  const cloned = clonePlan(plan);
  cloned.tasks = cloned.tasks
    .map((task) => {
      if (task.type !== "refactor") {
        return normalizeTask(task);
      }

      if (selectedUnits.size > 0 && !selectedUnits.has(task.id)) {
        return normalizeTask(task);
      }

      const files = filesForTask(task);
      if (files.length <= 1) {
        return normalizeTask(task);
      }

      return normalizeTask({
        ...task,
        scope: {
          ...(task.scope ?? {}),
          files: [files[0] as string],
        },
        title: `${task.title} [reduced-scope]`,
      });
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return cloned;
}

function addValidationPlan(plan: Plan, stageId: string): Plan {
  const cloned = clonePlan(plan);
  const marker = `adaptive-validation:${stageId}`;
  cloned.tasks = cloned.tasks
    .map((task) => {
      if (task.type !== "enforce") {
        return normalizeTask(task);
      }

      return normalizeTask({
        ...task,
        successCriteria: sortedUnique([...(task.successCriteria ?? []), marker]),
      });
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return cloned;
}

function applyMutationToPlan(plan: Plan, state: StatePlane, mutation: StrategyMutation): Plan {
  if (mutation.type === "reorder") {
    return reorderByDependency(plan, state);
  }

  if (mutation.type === "split-stage") {
    return splitRefactorTasks(plan, `t-refactor-adp-${mutation.stageId}`);
  }

  if (mutation.type === "reduce-scope") {
    return reduceScopePlan(plan, mutation.units);
  }

  if (mutation.type === "add-validation") {
    return addValidationPlan(plan, mutation.stageId);
  }

  return adjustBatchingPlan(plan, mutation.size);
}

const splitLargeTasksMutation: MutationRule = {
  id: "split-large-tasks",
  fromStrategy: "aggressive",
  condition: (pattern) => pattern.type === "too-many-patches" || pattern.type === "too-many-files",
  buildMutation: () => ({
    type: "split-stage",
    stageId: "refactor",
  }),
};

const increaseGranularityMutation: MutationRule = {
  id: "increase-granularity",
  fromStrategy: "grouped",
  condition: (pattern) => pattern.type === "validation-failure" || pattern.type === "conflict-heavy",
  buildMutation: (pattern) => ({
    type: "reduce-scope",
    units: sortedUnique(pattern.units ?? []),
  }),
};

const enforceLayeringMutation: MutationRule = {
  id: "enforce-layering",
  fromStrategy: "minimal",
  condition: (pattern) => pattern.type === "conflict-heavy"
    || pattern.type === "validation-failure"
    || pattern.type === "dependency-ordering",
  buildMutation: (pattern) => ({
    type: "reorder",
    units: sortedUnique(pattern.units ?? []),
  }),
};

const policyGuardMutation: MutationRule = {
  id: "policy-guard",
  fromStrategy: "adaptive",
  condition: (pattern) => pattern.type === "policy-violation",
  buildMutation: (pattern) => ({
    type: "add-validation",
    stageId: pattern.rule ?? "policy",
  }),
};

const riskBatchingMutation: MutationRule = {
  id: "risk-batching",
  fromStrategy: "adaptive",
  condition: (pattern) => pattern.type === "high-risk",
  buildMutation: (pattern) => ({
    type: "adjust-batching",
    size: Math.max(1, Math.floor(pattern.thresholdExceeded ?? 1)),
  }),
};

const BASE_MUTATIONS: StrategyMutation[] = [
  { type: "reorder", units: [] },
  { type: "split-stage", stageId: "refactor" },
  { type: "reduce-scope", units: [] },
  { type: "add-validation", stageId: "policy" },
  { type: "adjust-batching", size: 1 },
];

export const MUTATIONS: StrategyMutation[] = [...BASE_MUTATIONS].sort(mutationSort);

const MUTATION_RULES: MutationRule[] = [
  enforceLayeringMutation,
  increaseGranularityMutation,
  splitLargeTasksMutation,
  policyGuardMutation,
  riskBatchingMutation,
].sort((left, right) => left.id.localeCompare(right.id));

export function generateMutations(strategy: Strategy, patterns: FailurePattern[]): StrategyMutation[] {
  const normalizedPatterns = dedupePatterns(patterns);
  const generated: StrategyMutation[] = [];

  for (const pattern of normalizedPatterns) {
    for (const rule of MUTATION_RULES) {
      if (rule.fromStrategy !== strategy.type && !(rule.fromStrategy === "adaptive" && strategy.type === "adaptive")) {
        continue;
      }

      if (!rule.condition(pattern)) {
        continue;
      }

      generated.push(rule.buildMutation(pattern));
    }
  }

  return dedupeMutations(generated);
}

export function applyMutations(strategy: Strategy, mutations: StrategyMutation[]): Strategy[] {
  const ordered = dedupeMutations(mutations);
  return ordered.map((mutation) => {
    const id = createHash("sha256")
      .update(JSON.stringify({ strategyId: strategy.id, mutation: mutationKey(mutation) }))
      .digest("hex")
      .slice(0, 12);
    return {
      id: `s-adaptive-${id}`,
      type: "adaptive" as const,
      description: `Adaptive mutation ${mutation.type} from ${strategy.id}`,
      transform: (basePlan, state) => applyMutationToPlan(strategy.transform(basePlan, state), state, mutation),
    };
  });
}

export function limitVariants(variants: Strategy[], max: number): Strategy[] {
  const bounded = Math.max(0, Math.floor(max));
  return dedupeStrategies(variants).slice(0, bounded);
}

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

function dedupeOutcomes(outcomes: StrategyOutcome[]): StrategyOutcome[] {
  const byStrategy = new Map<string, StrategyOutcome>();

  for (const outcome of outcomes) {
    const existing = byStrategy.get(outcome.strategyId);
    if (!existing) {
      byStrategy.set(outcome.strategyId, outcome);
      continue;
    }

    const preferred = selectBestOutcome([existing, outcome]);
    byStrategy.set(outcome.strategyId, preferred);
  }

  return [...byStrategy.values()].sort((left, right) => left.strategyId.localeCompare(right.strategyId));
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

export function analyzeFailure(outcome: StrategyOutcome): FailurePattern[] {
  const patterns: FailurePattern[] = [];

  const sortedFailures = [...(outcome.failures ?? [])]
    .sort((left, right) => left.type.localeCompare(right.type) || (left.unitId ?? "").localeCompare(right.unitId ?? ""));

  const dependencyUnits = sortedUnique(sortedFailures
    .filter((failure) => failure.type.includes("depend") || failure.type.includes("order"))
    .flatMap((failure) => failure.unitId ? [failure.unitId] : []));
  if (dependencyUnits.length > 0) {
    patterns.push({
      type: "dependency-ordering",
      strategyId: outcome.strategyId,
      metrics: outcome.metrics,
      units: dependencyUnits,
      details: "dependency ordering failure observed",
    });
  }

  const policyFailures = sortedFailures.filter((failure) => failure.type.includes("policy") || failure.type.includes("approval"));
  for (const failure of policyFailures) {
    patterns.push({
      type: "policy-violation",
      strategyId: outcome.strategyId,
      metrics: outcome.metrics,
      rule: failure.type,
      details: failure.unitId,
    });
  }

  const riskScore = outcome.metrics.remainingViolations + outcome.metrics.introducedErrors;
  if (riskScore > 0) {
    patterns.push({
      type: "high-risk",
      strategyId: outcome.strategyId,
      metrics: outcome.metrics,
      thresholdExceeded: riskScore,
      details: `risk=${riskScore}`,
    });
  }

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

export function analyzeOutcome(outcome: StrategyOutcome): FailurePattern[] {
  return analyzeFailure(outcome);
}

export function isGoodEnough(outcome: StrategyOutcome): boolean {
  return outcome.success && outcome.metrics.remainingViolations === 0;
}

function validateGeneratedPlan(plan: Plan): boolean {
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
  }

  return true;
}

export function refineStrategies(
  outcomes: StrategyOutcome[],
  state: StatePlane,
  options: RefineStrategiesOptions
): {
  strategies: Strategy[];
  mutationsApplied: number;
  mutationList: StrategyMutation[];
  evolution: StrategyEvolution[];
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
  const mutationList: StrategyMutation[] = [];
  const evolution: StrategyEvolution[] = [];
  const decisions: string[] = [];
  const maxNew = options.maxNewStrategies ?? MAX_NEW_STRATEGIES_PER_ITERATION;

  for (const outcome of [...outcomes].sort((left, right) => left.strategyId.localeCompare(right.strategyId))) {
    const patterns = dedupePatterns([
      ...analyzeFailure(outcome),
      ...(historicalByStrategy.get(outcome.strategyId) ?? []),
    ]);

    const parentStrategy: Strategy = {
      id: outcome.strategyId,
      type: outcome.strategyType,
      description: `Recovered strategy ${outcome.strategyId}`,
      transform: () => clonePlan(outcome.plan),
    };

    for (const pattern of patterns) {
      const mutations = generateMutations(parentStrategy, [pattern]);
      const variants = applyMutations(parentStrategy, mutations);
      const bounded = limitVariants(variants, Math.max(0, maxNew - created.length));

      for (let index = 0; index < bounded.length; index += 1) {
        if (created.length >= maxNew) {
          break;
        }

        const mutation = mutations[index];
        if (!mutation) {
          continue;
        }

        const variant = bounded[index] as Strategy;
        const mutatedPlan = variant.transform(outcome.plan, state);
        if (!validateGeneratedPlan(mutatedPlan)) {
          decisions.push(`Rejected mutation ${mutation.type} for ${outcome.strategyId}: invalid plan graph`);
          continue;
        }

        const strategyId = generateStrategyId(outcome, mutation, pattern, mutatedPlan);
        if (existingIds.has(strategyId)) {
          continue;
        }

        existingIds.add(strategyId);
        created.push({
          id: strategyId,
          type: "adaptive",
          description: `Adaptive strategy from ${outcome.strategyId} via ${mutation.type}`,
          transform: () => clonePlan(mutatedPlan),
        });
        mutationList.push(mutation);
        evolution.push({
          parentId: outcome.strategyId,
          childId: strategyId,
          mutation,
        });
        decisions.push(`Applied ${mutation.type} to ${outcome.strategyId} due to ${pattern.type} -> ${strategyId}`);
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
    mutationList: dedupeMutations(mutationList),
    evolution: [...evolution].sort((left, right) => left.parentId.localeCompare(right.parentId) || left.childId.localeCompare(right.childId)),
    decisions,
  };
}

export function buildStrategyHistory(planId: string, outcomes: StrategyOutcome[]): StrategyHistory[] {
  return [...outcomes]
    .sort((left, right) => left.strategyId.localeCompare(right.strategyId))
    .map((outcome) => {
      const patterns: FailurePatternRecord[] = analyzeOutcome(outcome)
        .filter((pattern): pattern is FailurePattern & { type: FailurePatternRecord["type"] } => HISTORY_PATTERN_TYPES.has(pattern.type as FailurePatternRecord["type"]))
        .map((pattern) => ({
          type: pattern.type,
          strategyId: pattern.strategyId,
          metrics: {
            filesChanged: pattern.metrics.filesChanged,
            patchesCount: pattern.metrics.patchesCount,
            remainingViolations: pattern.metrics.remainingViolations,
            introducedErrors: pattern.metrics.introducedErrors,
          },
          ...(pattern.details ? { details: pattern.details } : {}),
        }));

      return {
        planId,
        strategyId: outcome.strategyId,
        strategyType: outcome.strategyType,
        patterns,
        outcomeMetrics: outcome.metrics,
      };
    });
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

export function isImproved(candidate: StrategyMetrics, baseline: StrategyMetrics): boolean {
  if (candidate.remainingViolations !== baseline.remainingViolations) {
    return candidate.remainingViolations < baseline.remainingViolations;
  }

  if (candidate.introducedErrors !== baseline.introducedErrors) {
    return candidate.introducedErrors < baseline.introducedErrors;
  }

  if (candidate.patchesCount !== baseline.patchesCount) {
    return candidate.patchesCount < baseline.patchesCount;
  }

  return candidate.filesChanged < baseline.filesChanged;
}

export async function adaptiveCycle(
  strategy: Strategy,
  basePlan: Plan,
  state: StatePlane,
  options: EvaluateStrategyOptions
): Promise<{
  selected: StrategyOutcome;
  outcomes: StrategyOutcome[];
  patterns: FailurePattern[];
  mutations: StrategyMutation[];
  variants: Strategy[];
  evolution: StrategyEvolution[];
}> {
  const initial = await evaluateStrategy(strategy, basePlan, state, options);
  if (isGoodEnough(initial)) {
    return {
      selected: initial,
      outcomes: [initial],
      patterns: [],
      mutations: [],
      variants: [],
      evolution: [],
    };
  }

  const patterns = analyzeFailure(initial);
  const mutations = generateMutations(strategy, patterns);
  const variants = limitVariants(applyMutations(strategy, mutations), MAX_NEW_STRATEGIES_PER_ITERATION);

  if (variants.length === 0) {
    return {
      selected: initial,
      outcomes: [initial],
      patterns,
      mutations,
      variants,
      evolution: [],
    };
  }

  const outcomes = await evaluateStrategies(basePlan, state, {
    ...options,
    strategies: variants,
    maxStrategies: variants.length,
  });
  const selected = selectBestOutcome(outcomes);
  const evolution: StrategyEvolution[] = variants
    .map((variant, index) => ({
      parentId: strategy.id,
      childId: variant.id,
      mutation: mutations[index] as StrategyMutation,
    }))
    .filter((entry) => Boolean(entry.mutation))
    .sort((left, right) => left.childId.localeCompare(right.childId));

  return {
    selected,
    outcomes,
    patterns,
    mutations,
    variants,
    evolution,
  };
}

function adaptiveCycleFingerprint(result: {
  selected: StrategyOutcome;
  outcomes: StrategyOutcome[];
  patterns: FailurePattern[];
  mutations: StrategyMutation[];
  variants: Strategy[];
  evolution: StrategyEvolution[];
}): string {
  return JSON.stringify({
    selected: result.selected.strategyId,
    outcomes: dedupeOutcomes(result.outcomes).map((outcome) => ({
      strategyId: outcome.strategyId,
      metrics: outcome.metrics,
      success: outcome.success,
      previewHash: outcome.previewHash,
    })),
    patterns: dedupePatterns(result.patterns).map((pattern) => patternKey(pattern)),
    mutations: dedupeMutations(result.mutations).map((mutation) => mutationKey(mutation)),
    variants: dedupeStrategies(result.variants).map((variant) => variant.id),
    evolution: [...result.evolution]
      .sort((left, right) => left.childId.localeCompare(right.childId))
      .map((entry) => ({
        parentId: entry.parentId,
        childId: entry.childId,
        mutation: mutationKey(entry.mutation),
      })),
  });
}

export async function assertDeterministicAdaptiveCycle(
  strategy: Strategy,
  basePlan: Plan,
  state: StatePlane,
  options: EvaluateStrategyOptions
): Promise<{
  selected: StrategyOutcome;
  outcomes: StrategyOutcome[];
  patterns: FailurePattern[];
  mutations: StrategyMutation[];
  variants: Strategy[];
  evolution: StrategyEvolution[];
}> {
  const first = await adaptiveCycle(strategy, clonePlan(basePlan), cloneState(state), options);
  const second = await adaptiveCycle(strategy, clonePlan(basePlan), cloneState(state), options);

  const firstFingerprint = adaptiveCycleFingerprint(first);
  const secondFingerprint = adaptiveCycleFingerprint(second);

  if (firstFingerprint !== secondFingerprint) {
    throw new Error("Determinism violation: adaptiveCycle produced divergent results for identical inputs");
  }

  return first;
}

export async function iterateStrategy(
  strategy: Strategy,
  maxIterations: number,
  basePlan: Plan,
  state: StatePlane,
  options: EvaluateStrategyOptions
): Promise<{
  selected: StrategyOutcome;
  outcomes: StrategyOutcome[];
  trace: AdaptiveTrace;
}> {
  const boundedIterations = Math.max(1, Math.floor(maxIterations));
  let currentStrategy = strategy;
  let selected = await evaluateStrategy(currentStrategy, basePlan, state, options);
  let outcomes: StrategyOutcome[] = [selected];
  const decisions: string[] = [];
  const mutationDetails: StrategyMutation[] = [];
  const evolution: StrategyEvolution[] = [];
  const tested = new Set<string>([selected.strategyId]);
  let completedIterations = 0;

  for (let iteration = 1; iteration <= boundedIterations; iteration += 1) {
    completedIterations = iteration;
    if (isGoodEnough(selected)) {
      decisions.push(`Stop: ${selected.strategyId} satisfied success criteria`);
      break;
    }

    const cycle = await adaptiveCycle(currentStrategy, basePlan, state, options);
    mutationDetails.push(...cycle.mutations);
    evolution.push(...cycle.evolution);
    outcomes = [...outcomes, ...cycle.outcomes].sort((left, right) => left.strategyId.localeCompare(right.strategyId));
    cycle.outcomes.forEach((entry) => tested.add(entry.strategyId));

    if (!isImproved(cycle.selected.metrics, selected.metrics)) {
      decisions.push(`Stop: no improvement after iteration ${iteration}`);
      break;
    }

    selected = cycle.selected;
    const nextStrategy = cycle.variants.find((variant) => variant.id === cycle.selected.strategyId);
    if (!nextStrategy) {
      decisions.push(`Stop: selected variant ${cycle.selected.strategyId} not found in variant set`);
      break;
    }

    currentStrategy = nextStrategy;
  }

  const evolutionByKey = new Map<string, StrategyEvolution>();
  for (const item of evolution) {
    const key = `${item.parentId}->${item.childId}:${mutationKey(item.mutation)}`;
    if (!evolutionByKey.has(key)) {
      evolutionByKey.set(key, item);
    }
  }

  const trace: AdaptiveTrace = {
    iterations: completedIterations > 0 ? completedIterations : 1,
    strategiesEvaluated: outcomes.length,
    mutationsApplied: mutationDetails.length,
    strategiesTested: [...tested].sort((left, right) => left.localeCompare(right)),
    mutationsAppliedDetails: dedupeMutations(mutationDetails),
    evolution: [...evolutionByKey.values()].sort((left, right) => left.childId.localeCompare(right.childId)),
    finalStrategy: selected.strategyId,
    selectedStrategyId: selected.strategyId,
    decisions,
  };

  return {
    selected,
    outcomes,
    trace,
  };
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
  const mutationDetails: StrategyMutation[] = [];
  const evolution: StrategyEvolution[] = [];
  const strategiesTested = new Set<string>();
  const allOutcomes: StrategyOutcome[] = [];
  const iterationsTrace: AdaptiveIterationResult[] = [];
  let latestOutcomes: StrategyOutcome[] = [];
  let previousBest: StrategyOutcome | undefined;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    iterations = iteration + 1;
    const outcomes = await evaluateStrategies(basePlan, state, {
      ...options,
      strategies,
      maxStrategies: strategies.length,
    });

    latestOutcomes = outcomes;
    allOutcomes.push(...outcomes);
    strategiesEvaluated += outcomes.length;
    outcomes.forEach((outcome) => strategiesTested.add(outcome.strategyId));

    const best = selectBestOutcome(outcomes);
    iterationsTrace.push({
      iteration: iterations,
      selectedStrategyId: best.strategyId,
      outcomes: [...outcomes].sort((left, right) => left.strategyId.localeCompare(right.strategyId)),
    });
    decisions.push(`Iteration ${iterations}: best=${best.strategyId} remaining=${best.metrics.remainingViolations} introduced=${best.metrics.introducedErrors}`);

    if (previousBest && !isImproved(best.metrics, previousBest.metrics)) {
      decisions.push(`Stop: no improvement from ${previousBest.strategyId} to ${best.strategyId}`);
      break;
    }

    if (isGoodEnough(best)) {
      decisions.push(`Stop: ${best.strategyId} satisfied isGoodEnough`);
      const adaptiveTrace: AdaptiveTrace = {
        iterations,
        strategiesEvaluated,
        mutationsApplied,
        strategiesTested: [...strategiesTested].sort((left, right) => left.localeCompare(right)),
        mutationsAppliedDetails: dedupeMutations(mutationDetails),
        evolution: [...evolution].sort((left, right) => left.childId.localeCompare(right.childId)),
        finalStrategy: best.strategyId,
        selectedStrategyId: best.strategyId,
        decisions,
      };

      return {
        selected: best,
        outcomes: dedupeOutcomes(allOutcomes),
        adaptiveTrace,
        history: buildStrategyHistory(basePlan.id, dedupeOutcomes(allOutcomes)),
        iterations: iterationsTrace,
      };
    }

    const historicalPatterns = collectHistoricalPatterns(state, outcomes);
    const refined = refineStrategies(outcomes, state, {
      existingStrategies: strategies,
      historicalPatterns,
      maxNewStrategies: MAX_NEW_STRATEGIES_PER_ITERATION,
    });

    mutationsApplied += refined.mutationsApplied;
    mutationDetails.push(...refined.mutationList);
    evolution.push(...refined.evolution);
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
    previousBest = best;
  }

  const finalBest = selectBestOutcome(latestOutcomes);
  const adaptiveTrace: AdaptiveTrace = {
    iterations,
    strategiesEvaluated,
    mutationsApplied,
    strategiesTested: [...strategiesTested].sort((left, right) => left.localeCompare(right)),
    mutationsAppliedDetails: dedupeMutations(mutationDetails),
    evolution: [...evolution].sort((left, right) => left.childId.localeCompare(right.childId)),
    finalStrategy: finalBest.strategyId,
    selectedStrategyId: finalBest.strategyId,
    decisions,
  };

  return {
    selected: finalBest,
    outcomes: dedupeOutcomes(allOutcomes.length > 0 ? allOutcomes : latestOutcomes),
    adaptiveTrace,
    history: buildStrategyHistory(basePlan.id, dedupeOutcomes(allOutcomes.length > 0 ? allOutcomes : latestOutcomes)),
    iterations: iterationsTrace,
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
