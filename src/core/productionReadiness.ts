import {
  canonicalizeUnknown,
  deterministicHash,
  deterministicId,
  stableStringify,
} from "./deterministicCore.js";
import { readAuditStore } from "./audit.js";

export type TelemetryEvent = {
  id: string;
  type: "execution" | "validation" | "policy" | "failure";
  timestamp: number;
  logicalTime: number;
  payload: unknown;
};

export type Metric = {
  name: string;
  value: number;
  tags: Record<string, string>;
};

export type Span = {
  id: string;
  name: string;
  startLogicalTime: number;
  endLogicalTime: number;
  status: "ok" | "error";
  tags: Record<string, string>;
};

export type Trace = {
  traceId: string;
  spans: Span[];
};

export type LogEntry = {
  level: "info" | "warn" | "error";
  message: string;
  context: unknown;
};

export type Alert = {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  condition: string;
};

export type Incident = {
  id: string;
  cause: string;
  affectedUnits: string[];
  resolution: string;
  links: {
    traceId?: string;
    logIds: string[];
    stateSnapshotHash?: string;
  };
};

export type HealthStatus = {
  healthy: boolean;
  checks: {
    determinismIntact: boolean;
    replayConsistency: boolean;
    auditChainValid: boolean;
    policyEnforcementActive: boolean;
  };
  failures: string[];
};

export type ChaosMode = "light" | "moderate";

export type SLO = {
  name: string;
  target: number;
};

export type SLOEvaluation = SLO & {
  actual: number;
  met: boolean;
};

export type FeatureFlag = {
  name: string;
  enabled: boolean;
};

export type Runbook = {
  issue: string;
  steps: string[];
};

export type PerformanceValidationResult = {
  valid: boolean;
  errors: string[];
  stats: {
    units: number;
    edges: number;
    density: number;
  };
};

export type LoadTestResult = {
  passed: boolean;
  units: number;
  edges: number;
  maxStageWidth: number;
  errors: string[];
};

export type ContinuousVerificationResult = {
  passed: boolean;
  checks: {
    determinism: boolean;
    replay: boolean;
    policy: boolean;
    orchestration: boolean;
  };
  failures: string[];
};

export type ProductionSnapshotView = {
  health: HealthStatus;
  metrics: Metric[];
  alerts: Alert[];
  incidents: Incident[];
  slos: SLOEvaluation[];
  failureHotspots: string[];
  traces: Trace[];
};

type CounterState = {
  executions: number;
  executionSuccesses: number;
  rollbackAttempts: number;
  rollbackSuccesses: number;
  policyEvaluations: number;
  policyDenials: number;
  determinismFailures: number;
  replayMismatches: number;
};

type ObservabilityStore = {
  logicalTime: number;
  telemetryEvents: TelemetryEvent[];
  metrics: Metric[];
  traces: Trace[];
  logs: Array<LogEntry & { id: string; logicalTime: number }>;
  alerts: Alert[];
  incidents: Incident[];
  counters: CounterState;
  featureFlags: Map<string, boolean>;
};

const MAX_EVENTS = 1000;
const MAX_METRICS = 1000;
const MAX_LOGS = 1000;
const MAX_TRACES = 300;
const MAX_ALERTS = 300;
const MAX_INCIDENTS = 200;

export const PRODUCTION_SLOS: SLO[] = [
  { name: "execution-success-rate", target: 99.9 },
  { name: "rollback-success-rate", target: 100 },
  { name: "replay-accuracy", target: 100 },
];

