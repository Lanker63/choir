import {
  executeGlobalPlan,
  type CompiledPolicy,
  type GlobalPlan,
  type Repo,
} from "./globalOrchestration.js";
import {
  chaosInject,
  circuitAllow,
  continuousVerify,
  evaluateAlerts,
  evaluateSLOs,
  getProductionSnapshot,
  getRunbook,
  latestRequiredMetrics,
  listFeatureFlags,
  listTelemetryEvents,
  rateLimitAllow,
  recordCircuitFailure,
  recordDeterminismFailure,
  recordReplayMismatch,
  resetProductionReadiness,
  runLoadTest,
  setFeatureFlag,
  validatePerformance,
  withExecutionTimeout,
} from "./productionReadiness.js";
import { runDeterminismVerification } from "./determinismVerification.js";

export type ProductionVerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type ProductionVerificationReport = {
  passed: boolean;
  checks: ProductionVerificationCheck[];
  failures: string[];
};

function fixturePlan(id: string): GlobalPlan {
  return {
    id,
    tasks: [
      {
        id: "repo-a:t1",
        repoId: "repo-a",
        action: "set:meta.state=prepared",
        dependsOn: [],
      },
      {
        id: "repo-b:t1",
        repoId: "repo-b",
        action: "set:meta.state=applied",
        dependsOn: ["repo-a:t1"],
      },
    ],
  };
}

function fixtureRepos(): Repo[] {
  return [
    {
      id: "repo-a",
      dependencies: [],
      state: { meta: { state: "idle" } },
    },
    {
      id: "repo-b",
      dependencies: ["repo-a"],
      state: { meta: { state: "idle" } },
    },
  ];
}

function fixturePolicies(): CompiledPolicy[] {
  return [];
}

