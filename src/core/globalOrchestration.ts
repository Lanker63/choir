import {
  canonicalizeUnknown,
  cloneDeterministicContext,
  deterministicContextFromHash,
  deterministicHash,
  deterministicId,
  stableSortBy,
  stableSortStrings,
  stableStringify,
  type DeterministicContext,
} from "./deterministicCore.js";
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
  transactionTrace?: TransactionTrace;
  deterministicTrace?: DeterministicTrace;
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
  rollbackTrace?: RollbackTrace;
};

export type GlobalState = Record<string, SystemState>;

export type PolicyState = CompiledPolicy[];

export type ExecutionInput = {
  plan: GlobalPlan;
  state: GlobalState;
  policies: PolicyState;
  dependencyGraph: DependencyGraph;
};

export type ExecutionContext = {
  baseTimestamp: number;
  seed: number;
  logicalTime: number;
};

export type DeterministicOperation = {
  opId: string;
  type: string;
  target: string;
  action: string;
  stateAfter: SystemState;
  stateHashAfter: string;
};

export type DeterministicStageTrace = {
  stageId: string;
  unitOrder: string[];
  stateHashBefore: string;
  stateHashAfter: string;
  operations: DeterministicOperation[];
};

export type DeterministicTrace = {
  traceId: string;
  inputHash: string;
  context: ExecutionContext;
  initialState: GlobalState;
  stages: DeterministicStageTrace[];
  finalStateHash: string;
  deterministic: boolean;
};

export type TraceStore = {
  version: number;
  traces: ReadonlyMap<string, DeterministicTrace>;
};

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
  deterministicTrace?: DeterministicTrace;
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

export type Strategy = {
  id: string;
  plan: GlobalPlan;
};

export type EvaluatedStrategy = {
  strategyId: string;
  result: SimulationResult;
};

export type StrategyMetrics = {
  violations: number;
  risk: number;
  changes: number;
  executionCost: number;
};

export type ScoreWeights = {
  risk: number;
  changes: number;
  executionCost: number;
};

export type StrategyConfig = {
  allowViolations?: boolean;
  weights?: ScoreWeights;
  costModel?: CostModel;
};

export type RankedStrategy = EvaluatedStrategy & {
  metrics: StrategyMetrics;
  score: number | null;
};

export type StrategyDecision = {
  selected: string;
  ranking: {
    strategyId: string;
    metrics: StrategyMetrics;
  }[];
  reason: string;
};

export type StrategyTrace = {
  strategiesEvaluated: number;
  strategiesRejected: number;
  selectionTime: number;
};

export type StrategySelectionResult = {
  selected: RankedStrategy;
  ranking: RankedStrategy[];
  decision: StrategyDecision;
  trace: StrategyTrace;
};

export type RolloutStrategy =
  | { type: "all-at-once" }
  | { type: "canary"; initialPercent: number; steps: number[] }
  | { type: "phased"; phases: number[] }
  | { type: "batched"; batchSize: number };

export type Transaction = {
  id: string;
  stages: ExecutionStage[];
  status: "pending" | "committed" | "aborted";
  startedAt: number;
  committedAt?: number;
};

export type ExecutionFailure = {
  stageId: string;
  unitId: string;
  error: string;
  timestamp: number;
};

export type UnitExecutionState =
  | "pending"
  | "executed"
  | "failed"
  | "rolled-back";

export type ExecutionState = {
  units: Record<string, UnitExecutionState>;
};

export type DependencyGraph = {
  edges: {
    from: string;
    to: string;
  }[];
};

export type Snapshot = {
  unitId: string;
  state: SystemState;
  timestamp: number;
};

export type TransactionContext = {
  transactionId: string;
  workingState: GlobalState;
  baseState: GlobalState;
  snapshots: Map<string, Snapshot>;
  transaction: Transaction;
  compensations: CompensationAction[];
  context: DeterministicContext;
};

export type Change = {
  unitId: string;
  nextState: SystemState;
};

export type Compensation = {
  unitId: string;
  apply(): void;
};

export type CompensationAction = {
  unitId: string;
  undo(): void;
};

export type Lock = {
  unitId: string;
  transactionId: string;
  ownerToken: symbol;
};

export type RollbackTrace = {
  failedUnit: string;
  rollbackSet: string[];
  rollbackOrder: string[];
  duration: number;
};

export type TransactionTrace = {
  transactionId: string;
  stagesExecuted: string[];
  committed: boolean;
  duration: number;
};

export type TransactionBatch = {
  transactions: Transaction[];
};

export type ExecutionStage = {
  id: string;
  units: string[];
  percentage?: number;
  order: number;
};

export type StageMetrics = {
  errorRate: number;
  latency: number;
  violations: number;
};

export type RolloutConfig = {
  thresholds: {
    errorRate: number;
    latency: number;
  };
  autoRollback: boolean;
  stageApproval?: boolean;
  requireApproval?: (input: { planId: string; stageId?: string; previewHash: string }) => boolean | Promise<boolean>;
};

export type RolloutTrace = {
  stages: ExecutionStage[];
  completedStages: string[];
  failedStage?: string;
  metrics: Record<string, StageMetrics>;
  rollbackTraces: RollbackTrace[];
  transactionTraces: TransactionTrace[];
  deterministicTraces: DeterministicTrace[];
  canResume?: boolean;
};

export type RolloutValidationResult = {
  valid: boolean;
  errors: string[];
};

export type StageExecutionResult = {
  stage: ExecutionStage;
  success: boolean;
  violations: string[];
  metrics: StageMetrics;
  unitsAffected: string[];
  finalStates: GlobalState;
  executionState: ExecutionState;
  transactionTrace?: TransactionTrace;
  deterministicTrace?: DeterministicTrace;
  failure?: ExecutionFailure;
};

export type TransactionExecutionResult = {
  success: boolean;
  finalState: GlobalState;
  baseState: GlobalState;
  policyResult: PolicyResult;
  orderedTaskIds: string[];
  plan: GlobalPlan;
  violations: string[];
  stepsExecuted: string[];
  unitsAffected: string[];
  executionState: ExecutionState;
  failure?: ExecutionFailure;
  transaction: Transaction;
  trace: TransactionTrace;
  deterministicTrace: DeterministicTrace;
};

export type RolloutExecutionResult = {
  success: boolean;
  stopped: boolean;
  rolledBack: boolean;
  finalStates: GlobalState;
  trace: RolloutTrace;
  failures: string[];
};

export type ComparisonResult = {
  bestStrategy: string;
  metrics: {
    risk: number;
    changes: number;
    violations: number;
  };
  ranking: {
    strategyId: string;
    metrics: StrategyMetrics;
    score: number | null;
  }[];
  decision: StrategyDecision;
  trace: StrategyTrace;
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
  executionState: ExecutionState;
  transaction: Transaction;
  transactionTrace: TransactionTrace;
  deterministicTrace: DeterministicTrace;
  failure?: ExecutionFailure;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableSortUnknown(value: unknown): unknown {
  return canonicalizeUnknown(value);
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
  return stableSortStrings(Array.from(new Set(values)));
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    ordered.push(value);
  }

  return ordered;
}

export function deterministicSort(items: string[]): string[] {
  return stableSortStrings(items);
}