const RUNBOOKS: Record<string, Runbook> = {
  "nondeterminism-detected": {
    issue: "nondeterminism-detected",
    steps: [
      "Pause new execution dispatch via feature flag execution.enabled=false.",
      "Run determinism verification and compare deterministic traces.",
      "Re-enable execution only after deterministic fingerprints match.",
    ],
  },
  "replay-mismatch": {
    issue: "replay-mismatch",
    steps: [
      "Freeze rollout progression.",
      "Recompute replay from stored deterministic trace and compare hashes.",
      "Rollback affected units and re-run verification before resuming.",
    ],
  },
  "audit-chain-break": {
    issue: "audit-chain-break",
    steps: [
      "Stop production writes to audit stream.",
      "Recover last valid audit checkpoint and rebuild chain deterministically.",
      "Resume writes after chain integrity check passes.",
    ],
  },
  "rollback-failure": {
    issue: "rollback-failure",
    steps: [
      "Block further execution for affected units.",
      "Restore known-good snapshot for failed scope.",
      "Run post-rollback consistency verification.",
    ],
  },
  "policy-bypass-attempt": {
    issue: "policy-bypass-attempt",
    steps: [
      "Deny execution and capture full trace context.",
      "Review actor path and policy decision chain.",
      "Rotate credentials and require manual approval for next execution.",
    ],
  },
};

function defaultFeatureFlags(): Map<string, boolean> {
  return new Map<string, boolean>([
    ["execution.enabled", true],
    ["observability.enabled", true],
    ["chaos.safe-mode", true],
    ["continuous-verification.enabled", true],
  ]);
}

const store: ObservabilityStore = {
  logicalTime: 0,
  telemetryEvents: [],
  metrics: [],
  traces: [],
  logs: [],
  alerts: [],
  incidents: [],
  counters: {
    executions: 0,
    executionSuccesses: 0,
    rollbackAttempts: 0,
    rollbackSuccesses: 0,
    policyEvaluations: 0,
    policyDenials: 0,
    determinismFailures: 0,
    replayMismatches: 0,
  },
  featureFlags: defaultFeatureFlags(),
};

function nowTimestamp(logicalTime: number): number {
  return logicalTime;
}

function nextLogicalTime(): number {
  store.logicalTime += 1;
  return store.logicalTime;
}

function capArray<T>(entries: T[], max: number): T[] {
  if (entries.length <= max) {
    return entries;
  }

  return entries.slice(entries.length - max);
}

function metricValue(name: string): number {
  const latest = [...store.metrics]
    .reverse()
    .find((entry) => entry.name === name);
  return latest?.value ?? 0;
}

function executionSuccessRate(): number {
  if (store.counters.executions === 0) {
    return 100;
  }

  return (store.counters.executionSuccesses / store.counters.executions) * 100;
}

function rollbackSuccessRate(): number {
  if (store.counters.rollbackAttempts === 0) {
    return 100;
  }

  return (store.counters.rollbackSuccesses / store.counters.rollbackAttempts) * 100;
}

function replayAccuracy(): number {
  const mismatches = store.counters.replayMismatches;
  if (mismatches === 0) {
    return 100;
  }

  const baseline = Math.max(1, store.counters.executions);
  return Math.max(0, ((baseline - mismatches) / baseline) * 100);
}

function pushMetric(name: string, value: number, tags: Record<string, string>): void {
  store.metrics.push({
    name,
    value,
    tags: Object.fromEntries(
      Object.entries(tags)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, tagValue]) => [key, tagValue])
    ),
  });
  store.metrics = capArray(store.metrics, MAX_METRICS);
}

function refreshCoreMetrics(): void {
  pushMetric("execution_success_rate", executionSuccessRate(), { unit: "percent" });
  pushMetric("rollback_rate", rollbackSuccessRate(), { unit: "percent" });
  pushMetric("policy_denial_rate", store.counters.policyEvaluations === 0
    ? 0
    : (store.counters.policyDenials / store.counters.policyEvaluations) * 100, { unit: "percent" });
  pushMetric("determinism_failures", store.counters.determinismFailures, { unit: "count" });
  pushMetric("replay_mismatches", store.counters.replayMismatches, { unit: "count" });
}

export function resetProductionReadiness(): void {
  store.logicalTime = 0;
  store.telemetryEvents = [];
  store.metrics = [];
  store.traces = [];
  store.logs = [];
  store.alerts = [];
  store.incidents = [];
  store.featureFlags = defaultFeatureFlags();
  store.counters = {
    executions: 0,
    executionSuccesses: 0,
    rollbackAttempts: 0,
    rollbackSuccesses: 0,
    policyEvaluations: 0,
    policyDenials: 0,
    determinismFailures: 0,
    replayMismatches: 0,
  };
  rateWindow.clear();
  circuitState.clear();
}

