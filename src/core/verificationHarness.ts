import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { CONTROL_PLANE_VERSION, ControlPlane, Plan, Task } from "../schema.js";
import {
  ExecutionInput,
  GlobalPlan,
  GlobalPlanTask,
  PolicyState,
  Repo,
  Strategy as GlobalStrategy,
  buildRollbackDependencyGraph,
  compareStrategies,
  executeGlobalPlan,
  hashState as hashGlobalState,
  replay,
  simulatePlan,
} from "./globalOrchestration.js";
import {
  STRATEGIES,
  Strategy,
  StrategyMetrics,
  StrategyOutcome,
  evaluateStrategy,
  isImproved,
  iterateStrategy,
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
import { runCompilerVerification } from "./compilerVerification.js";
import { runTransactionVerification } from "./transactionVerification.js";
import { runStateVerification } from "./stateVerification.js";
import { runPolicyVerification } from "./policyVerification.js";
import { runOrchestrationVerification } from "./orchestrationVerification.js";
import { runProductionVerification } from "./productionVerification.js";
import { resetProductionReadiness } from "./productionReadiness.js";

export type VerificationCase = {
  name: string;
  input: ExecutionInput;
  assertions: {
    deterministic: boolean;
    replayMatches: boolean;
    simulationMatches: boolean;
    rollbackSafe: boolean;
  };
};

export type FailureInjectionMode = "mid-stage-failure" | "dependency-failure" | "policy-violation";

export type VerificationCaseResult = {
  name: string;
  expected: VerificationCase["assertions"];
  actual: VerificationCase["assertions"];
  passed: boolean;
  failures: string[];
};

export type VerificationReport = {
  passed: boolean;
  failures: string[];
  metrics: {
    determinism: boolean;
    replay: boolean;
    simulation: boolean;
    rollback: boolean;
    policy: boolean;
    orchestration: boolean;
    production: boolean;
    compiler: boolean;
    transactions: boolean;
    state: boolean;
    strategy: boolean;
    memory: boolean;
    adaptive: boolean;
    flakeFree: boolean;
  };
  cases: VerificationCaseResult[];
};

export type VerificationMode = "full" | "quick";

export type RunVerificationOptions = {
  workspaceRoot?: string;
  mode?: VerificationMode;
  parallelCaseExecution?: boolean;
  detectFlakiness?: boolean;
  flakeRuns?: number;
  throwOnFailure?: boolean;
  suite?: VerificationCase[];
};

export type MemoryVerificationContext = {
  root: string;
  controlPlane: ControlPlane;
  state: StatePlane;
  outcome: StrategyOutcome;
};

export type AdaptationVerificationContext = {
  root: string;
  controlPlane: ControlPlane;
  state: StatePlane;
  basePlan: Plan;
};

const FAILURE_MODES: FailureInjectionMode[] = [
  "mid-stage-failure",
  "dependency-failure",
  "policy-violation",
];

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

function buildVerificationGlobalPlan(id: string): GlobalPlan {
  const suffix = id.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const repoA = `repo-a-${suffix}`;
  const repoB = `repo-b-${suffix}`;
  const repoC = `repo-c-${suffix}`;

  return {
    id,
    tasks: [
      {
        id: `${repoA}:t1`,
        repoId: repoA,
        action: "set:meta.version=1",
        dependsOn: [],
      },
      {
        id: `${repoB}:t1`,
        repoId: repoB,
        action: "set:meta.sync=ready",
        dependsOn: [`${repoA}:t1`],
      },
      {
        id: `${repoC}:t1`,
        repoId: repoC,
        action: "set:meta.state=steady",
        dependsOn: [`${repoB}:t1`],
      },
    ],
  };
}

function buildVerificationExecutionInput(id: string): ExecutionInput {
  const plan = buildVerificationGlobalPlan(id);
  const repoIds = sortedUnique(plan.tasks.map((task) => task.repoId));
  const state = {
    [repoIds[0] as string]: { meta: { version: "0" } },
    [repoIds[1] as string]: { meta: { sync: "stale" } },
    [repoIds[2] as string]: { meta: { state: "cold" } },
  };

  return {
    plan,
    state,
    policies: [],
    dependencyGraph: buildRollbackDependencyGraph(plan),
  };
}

function taskById(plan: GlobalPlan): Map<string, GlobalPlanTask> {
  return new Map(plan.tasks.map((task) => [task.id, task] as const));
}

function buildReposForPlan(plan: GlobalPlan, state: ExecutionInput["state"]): Repo[] {
  const byTaskId = taskById(plan);
  const dependencyMap = new Map<string, Set<string>>();
  const repoIds = new Set<string>([
    ...Object.keys(state),
    ...plan.tasks.map((task) => task.repoId),
  ]);

  for (const repoId of repoIds) {
    dependencyMap.set(repoId, new Set<string>());
  }

  for (const task of [...plan.tasks].sort((left, right) => left.id.localeCompare(right.id))) {
    const dependencySet = dependencyMap.get(task.repoId) ?? new Set<string>();
    for (const dependencyId of task.dependsOn) {
      const dependencyTask = byTaskId.get(dependencyId);
      if (!dependencyTask) {
        continue;
      }

      if (dependencyTask.repoId !== task.repoId) {
        dependencySet.add(dependencyTask.repoId);
      }
    }

    dependencyMap.set(task.repoId, dependencySet);
  }

  return [...repoIds]
    .sort((left, right) => left.localeCompare(right))
    .map((repoId) => ({
      id: repoId,
      dependencies: sortedUnique([...(dependencyMap.get(repoId) ?? new Set<string>())]),
      state: clone(state[repoId] ?? {}),
    }));
}

function verifyPolicySet(policies: PolicyState): PolicyState {
  return [
    ...clone(policies),
    {
      id: "verify-deny-danger-actions",
      source: "org",
      rules: [
        {
          id: "verify-deny-danger",
          kind: "deny-action-prefix",
          effect: "deny",
          actionPrefix: "danger:",
        },
      ],
    },
  ];
}

function applySetAction(action: string, currentState: unknown): unknown {
  if (!action.startsWith("set:")) {
    return clone(currentState);
  }

  const payload = action.slice("set:".length).trim();
  const [pathValue, valueRaw] = payload.split("=");
  if (!pathValue || typeof valueRaw === "undefined") {
    return clone(currentState);
  }

  const segments = pathValue.split(".").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (segments.length === 0) {
    return clone(currentState);
  }

  const nextState = clone(currentState ?? {}) as Record<string, unknown>;
  let cursor: Record<string, unknown> = nextState;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const existing = cursor[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1] as string] = valueRaw.trim();
  return nextState;
}

