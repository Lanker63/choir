import fs from "fs";
import os from "os";
import path from "path";
import {
  deterministicHash,
  deterministicId,
  stableStringify,
  SeededRandom,
} from "../../../core/deterministicCore.js";
import {
  executeDeterministic,
  executeGlobalPlan,
  replay,
  simulatePlan,
  type CompiledPolicy,
  type ExecuteGlobalPlanOptions,
  type ExecutionInput,
  type GlobalExecutionResult,
  type GlobalPlan,
  type GlobalPlanTask,
  type Repo,
} from "../../../core/globalOrchestration.js";
import { runContractVerification, type ContractVerificationReport } from "./contractVerification.js";
import { runFullVerification, type VerificationReport } from "./verificationHarness.js";
import { runDeterminismVerification, type DeterminismVerificationReport } from "./determinismVerification.js";
import { runPolicyVerification, type PolicyVerificationReport } from "./policyVerification.js";
import { runStateVerification, type StateVerificationReport } from "./stateVerification.js";
import { runOrchestrationVerification, type OrchestrationVerificationReport } from "./orchestrationVerification.js";
import { runTransactionVerification, type TransactionVerificationReport } from "./transactionVerification.js";
import { runCompilerVerification, type CompilerVerificationReport } from "./compilerVerification.js";
import { runRuntimeGovernanceVerification, type RuntimeGovernanceVerificationReport } from "./runtimeGovernanceVerification.js";
import { runChaosTest, type PropertyRunResult } from "./propertyChaosHarness.js";
import {
  continuousVerify,
  currentObservabilityFingerprint,
  getProductionSnapshot,
  resetProductionReadiness,
  runLoadTest,
  validatePerformance,
} from "../../../core/productionReadiness.js";
import { approvePendingDiff, listPendingApprovals } from "../../../core/state.js";
import { createReplica, mergeStates, sync, type SystemState as ReplicaSystemState } from "../../../core/distributedSync.js";

export type SystemInvariant =
  | "simulate == execute"
  | "replay == execution"
  | "rollback restores exact state"
  | "policy always enforced"
  | "determinism holds globally";

export type FullSystemVerificationMode = "quick" | "full";

export type InvariantResult = {
  invariant: SystemInvariant;
  passed: boolean;
  detail: string;
};

export type HardeningPassResult = {
  id: number;
  name: string;
  passed: boolean;
  detail: string;
  failures: string[];
};

export type DefensiveExecutionResult = {
  accepted: boolean;
  errors: string[];
  result?: GlobalExecutionResult;
};

export type ContractCoverageResult = {
  passed: boolean;
  report: ContractVerificationReport;
  sectionsPassed: number;
  sectionsTotal: number;
};

export type DeterminismLockResult = {
  passed: boolean;
  fingerprints: string[];
  baselineFile: string;
  localFingerprint: string;
  ciFingerprint?: string;
  detail: string;
};

export type ProofArtifact = {
  path: string;
  proofHash: string;
  passed: boolean;
};

export type FullSystemVerificationReport = {
  passed: boolean;
  mode: FullSystemVerificationMode;
  contractCoverage: {
    passed: boolean;
    sectionsPassed: number;
    sectionsTotal: number;
  };
  invariants: InvariantResult[];
  passes: HardeningPassResult[];
  proofArtifacts: string[];
  failures: string[];
};

export type RunFullSystemVerificationOptions = {
  mode?: FullSystemVerificationMode;
  workspaceRoot?: string;
  throwOnFailure?: boolean;
};

type VerificationBundle = {
  full: VerificationReport;
  determinism: DeterminismVerificationReport;
  policy: PolicyVerificationReport;
  state: StateVerificationReport;
  orchestration: OrchestrationVerificationReport;
  runtimeGovernance: RuntimeGovernanceVerificationReport;
  transactions: TransactionVerificationReport;
  compiler: CompilerVerificationReport;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function hashValue(value: unknown): string {
  return deterministicHash(value);
}

function modeValue(mode: FullSystemVerificationMode, fullValue: number, quickValue: number): number {
  return mode === "full" ? fullValue : quickValue;
}

function ensureDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendFailure(failures: string[], prefix: string, errors: string[]): void {
  for (const error of errors) {
    failures.push(`${prefix}: ${error}`);
  }
}

function defaultPolicies(): CompiledPolicy[] {
  return [];
}

function requireApprovalPolicy(): CompiledPolicy[] {
  return [
    {
      id: "full-system-require-approval",
      source: "org",
      rules: [
        {
          id: "full-system-require-set",
          kind: "deny-action-prefix",
          effect: "require-approval",
          actionPrefix: "set:",
          priority: 10,
        },
      ],
    },
  ];
}

function denyDangerPolicy(): CompiledPolicy[] {
  return [
    {
      id: "full-system-require-danger",
      source: "repo",
      rules: [
        {
          id: "full-system-require-danger-rule",
          kind: "deny-action-prefix",
          effect: "require-approval",
          actionPrefix: "danger:",
          priority: 100,
        },
      ],
    },
    {
      id: "full-system-deny-danger",
      source: "org",
      rules: [
        {
          id: "full-system-deny-danger-rule",
          kind: "deny-action-prefix",
          effect: "deny",
          actionPrefix: "danger:",
          priority: 1,
        },
      ],
    },
  ];
}

function applySetAction(action: string, current: ReplicaSystemState): ReplicaSystemState {
  if (!action.startsWith("set:")) {
    return clone(current);
  }

  const payload = action.slice("set:".length).trim();
  const [pathValue, rawValue] = payload.split("=");
  if (!pathValue || typeof rawValue === "undefined") {
    return clone(current);
  }

  const segments = pathValue
    .split(".")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (segments.length === 0) {
    return clone(current);
  }

  const next = clone(current) as Record<string, unknown>;
  let cursor: Record<string, unknown> = next;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const existing = cursor[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1] as string] = rawValue.trim();
  return next as ReplicaSystemState;
}

