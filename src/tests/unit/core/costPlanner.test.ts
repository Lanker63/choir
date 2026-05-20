import { describe, expect, it } from "vitest";
import type { Plan, Task } from "../../../schema.js";
import {
  buildCostTrace,
  estimateDependencyDepth,
  scorePlans,
  selectBestPlan,
} from "../../../core/costPlanner.js";
import { createEmptyStatePlane } from "../../../core/state.js";

function makeTask(id: string, type: Task["type"], dependsOn: string[] = [], files: string[] = []): Task {
  return {
    id,
    title: id,
    type,
    dependsOn,
    successCriteria: ["ok"],
    ...(files.length > 0 ? { scope: { files } } : {}),
  };
}

function makePlan(id: string, tasks: Task[]): Plan {
  return {
    id,
    title: id,
    derivedFrom: "goal",
    goalRefs: [id],
    tasks,
    status: "draft",
  };
}

describe("costPlanner", () => {
  it("uses deterministic plan-id tie break when total cost matches", () => {
    const state = createEmptyStatePlane();
    const planA = makePlan("plan-a", [makeTask("task-a", "analysis")]);
    const planB = makePlan("plan-b", [makeTask("task-b", "analysis")]);

    const scored = scorePlans([planB, planA], state);

    expect(scored.map((entry) => entry.planId)).toEqual(["plan-a", "plan-b"]);
    expect(selectBestPlan([planB, planA], state).id).toBe("plan-a");
  });

  it("penalizes cyclic dependency depth deterministically", () => {
    const state = createEmptyStatePlane();
    const cyclical = makePlan("plan-cycle", [
      makeTask("task-a", "analysis", ["task-b"]),
      makeTask("task-b", "refactor", ["task-a"]),
    ]);

    expect(estimateDependencyDepth(cyclical, state)).toBeGreaterThan(cyclical.tasks.length);
  });

  it("emits explainable trace for selected plan", () => {
    const state = createEmptyStatePlane();
    state.violations = [
      {
        id: "diag-1",
        ruleId: "rule-a",
        message: "violation",
        severity: "error",
        category: "AST",
        location: {
          file: "src/a.ts",
          start: { line: 1, character: 0 },
          end: { line: 1, character: 1 },
        },
        traceId: "trace-1",
      },
    ];

    const plan = makePlan("plan-trace", [
      makeTask("task-analysis", "analysis"),
      makeTask("task-refactor", "refactor", ["task-analysis"], ["src/a.ts"]),
    ]);

    const score = scorePlans([plan], state);
    const trace = buildCostTrace("plan-trace", score);

    expect(trace.selectedPlanId).toBe("plan-trace");
    expect(trace.decision).toContain("lowest total cost");
    expect(trace.evaluatedPlans).toHaveLength(1);
  });
});
