import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { CONTROL_PLANE_VERSION, ControlPlane, Plan, Task } from "../schema.js";
import {
  CompiledPolicy,
  DependencyGraph,
  DeterministicTrace,
  ExecutionInput,
  GlobalPlan,
  GlobalPlanTask,
  GlobalPolicyRule,
  GlobalState,
  PolicyState,
  Repo,
  RolloutStrategy,
  buildRollbackDependencyGraph,
  buildStages,
  compareStrategies,
  executeGlobalPlan,
  hashInput,
  hashState as hashGlobalState,
  replay,
  simulatePlan,
} from "./globalOrchestration.js";
import {
  StrategyOutcome,
} from "./strategyPlanner.js";
import {
  buildSignature,
  canReuse,
  findMatchingStrategies,
  readStrategyMemory,
  recordStrategy,
  selectFromMemory,
  validatePlanStillApplies,
} from "./strategyMemory.js";
import { StatePlane, createEmptyStatePlane } from "./state.js";

export type SystemInvariant =
  | "determinism"
  | "replay-consistency"
  | "simulation-equivalence"
  | "rollback-integrity"
  | "policy-enforcement"
  | "strategy-determinism"
  | "memory-validity";

export type Generator<T> = () => T;

export type Edge = {
  from: string;
  to: string;
};

export type ChaosEvent =
  | { type: "fail-stage"; stageId: string }
  | { type: "fail-unit"; unitId: string }
  | { type: "inject-latency"; ms: number }
  | { type: "drop-dependency"; edge: Edge }
  | { type: "policy-conflict"; rule: string };

export type ChaosMode =
  | "none"
  | "light"
  | "moderate"
  | "extreme";

export type PropertyTestCase = {
  plan: GlobalPlan;
  graph: DependencyGraph;
  policy: PolicyState;
  state: GlobalState;
};

export type PropertyRunOptions = {
  iterations?: number;
  seed?: number;
  chaosMode?: ChaosMode;
  throwOnFailure?: boolean;
};

export type ChaosTestReport = {
  totalRuns: number;
  failures: number;
  invariantsBroken: string[];
  minimalFailureCase?: object;
  mode: ChaosMode;
  seed: number;
};

export type PropertyRunResult = ChaosTestReport & {
  failedAtIteration?: number;
};

type GeneratedCase = {
  input: ExecutionInput;
  profile: "empty" | "sparse" | "large" | "conflict";
  chaosEvents: ChaosEvent[];
};

type InvariantContext = {
  iteration: number;
  seed: number;
  input: ExecutionInput;
  generated: GeneratedCase;
  chaoticPlan: GlobalPlan;
  simulatedState: GlobalState;
  executionState: GlobalState;
  executionSuccess: boolean;
  trace?: DeterministicTrace;
  repos: Repo[];
  policies: PolicyState;
  executeTask?: ExecuteTask;
};

type ExecuteTask = (
  task: GlobalPlanTask,
  repoState: Record<string, unknown>,
  repoId: string,
  allStates: Record<string, Record<string, unknown>>,
  mode: "simulation" | "execution"
) => Promise<Record<string, unknown>>;

type SafeSimulationResult = {
  finalState: GlobalState;
  blocked: boolean;
  blockReason?: string;
};

type SafeExecutionResult = {
  success: boolean;
  rolledBack: boolean;
  finalStates: GlobalState;
  trace?: DeterministicTrace;
  blocked: boolean;
  blockReason?: string;
};

type InvariantCheck = (ctx: InvariantContext) => Promise<boolean>;

type SeededGeneratorState = {
  seed: number;
};

const CHAOS_DEFAULTS: Record<Exclude<ChaosMode, "none">, number> = {
  light: 1,
  moderate: 2,
  extreme: 4,
};

let generatorState: SeededGeneratorState = { seed: 1337 };

export function setSeed(seed: number): void {
  const normalized = Number.isFinite(seed) ? Math.max(1, Math.floor(seed)) : 1337;
  generatorState = { seed: normalized };
}

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = (seed >>> 0) || 1;
  }

  next(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return (this.state >>> 0) / 0x100000000;
  }

  int(maxExclusive: number): number {
    if (maxExclusive <= 1) {
      return 0;
    }

    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(values: readonly T[]): T {
    return values[this.int(values.length)] as T;
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }
}