function buildLinearPlan(id: string, tasks: number, prefix: string): GlobalPlan {
  const normalizedTasks = Math.max(0, Math.floor(tasks));
  const planTasks: GlobalPlanTask[] = [];

  for (let index = 0; index < normalizedTasks; index += 1) {
    const taskId = `${prefix}-${index}:t1`;
    const dependsOn = index === 0 ? [] : [`${prefix}-${index - 1}:t1`];
    planTasks.push({
      id: taskId,
      repoId: `${prefix}-${index}`,
      action: `set:meta.value=${index + 1}`,
      dependsOn,
    });
  }

  return {
    id,
    tasks: planTasks,
  };
}

function buildReposForPlan(plan: GlobalPlan): Repo[] {
  const byTask = new Map(plan.tasks.map((task) => [task.id, task] as const));
  const dependencyMap = new Map<string, Set<string>>();

  for (const task of plan.tasks) {
    if (!dependencyMap.has(task.repoId)) {
      dependencyMap.set(task.repoId, new Set<string>());
    }
  }

  for (const task of plan.tasks) {
    const repoDeps = dependencyMap.get(task.repoId) ?? new Set<string>();
    for (const dependencyId of task.dependsOn) {
      const dependencyTask = byTask.get(dependencyId);
      if (!dependencyTask) {
        continue;
      }

      if (dependencyTask.repoId !== task.repoId) {
        repoDeps.add(dependencyTask.repoId);
      }
    }

    dependencyMap.set(task.repoId, repoDeps);
  }

  return [...dependencyMap.keys()]
    .sort((left, right) => left.localeCompare(right))
    .map((repoId) => ({
      id: repoId,
      dependencies: sortedUnique([...(dependencyMap.get(repoId) ?? new Set<string>())]),
      state: { meta: { value: "0" } },
    }));
}

function buildExecutionInput(id: string, tasks: number): ExecutionInput {
  const plan = buildLinearPlan(id, tasks, `full-system-${id}`);
  const repos = buildReposForPlan(plan);
  const state = Object.fromEntries(repos.map((repo) => [repo.id, repo.state] as const));

  return {
    plan,
    state,
    policies: defaultPolicies(),
    dependencyGraph: {
      edges: plan.tasks.flatMap((task) => task.dependsOn.map((dependencyId) => ({ from: dependencyId, to: task.id }))),
    },
  };
}

function buildExecutionOptions(plan: GlobalPlan, policies: CompiledPolicy[] = defaultPolicies()): ExecuteGlobalPlanOptions {
  const repos = buildReposForPlan(plan);
  return {
    repos,
    policies,
    executeTask: async (task, state) => applySetAction(task.action, state),
  };
}

