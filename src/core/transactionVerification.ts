import {
  applyChange,
  beginTransaction,
  buildRollbackDependencyGraph,
  commitPhase,
  executeTransaction,
  hashState,
  preparePhase,
  simulateTransaction,
  type ExecuteGlobalPlanOptions,
  type GlobalPlan,
  type Repo,
  validatePhase,
} from "./globalOrchestration.js";

export type TransactionVerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type TransactionVerificationReport = {
  passed: boolean;
  checks: TransactionVerificationCheck[];
  failures: string[];
};

function buildFixturePlan(): GlobalPlan {
  return {
    id: "verify-transactions-plan",
    tasks: [
      {
        id: "repo-a:t1",
        repoId: "repo-a",
        action: "set:meta.value=1",
        dependsOn: [],
      },
      {
        id: "repo-b:t1",
        repoId: "repo-b",
        action: "set:meta.value=2",
        dependsOn: ["repo-a:t1"],
      },
    ],
  };
}

function buildFixtureRepos(): Repo[] {
  return [
    {
      id: "repo-a",
      state: { meta: { value: "0" } },
      dependencies: [],
    },
    {
      id: "repo-b",
      state: { meta: { value: "0" } },
      dependencies: ["repo-a"],
    },
  ];
}

function optionsFor(plan: GlobalPlan): ExecuteGlobalPlanOptions {
  return {
    repos: buildFixtureRepos(),
    policies: [],
    validateState: () => true,
    executeTask: async (task, state) => {
      if (task.action.startsWith("set:")) {
        const value = task.repoId === "repo-a" ? "1" : "2";
        return { ...state, meta: { value } };
      }

      return state;
    },
  };
}

export async function runTransactionVerification(): Promise<TransactionVerificationReport> {
  const checks: TransactionVerificationCheck[] = [];
  const plan = buildFixturePlan();
  const options = optionsFor(plan);

  const commitResult = await executeTransaction(plan, options, "execution");
  checks.push({
    name: "commit-updates-state-atomically",
    passed: commitResult.success && commitResult.transaction.status === "committed"
      && hashState(commitResult.baseState) !== hashState(commitResult.finalState)
      && commitResult.trace.transitions.length > 0,
    detail: commitResult.success
      ? "execution committed and produced transition trace"
      : "execution did not commit successfully",
  });

  const rollbackResult = await executeTransaction(plan, {
    ...options,
    executeTask: async (task, state) => {
      if (task.repoId === "repo-b") {
        throw new Error("forced-failure");
      }

      return { ...state, meta: { value: "1" } };
    },
  }, "execution");
  checks.push({
    name: "rollback-isolates-failed-scope",
    passed: !rollbackResult.success
      && rollbackResult.transaction.status !== "committed"
      && hashState({ "repo-a": rollbackResult.finalState["repo-a"] }) === hashState({ "repo-a": { meta: { value: "1" } } })
      && hashState({ "repo-b": rollbackResult.finalState["repo-b"] }) === hashState({ "repo-b": rollbackResult.baseState["repo-b"] }),
    detail: rollbackResult.success
      ? "rollback case unexpectedly succeeded"
      : "rollback preserved unaffected committed unit state while restoring failed scope",
  });

  const simulation = await simulateTransaction(plan, options);
  const execution = await executeTransaction(plan, options, "execution");
  checks.push({
    name: "simulation-matches-execution",
    passed: simulation.success && execution.success && hashState(simulation.finalState) === hashState(execution.finalState),
    detail: hashState(simulation.finalState) === hashState(execution.finalState)
      ? "simulation and execution hashes converged"
      : "simulation diverged from execution",
  });

  const idempotentCtx = beginTransaction({ "repo-a": { meta: { value: "0" } } }, [], undefined, "verify-idempotency");
  preparePhase(idempotentCtx);
  applyChange(idempotentCtx, {
    unitId: "repo-a",
    nextState: { meta: { value: "7" } },
    type: "set",
  });
  applyChange(idempotentCtx, {
    unitId: "repo-a",
    nextState: { meta: { value: "7" } },
    type: "set",
  });
  const idempotentValidation = validatePhase(idempotentCtx, {
    repos: [{ id: "repo-a", dependencies: [], state: { meta: { value: "0" } } }],
    graph: buildRollbackDependencyGraph({
      id: "idempotent-plan",
      tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=7", dependsOn: [] }],
    }),
    executionState: { units: { "repo-a": "executed" } },
    policyResult: {
      allowed: true,
      requiresApproval: false,
      violations: [],
      policyDecisions: [],
      appliedPolicyIds: [],
    },
  });
  if (idempotentValidation.valid) {
    commitPhase(idempotentCtx);
  }

  checks.push({
    name: "idempotency-guard-prevents-duplicate-mutation-effects",
    passed: idempotentValidation.valid
      && idempotentCtx.transitions.length === 1
      && hashState(idempotentCtx.workingState) === hashState({ "repo-a": { meta: { value: "7" } } }),
    detail: idempotentValidation.valid
      ? "duplicate applyChange call produced a single transition"
      : "idempotent transaction failed validation",
  });

  const commitGuardCtx = beginTransaction({ "repo-a": { meta: { value: "0" } } }, [], undefined, "verify-commit-guard");
  preparePhase(commitGuardCtx);
  applyChange(commitGuardCtx, {
    unitId: "repo-a",
    nextState: { meta: { value: "2" } },
    type: "set",
  });

  let commitGuardBlocked = false;
  try {
    commitPhase(commitGuardCtx);
  } catch {
    commitGuardBlocked = true;
  }

  checks.push({
    name: "commit-requires-validation",
    passed: commitGuardBlocked,
    detail: commitGuardBlocked
      ? "commit without validate phase was blocked"
      : "commit guard did not block unvalidated transaction",
  });

  const failures = checks.filter((entry) => !entry.passed).map((entry) => `${entry.name}: ${entry.detail}`);

  return {
    passed: failures.length === 0,
    checks,
    failures,
  };
}

export function formatTransactionVerificationReport(report: TransactionVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} transaction verification`,
    ...report.checks.map((entry) => `- ${entry.name}: ${entry.passed ? "PASS" : "FAIL"} (${entry.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((entry) => `- ${entry}`));
  }

  return lines.join("\n");
}
