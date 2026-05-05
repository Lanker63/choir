import assert from "assert";
import fs from "fs";
import path from "path";
import { compileControlPlaneToRules } from "../../dsl/compiler.js";
import {
  createHarnessFromFixture,
  fileExists,
  listFiles,
  repoRoot,
  searchCodebase,
  simulateRuleEditorValidation,
  snapshotWorkspace,
  validateStateDeterminism,
} from "./harness.js";
import { runConflictResolutionEngine } from "../../fix/conflictEngine.js";
import {
  buildCostTrace,
  scorePlan,
  scorePlans,
  selectBestPlan,
  selectPlanSet,
} from "../../core/costPlanner.js";
import {
  MAX_STRATEGIES,
  STRATEGIES,
  StrategyResult,
  buildStrategyTrace,
  evaluateStrategies,
  groupedStrategy,
  layeredStrategy,
  aggressiveStrategy,
  selectBestStrategy,
} from "../../core/strategyPlanner.js";
import {
  ExecutionPreview,
  generateDiff,
  groupPatchesByFile,
  hashPreview,
} from "../../core/executionPreview.js";
import { Diagnostic, SourceLocation } from "../../core/types.js";
import { Fix, Patch } from "../../fix/types.js";
import { parseConductorCommand } from "../../conductorCommands.js";
import { computeLayers, generatePlan, getExecutableTasks, taskExecutionKey } from "../../core/orchestration.js";
import {
  buildConflictMatrix,
  buildExecutionGraph,
  buildExecutionPlan,
  computeExecutionLayers,
  createInMemoryTransactionFS,
  runExecutionPlan,
  runExecutionPlanTransactionally,
} from "../../core/scheduler.js";
import { createEmptyStatePlane } from "../../core/state.js";
import { CONTROL_PLANE_VERSION, ControlPlane, ControlPlaneSchema, Plan, Task } from "../../schema.js";

function testLocation(file: string, startLine: number, startChar: number, endLine: number, endChar: number): SourceLocation {
  return {
    file,
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
  };
}

function makeControlPlane(overrides?: ControlPlane["policy"]["priorityOverrides"]): ControlPlane {
  return {
    version: CONTROL_PLANE_VERSION,
    mission: "",
    vision: "",
    intent: {
      goals: [],
      constraints: [],
      "non-goals": [],
    },
    policy: {
      rules: [],
      ...(overrides ? { priorityOverrides: overrides } : {}),
    },
    execution: {
      plans: [],
    },
  };
}

function makeTask(
  id: string,
  type: Task["type"],
  options: {
    title?: string;
    files?: string[];
    dependsOn?: string[];
  } = {}
): Task {
  return {
    id,
    title: options.title ?? id,
    type,
    ...(options.files ? { scope: { files: options.files } } : {}),
    ...(options.dependsOn ? { dependsOn: options.dependsOn } : { dependsOn: [] }),
    successCriteria: ["ok"],
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

type TestCase = {
  id: string;
  name: string;
  run: () => Promise<void>;
};

type TestPass = {
  name: string;
  tests: TestCase[];
};

const planGoldenRoot = path.join(repoRoot, "src", "tests", "architecture", "golden", "plans");

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, "\n").trim();
}

async function assertPlanGoldenForFixture(fixtureName: string, goldenFileName: string): Promise<void> {
  await withFixture(fixtureName, async ({ harness }) => {
    await harness.runPipeline();
    const control = harness.loadControlPlane();
    const state = harness.readState();
    const plan = generatePlan(control, state);

    const snapshotPath = path.join(planGoldenRoot, goldenFileName);
    const expected = normalizeLineEndings(fs.readFileSync(snapshotPath, "utf-8"));
    const actual = normalizeLineEndings(JSON.stringify(plan, null, 2));

    assert.strictEqual(
      actual,
      expected,
      `Generated plan snapshot mismatch for fixture ${fixtureName} at ${snapshotPath}`
    );
  });
}

async function withFixture(
  fixtureName: string,
  run: (args: { root: string; harness: ReturnType<typeof createHarnessFromFixture>["harness"] }) => Promise<void>
): Promise<void> {
  const fixture = createHarnessFromFixture(fixtureName);
  try {
    await run({ root: fixture.root, harness: fixture.harness });
  } finally {
    fixture.dispose();
  }
}

