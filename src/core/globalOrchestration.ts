import { createHash } from "crypto";
import { SystemState } from "./distributedSync.js";

export type RepoTask = {
  id: string;
  action: string;
  dependsOn: string[];
};

export type Repo = {
  id: string;
  state: SystemState;
  dependencies: string[];
  tasks?: RepoTask[];
  teamId?: string;
  environment?: string;
};

export type GlobalDependencyNode = {
  repoId: string;
  taskId: string;
};

export type GlobalDependencyEdge = {
  from: string;
  to: string;
};

export type GlobalDependencyGraph = {
  nodes: GlobalDependencyNode[];
  edges: GlobalDependencyEdge[];
};

export type GlobalPlanTask = {
  id: string;
  repoId: string;
  action: string;
  dependsOn: string[];
};

export type GlobalPlan = {
  id: string;
  tasks: GlobalPlanTask[];
};

export type ExecutionOrder = {
  orderedTaskIds: string[];
  tasks: GlobalPlanTask[];
};

export type TaskBatch = {
  id: string;
  taskIds: string[];
  tasks: GlobalPlanTask[];
};

export type PolicySourceLayer = "org" | "team" | "repo" | "environment";
export type PolicyEffect = "allow" | "require-approval" | "deny";

export type GlobalPolicyRule =
  | {
    id: string;
    kind: "deny-action-prefix";
    effect: PolicyEffect;
    actionPrefix: string;
    repoIds?: string[];
  }
  | {
    id: string;
    kind: "require-repo-action-prefix";
    effect: PolicyEffect;
    actionPrefix: string;
    repoIds?: string[];
  }
  | {
    id: string;
    kind: "cross-repo-action-compatibility";
    effect: PolicyEffect;
    upstreamPrefix: string;
    downstreamPrefix: string;
  }
  | {
    id: string;
    kind: "require-state-path";
    effect: PolicyEffect;
    path: string;
    repoIds?: string[];
  };

export type OrgPolicy = {
  id: string;
  rules: GlobalPolicyRule[];
};

export type CompiledPolicy = {
  id: string;
  source: PolicySourceLayer;
  rules: GlobalPolicyRule[];
};

export type PolicyPropagation = {
  source: "org";
  targets: string[];
  rules: GlobalPolicyRule[];
};

export type PolicyDistribution = {
  propagation: PolicyPropagation;
  byRepo: Record<string, CompiledPolicy[]>;
};

export type PolicyResult = {
  allowed: boolean;
  requiresApproval: boolean;
  violations: string[];
  policyDecisions: string[];
  appliedPolicyIds: string[];
};

export type PlanValidationResult = {
  valid: boolean;
  errors: string[];
};

export type DriftResult = {
  repoId: string;
  driftDetected: boolean;
  violations: string[];
};

export type GlobalAudit = {
  planId: string;
  reposInvolved: string[];
  policiesApplied: string[];
  violations: string[];
};

export type GlobalTrace = {
  plan: GlobalPlan;
  executionOrder: string[];
  policyDecisions: string[];
  convergence: boolean;
};

export type GlobalContext = {
  repos: Repo[];
  policies: CompiledPolicy[];
  graph: GlobalDependencyGraph;
};

export type GlobalPlanningCache = {
  graphByKey: Map<string, GlobalDependencyGraph>;
  planByKey: Map<string, GlobalPlan>;
};

export type ExecuteGlobalPlanOptions = {
  repos: Repo[];
  policies: CompiledPolicy[];
  validateState?: (state: SystemState, repoId: string) => boolean;
  executeTask?: (
    task: GlobalPlanTask,
    repoState: SystemState,
    repoId: string,
    allStates: Record<string, SystemState>,
    mode: "simulation" | "execution"
  ) => Promise<SystemState>;
};

export type GlobalExecutionResult = {
  success: boolean;
  rolledBack: boolean;
  finalStates: Record<string, SystemState>;
  audit: GlobalAudit;
  trace: GlobalTrace;
};

export type GlobalState = Record<string, SystemState>;

export type SimulationContext = {
  baseState: GlobalState;
  simulatedState: GlobalState;
  plan: GlobalPlan;
  mode: "simulation";
};

export type ChangeSummary = {
  unitId: string;
  filesChanged: string[];
  operations: string[];
};

export type CostModel = {
  changeCost: number;
  riskScore: number;
};

export type SimulationTrace = {
  stepsExecuted: string[];
  unitsAffected: string[];
  replayable: boolean;
};

export type SimulationResult = {
  finalState: GlobalState;
  changes: ChangeSummary[];
  violations: string[];
  policyDecisions: PolicyResult[];
  success: boolean;
  trace: SimulationTrace;
  context: SimulationContext;
};

export type ComparisonResult = {
  bestStrategy: string;
  metrics: {
    risk: number;
    changes: number;
    violations: number;
  };
};

export type GlobalConsistencyResult = {
  valid: boolean;
  errors: string[];
};

type InternalRunResult = {
  success: boolean;
  rolledBack: boolean;
  finalStates: GlobalState;
  baseStates: GlobalState;
  policyResult: PolicyResult;
  orderedTaskIds: string[];
  plan: GlobalPlan;
  violations: string[];
  stepsExecuted: string[];
  unitsAffected: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableSortUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSortUnknown(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stableSortUnknown(value[key])])
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableSortUnknown(value));
}

