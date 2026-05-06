import {
  DAG,
  GlobalPlan,
  GlobalUnit,
  Repo,
  buildGlobalDAG,
  executeGlobalPlan,
  groupIntoStages,
  hashState,
  isolateFailure,
  mergeStates,
  partitionUnitsAcrossNodes,
  tick,
  topologicalSort,
  validateGlobalState,
  detectCycles,
} from "./globalOrchestration.js";

export type OrchestrationVerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type OrchestrationVerificationReport = {
  passed: boolean;
  checks: OrchestrationVerificationCheck[];
  failures: string[];
};

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

function fixtureUnits(): GlobalUnit[] {
  return [
    {
      id: "repo-a:t1",
      repo: "repo-a",
      path: "packages/repo-a/src/index.ts",
      dependencies: [],
      hash: "",
    },
    {
      id: "repo-b:t1",
      repo: "repo-b",
      path: "packages/repo-b/src/index.ts",
      dependencies: ["repo-a:t1"],
      hash: "",
    },
    {
      id: "repo-c:t1",
      repo: "repo-c",
      path: "packages/repo-c/src/index.ts",
      dependencies: [],
      hash: "",
    },
  ];
}

function fixtureRepos(): Repo[] {
  return [
    {
      id: "repo-a",
      dependencies: [],
      state: { meta: { value: "0" } },
    },
    {
      id: "repo-b",
      dependencies: ["repo-a"],
      state: { meta: { value: "0" } },
    },
    {
      id: "repo-c",
      dependencies: [],
      state: { meta: { value: "0" } },
    },
  ];
}