const pass1: TestPass = {
  name: "Pass 1 — Control Plane Tests",
  tests: [
    {
      id: "1.1",
      name: "only one control plane YAML exists",
      run: async () => {
        await withFixture("simple-project", async ({ root }) => {
          const files = listFiles(path.join(root, ".choir"));
          const yamlFiles = files.filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"));
          assert.strictEqual(yamlFiles.length, 1);
        });
      },
    },
    {
      id: "1.2",
      name: "control plane matches canonical schema",
      run: async () => {
        await withFixture("simple-project", async ({ harness }) => {
          const control = harness.loadControlPlane();

          assert.strictEqual(typeof control.version, "string");
          assert.strictEqual(typeof control.mission, "string");
          assert.strictEqual(typeof control.vision, "string");
          assert.ok(Array.isArray(control.intent["non-goals"]));
          assert.ok(Array.isArray(control.intent.goals));
          assert.ok(Array.isArray(control.intent.constraints));
          assert.ok(Array.isArray(control.policy.rules));
          assert.ok(Array.isArray(control.execution.plans));
        });
      },
    },
    {
      id: "1.3",
      name: "control plane compiles into executable rules",
      run: async () => {
        await withFixture("simple-project", async ({ harness }) => {
          const control = harness.loadControlPlane();
          const rules = compileControlPlaneToRules(control);
          assert.ok(rules.length > 0);
        });
      },
    },
    {
      id: "1.4",
      name: "control plane rejects duplicate plan ids",
      run: async () => {
        const invalid = {
          ...makeControlPlane(),
          execution: {
            plans: [
              {
                id: "plan-duplicate",
                title: "Plan A",
                derivedFrom: "manual",
                tasks: [
                  {
                    id: "task-a",
                    title: "Task A",
                    type: "analysis",
                    successCriteria: ["analyze"],
                  },
                ],
                status: "draft",
              },
              {
                id: "plan-duplicate",
                title: "Plan B",
                derivedFrom: "manual",
                tasks: [
                  {
                    id: "task-b",
                    title: "Task B",
                    type: "analysis",
                    successCriteria: ["analyze"],
                  },
                ],
                status: "draft",
              },
            ],
          },
        };

        assert.throws(() => ControlPlaneSchema.parse(invalid), /Duplicate plan id/);
      },
    },
    {
      id: "1.5",
      name: "control plane rejects circular task dependencies",
      run: async () => {
        const invalid = {
          ...makeControlPlane(),
          execution: {
            plans: [
              {
                id: "plan-cycle",
                title: "Cycle",
                derivedFrom: "manual",
                tasks: [
                  {
                    id: "task-1",
                    title: "Task 1",
                    type: "analysis",
                    dependsOn: ["task-2"],
                    successCriteria: ["one"],
                  },
                  {
                    id: "task-2",
                    title: "Task 2",
                    type: "refactor",
                    dependsOn: ["task-1"],
                    successCriteria: ["two"],
                  },
                ],
                status: "draft",
              },
            ],
          },
        };

        assert.throws(() => ControlPlaneSchema.parse(invalid), /Circular task dependency detected/);
      },
    },
  ],
};

const pass2: TestPass = {
  name: "Pass 2 — Chat Non-Authority Tests",
  tests: [
    {
      id: "2.1",
      name: "chat does not produce diagnostics without persistence",
      run: async () => {
        await withFixture("simple-project", async ({ harness }) => {
          harness.sendChat("forbid console.log");
          const diagnostics = harness.readDiagnostics();
          assert.strictEqual(diagnostics.length, 0);
        });
      },
    },
    {
      id: "2.2",
      name: "chat mutates control plane YAML",
      run: async () => {
        await withFixture("simple-project", async ({ harness }) => {
          harness.sendChat("add constraint: no console.log");
          const control = harness.loadControlPlane();
          assert.ok(control.intent.constraints.includes("no console.log"));
        });
      },
    },
    {
      id: "2.3",
      name: "enforcement requires pipeline execution",
      run: async () => {
        await withFixture("simple-project", async ({ harness }) => {
          harness.sendChat("add constraint: no console.log");

          let diagnostics = harness.readDiagnostics();
          assert.strictEqual(diagnostics.length, 0);

          await harness.runPipeline();
          diagnostics = harness.readDiagnostics();
          assert.ok(diagnostics.length > 0);
        });
      },
    },
    {
      id: "2.4",
      name: "enforcer does not consume raw chat input",
      run: async () => {
        const enforcerPath = path.join(repoRoot, "src", "enforcer.ts");
        const code = fs.readFileSync(enforcerPath, "utf-8");
        assert.ok(!/request\.text/.test(code));
      },
    },
    {
      id: "2.5",
      name: "plural chat directives split comma-delimited lists",
      run: async () => {
        await withFixture("simple-project", async ({ harness }) => {
          harness.sendChat("add non-goals: Distributed app, authenticatoin, authorization");
          harness.sendChat("add constraints: no database, no user adminitstration");
          const control = harness.loadControlPlane();

          assert.ok(control.intent["non-goals"].includes("Distributed app"));
          assert.ok(control.intent["non-goals"].includes("authenticatoin"));
          assert.ok(control.intent["non-goals"].includes("authorization"));
          assert.ok(!control.intent["non-goals"].includes("Distributed app, authenticatoin, authorization"));

          assert.ok(control.intent.constraints.includes("no database"));
          assert.ok(control.intent.constraints.includes("no user adminitstration"));
          assert.ok(!control.intent.constraints.includes("no database, no user adminitstration"));
        });
      },
    },
    {
      id: "2.6",
      name: "conductor parser handles plan commands deterministically",
      run: async () => {
        assert.deepStrictEqual(
          parseConductorCommand("plan for goal: enforce service boundaries"),
          { kind: "plan", goal: "enforce service boundaries" }
        );
        assert.deepStrictEqual(
          parseConductorCommand("PLAN"),
          { kind: "plan" }
        );
      },
    },
    {
      id: "2.7",
      name: "conductor parser handles approve/preview/execute/status/help",
      run: async () => {
        assert.deepStrictEqual(parseConductorCommand("approve plan-123"), { kind: "approve", planId: "plan-123" });
        assert.deepStrictEqual(parseConductorCommand("approve"), { kind: "approve", planId: undefined });
        assert.deepStrictEqual(parseConductorCommand("preview plan-123"), { kind: "preview", planId: "plan-123" });
        assert.deepStrictEqual(parseConductorCommand("preview"), { kind: "preview", planId: undefined });
        const previewHash = "a".repeat(64);
        assert.deepStrictEqual(parseConductorCommand(`execute ${previewHash}`), { kind: "execute", previewId: previewHash });
        assert.deepStrictEqual(parseConductorCommand(`execute plan-123 ${previewHash}`), { kind: "execute", planId: "plan-123", previewId: previewHash });
        assert.deepStrictEqual(parseConductorCommand("execute plan-123"), { kind: "execute", planId: "plan-123" });
        assert.deepStrictEqual(parseConductorCommand("status"), { kind: "status" });
        assert.deepStrictEqual(parseConductorCommand("something else"), { kind: "help" });
      },
    },
  ],
};

