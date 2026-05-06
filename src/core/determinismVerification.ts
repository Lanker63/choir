import {
  buildRollbackDependencyGraph,
  executeDeterministic,
  executeGlobalPlan,
  hashState,
  replay,
  simulatePlan,
  type CompiledPolicy,
  type ExecutionInput,
  type GlobalPlan,
  type Repo,
} from "./globalOrchestration.js";
import { stableStringify } from "./deterministicCore.js";

export type DeterminismCheckResult = {
  name: string;
  passed: boolean;
  detail: string;
};

export type DeterminismVerificationReport = {
  passed: boolean;
  checks: DeterminismCheckResult[];
  failures: string[];
};

function fixturePlan(): GlobalPlan {
  return {
    id: "verify-determinism-plan",
    tasks: [
      {
        id: "repo-alpha:t-prepare",
        repoId: "repo-alpha",
        action: "set:meta.phase=prepared",
        dependsOn: [],
      },
      {
        id: "repo-beta:t-sync",
        repoId: "repo-beta",
        action: "set:meta.phase=synced",
        dependsOn: ["repo-alpha:t-prepare"],
      },
    ],
  };
}

function fixtureRepos(): Repo[] {
  return [
    {
      id: "repo-alpha",
      state: {
        meta: {
          phase: "idle",
        },
      },
      dependencies: [],
    },
    {
      id: "repo-beta",
      state: {
        meta: {
          phase: "idle",
        },
      },
      dependencies: ["repo-alpha"],
    },
  ];
}

function fixturePolicies(): CompiledPolicy[] {
  return [];
}

function fixtureInput(plan: GlobalPlan, repos: Repo[], policies: CompiledPolicy[]): ExecutionInput {
  return {
    plan,
    state: Object.fromEntries(repos.map((repo) => [repo.id, repo.state] as const)),
    policies,
    dependencyGraph: buildRollbackDependencyGraph(plan),
  };
}

export async function runDeterminismVerification(): Promise<DeterminismVerificationReport> {
  const plan = fixturePlan();
  const repos = fixtureRepos();
  const policies = fixturePolicies();
  const input = fixtureInput(plan, repos, policies);
  const checks: DeterminismCheckResult[] = [];

  const deterministicRuns: string[] = [];
  for (let run = 0; run < 10; run += 1) {
    const trace = await executeDeterministic(input);
    deterministicRuns.push(stableStringify(trace));
  }

  const deterministicRunPass = deterministicRuns.every((entry) => entry === deterministicRuns[0]);
  checks.push({
    name: "same-input-determinism-10x",
    passed: deterministicRunPass,
    detail: deterministicRunPass
      ? "executeDeterministic produced identical traces across 10 runs"
      : "executeDeterministic diverged across 10 runs",
  });

  const baselineTrace = await executeDeterministic(input);
  const replayed = replay(baselineTrace);
  const replayPass = baselineTrace.deterministic && hashState(replayed) === baselineTrace.finalStateHash;
  checks.push({
    name: "replay-exactness",
    passed: replayPass,
    detail: replayPass
      ? "deterministic trace replay hash matched recorded final state hash"
      : "replay hash did not match deterministic trace final hash",
  });

  const simulated = await simulatePlan(plan, { repos, policies });
  const executed = await executeGlobalPlan(plan, { repos, policies });
  const parityPass = hashState(simulated.finalState) === hashState(executed.finalStates);
  checks.push({
    name: "simulate-execute-parity",
    passed: parityPass,
    detail: parityPass
      ? "simulatePlan and executeGlobalPlan converged to the same state hash"
      : "simulation and execution diverged",
  });

  const executionFingerprints: string[] = [];
  for (let run = 0; run < 5; run += 1) {
    const execution = await executeGlobalPlan(plan, { repos, policies });
    executionFingerprints.push(stableStringify({
      success: execution.success,
      rolledBack: execution.rolledBack,
      finalStateHash: hashState(execution.finalStates),
      trace: execution.trace,
      rollbackTrace: execution.rollbackTrace ?? null,
    }));
  }

  const nondeterminismPass = executionFingerprints.every((entry) => entry === executionFingerprints[0]);
  checks.push({
    name: "nondeterminism-detector-5x",
    passed: nondeterminismPass,
    detail: nondeterminismPass
      ? "5 repeated executions produced an identical fingerprint"
      : "execution fingerprint diverged across repeated runs",
  });

  const failures = checks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.detail}`);

  return {
    passed: failures.length === 0,
    checks,
    failures,
  };
}

export function formatDeterminismVerificationReport(report: DeterminismVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} deterministic verification`,
    ...report.checks.map((check) => `- ${check.name}: ${check.passed ? "PASS" : "FAIL"} (${check.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((failure) => `- ${failure}`));
  }

  return lines.join("\n");
}