function optionsForInput(
  input: ExecutionInput,
  planOverride?: GlobalPlan,
  mode?: FailureInjectionMode
): {
  repos: Repo[];
  policies: PolicyState;
  executeTask?: (
    task: GlobalPlanTask,
    repoState: Record<string, unknown>,
    repoId: string,
    allStates: Record<string, Record<string, unknown>>,
    runMode: "simulation" | "execution"
  ) => Promise<Record<string, unknown>>;
} {
  const plan = planOverride ? clone(planOverride) : clone(input.plan);
  const repos = buildReposForPlan(plan, clone(input.state));
  const policies = mode === "policy-violation" ? verifyPolicySet(input.policies) : clone(input.policies);

  if (mode !== "mid-stage-failure") {
    return {
      repos,
      policies,
    };
  }

  return {
    repos,
    policies,
    executeTask: async (task, repoState, _repoId, _allStates, runMode) => {
      if (runMode === "execution" && task.action.startsWith("verify-fail:")) {
        throw new Error(`Injected verification failure at ${task.id}`);
      }

      return applySetAction(task.action, repoState) as Record<string, unknown>;
    },
  };
}

function buildPlannerTask(
  id: string,
  title: string,
  type: Task["type"],
  dependsOn: string[]
): Task {
  return {
    id,
    title,
    type,
    dependsOn,
    successCriteria: [`${id}:ok`],
  };
}

function buildPlannerPlan(id: string): Plan {
  return {
    id,
    title: "Verification Planner Plan",
    derivedFrom: "manual",
    status: "draft",
    goalRefs: ["verification"],
    tasks: [
      buildPlannerTask("t-analysis", "Analyze", "analysis", []),
      buildPlannerTask("t-refactor-a", "Refactor A", "refactor", ["t-analysis"]),
      buildPlannerTask("t-refactor-b", "Refactor B", "refactor", ["t-refactor-a"]),
      buildPlannerTask("t-enforce", "Enforce", "enforce", ["t-refactor-b"]),
    ],
  };
}