const pass3: TestPass = {
  name: "Pass 3 — State Plane Tests",
  tests: [
    {
      id: "3.1",
      name: "state file is generated",
      run: async () => {
        await withFixture("multi-module", async ({ harness, root }) => {
          await harness.runPipeline();
          assert.strictEqual(fileExists(path.join(root, ".choir", "state.json")), true);
        });
      },
    },
    {
      id: "3.2",
      name: "state contains required structures",
      run: async () => {
        await withFixture("multi-module", async ({ harness }) => {
          await harness.runPipeline();
          const state = harness.readState();

          assert.ok(typeof state.astIndex === "object" && state.astIndex !== null);
          assert.ok(typeof state.symbolGraph === "object" && state.symbolGraph !== null);
          assert.ok(Array.isArray(state.violations));
          assert.ok(typeof state.metrics === "object" && state.metrics !== null);
          assert.ok(typeof state.dependencyGraph === "object" && state.dependencyGraph !== null);
          assert.ok(typeof state.execution === "object" && state.execution !== null);
          assert.ok(typeof state.execution.taskStatus === "object" && state.execution.taskStatus !== null);
          assert.ok(typeof state.execution.taskResults === "object" && state.execution.taskResults !== null);
          assert.ok(Array.isArray(state.execution.history));
        });
      },
    },
    {
      id: "3.3",
      name: "state is reproducible",
      run: async () => {
        await withFixture("dependency-graph", async ({ harness }) => {
          await harness.runPipeline();
          const state1 = harness.readState();

          await harness.runPipeline();
          const state2 = harness.readState();

          assert.deepStrictEqual(state1, state2);
        });
      },
    },
    {
      id: "3.4",
      name: "state derived only from workspace plus control plane",
      run: async () => {
        await withFixture("dependency-graph", async ({ harness, root }) => {
          const snapshot = snapshotWorkspace(root);
          await harness.runPipeline();
          const state = harness.readState();

          assert.strictEqual(await validateStateDeterminism(snapshot, state), true);
        });
      },
    },
    {
      id: "3.5",
      name: "deterministic plan generation from goals and violations",
      run: async () => {
        const control = makeControlPlane();
        control.intent.goals = ["enforce service boundaries"];
        control.intent.constraints = ["no direct db access"];

        const state = createEmptyStatePlane();
        state.violations = [
          {
            id: "diag-1",
            ruleId: "intent-no-direct-db-access",
            message: "violation A",
            severity: "error",
            category: "AST",
            location: testLocation("src/services/user.ts", 1, 0, 1, 5),
            traceId: "trace-1",
          },
          {
            id: "diag-2",
            ruleId: "rule-b",
            message: "violation B",
            severity: "warning",
            category: "strategy",
            location: testLocation("src/repositories/userRepo.ts", 2, 0, 2, 7),
            traceId: "trace-2",
          },
        ];

        const first = generatePlan(control, state);
        const second = generatePlan(control, state);

        assert.deepStrictEqual(first, second);
        assert.strictEqual(first.tasks[0]?.type, "analysis");
        assert.strictEqual(first.tasks[first.tasks.length - 1]?.type, "enforce");

        const refactors = first.tasks.filter((task) => task.type === "refactor");
        assert.strictEqual(refactors.length, 1);
        assert.ok(refactors[0]?.title.includes("intent-no-direct-db-access"));
      },
    },
    {
      id: "3.6",
      name: "plan snapshot matches simple-project golden",
      run: async () => {
        await assertPlanGoldenForFixture("simple-project", "simple-project.plan.json");
      },
    },
    {
      id: "3.7",
      name: "plan snapshot matches multi-module golden",
      run: async () => {
        await assertPlanGoldenForFixture("multi-module", "multi-module.plan.json");
      },
    },
    {
      id: "3.8",
      name: "plan snapshot matches dependency-graph golden",
      run: async () => {
        await assertPlanGoldenForFixture("dependency-graph", "dependency-graph.plan.json");
      },
    },
    {
      id: "3.9",
      name: "plan groups violations by rule into minimal refactor tasks",
      run: async () => {
        const control = makeControlPlane();
        control.intent.goals = ["enforce service boundaries"];

        const state = createEmptyStatePlane();
        state.violations = [
          {
            id: "diag-1",
            ruleId: "rule-shared",
            message: "v1",
            severity: "error",
            category: "AST",
            location: testLocation("src/a.ts", 1, 0, 1, 2),
            traceId: "trace-1",
          },
          {
            id: "diag-2",
            ruleId: "rule-shared",
            message: "v2",
            severity: "warning",
            category: "AST",
            location: testLocation("src/b.ts", 2, 0, 2, 2),
            traceId: "trace-2",
          },
          {
            id: "diag-3",
            ruleId: "rule-other",
            message: "v3",
            severity: "error",
            category: "AST",
            location: testLocation("src/c.ts", 3, 0, 3, 2),
            traceId: "trace-3",
          },
        ];

        const plan = generatePlan(control, state);
        const refactors = plan.tasks.filter((task) => task.type === "refactor");

        assert.strictEqual(refactors.length, 2);
        assert.ok(refactors.some((task) => task.title.includes("rule-shared")));
        assert.ok(refactors.some((task) => task.title.includes("rule-other")));
      },
    },
    {
      id: "3.10",
      name: "dependency layer computation detects cycles",
      run: async () => {
        assert.throws(
          () => computeLayers(["src/a.ts", "src/b.ts"], {
            "src/a.ts": ["./b"],
            "src/b.ts": ["./a"],
          }),
          /Cycle detected in dependency graph/
        );
      },
    },
  ],
};