function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSort(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const asRecord = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(asRecord)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stableSort(asRecord[key])] as const)
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableSort(value));
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function combineSeed(baseSeed: number, salt: string): number {
  const hashed = createHash("sha256").update(`${baseSeed}:${salt}`).digest("hex").slice(0, 8);
  return parseInt(hashed, 16) || 1;
}

function randomRepoIds(rng: SeededRandom, count: number, prefix: string): string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(`${prefix}-repo-${index + 1}`);
  }

  // deterministic variation in order to exercise sorting code paths
  return rng.bool(0.5) ? [...ids].reverse() : ids;
}

function createPlanTask(
  repoId: string,
  order: number,
  dependsOn: string[],
  profile: GeneratedCase["profile"]
): GlobalPlanTask {
  const action = profile === "conflict" && order === 0
    ? `danger:mutate:${repoId}`
    : `set:meta.step${order + 1}=${repoId}`;

  return {
    id: `${repoId}:t${order + 1}`,
    repoId,
    action,
    dependsOn,
  };
}

function generateRandomPlan(rng: SeededRandom, profile: GeneratedCase["profile"], iteration: number): GlobalPlan {
  const repoCount = profile === "empty"
    ? 0
    : profile === "large"
      ? 8 + rng.int(4)
      : 2 + rng.int(3);

  const repoIds = randomRepoIds(rng, repoCount, `iter-${iteration}`);
  const tasks: GlobalPlanTask[] = [];

  for (let index = 0; index < repoIds.length; index += 1) {
    const repoId = repoIds[index] as string;
    const previousTaskId = tasks.length > 0 ? tasks[tasks.length - 1]?.id : undefined;
    const extraDependency = tasks.length > 1 && rng.bool(0.25)
      ? tasks[Math.max(0, tasks.length - 2)]?.id
      : undefined;
    const dependsOn = sortedUnique([
      ...(previousTaskId ? [previousTaskId] : []),
      ...(extraDependency ? [extraDependency] : []),
    ]);

    tasks.push(createPlanTask(repoId, 0, dependsOn, profile));
  }

  return {
    id: `property-plan-${iteration}-${profile}`,
    tasks: tasks.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function generateRandomGraph(rng: SeededRandom, plan: GlobalPlan): DependencyGraph {
  const taskMap = new Map(plan.tasks.map((task) => [task.id, task] as const));
  const edges: Edge[] = [];

  for (const task of [...plan.tasks].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const dependency of task.dependsOn) {
      if (!taskMap.has(dependency)) {
        continue;
      }
      edges.push({ from: dependency, to: task.repoId });
    }

    if (rng.bool(0.1) && plan.tasks.length > 1) {
      const randomTask = plan.tasks[rng.int(plan.tasks.length)] as GlobalPlanTask;
      if (randomTask.repoId !== task.repoId) {
        edges.push({ from: randomTask.repoId, to: task.repoId });
      }
    }
  }

  return {
    edges: edges
      .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to))
      .filter((edge, index, all) => index === 0 || edge.from !== all[index - 1]?.from || edge.to !== all[index - 1]?.to),
  };
}

function makeCompiledPolicy(id: string, source: CompiledPolicy["source"], rules: GlobalPolicyRule[]): CompiledPolicy {
  return {
    id,
    source,
    rules,
  };
}

function generateRandomPolicy(rng: SeededRandom, profile: GeneratedCase["profile"], iteration: number): PolicyState {
  const policies: CompiledPolicy[] = [];

  if (profile === "conflict") {
    policies.push(makeCompiledPolicy(`policy-${iteration}-deny-danger`, "org", [
      {
        id: `rule-${iteration}-deny-danger`,
        kind: "deny-action-prefix",
        effect: "deny",
        actionPrefix: "danger:",
      },
    ]));

    policies.push(makeCompiledPolicy(`policy-${iteration}-require-set`, "repo", [
      {
        id: `rule-${iteration}-require-set`,
        kind: "require-repo-action-prefix",
        effect: "require-approval",
        actionPrefix: "set:",
      },
    ]));

    return policies;
  }

  if (rng.bool(0.2)) {
    policies.push(makeCompiledPolicy(`policy-${iteration}-approval`, "team", [
      {
        id: `rule-${iteration}-approval`,
        kind: "require-repo-action-prefix",
        effect: "require-approval",
        actionPrefix: "set:",
      },
    ]));
  }

  return policies;
}