function fixturePlan(id: string): GlobalPlan {
  return {
    id,
    tasks: [
      {
        id: "repo-a:t1",
        repoId: "repo-a",
        action: "set:meta.value=1",
        dependsOn: [],
      },
      {
        id: "repo-c:t1",
        repoId: "repo-c",
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

function cyclePlan(): GlobalPlan {
  return {
    id: "orchestration-cycle",
    tasks: [
      {
        id: "repo-a:t1",
        repoId: "repo-a",
        action: "set:meta.value=1",
        dependsOn: ["repo-a:t2"],
      },
      {
        id: "repo-a:t2",
        repoId: "repo-a",
        action: "set:meta.value=2",
        dependsOn: ["repo-a:t1"],
      },
    ],
  };
}

function applySetAction(action: string, state: Record<string, unknown>): Record<string, unknown> {
  if (!action.startsWith("set:")) {
    return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  }

  const payload = action.slice("set:".length).trim();
  const [path, valueRaw] = payload.split("=");
  if (!path || typeof valueRaw === "undefined") {
    return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  }

  const segments = path.split(".").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (segments.length === 0) {
    return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  }

  const next = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
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

export async function runOrchestrationVerification(): Promise<OrchestrationVerificationReport> {
  const checks: OrchestrationVerificationCheck[] = [];

  const dag = buildGlobalDAG(fixtureUnits());
  const ordered = topologicalSort(dag);
  const stages = groupIntoStages(ordered);

  const cycleDag = buildGlobalDAG([
    {
      id: "u1",
      repo: "repo-a",
      path: "repo-a",
      dependencies: ["u2"],
      hash: "",
    },
    {
      id: "u2",
      repo: "repo-a",
      path: "repo-a",
      dependencies: ["u1"],
      hash: "",
    },
  ]);

  let cycleBlocked = false;
  try {
    const cycleResult = await executeGlobalPlan(cyclePlan(), {
      repos: [{ id: "repo-a", dependencies: [], state: { meta: { value: "0" } } }],
      policies: [],
    });
    cycleBlocked = cycleResult.success === false;
  } catch {
    cycleBlocked = true;
  }

  const cyclePassed = detectCycles(cycleDag) && cycleBlocked;
  checks.push({
    name: "cycle-detection-hard-block",
    passed: cyclePassed,
    detail: cyclePassed
      ? "cycle was detected and execution was blocked"
      : "cycle was not detected or execution was not blocked",
  });

  const reorderedDag = buildGlobalDAG([...fixtureUnits()].reverse());
  const reordered = topologicalSort(reorderedDag).map((entry) => entry.id);
  const canonical = ordered.map((entry) => entry.id);
  const orderingPassed = stableStringify(canonical) === stableStringify(reordered);
  checks.push({
    name: "deterministic-topological-order",
    passed: orderingPassed,
    detail: orderingPassed
      ? "same DAG produced stable deterministic order"
      : `ordering diverged (${canonical.join(",")} vs ${reordered.join(",")})`,
  });

  const stageIndexByUnit = new Map<string, number>();
  stages.forEach((stage, index) => {
    stage.unitIds.forEach((unitId) => stageIndexByUnit.set(unitId, index));
  });
  const stageDependencyPassed = ordered.every((unit) =>
    unit.dependencies.every((dependencyId) =>
      (stageIndexByUnit.get(dependencyId) ?? -1) < (stageIndexByUnit.get(unit.id) ?? Number.MAX_SAFE_INTEGER)
    )
  );
  checks.push({
    name: "stage-grouping-respects-dependencies",
    passed: stageDependencyPassed,
    detail: stageDependencyPassed
      ? "all dependent units were placed in later stages"
      : "stage grouping allowed dependency violations",
  });

  const partitionsA = partitionUnitsAcrossNodes(ordered, ["node-2", "node-1"]);
  const partitionsB = partitionUnitsAcrossNodes(ordered, ["node-1", "node-2"]);
  const partitionPassed = stableStringify(partitionsA) === stableStringify(partitionsB);
  checks.push({
    name: "deterministic-node-partitioning",
    passed: partitionPassed,
    detail: partitionPassed
      ? "unit partitioning across nodes was deterministic"
      : "partitioning changed under equivalent node inputs",
  });

  const clock = { time: 0 };
  tick(clock);
  tick(clock);
  const logicalClockPassed = clock.time === 2;
  checks.push({
    name: "logical-clock-monotonic",
    passed: logicalClockPassed,
    detail: logicalClockPassed
      ? "logical clock advanced without wall clock dependency"
      : "logical clock did not advance deterministically",
  });

  const mergeLeft = {
    "repo-a": { meta: { value: "1" } },
  };
  const mergeRight = {
    "repo-b": { meta: { value: "2" } },
  };
  const mergedAB = mergeStates(mergeLeft, mergeRight);
  const mergedBA = mergeStates(mergeRight, mergeLeft);
  let conflictRaised = false;
  try {
    mergeStates(
      { "repo-a": { meta: { value: "1" } } },
      { "repo-a": { meta: { value: "2" } } }
    );
  } catch {
    conflictRaised = true;
  }

  const convergencePassed = stableStringify(mergedAB) === stableStringify(mergedBA) && conflictRaised;
  checks.push({
    name: "distributed-merge-convergence",
    passed: convergencePassed,
    detail: convergencePassed
      ? "merge was commutative for compatible states and explicit on conflicts"
      : "merge convergence/explicit-conflict guarantee failed",
  });

  const mergedUnits = Object.keys(mergedAB)
    .sort((left, right) => left.localeCompare(right))
    .map((unitId) => ({
      id: unitId,
      repo: unitId,
      path: unitId,
      dependencies: [],
      hash: "",
    } satisfies GlobalUnit));
  const mergeDag = buildGlobalDAG(mergedUnits);
  const expectedHashes = Object.fromEntries(
    Object.keys(mergedAB)
      .sort((left, right) => left.localeCompare(right))
      .map((unitId) => [unitId, hashState({ [unitId]: mergedAB[unitId] })] as const)
  );

  const consistency = validateGlobalState(mergedAB, mergeDag, expectedHashes);
  checks.push({
    name: "global-consistency-validation",
    passed: consistency.valid,
    detail: consistency.valid
      ? "global state validated dependency references and hashes"
      : consistency.errors.join("; "),
  });

  const failurePlan = fixturePlan("orchestration-failure-isolation");
  const executionOrderTrace: string[] = [];
  const firstRun = await executeGlobalPlan(failurePlan, {
    repos: fixtureRepos(),
    policies: [],
    executeTask: async (task, state, _repoId, _allStates, mode) => {
      if (mode === "execution" && task.id === "repo-b:t1") {
        throw new Error("injected failure");
      }

      executionOrderTrace.push(task.id);
      return applySetAction(task.action, state as Record<string, unknown>) as Record<string, unknown>;
    },
  });

  const isolationScope = isolateFailure("repo-b:t1", dag);
  const failureIsolationPassed = firstRun.success === false
    && firstRun.rolledBack
    && stableStringify(firstRun.rollbackTrace?.rollbackSet ?? []) === stableStringify(["repo-b"])
    && stableStringify(isolationScope) === stableStringify(["repo-b:t1"])
    && stableStringify(firstRun.finalStates["repo-a"]) === stableStringify({ meta: { value: "1" } })
    && stableStringify(firstRun.finalStates["repo-c"]) === stableStringify({ meta: { value: "1" } })
    && stableStringify(firstRun.finalStates["repo-b"]) === stableStringify({ meta: { value: "0" } });

  checks.push({
    name: "failure-isolation-and-partial-rollback",
    passed: failureIsolationPassed,
    detail: failureIsolationPassed
      ? "only failed scope was rolled back; unrelated units remained applied"
      : [
        `success=${firstRun.success}`,
        `rolledBack=${firstRun.rolledBack}`,
        `rollbackSet=${(firstRun.rollbackTrace?.rollbackSet ?? []).join(",") || "none"}`,
        `repoA=${stableStringify(firstRun.finalStates["repo-a"])}`,
        `repoB=${stableStringify(firstRun.finalStates["repo-b"])}`,
        `repoC=${stableStringify(firstRun.finalStates["repo-c"])}`,
      ].join("; "),
  });

  const successPlan = fixturePlan("orchestration-success-order");
  const executed = await executeGlobalPlan(successPlan, {
    repos: fixtureRepos(),
    policies: [],
    executeTask: async (task, state) => applySetAction(task.action, state as Record<string, unknown>) as Record<string, unknown>,
  });
  const depIndex = new Map(executed.trace.executionOrder.map((taskId, index) => [taskId, index] as const));
  const executionOrderPassed = successPlan.tasks.every((task) =>
    task.dependsOn.every((dependencyId) => (depIndex.get(dependencyId) ?? -1) < (depIndex.get(task.id) ?? Number.MAX_SAFE_INTEGER))
  );

  const repeated = await executeGlobalPlan(successPlan, {
    repos: fixtureRepos(),
    policies: [],
    executeTask: async (task, state) => applySetAction(task.action, state as Record<string, unknown>) as Record<string, unknown>,
  });
  const traceDeterministicPassed = stableStringify(executed.trace.stages) === stableStringify(repeated.trace.stages)
    && stableStringify(executed.trace.executionOrder) === stableStringify(repeated.trace.executionOrder);

  checks.push({
    name: "execution-order-respects-dag",
    passed: executionOrderPassed,
    detail: executionOrderPassed
      ? "execution order respected all DAG dependencies"
      : `invalid execution order: ${executed.trace.executionOrder.join(",")}`,
  });

  checks.push({
    name: "global-trace-reproducible",
    passed: traceDeterministicPassed,
    detail: traceDeterministicPassed
      ? "stage and execution traces reproduced deterministically"
      : "trace content changed for same input",
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

export function formatOrchestrationVerificationReport(report: OrchestrationVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} orchestration verification`,
    ...report.checks.map((entry) => `- ${entry.name}: ${entry.passed ? "PASS" : "FAIL"} (${entry.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((entry) => `- ${entry}`));
  }

  return lines.join("\n");
}