export function emitTelemetryEvent(type: TelemetryEvent["type"], payload: unknown): TelemetryEvent {
  if (!isFeatureEnabled("observability.enabled")) {
    return {
      id: deterministicId("telemetry-disabled", { type }),
      type,
      timestamp: 0,
      logicalTime: 0,
      payload: canonicalizeUnknown(payload),
    };
  }

  const logicalTime = nextLogicalTime();
  const event: TelemetryEvent = {
    id: deterministicId("telemetry", {
      type,
      logicalTime,
      payload: canonicalizeUnknown(payload),
    }),
    type,
    timestamp: nowTimestamp(logicalTime),
    logicalTime,
    payload: canonicalizeUnknown(payload),
  };

  store.telemetryEvents.push(event);
  store.telemetryEvents = capArray(store.telemetryEvents, MAX_EVENTS);
  return event;
}

function emitMetric(name: string, value: number, tags: Record<string, string> = {}): Metric {
  pushMetric(name, value, tags);
  emitTelemetryEvent("validation", {
    metric: {
      name,
      value,
      tags,
    },
  });
  return {
    name,
    value,
    tags,
  };
}

export function createTrace(traceType: string, spanNames: string[], context: unknown): Trace {
  const seed = {
    traceType,
    spanNames: [...spanNames],
    context: canonicalizeUnknown(context),
    logicalTime: store.logicalTime,
  };
  const traceId = deterministicId("trace", seed, 16);
  let logical = nextLogicalTime();

  const spans: Span[] = spanNames.map((name, index) => {
    const start = logical + index;
    const end = start + 1;
    return {
      id: deterministicId("span", { traceId, name, index, start, end }, 16),
      name,
      startLogicalTime: start,
      endLogicalTime: end,
      status: "ok",
      tags: {},
    };
  });

  logical = spans.length === 0 ? logical : spans[spans.length - 1].endLogicalTime;
  store.logicalTime = Math.max(store.logicalTime, logical);

  const trace: Trace = {
    traceId,
    spans,
  };

  store.traces.push(trace);
  store.traces = capArray(store.traces, MAX_TRACES);
  emitTelemetryEvent("execution", { traceId, spanCount: spans.length, traceType });
  return trace;
}

export function updateTraceStatus(traceId: string, status: "ok" | "error", tags: Record<string, string> = {}): Trace | null {
  const index = store.traces.findIndex((entry) => entry.traceId === traceId);
  if (index < 0) {
    return null;
  }

  const trace = store.traces[index] as Trace;
  const next: Trace = {
    traceId: trace.traceId,
    spans: trace.spans.map((span) => ({
      ...span,
      status,
      tags: {
        ...span.tags,
        ...Object.fromEntries(Object.entries(tags).sort(([left], [right]) => left.localeCompare(right))),
      },
    })),
  };

  store.traces[index] = next;
  emitTelemetryEvent(status === "ok" ? "execution" : "failure", {
    traceId,
    status,
    tags,
  });
  return next;
}

export function appendStructuredLog(level: LogEntry["level"], message: string, context: unknown): LogEntry & { id: string; logicalTime: number } {
  const logicalTime = nextLogicalTime();
  const entry = {
    id: deterministicId("log", {
      level,
      message,
      logicalTime,
      context: canonicalizeUnknown(context),
    }),
    level,
    message,
    context: canonicalizeUnknown(context),
    logicalTime,
  };

  store.logs.push(entry);
  store.logs = capArray(store.logs, MAX_LOGS);
  emitTelemetryEvent(level === "error" ? "failure" : "validation", {
    logId: entry.id,
    level,
    message,
  });
  return entry;
}

function formatStructuredLog(entry: LogEntry): string {
  return stableStringify({
    level: entry.level,
    message: entry.message,
    context: canonicalizeUnknown(entry.context),
  });
}