function cloneUnknown<T>(value: T): T {
  if (typeof value === "undefined") {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneState(state: GlobalState): GlobalState {
  return cloneUnknown(state);
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function stateForRepos(repos: Repo[]): GlobalState {
  return Object.fromEntries(
    [...repos]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((repo) => [repo.id, cloneUnknown(repo.state)] as const)
  ) as GlobalState;
}

function statesEqual(left: GlobalState, right: GlobalState): boolean {
  return stableStringify(left) === stableStringify(right);
}

function collectUndefinedPaths(value: unknown, prefix: string): string[] {
  if (typeof value === "undefined") {
    return [prefix.length > 0 ? prefix : "<root>"];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectUndefinedPaths(entry, `${prefix}[${index}]`));
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((key) => collectUndefinedPaths(value[key], prefix.length > 0 ? `${prefix}.${key}` : key));
}

export function validateGlobalConsistency(simulatedState: GlobalState, repos?: Repo[]): GlobalConsistencyResult {
  const errors: string[] = [];
  const repoIds = Object.keys(simulatedState).sort((left, right) => left.localeCompare(right));

  for (const repoId of repoIds) {
    const state = simulatedState[repoId];
    if (!isRecord(state)) {
      errors.push(`State for ${repoId} must be an object`);
      continue;
    }

    const undefinedPaths = collectUndefinedPaths(state, "");
    for (const entry of undefinedPaths) {
      errors.push(`State for ${repoId} contains undefined value at ${entry}`);
    }
  }

  if (repos) {
    const expectedRepoIds = repos.map((repo) => repo.id).sort((left, right) => left.localeCompare(right));
    if (stableStringify(expectedRepoIds) !== stableStringify(repoIds)) {
      errors.push("Simulated state repo set diverged from orchestration context");
    }
  }

  return {
    valid: errors.length === 0,
    errors: sortedUnique(errors),
  };
}

function summarizeChanges(baseState: GlobalState, finalState: GlobalState, plan: GlobalPlan): ChangeSummary[] {
  const byRepoOperations = new Map<string, string[]>();

  for (const task of [...plan.tasks].sort((left, right) => left.id.localeCompare(right.id))) {
    const operations = byRepoOperations.get(task.repoId) ?? [];
    operations.push(task.action);
    byRepoOperations.set(task.repoId, operations);
  }

  return [...Object.keys(finalState)]
    .sort((left, right) => left.localeCompare(right))
    .map((repoId) => {
      const changed = stableStringify(baseState[repoId] ?? {}) !== stableStringify(finalState[repoId] ?? {});
      return {
        unitId: repoId,
        filesChanged: changed ? [".choir/state.json"] : [],
        operations: sortedUnique(byRepoOperations.get(repoId) ?? []),
      } satisfies ChangeSummary;
    })
    .filter((entry) => entry.filesChanged.length > 0 || entry.operations.length > 0);
}

function filterPlanForUnits(plan: GlobalPlan, units: string[]): GlobalPlan {
  const selectedUnits = sortedUnique(units);
  if (selectedUnits.length === 0) {
    return cloneUnknown(plan);
  }

  const taskById = new Map(plan.tasks.map((task) => [task.id, task] as const));
  const required = new Set(
    plan.tasks
      .filter((task) => selectedUnits.includes(task.repoId))
      .map((task) => task.id)
  );

  const queue = [...required].sort((left, right) => left.localeCompare(right));
  while (queue.length > 0) {
    const taskId = queue.shift() as string;
    const task = taskById.get(taskId);
    if (!task) {
      continue;
    }

    for (const dependencyId of [...task.dependsOn].sort((left, right) => left.localeCompare(right))) {
      if (required.has(dependencyId)) {
        continue;
      }

      required.add(dependencyId);
      queue.push(dependencyId);
      queue.sort((left, right) => left.localeCompare(right));
    }
  }

  const tasks = plan.tasks
    .filter((task) => required.has(task.id))
    .map((task) => ({
      ...task,
      dependsOn: task.dependsOn.filter((dependencyId) => required.has(dependencyId)).sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const id = hashId("global-plan", {
    base: plan.id,
    units: selectedUnits,
    tasks: tasks.map((task) => task.id),
  });

  return {
    id,
    tasks,
  };
}

async function runGlobalPlanInternal(
  plan: GlobalPlan,
  options: ExecuteGlobalPlanOptions,
  mode: "simulation" | "execution",
  units?: string[]
): Promise<InternalRunResult> {
  const validation = validateGlobalPlan(plan);
  if (!validation.valid) {
    const normalizedRepos = options.repos.map((repo) => normalizeRepo(repo)).sort((left, right) => left.id.localeCompare(right.id));
    const baseStates = stateForRepos(normalizedRepos);
    return {
      success: false,
      rolledBack: false,
      finalStates: cloneState(baseStates),
      baseStates,
      policyResult: {
        allowed: false,
        requiresApproval: false,
        violations: validation.errors,
        policyDecisions: ["deny:plan-validation"],
        appliedPolicyIds: [],
      },
      orderedTaskIds: [],
      plan,
      violations: validation.errors,
      stepsExecuted: [],
      unitsAffected: [],
    };
  }

  const normalizedRepos = options.repos.map((repo) => normalizeRepo(repo)).sort((left, right) => left.id.localeCompare(right.id));
  const effectivePlan = units && units.length > 0 ? filterPlanForUnits(plan, units) : cloneUnknown(plan);
  const policyResult = evaluateGlobalPolicies(effectivePlan, flattenPolicies(options.policies), normalizedRepos);
  const ordered = orderPlan(effectivePlan);
  const batches = batchTasks(effectivePlan);

  const states = stateForRepos(normalizedRepos);
  const snapshot = cloneState(states);
  const validateState = options.validateState ?? (() => true);
  const executeTask = options.executeTask ?? (async (task, state) => defaultTaskExecutor(task, state));
  const stepsExecuted: string[] = [];
  const unitsAffected = new Set<string>();

  if (!policyResult.allowed) {
    return {
      success: false,
      rolledBack: false,
      finalStates: cloneState(snapshot),
      baseStates: snapshot,
      policyResult,
      orderedTaskIds: ordered.orderedTaskIds,
      plan: effectivePlan,
      violations: policyResult.violations,
      stepsExecuted,
      unitsAffected: [],
    };
  }

  try {
    for (const batch of batches) {
      const sortedTasks = [...batch.tasks].sort((left, right) => left.id.localeCompare(right.id));
      for (const task of sortedTasks) {
        const currentState = cloneUnknown(states[task.repoId] ?? {});
        const nextState = await executeTask(task, currentState, task.repoId, cloneState(states), mode);
        states[task.repoId] = cloneUnknown(nextState);
        stepsExecuted.push(task.id);
        unitsAffected.add(task.repoId);

        if (!validateState(states[task.repoId], task.repoId)) {
          throw new Error(`State validation failed after task ${task.id}`);
        }
      }
    }

    const consistency = validateGlobalConsistency(states, normalizedRepos);
    if (!consistency.valid) {
      return {
        success: false,
        rolledBack: true,
        finalStates: cloneState(snapshot),
        baseStates: snapshot,
        policyResult,
        orderedTaskIds: ordered.orderedTaskIds,
        plan: effectivePlan,
        violations: consistency.errors,
        stepsExecuted,
        unitsAffected: sortedUnique([...unitsAffected]),
      };
    }

    return {
      success: true,
      rolledBack: false,
      finalStates: cloneState(states),
      baseStates: snapshot,
      policyResult,
      orderedTaskIds: ordered.orderedTaskIds,
      plan: effectivePlan,
      violations: [],
      stepsExecuted,
      unitsAffected: sortedUnique([...unitsAffected]),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      rolledBack: true,
      finalStates: cloneState(snapshot),
      baseStates: snapshot,
      policyResult,
      orderedTaskIds: ordered.orderedTaskIds,
      plan: effectivePlan,
      violations: sortedUnique([...policyResult.violations, reason]),
      stepsExecuted,
      unitsAffected: sortedUnique([...unitsAffected]),
    };
  }
}

export async function simulatePlan(
  plan: GlobalPlan,
  options: ExecuteGlobalPlanOptions
): Promise<SimulationResult> {
  const internal = await runGlobalPlanInternal(plan, options, "simulation");
  const finalState = cloneState(internal.finalStates);
  const baseState = cloneState(internal.baseStates);

  return {
    finalState,
    changes: summarizeChanges(baseState, finalState, internal.plan),
    violations: sortedUnique([...internal.violations, ...internal.policyResult.violations]),
    policyDecisions: [cloneUnknown(internal.policyResult)],
    success: internal.success,
    trace: {
      stepsExecuted: [...internal.stepsExecuted],
      unitsAffected: [...internal.unitsAffected],
      replayable: true,
    },
    context: {
      baseState,
      simulatedState: cloneState(finalState),
      plan: cloneUnknown(internal.plan),
      mode: "simulation",
    },
  };
}

export async function simulateUnits(
  units: string[],
  plan: GlobalPlan,
  options: ExecuteGlobalPlanOptions
): Promise<SimulationResult> {
  const internal = await runGlobalPlanInternal(plan, options, "simulation", units);
  const finalState = cloneState(internal.finalStates);
  const baseState = cloneState(internal.baseStates);

  return {
    finalState,
    changes: summarizeChanges(baseState, finalState, internal.plan),
    violations: sortedUnique([...internal.violations, ...internal.policyResult.violations]),
    policyDecisions: [cloneUnknown(internal.policyResult)],
    success: internal.success,
    trace: {
      stepsExecuted: [...internal.stepsExecuted],
      unitsAffected: [...internal.unitsAffected],
      replayable: true,
    },
    context: {
      baseState,
      simulatedState: cloneState(finalState),
      plan: cloneUnknown(internal.plan),
      mode: "simulation",
    },
  };
}

function strategyMetricsFromSimulation(
  simulation: SimulationResult,
  costModel: CostModel
): { risk: number; changes: number; violations: number } {
  const changes = simulation.changes.reduce((sum, entry) => sum + entry.operations.length, 0);
  const violations = simulation.violations.length;
  const risk = (changes * costModel.changeCost) + (violations * costModel.riskScore) + (simulation.success ? 0 : costModel.riskScore);
  return {
    risk,
    changes,
    violations,
  };
}

export async function compareStrategies(
  strategies: GlobalPlan[],
  options: ExecuteGlobalPlanOptions & { costModel?: CostModel }
): Promise<ComparisonResult> {
  const orderedPlans = [...strategies].sort((left, right) => left.id.localeCompare(right.id));
  const costModel = options.costModel ?? {
    changeCost: 1,
    riskScore: 5,
  };

  if (orderedPlans.length === 0) {
    throw new Error("No strategies provided for comparison");
  }

  const evaluated: Array<{ id: string; metrics: { risk: number; changes: number; violations: number } }> = [];

  for (const strategy of orderedPlans) {
    const simulation = await simulatePlan(strategy, options);
    evaluated.push({
      id: strategy.id,
      metrics: strategyMetricsFromSimulation(simulation, costModel),
    });
  }

  const best = [...evaluated].sort((left, right) =>
    left.metrics.violations - right.metrics.violations
    || left.metrics.risk - right.metrics.risk
    || left.metrics.changes - right.metrics.changes
    || left.id.localeCompare(right.id)
  )[0] as { id: string; metrics: { risk: number; changes: number; violations: number } };

  return {
    bestStrategy: best.id,
    metrics: best.metrics,
  };
}

function normalizeTaskId(value: string): string {
  return value.trim();
}

function globalTaskId(repoId: string, taskId: string): string {
  return `${repoId}:${taskId}`;
}

function normalizeRepo(repo: Repo): Repo {
  const id = repo.id.trim();
  const dependencies = sortedUnique((repo.dependencies ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0));
  const tasks = (repo.tasks ?? [])
    .map((task) => ({
      id: normalizeTaskId(task.id),
      action: task.action.trim(),
      dependsOn: sortedUnique((task.dependsOn ?? []).map((entry) => normalizeTaskId(entry)).filter((entry) => entry.length > 0)),
    }))
    .filter((task) => task.id.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    ...repo,
    id,
    dependencies,
    state: cloneUnknown(repo.state),
    ...(tasks.length > 0 ? { tasks } : {}),
  };
}

function getAtPath(state: SystemState, path: string): { exists: boolean; value: unknown } {
  const segments = path.split(".").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (segments.length === 0) {
    return { exists: false, value: undefined };
  }

  let current: unknown = state;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { exists: false, value: undefined };
    }

    current = current[segment];
  }

  return {
    exists: true,
    value: cloneUnknown(current),
  };
}

function hashId(prefix: string, payload: unknown): string {
  const digest = createHash("sha256").update(stableStringify(payload), "utf-8").digest("hex").slice(0, 12);
  return `${prefix}-${digest}`;
}

function ensureNoRepoCycles(repos: Repo[]): void {
  const byRepoId = new Map(repos.map((repo) => [repo.id, repo] as const));
  const visited = new Set<string>();
  const active = new Set<string>();

  function visit(repoId: string): void {
    if (active.has(repoId)) {
      throw new Error(`Global dependency cycle detected across repositories at ${repoId}`);
    }

    if (visited.has(repoId)) {
      return;
    }

    visited.add(repoId);
    active.add(repoId);

    const repo = byRepoId.get(repoId);
    const deps = repo?.dependencies ?? [];

    for (const dep of deps) {
      if (!byRepoId.has(dep)) {
        throw new Error(`Missing referenced repository dependency: ${dep}`);
      }
      visit(dep);
    }

    active.delete(repoId);
  }

  for (const repo of [...repos].sort((left, right) => left.id.localeCompare(right.id))) {
    visit(repo.id);
  }
}

function extractRepoTasks(repo: Repo): RepoTask[] {
  if (repo.tasks && repo.tasks.length > 0) {
    return repo.tasks;
  }

  const statePlans = Array.isArray((repo.state as Record<string, unknown>).plans)
    ? (repo.state as Record<string, unknown>).plans as Array<Record<string, unknown>>
    : [];

  const taskIds = statePlans
    .flatMap((plan) => Array.isArray(plan.taskIds) ? plan.taskIds : [])
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());

  if (taskIds.length === 0) {
    return [{
      id: "t-sync",
      action: "synchronize-repo-state",
      dependsOn: [],
    }];
  }

  const ordered = sortedUnique(taskIds);
  return ordered.map((taskId, index) => ({
    id: taskId,
    action: `execute:${taskId}`,
    dependsOn: index > 0 ? [ordered[index - 1] as string] : [],
  }));
}

function taskRoots(tasks: RepoTask[]): RepoTask[] {
  return tasks.filter((task) => task.dependsOn.length === 0).sort((left, right) => left.id.localeCompare(right.id));
}

function taskLeaves(tasks: RepoTask[]): RepoTask[] {
  const incoming = new Set(tasks.flatMap((task) => task.dependsOn));
  return tasks.filter((task) => !incoming.has(task.id)).sort((left, right) => left.id.localeCompare(right.id));
}

export function buildGlobalDependencyGraph(repos: Repo[], cache?: GlobalPlanningCache): GlobalDependencyGraph {
  const normalizedRepos = repos.map((repo) => normalizeRepo(repo)).sort((left, right) => left.id.localeCompare(right.id));
  const signature = hashId("graph", normalizedRepos.map((repo) => ({
    id: repo.id,
    dependencies: repo.dependencies,
    taskIds: extractRepoTasks(repo).map((task) => task.id),
  })));

  const cached = cache?.graphByKey.get(signature);
  if (cached) {
    return cloneUnknown(cached);
  }

  ensureNoRepoCycles(normalizedRepos);

  const repoTaskMap = new Map(normalizedRepos.map((repo) => [repo.id, extractRepoTasks(repo)] as const));
  const nodes: GlobalDependencyNode[] = [];
  const edgeSet = new Set<string>();

  for (const repo of normalizedRepos) {
    const tasks = repoTaskMap.get(repo.id) ?? [];
    const taskIdSet = new Set(tasks.map((task) => task.id));

    for (const task of tasks) {
      nodes.push({ repoId: repo.id, taskId: task.id });

      for (const localDep of task.dependsOn) {
        if (!taskIdSet.has(localDep)) {
          throw new Error(`Missing local task dependency ${repo.id}:${localDep}`);
        }

        const from = globalTaskId(repo.id, localDep);
        const to = globalTaskId(repo.id, task.id);
        edgeSet.add(`${from}->${to}`);
      }
    }
  }

  for (const repo of normalizedRepos) {
    const currentTasks = repoTaskMap.get(repo.id) ?? [];
    const currentRoots = taskRoots(currentTasks);

    for (const depRepoId of repo.dependencies) {
      const depTasks = repoTaskMap.get(depRepoId) ?? [];
      const depLeaves = taskLeaves(depTasks);

      for (const fromTask of depLeaves) {
        for (const toTask of currentRoots) {
          const from = globalTaskId(depRepoId, fromTask.id);
          const to = globalTaskId(repo.id, toTask.id);
          edgeSet.add(`${from}->${to}`);
        }
      }
    }
  }

  const edges = [...edgeSet]
    .map((entry) => {
      const [from, to] = entry.split("->");
      return {
        from,
        to,
      } satisfies GlobalDependencyEdge;
    })
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));

  const graph: GlobalDependencyGraph = {
    nodes: nodes.sort((left, right) =>
      left.repoId.localeCompare(right.repoId)
      || left.taskId.localeCompare(right.taskId)
    ),
    edges,
  };

  cache?.graphByKey.set(signature, cloneUnknown(graph));
  return graph;
}

function graphCycleError(nodes: string[], edges: GlobalDependencyEdge[]): string | null {
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node, []] as const));
  for (const edge of edges) {
    const current = outgoing.get(edge.from) ?? [];
    current.push(edge.to);
    outgoing.set(edge.from, current.sort((left, right) => left.localeCompare(right)));
  }

  const visited = new Set<string>();
  const active = new Set<string>();

  function visit(node: string): string | null {
    if (active.has(node)) {
      return node;
    }
    if (visited.has(node)) {
      return null;
    }

    visited.add(node);
    active.add(node);
    const targets = outgoing.get(node) ?? [];
    for (const next of targets) {
      const cycle = visit(next);
      if (cycle) {
        return cycle;
      }
    }
    active.delete(node);
    return null;
  }

  for (const node of [...nodes].sort((left, right) => left.localeCompare(right))) {
    const cycle = visit(node);
    if (cycle) {
      return `Cycle detected in global plan graph at ${cycle}`;
    }
  }

  return null;
}