function generateRandomState(_rng: SeededRandom, plan: GlobalPlan): GlobalState {
  const state: GlobalState = {};
  const repoIds = sortedUnique(plan.tasks.map((task) => task.repoId));

  for (const repoId of repoIds) {
    state[repoId] = {
      meta: {
        seeded: "0",
      },
    };
  }

  return state;
}

function profileForIteration(iteration: number): GeneratedCase["profile"] {
  const profiles: GeneratedCase["profile"][] = ["empty", "sparse", "large", "conflict"];
  return profiles[iteration % profiles.length] as GeneratedCase["profile"];
}

function generatorsFor(seed: number, iteration: number): {
  plan: Generator<GlobalPlan>;
  dependencyGraph: Generator<DependencyGraph>;
  policy: Generator<PolicyState>;
  state: Generator<GlobalState>;
  profile: GeneratedCase["profile"];
} {
  const profile = profileForIteration(iteration);
  const rng = new SeededRandom(combineSeed(seed, `generator:${iteration}`));
  const plan = generateRandomPlan(rng, profile, iteration);

  return {
    plan: () => clone(plan),
    dependencyGraph: () => generateRandomGraph(new SeededRandom(combineSeed(seed, `graph:${iteration}`)), plan),
    policy: () => generateRandomPolicy(new SeededRandom(combineSeed(seed, `policy:${iteration}`)), profile, iteration),
    state: () => generateRandomState(new SeededRandom(combineSeed(seed, `state:${iteration}`)), plan),
    profile,
  };
}

export function generateTestCase(iteration: number, seed = generatorState.seed): GeneratedCase {
  const set = generatorsFor(seed, iteration);
  const plan = set.plan();
  const state = set.state();
  const policy = set.policy();

  const input: ExecutionInput = {
    plan,
    state,
    policies: policy,
    dependencyGraph: set.dependencyGraph(),
  };

  return {
    input,
    profile: set.profile,
    chaosEvents: [],
  };
}

function taskById(plan: GlobalPlan): Map<string, GlobalPlanTask> {
  return new Map(plan.tasks.map((task) => [task.id, task] as const));
}

function buildReposForPlan(plan: GlobalPlan, state: GlobalState): Repo[] {
  const byTaskId = taskById(plan);
  const repoIds = sortedUnique([
    ...Object.keys(state),
    ...plan.tasks.map((task) => task.repoId),
  ]);

  const dependencyByRepo = new Map<string, Set<string>>();
  for (const repoId of repoIds) {
    dependencyByRepo.set(repoId, new Set<string>());
  }

  for (const task of [...plan.tasks].sort((left, right) => left.id.localeCompare(right.id))) {
    const bucket = dependencyByRepo.get(task.repoId) ?? new Set<string>();
    for (const dependencyId of task.dependsOn) {
      const dependency = byTaskId.get(dependencyId);
      if (dependency && dependency.repoId !== task.repoId) {
        bucket.add(dependency.repoId);
      }
    }
    dependencyByRepo.set(task.repoId, bucket);
  }

  return repoIds.map((repoId) => ({
    id: repoId,
    dependencies: sortedUnique([...(dependencyByRepo.get(repoId) ?? new Set<string>())]),
    state: clone(state[repoId] ?? {}),
  }));
}

function chooseChaosEvents(plan: GlobalPlan, mode: ChaosMode, rng: SeededRandom): ChaosEvent[] {
  if (mode === "none") {
    return [];
  }

  const tasks = [...plan.tasks].sort((left, right) => left.id.localeCompare(right.id));
  const unitIds = sortedUnique(tasks.map((task) => task.repoId));
  const events: ChaosEvent[] = [];
  const count = CHAOS_DEFAULTS[mode];

  for (let index = 0; index < count; index += 1) {
    const eventType = rng.pick<ChaosEvent["type"]>([
      "fail-stage",
      "fail-unit",
      "inject-latency",
      "drop-dependency",
      "policy-conflict",
    ]);

    if (eventType === "fail-stage") {
      const strategy: RolloutStrategy = { type: "batched", batchSize: 1 };
      const stages = buildStages(plan, strategy);
      const stage = stages.length > 0 ? stages[rng.int(stages.length)] : undefined;
      if (stage) {
        events.push({ type: "fail-stage", stageId: stage.id });
      }
      continue;
    }

    if (eventType === "fail-unit") {
      if (unitIds.length > 0) {
        events.push({ type: "fail-unit", unitId: unitIds[rng.int(unitIds.length)] as string });
      }
      continue;
    }

    if (eventType === "inject-latency") {
      events.push({ type: "inject-latency", ms: 5 + rng.int(30) });
      continue;
    }

    if (eventType === "drop-dependency") {
      const dependentTask = tasks.find((task) => task.dependsOn.length > 0);
      const dependency = dependentTask?.dependsOn[0];
      if (dependentTask && dependency) {
        events.push({ type: "drop-dependency", edge: { from: dependency, to: dependentTask.id } });
      }
      continue;
    }

    events.push({ type: "policy-conflict", rule: `chaos-conflict-${index + 1}` });
  }

  return events;
}