function validateAuditChain(root: string): boolean {
  try {
    const store = readAuditStore(root);
    if (store.records.length <= 1) {
      return true;
    }

    for (let index = 1; index < store.records.length; index += 1) {
      const prev = store.records[index - 1];
      const current = store.records[index];
      if (!prev || !current) {
        continue;
      }

      if (current.previousHash !== prev.hash) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

export function healthCheck(root?: string): HealthStatus {
  const checks = {
    determinismIntact: store.counters.determinismFailures === 0,
    replayConsistency: store.counters.replayMismatches === 0,
    auditChainValid: root ? validateAuditChain(root) : true,
    policyEnforcementActive: store.counters.policyEvaluations > 0 || isFeatureEnabled("observability.enabled"),
  };

  const failures: string[] = [];
  if (!checks.determinismIntact) {
    failures.push("nondeterminism detected");
  }
  if (!checks.replayConsistency) {
    failures.push("replay mismatch detected");
  }
  if (!checks.auditChainValid) {
    failures.push("audit chain validation failed");
  }
  if (!checks.policyEnforcementActive) {
    failures.push("policy enforcement appears inactive");
  }

  const status: HealthStatus = {
    healthy: failures.length === 0,
    checks,
    failures,
  };

  emitTelemetryEvent("validation", {
    health: status,
  });
  return status;
}

function requiredAlerts(root?: string): Alert[] {
  const health = healthCheck(root);
  const alerts: Alert[] = [];

  if (store.counters.determinismFailures > 0) {
    alerts.push({
      id: deterministicId("alert", "nondeterminism-detected"),
      severity: "critical",
      condition: "nondeterminism-detected",
    });
  }

  if (store.counters.replayMismatches > 0) {
    alerts.push({
      id: deterministicId("alert", "replay-mismatch"),
      severity: "critical",
      condition: "replay-mismatch",
    });
  }

  if (!health.checks.auditChainValid) {
    alerts.push({
      id: deterministicId("alert", "audit-chain-break"),
      severity: "critical",
      condition: "audit-chain-break",
    });
  }

  const rollbackFailures = Math.max(0, store.counters.rollbackAttempts - store.counters.rollbackSuccesses);
  if (rollbackFailures > 0) {
    alerts.push({
      id: deterministicId("alert", "rollback-failure"),
      severity: "high",
      condition: "rollback-failure",
    });
  }

  const bypassDetected = store.logs.some((entry) => {
    const context = entry.context as Record<string, unknown>;
    return Boolean(context?.policyBypassAttempt === true);
  });
  if (bypassDetected) {
    alerts.push({
      id: deterministicId("alert", "policy-bypass-attempt"),
      severity: "critical",
      condition: "policy-bypass-attempt",
    });
  }

  return alerts;
}

export function getRunbook(issue: string): Runbook | null {
  return RUNBOOKS[issue] ?? null;
}

function createIncidentFromAlert(alert: Alert): Incident {
  const runbook = getRunbook(alert.condition);
  const traceId = store.traces[store.traces.length - 1]?.traceId;
  const recentLogIds = store.logs.slice(-5).map((entry) => entry.id);
  const stateSnapshotHash = deterministicHash({
    counters: store.counters,
    alerts: store.alerts,
    incidents: store.incidents.map((incident) => incident.id),
  });

  return {
    id: deterministicId("incident", {
      condition: alert.condition,
      logicalTime: store.logicalTime,
    }),
    cause: alert.condition,
    affectedUnits: [],
    resolution: runbook ? runbook.steps.join(" ") : "Follow standard incident triage and deterministic rollback procedure.",
    links: {
      traceId,
      logIds: recentLogIds,
      stateSnapshotHash,
    },
  };
}

export function evaluateAlerts(root?: string): Alert[] {
  const next = requiredAlerts(root)
    .sort((left, right) => left.condition.localeCompare(right.condition));
  store.alerts = capArray(next, MAX_ALERTS);

  for (const alert of next) {
    if (alert.severity !== "critical") {
      continue;
    }

    if (store.incidents.some((incident) => incident.cause === alert.condition)) {
      continue;
    }

    const incident = createIncidentFromAlert(alert);
    store.incidents.push(incident);
    store.incidents = capArray(store.incidents, MAX_INCIDENTS);
    appendStructuredLog("error", `Incident opened for ${alert.condition}`, {
      incidentId: incident.id,
      condition: alert.condition,
    });
  }

  emitTelemetryEvent("failure", {
    alertCount: next.length,
    criticalAlerts: next.filter((entry) => entry.severity === "critical").length,
  });
  return [...store.alerts];
}

function listIncidents(): Incident[] {
  return [...store.incidents];
}

export function chaosInject(mode: ChaosMode): { mode: ChaosMode; injected: string[] } {
  if (!isFeatureEnabled("chaos.safe-mode")) {
    throw new Error("Chaos injection blocked: chaos.safe-mode feature flag is disabled");
  }

  const injected = mode === "light"
    ? ["inject-latency:10", "toggle-retry-path"]
    : ["inject-latency:25", "drop-noncritical-retry", "force-fallback-branch"];

  emitTelemetryEvent("validation", {
    chaosMode: mode,
    injected,
    safe: true,
  });
  appendStructuredLog("warn", "Chaos injected in safe mode", { mode, injected });

  return {
    mode,
    injected,
  };
}

export async function continuousVerify(root?: string): Promise<ContinuousVerificationResult> {
  if (!isFeatureEnabled("continuous-verification.enabled")) {
    return {
      passed: true,
      checks: {
        determinism: true,
        replay: true,
        policy: true,
        orchestration: true,
      },
      failures: [],
    };
  }

  const [{ runDeterminismVerification }, { runPolicyVerification }, { runOrchestrationVerification }] = await Promise.all([
    import("../tests/verification/core/determinismVerification.js"),
    import("../tests/verification/core/policyVerification.js"),
    import("../tests/verification/core/orchestrationVerification.js"),
  ]);

  const determinism = await runDeterminismVerification();
  const policy = await runPolicyVerification();
  const orchestration = await runOrchestrationVerification();

  const replay = determinism.checks.find((entry) => entry.name === "replay-exactness")?.passed ?? false;

  const checks = {
    determinism: determinism.passed,
    replay,
    policy: policy.passed,
    orchestration: orchestration.passed,
  };

  const failures = [
    ...determinism.failures.map((entry) => `determinism: ${entry}`),
    ...policy.failures.map((entry) => `policy: ${entry}`),
    ...orchestration.failures.map((entry) => `orchestration: ${entry}`),
  ];

  const result: ContinuousVerificationResult = {
    passed: failures.length === 0,
    checks,
    failures,
  };

  emitTelemetryEvent("validation", {
    continuousVerify: result,
    root: root ?? "<none>",
  });

  if (!result.passed) {
    store.counters.determinismFailures += checks.determinism ? 0 : 1;
    store.counters.replayMismatches += checks.replay ? 0 : 1;
    refreshCoreMetrics();
  }

  return result;
}

export function evaluateSLOs(): SLOEvaluation[] {
  const actualByName: Record<string, number> = {
    "execution-success-rate": executionSuccessRate(),
    "rollback-success-rate": rollbackSuccessRate(),
    "replay-accuracy": replayAccuracy(),
  };

  return PRODUCTION_SLOS.map((slo) => {
    const actual = actualByName[slo.name] ?? 0;
    return {
      ...slo,
      actual,
      met: actual >= slo.target,
    };
  });
}

export function validatePerformance(plan: { id?: string; tasks?: Array<{ dependsOn?: string[] }>; units?: Array<{ dependencies?: string[] }> }): PerformanceValidationResult {
  const taskCount = Array.isArray(plan.tasks)
    ? plan.tasks.length
    : (Array.isArray(plan.units) ? plan.units.length : 0);

  const edgeCount = Array.isArray(plan.tasks)
    ? plan.tasks.reduce((sum, task) => sum + (task.dependsOn?.length ?? 0), 0)
    : (Array.isArray(plan.units)
      ? plan.units.reduce((sum, unit) => sum + (unit.dependencies?.length ?? 0), 0)
      : 0);

  const maxPossibleEdges = Math.max(1, taskCount * Math.max(0, taskCount - 1));
  const density = edgeCount / maxPossibleEdges;

  const errors: string[] = [];
  if (taskCount > 5000) {
    errors.push("Plan size exceeds safe bound for deterministic orchestration");
  }
  if (edgeCount > taskCount * 20) {
    errors.push("Edge growth exceeds linear-safe bound and risks superlinear behavior");
  }
  if (density > 0.6) {
    errors.push("DAG density too high for predictable orchestration latency");
  }

  const result: PerformanceValidationResult = {
    valid: errors.length === 0,
    errors,
    stats: {
      units: taskCount,
      edges: edgeCount,
      density,
    },
  };

  emitTelemetryEvent("validation", {
    performance: result,
  });

  return result;
}

export function runLoadTest(units = 200, width = 8): LoadTestResult {
  const safeUnits = Math.max(10, Math.min(2000, Math.floor(units)));
  const safeWidth = Math.max(1, Math.min(64, Math.floor(width)));

  const edges: Array<{ from: number; to: number }> = [];
  for (let index = 0; index < safeUnits; index += 1) {
    for (let dep = 1; dep <= safeWidth; dep += 1) {
      const from = index - dep;
      if (from < 0) {
        break;
      }

      edges.push({ from, to: index });
    }
  }

  const byDepth = new Map<number, number>();
  for (let index = 0; index < safeUnits; index += 1) {
    const depth = Math.floor(index / safeWidth);
    byDepth.set(depth, (byDepth.get(depth) ?? 0) + 1);
  }

  const maxStageWidth = Math.max(...byDepth.values());
  const errors: string[] = [];
  if (edges.length > safeUnits * safeWidth * 2) {
    errors.push("Load graph edge count exceeded deterministic bound");
  }
  if (maxStageWidth <= 0) {
    errors.push("Invalid stage width calculated during load test");
  }

  const result: LoadTestResult = {
    passed: errors.length === 0,
    units: safeUnits,
    edges: edges.length,
    maxStageWidth,
    errors,
  };

  emitTelemetryEvent("validation", {
    loadTest: result,
  });

  return result;
}

const rateWindow = new Map<string, { windowStart: number; count: number }>();

export function rateLimitAllow(key: string, limit: number, windowSize = 60): boolean {
  const current = Math.max(0, store.logicalTime);
  const state = rateWindow.get(key);

  if (!state || (current - state.windowStart) >= windowSize) {
    rateWindow.set(key, {
      windowStart: current,
      count: 1,
    });
    return true;
  }

  if (state.count >= limit) {
    appendStructuredLog("warn", "Rate limit exceeded", { key, limit, windowSize });
    emitTelemetryEvent("failure", { key, reason: "rate-limit" });
    return false;
  }

  state.count += 1;
  rateWindow.set(key, state);
  return true;
}

type CircuitState = {
  failures: number;
  openUntil: number;
};

const circuitState = new Map<string, CircuitState>();

export function circuitAllow(key: string, failureThreshold = 3, cooldown = 30): boolean {
  const current = Math.max(0, store.logicalTime);
  const state = circuitState.get(key) ?? { failures: 0, openUntil: -1 };

  if (state.openUntil > current) {
    appendStructuredLog("warn", "Circuit breaker is open", { key, openUntil: state.openUntil });
    emitTelemetryEvent("failure", { key, reason: "circuit-open" });
    return false;
  }

  if (state.openUntil > -1 && state.openUntil <= current) {
    state.failures = 0;
    state.openUntil = -1;
  }

  if (state.failures >= failureThreshold) {
    state.openUntil = current + cooldown;
    circuitState.set(key, state);
    appendStructuredLog("error", "Circuit breaker opened", { key, openUntil: state.openUntil });
    emitTelemetryEvent("failure", { key, reason: "circuit-opened" });
    return false;
  }

  circuitState.set(key, state);
  return true;
}

export function recordCircuitSuccess(key: string): void {
  const state = circuitState.get(key);
  if (!state) {
    return;
  }

  state.failures = 0;
  state.openUntil = -1;
  circuitState.set(key, state);
}

export function recordCircuitFailure(key: string): void {
  const state = circuitState.get(key) ?? { failures: 0, openUntil: -1 };
  state.failures += 1;
  circuitState.set(key, state);
}

export async function withExecutionTimeout<T>(
  timeoutMs: number,
  work: () => Promise<T>
): Promise<T> {
  const safeTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Execution timed out after ${safeTimeoutMs}ms`));
    }, safeTimeoutMs);

    work()
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export function setFeatureFlag(name: string, enabled: boolean): FeatureFlag {
  store.featureFlags.set(name, enabled);
  appendStructuredLog("info", "Feature flag updated", { name, enabled });
  emitTelemetryEvent("validation", {
    featureFlag: {
      name,
      enabled,
    },
  });
  return {
    name,
    enabled,
  };
}

export function isFeatureEnabled(name: string): boolean {
  return store.featureFlags.get(name) ?? false;
}

export function listFeatureFlags(): FeatureFlag[] {
  return [...store.featureFlags.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, enabled]) => ({ name, enabled }));
}

export function recordExecutionOutcome(input: { success: boolean; rolledBack: boolean; source: string }): void {
  store.counters.executions += 1;
  if (input.success) {
    store.counters.executionSuccesses += 1;
  }

  if (input.rolledBack) {
    store.counters.rollbackAttempts += 1;
    if (!input.success) {
      store.counters.rollbackSuccesses += 1;
    }
  }

  refreshCoreMetrics();
  emitTelemetryEvent(input.success ? "execution" : "failure", {
    source: input.source,
    success: input.success,
    rolledBack: input.rolledBack,
  });
}

export function recordPolicyOutcome(input: { denied: boolean; source: string }): void {
  store.counters.policyEvaluations += 1;
  if (input.denied) {
    store.counters.policyDenials += 1;
  }

  refreshCoreMetrics();
  emitTelemetryEvent("policy", {
    source: input.source,
    denied: input.denied,
  });
}

export function recordDeterminismFailure(count = 1): void {
  store.counters.determinismFailures += Math.max(0, Math.floor(count));
  refreshCoreMetrics();
  emitTelemetryEvent("failure", {
    determinismFailures: store.counters.determinismFailures,
  });
}

export function recordReplayMismatch(count = 1): void {
  store.counters.replayMismatches += Math.max(0, Math.floor(count));
  refreshCoreMetrics();
  emitTelemetryEvent("failure", {
    replayMismatches: store.counters.replayMismatches,
  });
}

export function markPolicyBypassAttempt(context: unknown): void {
  appendStructuredLog("error", "Policy bypass attempt detected", {
    policyBypassAttempt: true,
    context: canonicalizeUnknown(context),
  });
}

export function listTelemetryEvents(): TelemetryEvent[] {
  return [...store.telemetryEvents];
}

function listMetrics(): Metric[] {
  return [...store.metrics];
}

function listTraces(): Trace[] {
  return [...store.traces];
}

function listLogs(): Array<LogEntry & { id: string; logicalTime: number }> {
  return [...store.logs];
}

export function getProductionSnapshot(root?: string): ProductionSnapshotView {
  const health = healthCheck(root);
  const alerts = evaluateAlerts(root);
  const slos = evaluateSLOs();

  const hotspotCounts = new Map<string, number>();
  for (const incident of store.incidents) {
    hotspotCounts.set(incident.cause, (hotspotCounts.get(incident.cause) ?? 0) + 1);
  }

  const failureHotspots = [...hotspotCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([cause]) => cause);

  return {
    health,
    metrics: [...store.metrics].slice(-20),
    alerts,
    incidents: [...store.incidents].slice(-20),
    slos,
    failureHotspots,
    traces: [...store.traces].slice(-20),
  };
}

function continuousVerificationEnabled(): boolean {
  return isFeatureEnabled("continuous-verification.enabled");
}

export function currentObservabilityFingerprint(): string {
  return deterministicHash({
    telemetryEvents: store.telemetryEvents,
    metrics: store.metrics,
    traces: store.traces,
    logs: store.logs,
    counters: store.counters,
    flags: listFeatureFlags(),
  });
}

export function latestRequiredMetrics(): Record<string, number> {
  return {
    execution_success_rate: metricValue("execution_success_rate"),
    rollback_rate: metricValue("rollback_rate"),
    policy_denial_rate: metricValue("policy_denial_rate"),
    determinism_failures: metricValue("determinism_failures"),
    replay_mismatches: metricValue("replay_mismatches"),
  };
}
