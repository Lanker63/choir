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
  MAX_ADAPTIVE_ITERATIONS,
  MAX_STRATEGIES,
  STRATEGIES,
  StrategyOutcome,
  adaptiveStrategySelection,
  analyzeOutcome,
  buildStrategyTrace,
  evaluateStrategies,
  groupedStrategy,
  layeredStrategy,
  aggressiveStrategy,
  refineStrategies,
  selectBestOutcome,
} from "../../core/strategyPlanner.js";
import {
  ExecutionPreview,
  generateDiff,
  groupPatchesByFile,
  hashPreview,
} from "../../core/executionPreview.js";
import {
  StrategyMemoryEntry,
  buildSignature,
  canReuse,
  dedupeMemory,
  findMatchingStrategies,
  matchSignature,
  readStrategyMemory,
  recordStrategy,
  selectFromMemory,
  validatePlanStillApplies,
} from "../../core/strategyMemory.js";
import {
  CHOIR_DSL_GRAMMAR,
  ChoirAgent,
  compile,
  enforceCapabilities,
  parse,
  parseCommand,
  tokenize,
  validGrammar,
} from "../../core/choirRouter.js";
import {
  approveDiff,
  canonicalizeConfig,
  compileDSL,
  compileDSLAndWrite,
  controlPlaneToChoirConfig,
  hashConfig,
  policyStatus,
  rejectDiff,
  serializeYAML,
} from "../../core/dslYamlCompiler.js";
import {
  computeDiff,
  evaluatePolicies,
  hashDiff,
  toPolicySet,
} from "../../core/policyEngine.js";
import {
  formatDSL,
  generateDSL,
  validateRoundTrip,
} from "../../core/yamlDslGenerator.js";
import { Diagnostic, SourceLocation } from "../../core/types.js";
import { Fix, Patch } from "../../fix/types.js";
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
      approvalRules: [],
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
      name: "choir DSL tokenizer is deterministic",
      run: async () => {
        assert.deepStrictEqual(
          tokenize("choir define goal \"enforce service boundaries\""),
          [
            { type: "keyword", value: "choir" },
            { type: "keyword", value: "define" },
            { type: "keyword", value: "goal" },
            { type: "string", value: "enforce service boundaries" },
          ]
        );

        assert.ok(CHOIR_DSL_GRAMMAR.includes("<command> ::= \"choir\" <action>"));
      },
    },
    {
      id: "2.7",
      name: "choir DSL parser builds AST and supports then-pipeline",
      run: async () => {
        const tokens = tokenize("choir define goal \"enforce service boundaries\"");
        assert.deepStrictEqual(parse(tokens), {
          type: "define",
          defineType: "goal",
          value: "enforce service boundaries",
        });

        const sequence = parseCommand("choir plan for \"service boundaries\" then preview then execute");
        assert.deepStrictEqual(sequence.ast, {
          type: "sequence",
          actions: [
            { type: "plan", target: "service boundaries" },
            { type: "preview" },
            { type: "execute" },
          ],
        });
        assert.strictEqual(validGrammar(sequence.ast), true);
      },
    },
    {
      id: "2.8",
      name: "choir DSL rejects invalid syntax deterministically",
      run: async () => {
        assert.throws(() => parseCommand("plan"), /Expected keyword 'choir'/);
        assert.throws(() => parseCommand("choir define \"goal\" enforce"), /Expected one of/);
        assert.throws(() => parseCommand("choir plan for unquoted"), /Expected quoted string/);
        assert.throws(() => parseCommand("choir execute unknown-plan"), /Expected optional plan reference/);
      },
    },
    {
      id: "2.9",
      name: "choir DSL compiler routes AST actions deterministically",
      run: async () => {
        const calls: string[] = [];
        const handlers = {
          architect: {
            define: async (node: { defineType: string; value: string }) => {
              calls.push(`architect.define:${node.defineType}:${node.value}`);
            },
          },
          analyst: {
            analyze: async (node: { target: string }) => {
              calls.push(`analyst.analyze:${node.target}`);
            },
            status: async () => {
              calls.push("analyst.status");
            },
          },
          conductor: {
            plan: async (node: { target?: string }) => {
              calls.push(`conductor.plan:${node.target ?? ""}`);
            },
            preview: async (node: { planRef?: { identifier: string } }) => {
              calls.push(`conductor.preview:${node.planRef?.identifier ?? ""}`);
            },
            execute: async (node: { planRef?: { identifier: string } }) => {
              calls.push(`conductor.execute:${node.planRef?.identifier ?? ""}`);
            },
          },
        };

        const parsed = parseCommand("choir plan for \"service boundaries\" then preview then execute");
        const compiled = await compile(parsed.ast, handlers, {});
        assert.deepStrictEqual(compiled.compiledActions, [
          "conductor.plan",
          "conductor.preview",
          "conductor.execute",
        ]);

        const agent = new ChoirAgent(handlers);
        const traceA = await agent.handle("choir define goal \"secure service boundary\"", {});
        const traceB = await agent.handle("choir define goal \"secure service boundary\"", {});

        assert.deepStrictEqual(traceA, traceB);
        assert.strictEqual(traceA.rolesInvoked[0], "architect");
        assert.ok(traceA.dslTrace.compiledAction.includes("architect.define"));
        assert.ok(calls.includes("architect.define:goal:secure service boundary"));
      },
    },
    {
      id: "2.10",
      name: "capability enforcement prevents cross-role actions",
      run: async () => {
        enforceCapabilities("architect", "modify-yaml");
        enforceCapabilities("analyst", "read-state");
        enforceCapabilities("conductor", "plan");
        enforceCapabilities("conductor", "schedule");

        assert.throws(() => enforceCapabilities("architect", "schedule"), /Capability violation/);
        assert.throws(() => enforceCapabilities("analyst", "modify-yaml"), /Capability violation/);
        assert.throws(() => enforceCapabilities("conductor", "modify-yaml"), /Capability violation/);
      },
    },
    {
      id: "2.11",
      name: "dsl compiler mutates yaml intent deterministically",
      run: async () => {
        const control = makeControlPlane();
        const first = compileDSL("choir define goal \"enforce service boundaries\"", control);
        const second = compileDSL("choir define goal \"enforce service boundaries\"", first.updatedControlPlane);

        assert.strictEqual(first.changed, true);
        assert.strictEqual(second.changed, false);
        assert.ok(first.updatedControlPlane.intent.goals.includes("enforce service boundaries"));

        const firstHash = hashConfig(controlPlaneToChoirConfig(first.updatedControlPlane));
        const secondHash = hashConfig(controlPlaneToChoirConfig(second.updatedControlPlane));
        assert.strictEqual(firstHash, secondHash);
      },
    },
    {
      id: "2.12",
      name: "dsl compiler supports multi-command then pipeline",
      run: async () => {
        const control = makeControlPlane();
        const compiled = compileDSL(
          "choir define goal \"A\" then define constraint \"B\" then define non-goal \"C\"",
          control
        );

        assert.strictEqual(compiled.changed, true);
        assert.deepStrictEqual(compiled.updatedControlPlane.intent.goals, ["A"]);
        assert.deepStrictEqual(compiled.updatedControlPlane.intent.constraints, ["B"]);
        assert.deepStrictEqual(compiled.updatedControlPlane.intent["non-goals"], ["C"]);
      },
    },
    {
      id: "2.13",
      name: "dsl compiler plan upsert is deterministic and duplicate-safe",
      run: async () => {
        const control = makeControlPlane();
        const first = compileDSL("choir plan", control);
        const second = compileDSL("choir plan", first.updatedControlPlane);

        assert.strictEqual(first.updatedControlPlane.execution.plans.length >= 1, true);
        assert.strictEqual(second.updatedControlPlane.execution.plans.length, first.updatedControlPlane.execution.plans.length);
      },
    },
    {
      id: "2.14",
      name: "dsl compiler keeps execute as non-mutating in yaml mode",
      run: async () => {
        const control = makeControlPlane();
        const compiled = compileDSL("choir execute", control);
        assert.strictEqual(compiled.changed, false);
        assert.deepStrictEqual(compiled.updatedControlPlane, control);
      },
    },
    {
      id: "2.15",
      name: "dsl compiler rejects malformed and empty-value commands",
      run: async () => {
        const control = makeControlPlane();
        assert.throws(() => compileDSL("choir define goal enforce boundaries", control), /Expected quoted string/);
        assert.throws(() => compileDSL("choir define constraint \"\"", control), /Invalid Choir DSL command/);
      },
    },
    {
      id: "2.16",
      name: "yaml serialization is canonical and reproducible",
      run: async () => {
        const control = makeControlPlane();
        const compiled = compileDSL(
          "choir define constraint \"z\" then define constraint \"a\" then define goal \"b\" then define goal \"a\"",
          control
        );

        const cfg = canonicalizeConfig(controlPlaneToChoirConfig(compiled.updatedControlPlane));
        const first = serializeYAML(cfg);
        const second = serializeYAML(cfg);

        assert.strictEqual(first, second);
        assert.ok(first.includes("constraints:"));
        assert.ok(first.includes("- a"));
        assert.ok(first.includes("- z"));
      },
    },
    {
      id: "2.17",
      name: "dsl parser supports export dsl command",
      run: async () => {
        const parsed = parseCommand("choir export dsl intent");
        assert.deepStrictEqual(parsed.ast, {
          type: "export",
          format: "dsl",
          section: "intent",
        });

        const compiled = compileDSL("choir export dsl", makeControlPlane());
        assert.strictEqual(compiled.changed, false);
      },
    },
    {
      id: "2.18",
      name: "yaml to dsl projection is deterministic and diff-friendly",
      run: async () => {
        const control = makeControlPlane();
        control.intent.goals = ["B", "A"];
        control.intent.constraints = ["z", "a"];
        control.intent["non-goals"] = ["n2", "n1"];

        const generated = generateDSL(controlPlaneToChoirConfig(control));
        const text = formatDSL(generated.script);

        assert.strictEqual(text, [
          'choir define goal "A"',
          'choir define goal "B"',
          'choir define constraint "a"',
          'choir define constraint "z"',
          'choir define non-goal "n1"',
          'choir define non-goal "n2"',
        ].join("\n"));
      },
    },
    {
      id: "2.19",
      name: "yaml to dsl round-trip is stable",
      run: async () => {
        const control = makeControlPlane();
        control.intent.goals = ["enforce boundaries"];
        control.intent.constraints = ["no direct db access"];
        control.intent["non-goals"] = ["distributed app"];

        const roundTrip = validateRoundTrip(controlPlaneToChoirConfig(control));
        assert.strictEqual(roundTrip.stable, true);
      },
    },
    {
      id: "2.20",
      name: "yaml to dsl partial projection supports intent section",
      run: async () => {
        const control = makeControlPlane();
        control.intent.goals = ["A"];
        control.policy.rules = [
          {
            id: "rule.one",
            match: { imports: ["x"] },
            constraint: { type: "forbid" },
            message: "x",
          },
        ];

        const generated = generateDSL(controlPlaneToChoirConfig(control), { section: "intent" });
        const text = formatDSL(generated.script);
        assert.strictEqual(text, 'choir define goal "A"');
        assert.strictEqual(generated.trace.sections.includes("intent"), true);
        assert.strictEqual(generated.trace.sections.includes("policy"), false);
      },
    },
    {
      id: "2.21",
      name: "yaml to dsl warns for unrepresentable policy and plans",
      run: async () => {
        const control = makeControlPlane();
        control.policy.rules = [
          {
            id: "rule.alpha",
            match: { imports: ["alpha"] },
            constraint: { type: "forbid" },
            message: "alpha",
          },
        ];
        control.execution.plans = [
          makePlan("plan-alpha", [makeTask("t1", "analysis")]),
        ];

        const generated = generateDSL(controlPlaneToChoirConfig(control));
        assert.ok(generated.trace.warnings.some((warning) => warning.includes("policy.rules.rule.alpha")));
        assert.ok(generated.trace.warnings.some((warning) => warning.includes("execution.plans.plan-alpha")));
      },
    },
    {
      id: "2.22",
      name: "policy engine computes deterministic yaml diffs and hash",
      run: async () => {
        const before = controlPlaneToChoirConfig(makeControlPlane());
        const afterControl = makeControlPlane();
        afterControl.intent.constraints = ["db access control"];
        const after = controlPlaneToChoirConfig(afterControl);

        const diffA = computeDiff(before, after);
        const diffB = computeDiff(before, after);

        assert.deepStrictEqual(diffA, diffB);
        assert.strictEqual(hashDiff(diffA), hashDiff(diffB));
        assert.ok(diffA.some((entry) => entry.path.includes("intent.constraints")));
      },
    },
    {
      id: "2.23",
      name: "policy deny rule blocks yaml mutation before write",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-policy-deny-"));
        const controlPath = path.join(root, ".choir", "choir.config.yaml");

        const control = makeControlPlane();
        control.policy.approvalRules = [
          {
            id: "deny-db-constraint",
            match: {
              path: "intent.constraints",
              operation: "add",
            },
            condition: {
              contains: "db",
            },
            effect: {
              type: "deny",
              message: "db constraints are denied",
            },
          },
        ];

        const result = compileDSLAndWrite(
          'choir define constraint "db connection"',
          control,
          controlPath,
          { workspaceRoot: root }
        );

        assert.strictEqual(result.decision, "deny");
        assert.strictEqual(fs.existsSync(controlPath), false);
      },
    },
    {
      id: "2.24",
      name: "policy require-approval blocks until approved for exact diff hash",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-policy-approval-"));
        const controlPath = path.join(root, ".choir", "choir.config.yaml");

        const control = makeControlPlane();
        control.policy.approvalRules = [
          {
            id: "approve-db-constraint",
            match: {
              path: "intent.constraints",
              operation: "add",
            },
            condition: {
              contains: "db",
            },
            effect: {
              type: "require-approval",
              message: "db constraints require approval",
            },
          },
        ];

        const command = 'choir define constraint "db connection"';
        const first = compileDSLAndWrite(command, control, controlPath, { workspaceRoot: root });
        assert.strictEqual(first.decision, "require-approval");
        assert.strictEqual(fs.existsSync(controlPath), false);
        assert.ok(first.pendingApprovalId);

        const statusBefore = policyStatus(root);
        assert.ok(statusBefore.pending.some((entry) => entry.id === first.pendingApprovalId));

        const approved = approveDiff(root, first.pendingApprovalId!, "test-user");
        assert.strictEqual(approved.approved, true);

        const second = compileDSLAndWrite(command, control, controlPath, { workspaceRoot: root });
        assert.strictEqual(second.decision, "allow");
        assert.strictEqual(fs.existsSync(controlPath), true);

        const statusAfter = policyStatus(root);
        assert.strictEqual(statusAfter.pending.length, 0);

        const rejected = rejectDiff(root, first.pendingApprovalId!);
        assert.strictEqual(rejected.removed, false);
      },
    },
    {
      id: "2.25",
      name: "policy evaluation trace is deterministic",
      run: async () => {
        const beforeControl = makeControlPlane();
        const afterControl = makeControlPlane();
        afterControl.intent.constraints = ["db access", "audit"];

        const diffs = computeDiff(
          controlPlaneToChoirConfig(beforeControl),
          controlPlaneToChoirConfig(afterControl)
        );

        const policySet = toPolicySet([
          {
            id: "rule-approval",
            match: {
              path: "intent.constraints",
              operation: "add",
            },
            condition: {
              contains: "db",
            },
            effect: {
              type: "require-approval",
            },
          },
        ]);

        const evalA = evaluatePolicies(diffs, policySet);
        const evalB = evaluatePolicies(diffs, policySet);

        assert.deepStrictEqual(evalA, evalB);
        assert.strictEqual(evalA.result.requiresApproval, true);
        assert.strictEqual(evalA.trace.decision, "require-approval");
      },
    },
    {
      id: "2.26",
      name: "dsl parser supports policy approval command surface",
      run: async () => {
        assert.deepStrictEqual(parseCommand("choir approve diff-abc123").ast, {
          type: "approve",
          diffId: "diff-abc123",
        });
        assert.deepStrictEqual(parseCommand("choir reject diff-abc123").ast, {
          type: "reject",
          diffId: "diff-abc123",
        });
        assert.deepStrictEqual(parseCommand("choir policy status").ast, {
          type: "policy-status",
        });
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
          root: repoRoot,
          maxStrategies: MAX_STRATEGIES,
        });

        assert.strictEqual(results.length, 4);
        assert.strictEqual(JSON.stringify(basePlan), planSnapshot);
        assert.strictEqual(JSON.stringify(state), stateSnapshot);

        const selected = selectBestOutcome(results);
        const trace = buildStrategyTrace(results, selected);
        assert.strictEqual(trace.selectedStrategyId, selected.strategyId);

        const tieSeed = results[0] as StrategyOutcome;
        const tied: StrategyOutcome[] = [
          {
            ...tieSeed,
            strategyId: "s-zeta",
            success: true,
            metrics: {
              ...tieSeed.metrics,
              remainingViolations: 1,
              introducedErrors: 0,
              patchesCount: 2,
              filesChanged: 1,
            },
          },
          {
            ...tieSeed,
            strategyId: "s-alpha",
            success: true,
            metrics: {
              ...tieSeed.metrics,
              remainingViolations: 1,
              introducedErrors: 0,
              patchesCount: 2,
              filesChanged: 1,
            },
          },
        ];

        const tieWinner = selectBestOutcome(tied);
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
      id: "4.21",
      name: "adaptive refinement deterministically generates bounded strategies from failure patterns",
      run: async () => {
        const state = createEmptyStatePlane();

        const basePlan = makePlan("plan-adaptive-refine", [
          makeTask("t-analysis", "analysis"),
          makeTask("t-refactor-a", "refactor", { dependsOn: ["t-analysis"], files: ["src/a.ts", "src/b.ts"] }),
          makeTask("t-refactor-b", "refactor", { dependsOn: ["t-analysis"], files: ["src/c.ts", "src/d.ts"] }),
          makeTask("t-enforce", "enforce", { dependsOn: ["t-refactor-a", "t-refactor-b"] }),
        ]);

        const aggressiveFailure: StrategyOutcome = {
          strategyId: "s-aggressive",
          strategyType: "aggressive",
          plan: basePlan,
          patches: [],
          diagnostics: [],
          validation: {
            passed: false,
            diagnostics: [],
            conflicts: [],
            invariantChecks: [],
            errors: ["too broad"],
          },
          metrics: {
            filesChanged: 12,
            patchesCount: 40,
            remainingViolations: 2,
            introducedErrors: 1,
          },
          success: false,
          fileChanges: [],
          previewHash: "",
        };

        const groupedFailure: StrategyOutcome = {
          strategyId: "s-grouped",
          strategyType: "grouped",
          plan: basePlan,
          patches: [],
          diagnostics: [],
          validation: {
            passed: false,
            diagnostics: [],
            conflicts: [],
            invariantChecks: [],
            errors: ["validation failed"],
          },
          metrics: {
            filesChanged: 3,
            patchesCount: 6,
            remainingViolations: 1,
            introducedErrors: 0,
          },
          success: false,
          fileChanges: [],
          previewHash: "",
        };

        const patterns = analyzeOutcome(aggressiveFailure);
        assert.ok(patterns.some((pattern) => pattern.type === "too-many-patches"));
        assert.ok(patterns.some((pattern) => pattern.type === "too-many-files"));
        assert.ok(patterns.some((pattern) => pattern.type === "validation-failure"));

        const first = refineStrategies([aggressiveFailure, groupedFailure], state, {
          existingStrategies: STRATEGIES,
        });
        const second = refineStrategies([aggressiveFailure, groupedFailure], state, {
          existingStrategies: STRATEGIES,
        });

        const firstIds = first.strategies.map((strategy) => strategy.id);
        const secondIds = second.strategies.map((strategy) => strategy.id);

        assert.ok(firstIds.length > 0);
        assert.deepStrictEqual(firstIds, secondIds);
        assert.strictEqual(new Set(firstIds).size, firstIds.length);
        assert.ok(first.mutationsApplied <= 6);
      },
    },
    {
      id: "4.22",
      name: "adaptive strategy selection is deterministic and bounded by iteration limits",
      run: async () => {
        const state = createEmptyStatePlane();
        state.violations = [
          {
            id: "diag-adaptive-1",
            ruleId: "rule-adaptive",
            message: "adaptive violation",
            severity: "warning",
            category: "AST",
            location: testLocation("src/adaptive.ts", 1, 0, 1, 1),
            traceId: "trace-adaptive-1",
          },
        ];

        const basePlan = makePlan("plan-adaptive-loop", [
          makeTask("t-analysis", "analysis"),
          makeTask("t-refactor-a", "refactor", { dependsOn: ["t-analysis"], files: ["src/adaptive-a.ts"] }),
          makeTask("t-refactor-b", "refactor", { dependsOn: ["t-analysis"], files: ["src/adaptive-b.ts"] }),
          makeTask("t-enforce", "enforce", { dependsOn: ["t-refactor-a", "t-refactor-b"] }),
        ]);

        const first = await adaptiveStrategySelection(basePlan, state, {
          controlPlane: makeControlPlane(),
          root: repoRoot,
        });
        const second = await adaptiveStrategySelection(basePlan, state, {
          controlPlane: makeControlPlane(),
          root: repoRoot,
        });

        assert.ok(first.outcomes.length >= MAX_STRATEGIES);
        assert.ok(first.adaptiveTrace.iterations >= 1);
        assert.ok(first.adaptiveTrace.iterations <= MAX_ADAPTIVE_ITERATIONS);
        assert.ok(first.adaptiveTrace.strategiesEvaluated >= first.outcomes.length);
        assert.ok(first.history.length > 0);

        assert.strictEqual(first.selected.strategyId, second.selected.strategyId);
        assert.deepStrictEqual(
          first.outcomes.map((outcome) => outcome.strategyId),
          second.outcomes.map((outcome) => outcome.strategyId)
        );
      },
    },
    {
      id: "4.23",
      name: "strategy memory signature generation and matching are deterministic",
      run: async () => {
        const control = {
          ...makeControlPlane(),
          intent: {
            ...makeControlPlane().intent,
            goals: ["z-goal", "a-goal"],
            constraints: ["b-constraint", "a-constraint"],
          },
        };

        const state = createEmptyStatePlane();
        state.violations = [
          {
            id: "m-2",
            ruleId: "rule-b",
            message: "B",
            severity: "warning",
            category: "AST",
            location: testLocation("src/b.ts", 1, 0, 1, 1),
            traceId: "m-trace-2",
          },
          {
            id: "m-1",
            ruleId: "rule-a",
            message: "A",
            severity: "warning",
            category: "AST",
            location: testLocation("src/a.ts", 1, 0, 1, 1),
            traceId: "m-trace-1",
          },
          {
            id: "m-3",
            ruleId: "rule-b",
            message: "B2",
            severity: "warning",
            category: "AST",
            location: testLocation("src/b.ts", 2, 0, 2, 1),
            traceId: "m-trace-3",
          },
        ];
        state.dependencyGraph = {
          "src/a.ts": ["src/shared.ts"],
          "src/b.ts": ["src/shared.ts"],
          "src/shared.ts": [],
        };

        const first = buildSignature(control, state);
        const second = buildSignature(control, JSON.parse(JSON.stringify(state)));

        assert.deepStrictEqual(first, second);
        assert.ok(matchSignature(first, second));
        assert.deepStrictEqual(first.goals, ["a-goal", "z-goal"]);
        assert.deepStrictEqual(first.constraints, ["a-constraint", "b-constraint"]);
        assert.deepStrictEqual(first.violationSummary, [
          { ruleId: "rule-a", count: 1 },
          { ruleId: "rule-b", count: 2 },
        ]);
      },
    },
    {
      id: "4.24",
      name: "strategy memory record lookup reuse and dedupe are deterministic",
      run: async () => {
        await withFixture("simple-project", async ({ root }) => {
          const state = createEmptyStatePlane();
          const control = makeControlPlane();
          const signature = buildSignature(control, state);

          const selected: StrategyOutcome = {
            strategyId: "s-minimal",
            strategyType: "minimal",
            plan: makePlan("plan-memory", [
              makeTask("t-analysis", "analysis"),
              makeTask("t-enforce", "enforce", { dependsOn: ["t-analysis"] }),
            ]),
            patches: [],
            diagnostics: [],
            validation: {
              passed: true,
              diagnostics: [],
              conflicts: [],
              invariantChecks: [],
            },
            metrics: {
              filesChanged: 0,
              patchesCount: 1,
              remainingViolations: 0,
              introducedErrors: 0,
            },
            success: true,
            fileChanges: [],
            previewHash: "memory-preview-hash",
          };

          const entry = recordStrategy(root, signature, selected);
          const memory = readStrategyMemory(root);
          const matches = findMatchingStrategies(signature, memory);
          const reusable = matches.filter((candidate) => canReuse(candidate));
          const chosen = selectFromMemory(reusable);

          assert.ok(entry.id.length > 0);
          assert.ok(matches.length >= 1);
          assert.ok(chosen);
          assert.strictEqual(chosen?.strategyId, "s-minimal");
          assert.ok(validatePlanStillApplies(chosen!.plan, state, { root, expectedPlanId: "plan-memory" }));

          const duplicate: StrategyMemoryEntry = {
            ...entry,
          };
          const deduped = dedupeMemory([entry, duplicate]);
          assert.strictEqual(deduped.length, 1);
        });
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
