import { ControlPlane, Plan, Task } from "../schema.js";
import { computeLayers } from "./orchestration.js";
import { Patch } from "../fix/types.js";
import { ValidationResult } from "./scheduler.js";
import { StatePlane } from "./state.js";
import { Diagnostic } from "./types.js";
import { FileChange, simulatePlanOutcome } from "./executionPreview.js";

export type StrategyType = "minimal" | "grouped" | "layered" | "aggressive";

export type Strategy = {
  id: string;
  type: StrategyType;
  description: string;
  transform: (basePlan: Plan, state: StatePlane) => Plan;
};

export type StrategyOutcome = {
  strategyId: string;
  plan: Plan;
  patches: Patch[];
  diagnostics: Diagnostic[];
  validation: ValidationResult;
  metrics: {
    filesChanged: number;
    patchesCount: number;
    remainingViolations: number;
    introducedErrors: number;
  };
  success: boolean;
  fileChanges: FileChange[];
  previewHash: string;
};

export type StrategySelectionTrace = {
  evaluated: {
    strategyId: string;
    metrics: StrategyOutcome["metrics"];
    success: boolean;
  }[];
  selectedStrategyId: string;
  decision: string;
};

export type StrategyTrace = StrategySelectionTrace;

export const MAX_STRATEGIES = 4;

type EvaluateStrategyOptions = {
  controlPlane: ControlPlane;
  root: string;
};

type EvaluateStrategiesOptions = EvaluateStrategyOptions & {
  maxStrategies?: number;
  strategies?: Strategy[];
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

function failedOutcome(strategyId: string, plan: Plan, message: string): StrategyOutcome {
  return {
    strategyId,
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

async function evaluateTransformedPlan(
  strategyId: string,
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
    return failedOutcome(strategyId, plan, message);
  }
}

export async function evaluateStrategy(
  strategy: Strategy,
  basePlan: Plan,
  state: StatePlane,
  options: EvaluateStrategyOptions
): Promise<StrategyOutcome> {
  return evaluateTransformedPlan(strategy.id, strategy.transform(basePlan, state), state, options);
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
    results.push(await evaluateTransformedPlan(strategy.id, transformedPlan, state, options));
  }

  return [...results].sort((left, right) => left.strategyId.localeCompare(right.strategyId));
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

export function buildStrategyTrace(results: StrategyOutcome[], selected: StrategyOutcome): StrategyTrace {
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
  };
}