function normalizePlan(plan: GlobalPlan): GlobalPlan {
  return {
    id: plan.id,
    tasks: [...plan.tasks]
      .map((task) => ({
        ...task,
        dependsOn: deterministicSort(task.dependsOn),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function normalizeDependencyGraph(graph: DependencyGraph): DependencyGraph {
  return {
    edges: [...graph.edges]
      .map((edge) => ({ from: edge.from, to: edge.to }))
      .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)),
  };
}

function normalizePolicies(policies: PolicyState): PolicyState {
  return [...policies]
    .map((policy) => ({
      id: policy.id,
      source: policy.source,
      rules: [...cloneUnknown(policy.rules)].sort((left, right) => left.id.localeCompare(right.id)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id) || left.source.localeCompare(right.source));
}

function normalizeExecutionInput(input: ExecutionInput): ExecutionInput {
  return {
    plan: normalizePlan(input.plan),
    state: stableSortUnknown(cloneState(input.state)) as GlobalState,
    policies: normalizePolicies(input.policies),
    dependencyGraph: normalizeDependencyGraph(input.dependencyGraph),
  };
}

export function hashState(state: GlobalState): string {
  return deterministicHash(stableSortUnknown(state));
}

export function hashInput(input: ExecutionInput): string {
  const normalized = normalizeExecutionInput(input);
  return deterministicHash(normalized);
}

function executionContextFromInputHash(inputHash: string): ExecutionContext {
  return deterministicContextFromHash(inputHash);
}

let traceStore: TraceStore = {
  version: 1,
  traces: new Map<string, DeterministicTrace>(),
};

export function getTraceStore(): TraceStore {
  return {
    version: traceStore.version,
    traces: new Map(traceStore.traces),
  };
}

export function appendTrace(store: TraceStore, trace: DeterministicTrace): TraceStore {
  const existing = store.traces.get(trace.traceId);
  if (existing) {
    if (stableStringify(existing) === stableStringify(trace)) {
      return store;
    }

    throw new Error(`Trace append rejected: trace ${trace.traceId} already exists with different content`);
  }

  const nextTraces = new Map(store.traces);
  nextTraces.set(trace.traceId, cloneUnknown(trace));
  return {
    version: store.version + 1,
    traces: nextTraces,
  };
}

function recordDeterministicTrace(trace: DeterministicTrace): void {
  traceStore = appendTrace(traceStore, trace);
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

function stateDiffUnits(left: GlobalState, right: GlobalState): string[] {
  const units = sortedUnique([...Object.keys(left), ...Object.keys(right)]);
  return units.filter((unit) => stableStringify(left[unit]) !== stableStringify(right[unit]));
}

function createExecutionState(units: string[]): ExecutionState {
  return {
    units: Object.fromEntries(
      sortedUnique(units).map((unit) => [unit, "pending" satisfies UnitExecutionState] as const)
    ),
  };
}

function cloneExecutionState(state: ExecutionState): ExecutionState {
  return {
    units: {
      ...state.units,
    },
  };
}

function setUnitExecutionState(state: ExecutionState, unitId: string, value: UnitExecutionState): void {
  state.units[unitId] = value;
}

const transactionLocks = new Map<string, Lock>();

export function sortStages(stages: ExecutionStage[]): ExecutionStage[] {
  return stableSortBy(stages, (stage) =>
    `${stage.order.toString().padStart(8, "0")}:${stage.id}:${stableStringify(stage.units)}`
  ).sort((left, right) =>
    left.order - right.order
    || left.id.localeCompare(right.id)
    || stableStringify(left.units).localeCompare(stableStringify(right.units))
  );
}

function nextDeterministicTimestamp(ctx: TransactionContext): number {
  ctx.context.logicalTime += 1;
  return ctx.context.baseTimestamp + ctx.context.logicalTime;
}

function createTransaction(baseState: GlobalState, stages: ExecutionStage[], context: DeterministicContext): Transaction {
  const orderedStages = sortStages(stages);
  const id = hashId("transaction", {
    stages: orderedStages.map((stage) => ({
      id: stage.id,
      order: stage.order,
      units: sortedUnique(stage.units),
      percentage: stage.percentage,
    })),
    baseState,
  });

  return {
    id,
    stages: orderedStages,
    status: "pending",
    startedAt: context.baseTimestamp,
  };
}

export function beginTransaction(
  state: GlobalState,
  stages: ExecutionStage[] = [],
  context?: ExecutionContext
): TransactionContext {
  const baseState = cloneState(state);
  const deterministicContext = context
    ? cloneDeterministicContext(context)
    : deterministicContextFromHash(hashState(baseState));
  const transaction = createTransaction(baseState, stages, deterministicContext);
  return {
    transactionId: transaction.id,
    workingState: cloneState(baseState),
    baseState,
    snapshots: new Map<string, Snapshot>(),
    transaction,
    compensations: [],
    context: deterministicContext,
  };
}

function applyGlobalState(state: GlobalState): GlobalState {
  return cloneState(state);
}

export function commitTransaction(ctx: TransactionContext): void {
  ctx.workingState = applyGlobalState(ctx.workingState);
  ctx.transaction.status = "committed";
  ctx.transaction.committedAt = nextDeterministicTimestamp(ctx);
}

function runCompensations(ctx: TransactionContext): void {
  for (let index = ctx.compensations.length - 1; index >= 0; index -= 1) {
    ctx.compensations[index]?.undo();
  }
}

export function abortTransaction(ctx: TransactionContext): void {
  runCompensations(ctx);
  ctx.workingState = cloneState(ctx.baseState);
  ctx.transaction.status = "aborted";
}

function setTransactionUnitState(ctx: TransactionContext, unitId: string, nextState: SystemState): void {
  ctx.workingState[unitId] = cloneUnknown(nextState);
}

export function snapshotUnit(ctx: TransactionContext, unitId: string): void {
  if (ctx.snapshots.has(unitId)) {
    return;
  }

  ctx.snapshots.set(unitId, {
    unitId,
    state: cloneUnknown(ctx.workingState[unitId] ?? {}),
    timestamp: nextDeterministicTimestamp(ctx),
  });
}

export function applyChange(ctx: TransactionContext, change: Change): void {
  snapshotUnit(ctx, change.unitId);
  setTransactionUnitState(ctx, change.unitId, change.nextState);
}

export function registerCompensationAction(ctx: TransactionContext, action: CompensationAction): void {
  ctx.compensations.push(action);
}

type TransactionValidationInput = {
  repos?: Repo[];
  graph?: DependencyGraph;
  executionState?: ExecutionState;
  policyResult?: PolicyResult;
  violations?: string[];
};

export function validateTransaction(ctx: TransactionContext, input?: TransactionValidationInput): RolloutValidationResult {
  const errors: string[] = [];

  if (input?.policyResult) {
    if (!input.policyResult.allowed) {
      errors.push("Transaction validation failed: policy denied execution");
    }

    errors.push(...input.policyResult.violations);
  }

  if (input?.graph && input.executionState) {
    const dependencyValidation = validatePostRollback(ctx.workingState, input.graph, input.executionState, input.repos);
    errors.push(...dependencyValidation.errors);
  }

  const consistency = validateGlobalConsistency(ctx.workingState, input?.repos);
  errors.push(...consistency.errors);
  errors.push(...(input?.violations ?? []));

  return {
    valid: errors.length === 0,
    errors: sortedUnique(errors),
  };
}

export function preparePhase(ctx: TransactionContext, input?: TransactionValidationInput): RolloutValidationResult {
  return validateTransaction(ctx, input);
}

export function commitPhase(ctx: TransactionContext): void {
  commitTransaction(ctx);
}

function acquireLocks(ownerToken: symbol, transactionId: string, units: string[]): RolloutValidationResult {
  const errors: string[] = [];
  const uniqueUnits = sortedUnique(units);

  for (const unit of uniqueUnits) {
    const existing = transactionLocks.get(unit);
    if (existing && existing.ownerToken !== ownerToken) {
      errors.push(`Lock conflict: unit ${unit} is held by transaction ${existing.transactionId}`);
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors: sortedUnique(errors),
    };
  }

  for (const unit of uniqueUnits) {
    transactionLocks.set(unit, {
      unitId: unit,
      transactionId,
      ownerToken,
    });
  }

  return {
    valid: true,
    errors: [],
  };
}

function releaseLocks(ownerToken: symbol): void {
  for (const [unit, lock] of transactionLocks.entries()) {
    if (lock.ownerToken === ownerToken) {
      transactionLocks.delete(unit);
    }
  }
}

export function buildRollbackDependencyGraph(plan: GlobalPlan): DependencyGraph {
  const dependencies = buildUnitDependencies(plan);
  const edges = [...dependencies.entries()]
    .flatMap(([unit, unitDeps]) => [...unitDeps].map((dependency) => ({ from: dependency, to: unit })))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));

  return {
    edges,
  };
}

function graphAdjacencyBySource(graph: DependencyGraph): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const current = map.get(edge.from) ?? [];
    current.push(edge.to);
    map.set(edge.from, sortedUnique(current));
    if (!map.has(edge.to)) {
      map.set(edge.to, []);
    }
  }

  return map;
}

export function computeRollbackSet(
  failedUnit: string,
  graph: DependencyGraph,
  state: ExecutionState
): string[] {
  const adjacency = graphAdjacencyBySource(graph);
  const rollbackSet = new Set<string>([failedUnit]);
  const queue: string[] = [failedUnit];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const dependents = adjacency.get(current) ?? [];
    for (const dependent of dependents) {
      if (rollbackSet.has(dependent)) {
        continue;
      }

      if (state.units[dependent] !== "executed") {
        continue;
      }

      rollbackSet.add(dependent);
      queue.push(dependent);
      queue.sort((left, right) => left.localeCompare(right));
    }
  }

  return sortedUnique([...rollbackSet]);
}

export function orderRollback(units: string[], graph: DependencyGraph): string[] {
  const selected = new Set(sortedUnique(units));
  const indegree = new Map<string, number>([...selected].map((unit) => [unit, 0] as const));
  const outgoing = new Map<string, string[]>([...selected].map((unit) => [unit, []] as const));

  for (const edge of graph.edges) {
    if (!selected.has(edge.from) || !selected.has(edge.to)) {
      continue;
    }

    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    const current = outgoing.get(edge.from) ?? [];
    current.push(edge.to);
    outgoing.set(edge.from, sortedUnique(current));
  }

  const ready = [...selected].filter((unit) => (indegree.get(unit) ?? 0) === 0).sort((left, right) => left.localeCompare(right));
  const topological: string[] = [];

  while (ready.length > 0) {
    const unit = ready.shift() as string;
    topological.push(unit);

    const nextUnits = outgoing.get(unit) ?? [];
    for (const nextUnit of nextUnits) {
      const nextInDegree = (indegree.get(nextUnit) ?? 0) - 1;
      indegree.set(nextUnit, nextInDegree);
      if (nextInDegree === 0) {
        ready.push(nextUnit);
        ready.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  if (topological.length !== selected.size) {
    throw new Error("Rollback ordering failed: dependency cycle detected");
  }

  return [...topological].reverse();
}

export function validateIsolation(
  rollbackSet: string[],
  graph: DependencyGraph,
  failedUnit?: string
): RolloutValidationResult {
  const errors: string[] = [];
  const unique = sortedUnique(rollbackSet);

  if (unique.length !== rollbackSet.length) {
    errors.push("Rollback set contains duplicate units");
  }

  if (!failedUnit) {
    return {
      valid: errors.length === 0,
      errors: sortedUnique(errors),
    };
  }

  const adjacency = graphAdjacencyBySource(graph);
  const reachable = new Set<string>([failedUnit]);
  const queue: string[] = [failedUnit];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const dependents = adjacency.get(current) ?? [];
    for (const dependent of dependents) {
      if (reachable.has(dependent)) {
        continue;
      }

      reachable.add(dependent);
      queue.push(dependent);
      queue.sort((left, right) => left.localeCompare(right));
    }
  }

  for (const unit of unique) {
    if (!reachable.has(unit)) {
      errors.push(`Isolation violation: rollback set contains unrelated unit ${unit}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors: sortedUnique(errors),
  };
}

function snapshotUnits(state: GlobalState, units: string[], timestamp: number): Snapshot[] {
  return sortedUnique(units).map((unitId) => ({
    unitId,
    state: cloneUnknown(state[unitId] ?? {}),
    timestamp,
  }));
}

function toSnapshotMap(snapshots: Snapshot[]): Map<string, Snapshot> {
  return new Map(snapshots.map((snapshot) => [snapshot.unitId, snapshot] as const));
}

export function rollbackToSnapshot(
  unitId: string,
  snapshots: Map<string, Snapshot>,
  currentState: GlobalState
): boolean {
  const snapshot = snapshots.get(unitId);
  if (!snapshot) {
    return false;
  }

  currentState[unitId] = cloneUnknown(snapshot.state);
  return true;
}

function buildCompensations(
  units: string[],
  stableState: GlobalState,
  stateRef: { current: GlobalState }
): Compensation[] {
  return sortedUnique(units).map((unitId) => ({
    unitId,
    apply: () => {
      stateRef.current[unitId] = cloneUnknown(stableState[unitId] ?? {});
    },
  }));
}

export async function rollbackUnits(
  units: string[],
  graph: DependencyGraph,
  currentState: GlobalState,
  snapshots: Snapshot[],
  compensations: Compensation[] = []
): Promise<{ state: GlobalState; rollbackOrder: string[] }> {
  const ordered = orderRollback(units, graph);
  const stateRef = { current: currentState };
  const snapshotMap = toSnapshotMap(snapshots);
  const compensationMap = new Map(compensations.map((entry) => [entry.unitId, entry] as const));

  for (const unit of ordered) {
    const restored = rollbackToSnapshot(unit, snapshotMap, stateRef.current);
    if (restored) {
      continue;
    }

    const compensation = compensationMap.get(unit);
    compensation?.apply();
  }

  return {
    state: cloneState(stateRef.current),
    rollbackOrder: ordered,
  };
}

function mergeRollbackSets(primaryFailedUnit: string, graph: DependencyGraph, state: ExecutionState, additionalUnits?: string[]): string[] {
  const rollback = new Set(computeRollbackSet(primaryFailedUnit, graph, state));
  for (const unit of additionalUnits ?? []) {
    rollback.add(unit);
  }

  return sortedUnique([...rollback]);
}

function markUnitsRolledBack(executionState: ExecutionState, units: string[]): ExecutionState {
  const next = cloneExecutionState(executionState);
  for (const unit of units) {
    next.units[unit] = "rolled-back";
  }

  return next;
}

function hasPath(from: string, to: string, graph: DependencyGraph): boolean {
  if (from === to) {
    return true;
  }

  const adjacency = graphAdjacencyBySource(graph);
  const visited = new Set<string>();
  const queue: string[] = [from];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (visited.has(current)) {
      continue;
    }

    visited.add(current);
    const dependents = adjacency.get(current) ?? [];
    for (const dependent of dependents) {
      if (dependent === to) {
        return true;
      }

      if (!visited.has(dependent)) {
        queue.push(dependent);
      }
    }
  }

  return false;
}

function canResumeAfterRollback(rollbackSet: string[], remainingUnits: string[], graph: DependencyGraph): boolean {
  if (remainingUnits.length === 0) {
    return false;
  }

  for (const unit of remainingUnits) {
    for (const rolledBack of rollbackSet) {
      if (hasPath(rolledBack, unit, graph)) {
        return false;
      }
    }
  }

  return true;
}

export function validatePostRollback(
  state: GlobalState,
  graph: DependencyGraph,
  executionState: ExecutionState,
  repos?: Repo[]
): RolloutValidationResult {
  const errors: string[] = [];

  for (const unit of Object.keys(executionState.units).sort((left, right) => left.localeCompare(right))) {
    if (!Object.prototype.hasOwnProperty.call(state, unit)) {
      errors.push(`Post-rollback state missing unit ${unit}`);
    }
  }

  for (const edge of graph.edges) {
    const dependentState = executionState.units[edge.to];
    const dependencyState = executionState.units[edge.from];
    if (dependentState !== "executed") {
      continue;
    }

    if (dependencyState !== "executed") {
      errors.push(`Post-rollback dependency violation: ${edge.to} executed while ${edge.from} is ${dependencyState ?? "pending"}`);
    }
  }

  const consistency = validateGlobalConsistency(state, repos);
  errors.push(...consistency.errors);

  return {
    valid: errors.length === 0,
    errors: sortedUnique(errors),
  };
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

function executionStagesFromBatches(batches: TaskBatch[]): ExecutionStage[] {
  const total = Math.max(1, batches.length);
  return batches.map((batch, index) => ({
    id: batch.id,
    units: sortedUnique(batch.tasks.map((task) => task.repoId)),
    percentage: Math.round(((index + 1) / total) * 100),
    order: index + 1,
  }));
}

function buildTransactionTrace(ctx: TransactionContext, stagesExecuted: string[]): TransactionTrace {
  const endTimestamp = ctx.transaction.committedAt ?? (ctx.context.baseTimestamp + ctx.context.logicalTime);
  return {
    transactionId: ctx.transactionId,
    stagesExecuted: uniqueInOrder(stagesExecuted),
    committed: ctx.transaction.status === "committed",
    duration: Math.max(0, endTimestamp - ctx.transaction.startedAt),
  };
}

export async function executeTransaction(
  plan: GlobalPlan,
  options: ExecuteGlobalPlanOptions,
  mode: "simulation" | "execution" = "execution",
  units?: string[]
): Promise<TransactionExecutionResult> {
  const validation = validateGlobalPlan(plan);
  if (!validation.valid) {
    const normalizedRepos = options.repos.map((repo) => normalizeRepo(repo)).sort((left, right) => left.id.localeCompare(right.id));
    const baseState = stateForRepos(normalizedRepos);
    const executionState = createExecutionState(Object.keys(baseState));
    const input: ExecutionInput = {
      plan: normalizePlan(plan),
      state: cloneState(baseState),
      policies: normalizePolicies(options.policies),
      dependencyGraph: buildRollbackDependencyGraph(plan),
    };
    const inputHash = hashInput(input);
    const context = executionContextFromInputHash(inputHash);
    const tx = beginTransaction(baseState, [], context);
    abortTransaction(tx);
    const deterministicTrace: DeterministicTrace = {
      traceId: deterministicTraceId(inputHash, [], hashState(baseState)),
      inputHash,
      context,
      initialState: cloneState(baseState),
      stages: [],
      finalStateHash: hashState(baseState),
      deterministic: true,
    };
    deterministicTrace.deterministic = validateTrace(deterministicTrace) && verifyReplay(deterministicTrace);
    recordDeterministicTrace(deterministicTrace);
    const policyResult = {
      allowed: false,
      requiresApproval: false,
      violations: validation.errors,
      policyDecisions: ["deny:plan-validation"],
      appliedPolicyIds: [],
    } satisfies PolicyResult;

    return {
      success: false,
      finalState: cloneState(baseState),
      baseState: cloneState(baseState),
      policyResult,
      orderedTaskIds: [],
      plan,
      violations: validation.errors,
      stepsExecuted: [],
      unitsAffected: [],
      executionState,
      transaction: cloneUnknown(tx.transaction),
      trace: buildTransactionTrace(tx, []),
      deterministicTrace,
    };
  }

  const normalizedRepos = options.repos.map((repo) => normalizeRepo(repo)).sort((left, right) => left.id.localeCompare(right.id));
  const effectivePlan = units && units.length > 0 ? filterPlanForUnits(plan, units) : cloneUnknown(plan);
  const policyResult = evaluateGlobalPolicies(effectivePlan, flattenPolicies(options.policies), normalizedRepos);
  const ordered = orderPlan(effectivePlan);
  const batches = batchTasks(effectivePlan);
  const stages = executionStagesFromBatches(batches);
  const batchById = new Map(batches.map((batch) => [batch.id, batch] as const));

  const baseState = stateForRepos(normalizedRepos);
  const validateState = options.validateState ?? (() => true);
  const executeTask = options.executeTask ?? (async (task, state) => defaultTaskExecutor(task, state));
  const executionState = createExecutionState(normalizedRepos.map((repo) => repo.id));
  const deterministicInput: ExecutionInput = {
    plan: normalizePlan(effectivePlan),
    state: cloneState(baseState),
    policies: normalizePolicies(options.policies),
    dependencyGraph: buildRollbackDependencyGraph(effectivePlan),
  };
  const deterministicInputHash = hashInput(deterministicInput);
  const deterministicContext = executionContextFromInputHash(deterministicInputHash);
  const tx = beginTransaction(baseState, stages, deterministicContext);
  const shouldLock = mode === "execution";
  const lockOwnerToken = shouldLock ? Symbol(tx.transactionId) : undefined;
  const lockUnits = sortedUnique(effectivePlan.tasks.map((task) => task.repoId));
  const stepsExecuted: string[] = [];
  const unitsAffected = new Set<string>();
  const committedStages: string[] = [];
  const taskById = new Map(effectivePlan.tasks.map((task) => [task.id, task] as const));
  const deterministicStages: DeterministicStageTrace[] = [];
  let expectedStageBeforeHash = hashState(baseState);

  const finalizeDeterministicTrace = (currentState: GlobalState, deterministicHint: boolean): DeterministicTrace => {
    const finalStateHash = hashState(currentState);
    const trace: DeterministicTrace = {
      traceId: deterministicTraceId(deterministicInputHash, deterministicStages, finalStateHash),
      inputHash: deterministicInputHash,
      context: deterministicContext,
      initialState: cloneState(baseState),
      stages: cloneUnknown(deterministicStages),
      finalStateHash,
      deterministic: false,
    };

    const valid = validateTrace(trace);
    const replayVerified = valid ? verifyReplay(trace) : false;
    trace.deterministic = deterministicHint && valid && replayVerified;
    recordDeterministicTrace(trace);
    return trace;
  };

  if (shouldLock && lockOwnerToken) {
    const lockResult = acquireLocks(lockOwnerToken, tx.transactionId, lockUnits);
    if (!lockResult.valid) {
      abortTransaction(tx);
      const deterministicTrace = finalizeDeterministicTrace(tx.workingState, false);
      return {
        success: false,
        finalState: cloneState(tx.workingState),
        baseState: cloneState(baseState),
        policyResult,
        orderedTaskIds: ordered.orderedTaskIds,
        plan: effectivePlan,
        violations: sortedUnique([...policyResult.violations, ...lockResult.errors]),
        stepsExecuted,
        unitsAffected: [],
        executionState,
        transaction: cloneUnknown(tx.transaction),
        trace: buildTransactionTrace(tx, committedStages),
        deterministicTrace,
        failure: {
          stageId: "transaction:lock",
          unitId: lockUnits[0] ?? "workspace:root",
          error: lockResult.errors.join("; "),
          timestamp: nextDeterministicTimestamp(tx),
        },
      };
    }
  }

  if (!policyResult.allowed) {
    abortTransaction(tx);
    if (lockOwnerToken) {
      releaseLocks(lockOwnerToken);
    }
    const deterministicTrace = finalizeDeterministicTrace(tx.workingState, true);
    return {
      success: false,
      finalState: cloneState(tx.workingState),
      baseState: cloneState(baseState),
      policyResult,
      orderedTaskIds: ordered.orderedTaskIds,
      plan: effectivePlan,
      violations: policyResult.violations,
      stepsExecuted,
      unitsAffected: [],
      executionState,
      transaction: cloneUnknown(tx.transaction),
      trace: buildTransactionTrace(tx, committedStages),
      deterministicTrace,
    };
  }

  try {
    for (const stage of sortStages(stages)) {
      const batch = batchById.get(stage.id);
      if (!batch) {
        continue;
      }

      const stageTx = beginTransaction(tx.workingState, [stage], tx.context);
      let activeTask: GlobalPlanTask | null = null;
      const stageBeforeHash = hashState(tx.workingState);
      assertDeterministic(
        stageBeforeHash === expectedStageBeforeHash,
        `stage ${stage.id} expected state hash ${expectedStageBeforeHash}, got ${stageBeforeHash}`
      );
      const stageOperations: DeterministicOperation[] = [];

      try {
        const sortedTasks = [...batch.tasks].sort((left, right) => left.id.localeCompare(right.id));
        for (const task of sortedTasks) {
          activeTask = task;
          const currentState = cloneUnknown(stageTx.workingState[task.repoId] ?? {});
          const allStates = cloneState(stageTx.workingState);
          const nextState = await executeTask(task, currentState, task.repoId, allStates, mode);
          const previousState = cloneUnknown(stageTx.workingState[task.repoId] ?? {});
          applyChange(stageTx, {
            unitId: task.repoId,
            nextState,
          });
          registerCompensationAction(stageTx, {
            unitId: task.repoId,
            undo: () => {
              setTransactionUnitState(stageTx, task.repoId, previousState);
            },
          });
          const stateAfter = cloneUnknown(stageTx.workingState[task.repoId] ?? {});
          stageOperations.push({
            opId: task.id,
            type: operationTypeFromAction(task.action),
            target: task.repoId,
            action: task.action,
            stateAfter,
            stateHashAfter: hashState({ [task.repoId]: stateAfter }),
          });
          stepsExecuted.push(task.id);
          unitsAffected.add(task.repoId);
          setUnitExecutionState(executionState, task.repoId, "executed");

          if (!validateState(stageTx.workingState[task.repoId], task.repoId)) {
            throw new Error(`State validation failed after task ${task.id}`);
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const failedUnit = activeTask?.repoId ?? stage.units[0] ?? normalizedRepos[0]?.id ?? "workspace:root";
        setUnitExecutionState(executionState, failedUnit, "failed");
        abortTransaction(stageTx);
        abortTransaction(tx);
        const deterministicTrace = finalizeDeterministicTrace(tx.workingState, true);
        return {
          success: false,
          finalState: cloneState(tx.workingState),
          baseState: cloneState(baseState),
          policyResult,
          orderedTaskIds: ordered.orderedTaskIds,
          plan: effectivePlan,
          violations: sortedUnique([...policyResult.violations, reason]),
          stepsExecuted,
          unitsAffected: sortedUnique([...unitsAffected]),
          executionState,
          transaction: cloneUnknown(tx.transaction),
          trace: buildTransactionTrace(tx, committedStages),
          deterministicTrace,
          failure: {
            stageId: stage.id,
            unitId: failedUnit,
            error: reason,
            timestamp: nextDeterministicTimestamp(tx),
          },
        };
      }

      const stagePrepare = preparePhase(stageTx, {
        repos: normalizedRepos,
        policyResult,
      });
      if (!stagePrepare.valid) {
        const failedUnit = stage.units[0] ?? normalizedRepos[0]?.id ?? "workspace:root";
        setUnitExecutionState(executionState, failedUnit, "failed");
        abortTransaction(stageTx);
        abortTransaction(tx);
        const deterministicTrace = finalizeDeterministicTrace(tx.workingState, true);
        return {
          success: false,
          finalState: cloneState(tx.workingState),
          baseState: cloneState(baseState),
          policyResult,
          orderedTaskIds: ordered.orderedTaskIds,
          plan: effectivePlan,
          violations: sortedUnique([...policyResult.violations, ...stagePrepare.errors]),
          stepsExecuted,
          unitsAffected: sortedUnique([...unitsAffected]),
          executionState,
          transaction: cloneUnknown(tx.transaction),
          trace: buildTransactionTrace(tx, committedStages),
          deterministicTrace,
          failure: {
            stageId: `${stage.id}:prepare`,
            unitId: failedUnit,
            error: stagePrepare.errors.join("; "),
            timestamp: nextDeterministicTimestamp(tx),
          },
        };
      }

      commitPhase(stageTx);
      const stageAfterHash = hashState(stageTx.workingState);
      deterministicStages.push({
        stageId: stage.id,
        unitOrder: deterministicSort(sortedUnique(stage.units)),
        stateHashBefore: stageBeforeHash,
        stateHashAfter: stageAfterHash,
        operations: stageOperations,
      });
      expectedStageBeforeHash = stageAfterHash;
      tx.workingState = cloneState(stageTx.workingState);
      tx.baseState = cloneState(stageTx.workingState);
      committedStages.push(stage.id);
    }

    const finalPrepare = preparePhase(tx, {
      repos: normalizedRepos,
      policyResult,
      violations: policyResult.violations,
    });

    if (!finalPrepare.valid) {
      const fallbackTask = taskById.get(stepsExecuted[stepsExecuted.length - 1] ?? "") ?? null;
      const failedUnit = fallbackTask?.repoId ?? normalizedRepos[0]?.id ?? "workspace:root";
      setUnitExecutionState(executionState, failedUnit, "failed");
      abortTransaction(tx);
      const deterministicTrace = finalizeDeterministicTrace(tx.workingState, true);
      return {
        success: false,
        finalState: cloneState(tx.workingState),
        baseState: cloneState(baseState),
        policyResult,
        orderedTaskIds: ordered.orderedTaskIds,
        plan: effectivePlan,
        violations: sortedUnique([...policyResult.violations, ...finalPrepare.errors]),
        stepsExecuted,
        unitsAffected: sortedUnique([...unitsAffected]),
        executionState,
        transaction: cloneUnknown(tx.transaction),
        trace: buildTransactionTrace(tx, committedStages),
        deterministicTrace,
        failure: {
          stageId: "transaction:prepare",
          unitId: failedUnit,
          error: finalPrepare.errors.join("; "),
          timestamp: nextDeterministicTimestamp(tx),
        },
      };
    }

    commitPhase(tx);
    const deterministicTrace = finalizeDeterministicTrace(tx.workingState, true);
    return {
      success: true,
      finalState: cloneState(tx.workingState),
      baseState: cloneState(baseState),
      policyResult,
      orderedTaskIds: ordered.orderedTaskIds,
      plan: effectivePlan,
      violations: [],
      stepsExecuted,
      unitsAffected: sortedUnique([...unitsAffected]),
      executionState,
      transaction: cloneUnknown(tx.transaction),
      trace: buildTransactionTrace(tx, committedStages),
      deterministicTrace,
    };
  } finally {
    if (lockOwnerToken) {
      releaseLocks(lockOwnerToken);
    }
  }
}

export async function executeTransactionBatch(
  plans: GlobalPlan[],
  options: ExecuteGlobalPlanOptions,
  mode: "simulation" | "execution" = "execution"
): Promise<TransactionBatch> {
  const orderedPlans = [...plans].sort((left, right) => left.id.localeCompare(right.id));
  const transactions: Transaction[] = [];

  for (const plan of orderedPlans) {
    const result = await executeTransaction(plan, options, mode);
    transactions.push(cloneUnknown(result.transaction));
    if (!result.success) {
      break;
    }
  }

  return {
    transactions,
  };
}

async function runGlobalPlanInternal(
  plan: GlobalPlan,
  options: ExecuteGlobalPlanOptions,
  mode: "simulation" | "execution",
  units?: string[]
): Promise<InternalRunResult> {
  const transactionResult = await executeTransaction(plan, options, mode, units);

  return {
    success: transactionResult.success,
    rolledBack: false,
    finalStates: cloneState(transactionResult.finalState),
    baseStates: cloneState(transactionResult.baseState),
    policyResult: cloneUnknown(transactionResult.policyResult),
    orderedTaskIds: [...transactionResult.orderedTaskIds],
    plan: cloneUnknown(transactionResult.plan),
    violations: [...transactionResult.violations],
    stepsExecuted: [...transactionResult.stepsExecuted],
    unitsAffected: [...transactionResult.unitsAffected],
    executionState: cloneExecutionState(transactionResult.executionState),
    transaction: cloneUnknown(transactionResult.transaction),
    transactionTrace: cloneUnknown(transactionResult.trace),
    deterministicTrace: cloneUnknown(transactionResult.deterministicTrace),
    failure: transactionResult.failure ? cloneUnknown(transactionResult.failure) : undefined,
  };
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
      deterministicTrace: cloneUnknown(internal.deterministicTrace),
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
      deterministicTrace: cloneUnknown(internal.deterministicTrace),
    },
    context: {
      baseState,
      simulatedState: cloneState(finalState),
      plan: cloneUnknown(internal.plan),
      mode: "simulation",
    },
  };
}

function defaultCostModel(): CostModel {
  return {
    changeCost: 1,
    riskScore: 5,
  };
}

function defaultScoreWeights(): ScoreWeights {
  return {
    risk: 5,
    changes: 1,
    executionCost: 1,
  };
}

export function computeStrategyMetrics(
  result: SimulationResult,
  costModel: CostModel = defaultCostModel()
): StrategyMetrics {
  const changes = result.changes.reduce((sum, entry) => sum + entry.operations.length, 0);
  const violations = result.violations.length;
  const risk = (changes * costModel.changeCost) + (violations * costModel.riskScore) + (result.success ? 0 : costModel.riskScore);
  const executionCost = changes + result.trace.stepsExecuted.length + result.trace.unitsAffected.length;

  return {
    violations,
    risk,
    changes,
    executionCost,
  };
}

export function compareStrategyMetricsLex(left: StrategyMetrics, right: StrategyMetrics): number {
  if (left.violations !== right.violations) {
    return left.violations - right.violations;
  }

  if (left.risk !== right.risk) {
    return left.risk - right.risk;
  }

  if (left.changes !== right.changes) {
    return left.changes - right.changes;
  }

  return left.executionCost - right.executionCost;
}

export function computeStrategyScore(metrics: StrategyMetrics, weights: ScoreWeights): number {
  return (
    (metrics.risk * weights.risk)
    + (metrics.changes * weights.changes)
    + (metrics.executionCost * weights.executionCost)
  );
}

export async function evaluateStrategies(
  strategies: Strategy[],
  options: ExecuteGlobalPlanOptions
): Promise<EvaluatedStrategy[]> {
  const ordered = [...strategies].sort((left, right) => left.id.localeCompare(right.id));
  const evaluated: EvaluatedStrategy[] = [];

  for (const strategy of ordered) {
    evaluated.push({
      strategyId: strategy.id,
      result: await simulatePlan(strategy.plan, options),
    });
  }

  return evaluated;
}

export function rankStrategies(
  evaluated: EvaluatedStrategy[],
  config?: StrategyConfig
): RankedStrategy[] {
  const allowViolations = config?.allowViolations ?? false;
  const weights = config?.weights;
  const costModel = config?.costModel ?? defaultCostModel();

  const enriched = [...evaluated]
    .sort((left, right) => left.strategyId.localeCompare(right.strategyId))
    .map((entry) => {
      const metrics = computeStrategyMetrics(entry.result, costModel);
      return {
        ...entry,
        metrics,
        score: weights ? computeStrategyScore(metrics, weights) : null,
      } satisfies RankedStrategy;
    });

  const valid = allowViolations
    ? enriched
    : enriched.filter((entry) => entry.metrics.violations === 0);

  return [...valid].sort((left, right) => {
    const lex = compareStrategyMetricsLex(left.metrics, right.metrics);
    if (lex !== 0) {
      return lex;
    }

    if (weights && left.score !== null && right.score !== null && left.score !== right.score) {
      return left.score - right.score;
    }

    return left.strategyId.localeCompare(right.strategyId);
  });
}

function formatStrategyMetrics(metrics: StrategyMetrics): string {
  return `violations=${metrics.violations}, risk=${metrics.risk}, changes=${metrics.changes}, executionCost=${metrics.executionCost}`;
}

function explainStrategyDecision(
  ranking: RankedStrategy[],
  selected: RankedStrategy,
  rejected: number,
  config?: StrategyConfig
): string {
  const lines: string[] = [
    `Selected ${selected.strategyId}`,
    "- lexicographic priority: violations -> risk -> changes -> executionCost",
    `- selected metrics: ${formatStrategyMetrics(selected.metrics)}`,
  ];

  if (rejected > 0 && !config?.allowViolations) {
    lines.push(`- rejected strategies with violations: ${rejected}`);
  }

  const runnerUp = ranking[1];
  if (runnerUp) {
    lines.push(`- next best ${runnerUp.strategyId}: ${formatStrategyMetrics(runnerUp.metrics)}`);
  }

  if (config?.weights) {
    const weights = {
      ...defaultScoreWeights(),
      ...config.weights,
    };
    lines.push(`- weighted scoring enabled after lexicographic filtering: risk=${weights.risk}, changes=${weights.changes}, executionCost=${weights.executionCost}`);
    if (selected.score !== null) {
      lines.push(`- selected weighted score: ${selected.score}`);
    }
  }

  return lines.join("\n");
}

export async function selectBestStrategy(
  strategies: Strategy[],
  options: ExecuteGlobalPlanOptions,
  config?: StrategyConfig
): Promise<StrategySelectionResult> {
  if (strategies.length === 0) {
    throw new Error("No strategies provided for comparison");
  }

  const evaluated = await evaluateStrategies(strategies, options);
  const effectiveConfig: StrategyConfig = {
    ...config,
    ...(config?.weights
      ? {
        weights: {
          ...defaultScoreWeights(),
          ...config.weights,
        },
      }
      : {}),
    costModel: config?.costModel ?? defaultCostModel(),
  };
  const ranking = rankStrategies(evaluated, effectiveConfig);

  if (ranking.length === 0) {
    throw new Error("No valid strategies");
  }

  const selected = ranking[0] as RankedStrategy;
  const rejected = evaluated.length - ranking.length;
  const decision: StrategyDecision = {
    selected: selected.strategyId,
    ranking: ranking.map((entry) => ({
      strategyId: entry.strategyId,
      metrics: {
        ...entry.metrics,
      },
    })),
    reason: explainStrategyDecision(ranking, selected, rejected, effectiveConfig),
  };
  const trace: StrategyTrace = {
    strategiesEvaluated: evaluated.length,
    strategiesRejected: rejected,
    selectionTime: Math.max(0, evaluated.length + ranking.length + rejected),
  };

  return {
    selected,
    ranking,
    decision,
    trace,
  };
}

export async function compareStrategies(
  strategies: GlobalPlan[],
  options: ExecuteGlobalPlanOptions & { costModel?: CostModel; strategyConfig?: StrategyConfig }
): Promise<ComparisonResult> {
  const selection = await selectBestStrategy(
    [...strategies]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((plan) => ({ id: plan.id, plan })),
    options,
    {
      ...options.strategyConfig,
      costModel: options.costModel ?? options.strategyConfig?.costModel,
    }
  );

  return {
    bestStrategy: selection.selected.strategyId,
    metrics: {
      risk: selection.selected.metrics.risk,
      changes: selection.selected.metrics.changes,
      violations: selection.selected.metrics.violations,
    },
    ranking: selection.ranking.map((entry) => ({
      strategyId: entry.strategyId,
      metrics: {
        ...entry.metrics,
      },
      score: entry.score,
    })),
    decision: selection.decision,
    trace: selection.trace,
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
  return deterministicId(prefix, payload, 12);
}

function operationTypeFromAction(action: string): string {
  const separator = action.indexOf(":");
  if (separator <= 0) {
    return "task";
  }

  return action.slice(0, separator);
}

function assertDeterministic(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Deterministic execution assertion failed: ${message}`);
  }
}

function deterministicTraceId(inputHash: string, stages: DeterministicStageTrace[], finalStateHash: string): string {
  return hashId("det-trace", {
    inputHash,
    finalStateHash,
    stages: stages.map((stage) => ({
      stageId: stage.stageId,
      stateHashBefore: stage.stateHashBefore,
      stateHashAfter: stage.stateHashAfter,
      opIds: stage.operations.map((operation) => operation.opId),
    })),
  });
}

function validateTraceDetailed(trace: DeterministicTrace): string[] {
  const errors: string[] = [];

  if (trace.stages.length === 0) {
    if (hashState(trace.initialState) !== trace.finalStateHash) {
      errors.push("Final state hash must equal initial state hash when trace has no stages");
    }
    return errors;
  }

  let expectedBefore = hashState(trace.initialState);
  const seenStageIds = new Set<string>();

  for (const stage of trace.stages) {
    if (seenStageIds.has(stage.stageId)) {
      errors.push(`Duplicate stage id ${stage.stageId}`);
    }
    seenStageIds.add(stage.stageId);

    if (stableStringify(stage.unitOrder) !== stableStringify(deterministicSort(stage.unitOrder))) {
      errors.push(`Stage ${stage.stageId} has non-deterministic unit ordering`);
    }

    const opIds = stage.operations.map((operation) => operation.opId);
    if (stableStringify(opIds) !== stableStringify(deterministicSort(opIds))) {
      errors.push(`Stage ${stage.stageId} has non-deterministic operation ordering`);
    }

    if (stage.stateHashBefore !== expectedBefore) {
      errors.push(`Stage ${stage.stageId} stateHashBefore does not match prior stage hash`);
    }

    for (const operation of stage.operations) {
      const expectedOperationHash = hashState({ [operation.target]: operation.stateAfter });
      if (operation.stateHashAfter !== expectedOperationHash) {
        errors.push(`Operation ${operation.opId} state hash mismatch`);
      }
    }

    expectedBefore = stage.stateHashAfter;
  }

  if (expectedBefore !== trace.finalStateHash) {
    errors.push("Final state hash does not match last stage stateHashAfter");
  }

  return errors;
}

export function validateTrace(trace: DeterministicTrace): boolean {
  return validateTraceDetailed(trace).length === 0;
}

export function replay(trace: DeterministicTrace): GlobalState {
  const errors = validateTraceDetailed(trace);
  if (errors.length > 0) {
    throw new Error(`Replay rejected: invalid deterministic trace (${errors.join("; ")})`);
  }

  const state = cloneState(trace.initialState);
  for (const stage of trace.stages) {
    const beforeHash = hashState(state);
    assertDeterministic(
      beforeHash === stage.stateHashBefore,
      `stage ${stage.stageId} expected ${stage.stateHashBefore}, got ${beforeHash}`
    );

    for (const operation of stage.operations) {
      state[operation.target] = cloneUnknown(operation.stateAfter);
      const opHash = hashState({ [operation.target]: state[operation.target] });
      assertDeterministic(
        opHash === operation.stateHashAfter,
        `operation ${operation.opId} expected ${operation.stateHashAfter}, got ${opHash}`
      );
    }

    const afterHash = hashState(state);
    assertDeterministic(
      afterHash === stage.stateHashAfter,
      `stage ${stage.stageId} expected ${stage.stateHashAfter}, got ${afterHash}`
    );
  }

  return state;
}

export function verifyReplay(trace: DeterministicTrace): boolean {
  const replayed = replay(trace);
  const replayHash = hashState(replayed);
  assertDeterministic(
    replayHash === trace.finalStateHash,
    `replay hash ${replayHash} does not match execution hash ${trace.finalStateHash}`
  );
  return true;
}

export async function executeDeterministic(input: ExecutionInput): Promise<DeterministicTrace> {
  const normalizedInput = normalizeExecutionInput(input);
  const inputHash = hashInput(normalizedInput);
  const context = executionContextFromInputHash(inputHash);
  const orderedPlan = normalizePlan(normalizedInput.plan);
  const batches = batchTasks(orderedPlan);
  const workingState = cloneState(normalizedInput.state);
  const stages: DeterministicStageTrace[] = [];

  for (const batch of batches) {
    const sortedTasks = [...batch.tasks].sort((left, right) => left.id.localeCompare(right.id));
    const stageBeforeHash = hashState(workingState);
    const operations: DeterministicOperation[] = [];

    for (const task of sortedTasks) {
      const currentState = cloneUnknown(workingState[task.repoId] ?? {});
      const nextState = await defaultTaskExecutor(task, currentState);
      workingState[task.repoId] = cloneUnknown(nextState);
      operations.push({
        opId: task.id,
        type: operationTypeFromAction(task.action),
        target: task.repoId,
        action: task.action,
        stateAfter: cloneUnknown(workingState[task.repoId] ?? {}),
        stateHashAfter: hashState({ [task.repoId]: workingState[task.repoId] ?? {} }),
      });
    }

    const stageAfterHash = hashState(workingState);
    stages.push({
      stageId: batch.id,
      unitOrder: deterministicSort(sortedTasks.map((task) => task.repoId)),
      stateHashBefore: stageBeforeHash,
      stateHashAfter: stageAfterHash,
      operations,
    });
  }

  const finalStateHash = hashState(workingState);
  const trace: DeterministicTrace = {
    traceId: deterministicTraceId(inputHash, stages, finalStateHash),
    inputHash,
    context,
    initialState: cloneState(normalizedInput.state),
    stages,
    finalStateHash,
    deterministic: true,
  };

  trace.deterministic = validateTrace(trace) && verifyReplay(trace);
  recordDeterministicTrace(trace);
  return trace;
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

async function executeIsolatedRollback(
  failedUnit: string,
  graph: DependencyGraph,
  executionState: ExecutionState,
  stableState: GlobalState,
  currentState: GlobalState,
  repos: Repo[],
  context: ExecutionContext,
  additionalUnits?: string[]
): Promise<{
  finalState: GlobalState;
  rollbackTrace: RollbackTrace;
  executionState: ExecutionState;
  validation: RolloutValidationResult;
  isolation: RolloutValidationResult;
}> {
  const rollbackSet = mergeRollbackSets(failedUnit, graph, executionState, additionalUnits);
  const isolation = validateIsolation(rollbackSet, graph, failedUnit);
  const workingState = cloneState(currentState);
  const rollbackContext = cloneDeterministicContext(context);
  const snapshots = snapshotUnits(stableState, rollbackSet, rollbackContext.baseTimestamp + rollbackContext.logicalTime + 1);
  const stateRef = { current: workingState };
  const compensations = buildCompensations(rollbackSet, stableState, stateRef);
  const rolledBack = await rollbackUnits(rollbackSet, graph, stateRef.current, snapshots, compensations);
  const rollbackDuration = Math.max(0, rollbackSet.length + rolledBack.rollbackOrder.length + (rollbackContext.seed % 7));
  const rollbackTrace: RollbackTrace = {
    failedUnit,
    rollbackSet,
    rollbackOrder: rolledBack.rollbackOrder,
    duration: rollbackDuration,
  };

  const postRollbackState = markUnitsRolledBack(executionState, rollbackSet);
  const validation = validatePostRollback(rolledBack.state, graph, postRollbackState, repos);

  return {
    finalState: rolledBack.state,
    rollbackTrace,
    executionState: postRollbackState,
    validation,
    isolation,
  };
}

export async function executeGlobalPlan(
  plan: GlobalPlan,
  options: ExecuteGlobalPlanOptions
): Promise<GlobalExecutionResult> {
  const normalizedRepos = options.repos.map((repo) => normalizeRepo(repo)).sort((left, right) => left.id.localeCompare(right.id));
  const dependencyGraph = buildRollbackDependencyGraph(plan);
  const simulation = await simulatePlan(plan, options);
  const simulationPolicy = simulation.policyDecisions[0];

  if (simulationPolicy && !simulationPolicy.allowed) {
    blockGlobalExecution(simulationPolicy);
  }

  if (!simulation.success) {
    const baseStates = stateForRepos(normalizedRepos);
    return {
      success: false,
      rolledBack: false,
      finalStates: cloneState(baseStates),
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
        deterministicTrace: simulation.trace.deterministicTrace ? cloneUnknown(simulation.trace.deterministicTrace) : undefined,
      },
    };
  }

  const execution = await runGlobalPlanInternal(plan, options, "execution");

  if (!execution.success) {
    const failedUnit = execution.failure?.unitId ?? execution.unitsAffected[0] ?? normalizedRepos[0]?.id ?? "workspace:root";
    const isolatedRollback = await executeIsolatedRollback(
      failedUnit,
      dependencyGraph,
      execution.executionState,
      execution.baseStates,
      execution.finalStates,
      normalizedRepos,
      execution.deterministicTrace.context
    );

    const requiresFullRollback = !isolatedRollback.isolation.valid || !isolatedRollback.validation.valid;
    const finalStates = requiresFullRollback
      ? rollbackAllRepos(execution.baseStates)
      : cloneState(isolatedRollback.finalState);
    const violations = sortedUnique([
      ...execution.policyResult.violations,
      ...execution.violations,
      ...isolatedRollback.isolation.errors,
      ...isolatedRollback.validation.errors,
      ...(requiresFullRollback ? ["Fallback to rollback-all: isolated rollback could not restore consistency"] : []),
    ]);

    return {
      success: false,
      rolledBack: true,
      finalStates,
      audit: {
        planId: plan.id,
        reposInvolved: normalizedRepos.map((repo) => repo.id),
        policiesApplied: execution.policyResult.appliedPolicyIds,
        violations,
      },
      trace: {
        plan,
        executionOrder: execution.orderedTaskIds,
        policyDecisions: execution.policyResult.policyDecisions,
        convergence: false,
        transactionTrace: cloneUnknown(execution.transactionTrace),
        deterministicTrace: cloneUnknown(execution.deterministicTrace),
      },
      rollbackTrace: isolatedRollback.rollbackTrace,
    };
  }

  const expectedState = simulation.finalState;
  const actualState = execution.finalStates;
  const simulationDeterministicTrace = simulation.trace.deterministicTrace;
  const executionDeterministicTrace = execution.deterministicTrace;
  const stateEquivalent = statesEqual(expectedState, actualState);
  const hashEquivalent = simulationDeterministicTrace
    ? simulationDeterministicTrace.finalStateHash === executionDeterministicTrace.finalStateHash
    : true;
  const deterministicTraceValid = (simulationDeterministicTrace?.deterministic ?? true)
    && executionDeterministicTrace.deterministic;
  const equivalent = stateEquivalent && hashEquivalent && deterministicTraceValid;

  if (!equivalent) {
    const divergentUnits = stateDiffUnits(expectedState, actualState);
    const failedUnit = divergentUnits[0] ?? execution.unitsAffected[0] ?? normalizedRepos[0]?.id ?? "workspace:root";
    const isolatedRollback = await executeIsolatedRollback(
      failedUnit,
      dependencyGraph,
      execution.executionState,
      execution.baseStates,
      execution.finalStates,
      normalizedRepos,
      execution.deterministicTrace.context,
      divergentUnits
    );
    const requiresFullRollback = !isolatedRollback.isolation.valid || !isolatedRollback.validation.valid;
    const rolledBackStates = requiresFullRollback
      ? rollbackAllRepos(execution.baseStates)
      : cloneState(isolatedRollback.finalState);
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
          ...isolatedRollback.isolation.errors,
          ...isolatedRollback.validation.errors,
          "Simulation and execution diverged",
          ...(hashEquivalent ? [] : ["Simulation and execution state hashes diverged"]),
          ...(deterministicTraceValid ? [] : ["Deterministic trace validation failed"]),
          ...(requiresFullRollback ? ["Fallback to rollback-all: isolated rollback could not restore consistency"] : []),
        ]),
      },
      trace: {
        plan,
        executionOrder: execution.orderedTaskIds,
        policyDecisions: execution.policyResult.policyDecisions,
        convergence: false,
        transactionTrace: cloneUnknown(execution.transactionTrace),
        deterministicTrace: cloneUnknown(execution.deterministicTrace),
      },
      rollbackTrace: isolatedRollback.rollbackTrace,
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
      transactionTrace: cloneUnknown(execution.transactionTrace),
      deterministicTrace: cloneUnknown(execution.deterministicTrace),
    },
  };
}

function normalizePercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.min(100, Math.round(value)));
}

function normalizePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

function buildUnitDependencies(plan: GlobalPlan): Map<string, Set<string>> {
  const taskById = new Map(plan.tasks.map((task) => [task.id, task] as const));
  const dependencies = new Map<string, Set<string>>();

  for (const task of plan.tasks) {
    if (!dependencies.has(task.repoId)) {
      dependencies.set(task.repoId, new Set<string>());
    }

    for (const dependencyId of task.dependsOn) {
      const dependencyTask = taskById.get(dependencyId);
      if (!dependencyTask) {
        continue;
      }

      if (dependencyTask.repoId === task.repoId) {
        continue;
      }

      dependencies.get(task.repoId)?.add(dependencyTask.repoId);
      if (!dependencies.has(dependencyTask.repoId)) {
        dependencies.set(dependencyTask.repoId, new Set<string>());
      }
    }
  }

  return dependencies;
}

function buildDeterministicUnitOrder(plan: GlobalPlan): string[] {
  const dependencies = buildUnitDependencies(plan);
  const units = sortedUnique(plan.tasks.map((task) => task.repoId));
  const indegree = new Map<string, number>(units.map((unit) => [unit, 0] as const));
  const outgoing = new Map<string, string[]>(units.map((unit) => [unit, []] as const));

  for (const unit of units) {
    const deps = sortedUnique([...(dependencies.get(unit) ?? new Set<string>())]);
    indegree.set(unit, deps.length);
    for (const dep of deps) {
      const current = outgoing.get(dep) ?? [];
      current.push(unit);
      outgoing.set(dep, sortedUnique(current));
    }
  }

  const ready = [...units].filter((unit) => (indegree.get(unit) ?? 0) === 0).sort((left, right) => left.localeCompare(right));
  const ordered: string[] = [];

  while (ready.length > 0) {
    const unit = ready.shift() as string;
    ordered.push(unit);

    const nextUnits = outgoing.get(unit) ?? [];
    for (const nextUnit of nextUnits) {
      const nextInDegree = (indegree.get(nextUnit) ?? 0) - 1;
      indegree.set(nextUnit, nextInDegree);
      if (nextInDegree === 0) {
        ready.push(nextUnit);
        ready.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  if (ordered.length !== units.length) {
    throw new Error("Rollout staging failed: unit dependency cycle detected");
  }

  return ordered;
}

function buildStageId(planId: string, order: number, units: string[], percentage?: number): string {
  return hashId("rollout-stage", {
    planId,
    order,
    units,
    ...(typeof percentage === "number" ? { percentage } : {}),
  });
}

function toCumulativePercents(strategy: RolloutStrategy): number[] {
  if (strategy.type === "canary") {
    const values = [
      normalizePercent(strategy.initialPercent),
      ...strategy.steps.map((step) => normalizePercent(step)),
      100,
    ];
    return [...new Set(values)].sort((left, right) => left - right);
  }

  if (strategy.type === "phased") {
    const values = [
      ...strategy.phases.map((phase) => normalizePercent(phase)),
      100,
    ];
    return [...new Set(values)].sort((left, right) => left - right);
  }

  return [100];
}

function stagePlanForUnits(plan: GlobalPlan, units: string[]): GlobalPlan {
  const selectedUnits = new Set(sortedUnique(units));
  const tasks = plan.tasks
    .filter((task) => selectedUnits.has(task.repoId))
    .map((task) => ({
      ...task,
      dependsOn: task.dependsOn.filter((dependencyId) => {
        const dependencyTask = plan.tasks.find((entry) => entry.id === dependencyId);
        return dependencyTask ? selectedUnits.has(dependencyTask.repoId) : false;
      }).sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    id: hashId("rollout-plan", {
      base: plan.id,
      units: [...selectedUnits],
      tasks: tasks.map((task) => task.id),
    }),
    tasks,
  };
}

function defaultRolloutConfig(): RolloutConfig {
  return {
    thresholds: {
      errorRate: 1,
      latency: Number.MAX_SAFE_INTEGER,
    },
    autoRollback: true,
    stageApproval: false,
  };
}

function mergeRolloutConfig(config?: Partial<RolloutConfig>): RolloutConfig {
  const defaults = defaultRolloutConfig();
  return {
    ...defaults,
    ...config,
    thresholds: {
      ...defaults.thresholds,
      ...(config?.thresholds ?? {}),
    },
  };
}

export function buildStages(plan: GlobalPlan, strategy: RolloutStrategy): ExecutionStage[] {
  const orderedUnits = buildDeterministicUnitOrder(plan);
  if (orderedUnits.length === 0) {
    return [];
  }

  if (strategy.type === "all-at-once") {
    return [{
      id: buildStageId(plan.id, 1, orderedUnits, 100),
      units: orderedUnits,
      percentage: 100,
      order: 1,
    }];
  }

  if (strategy.type === "batched") {
    const batchSize = normalizePositiveInt(strategy.batchSize, 1);
    const stages: ExecutionStage[] = [];
    let order = 1;

    for (let cursor = 0; cursor < orderedUnits.length; cursor += batchSize) {
      const units = orderedUnits.slice(cursor, cursor + batchSize);
      const percentage = normalizePercent((Math.min(orderedUnits.length, cursor + batchSize) / orderedUnits.length) * 100);
      stages.push({
        id: buildStageId(plan.id, order, units, percentage),
        units,
        percentage,
        order,
      });
      order += 1;
    }

    return stages;
  }

  const percents = toCumulativePercents(strategy);
  const stages: ExecutionStage[] = [];
  let previousCount = 0;
  let order = 1;

  for (const percent of percents) {
    const nextCount = Math.max(previousCount + 1, Math.ceil((percent / 100) * orderedUnits.length));
    const boundedCount = Math.min(orderedUnits.length, nextCount);
    const units = orderedUnits.slice(previousCount, boundedCount);
    previousCount = boundedCount;

    if (units.length === 0) {
      continue;
    }

    stages.push({
      id: buildStageId(plan.id, order, units, percent),
      units,
      percentage: percent,
      order,
    });
    order += 1;
  }

  return stages;
}

export function respectDependencies(
  stage: ExecutionStage,
  plan: GlobalPlan,
  completedUnits: string[]
): RolloutValidationResult {
  const dependencyMap = buildUnitDependencies(plan);
  const stageUnits = new Set(stage.units);
  const completed = new Set(completedUnits);
  const errors: string[] = [];

  for (const unit of stage.units) {
    const dependencies = sortedUnique([...(dependencyMap.get(unit) ?? new Set<string>())]);
    for (const dependency of dependencies) {
      if (stageUnits.has(dependency) || completed.has(dependency)) {
        continue;
      }

      errors.push(`Stage ${stage.id} executes ${unit} before dependency ${dependency}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors: sortedUnique(errors),
  };
}

function stageMetricsFromRun(run: InternalRunResult): StageMetrics {
  const totalSteps = Math.max(1, run.stepsExecuted.length);
  const violations = sortedUnique([...run.violations, ...run.policyResult.violations]).length;

  return {
    errorRate: violations / totalSteps,
    latency: run.stepsExecuted.length,
    violations,
  };
}

export async function executeStage(
  stage: ExecutionStage,
  plan: GlobalPlan,
  options: ExecuteGlobalPlanOptions,
  currentState: GlobalState
): Promise<StageExecutionResult> {
  const stagePlan = stagePlanForUnits(plan, stage.units);
  const stageRepos = options.repos
    .map((repo) => ({
      ...repo,
      state: cloneUnknown(currentState[repo.id] ?? repo.state),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const run = await runGlobalPlanInternal(stagePlan, {
    ...options,
    repos: stageRepos,
  }, "execution");

  const metrics = stageMetricsFromRun(run);
  const violations = sortedUnique([...run.violations, ...run.policyResult.violations]);

  return {
    stage,
    success: run.success,
    violations,
    metrics,
    unitsAffected: [...run.unitsAffected],
    finalStates: cloneState(run.finalStates),
    executionState: cloneExecutionState(run.executionState),
    transactionTrace: cloneUnknown(run.transactionTrace),
    deterministicTrace: cloneUnknown(run.deterministicTrace),
    ...(run.failure ? { failure: run.failure } : {}),
  };
}

export function validateStage(
  stageResult: StageExecutionResult,
  plan: GlobalPlan,
  completedUnits: string[],
  config: RolloutConfig
): RolloutValidationResult {
  const dependencyValidation = respectDependencies(stageResult.stage, plan, completedUnits);
  const errors: string[] = [];

  if (!stageResult.success) {
    errors.push(`Stage ${stageResult.stage.id} execution failed`);
  }

  errors.push(...stageResult.violations);
  errors.push(...dependencyValidation.errors);

  if (stageResult.metrics.errorRate > config.thresholds.errorRate) {
    errors.push(`Stage ${stageResult.stage.id} exceeded errorRate threshold`);
  }

  if (stageResult.metrics.latency > config.thresholds.latency) {
    errors.push(`Stage ${stageResult.stage.id} exceeded latency threshold`);
  }

  return {
    valid: errors.length === 0,
    errors: sortedUnique(errors),
  };
}

export function rollbackStage(
  stage: ExecutionStage,
  stableState: GlobalState,
  currentState: GlobalState
): GlobalState {
  const next = cloneState(currentState);
  for (const unit of stage.units) {
    if (Object.prototype.hasOwnProperty.call(stableState, unit)) {
      next[unit] = cloneUnknown(stableState[unit]);
    }
  }

  return next;
}

function rolloutPreviewHash(plan: GlobalPlan, simulation: SimulationResult): string {
  return hashId("rollout-preview", {
    planId: plan.id,
    steps: simulation.trace.stepsExecuted,
    changes: simulation.changes,
    violations: simulation.violations,
  });
}

export async function executeRolloutPlan(
  plan: GlobalPlan,
  options: ExecuteGlobalPlanOptions,
  strategy: RolloutStrategy,
  config?: Partial<RolloutConfig>
): Promise<RolloutExecutionResult> {
  const effectiveConfig = mergeRolloutConfig(config);
  const normalizedRepos = options.repos.map((repo) => normalizeRepo(repo)).sort((left, right) => left.id.localeCompare(right.id));
  const baseState = stateForRepos(normalizedRepos);
  const dependencyGraph = buildRollbackDependencyGraph(plan);
  const trace: RolloutTrace = {
    stages: buildStages(plan, strategy),
    completedStages: [],
    metrics: {},
    rollbackTraces: [],
    transactionTraces: [],
    deterministicTraces: [],
  };

  if (trace.stages.length === 0) {
    return {
      success: true,
      stopped: false,
      rolledBack: false,
      finalStates: cloneState(baseState),
      trace,
      failures: [],
    };
  }

  const simulation = await simulatePlan(plan, {
    ...options,
    repos: normalizedRepos,
  });

  if (!simulation.success) {
    return {
      success: false,
      stopped: true,
      rolledBack: false,
      finalStates: cloneState(baseState),
      trace,
      failures: sortedUnique([
        ...simulation.violations,
        "Rollout blocked: pre-rollout simulation failed",
      ]),
    };
  }

  const rolloutContext = executionContextFromInputHash(hashInput({
    plan: normalizePlan(plan),
    state: cloneState(baseState),
    policies: normalizePolicies(options.policies),
    dependencyGraph,
  }));

  const previewHash = rolloutPreviewHash(plan, simulation);
  if (effectiveConfig.requireApproval && !effectiveConfig.stageApproval) {
    const approved = await effectiveConfig.requireApproval({
      planId: plan.id,
      previewHash,
    });

    if (!approved) {
      return {
        success: false,
        stopped: true,
        rolledBack: false,
        finalStates: cloneState(baseState),
        trace,
        failures: ["Rollout blocked: approval required"],
      };
    }
  }

  let currentState = cloneState(baseState);
  let executionState = createExecutionState(normalizedRepos.map((repo) => repo.id));
  const completedUnits = new Set<string>();

  for (const stage of trace.stages) {
    const stageSnapshot = cloneState(currentState);

    if (effectiveConfig.requireApproval && effectiveConfig.stageApproval) {
      const approved = await effectiveConfig.requireApproval({
        planId: plan.id,
        stageId: stage.id,
        previewHash,
      });

      if (!approved) {
        trace.failedStage = stage.id;
        return {
          success: false,
          stopped: true,
          rolledBack: false,
          finalStates: cloneState(currentState),
          trace,
          failures: ["Rollout blocked: stage approval required"],
        };
      }
    }

    const stageResult = await executeStage(stage, plan, {
      ...options,
      repos: normalizedRepos,
    }, currentState);

    const mergedExecutionState = cloneExecutionState(executionState);
    for (const [unit, status] of Object.entries(stageResult.executionState.units)) {
      if (status === "executed" || status === "failed") {
        setUnitExecutionState(mergedExecutionState, unit, status);
      }
    }

    trace.metrics[stage.id] = {
      ...stageResult.metrics,
    };
    if (stageResult.transactionTrace) {
      trace.transactionTraces.push(cloneUnknown(stageResult.transactionTrace));
    }
    if (stageResult.deterministicTrace) {
      trace.deterministicTraces.push(cloneUnknown(stageResult.deterministicTrace));
    }

    const stageValidation = validateStage(stageResult, plan, [...completedUnits], effectiveConfig);
    if (!stageValidation.valid) {
      trace.failedStage = stage.id;
      if (!effectiveConfig.autoRollback) {
        trace.canResume = false;
        return {
          success: false,
          stopped: true,
          rolledBack: false,
          finalStates: cloneState(stageResult.finalStates),
          trace,
          failures: stageValidation.errors,
        };
      }

      const failedUnit = stageResult.failure?.unitId ?? stage.units[0] ?? "workspace:root";
      const isolatedRollback = await executeIsolatedRollback(
        failedUnit,
        dependencyGraph,
        mergedExecutionState,
        stageSnapshot,
        stageResult.finalStates,
        normalizedRepos,
        rolloutContext
      );
      trace.rollbackTraces.push(isolatedRollback.rollbackTrace);

      const remainingUnits = trace.stages
        .filter((candidate) => candidate.order > stage.order)
        .flatMap((candidate) => candidate.units);
      const canResume = canResumeAfterRollback(
        isolatedRollback.rollbackTrace.rollbackSet,
        sortedUnique(remainingUnits),
        dependencyGraph
      );
      trace.canResume = canResume;

      const rollbackFailures = sortedUnique([
        ...stageValidation.errors,
        ...isolatedRollback.isolation.errors,
        ...isolatedRollback.validation.errors,
      ]);

      executionState = cloneExecutionState(isolatedRollback.executionState);
      currentState = cloneState(isolatedRollback.finalState);

      if (canResume) {
        completedUnits.clear();
        for (const [unit, unitState] of Object.entries(executionState.units)) {
          if (unitState === "executed") {
            completedUnits.add(unit);
          }
        }

        continue;
      }

      return {
        success: false,
        stopped: true,
        rolledBack: true,
        finalStates: cloneState(currentState),
        trace,
        failures: rollbackFailures,
      };
    }

    currentState = cloneState(stageResult.finalStates);
    executionState = mergedExecutionState;
    trace.completedStages.push(stage.id);
    stage.units.forEach((unit) => completedUnits.add(unit));
  }

  const equivalent = statesEqual(currentState, simulation.finalState);
  if (!equivalent) {
    const divergentUnits = stateDiffUnits(currentState, simulation.finalState);
    const failedUnit = divergentUnits[0] ?? trace.stages[0]?.units[0] ?? "workspace:root";
    const isolatedRollback = await executeIsolatedRollback(
      failedUnit,
      dependencyGraph,
      executionState,
      baseState,
      currentState,
      normalizedRepos,
      rolloutContext,
      divergentUnits
    );
    trace.rollbackTraces.push(isolatedRollback.rollbackTrace);

    const requiresFullRollback = !isolatedRollback.isolation.valid || !isolatedRollback.validation.valid;
    const rollbackState = requiresFullRollback
      ? cloneState(baseState)
      : cloneState(isolatedRollback.finalState);
    return {
      success: false,
      stopped: true,
      rolledBack: true,
      finalStates: rollbackState,
      trace,
      failures: sortedUnique([
        "Rollout failed: simulation and staged execution diverged",
        ...isolatedRollback.isolation.errors,
        ...isolatedRollback.validation.errors,
        ...(requiresFullRollback ? ["Fallback to rollback-all: isolated rollback could not restore consistency"] : []),
      ]),
    };
  }

  return {
    success: true,
    stopped: false,
    rolledBack: false,
    finalStates: cloneState(currentState),
    trace,
    failures: [],
  };
}