const pass4: TestPass = {
  name: "Pass 4 — Pipeline Consolidation Tests",
  tests: [
    {
      id: "4.1",
      name: "pipeline is sole enforcement entry",
      run: async () => {
        const pipelineUsages = searchCodebase("runPipeline");
        const directEnforceUsages = searchCodebase(/\benforce\s*\(/);

        assert.ok(pipelineUsages.length > 0);
        assert.strictEqual(directEnforceUsages.length, 0);
      },
    },
    {
      id: "4.2",
      name: "chat triggers pipeline indirectly",
      run: async () => {
        await withFixture("simple-project", async ({ harness }) => {
          harness.sendChat("add constraint: no console.log");
          await harness.runPipeline();

          const diagnostics = harness.readDiagnostics();
          assert.ok(diagnostics.length > 0);
        });
      },
    },
    {
      id: "4.3",
      name: "rule editor validation uses pipeline",
      run: async () => {
        const result = simulateRuleEditorValidation();
        assert.strictEqual(result.source, "pipeline");
      },
    },
    {
      id: "4.4",
      name: "pipeline executes in correct order",
      run: async () => {
        await withFixture("multi-module", async ({ harness }) => {
          const trace = (await harness.runPipeline()).trace;
          assert.deepStrictEqual(trace.phases, ["AST", "SEMANTIC", "CODE", "STRATEGY"]);
        });
      },
    },
    {
      id: "4.5",
      name: "scheduler enforces dependency order",
      run: async () => {
        const control = makeControlPlane();
        control.intent.goals = ["enforce service boundaries"];
        const state = createEmptyStatePlane();
        state.violations = [
          {
            id: "diag-1",
            ruleId: "rule-a",
            message: "violation",
            severity: "error",
            category: "AST",
            location: testLocation("src/services/user.ts", 1, 0, 1, 5),
            traceId: "trace-1",
          },
        ];

        const plan = generatePlan(control, state);

        const firstExecutable = getExecutableTasks(plan, state).map((task) => task.id);
        assert.deepStrictEqual(firstExecutable, ["t-analysis"]);

        state.execution.taskStatus[taskExecutionKey(plan.id, "t-analysis")] = "complete";
        const secondExecutable = getExecutableTasks(plan, state);
        assert.ok(secondExecutable.every((task) => task.type === "refactor"));

        for (const task of secondExecutable) {
          state.execution.taskStatus[taskExecutionKey(plan.id, task.id)] = "complete";
        }

        const thirdExecutable = getExecutableTasks(plan, state).map((task) => task.id);
        assert.deepStrictEqual(thirdExecutable, ["t-validate"]);
      },
    },
    {
      id: "4.6",
      name: "global execution graph flattens and normalizes dependencies",
      run: async () => {
        const plans: Plan[] = [
          makePlan("plan-a", [
            makeTask("t-analysis", "analysis"),
            makeTask("t-refactor", "refactor", { dependsOn: ["t-analysis"], files: ["src/a.ts"] }),
          ]),
          makePlan("plan-b", [
            makeTask("t-analysis", "analysis"),
            makeTask("t-refactor", "refactor", { dependsOn: ["t-analysis"], files: ["src/b.ts"] }),
          ]),
        ];

        const graph = buildExecutionGraph(plans);
        assert.ok(graph.nodes.has("plan-a:t-analysis"));
        assert.ok(graph.nodes.has("plan-b:t-refactor"));
        assert.deepStrictEqual(graph.nodes.get("plan-a:t-refactor")?.dependencies, ["plan-a:t-analysis"]);
      },
    },
    {
      id: "4.7",
      name: "global execution graph topological layers are deterministic",
      run: async () => {
        const plans: Plan[] = [
          makePlan("plan-a", [
            makeTask("t-analysis", "analysis"),
            makeTask("t-refactor", "refactor", { dependsOn: ["t-analysis"], files: ["src/a.ts"] }),
          ]),
          makePlan("plan-b", [
            makeTask("t-analysis", "analysis"),
            makeTask("t-refactor", "refactor", { dependsOn: ["t-analysis"], files: ["src/b.ts"] }),
          ]),
        ];

        const graph = buildExecutionGraph(plans);
        const layers = computeExecutionLayers(graph);

        assert.deepStrictEqual(layers[0]?.map((node) => node.id), ["plan-a:t-analysis", "plan-b:t-analysis"]);
        assert.deepStrictEqual(layers[1]?.map((node) => node.id), ["plan-a:t-refactor", "plan-b:t-refactor"]);
      },
    },
    {
      id: "4.8",
      name: "conflict matrix blocks overlapping file mutations",
      run: async () => {
        const plans: Plan[] = [
          makePlan("plan-a", [makeTask("t-refactor", "refactor", { files: ["src/shared.ts"] })]),
          makePlan("plan-b", [makeTask("t-refactor", "refactor", { files: ["src/shared.ts"] })]),
        ];

        const graph = buildExecutionGraph(plans);
        const matrix = buildConflictMatrix(graph);

        assert.ok(matrix.get("plan-a:t-refactor")?.has("plan-b:t-refactor"));
        assert.ok(matrix.get("plan-b:t-refactor")?.has("plan-a:t-refactor"));
      },
    },
    {
      id: "4.9",
      name: "execution planner enables safe parallel batches",
      run: async () => {
        const plans: Plan[] = [
          makePlan("plan-a", [makeTask("t-refactor", "refactor", { files: ["src/a.ts"] })]),
          makePlan("plan-b", [makeTask("t-refactor", "refactor", { files: ["src/b.ts"] })]),
        ];

        const first = buildExecutionPlan(plans, { smallTaskMergeThreshold: 0 });
        const second = buildExecutionPlan(plans, { smallTaskMergeThreshold: 0 });

        assert.deepStrictEqual(first.executionPlan, second.executionPlan);
        assert.strictEqual(first.executionPlan.batches.length, 1);
        assert.strictEqual(first.executionPlan.batches[0]?.parallelizable, true);
        assert.strictEqual(first.executionPlan.batches[0]?.workUnits.length, 2);

        const results = await runExecutionPlan(first.executionPlan, async (unit) => unit.id);
        assert.strictEqual(results.length, 2);
      },
    },
    {
      id: "4.10",
      name: "execution planner separates conflicting tasks into distinct batches",
      run: async () => {
        const plans: Plan[] = [
          makePlan("plan-a", [makeTask("t-refactor", "refactor", { files: ["src/shared.ts"] })]),
          makePlan("plan-b", [makeTask("t-refactor", "refactor", { files: ["src/shared.ts"] })]),
        ];

        const planned = buildExecutionPlan(plans, { smallTaskMergeThreshold: 0 });

        assert.strictEqual(planned.executionPlan.batches.length, 2);
        assert.ok(planned.executionPlan.batches.every((batch) => batch.workUnits.length === 1));
      },
    },
    {
      id: "4.14",
      name: "cost scoring is deterministic and explainable",
      run: async () => {
        const state = createEmptyStatePlane();
        state.violations = [
          {
            id: "diag-1",
            ruleId: "rule-a",
            message: "A",
            severity: "error",
            category: "AST",
            location: testLocation("src/a.ts", 1, 0, 1, 3),
            traceId: "trace-1",
          },
          {
            id: "diag-2",
            ruleId: "rule-b",
            message: "B",
            severity: "warning",
            category: "AST",
            location: testLocation("src/b.ts", 2, 0, 2, 3),
            traceId: "trace-2",
          },
        ];

        const plan = makePlan("plan-a", [
          makeTask("t-analysis", "analysis"),
          makeTask("t-refactor", "refactor", { dependsOn: ["t-analysis"], files: ["src/a.ts"] }),
          makeTask("t-validate", "enforce", { dependsOn: ["t-refactor"] }),
        ]);

        const first = scorePlan(plan, state);
        const second = scorePlan(plan, state);

        assert.deepStrictEqual(first, second);
        assert.strictEqual(first.breakdown.editCost, 3);
        assert.strictEqual(first.breakdown.fileTouchCost, 1);
        assert.strictEqual(first.breakdown.riskCost, 1);
        assert.strictEqual(first.breakdown.dependencyCost, 2);
        assert.strictEqual(first.breakdown.violationReduction, 2);
        assert.strictEqual(first.totalCost, 7);
      },
    },
    {
      id: "4.15",
      name: "cost selection uses deterministic plan-id tie-breaker",
      run: async () => {
        const state = createEmptyStatePlane();

        const planA = makePlan("plan-a", [makeTask("t-analysis", "analysis")]);
        const planB = makePlan("plan-b", [makeTask("t-analysis", "analysis")]);

        const selected = selectBestPlan([planB, planA], state);
        assert.strictEqual(selected.id, "plan-a");

        const scores = scorePlans([planB, planA], state);
        assert.deepStrictEqual(scores.map((score) => score.planId), ["plan-a", "plan-b"]);
      },
    },
    {
      id: "4.16",
      name: "cost-based plan set selection returns lowest-cost plan",
      run: async () => {
        const state = createEmptyStatePlane();
        state.violations = [
          {
            id: "diag-1",
            ruleId: "rule-a",
            message: "A",
            severity: "error",
            category: "AST",
            location: testLocation("src/a.ts", 1, 0, 1, 1),
            traceId: "trace-1",
          },
        ];

        const lowCost = makePlan("plan-low", [
          makeTask("t-analysis", "analysis"),
          makeTask("t-validate", "enforce", { dependsOn: ["t-analysis"] }),
        ]);

        const highCost = makePlan("plan-high", [
          makeTask("t-analysis", "analysis"),
          makeTask("t-refactor-1", "refactor", { dependsOn: ["t-analysis"], files: ["src/a.ts"] }),
          makeTask("t-refactor-2", "refactor", { dependsOn: ["t-refactor-1"], files: ["src/b.ts"] }),
          makeTask("t-validate", "enforce", { dependsOn: ["t-refactor-2"] }),
        ]);

        const selectedSet = selectPlanSet([highCost, lowCost], state);
        assert.strictEqual(selectedSet.length, 1);
        assert.strictEqual(selectedSet[0]?.id, "plan-low");

        const evaluated = scorePlans([highCost, lowCost], state);
        const trace = buildCostTrace(selectedSet[0]?.id as string, evaluated);
        assert.strictEqual(trace.selectedPlanId, "plan-low");
        assert.ok(trace.decision.includes("plan-low selected due to lowest total cost"));
      },
    },
    {
      id: "4.17",
      name: "strategy registry is deterministic and capped",
      run: async () => {
        assert.strictEqual(MAX_STRATEGIES, 4);
        assert.deepStrictEqual(
          STRATEGIES.map((strategy) => strategy.id),
          ["s-aggressive", "s-grouped", "s-layered", "s-minimal"]
        );
      },
    },
    {
      id: "4.18",
      name: "strategy transforms are deterministic across grouped layered and aggressive modes",
      run: async () => {
        const state = createEmptyStatePlane();
        state.dependencyGraph = {
          "src/a.ts": ["src/core.ts"],
          "src/b.ts": ["src/core.ts"],
          "src/c.ts": ["src/b.ts"],
          "src/core.ts": [],
        };

        const basePlan = makePlan("plan-strategy", [
          makeTask("t-analysis", "analysis"),
          makeTask("t-refactor-a", "refactor", { dependsOn: ["t-analysis"], files: ["src/a.ts"] }),
          makeTask("t-refactor-b", "refactor", { dependsOn: ["t-analysis"], files: ["src/a.ts", "src/b.ts"] }),
          makeTask("t-refactor-c", "refactor", { dependsOn: ["t-analysis"], files: ["src/c.ts"] }),
          makeTask("t-enforce", "enforce", { dependsOn: ["t-refactor-a", "t-refactor-b", "t-refactor-c"] }),
        ]);

        const groupedFirst = groupedStrategy(basePlan, state);
        const groupedSecond = groupedStrategy(basePlan, state);
        assert.deepStrictEqual(groupedFirst, groupedSecond);
        assert.ok(groupedFirst.tasks.filter((task) => task.type === "refactor").length < 3);

        const layeredFirst = layeredStrategy(basePlan, state);
        const layeredSecond = layeredStrategy(basePlan, state);
        assert.deepStrictEqual(layeredFirst, layeredSecond);
        assert.ok(layeredFirst.tasks.some((task) => task.id.startsWith("t-refactor-l")));

        const aggressive = aggressiveStrategy(basePlan, state);
        const aggressiveRefactors = aggressive.tasks.filter((task) => task.type === "refactor");
        assert.strictEqual(aggressiveRefactors.length, 1);
        assert.strictEqual(aggressiveRefactors[0]?.id, "t-refactor-aggressive");
      },
    },
    {
      id: "4.19",
      name: "strategy evaluation and selection are deterministic with lexicographic tie break",
      run: async () => {
        const state = createEmptyStatePlane();
        state.violations = [
          {
            id: "diag-1",
            ruleId: "rule-a",
            message: "A",
            severity: "warning",
            category: "AST",
            location: testLocation("src/a.ts", 1, 0, 1, 1),
            traceId: "trace-1",
          },
        ];

        const basePlan = makePlan("plan-strategy", [
          makeTask("t-analysis", "analysis"),
          makeTask("t-refactor-a", "refactor", { dependsOn: ["t-analysis"], files: ["src/a.ts"] }),
          makeTask("t-refactor-b", "refactor", { dependsOn: ["t-analysis"], files: ["src/b.ts"] }),
          makeTask("t-enforce", "enforce", { dependsOn: ["t-refactor-a", "t-refactor-b"] }),
        ]);

        const planSnapshot = JSON.stringify(basePlan);
        const stateSnapshot = JSON.stringify(state);

        const results = await evaluateStrategies(basePlan, state, {
          controlPlane: makeControlPlane(),
          maxStrategies: MAX_STRATEGIES,
        });

        assert.strictEqual(results.length, 4);
        assert.strictEqual(JSON.stringify(basePlan), planSnapshot);
        assert.strictEqual(JSON.stringify(state), stateSnapshot);

        const selected = selectBestStrategy(results);
        const trace = buildStrategyTrace(results, selected);
        assert.strictEqual(trace.selectedStrategyId, selected.strategyId);

        const tieSeed = results[0] as StrategyResult;
        const tied: StrategyResult[] = [
          {
            ...tieSeed,
            strategyId: "s-zeta",
            success: true,
            cost: { ...tieSeed.cost, totalCost: 5 },
          },
          {
            ...tieSeed,
            strategyId: "s-alpha",
            success: true,
            cost: { ...tieSeed.cost, totalCost: 5 },
          },
        ];

        const tieWinner = selectBestStrategy(tied);
        assert.strictEqual(tieWinner.strategyId, "s-alpha");
      },
    },
    {
      id: "4.20",
      name: "preview patch grouping and hash are deterministic",
      run: async () => {
        const patches: Patch[] = [
          {
            type: "replace",
            location: testLocation("src/a.ts", 1, 0, 1, 3),
            text: "next",
          },
          {
            type: "create-file",
            file: "src/b.ts",
            content: "export const value = 1;\n",
          },
        ];

        const grouped = groupPatchesByFile(patches);
        assert.deepStrictEqual([...grouped.keys()], ["src/a.ts", "src/b.ts"]);

        const before = "const value = 1;\n";
        const after = "const value = 2;\n";
        const firstDiff = generateDiff("src/a.ts", before, after);
        const secondDiff = generateDiff("src/a.ts", before, after);
        assert.strictEqual(firstDiff, secondDiff);

        const preview: ExecutionPreview = {
          previewId: "",
          hash: "",
          planId: "plan-preview",
          summary: {
            totalFilesChanged: 2,
            totalPatches: patches.length,
            totalDiagnosticsResolved: 1,
          },
          fileChanges: [
            {
              file: "src/a.ts",
              patches: grouped.get("src/a.ts") ?? [],
              before,
              after,
              diff: firstDiff,
            },
            {
              file: "src/b.ts",
              patches: grouped.get("src/b.ts") ?? [],
              before: "",
              after: "export const value = 1;\n",
              diff: generateDiff("src/b.ts", "", "export const value = 1;\n"),
            },
          ],
          diagnostics: [],
          strategy: {
            strategyId: "s-layered",
            cost: 10,
          },
        };

        const hashA = hashPreview(preview);
        const hashB = hashPreview(preview);
        assert.strictEqual(hashA, hashB);
        assert.strictEqual(hashA.length, 64);
      },
    },
    {
      id: "4.11",
      name: "transactional execution commits validated batches",
      run: async () => {
        const plans: Plan[] = [
          makePlan("plan-a", [makeTask("t-refactor", "refactor", { files: ["src/example.ts"] })]),
        ];
        const { executionPlan } = buildExecutionPlan(plans, { smallTaskMergeThreshold: 0 });
        const txFs = createInMemoryTransactionFS({
          files: {
            "src/example.ts": "const value = 1;\n",
          },
          state: createEmptyStatePlane(),
        });

        const result = await runExecutionPlanTransactionally(executionPlan, {
          fs: txFs,
          controlPlane: makeControlPlane(),
          enforcer: {
            proposeFixes: async () => ({
              fixes: [
                {
                  id: "fix-1",
                  ruleId: "rule-a",
                  title: "Fix literal",
                  diagnosticIds: ["diag-1"],
                  patches: [
                    {
                      type: "create-file",
                      file: "src/example.ts",
                      content: "const value = 2;\n",
                    },
                  ],
                  traceId: "trace-1",
                },
              ],
              diagnostics: [
                {
                  id: "diag-1",
                  ruleId: "rule-a",
                  message: "literal needs update",
                  severity: "warning",
                  category: "AST",
                  location: testLocation("src/example.ts", 0, 0, 0, 1),
                  traceId: "trace-1",
                },
              ],
            }),
          },
          pipeline: {
            run: async () => ({
              diagnostics: [],
              conflicts: [],
            }),
          },
        });

        const snapshot = txFs.snapshot();
        assert.strictEqual(snapshot.files["src/example.ts"], "const value = 2;\n");
        assert.strictEqual(result.transactions[0]?.status, "committed");
        assert.strictEqual(result.traces[0]?.validationPassed, true);
      },
    },
    {
      id: "4.12",
      name: "transactional execution rolls back on validation failure without writes",
      run: async () => {
        const plans: Plan[] = [
          makePlan("plan-a", [makeTask("t-refactor", "refactor", { files: ["src/example.ts"] })]),
        ];
        const { executionPlan } = buildExecutionPlan(plans, { smallTaskMergeThreshold: 0 });
        const txFs = createInMemoryTransactionFS({
          files: {
            "src/example.ts": "const value = 1;\n",
          },
          state: createEmptyStatePlane(),
        });

        const result = await runExecutionPlanTransactionally(executionPlan, {
          fs: txFs,
          controlPlane: makeControlPlane(),
          enforcer: {
            proposeFixes: async () => ({
              fixes: [
                {
                  id: "fix-1",
                  ruleId: "rule-a",
                  title: "Fix literal",
                  diagnosticIds: ["diag-1"],
                  patches: [
                    {
                      type: "create-file",
                      file: "src/example.ts",
                      content: "const value = 2;\n",
                    },
                  ],
                  traceId: "trace-1",
                },
              ],
              diagnostics: [
                {
                  id: "diag-1",
                  ruleId: "rule-a",
                  message: "literal needs update",
                  severity: "warning",
                  category: "AST",
                  location: testLocation("src/example.ts", 0, 0, 0, 1),
                  traceId: "trace-1",
                },
              ],
            }),
          },
          pipeline: {
            run: async () => ({
              diagnostics: [
                {
                  id: "diag-1",
                  ruleId: "rule-a",
                  message: "new blocking error",
                  severity: "error",
                  category: "AST",
                  location: testLocation("src/example.ts", 0, 0, 0, 1),
                  traceId: "trace-1",
                },
              ],
              conflicts: [],
            }),
          },
        });

        const snapshot = txFs.snapshot();
        assert.strictEqual(snapshot.files["src/example.ts"], "const value = 1;\n");
        assert.strictEqual(result.transactions[0]?.status, "rolled-back");
        assert.strictEqual(result.traces[0]?.validationPassed, false);
        assert.strictEqual(txFs.journal.filter((entry) => entry.kind === "atomic-write").length, 0);
      },
    },
    {
      id: "4.13",
      name: "transactional execution rejects non-idempotent patch sets",
      run: async () => {
        const plans: Plan[] = [
          makePlan("plan-a", [makeTask("t-refactor", "refactor", { files: ["src/example.ts"] })]),
        ];
        const { executionPlan } = buildExecutionPlan(plans, { smallTaskMergeThreshold: 0 });
        const txFs = createInMemoryTransactionFS({
          files: {
            "src/example.ts": "const value = 1;\n",
          },
          state: createEmptyStatePlane(),
        });

        const result = await runExecutionPlanTransactionally(executionPlan, {
          fs: txFs,
          controlPlane: makeControlPlane(),
          enforcer: {
            proposeFixes: async () => ({
              fixes: [
                {
                  id: "fix-1",
                  ruleId: "rule-a",
                  title: "Insert header",
                  diagnosticIds: ["diag-1"],
                  patches: [
                    {
                      type: "insert",
                      location: testLocation("src/example.ts", 0, 0, 0, 0),
                      text: "// header\n",
                      position: "before",
                    },
                  ],
                  traceId: "trace-1",
                },
              ],
              diagnostics: [
                {
                  id: "diag-1",
                  ruleId: "rule-a",
                  message: "header is missing",
                  severity: "warning",
                  category: "AST",
                  location: testLocation("src/example.ts", 0, 0, 0, 1),
                  traceId: "trace-1",
                },
              ],
            }),
          },
          pipeline: {
            run: async () => ({
              diagnostics: [],
              conflicts: [],
            }),
          },
        });

        const tx = result.transactions[0];
        const idempotency = tx?.validation.invariantChecks.find((check) => check.name === "idempotent");

        assert.strictEqual(tx?.status, "rolled-back");
        assert.ok(idempotency);
        assert.strictEqual(idempotency?.passed, false);
        assert.strictEqual(txFs.snapshot().files["src/example.ts"], "const value = 1;\n");
      },
    },
  ],
};

const finalPass: TestPass = {
  name: "Final — Cross-Cutting Tests",
  tests: [
    {
      id: "X.1",
      name: "higher priority rules override lower ones",
      run: async () => {
        await withFixture("multi-module", async ({ harness }) => {
          const result = await harness.runPipeline();
          assert.ok(result.trace.decisions.includes("AST override applied"));
        });
      },
    },
    {
      id: "X.2",
      name: "trace is fully populated",
      run: async () => {
        await withFixture("multi-module", async ({ harness }) => {
          const trace = (await harness.runPipeline()).trace;
          assert.ok(trace.rulesEvaluated.length > 0);
          assert.ok(trace.decisions.length > 0);
        });
      },
    },
    {
      id: "X.3",
      name: "control plane requires version",
      run: async () => {
        await withFixture("simple-project", async ({ harness }) => {
          const control = harness.loadControlPlane();
          assert.ok(typeof control.version === "string" && control.version.length > 0);
        });
      },
    },
    {
      id: "X.4",
      name: "conflict resolution is deterministic and priority driven",
      run: async () => {
        const sharedLocation = testLocation("src/example.ts", 1, 0, 1, 10);

        const diagnostics: Diagnostic[] = [
          {
            id: "diag-A",
            ruleId: "rule-a",
            message: "A",
            severity: "error",
            category: "AST",
            location: sharedLocation,
            traceId: "trace-A",
          },
          {
            id: "diag-B",
            ruleId: "rule-b",
            message: "B",
            severity: "warning",
            category: "strategy",
            location: sharedLocation,
            traceId: "trace-B",
          },
        ];

        const fixes: Fix[] = [
          {
            id: "fix-A",
            ruleId: "rule-a",
            title: "Fix A",
            diagnosticIds: ["diag-A"],
            patches: [
              {
                type: "replace",
                location: sharedLocation,
                text: "alpha",
              },
            ],
            isSafe: true,
            traceId: "trace-A",
          },
          {
            id: "fix-B",
            ruleId: "rule-b",
            title: "Fix B",
            diagnosticIds: ["diag-B"],
            patches: [
              {
                type: "replace",
                location: sharedLocation,
                text: "beta",
              },
            ],
            isSafe: true,
            traceId: "trace-B",
          },
        ];

        const first = runConflictResolutionEngine({
          fixes,
          diagnostics,
          controlPlane: makeControlPlane(),
        });

        const second = runConflictResolutionEngine({
          fixes,
          diagnostics,
          controlPlane: makeControlPlane(),
        });

        assert.deepStrictEqual(first, second);
        assert.deepStrictEqual(first.selectedFixes.map((fix) => fix.id), ["fix-A"]);
        assert.deepStrictEqual(first.rejectedFixes, [{ fixId: "fix-B", reason: "lower-priority" }]);
        assert.ok(first.conflicts.some((conflict) => conflict.reason === "overlapping-range"));
      },
    },
    {
      id: "X.5",
      name: "priority overrides and dependency safety rejections are honored",
      run: async () => {
        const sharedLocation = testLocation("src/example.ts", 2, 0, 2, 6);
        const diagnostics: Diagnostic[] = [
          {
            id: "diag-A",
            ruleId: "rule-a",
            message: "A",
            severity: "error",
            category: "AST",
            location: sharedLocation,
            traceId: "trace-A",
          },
          {
            id: "diag-B",
            ruleId: "rule-b",
            message: "B",
            severity: "warning",
            category: "strategy",
            location: sharedLocation,
            traceId: "trace-B",
          },
          {
            id: "diag-U",
            ruleId: "rule-u",
            message: "U",
            severity: "error",
            category: "AST",
            location: sharedLocation,
            traceId: "trace-U",
          },
          {
            id: "diag-D",
            ruleId: "rule-d",
            message: "D",
            severity: "error",
            category: "AST",
            location: sharedLocation,
            traceId: "trace-D",
          },
        ];

        const fixes: Fix[] = [
          {
            id: "fix-A",
            ruleId: "rule-a",
            title: "Fix A",
            diagnosticIds: ["diag-A"],
            patches: [
              {
                type: "replace",
                location: sharedLocation,
                text: "alpha",
              },
            ],
            isSafe: true,
            traceId: "trace-A",
          },
          {
            id: "fix-B",
            ruleId: "rule-b",
            title: "Fix B",
            diagnosticIds: ["diag-B"],
            patches: [
              {
                type: "replace",
                location: sharedLocation,
                text: "beta",
              },
            ],
            isSafe: true,
            traceId: "trace-B",
          },
          {
            id: "fix-U",
            ruleId: "rule-u",
            title: "Unsafe fix",
            diagnosticIds: ["diag-U"],
            patches: [],
            isSafe: false,
            traceId: "trace-U",
          },
          {
            id: "fix-D",
            ruleId: "rule-d",
            title: "Dependent fix",
            diagnosticIds: ["diag-D"],
            patches: [],
            dependsOn: ["fix-Missing"],
            traceId: "trace-D",
          },
        ];

        const result = runConflictResolutionEngine({
          fixes,
          diagnostics,
          controlPlane: makeControlPlane({
            AST: 1,
            strategy: 9,
          }),
        });

        assert.deepStrictEqual(result.selectedFixes.map((fix) => fix.id), ["fix-B"]);
        assert.deepStrictEqual(
          result.rejectedFixes,
          [
            { fixId: "fix-A", reason: "lower-priority" },
            { fixId: "fix-D", reason: "dependency-failure" },
            { fixId: "fix-U", reason: "unsafe" },
          ]
        );
      },
    },
  ],
};

async function runPass(testPass: TestPass): Promise<boolean> {
  process.stdout.write(`\n== ${testPass.name} ==\n`);

  for (const test of testPass.tests) {
    try {
      await test.run();
      process.stdout.write(`PASS ${test.id} ${test.name}\n`);
    } catch (error) {
      process.stderr.write(`FAIL ${test.id} ${test.name}\n`);
      process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
      return false;
    }
  }

  return true;
}

async function main(): Promise<void> {
  const passes: TestPass[] = [pass1, pass2, pass3, pass4, finalPass];

  for (const testPass of passes) {
    const ok = await runPass(testPass);
    if (!ok) {
      process.stderr.write("\nArchitecture harness failed. Refactor is incomplete.\n");
      process.exitCode = 1;
      return;
    }
  }

  process.stdout.write("\nPASS architecture harness (all passes)\n");
}

void main();