export function validateGlobalPlan(plan: GlobalPlan): PlanValidationResult {
  const taskIds = plan.tasks.map((task) => task.id);
  const taskSet = new Set(taskIds);
  const errors: string[] = [];

  if (taskSet.size !== taskIds.length) {
    errors.push("Duplicate global task ids detected");
  }

  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!taskSet.has(dep)) {
        errors.push(`Missing dependency ${dep} for task ${task.id}`);
      }
    }
  }

  const parsedActions = new Map<string, Map<string, Set<string>>>();
  for (const task of plan.tasks) {
    const [verbRaw, ...rest] = task.action.split(":");
    const verb = verbRaw.trim().toLowerCase();
    const target = rest.join(":").trim().toLowerCase();
    if (target.length === 0) {
      continue;
    }

    const repoMap = parsedActions.get(task.repoId) ?? new Map<string, Set<string>>();
    const verbs = repoMap.get(target) ?? new Set<string>();
    verbs.add(verb);
    repoMap.set(target, verbs);
    parsedActions.set(task.repoId, repoMap);
  }

  const conflicts: Array<[string, string[]]> = [];
  const oppositePairs: Array<[string, string]> = [
    ["add", "remove"],
    ["enable", "disable"],
    ["grant", "revoke"],
  ];

  for (const [repoId, targetMap] of parsedActions.entries()) {
    for (const [target, verbs] of targetMap.entries()) {
      for (const [a, b] of oppositePairs) {
        if (verbs.has(a) && verbs.has(b)) {
          conflicts.push([`${repoId}:${target}`, [a, b]]);
        }
      }
    }
  }

  for (const [target, verbs] of conflicts.sort((left, right) => left[0].localeCompare(right[0]))) {
    errors.push(`Conflicting actions for ${target}: ${verbs.join(" vs ")}`);
  }

  const cycle = graphCycleError(
    [...taskSet].sort((left, right) => left.localeCompare(right)),
    plan.tasks.flatMap((task) => task.dependsOn.map((dep) => ({ from: dep, to: task.id })))
  );
  if (cycle) {
    errors.push(cycle);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function topologicalLayers(plan: GlobalPlan): string[][] {
  const taskById = new Map(plan.tasks.map((task) => [task.id, task] as const));
  const indegree = new Map<string, number>(plan.tasks.map((task) => [task.id, task.dependsOn.length]));
  const outgoing = new Map<string, string[]>(plan.tasks.map((task) => [task.id, []]));

  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      const existing = outgoing.get(dep) ?? [];
      existing.push(task.id);
      outgoing.set(dep, existing);
    }
  }

  for (const [taskId, edges] of outgoing.entries()) {
    outgoing.set(taskId, edges.sort((left, right) => left.localeCompare(right)));
  }

  const remaining = new Set(plan.tasks.map((task) => task.id));
  const layers: string[][] = [];

  while (remaining.size > 0) {
    const layer = [...remaining]
      .filter((taskId) => (indegree.get(taskId) ?? 0) === 0)
      .sort((left, right) => left.localeCompare(right));

    if (layer.length === 0) {
      throw new Error("Cycle detected in global plan");
    }

    for (const taskId of layer) {
      remaining.delete(taskId);
      const next = outgoing.get(taskId) ?? [];
      for (const target of next) {
        indegree.set(target, (indegree.get(target) ?? 0) - 1);
      }
    }

    layers.push(layer);
  }

  if (layers.flat().length !== taskById.size) {
    throw new Error("Topological ordering failed to include all tasks");
  }

  return layers;
}