function applyChaosEvent(plan: GlobalPlan, event: ChaosEvent): GlobalPlan {
  const next = clone(plan);

  if (event.type === "fail-unit") {
    next.tasks = next.tasks.map((task) => task.repoId === event.unitId
      ? { ...task, action: `verify-fail:${task.id}` }
      : task);
    return next;
  }

  if (event.type === "fail-stage") {
    const strategy: RolloutStrategy = { type: "batched", batchSize: 1 };
    const stages = buildStages(next, strategy);
    const stage = stages.find((entry) => entry.id === event.stageId);
    if (!stage) {
      return next;
    }

    const failingUnit = stage.units[0];
    next.tasks = next.tasks.map((task) => task.repoId === failingUnit
      ? { ...task, action: `verify-fail:${task.id}` }
      : task);
    return next;
  }

  if (event.type === "drop-dependency") {
    next.tasks = next.tasks.map((task) => task.id !== event.edge.to
      ? task
      : {
        ...task,
        dependsOn: task.dependsOn.filter((dependency) => dependency !== event.edge.from),
      });
    return next;
  }

  return next;
}

function injectChaosPolicy(base: PolicyState, events: ChaosEvent[]): PolicyState {
  const policies = clone(base);

  for (const event of events) {
    if (event.type !== "policy-conflict") {
      continue;
    }

    policies.push(makeCompiledPolicy(`chaos-${event.rule}`, "environment", [
      {
        id: `rule-${event.rule}`,
        kind: "deny-action-prefix",
        effect: "deny",
        actionPrefix: "set:",
      },
    ]));
  }

  return policies;
}

export function injectChaos(plan: GlobalPlan, mode: ChaosMode, seed: number, iteration: number): { plan: GlobalPlan; events: ChaosEvent[] } {
  const rng = new SeededRandom(combineSeed(seed, `chaos:${iteration}:${mode}`));
  const events = chooseChaosEvents(plan, mode, rng);

  let nextPlan = clone(plan);
  for (const event of events) {
    nextPlan = applyChaosEvent(nextPlan, event);
  }

  return {
    plan: nextPlan,
    events,
  };
}

function parseSetAction(action: string, state: Record<string, unknown>): Record<string, unknown> {
  if (!action.startsWith("set:")) {
    return clone(state);
  }

  const payload = action.slice("set:".length).trim();
  const [pathValue, valueRaw] = payload.split("=");
  if (!pathValue || typeof valueRaw === "undefined") {
    return clone(state);
  }

  const segments = pathValue.split(".").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (segments.length === 0) {
    return clone(state);
  }

  const next = clone(state);
  let cursor: Record<string, unknown> = next;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const existing = cursor[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1] as string] = valueRaw.trim();
  return next;
}