export async function runProductionVerification(): Promise<ProductionVerificationReport> {
  resetProductionReadiness();

  const checks: ProductionVerificationCheck[] = [];
  const plan = fixturePlan("production-verify-plan");
  const repos = fixtureRepos();
  const policies = fixturePolicies();

  const execution = await executeGlobalPlan(plan, {
    repos,
    policies,
  });

  const telemetry = listTelemetryEvents();
  const requiredMetrics = latestRequiredMetrics();

  const observabilityEmissionPassed = execution.success
    && telemetry.length > 0
    && Number.isFinite(requiredMetrics.execution_success_rate)
    && Number.isFinite(requiredMetrics.rollback_rate)
    && Number.isFinite(requiredMetrics.policy_denial_rate)
    && Number.isFinite(requiredMetrics.determinism_failures)
    && Number.isFinite(requiredMetrics.replay_mismatches);

  checks.push({
    name: "observability-emission-required-metrics",
    passed: observabilityEmissionPassed,
    detail: observabilityEmissionPassed
      ? "execution path emitted telemetry and required production metrics"
      : "missing telemetry events or required metrics",
  });

  const perfValidation = validatePerformance(plan);
  checks.push({
    name: "performance-validation-guard",
    passed: perfValidation.valid,
    detail: perfValidation.valid
      ? "plan passed deterministic performance guardrails"
      : `performance validation failed: ${perfValidation.errors.join("; ")}`,
  });

  const load = runLoadTest(240, 6);
  checks.push({
    name: "load-test-stability",
    passed: load.passed,
    detail: load.passed
      ? `load test passed (units=${load.units}, edges=${load.edges})`
      : `load test failed: ${load.errors.join("; ")}`,
  });

  const chaos = chaosInject("light");
  checks.push({
    name: "chaos-safe-mode",
    passed: chaos.injected.length > 0,
    detail: chaos.injected.length > 0
      ? "chaos injection executed in safe mode"
      : "chaos injection did not produce test perturbations",
  });

  recordDeterminismFailure(1);
  recordReplayMismatch(1);
  const alerts = evaluateAlerts();
  const hasNondeterminismAlert = alerts.some((entry) => entry.condition === "nondeterminism-detected");
  const hasReplayAlert = alerts.some((entry) => entry.condition === "replay-mismatch");
  const alertingPassed = hasNondeterminismAlert && hasReplayAlert;

  checks.push({
    name: "critical-alert-triggering",
    passed: alertingPassed,
    detail: alertingPassed
      ? "critical alerts emitted for determinism and replay mismatches"
      : "required critical alerts were not emitted",
  });

  const runbookCoveragePassed = [
    "nondeterminism-detected",
    "replay-mismatch",
    "audit-chain-break",
    "rollback-failure",
    "policy-bypass-attempt",
  ].every((issue) => {
    const runbook = getRunbook(issue);
    return Boolean(runbook && runbook.steps.length > 0);
  });

  checks.push({
    name: "alert-runbook-coverage",
    passed: runbookCoveragePassed,
    detail: runbookCoveragePassed
      ? "all required alerts have runbook mappings"
      : "one or more required alerts are missing runbooks",
  });

  const determinismReport = await runDeterminismVerification();
  const replayCheck = determinismReport.checks.find((entry) => entry.name === "replay-exactness")?.passed ?? false;
  checks.push({
    name: "deterministic-replay-sample",
    passed: replayCheck,
    detail: replayCheck
      ? "deterministic replay sample matched final state hash"
      : "deterministic replay sample mismatch detected",
  });

  const cv = await continuousVerify();
  checks.push({
    name: "continuous-verification-loop",
    passed: cv.passed,
    detail: cv.passed
      ? "continuous verification loop passed determinism/replay/policy/orchestration checks"
      : `continuous verification failed: ${cv.failures.join("; ")}`,
  });

  const firstAllow = rateLimitAllow("verify-rate", 1, 1000);
  const secondAllow = rateLimitAllow("verify-rate", 1, 1000);
  const rateLimitPassed = firstAllow && !secondAllow;
  checks.push({
    name: "rate-limit-guard",
    passed: rateLimitPassed,
    detail: rateLimitPassed
      ? "rate limiter blocked excessive calls deterministically"
      : "rate limiter did not enforce expected guard behavior",
  });

  const circuitKey = "verify-circuit";
  const circuitInitiallyOpen = circuitAllow(circuitKey, 2, 1000);
  recordCircuitFailure(circuitKey);
  recordCircuitFailure(circuitKey);
  const circuitAfterFailures = circuitAllow(circuitKey, 2, 1000);
  const circuitPassed = circuitInitiallyOpen && !circuitAfterFailures;
  checks.push({
    name: "circuit-breaker-guard",
    passed: circuitPassed,
    detail: circuitPassed
      ? "circuit breaker opened after threshold failures"
      : "circuit breaker did not open as expected",
  });

  let timeoutGuardPassed = false;
  try {
    const value = await withExecutionTimeout(100, async () => "ok");
    timeoutGuardPassed = value === "ok";
  } catch {
    timeoutGuardPassed = false;
  }

  checks.push({
    name: "execution-timeout-guard",
    passed: timeoutGuardPassed,
    detail: timeoutGuardPassed
      ? "execution timeout wrapper completed within configured bound"
      : "execution timeout wrapper failed unexpectedly",
  });

  const beforeFlags = listFeatureFlags();
  setFeatureFlag("continuous-verification.enabled", true);
  const afterFlags = listFeatureFlags();
  const featureFlagPassed = beforeFlags.length > 0 && afterFlags.some((entry) => entry.name === "continuous-verification.enabled");

  checks.push({
    name: "feature-flag-control-plane",
    passed: featureFlagPassed,
    detail: featureFlagPassed
      ? "feature flags are discoverable and mutable"
      : "feature flags were not exposed or mutable",
  });

  const slos = evaluateSLOs();
  const sloPassed = slos.length >= 3
    && slos.some((entry) => entry.name === "execution-success-rate")
    && slos.some((entry) => entry.name === "rollback-success-rate")
    && slos.some((entry) => entry.name === "replay-accuracy");

  checks.push({
    name: "slo-evaluation-surface",
    passed: sloPassed,
    detail: sloPassed
      ? "SLO evaluation produced required production SLO records"
      : "SLO evaluation missing required records",
  });

  const snapshot = getProductionSnapshot();
  const snapshotPassed = snapshot.metrics.length > 0
    && snapshot.slos.length >= 3
    && snapshot.health.checks.policyEnforcementActive;

  checks.push({
    name: "production-snapshot-dashboard",
    passed: snapshotPassed,
    detail: snapshotPassed
      ? "production snapshot exposes health, metrics, alerts, incidents, and SLOs"
      : "production snapshot missing required observability fields",
  });

  const failures = checks
    .filter((entry) => !entry.passed)
    .map((entry) => `${entry.name}: ${entry.detail}`);

  return {
    passed: failures.length === 0,
    checks,
    failures,
  };
}

export function formatProductionVerificationReport(report: ProductionVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} production verification`,
    ...report.checks.map((entry) => `- ${entry.name}: ${entry.passed ? "PASS" : "FAIL"} (${entry.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((entry) => `- ${entry}`));
  }

  return lines.join("\n");
}