export function orderPlan(plan: GlobalPlan): ExecutionOrder {
  const validation = validateGlobalPlan(plan);
  if (!validation.valid) {
    throw new Error(`Global plan validation failed: ${validation.errors.join("; ")}`);
  }

  const layers = topologicalLayers(plan);
  const orderedTaskIds = layers.flat();
  const taskMap = new Map(plan.tasks.map((task) => [task.id, task] as const));

  return {
    orderedTaskIds,
    tasks: orderedTaskIds.map((taskId) => taskMap.get(taskId)).filter((task): task is GlobalPlanTask => Boolean(task)),
  };
}

export function batchTasks(plan: GlobalPlan): TaskBatch[] {
  const layers = topologicalLayers(plan);
  const taskMap = new Map(plan.tasks.map((task) => [task.id, task] as const));

  return layers.map((layer, index) => ({
    id: `batch-${String(index + 1).padStart(2, "0")}`,
    taskIds: [...layer],
    tasks: layer.map((taskId) => taskMap.get(taskId)).filter((task): task is GlobalPlanTask => Boolean(task)),
  }));
}

function flattenPolicies(policies: CompiledPolicy[]): GlobalPolicyRule[] {
  return policies
    .flatMap((policy) => policy.rules)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function taskMapByRepo(plan: GlobalPlan): Map<string, GlobalPlanTask[]> {
  const map = new Map<string, GlobalPlanTask[]>();
  for (const task of plan.tasks) {
    const existing = map.get(task.repoId) ?? [];
    existing.push(task);
    map.set(task.repoId, existing);
  }

  for (const [repoId, tasks] of map.entries()) {
    map.set(repoId, tasks.sort((left, right) => left.id.localeCompare(right.id)));
  }

  return map;
}

function repoSetFromRule(rule: GlobalPolicyRule): Set<string> | null {
  if ("repoIds" in rule && Array.isArray(rule.repoIds) && rule.repoIds.length > 0) {
    return new Set(sortedUnique(rule.repoIds));
  }

  return null;
}

function evaluateRule(
  rule: GlobalPolicyRule,
  plan: GlobalPlan,
  repos: Repo[],
  byRepo: Map<string, GlobalPlanTask[]>
): string[] {
  const scopedRepos = repoSetFromRule(rule);
  const violations: string[] = [];

  if (rule.kind === "deny-action-prefix") {
    for (const task of plan.tasks) {
      if (scopedRepos && !scopedRepos.has(task.repoId)) {
        continue;
      }

      if (task.action.startsWith(rule.actionPrefix)) {
        violations.push(`Rule ${rule.id}: denied action prefix '${rule.actionPrefix}' on ${task.id}`);
      }
    }
    return violations;
  }

  if (rule.kind === "require-repo-action-prefix") {
    const repoIds = scopedRepos
      ? [...scopedRepos].sort((left, right) => left.localeCompare(right))
      : repos.map((repo) => repo.id).sort((left, right) => left.localeCompare(right));

    for (const repoId of repoIds) {
      const tasks = byRepo.get(repoId) ?? [];
      const matched = tasks.some((task) => task.action.startsWith(rule.actionPrefix));
      if (!matched) {
        violations.push(`Rule ${rule.id}: repo ${repoId} missing required action prefix '${rule.actionPrefix}'`);
      }
    }

    return violations;
  }

  if (rule.kind === "cross-repo-action-compatibility") {
    const byRepoId = new Map(repos.map((repo) => [repo.id, repo] as const));
    for (const repo of [...repos].sort((left, right) => left.id.localeCompare(right.id))) {
      const currentTasks = byRepo.get(repo.id) ?? [];
      const hasDownstreamAdaptation = currentTasks.some((task) => task.action.startsWith(rule.downstreamPrefix));

      for (const depRepoId of repo.dependencies) {
        const depRepo = byRepoId.get(depRepoId);
        if (!depRepo) {
          continue;
        }

        const upstreamTasks = byRepo.get(depRepo.id) ?? [];
        const hasUpstreamBreakingChange = upstreamTasks.some((task) => task.action.startsWith(rule.upstreamPrefix));
        if (hasUpstreamBreakingChange && !hasDownstreamAdaptation) {
          violations.push(
            `Rule ${rule.id}: ${repo.id} depends on ${depRepo.id} upstream change '${rule.upstreamPrefix}' without downstream '${rule.downstreamPrefix}'`
          );
        }
      }
    }
    return violations;
  }

  if (rule.kind === "require-state-path") {
    const repoIds = scopedRepos
      ? [...scopedRepos].sort((left, right) => left.localeCompare(right))
      : repos.map((repo) => repo.id).sort((left, right) => left.localeCompare(right));
    const repoMap = new Map(repos.map((repo) => [repo.id, repo] as const));

    for (const repoId of repoIds) {
      const repo = repoMap.get(repoId);
      if (!repo) {
        continue;
      }

      const value = getAtPath(repo.state, rule.path);
      if (!value.exists) {
        violations.push(`Rule ${rule.id}: repo ${repo.id} missing required state path '${rule.path}'`);
      }
    }
    return violations;
  }

  return violations;
}

export function evaluateGlobalPolicies(plan: GlobalPlan, policies: GlobalPolicyRule[], repos: Repo[]): PolicyResult {
  const orderedRules = [...policies].sort((left, right) => left.id.localeCompare(right.id));
  const byRepo = taskMapByRepo(plan);
  const decisions: string[] = [];
  const violations: string[] = [];
  const appliedPolicyIds: string[] = [];
  let requiresApproval = false;
  let denied = false;

  for (const rule of orderedRules) {
    appliedPolicyIds.push(rule.id);
    const ruleViolations = evaluateRule(rule, plan, repos, byRepo);

    if (ruleViolations.length === 0) {
      decisions.push(`allow:${rule.id}`);
      continue;
    }

    violations.push(...ruleViolations);
    if (rule.effect === "deny") {
      denied = true;
      decisions.push(`deny:${rule.id}`);
      continue;
    }

    if (rule.effect === "require-approval") {
      requiresApproval = true;
      decisions.push(`require-approval:${rule.id}`);
      continue;
    }

    decisions.push(`allow-with-violation:${rule.id}`);
  }

  return {
    allowed: !denied && !requiresApproval,
    requiresApproval,
    violations: sortedUnique(violations),
    policyDecisions: decisions,
    appliedPolicyIds: sortedUnique(appliedPolicyIds),
  };
}

export function blockGlobalExecution(policyResult: PolicyResult): never {
  throw new Error(
    `Global execution blocked: ${policyResult.policyDecisions.join(", ")} :: ${policyResult.violations.join("; ")}`
  );
}

export function propagatePolicies(orgPolicies: OrgPolicy[], repos: Repo[]): PolicyDistribution {
  const orderedRepos = [...repos].map((repo) => normalizeRepo(repo)).sort((left, right) => left.id.localeCompare(right.id));
  const orderedPolicies = [...orgPolicies].sort((left, right) => left.id.localeCompare(right.id));

  const allRules = orderedPolicies.flatMap((policy) =>
    [...policy.rules].sort((left, right) => left.id.localeCompare(right.id))
  );

  const compiledOrgPolicies = orderedPolicies.map((policy) => ({
    id: policy.id,
    source: "org" as const,
    rules: [...policy.rules].sort((left, right) => left.id.localeCompare(right.id)),
  } satisfies CompiledPolicy));

  const byRepo = Object.fromEntries(
    orderedRepos.map((repo) => [repo.id, cloneUnknown(compiledOrgPolicies)])
  ) as Record<string, CompiledPolicy[]>;

  return {
    propagation: {
      source: "org",
      targets: orderedRepos.map((repo) => repo.id),
      rules: allRules,
    },
    byRepo,
  };
}

export function detectPolicyDrift(repo: Repo, orgPolicies: OrgPolicy[]): DriftResult {
  const violations: string[] = [];
  const sortedPolicies = [...orgPolicies].sort((left, right) => left.id.localeCompare(right.id));

  for (const policy of sortedPolicies) {
    for (const rule of [...policy.rules].sort((left, right) => left.id.localeCompare(right.id))) {
      if (rule.kind !== "require-state-path") {
        continue;
      }

      const repoSet = repoSetFromRule(rule);
      if (repoSet && !repoSet.has(repo.id)) {
        continue;
      }

      const value = getAtPath(repo.state, rule.path);
      if (!value.exists) {
        violations.push(`Drift: repo ${repo.id} missing required path '${rule.path}' from policy ${policy.id}:${rule.id}`);
      }
    }
  }

  return {
    repoId: repo.id,
    driftDetected: violations.length > 0,
    violations,
  };
}

export function createGlobalPlanningCache(): GlobalPlanningCache {
  return {
    graphByKey: new Map<string, GlobalDependencyGraph>(),
    planByKey: new Map<string, GlobalPlan>(),
  };
}

function globalPlanSignature(context: GlobalContext): string {
  return hashId("global-plan", {
    repos: context.repos.map((repo) => ({
      id: repo.id,
      dependencies: repo.dependencies,
      tasks: extractRepoTasks(repo).map((task) => ({
        id: task.id,
        action: task.action,
        dependsOn: task.dependsOn,
      })),
      stateHash: hashId("state", repo.state),
    })),
    policies: context.policies.map((policy) => ({
      id: policy.id,
      source: policy.source,
      ruleIds: policy.rules.map((rule) => rule.id),
    })),
    graph: context.graph,
  });
}

export function buildGlobalContext(
  repos: Repo[],
  policies: CompiledPolicy[],
  options?: {
    cache?: GlobalPlanningCache;
  }
): GlobalContext {
  const normalizedRepos = repos.map((repo) => normalizeRepo(repo)).sort((left, right) => left.id.localeCompare(right.id));
  const graph = buildGlobalDependencyGraph(normalizedRepos, options?.cache);
  const orderedPolicies = [...policies].sort((left, right) => left.id.localeCompare(right.id));

  return {
    repos: normalizedRepos,
    policies: orderedPolicies,
    graph,
  };
}

export function synthesizeGlobalPlan(
  context: GlobalContext,
  options?: {
    cache?: GlobalPlanningCache;
    previousPlan?: GlobalPlan;
  }
): GlobalPlan {
  const signature = globalPlanSignature(context);
  const cached = options?.cache?.planByKey.get(signature);
  if (cached) {
    return cloneUnknown(cached);
  }

  if (options?.previousPlan && options.previousPlan.id === signature) {
    return cloneUnknown(options.previousPlan);
  }

  const byRepoId = new Map(context.repos.map((repo) => [repo.id, repo] as const));
  const extractedByRepo = new Map(context.repos.map((repo) => [repo.id, extractRepoTasks(repo)] as const));
  const taskMap = new Map<string, GlobalPlanTask>();

  for (const repo of context.repos) {
    const tasks = extractedByRepo.get(repo.id) ?? [];
    for (const task of tasks) {
      const id = globalTaskId(repo.id, task.id);
      const dependsOn = sortedUnique(task.dependsOn.map((dep) => globalTaskId(repo.id, dep)));
      taskMap.set(id, {
        id,
        repoId: repo.id,
        action: task.action,
        dependsOn,
      });
    }
  }

  for (const edge of context.graph.edges) {
    const target = taskMap.get(edge.to);
    if (!target) {
      continue;
    }

    target.dependsOn = sortedUnique([...target.dependsOn, edge.from]);
    taskMap.set(target.id, target);
  }

  for (const [repoId, repo] of byRepoId.entries()) {
    for (const depRepoId of repo.dependencies) {
      const depTasks = extractedByRepo.get(depRepoId) ?? [];
      const currentTasks = extractedByRepo.get(repoId) ?? [];
      const currentRootIds = taskRoots(currentTasks).map((task) => globalTaskId(repoId, task.id));
      const depLeafIds = taskLeaves(depTasks).map((task) => globalTaskId(depRepoId, task.id));

      for (const rootId of currentRootIds) {
        const current = taskMap.get(rootId);
        if (!current) {
          continue;
        }

        current.dependsOn = sortedUnique([...current.dependsOn, ...depLeafIds]);
        taskMap.set(rootId, current);
      }
    }
  }

  const tasks = [...taskMap.values()]
    .map((task) => ({
      ...task,
      dependsOn: sortedUnique(task.dependsOn),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const plan: GlobalPlan = {
    id: signature,
    tasks,
  };

  const validation = validateGlobalPlan(plan);
  if (!validation.valid) {
    throw new Error(`Global plan synthesis failed: ${validation.errors.join("; ")}`);
  }

  options?.cache?.planByKey.set(signature, cloneUnknown(plan));
  return plan;
}

function defaultTaskExecutor(task: GlobalPlanTask, state: SystemState): SystemState {
  if (task.action.startsWith("set:")) {
    const payload = task.action.slice("set:".length).trim();
    const [path, valueRaw] = payload.split("=");
    if (!path || typeof valueRaw === "undefined") {
      return state;
    }

    const segments = path.split(".").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    if (segments.length === 0) {
      return state;
    }

    const next = cloneUnknown(state) as Record<string, unknown>;
    let cursor: Record<string, unknown> = next;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] as string;
      const existing = cursor[segment];
      if (!isRecord(existing)) {
        cursor[segment] = {};
      }
      cursor = cursor[segment] as Record<string, unknown>;
    }

    cursor[segments[segments.length - 1] as string] = valueRaw.trim();
    return next;
  }

  return cloneUnknown(state);
}

function rollbackAllRepos(snapshot: Record<string, SystemState>): Record<string, SystemState> {
  return cloneUnknown(snapshot);
}

export async function executeGlobalPlan(
  plan: GlobalPlan,
  options: ExecuteGlobalPlanOptions
): Promise<GlobalExecutionResult> {
  const normalizedRepos = options.repos.map((repo) => normalizeRepo(repo)).sort((left, right) => left.id.localeCompare(right.id));
  const simulation = await simulatePlan(plan, options);
  const simulationPolicy = simulation.policyDecisions[0];

  if (simulationPolicy && !simulationPolicy.allowed) {
    blockGlobalExecution(simulationPolicy);
  }

  if (!simulation.success) {
    const baseStates = stateForRepos(normalizedRepos);
    return {
      success: false,
      rolledBack: true,
      finalStates: rollbackAllRepos(baseStates),
      audit: {
        planId: plan.id,
        reposInvolved: normalizedRepos.map((repo) => repo.id),
        policiesApplied: simulationPolicy?.appliedPolicyIds ?? [],
        violations: sortedUnique([
          ...simulation.violations,
          "Execution blocked: simulation gate failed",
        ]),
      },
      trace: {
        plan,
        executionOrder: simulation.trace.stepsExecuted,
        policyDecisions: simulationPolicy?.policyDecisions ?? [],
        convergence: false,
      },
    };
  }

  const execution = await runGlobalPlanInternal(plan, options, "execution");
  const expectedState = simulation.finalState;
  const actualState = execution.finalStates;
  const equivalent = statesEqual(expectedState, actualState);

  if (!equivalent) {
    const rolledBackStates = rollbackAllRepos(execution.baseStates);
    return {
      success: false,
      rolledBack: true,
      finalStates: rolledBackStates,
      audit: {
        planId: plan.id,
        reposInvolved: normalizedRepos.map((repo) => repo.id),
        policiesApplied: execution.policyResult.appliedPolicyIds,
        violations: sortedUnique([
          ...execution.policyResult.violations,
          "Simulation and execution diverged",
        ]),
      },
      trace: {
        plan,
        executionOrder: execution.orderedTaskIds,
        policyDecisions: execution.policyResult.policyDecisions,
        convergence: false,
      },
    };
  }

  return {
    success: execution.success,
    rolledBack: execution.rolledBack,
    finalStates: cloneState(execution.finalStates),
    audit: {
      planId: plan.id,
      reposInvolved: normalizedRepos.map((repo) => repo.id),
      policiesApplied: execution.policyResult.appliedPolicyIds,
      violations: sortedUnique([...execution.policyResult.violations, ...execution.violations]),
    },
    trace: {
      plan: cloneUnknown(execution.plan),
      executionOrder: execution.orderedTaskIds,
      policyDecisions: execution.policyResult.policyDecisions,
      convergence: execution.success,
    },
  };
}