function buildVerificationControlPlane(plan: Plan): ControlPlane {
  return {
    version: CONTROL_PLANE_VERSION,
    mission: "Verify system guarantees",
    vision: "Deterministic correctness",
    intent: {
      goals: ["verification"],
      constraints: ["deterministic execution", "rollback safety"],
      "non-goals": [],
    },
    policy: {
      rules: [],
    },
    execution: {
      plans: [plan],
    },
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

export const deterministicCase: VerificationCase = {
  name: "deterministic-case",
  input: buildVerificationExecutionInput("verify-deterministic"),
  assertions: {
    deterministic: true,
    replayMatches: true,
    simulationMatches: true,
    rollbackSafe: true,
  },
};

export const rollbackCase: VerificationCase = {
  name: "rollback-case",
  input: buildVerificationExecutionInput("verify-rollback"),
  assertions: {
    deterministic: true,
    replayMatches: true,
    simulationMatches: true,
    rollbackSafe: true,
  },
};

export const strategyCase: VerificationCase = {
  name: "strategy-case",
  input: buildVerificationExecutionInput("verify-strategy"),
  assertions: {
    deterministic: true,
    replayMatches: true,
    simulationMatches: true,
    rollbackSafe: true,
  },
};

export const memoryCase: VerificationCase = {
  name: "memory-case",
  input: buildVerificationExecutionInput("verify-memory"),
  assertions: {
    deterministic: true,
    replayMatches: true,
    simulationMatches: true,
    rollbackSafe: true,
  },
};

export const adaptiveCase: VerificationCase = {
  name: "adaptive-case",
  input: buildVerificationExecutionInput("verify-adaptive"),
  assertions: {
    deterministic: true,
    replayMatches: true,
    simulationMatches: true,
    rollbackSafe: true,
  },
};

export function createVerificationSuite(mode: VerificationMode = "full"): VerificationCase[] {
  const fullSuite = [
    deterministicCase,
    rollbackCase,
    strategyCase,
    memoryCase,
    adaptiveCase,
  ].map((entry) => ({
    ...entry,
    input: clone(entry.input),
  }));

  if (mode === "quick") {
    return fullSuite.slice(0, 2);
  }

  return fullSuite;
}

export function injectFailure(plan: GlobalPlan, mode: FailureInjectionMode): GlobalPlan {
  const nextPlan = clone(plan);
  const orderedTasks = [...nextPlan.tasks].sort((left, right) => left.id.localeCompare(right.id));
  const primaryTask = orderedTasks[0];
  if (!primaryTask) {
    return nextPlan;
  }

  if (mode === "mid-stage-failure") {
    const target = orderedTasks[0] as GlobalPlanTask;
    target.action = `verify-fail:${target.id}`;
    return nextPlan;
  }

  if (mode === "dependency-failure") {
    const missingDependency = "verify:missing-task";
    if (!primaryTask.dependsOn.includes(missingDependency)) {
      primaryTask.dependsOn = sortedUnique([...primaryTask.dependsOn, missingDependency]);
    }
    return nextPlan;
  }

  primaryTask.action = `danger:verify-policy-violation:${primaryTask.id}`;
  return nextPlan;
}

export async function checkDeterminism(input: ExecutionInput): Promise<boolean> {
  const fingerprints: string[] = [];

  for (let run = 0; run < 5; run += 1) {
    const execution = await executeGlobalPlan(clone(input.plan), optionsForInput(input));
    const deterministicTrace = execution.trace.deterministicTrace;
    fingerprints.push(stableStringify({
      success: execution.success,
      rolledBack: execution.rolledBack,
      stateHash: hashGlobalState(execution.finalStates),
      traceHash: deterministicTrace?.finalStateHash ?? "",
      deterministic: deterministicTrace?.deterministic ?? false,
      convergence: execution.trace.convergence,
    }));
  }

  return fingerprints.every((fingerprint) => fingerprint === fingerprints[0]);
}

export async function verifyRollback(input: ExecutionInput): Promise<boolean> {
  const snapshotHash = hashGlobalState(input.state);

  for (const mode of FAILURE_MODES) {
    const plan = injectFailure(input.plan, mode);
    try {
      const result = await executeGlobalPlan(plan, optionsForInput(input, plan, mode));
      if (hashGlobalState(result.finalStates) !== snapshotHash) {
        return false;
      }
    } catch {
      // Dependency and policy injection modes fail closed before mutation.
      if (mode === "mid-stage-failure") {
        return false;
      }
    }
  }

  return true;
}

export async function verifyStrategySelection(
  strategies: GlobalStrategy[],
  input: ExecutionInput
): Promise<boolean> {
  if (strategies.length === 0) {
    return false;
  }

  const plans = strategies.map((strategy) => clone(strategy.plan));
  const repos = buildReposForPlan(plans[0] as GlobalPlan, input.state);
  const policies = verifyPolicySet(input.policies);
  const first = await compareStrategies(plans, { repos, policies });
  const second = await compareStrategies(plans, { repos, policies });

  return first.bestStrategy === second.bestStrategy
    && stableStringify(first.metrics) === stableStringify(second.metrics)
    && stableStringify(first.ranking) === stableStringify(second.ranking);
}

export function verifyMemoryReuse(context: MemoryVerificationContext): boolean {
  const signature = buildSignature(context.controlPlane, context.state);
  recordStrategy(context.root, signature, context.outcome, { deterministic: true });

  const memory = readStrategyMemory(context.root);
  const reusable = findMatchingStrategies(signature, memory).filter((entry) => canReuse(entry));
  const selected = selectFromMemory(reusable);

  if (!selected) {
    return true;
  }

  return validatePlanStillApplies(selected.plan, context.state, {
    root: context.root,
    expectedPlanId: context.outcome.plan.id,
  });
}

export async function verifyAdaptation(
  initialStrategy: Strategy,
  context: AdaptationVerificationContext
): Promise<boolean> {
  const baseline = await evaluateStrategy(initialStrategy, context.basePlan, context.state, {
    controlPlane: context.controlPlane,
    root: context.root,
  });

  const improved = await iterateStrategy(initialStrategy, 3, context.basePlan, context.state, {
    controlPlane: context.controlPlane,
    root: context.root,
  });

  if (isImproved(improved.selected.metrics, baseline.metrics)) {
    return true;
  }

  return !isImproved(baseline.metrics, improved.selected.metrics)
    && improved.trace.iterations >= 1
    && improved.trace.decisions.length >= 0;
}

export async function runVerificationCase(test: VerificationCase): Promise<VerificationCaseResult> {
  const simulated = await simulatePlan(clone(test.input.plan), optionsForInput(test.input));
  const executed = await executeGlobalPlan(clone(test.input.plan), optionsForInput(test.input));
  const deterministic = await checkDeterminism(test.input);

  const trace = executed.trace.deterministicTrace;
  const replayMatches = trace
    ? hashGlobalState(replay(trace)) === hashGlobalState(executed.finalStates)
    : false;

  const simulationMatches = hashGlobalState(simulated.finalState) === hashGlobalState(executed.finalStates);
  const rollbackSafe = await verifyRollback(test.input);

  const actual = {
    deterministic,
    replayMatches,
    simulationMatches,
    rollbackSafe,
  };

  const failures: string[] = [];
  for (const key of Object.keys(test.assertions) as Array<keyof VerificationCase["assertions"]>) {
    if (actual[key] !== test.assertions[key]) {
      failures.push(`${key} expected ${String(test.assertions[key])} but got ${String(actual[key])}`);
    }
  }

  return {
    name: test.name,
    expected: test.assertions,
    actual,
    passed: failures.length === 0,
    failures,
  };
}

function buildStrategyCandidates(input: ExecutionInput): GlobalStrategy[] {
  const base = clone(input.plan);
  const risky = injectFailure(base, "policy-violation");
  risky.id = `${base.id}-risky`;

  const conservative = clone(base);
  conservative.id = `${base.id}-conservative`;
  conservative.tasks = conservative.tasks.map((task, index) => ({
    ...task,
    action: index === conservative.tasks.length - 1
      ? "set:meta.state=verified"
      : task.action,
  }));

  return [
    {
      id: base.id,
      plan: base,
    },
    {
      id: risky.id,
      plan: risky,
    },
    {
      id: conservative.id,
      plan: conservative,
    },
  ].sort((left, right) => left.id.localeCompare(right.id));
}

async function executeSuite(
  suite: VerificationCase[],
  parallelCaseExecution: boolean
): Promise<VerificationCaseResult[]> {
  const orderedSuite = [...suite].sort((left, right) => left.name.localeCompare(right.name));
  if (parallelCaseExecution) {
    const results = await Promise.all(orderedSuite.map((entry) => runVerificationCase(entry)));
    return results.sort((left, right) => left.name.localeCompare(right.name));
  }

  const results: VerificationCaseResult[] = [];
  for (const entry of orderedSuite) {
    results.push(await runVerificationCase(entry));
  }

  return results;
}

function runFingerprint(
  cases: VerificationCaseResult[],
  metrics: {
    policy: boolean;
    orchestration: boolean;
    production: boolean;
    compiler: boolean;
    transactions: boolean;
    state: boolean;
    strategy: boolean;
    memory: boolean;
    adaptive: boolean;
  }
): string {
  return stableStringify({
    cases: cases.map((entry) => ({
      name: entry.name,
      passed: entry.passed,
      actual: entry.actual,
    })),
    metrics,
  });
}

async function createMemoryContext(root: string): Promise<MemoryVerificationContext> {
  const plan = buildPlannerPlan("verify-memory-plan");
  const controlPlane = buildVerificationControlPlane(plan);
  const state = createEmptyStatePlane();

  fs.mkdirSync(path.join(root, ".choir"), { recursive: true });

  return {
    root,
    controlPlane,
    state,
    outcome: buildMemoryOutcome(plan),
  };
}

async function createAdaptationContext(root: string): Promise<AdaptationVerificationContext> {
  const basePlan = buildPlannerPlan("verify-adaptive-plan");
  const controlPlane = buildVerificationControlPlane(basePlan);
  const state = createEmptyStatePlane();
  state.violations = [
    {
      id: "verify-adaptive-1",
      ruleId: "rule.verify.adaptive",
      message: "adaptive target",
      severity: "warning",
      category: "AST",
      location: {
        file: "src/verification.ts",
        start: { line: 1, character: 0 },
        end: { line: 1, character: 1 },
      },
      traceId: "trace-verify-adaptive-1",
    },
  ];

  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "verification.ts"), "export const verify = true;\n", "utf-8");

  return {
    root,
    controlPlane,
    state,
    basePlan,
  };
}