function equalUnknown(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function hasCheck(report: { checks: Array<{ name: string; passed: boolean }> }, name: string): boolean {
  return report.checks.some((entry) => entry.name === name && entry.passed);
}

function buildRegressionPatterns(): Array<{ file: string; pattern: RegExp; description: string }> {
  return [
    {
      file: path.join("src", "tests", "verification", "core", "policyVerification.ts"),
      pattern: /preview-hash-approval-binding/,
      description: "preview hash approval binding regression",
    },
    {
      file: path.join("src", "tests", "verification", "core", "stateVerification.ts"),
      pattern: /audit-tamper-detected/,
      description: "audit tamper detection regression",
    },
    {
      file: path.join("src", "core", "persistentStateAudit.ts"),
      pattern: /Replay mismatch:/,
      description: "replay mismatch fail-closed regression",
    },
    {
      file: path.join("src", "tests", "architecture", "suite.ts"),
      pattern: /verify --production/,
      description: "parser architecture regression for production verify mode",
    },
  ];
}

async function runVerificationBundle(mode: FullSystemVerificationMode, workspaceRoot: string): Promise<VerificationBundle> {
  const verificationMode = mode === "full" ? "full" : "quick";

  return {
    full: await runFullVerification({
      workspaceRoot,
      mode: verificationMode,
      throwOnFailure: false,
      detectFlakiness: true,
      parallelCaseExecution: false,
      flakeRuns: modeValue(mode, 3, 2),
    }),
    determinism: await runDeterminismVerification(),
    policy: await runPolicyVerification(),
    state: await runStateVerification(),
    orchestration: await runOrchestrationVerification(),
    runtimeGovernance: await runRuntimeGovernanceVerification(),
    transactions: await runTransactionVerification(),
    compiler: await runCompilerVerification(),
  };
}

export async function verifyAllContracts(workspaceRoot = process.cwd()): Promise<ContractCoverageResult> {
  const report = await runContractVerification({
    workspaceRoot,
    mode: "full",
    throwOnFailure: false,
  });

  const sectionsTotal = report.sections.length;
  const sectionsPassed = report.sections.filter((entry) => entry.passed).length;
  const allCommandsPassed = report.commands.every((entry) => entry.exitCode === 0);
  const allSectionsPassed = sectionsPassed === sectionsTotal && sectionsTotal >= 14;

  return {
    passed: report.passed && allSectionsPassed && allCommandsPassed,
    report,
    sectionsPassed,
    sectionsTotal,
  };
}

async function validateSystemInvariants(mode: FullSystemVerificationMode, workspaceRoot: string): Promise<InvariantResult[]> {
  const bundle = await runVerificationBundle(mode, workspaceRoot);

  const invariants: InvariantResult[] = [
    {
      invariant: "simulate == execute",
      passed: bundle.full.metrics.simulation,
      detail: bundle.full.metrics.simulation
        ? "simulation and execution remained equivalent"
        : "simulation and execution diverged",
    },
    {
      invariant: "replay == execution",
      passed: bundle.full.metrics.replay,
      detail: bundle.full.metrics.replay
        ? "replay matched execution outputs"
        : "replay mismatch detected",
    },
    {
      invariant: "rollback restores exact state",
      passed: bundle.full.metrics.rollback,
      detail: bundle.full.metrics.rollback
        ? "rollback invariants held"
        : "rollback integrity check failed",
    },
    {
      invariant: "policy always enforced",
      passed: bundle.policy.passed && bundle.full.metrics.policy,
      detail: bundle.policy.passed
        ? "policy verification and harness checks passed"
        : "policy verification reported enforcement gaps",
    },
    {
      invariant: "determinism holds globally",
      passed: bundle.determinism.passed && bundle.full.metrics.determinism,
      detail: bundle.determinism.passed
        ? "deterministic fingerprints were stable"
        : "determinism checks reported divergence",
    },
  ];

  return invariants;
}

async function runEdgeCaseElimination(mode: FullSystemVerificationMode): Promise<{ passed: boolean; failures: string[]; detail: string }> {
  const failures: string[] = [];

  resetProductionReadiness();

  const emptyPlan: GlobalPlan = { id: "full-system-empty-plan", tasks: [] };
  const emptyResult = await executeGlobalPlan(emptyPlan, { repos: [], policies: [] });
  if (!emptyResult.success || !equalUnknown(emptyResult.finalStates, {})) {
    failures.push("empty plan did not converge to deterministic no-op state");
  }

  const singlePlan = buildLinearPlan("full-system-single-node", 1, "full-system-single");
  const singleResult = await executeGlobalPlan(singlePlan, buildExecutionOptions(singlePlan));
  if (!singleResult.success) {
    failures.push("single-node DAG execution failed");
  }

  const maximalPlan = buildLinearPlan("full-system-maximal-dag", modeValue(mode, 256, 40), "full-system-max");
  const maximalSimulation = await simulatePlan(maximalPlan, buildExecutionOptions(maximalPlan));
  const maximalExecution = await executeGlobalPlan(maximalPlan, buildExecutionOptions(maximalPlan));
  if (!maximalSimulation.success || !maximalExecution.success) {
    failures.push("maximal DAG simulation or execution failed");
  } else if (!equalUnknown(maximalSimulation.finalState, maximalExecution.finalStates)) {
    failures.push("maximal DAG simulation and execution diverged");
  }

  const conflictPlan: GlobalPlan = {
    id: "full-system-conflict-policy",
    tasks: [
      {
        id: "full-system-conflict:t1",
        repoId: "full-system-conflict",
        action: "danger:mutate",
        dependsOn: [],
      },
    ],
  };
  const conflictSimulation = await simulatePlan(conflictPlan, buildExecutionOptions(conflictPlan, denyDangerPolicy()));
  if (conflictSimulation.success) {
    failures.push("conflicting policy case unexpectedly succeeded");
  }

  const repeatedPlan = buildLinearPlan("full-system-repeated", 6, "full-system-repeat");
  const repeatedFingerprints: string[] = [];
  for (let run = 0; run < modeValue(mode, 5, 3); run += 1) {
    resetProductionReadiness();
    const result = await executeGlobalPlan(repeatedPlan, buildExecutionOptions(repeatedPlan));
    repeatedFingerprints.push(hashValue({
      success: result.success,
      rolledBack: result.rolledBack,
      finalStates: result.finalStates,
      trace: result.trace,
    }));
  }
  if (!repeatedFingerprints.every((entry) => entry === repeatedFingerprints[0])) {
    failures.push("repeated execution produced nondeterministic fingerprints");
  }

  const partialFailurePlan = buildLinearPlan("full-system-partial-failure", modeValue(mode, 8, 4), "full-system-partial");
  for (let failingIndex = 0; failingIndex < partialFailurePlan.tasks.length; failingIndex += 1) {
    const failingTaskId = (partialFailurePlan.tasks[failingIndex] as GlobalPlanTask).id;
    resetProductionReadiness();
    const runA = await executeGlobalPlan(partialFailurePlan, {
      ...buildExecutionOptions(partialFailurePlan),
      executeTask: async (task, state, _repoId, _allStates, runMode) => {
        if (runMode === "execution" && task.id === failingTaskId) {
          throw new Error(`full-system injected failure ${task.id}`);
        }
        return applySetAction(task.action, state);
      },
    });

    resetProductionReadiness();
    const runB = await executeGlobalPlan(partialFailurePlan, {
      ...buildExecutionOptions(partialFailurePlan),
      executeTask: async (task, state, _repoId, _allStates, runMode) => {
        if (runMode === "execution" && task.id === failingTaskId) {
          throw new Error(`full-system injected failure ${task.id}`);
        }
        return applySetAction(task.action, state);
      },
    });

    const deterministicFailure = equalUnknown(
      {
        success: runA.success,
        rolledBack: runA.rolledBack,
        finalStates: runA.finalStates,
        rollbackTrace: runA.rollbackTrace,
      },
      {
        success: runB.success,
        rolledBack: runB.rolledBack,
        finalStates: runB.finalStates,
        rollbackTrace: runB.rollbackTrace,
      }
    );

    if (!deterministicFailure) {
      failures.push(`partial failure handling was nondeterministic for ${failingTaskId}`);
      break;
    }

    if (runA.success) {
      failures.push(`partial failure case unexpectedly succeeded for ${failingTaskId}`);
      break;
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    detail: failures.length === 0
      ? "empty/single/maximal/conflict/repeated/partial-failure edge cases were deterministic and fail-safe"
      : failures.join("; "),
  };
}

async function allSubsystemsAgree(mode: FullSystemVerificationMode, workspaceRoot: string): Promise<{ passed: boolean; failures: string[]; detail: string }> {
  const failures: string[] = [];
  const bundle = await runVerificationBundle(mode, workspaceRoot);

  if (!bundle.compiler.passed) {
    appendFailure(failures, "compiler", bundle.compiler.failures);
  }

  if (!bundle.full.metrics.simulation) {
    failures.push("simulation != execution in full harness");
  }

  if (!bundle.state.passed) {
    appendFailure(failures, "state", bundle.state.failures);
  }

  if (!bundle.policy.passed) {
    appendFailure(failures, "policy", bundle.policy.failures);
  }

  if (!bundle.orchestration.passed) {
    appendFailure(failures, "orchestration", bundle.orchestration.failures);
  }

  return {
    passed: failures.length === 0,
    failures,
    detail: failures.length === 0
      ? "compiler/execution/simulation/state/audit/policy/orchestration remained consistent"
      : failures.join("; "),
  };
}

export async function enforceGlobalDeterminism(
  mode: FullSystemVerificationMode,
  workspaceRoot = process.cwd()
): Promise<DeterminismLockResult> {
  const runs = modeValue(mode, 10, 4);
  const fingerprints: string[] = [];

  for (let run = 0; run < runs; run += 1) {
    const report = await runFullVerification({
      workspaceRoot,
      mode: mode === "full" ? "full" : "quick",
      throwOnFailure: false,
      detectFlakiness: true,
      parallelCaseExecution: false,
      flakeRuns: modeValue(mode, 3, 2),
    });

    fingerprints.push(hashValue({
      passed: report.passed,
      metrics: report.metrics,
      failures: sortedUnique([...report.failures]),
      cases: report.cases.map((entry) => ({
        name: entry.name,
        passed: entry.passed,
        actual: entry.actual,
      })),
    }));
  }

  const localFingerprint = fingerprints[0] as string;
  const allRunsEqual = fingerprints.every((entry) => entry === localFingerprint);

  const proofRoot = path.join(workspaceRoot, ".choir", "artifacts", "proofs");
  const baselineFile = path.join(proofRoot, "determinism-lock.json");
  ensureDirectory(baselineFile);

  let ciFingerprint: string | undefined;
  if (fs.existsSync(baselineFile)) {
    try {
      const previous = JSON.parse(fs.readFileSync(baselineFile, "utf-8")) as Record<string, unknown>;
      if (typeof previous.ciFingerprint === "string" && previous.ciFingerprint.length > 0) {
        ciFingerprint = previous.ciFingerprint;
      }
    } catch {
      ciFingerprint = undefined;
    }
  }

  const nextBaseline = {
    localFingerprint,
    ciFingerprint: process.env.CI ? localFingerprint : ciFingerprint,
    updatedBy: process.env.CI ? "ci" : "local",
    runs,
  };
  fs.writeFileSync(baselineFile, `${JSON.stringify(nextBaseline, null, 2)}\n`, "utf-8");

  const crossEnvironmentPass = !ciFingerprint || ciFingerprint === localFingerprint;
  const passed = allRunsEqual && crossEnvironmentPass;

  return {
    passed,
    fingerprints,
    baselineFile,
    localFingerprint,
    ...(ciFingerprint ? { ciFingerprint } : {}),
    detail: passed
      ? "10-run fingerprint lock held and CI/local baseline remained compatible"
      : "global determinism lock diverged across runs or environment baselines",
  };
}

async function runFailureModeHardening(): Promise<{ passed: boolean; failures: string[]; detail: string }> {
  const failures: string[] = [];

  const transactions = await runTransactionVerification();
  if (!transactions.passed || !hasCheck(transactions, "rollback-isolates-failed-scope")) {
    failures.push("transaction failure handling is incomplete");
  }

  const policy = await runPolicyVerification();
  if (!policy.passed || !hasCheck(policy, "deny-precedence-over-require-approval")) {
    failures.push("policy denial hardening is incomplete");
  }

  const orchestration = await runOrchestrationVerification();
  if (!orchestration.passed || !hasCheck(orchestration, "cycle-detection-hard-block")) {
    failures.push("DAG cycle handling is incomplete");
  }

  const local = createReplica("full-system-local", { feature: { enabled: true } } as ReplicaSystemState);
  const remote = createReplica("full-system-remote", { feature: { enabled: false } } as ReplicaSystemState);
  const conflictSync = sync(local, remote, {
    mode: "bidirectional",
    conflictStrategy: "manual",
  });
  if (conflictSync.trace.conflictsDetected <= 0) {
    failures.push("merge conflict was not detected immediately");
  }

  const state = await runStateVerification();
  if (!state.passed || !hasCheck(state, "audit-tamper-detected")) {
    failures.push("replay mismatch/audit corruption safeguards are incomplete");
  }

  return {
    passed: failures.length === 0,
    failures,
    detail: failures.length === 0
      ? "transaction/policy/cycle/conflict/replay/audit failures were detected and handled deterministically"
      : failures.join("; "),
  };
}

function validateDefensivePlan(plan: GlobalPlan): string[] {
  const errors: string[] = [];
  const id = plan.id.trim();
  if (id.length === 0) {
    errors.push("plan.id is required");
  }

  const ids = new Set<string>();
  for (const task of plan.tasks) {
    const taskId = task.id.trim();
    const repoId = task.repoId.trim();
    const action = task.action.trim();

    if (taskId.length === 0) {
      errors.push("task.id is required");
      continue;
    }

    if (ids.has(taskId)) {
      errors.push(`duplicate task.id detected: ${taskId}`);
    }
    ids.add(taskId);

    if (repoId.length === 0) {
      errors.push(`task ${taskId} missing repoId`);
    }

    if (action.length === 0) {
      errors.push(`task ${taskId} missing action`);
    }

    if (/[\u0000-\u001F]/.test(action)) {
      errors.push(`task ${taskId} action contains control characters`);
    }

    if (task.dependsOn.includes(taskId)) {
      errors.push(`task ${taskId} cannot depend on itself`);
    }
  }

  for (const task of plan.tasks) {
    for (const dependencyId of task.dependsOn) {
      if (!ids.has(dependencyId)) {
        errors.push(`task ${task.id} depends on unknown task ${dependencyId}`);
      }
    }
  }

  return sortedUnique(errors);
}

function sanitizePlan(plan: GlobalPlan): GlobalPlan {
  return {
    id: plan.id.trim(),
    tasks: plan.tasks.map((task) => ({
      id: task.id.trim(),
      repoId: task.repoId.trim(),
      action: task.action.trim(),
      dependsOn: sortedUnique(task.dependsOn.map((dependencyId) => dependencyId.trim()).filter((entry) => entry.length > 0)),
    })),
  };
}

export async function defensiveExecute(
  plan: GlobalPlan,
  options: ExecuteGlobalPlanOptions
): Promise<DefensiveExecutionResult> {
  const sanitizedPlan = sanitizePlan(plan);
  const errors = validateDefensivePlan(sanitizedPlan);
  if (errors.length > 0) {
    return {
      accepted: false,
      errors,
    };
  }

  const result = await executeGlobalPlan(sanitizedPlan, options);
  return {
    accepted: true,
    errors: [],
    result,
  };
}

async function runDefensiveExecutionPass(mode: FullSystemVerificationMode): Promise<{ passed: boolean; failures: string[]; detail: string }> {
  const failures: string[] = [];

  const invalidPlan: GlobalPlan = {
    id: "full-system-invalid-plan",
    tasks: [
      {
        id: "dup-task",
        repoId: "repo-a",
        action: "set:meta.value=1",
        dependsOn: [],
      },
      {
        id: "dup-task",
        repoId: "repo-b",
        action: "set:meta.value=2",
        dependsOn: ["missing-task"],
      },
    ],
  };

  const invalidResult = await defensiveExecute(invalidPlan, {
    repos: buildReposForPlan(invalidPlan),
    policies: defaultPolicies(),
  });

  if (invalidResult.accepted || invalidResult.errors.length === 0) {
    failures.push("defensive execution accepted malformed input");
  }

  const validPlan = buildLinearPlan("full-system-defensive-valid", modeValue(mode, 6, 3), "full-system-defensive");
  const validResult = await defensiveExecute(validPlan, buildExecutionOptions(validPlan));
  if (!validResult.accepted || !validResult.result || !validResult.result.success) {
    failures.push("defensive execution failed on valid deterministic plan");
  }

  return {
    passed: failures.length === 0,
    failures,
    detail: failures.length === 0
      ? "defensive execute rejected invalid plans early and executed valid plans safely"
      : failures.join("; "),
  };
}

async function runChaosHardening(mode: FullSystemVerificationMode): Promise<{ passed: boolean; failures: string[]; detail: string; report: PropertyRunResult }> {
  const iterations = modeValue(mode, 1000, 80);
  const report = await runChaosTest("extreme", iterations, {
    seed: 1337,
    throwOnFailure: false,
  });

  const failures = report.failures > 0
    ? [`chaos hardening failed with invariants: ${report.invariantsBroken.join(", ") || "unknown"}`]
    : [];

  return {
    passed: failures.length === 0,
    failures,
    detail: failures.length === 0
      ? `extreme chaos mode passed with ${iterations} iterations`
      : failures.join("; "),
    report,
  };
}

async function runReplayStress(mode: FullSystemVerificationMode): Promise<{ passed: boolean; failures: string[]; detail: string }> {
  const failures: string[] = [];
  const traceCount = modeValue(mode, 4, 2);
  const replaysPerTrace = modeValue(mode, 10, 3);

  for (let traceIndex = 0; traceIndex < traceCount; traceIndex += 1) {
    const input = buildExecutionInput(`full-system-replay-${traceIndex}`, modeValue(mode, 8, 4));
    const trace = await executeDeterministic(input);

    const replayHashes: string[] = [];
    for (let replayRun = 0; replayRun < replaysPerTrace; replayRun += 1) {
      const replayed = replay(trace);
      replayHashes.push(hashValue(replayed));
    }

    if (!replayHashes.every((entry) => entry === replayHashes[0])) {
      failures.push(`trace ${trace.traceId} replay hash diverged`);
      continue;
    }

    if ((replayHashes[0] as string) !== trace.finalStateHash) {
      failures.push(`trace ${trace.traceId} replay hash mismatched recorded final hash`);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    detail: failures.length === 0
      ? `all traces replayed exactly ${replaysPerTrace} times`
      : failures.join("; "),
  };
}

async function runPolicyBypassAttackTest(mode: FullSystemVerificationMode): Promise<{ passed: boolean; failures: string[]; detail: string }> {
  const failures: string[] = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choir-full-system-policy-"));

  try {
    const plan = buildLinearPlan("full-system-policy-bypass", modeValue(mode, 3, 2), "full-system-policy");
    const repos = buildReposForPlan(plan);

    const blocked = await executeGlobalPlan(plan, {
      repos,
      policies: requireApprovalPolicy(),
      stateRoot: root,
      executeTask: async (task, state, _repoId, _allStates, runMode) => {
        if (runMode === "execution") {
          return applySetAction(task.action, state);
        }

        return applySetAction(task.action, state);
      },
    });

    const pending = listPendingApprovals(root).filter((entry) => entry.id.startsWith("preview-"));
    if (blocked.success || pending.length === 0) {
      failures.push("approval bypass attack succeeded before approval");
    }

    const pendingEntry = pending[0];
    if (pendingEntry) {
      approvePendingDiff(root, pendingEntry.id, "full-system-attacker-test", new Date().toISOString());
    }

    const changedPlan: GlobalPlan = {
      ...plan,
      tasks: plan.tasks.map((task) => ({
        ...task,
        action: task.action.replace(/=\d+$/, "=999"),
      })),
    };

    const changedExecution = await executeGlobalPlan(changedPlan, {
      repos,
      policies: requireApprovalPolicy(),
      stateRoot: root,
      executeTask: async (task, state) => applySetAction(task.action, state),
    });

    if (changedExecution.success) {
      failures.push("preview mutation bypass succeeded after approval");
    }

    const conflictPlan: GlobalPlan = {
      id: "full-system-policy-conflict-attack",
      tasks: [
        {
          id: "full-system-attack:t1",
          repoId: "full-system-attack",
          action: "danger:mutate",
          dependsOn: [],
        },
      ],
    };

    const conflictSimulation = await simulatePlan(conflictPlan, {
      repos: buildReposForPlan(conflictPlan),
      policies: denyDangerPolicy(),
    });

    if (conflictSimulation.success) {
      failures.push("conflicting-rule attack was not blocked");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  return {
    passed: failures.length === 0,
    failures,
    detail: failures.length === 0
      ? "approval bypass, preview mutation, and conflicting-rule attacks were blocked"
      : failures.join("; "),
  };
}

function randomState(random: SeededRandom, size: number): ReplicaSystemState {
  const safeSize = Math.max(1, Math.floor(size));
  const result: Record<string, unknown> = {};

  for (let index = 0; index < safeSize; index += 1) {
    const key = `k${index}`;
    result[key] = {
      value: Math.floor(random.next() * 1000),
      flag: random.next() > 0.5,
    };
  }

  return result;
}

async function runDistributedConvergenceStress(mode: FullSystemVerificationMode): Promise<{ passed: boolean; failures: string[]; detail: string }> {
  const failures: string[] = [];
  const iterations = modeValue(mode, 200, 24);
  const random = new SeededRandom(4242);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const left = randomState(random, modeValue(mode, 5, 3));
    const right = randomState(random, modeValue(mode, 5, 3));

    const mergedAB = mergeStates(left, right);
    const mergedBA = mergeStates(right, left);
    if (!equalUnknown(mergedAB, mergedBA)) {
      failures.push(`merge commutativity failed at iteration ${iteration}`);
      break;
    }

    const runSync = (): string => {
      let local = createReplica("full-system-node-a", left);
      let remote = createReplica("full-system-node-b", right);

      const fingerprints: string[] = [];
      for (let retry = 0; retry < 3; retry += 1) {
        const synced = sync(local, remote, {
          mode: "bidirectional",
          conflictStrategy: "lww",
        });

        local = synced.local;
        remote = synced.remote;
        fingerprints.push(hashValue({
          local: local.state,
          remote: remote.state,
          trace: synced.trace,
          retry,
        }));
      }

      return hashValue(fingerprints);
    };

    const syncFingerprintA = runSync();
    const syncFingerprintB = runSync();

    if (syncFingerprintA !== syncFingerprintB) {
      failures.push(`sync stability across retries failed at iteration ${iteration}`);
      break;
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    detail: failures.length === 0
      ? `distributed convergence remained stable across ${iterations} stress iterations`
      : failures.join("; "),
  };
}

async function runPerformanceStabilityHardening(mode: FullSystemVerificationMode): Promise<{ passed: boolean; failures: string[]; detail: string }> {
  const failures: string[] = [];

  const performancePlan = buildLinearPlan("full-system-performance", modeValue(mode, 300, 80), "full-system-perf");
  const perfValidation = validatePerformance(performancePlan);
  if (!perfValidation.valid) {
    failures.push(`performance validation failed: ${perfValidation.errors.join("; ")}`);
  }

  const load = runLoadTest(modeValue(mode, 2000, 200), modeValue(mode, 32, 8));
  if (!load.passed) {
    failures.push(`load test failed: ${load.errors.join("; ")}`);
  }

  const started = Date.now();
  const execution = await executeGlobalPlan(performancePlan, buildExecutionOptions(performancePlan));
  const durationMs = Date.now() - started;
  const maxDurationMs = modeValue(mode, 15000, 5000);

  if (!execution.success) {
    failures.push("performance plan execution failed");
  }

  if (durationMs > maxDurationMs) {
    failures.push(`bounded execution time exceeded (${durationMs}ms > ${maxDurationMs}ms)`);
  }

  return {
    passed: failures.length === 0,
    failures,
    detail: failures.length === 0
      ? `performance and stability checks passed (duration=${durationMs}ms)`
      : failures.join("; "),
  };
}

async function runFullSystemUAT(mode: FullSystemVerificationMode, workspaceRoot: string): Promise<{ passed: boolean; failures: string[]; detail: string }> {
  const failures: string[] = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choir-full-system-uat-"));

  try {
    const choirDir = path.join(root, ".choir");
    fs.mkdirSync(choirDir, { recursive: true });

    // init -> config
    const controlPlanePath = path.join(choirDir, "choir.config.yaml");
    fs.writeFileSync(controlPlanePath, [
      "version: \"1.0.0\"",
      "mission: \"full-system\"",
      "vision: \"hardening\"",
      "intent:",
      "  goals: []",
      "  constraints: []",
      "  nonGoals: []",
      "policy:",
      "  rules: []",
      "execution:",
      "  plans: []",
      "",
    ].join("\n"), "utf-8");

    // plan
    const plan = buildLinearPlan("full-system-uat", modeValue(mode, 4, 2), "full-system-uat");
    const repos = buildReposForPlan(plan);

    // simulate -> preview
    const simulation = await simulatePlan(plan, {
      repos,
      policies: requireApprovalPolicy(),
    });
    if (!simulation.success) {
      failures.push("UAT simulate/preview stage failed");
    }

    // approve gate (first blocked, then approved)
    const blockedExecution = await executeGlobalPlan(plan, {
      repos,
      policies: requireApprovalPolicy(),
      stateRoot: root,
      executeTask: async (task, state) => applySetAction(task.action, state),
    });

    const pending = listPendingApprovals(root).filter((entry) => entry.id.startsWith("preview-"));
    if (blockedExecution.success || pending.length === 0) {
      failures.push("UAT approval gate did not block prior to approval");
    }

    const firstPending = pending[0];
    if (firstPending) {
      approvePendingDiff(root, firstPending.id, "full-system-uat", new Date().toISOString());
    }

    // execute
    const executed = await executeGlobalPlan(plan, {
      repos,
      policies: requireApprovalPolicy(),
      stateRoot: root,
      executeTask: async (task, state) => applySetAction(task.action, state),
    });
    if (!executed.success) {
      failures.push("UAT execute stage failed after approval");
    }

    // rollback
    const rollbackRun = await executeGlobalPlan(plan, {
      repos,
      policies: defaultPolicies(),
      executeTask: async (task, state, _repoId, _allStates, runMode) => {
        if (runMode === "execution" && task.id === (plan.tasks[plan.tasks.length - 1] as GlobalPlanTask).id) {
          throw new Error("full-system-uat-rollback");
        }

        return applySetAction(task.action, state);
      },
    });
    if (rollbackRun.success || !rollbackRun.rolledBack) {
      failures.push("UAT rollback stage did not fail closed with rollback");
    }

    // replay
    const input = buildExecutionInput("full-system-uat-replay", modeValue(mode, 5, 3));
    const trace = await executeDeterministic(input);
    const replayed = replay(trace);
    if (hashValue(replayed) !== trace.finalStateHash) {
      failures.push("UAT replay stage mismatch");
    }

    // verify
    const verification = await runFullVerification({
      workspaceRoot,
      mode: "quick",
      throwOnFailure: false,
      detectFlakiness: true,
      parallelCaseExecution: false,
      flakeRuns: 2,
    });
    if (!verification.passed) {
      failures.push("UAT verify stage failed");
    }

    // observe
    const snapshot = getProductionSnapshot(root);
    if (!snapshot.health.checks.policyEnforcementActive) {
      failures.push("UAT observe stage missing policy-enforcement health signal");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  return {
    passed: failures.length === 0,
    failures,
    detail: failures.length === 0
      ? "UAT flow passed: init->config->plan->simulate->preview->approve->execute->rollback->replay->verify->observe"
      : failures.join("; "),
  };
}

export async function proveSystem(root = process.cwd()): Promise<ProofArtifact> {
  const deterministic = await runDeterminismVerification();
  const policy = await runPolicyVerification();
  const orchestration = await runOrchestrationVerification();

  // Continuous verification is stateful; seed it from a clean readiness snapshot
  // so prior intentional hardening failures do not pollute proof-loop counters.
  const proofRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), ".tmp-full-system-proof-"));
  let continuous;
  try {
    resetProductionReadiness();
    const proofPlan = buildLinearPlan("full-system-proof-loop", 3, "full-system-proof");
    await executeGlobalPlan(proofPlan, {
      ...buildExecutionOptions(proofPlan),
      stateRoot: proofRuntimeRoot,
    });

    continuous = await continuousVerify(proofRuntimeRoot);
  } finally {
    fs.rmSync(proofRuntimeRoot, { recursive: true, force: true });
  }

  const observabilityFingerprint = currentObservabilityFingerprint();

  const proofPayload = {
    generatedAt: new Date().toISOString(),
    deterministic: {
      passed: deterministic.passed,
      failures: deterministic.failures,
    },
    policy: {
      passed: policy.passed,
      failures: policy.failures,
    },
    orchestration: {
      passed: orchestration.passed,
      failures: orchestration.failures,
    },
    continuousVerify: {
      passed: continuous.passed,
      failures: continuous.failures,
      checks: continuous.checks,
    },
    observabilityFingerprint,
  };

  const passed = deterministic.passed && policy.passed && orchestration.passed && continuous.passed;
  const proofHash = deterministicHash(proofPayload);
  const proofId = deterministicId("full-system-proof", { proofHash, root }, 16);
  const proofPath = path.join(root, ".choir", "artifacts", "proofs", `${proofId}.json`);

  ensureDirectory(proofPath);
  fs.writeFileSync(proofPath, `${JSON.stringify({ ...proofPayload, proofHash, passed }, null, 2)}\n`, "utf-8");

  return {
    path: proofPath,
    proofHash,
    passed,
  };
}

export async function preventRegression(root = process.cwd()): Promise<{ passed: boolean; failures: string[]; detail: string }> {
  const failures: string[] = [];
  const requiredPatterns = buildRegressionPatterns();

  for (const entry of requiredPatterns) {
    const absolute = path.join(root, entry.file);
    if (!fs.existsSync(absolute)) {
      failures.push(`missing regression file: ${entry.file}`);
      continue;
    }

    const raw = fs.readFileSync(absolute, "utf-8");
    if (!entry.pattern.test(raw)) {
      failures.push(`missing regression lock: ${entry.description}`);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    detail: failures.length === 0
      ? "regression locks for known failure classes are present"
      : failures.join("; "),
  };
}

function toPassResult(id: number, name: string, passed: boolean, detail: string, failures: string[] = []): HardeningPassResult {
  return {
    id,
    name,
    passed,
    detail,
    failures: [...failures],
  };
}

export async function runFullSystemVerification(options: RunFullSystemVerificationOptions = {}): Promise<FullSystemVerificationReport> {
  const mode = options.mode ?? "full";
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : process.cwd();
  const failures: string[] = [];
  const passes: HardeningPassResult[] = [];
  const proofArtifacts: string[] = [];

  const contractCoverage = await verifyAllContracts(workspaceRoot);
  const pass1 = toPassResult(
    1,
    "Full Contract Coverage",
    contractCoverage.passed,
    `${contractCoverage.sectionsPassed}/${contractCoverage.sectionsTotal} contract sections passed`,
    contractCoverage.passed
      ? []
      : [
          `contract verification failed to satisfy ${contractCoverage.sectionsPassed}/${contractCoverage.sectionsTotal} coverage`,
        ]
  );
  passes.push(pass1);
  if (!pass1.passed) {
    failures.push(...pass1.failures);
  }

  const invariants = await validateSystemInvariants(mode, workspaceRoot);
  const brokenInvariants = invariants.filter((entry) => !entry.passed);
  const pass2 = toPassResult(
    2,
    "Cross-System Invariants",
    brokenInvariants.length === 0,
    brokenInvariants.length === 0
      ? "all cross-system invariants held"
      : `broken invariants: ${brokenInvariants.map((entry) => entry.invariant).join(", ")}`,
    brokenInvariants.map((entry) => `${entry.invariant}: ${entry.detail}`)
  );
  passes.push(pass2);
  if (!pass2.passed) {
    failures.push(...pass2.failures);
  }

  const edgeCases = await runEdgeCaseElimination(mode);
  const pass3 = toPassResult(3, "Edge-Case Elimination", edgeCases.passed, edgeCases.detail, edgeCases.failures);
  passes.push(pass3);
  if (!pass3.passed) {
    failures.push(...pass3.failures);
  }

  const consistency = await allSubsystemsAgree(mode, workspaceRoot);
  const pass4 = toPassResult(4, "Subsystem Consistency Validation", consistency.passed, consistency.detail, consistency.failures);
  passes.push(pass4);
  if (!pass4.passed) {
    failures.push(...pass4.failures);
  }

  const determinismLock = await enforceGlobalDeterminism(mode, workspaceRoot);
  const pass5 = toPassResult(
    5,
    "Global Determinism Lock",
    determinismLock.passed,
    determinismLock.detail,
    determinismLock.passed ? [] : ["determinism lock mismatch"]
  );
  passes.push(pass5);
  if (!pass5.passed) {
    failures.push(...pass5.failures);
  }

  const failureModes = await runFailureModeHardening();
  const pass6 = toPassResult(6, "Failure Mode Hardening", failureModes.passed, failureModes.detail, failureModes.failures);
  passes.push(pass6);
  if (!pass6.passed) {
    failures.push(...pass6.failures);
  }

  const defensive = await runDefensiveExecutionPass(mode);
  const pass7 = toPassResult(7, "Defensive Execution", defensive.passed, defensive.detail, defensive.failures);
  passes.push(pass7);
  if (!pass7.passed) {
    failures.push(...pass7.failures);
  }

  const chaos = await runChaosHardening(mode);
  const pass8 = toPassResult(8, "Chaos Hardening (Extreme)", chaos.passed, chaos.detail, chaos.failures);
  passes.push(pass8);
  if (!pass8.passed) {
    failures.push(...pass8.failures);
  }

  const replayStress = await runReplayStress(mode);
  const pass9 = toPassResult(9, "Replay Stress Test", replayStress.passed, replayStress.detail, replayStress.failures);
  passes.push(pass9);
  if (!pass9.passed) {
    failures.push(...pass9.failures);
  }

  const policyAttack = await runPolicyBypassAttackTest(mode);
  const pass10 = toPassResult(10, "Policy Bypass Attack Test", policyAttack.passed, policyAttack.detail, policyAttack.failures);
  passes.push(pass10);
  if (!pass10.passed) {
    failures.push(...pass10.failures);
  }

  const distributed = await runDistributedConvergenceStress(mode);
  const pass11 = toPassResult(11, "Distributed Convergence Stress", distributed.passed, distributed.detail, distributed.failures);
  passes.push(pass11);
  if (!pass11.passed) {
    failures.push(...pass11.failures);
  }

  const performance = await runPerformanceStabilityHardening(mode);
  const pass12 = toPassResult(12, "Performance + Stability Hardening", performance.passed, performance.detail, performance.failures);
  passes.push(pass12);
  if (!pass12.passed) {
    failures.push(...pass12.failures);
  }

  const uat = await runFullSystemUAT(mode, workspaceRoot);
  const pass13 = toPassResult(13, "Full System UAT", uat.passed, uat.detail, uat.failures);
  passes.push(pass13);
  if (!pass13.passed) {
    failures.push(...pass13.failures);
  }

  const proof = await proveSystem(workspaceRoot);
  proofArtifacts.push(proof.path);
  const pass14 = toPassResult(
    14,
    "Continuous Proof Loop",
    proof.passed,
    proof.passed
      ? `proof artifact generated: ${proof.path}`
      : "proof loop reported failed continuous checks",
    proof.passed ? [] : ["continuous proof checks failed"]
  );
  passes.push(pass14);
  if (!pass14.passed) {
    failures.push(...pass14.failures);
  }

  const regression = await preventRegression(workspaceRoot);
  const pass15 = toPassResult(15, "Regression Lock", regression.passed, regression.detail, regression.failures);
  passes.push(pass15);
  if (!pass15.passed) {
    failures.push(...pass15.failures);
  }

  const finalGatePassed = passes.filter((entry) => entry.id >= 1 && entry.id <= 15).every((entry) => entry.passed)
    && contractCoverage.passed
    && invariants.every((entry) => entry.passed)
    && chaos.report.failures === 0
    && !failures.some((entry) => entry.includes("nondeterminism"));

  const pass16 = toPassResult(
    16,
    "Final CI Gate",
    finalGatePassed,
    finalGatePassed
      ? "verify:full gate satisfied: contracts, invariants, tests, and determinism checks passed"
      : "verify:full gate failed due to at least one prior hardening failure",
    finalGatePassed ? [] : ["final gate blocked: unresolved hardening failures"]
  );
  passes.push(pass16);
  if (!pass16.passed) {
    failures.push(...pass16.failures);
  }

  const report: FullSystemVerificationReport = {
    passed: passes.every((entry) => entry.passed),
    mode,
    contractCoverage: {
      passed: contractCoverage.passed,
      sectionsPassed: contractCoverage.sectionsPassed,
      sectionsTotal: contractCoverage.sectionsTotal,
    },
    invariants,
    passes,
    proofArtifacts,
    failures: sortedUnique(failures),
  };

  if (!report.passed && options.throwOnFailure !== false) {
    throw new Error(formatFullSystemVerificationReport(report));
  }

  return report;
}

export function formatFullSystemVerificationReport(report: FullSystemVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} full-system verification`,
    `- mode: ${report.mode}`,
    `- contracts: ${report.contractCoverage.sectionsPassed}/${report.contractCoverage.sectionsTotal}`,
    `- invariants: ${report.invariants.filter((entry) => entry.passed).length}/${report.invariants.length}`,
    `- passes: ${report.passes.filter((entry) => entry.passed).length}/${report.passes.length}`,
  ];

  lines.push("", "Invariants:");
  for (const invariant of report.invariants) {
    lines.push(`- ${invariant.invariant}: ${invariant.passed ? "PASS" : "FAIL"} (${invariant.detail})`);
  }

  lines.push("", "Passes:");
  for (const pass of report.passes) {
    lines.push(`- ${pass.id}. ${pass.name}: ${pass.passed ? "PASS" : "FAIL"} (${pass.detail})`);
    for (const failure of pass.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  if (report.proofArtifacts.length > 0) {
    lines.push("", "Proof artifacts:");
    for (const artifact of report.proofArtifacts) {
      lines.push(`- ${artifact}`);
    }
  }

  if (report.failures.length > 0) {
    lines.push("", "Failures:");
    for (const failure of report.failures) {
      lines.push(`- ${failure}`);
    }
  }

  return lines.join("\n");
}