function buildChaosExecutor(events: ChaosEvent[]): ExecuteTask | undefined {
  if (events.length === 0) {
    return undefined;
  }

  const latency = events
    .filter((event): event is Extract<ChaosEvent, { type: "inject-latency" }> => event.type === "inject-latency")
    .reduce((sum, event) => sum + event.ms, 0);

  return async (task, repoState, _repoId, _allStates, mode) => {
    if (task.action.startsWith("verify-fail:")) {
      throw new Error(`Chaos failure at ${task.id}`);
    }

    const nextState = parseSetAction(task.action, repoState);
    if (latency > 0) {
      const meta = (nextState.meta && typeof nextState.meta === "object" && !Array.isArray(nextState.meta))
        ? nextState.meta as Record<string, unknown>
        : {};
      nextState.meta = {
        ...meta,
        chaosLatencyMs: latency,
      };
    }

    return nextState;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExecutionBlockedError(error: unknown): boolean {
  return errorMessage(error).startsWith("Global execution blocked:");
}

async function runSimulationSafely(
  plan: GlobalPlan,
  repos: Repo[],
  policies: PolicyState,
  state: GlobalState,
  executeTask?: ExecuteTask
): Promise<SafeSimulationResult> {
  try {
    const simulated = await simulatePlan(plan, {
      repos: clone(repos),
      policies: clone(policies),
      ...(executeTask ? { executeTask } : {}),
    });

    return {
      finalState: simulated.finalState,
      blocked: false,
    };
  } catch (error) {
    if (!isExecutionBlockedError(error)) {
      throw error;
    }

    return {
      finalState: clone(state),
      blocked: true,
      blockReason: errorMessage(error),
    };
  }
}

async function runExecutionSafely(
  plan: GlobalPlan,
  repos: Repo[],
  policies: PolicyState,
  state: GlobalState,
  executeTask?: ExecuteTask
): Promise<SafeExecutionResult> {
  try {
    const executed = await executeGlobalPlan(plan, {
      repos: clone(repos),
      policies: clone(policies),
      ...(executeTask ? { executeTask } : {}),
    });

    return {
      success: executed.success,
      rolledBack: executed.rolledBack,
      finalStates: executed.finalStates,
      trace: executed.trace.deterministicTrace,
      blocked: false,
    };
  } catch (error) {
    if (!isExecutionBlockedError(error)) {
      throw error;
    }

    return {
      success: false,
      rolledBack: false,
      finalStates: clone(state),
      blocked: true,
      blockReason: errorMessage(error),
    };
  }
}

async function detectNondeterminism(input: ExecutionInput, policies: PolicyState, executeTask?: ExecuteTask): Promise<boolean> {
  const fingerprints: string[] = [];
  const repos = buildReposForPlan(input.plan, input.state);

  for (let run = 0; run < 5; run += 1) {
    const result = await runExecutionSafely(clone(input.plan), repos, policies, input.state, executeTask);

    fingerprints.push(stableStringify({
      success: result.success,
      rolledBack: result.rolledBack,
      blocked: result.blocked,
      blockReason: result.blockReason ?? "",
      finalHash: hashGlobalState(result.finalStates),
      traceHash: result.trace?.finalStateHash ?? "",
    }));
  }

  return !fingerprints.every((fingerprint) => fingerprint === fingerprints[0]);
}

function buildPlannerPlan(globalPlan: GlobalPlan): Plan {
  const tasks: Task[] = globalPlan.tasks.map((task, index) => ({
    id: task.id,
    title: task.id,
    type: index === 0 ? "analysis" : index === globalPlan.tasks.length - 1 ? "enforce" : "refactor",
    dependsOn: sortedUnique(task.dependsOn),
    successCriteria: [`${task.id}:ok`],
  }));

  return {
    id: globalPlan.id,
    title: globalPlan.id,
    derivedFrom: "manual",
    status: "draft",
    goalRefs: ["property-test"],
    tasks,
  };
}

function buildMemoryOutcome(plan: Plan): StrategyOutcome {
  return {
    strategyId: "s-minimal",
    strategyType: "minimal",
    plan,
    patches: [],
    diagnostics: [],
    validation: {
      passed: true,
      diagnostics: [],
      conflicts: [],
      invariantChecks: [],
      errors: [],
    },
    metrics: {
      filesChanged: 0,
      patchesCount: 0,
      remainingViolations: 0,
      introducedErrors: 0,
    },
    success: true,
    fileChanges: [],
    previewHash: hashValue(plan.id),
  };
}

async function verifyMemoryValidity(ctx: InvariantContext): Promise<boolean> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choir-property-memory-"));

  try {
    const plan = buildPlannerPlan(ctx.chaoticPlan);
    const controlPlane: ControlPlane = {
      version: CONTROL_PLANE_VERSION,
      mission: "property-memory",
      vision: "property-memory",
      intent: {
        goals: ["property-test"],
        constraints: [],
        "non-goals": [],
      },
      policy: {
        rules: [],
      },
      execution: {
        plans: [plan],
      },
    };

    const state = createEmptyStatePlane();
    const signature = buildSignature(controlPlane, state);
    const outcome = buildMemoryOutcome(plan);

    recordStrategy(root, signature, outcome, { deterministic: true });
    const memory = readStrategyMemory(root);
    const reusable = findMatchingStrategies(signature, memory).filter((entry) => canReuse(entry));
    const selected = selectFromMemory(reusable);

    if (!selected) {
      return true;
    }

    return validatePlanStillApplies(selected.plan, state, {
      root,
      expectedPlanId: plan.id,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function hasDeniedAction(plan: GlobalPlan, policies: PolicyState): boolean {
  const denyPrefixes = policies
    .flatMap((policy) => policy.rules)
    .filter((rule): rule is Extract<GlobalPolicyRule, { kind: "deny-action-prefix" }> => rule.kind === "deny-action-prefix")
    .map((rule) => rule.actionPrefix);

  if (denyPrefixes.length === 0) {
    return false;
  }

  return plan.tasks.some((task) => denyPrefixes.some((prefix) => task.action.startsWith(prefix)));
}

async function verifyStrategyDeterminism(ctx: InvariantContext): Promise<boolean> {
  const base = clone(ctx.chaoticPlan);
  const variant = clone(ctx.chaoticPlan);
  variant.id = `${ctx.chaoticPlan.id}-variant`;
  variant.tasks = variant.tasks.map((task, index) => ({
    ...task,
    action: index === variant.tasks.length - 1 ? `set:meta.variant=${task.repoId}` : task.action,
  }));

  const repos = buildReposForPlan(base, ctx.input.state);
  const runComparison = async (): Promise<{ ok: true; result: Awaited<ReturnType<typeof compareStrategies>> } | { ok: false; error: string }> => {
    try {
      const result = await compareStrategies([base, variant], {
        repos: clone(repos),
        policies: clone(ctx.policies),
        ...(ctx.executeTask ? { executeTask: ctx.executeTask } : {}),
      });
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  };

  const first = await runComparison();
  const second = await runComparison();

  if (!first.ok || !second.ok) {
    return !first.ok && !second.ok && first.error === second.error;
  }

  return first.result.bestStrategy === second.result.bestStrategy
    && stableStringify(first.result.metrics) === stableStringify(second.result.metrics)
    && stableStringify(first.result.ranking) === stableStringify(second.result.ranking);
}

async function verifyRollbackIntegrity(ctx: InvariantContext): Promise<boolean> {
  const failingPlan = clone(ctx.chaoticPlan);
  const firstTask = [...failingPlan.tasks].sort((left, right) => left.id.localeCompare(right.id))[0];
  if (!firstTask) {
    return true;
  }

  firstTask.action = `verify-fail:${firstTask.id}`;
  const repos = buildReposForPlan(failingPlan, ctx.input.state);
  const executeTask = buildChaosExecutor([{ type: "fail-unit", unitId: firstTask.repoId }]);

  const failed = await runExecutionSafely(failingPlan, repos, ctx.policies, ctx.input.state, executeTask);

  return hashGlobalState(failed.finalStates) === hashGlobalState(ctx.input.state);
}

function hasMissingRequiredPrefix(plan: GlobalPlan, policies: PolicyState): boolean {
  const tasksByRepo = new Map<string, GlobalPlanTask[]>();
  for (const task of plan.tasks) {
    const existing = tasksByRepo.get(task.repoId) ?? [];
    existing.push(task);
    tasksByRepo.set(task.repoId, existing);
  }

  for (const rule of policies.flatMap((policy) => policy.rules)) {
    if (rule.kind !== "require-repo-action-prefix") {
      continue;
    }

    const repoIds = sortedUnique(rule.repoIds ?? plan.tasks.map((task) => task.repoId));
    for (const repoId of repoIds) {
      const repoTasks = tasksByRepo.get(repoId) ?? [];
      const hasPrefix = repoTasks.some((task) => task.action.startsWith(rule.actionPrefix));
      if (!hasPrefix) {
        return true;
      }
    }
  }

  return false;
}

const invariants: Record<SystemInvariant, InvariantCheck> = {
  "determinism": async (ctx) => !(await detectNondeterminism(ctx.input, ctx.policies, ctx.executeTask)),
  "replay-consistency": async (ctx) => {
    if (!ctx.executionSuccess) {
      return true;
    }

    if (!ctx.trace) {
      return false;
    }

    return hashGlobalState(replay(ctx.trace)) === hashGlobalState(ctx.executionState);
  },
  "simulation-equivalence": async (ctx) => {
    if (!ctx.executionSuccess) {
      return true;
    }

    return hashGlobalState(ctx.simulatedState) === hashGlobalState(ctx.executionState);
  },
  "rollback-integrity": verifyRollbackIntegrity,
  "policy-enforcement": async (ctx) => {
    const blockedByPolicy = hasDeniedAction(ctx.chaoticPlan, ctx.policies)
      || hasMissingRequiredPrefix(ctx.chaoticPlan, ctx.policies);
    return blockedByPolicy ? !ctx.executionSuccess : true;
  },
  "strategy-determinism": verifyStrategyDeterminism,
  "memory-validity": verifyMemoryValidity,
};

async function verifyAllInvariants(ctx: InvariantContext): Promise<string[]> {
  const broken: string[] = [];

  for (const [name, check] of Object.entries(invariants) as Array<[SystemInvariant, InvariantCheck]>) {
    const ok = await check(ctx);
    if (!ok) {
      broken.push(name);
    }
  }

  return broken;
}

async function evaluateFailure(candidate: GeneratedCase, mode: ChaosMode, seed: number, iteration: number): Promise<{ failed: boolean; broken: string[] }> {
  const chaosApplied = injectChaos(candidate.input.plan, mode, seed, iteration);
  const chaoticPlan = chaosApplied.plan;
  const policies = injectChaosPolicy(candidate.input.policies, chaosApplied.events);
  const repos = buildReposForPlan(chaoticPlan, candidate.input.state);
  const executeTask = buildChaosExecutor(chaosApplied.events);
  const simulated = await runSimulationSafely(chaoticPlan, repos, policies, candidate.input.state, executeTask);
  const executed = await runExecutionSafely(chaoticPlan, repos, policies, candidate.input.state, executeTask);

  const broken = await verifyAllInvariants({
    iteration,
    seed,
    input: {
      plan: chaosApplied.plan,
      state: clone(candidate.input.state),
      policies: clone(policies),
      dependencyGraph: buildRollbackDependencyGraph(chaoticPlan),
    },
    generated: {
      input: candidate.input,
      profile: candidate.profile,
      chaosEvents: chaosApplied.events,
    },
    chaoticPlan,
    simulatedState: simulated.finalState,
    executionState: executed.finalStates,
    executionSuccess: executed.success,
    trace: executed.trace,
    repos,
    policies,
    ...(executeTask ? { executeTask } : {}),
  });

  return {
    failed: broken.length > 0,
    broken,
  };
}

export async function shrinkFailure(
  testCase: GeneratedCase,
  mode: ChaosMode,
  seed: number,
  iteration: number
): Promise<GeneratedCase> {
  let current = clone(testCase);

  const reduceTasks = async (): Promise<void> => {
    let changed = true;
    while (changed) {
      changed = false;
      const tasks = [...current.input.plan.tasks].sort((left, right) => left.id.localeCompare(right.id));
      for (let index = tasks.length - 1; index >= 0; index -= 1) {
        const task = tasks[index];
        if (!task) {
          continue;
        }

        const candidate = clone(current);
        candidate.input.plan.tasks = candidate.input.plan.tasks
          .filter((entry) => entry.id !== task.id)
          .map((entry) => ({
            ...entry,
            dependsOn: entry.dependsOn.filter((dependency) => dependency !== task.id),
          }));
        candidate.input.state = Object.fromEntries(
          Object.entries(candidate.input.state).filter(([repoId]) => candidate.input.plan.tasks.some((entry) => entry.repoId === repoId))
        );

        const evaluated = await evaluateFailure(candidate, mode, seed, iteration);
        if (evaluated.failed) {
          current = candidate;
          changed = true;
          break;
        }
      }
    }
  };

  const reducePolicies = async (): Promise<void> => {
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = current.input.policies.length - 1; index >= 0; index -= 1) {
        const candidate = clone(current);
        candidate.input.policies.splice(index, 1);
        const evaluated = await evaluateFailure(candidate, mode, seed, iteration);
        if (evaluated.failed) {
          current = candidate;
          changed = true;
          break;
        }
      }
    }
  };

  await reduceTasks();
  await reducePolicies();

  return current;
}

async function runSingleIteration(iteration: number, seed: number, mode: ChaosMode): Promise<{
  broken: string[];
  generated: GeneratedCase;
}> {
  const generated = generateTestCase(iteration, seed);
  const chaosApplied = injectChaos(generated.input.plan, mode, seed, iteration);
  generated.chaosEvents = chaosApplied.events;
  const chaoticPlan = chaosApplied.plan;

  const policies = injectChaosPolicy(generated.input.policies, chaosApplied.events);
  const input: ExecutionInput = {
    plan: chaoticPlan,
    state: clone(generated.input.state),
    policies,
    dependencyGraph: buildRollbackDependencyGraph(chaoticPlan),
  };

  const repos = buildReposForPlan(chaoticPlan, input.state);
  const executeTask = buildChaosExecutor(chaosApplied.events);

  const simulated = await runSimulationSafely(chaoticPlan, repos, policies, input.state, executeTask);
  const executed = await runExecutionSafely(chaoticPlan, repos, policies, input.state, executeTask);

  const broken = await verifyAllInvariants({
    iteration,
    seed,
    input,
    generated,
    chaoticPlan,
    simulatedState: simulated.finalState,
    executionState: executed.finalStates,
    executionSuccess: executed.success,
    trace: executed.trace,
    repos,
    policies,
    ...(executeTask ? { executeTask } : {}),
  });

  return {
    broken,
    generated,
  };
}

function reportFingerprint(report: PropertyRunResult): string {
  return hashValue({
    totalRuns: report.totalRuns,
    failures: report.failures,
    invariantsBroken: [...report.invariantsBroken].sort((left, right) => left.localeCompare(right)),
    minimalFailureCase: report.minimalFailureCase,
    mode: report.mode,
    seed: report.seed,
    failedAtIteration: report.failedAtIteration,
  });
}

async function runDeterministicPass(
  iterations: number,
  seed: number,
  mode: ChaosMode
): Promise<PropertyRunResult> {
  let failures = 0;
  const invariantsBroken = new Set<string>();
  let minimalFailureCase: object | undefined;
  let failedAtIteration: number | undefined;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const run = await runSingleIteration(iteration, seed, mode);
    if (run.broken.length === 0) {
      continue;
    }

    failures += 1;
    run.broken.forEach((name) => invariantsBroken.add(name));

    if (!minimalFailureCase) {
      const shrunk = await shrinkFailure(run.generated, mode, seed, iteration);
      minimalFailureCase = {
        iteration,
        profile: shrunk.profile,
        inputHash: hashInput(shrunk.input),
        plan: shrunk.input.plan,
        policy: shrunk.input.policies,
        state: shrunk.input.state,
        chaosEvents: shrunk.chaosEvents,
      };
      failedAtIteration = iteration;
    }
  }

  return {
    totalRuns: iterations,
    failures,
    invariantsBroken: [...invariantsBroken].sort((left, right) => left.localeCompare(right)),
    ...(minimalFailureCase ? { minimalFailureCase } : {}),
    mode,
    seed,
    ...(typeof failedAtIteration === "number" ? { failedAtIteration } : {}),
  };
}

export async function runPropertyTest(iterations: number, options: PropertyRunOptions = {}): Promise<PropertyRunResult> {
  const seed = options.seed ?? generatorState.seed;
  const mode = options.chaosMode ?? "none";
  const report = await runDeterministicPass(iterations, seed, mode);
  const rerun = await runDeterministicPass(iterations, seed, mode);

  if (reportFingerprint(report) !== reportFingerprint(rerun)) {
    const unstable: PropertyRunResult = {
      ...report,
      failures: report.failures + 1,
      invariantsBroken: sortedUnique([...report.invariantsBroken, "nondeterministic-harness"]),
    };

    if (options.throwOnFailure !== false) {
      throw new Error(formatChaosTestReport(unstable));
    }

    return unstable;
  }

  if (report.failures > 0 && options.throwOnFailure !== false) {
    throw new Error(formatChaosTestReport(report));
  }

  return report;
}

export async function runChaosTest(mode: ChaosMode, iterations: number, options: PropertyRunOptions = {}): Promise<PropertyRunResult> {
  return runPropertyTest(iterations, {
    ...options,
    chaosMode: mode,
  });
}

export function formatChaosTestReport(report: ChaosTestReport): string {
  const status = report.failures === 0 ? "PASS" : "FAIL";
  const lines = [
    `${status} property+chaos harness`,
    `- mode: ${report.mode}`,
    `- seed: ${report.seed}`,
    `- totalRuns: ${report.totalRuns}`,
    `- failures: ${report.failures}`,
    `- invariantsBroken: ${report.invariantsBroken.length === 0 ? "none" : report.invariantsBroken.join(", ")}`,
  ];

  if (report.minimalFailureCase) {
    lines.push("", "Minimal failure case:", stableStringify(report.minimalFailureCase));
  }

  return lines.join("\n");
}

export function ciIterationLimit(defaultIterations: number, ciIterations: number): number {
  if (process.env.CI) {
    return ciIterations;
  }

  return defaultIterations;
}