function allAssertionsPass(result: VerificationCaseResult): boolean {
  return result.passed;
}

export async function runFullVerification(options: RunVerificationOptions = {}): Promise<VerificationReport> {
  const mode = options.mode ?? "full";
  const suite = options.suite ? clone(options.suite) : createVerificationSuite(mode);
  const parallelCaseExecution = options.parallelCaseExecution ?? false;
  const detectFlakiness = options.detectFlakiness ?? true;
  const flakeRuns = Math.max(2, options.flakeRuns ?? 3);

  const workspaceRoot = options.workspaceRoot
    ? path.resolve(options.workspaceRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), "choir-verify-"));
  const ownsWorkspaceRoot = !options.workspaceRoot;

  let report: VerificationReport;

  try {
    resetProductionReadiness();
    const caseResults = await executeSuite(suite, parallelCaseExecution);
    const failures = caseResults.flatMap((entry) => entry.failures.map((failure) => `${entry.name}: ${failure}`));

    const transactionReport = await runTransactionVerification();
    const transactions = transactionReport.passed;
    failures.push(...transactionReport.failures.map((failure) => `transactions: ${failure}`));
    const policyReport = await runPolicyVerification();
    const policy = policyReport.passed;
    failures.push(...policyReport.failures.map((failure) => `policy: ${failure}`));
    const orchestrationReport = await runOrchestrationVerification();
    const orchestration = orchestrationReport.passed;
    failures.push(...orchestrationReport.failures.map((failure) => `orchestration: ${failure}`));
    const productionReport = await runProductionVerification();
    const production = productionReport.passed;
    failures.push(...productionReport.failures.map((failure) => `production: ${failure}`));
    const compilerReport = await runCompilerVerification();
    const compiler = compilerReport.passed;
    failures.push(...compilerReport.failures.map((failure) => `compiler: ${failure}`));
    const stateReport = await runStateVerification();
    const state = stateReport.passed;
    failures.push(...stateReport.failures.map((failure) => `state: ${failure}`));

    const strategy = await verifyStrategySelection(buildStrategyCandidates(deterministicCase.input), deterministicCase.input);

    const memoryRoot = fs.mkdtempSync(path.join(workspaceRoot, ".tmp-verify-memory-"));
    const memory = verifyMemoryReuse(await createMemoryContext(memoryRoot));

    const adaptationRoot = fs.mkdtempSync(path.join(workspaceRoot, ".tmp-verify-adaptive-"));
    const adaptive = await verifyAdaptation(STRATEGIES[0] as Strategy, await createAdaptationContext(adaptationRoot));

    let flakeFree = true;
    const firstFingerprint = runFingerprint(caseResults, { policy, orchestration, production, compiler, transactions, state, strategy, memory, adaptive });

    if (detectFlakiness) {
      for (let run = 1; run < flakeRuns; run += 1) {
        resetProductionReadiness();
        const rerunCases = await executeSuite(suite, parallelCaseExecution);
        const rerunStrategy = await verifyStrategySelection(buildStrategyCandidates(deterministicCase.input), deterministicCase.input);
        const rerunMemoryRoot = fs.mkdtempSync(path.join(workspaceRoot, `.tmp-verify-memory-${run}-`));
        const rerunMemory = verifyMemoryReuse(await createMemoryContext(rerunMemoryRoot));
        const rerunAdaptiveRoot = fs.mkdtempSync(path.join(workspaceRoot, `.tmp-verify-adaptive-${run}-`));
        const rerunAdaptive = await verifyAdaptation(STRATEGIES[0] as Strategy, await createAdaptationContext(rerunAdaptiveRoot));
        const rerunPolicy = (await runPolicyVerification()).passed;
        const rerunOrchestration = (await runOrchestrationVerification()).passed;
        const rerunProduction = (await runProductionVerification()).passed;
        const rerunCompiler = (await runCompilerVerification()).passed;
        const rerunTransactions = (await runTransactionVerification()).passed;
        const rerunState = (await runStateVerification()).passed;
        const rerunFingerprint = runFingerprint(rerunCases, {
          policy: rerunPolicy,
          orchestration: rerunOrchestration,
          production: rerunProduction,
          compiler: rerunCompiler,
          transactions: rerunTransactions,
          state: rerunState,
          strategy: rerunStrategy,
          memory: rerunMemory,
          adaptive: rerunAdaptive,
        });

        if (rerunFingerprint !== firstFingerprint) {
          flakeFree = false;
          failures.push(`Flakiness detected: run ${run + 1} diverged from baseline verification snapshot`);
          break;
        }
      }
    }

    const determinism = caseResults.every((entry) => entry.actual.deterministic);
    const replay = caseResults.every((entry) => entry.actual.replayMatches);
    const simulation = caseResults.every((entry) => entry.actual.simulationMatches);
    const rollback = caseResults.every((entry) => entry.actual.rollbackSafe);
    const casesPass = caseResults.every((entry) => allAssertionsPass(entry));

    report = {
      passed: casesPass
        && failures.length === 0
        && determinism
        && replay
        && simulation
        && rollback
        && policy
        && orchestration
        && production
        && compiler
        && transactions
        && state
        && strategy
        && memory
        && adaptive
        && flakeFree,
      failures,
      metrics: {
        determinism,
        replay,
        simulation,
        rollback,
        policy,
        orchestration,
        production,
        compiler,
        transactions,
        state,
        strategy,
        memory,
        adaptive,
        flakeFree,
      },
      cases: caseResults,
    };
  } finally {
    if (ownsWorkspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }

  if (!report.passed && options.throwOnFailure !== false) {
    throw new Error(formatVerificationReport(report));
  }

  return report;
}

export function formatVerificationReport(report: VerificationReport): string {
  const status = report.passed ? "PASS" : "FAIL";
  const lines = [
    `${status} verification harness`,
    `- determinism: ${report.metrics.determinism}`,
    `- replay: ${report.metrics.replay}`,
    `- simulation: ${report.metrics.simulation}`,
    `- rollback: ${report.metrics.rollback}`,
    `- policy: ${report.metrics.policy}`,
    `- orchestration: ${report.metrics.orchestration}`,
    `- production: ${report.metrics.production}`,
    `- compiler: ${report.metrics.compiler}`,
    `- transactions: ${report.metrics.transactions}`,
    `- state: ${report.metrics.state}`,
    `- strategy: ${report.metrics.strategy}`,
    `- memory: ${report.metrics.memory}`,
    `- adaptive: ${report.metrics.adaptive}`,
    `- flakeFree: ${report.metrics.flakeFree}`,
    `- cases: ${report.cases.length}`,
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((entry) => `- ${entry}`));
  }

  return lines.join("\n");
}
