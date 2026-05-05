import { Fix } from "../fix/types.js";
import { ControlPlane, Plan, Task } from "../schema.js";
import { PlanScore, scorePlan } from "./costPlanner.js";
import { computeLayers } from "./orchestration.js";
import {
  TransactionEnforcer,
  TransactionPipeline,
  ValidationResult,
  WorkUnit,
  buildExecutionPlan,
  createInMemoryTransactionFS,
  runExecutionPlanSimulation,
} from "./scheduler.js";
import { StatePlane } from "./state.js";
import { Diagnostic } from "./types.js";

export type StrategyType = "minimal" | "grouped" | "layered" | "aggressive";

export type Strategy = {
  id: string;
  type: StrategyType;
  description: string;
  transform: (basePlan: Plan, state: StatePlane) => Plan;
};

export type StrategyResult = {
  strategyId: string;
  plan: Plan;
  cost: PlanScore;
  validation: ValidationResult;
  success: boolean;
};

export type StrategyTrace = {
  evaluated: {
    strategyId: string;
    cost: number;
    success: boolean;
  }[];
  selectedStrategyId: string;
  decision: string;
};

export const MAX_STRATEGIES = 4;

type EvaluateStrategyOptions = {
  controlPlane: ControlPlane;
  maxNewErrors?: number;
};

type EvaluateStrategiesOptions = EvaluateStrategyOptions & {
  maxStrategies?: number;
  costThreshold?: number;
  strategies?: Strategy[];
};

const SIM_FALLBACK_FILE = ".choir/choir.config.yaml";

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

function simulationLocation(file: string): Diagnostic["location"] {
  return {
    file,
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  };
}

function diagnosticsByTask(workUnits: WorkUnit[]): Map<string, string> {
  const mapping = new Map<string, string>();

  for (const task of workUnits.flatMap((unit) => unit.tasks)) {
    if (!mapping.has(task.id)) {
      mapping.set(task.id, filesForTask(task)[0] ?? SIM_FALLBACK_FILE);
    }
  }

  return mapping;
}

function simulationEnforcer(): TransactionEnforcer {
  return {
    async proposeFixes(workUnits: WorkUnit[]) {
      const fileByTaskId = diagnosticsByTask(workUnits);
      const refactorTaskIds = sortedUnique(workUnits
        .flatMap((unit) => unit.tasks)
        .filter((task) => task.type === "refactor")
        .map((task) => task.id));

      const diagnostics: Diagnostic[] = refactorTaskIds.map((taskId, index) => ({
        id: `sim-diag-${taskId}`,
        ruleId: `sim-rule-${taskId}`,
        message: `Simulated refactor for ${taskId}`,
        severity: "warning",
        category: "AST",
        location: simulationLocation(fileByTaskId.get(taskId) ?? SIM_FALLBACK_FILE),
        traceId: `sim-trace-${index + 1}`,
      }));

      const fixes: Fix[] = refactorTaskIds.map((taskId, index) => ({
        id: `sim-fix-${taskId}`,
        ruleId: `sim-rule-${taskId}`,
        title: `Simulated fix for ${taskId}`,
        diagnosticIds: [`sim-diag-${taskId}`],
        patches: [],
        isSafe: true,
        traceId: `sim-trace-${index + 1}`,
      }));

      return {
        fixes,
        diagnostics,
      };
    },
  };
}

function simulationPipeline(state: StatePlane): TransactionPipeline {
  return {
    async run() {
      return {
        diagnostics: [...state.violations],
        conflicts: [],
      };
    },
  };
}

function failedValidation(message: string): ValidationResult {
  return {
    passed: false,
    diagnostics: [],
    conflicts: [],
    invariantChecks: [],
    errors: [message],
  };
}

async function evaluateTransformedPlan(
  strategyId: string,
  plan: Plan,
  state: StatePlane,
  options: EvaluateStrategyOptions
): Promise<StrategyResult> {
  const cost = scorePlan(plan, state);

  try {
    const built = buildExecutionPlan([plan]);
    const simulation = await runExecutionPlanSimulation(built.executionPlan, {
      fs: createInMemoryTransactionFS({ state: cloneState(state) }),
      enforcer: simulationEnforcer(),
      pipeline: simulationPipeline(state),
      controlPlane: options.controlPlane,
      maxNewErrors: options.maxNewErrors,
    });

    return {
      strategyId,
      plan,
      cost,
      validation: simulation.validation,
      success: simulation.allPassed && simulation.validation.passed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      strategyId,
      plan,
      cost,
      validation: failedValidation(message),
      success: false,
    };
  }
}

export async function evaluateStrategy(
  strategy: Strategy,
  basePlan: Plan,
  state: StatePlane,
  options: EvaluateStrategyOptions
): Promise<StrategyResult> {
  return evaluateTransformedPlan(strategy.id, strategy.transform(basePlan, state), state, options);
}

export async function evaluateStrategies(
  basePlan: Plan,
  state: StatePlane,
  options: EvaluateStrategiesOptions
): Promise<StrategyResult[]> {
  const maxStrategies = options.maxStrategies ?? MAX_STRATEGIES;
  const costThreshold = options.costThreshold ?? Number.POSITIVE_INFINITY;
  const strategies = [...(options.strategies ?? STRATEGIES)]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, maxStrategies);

  const results: StrategyResult[] = [];

  for (const strategy of strategies) {
    const transformedPlan = strategy.transform(basePlan, state);
    const estimated = scorePlan(transformedPlan, state);

    if (estimated.totalCost > costThreshold) {
      const thresholdText = Number.isFinite(costThreshold) ? costThreshold.toFixed(2) : String(costThreshold);
      results.push({
        strategyId: strategy.id,
        plan: transformedPlan,
        cost: estimated,
        validation: failedValidation(
          `Skipped strategy ${strategy.id}: estimated cost ${estimated.totalCost.toFixed(2)} exceeded threshold ${thresholdText}`
        ),
        success: false,
      });
      continue;
    }

    results.push(await evaluateTransformedPlan(strategy.id, transformedPlan, state, options));
  }

  return [...results].sort((left, right) => left.strategyId.localeCompare(right.strategyId));
}

export function selectBestStrategy(results: StrategyResult[]): StrategyResult {
  if (results.length === 0) {
    throw new Error("Cannot select best strategy from an empty result list");
  }

  const valid = results.filter((result) => result.success);
  const candidates = valid.length > 0 ? valid : results;

  return [...candidates]
    .sort((left, right) => left.cost.totalCost - right.cost.totalCost || left.strategyId.localeCompare(right.strategyId))[0] as StrategyResult;
}

export function buildStrategyTrace(results: StrategyResult[], selected: StrategyResult): StrategyTrace {
  const evaluated = [...results]
    .sort((left, right) => left.strategyId.localeCompare(right.strategyId))
    .map((result) => ({
      strategyId: result.strategyId,
      cost: result.cost.totalCost,
      success: result.success,
    }));

  const decision = selected.success
    ? `${selected.strategyId} selected: validated with lowest cost ${selected.cost.totalCost.toFixed(2)}`
    : `${selected.strategyId} selected: no strategy passed validation; using lowest-cost fallback ${selected.cost.totalCost.toFixed(2)}`;

  return {
    evaluated,
    selectedStrategyId: selected.strategyId,
    decision,
  };
}
