import assert from "assert";
import fs from "fs";
import path from "path";
import * as YAML from "yaml";
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
  assertDeterministicAdaptiveCycle,
  analyzeFailure,
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
  generateExecutionPreview,
  generateDiff,
  groupPatchesByFile,
  hashPreview,
} from "../../core/executionPreview.js";
import {
  synthesizeAndOptimizePlans,
} from "../../core/planOptimizationOrchestrator.js";
import {
  StrategyMemoryEntry,
  buildSignature,
  canReuse,
  dedupeMemory,
  findMatchingStrategies,
  matchSignature,
  readStrategyMemory,
  recordStrategies,
  recordStrategy,
  selectFromMemory,
  validatePlanStillApplies,
} from "../../core/strategyMemory.js";
import {
  AST,
  CHOIR_DSL_GRAMMAR,
  ChoirAgent,
  compile,
  enforceCapabilities,
  parse,
  parseCommand,
  routeAST,
  splitByThen,
  tokenize,
  validateAST,
  validGrammar,
} from "../../core/choirRouter.js";
import {
  Rule,
  applyFixes,
  buildDependencyGraph,
  buildRuleIndex,
  createIncrementalRuleState,
  detectConflicts,
  diffAST,
  getAffectedNodes,
  processAST,
  runIncrementalRules,
  runRules,
  semanticEquivalent,
  validateCrossNode,
  validateSemantics,
  validateStructure,
} from "../../core/astValidation.js";
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
  exportReport,
  generateReport,
  queryAudit,
  readAuditStore,
} from "../../core/audit.js";
import {
  computeDiff,
  detectEnvironment,
  evaluatePolicies,
  formatPolicyInheritanceTrace,
  hashDiff,
  toPolicySet,
  validateRole,
} from "../../core/policyEngine.js";
import {
  compilePolicies,
  loadAllPolicies,
  loadPolicies,
  parsePolicyDSL,
} from "../../core/policyDsl.js";
import {
  formatDSL,
  generateDSL,
  validateRoundTrip,
} from "../../core/yamlDslGenerator.js";
import {
  getDeterministicCompletions,
  validateChoirDocument,
} from "../../core/choirLanguageModel.js";
import {
  expandMacro,
  getMacro,
  runMacro,
} from "../../core/macros.js";
import {
  detectBreakingChanges,
  installLibrary,
  lockLibraries,
  readMacroLock,
  resolveLibraryVersion,
  updateLibrary,
} from "../../core/macroLibraries.js";
import {
  loadCIConfig,
  runCI,
} from "../../core/ci.js";
import {
  InitWizard,
  buildDSL,
  clearInitSession,
  createWizardState,
  loadInitSession,
  saveInitSession,
} from "../../core/initWizard.js";
import { normalizeChatDSLInput, parseExportChatCommand, parseGoalMutationChatCommand, parseInitChatCommand, parseVerifyChatCommand } from "../../core/chatCommands.js";
import { synthesizePreviewContract } from "../../core/previewOrchestrator.js";
import {
  getAbstraction,
  listAbstractions,
  runAbstraction,
} from "../../core/abstractions.js";
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
import {
  approvePendingDiff,
  buildGlobalTimeline,
  buildState,
  buildUnitTimeline,
  createEmptyStatePlane,
  hashState,
  listSnapshots,
  persistStatePlane,
  readStatePlane,
  replaySnapshots,
  rollbackState,
  validateConsistency,
  validateState,
} from "../../core/state.js";
import {
  MANUAL_RESOLUTION,
  applyDelta,
  batchChangeSets,
  compressChangeSets,
  computeDelta,
  createReplica,
  createSyncTrace,
  decompressChangeSets,
  incrementClock,
  InMemoryTransport,
  mergeClock,
  mergeReplicaStates,
  mergeStates,
  signChangeSet,
  sync,
  validateReplicaConvergence,
} from "../../core/distributedSync.js";
import {
  applyChange,
  beginTransaction,
  blockGlobalExecution,
  batchTasks as batchGlobalTasks,
  buildRollbackDependencyGraph,
  buildGlobalContext,
  buildGlobalDependencyGraph,
  buildStages,
  compareStrategies,
  compareStrategyMetricsLex,
  computeRollbackSet,
  computeStrategyScore,
  createGlobalPlanningCache,
  deterministicSort,
  detectPolicyDrift,
  executeDeterministic,
  executeTransaction,
  executeRolloutPlan,
  evaluateStrategies as evaluateGlobalStrategies,
  evaluateGlobalPolicies,
  executeGlobalPlan,
  commitPhase,
  hashInput,
  hashState as hashGlobalState,
  replay,
  orderRollback,
  orderPlan as orderGlobalPlan,
  OrgPolicy,
  propagatePolicies,
  Repo,
  respectDependencies,
  RolloutStrategy,
  selectBestStrategy,
  simulatePlan,
  preparePhase,
  simulateUnits,
  synthesizeGlobalPlan,
  validatePhase,
  validateTrace,
  assertIdempotent,
  validateIsolation,
  validatePostRollback,
  verifyReplay,
  validateGlobalPlan,
} from "../../core/globalOrchestration.js";
import {
  formatSimulationChatResult,
  simulationRiskLabel,
} from "../../core/simulationChat.js";
import {
  OrchestrationPipelineError,
  runOrchestrationPipeline,
} from "../../core/orchestrationRuntime.js";
import { detectWorkspace } from "../../core/workspaceDetection.js";
import {
  buildGraphSnapshot,
  toUIGraph,
} from "../../core/dependencyGraphUi.js";
import {
  rollbackRefactor,
  runRefactorIntent,
} from "../../core/refactorEngine.js";
import {
  formatChaosTestReport,
  runChaosTest,
  runPropertyTest,
  setSeed,
} from "../verification/core/propertyChaosHarness.js";
import {
  checkDeterminism,
  createVerificationSuite,
  deterministicCase,
  formatVerificationReport,
  runFullVerification,
  runVerificationCase,
} from "../verification/core/verificationHarness.js";
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

async function withTemporaryEnv(
  updates: Partial<Record<"CI" | "NODE_ENV" | "CHOIR_ENVIRONMENT", string | undefined>>,
  run: () => Promise<void> | void
): Promise<void> {
  const original: Partial<Record<"CI" | "NODE_ENV" | "CHOIR_ENVIRONMENT", string | undefined>> = {
    CI: process.env.CI,
    NODE_ENV: process.env.NODE_ENV,
    CHOIR_ENVIRONMENT: process.env.CHOIR_ENVIRONMENT,
  };

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete process.env[key as "CI" | "NODE_ENV" | "CHOIR_ENVIRONMENT"];
    } else {
      process.env[key as "CI" | "NODE_ENV" | "CHOIR_ENVIRONMENT"] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key as "CI" | "NODE_ENV" | "CHOIR_ENVIRONMENT"];
      } else {
        process.env[key as "CI" | "NODE_ENV" | "CHOIR_ENVIRONMENT"] = value;
      }
    }
  }
}

function writePoliciesDSL(root: string, content: string): void {
  const choirRoot = path.join(root, ".choir");
  fs.mkdirSync(choirRoot, { recursive: true });
  fs.writeFileSync(path.join(choirRoot, "policies.dsl"), content, "utf-8");
}

function writeOrgPoliciesDSL(root: string, content: string): void {
  const orgRoot = path.join(root, "org");
  fs.mkdirSync(orgRoot, { recursive: true });
  fs.writeFileSync(path.join(orgRoot, "policies.dsl"), content, "utf-8");
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
        assert.deepStrictEqual(splitByThen('choir define goal "A" then plan then execute'), [
          'choir define goal "A"',
          "plan",
          "execute",
        ]);

        const tokens = tokenize("choir define goal \"enforce service boundaries\"");
        assert.deepStrictEqual(parse(tokens), {
          type: "define",
          defineType: "goal",
          value: "enforce service boundaries",
        });

        const analyzeTokens = tokenize("choir analyze summary");
        assert.deepStrictEqual(parse(analyzeTokens), {
          type: "analyze",
          target: "summary",
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
        validateAST(sequence.ast);
      },
    },
    {
      id: "2.8",
      name: "choir DSL parser supports refactor commands",
      run: async () => {
        const rename = parseCommand("choir refactor rename runQuery executeQuery");
        assert.deepStrictEqual(rename.ast, {
          type: "refactor-rename",
          symbol: "runQuery",
          newName: "executeQuery",
        });

        const extract = parseCommand("choir refactor extract queryService packages.core");
        assert.deepStrictEqual(extract.ast, {
          type: "refactor-extract",
          symbol: "queryService",
          targetUnit: "packages.core",
        });

        const inline = parseCommand("choir refactor inline queryResult");
        assert.deepStrictEqual(inline.ast, {
          type: "refactor-inline",
          symbol: "queryResult",
        });

        const optimizePlan = parseCommand("choir plan --optimize");
        assert.deepStrictEqual(optimizePlan.ast, {
          type: "plan",
          optimize: true,
        });

        const adaptivePlan = parseCommand("choir plan --adaptive");
        assert.deepStrictEqual(adaptivePlan.ast, {
          type: "plan",
          adaptive: true,
        });

        const optimizePlanForTarget = parseCommand("choir plan --optimize for \"service boundaries\"");
        assert.deepStrictEqual(optimizePlanForTarget.ast, {
          type: "plan",
          target: "service boundaries",
          optimize: true,
        });

        const adaptivePlanForTarget = parseCommand("choir plan --adaptive for \"service boundaries\"");
        assert.deepStrictEqual(adaptivePlanForTarget.ast, {
          type: "plan",
          target: "service boundaries",
          adaptive: true,
        });

        const simulate = parseCommand("choir simulate");
        assert.deepStrictEqual(simulate.ast, {
          type: "simulate",
        });

        const simulatePlanRef = parseCommand("choir simulate plan plan-alpha");
        assert.deepStrictEqual(simulatePlanRef.ast, {
          type: "simulate",
          planRef: {
            type: "plan-ref",
            identifier: "plan-alpha",
          },
        });

        const simulateUnitsAst = parseCommand("choir simulate units packages.core,apps.web");
        assert.deepStrictEqual(simulateUnitsAst.ast, {
          type: "simulate",
          units: ["packages.core", "apps.web"],
        });

        const executeCanary = parseCommand("choir execute --strategy canary --steps 1,10,25,100");
        assert.deepStrictEqual(executeCanary.ast, {
          type: "execute",
          rolloutStrategy: {
            type: "canary",
            initialPercent: 1,
            steps: [10, 25, 100],
          },
        });

        const executeBatched = parseCommand("choir execute --strategy batched --batch-size 2");
        assert.deepStrictEqual(executeBatched.ast, {
          type: "execute",
          rolloutStrategy: {
            type: "batched",
            batchSize: 2,
          },
        });

        const rollbackAll = parseCommand("choir rollback");
        assert.deepStrictEqual(rollbackAll.ast, {
          type: "rollback",
        });

        const rollbackUnit = parseCommand("choir rollback packages.api");
        assert.deepStrictEqual(rollbackUnit.ast, {
          type: "rollback",
          unitId: "packages.api",
        });

        const rollbackStage = parseCommand("choir rollback --stage rollout-stage-1");
        assert.deepStrictEqual(rollbackStage.ast, {
          type: "rollback",
          stageId: "rollout-stage-1",
        });

        assert.strictEqual(routeAST(rename.ast), "conductor");
      },
    },
    {
      id: "2.81",
      name: "choir DSL rejects invalid syntax deterministically",
      run: async () => {
        assert.throws(() => parseCommand("plan"), /Expected keyword 'choir'/);
        assert.throws(() => parseCommand("choir define \"goal\" enforce"), /Expected one of/);
        assert.throws(() => parseCommand("choir define goal"), /Expected quoted string/);
        assert.throws(() => parseCommand("choir plan for unquoted"), /Expected quoted string/);
        assert.throws(() => parseCommand("choir plan --optimize --optimize"), /Duplicate plan optimize flag/);
        assert.throws(() => parseCommand("choir plan --adaptive --adaptive"), /Duplicate plan adaptive flag/);
        assert.throws(() => parseCommand("choir execute --steps 1,10"), /require --strategy/);
        assert.deepStrictEqual(parseCommand("choir execute unknown-plan").ast, {
          type: "execute",
          planRef: {
            type: "plan-ref",
            identifier: "unknown-plan",
          },
        });
        assert.throws(() => parseCommand("choir rollback --stage"), /Expected identifier/);
        assert.throws(() => parseCommand("choir refactor rename one"), /Expected identifier/);
        assert.throws(() => parseCommand("choir simulate units"), /Expected identifier/);
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
          },
          enforcer: {
            execute: async (node: { planRef?: { identifier: string } }) => {
              calls.push(`enforcer.execute:${node.planRef?.identifier ?? ""}`);
            },
          },
        };

        const parsed = parseCommand("choir plan for \"service boundaries\" then preview then execute");
        assert.strictEqual(routeAST(parsed.ast), "conductor -> enforcer");
        const compiled = await compile(parsed.ast, handlers, {});
        assert.deepStrictEqual(compiled.compiledActions, [
          "conductor.plan",
          "conductor.preview",
          "enforcer.execute",
        ]);

        const agent = new ChoirAgent(handlers);
        const traceA = await agent.handle("choir define goal \"secure service boundary\"", {});
        const traceB = await agent.handle("choir define goal \"secure service boundary\"", {});

        assert.deepStrictEqual(traceA, traceB);
        assert.strictEqual(traceA.rolesInvoked[0], "architect");
        assert.strictEqual(traceA.commandTrace.routedTo, "architect");
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
      id: "2.90",
      name: "ast structure validation rejects malformed nodes deterministically",
      run: async () => {
        const malformed = {
          type: "define",
          defineType: "goal",
        } as unknown as AST;

        const structure = validateStructure(malformed);
        assert.strictEqual(structure.valid, false);
        assert.ok(structure.issues.some((entry) => entry.code === "define-value-missing"));
      },
    },
    {
      id: "2.91",
      name: "ast semantic validation rejects duplicates and conflicts",
      run: async () => {
        const control = makeControlPlane();
        control.intent["non-goals"] = ["no direct db access"];
        control.intent.constraints = ["No new development"];

        const duplicateGoal = parseCommand('choir define goal "enforce boundaries" then define goal "enforce boundaries"').ast;
        const duplicateResult = validateSemantics(duplicateGoal, { controlPlane: control });
        assert.strictEqual(duplicateResult.valid, false);
        assert.ok(duplicateResult.issues.some((entry) => entry.code === "duplicate-goal"));

        const conflict = parseCommand('choir define constraint "no direct db access"').ast;
        const conflictResult = validateSemantics(conflict, { controlPlane: control });
        assert.strictEqual(conflictResult.valid, false);
        assert.ok(conflictResult.issues.some((entry) => entry.code === "constraint-conflicts-non-goal"));

        const opposingConstraint = parseCommand('choir define constraint "New development"').ast;
        const opposingConstraintResult = validateSemantics(opposingConstraint, { controlPlane: control });
        assert.strictEqual(opposingConstraintResult.valid, false);
        assert.ok(opposingConstraintResult.issues.some((entry) => entry.code === "constraint-conflicts-constraint"));

        const opposingWithinSequence = parseCommand('choir define constraint "No AI code generation" then define constraint "AI code generation"').ast;
        const opposingWithinSequenceResult = validateSemantics(opposingWithinSequence, { controlPlane: makeControlPlane() });
        assert.strictEqual(opposingWithinSequenceResult.valid, false);
        assert.ok(opposingWithinSequenceResult.issues.some((entry) => entry.code === "constraint-conflicts-constraint"));
      },
    },
    {
      id: "2.92",
      name: "cross-node validation enforces plan preconditions and warns on implicit execute synthesis",
      run: async () => {
        const control = makeControlPlane();

        const executeOnly = parseCommand("choir execute").ast;
        const executeResult = validateCrossNode(executeOnly, { controlPlane: control });
        assert.strictEqual(executeResult.valid, true);
        assert.ok(executeResult.issues.some((entry) => entry.code === "execute-without-plan" && entry.severity === "warning"));

        const planWithoutIntent = parseCommand("choir plan").ast;
        const planWithoutIntentResult = validateCrossNode(planWithoutIntent, { controlPlane: control });
        assert.strictEqual(planWithoutIntentResult.valid, false);
        assert.ok(planWithoutIntentResult.issues.some((entry) => entry.code === "plan-without-intent"));

        const validPipeline = parseCommand('choir define goal "A" then plan then execute').ast;
        const validResult = validateCrossNode(validPipeline, { controlPlane: control });
        assert.strictEqual(validResult.valid, true);
      },
    },
    {
      id: "2.93",
      name: "rule engine execution order is deterministic and sorted by id",
      run: async () => {
        const ast = parseCommand('choir define goal "A"').ast;
        const control = makeControlPlane();
        const rules: Rule[] = [
          {
            id: "z-rule",
            match: () => true,
            validate: () => ({
              ruleId: "z-rule",
              severity: "warning",
              message: "z",
            }),
          },
          {
            id: "a-rule",
            match: () => true,
            validate: () => ({
              ruleId: "a-rule",
              severity: "warning",
              message: "a",
            }),
          },
        ];

        const results = runRules(ast, rules, { controlPlane: control });
        assert.deepStrictEqual(results.map((entry) => entry.ruleId), ["a-rule", "z-rule"]);
      },
    },
    {
      id: "2.94",
      name: "rule conflict detection catches contradictory decisions and fixes",
      run: async () => {
        const conflicts = detectConflicts([
          {
            ruleId: "allow-rule",
            severity: "warning",
            message: "allow",
            decision: "allow",
          },
          {
            ruleId: "deny-rule",
            severity: "warning",
            message: "deny",
            decision: "deny",
          },
          {
            ruleId: "fix-a",
            severity: "warning",
            message: "fix-a",
            actionIndex: 0,
            fix: { type: "define", defineType: "goal", value: "A" },
          },
          {
            ruleId: "fix-b",
            severity: "warning",
            message: "fix-b",
            actionIndex: 0,
            fix: { type: "define", defineType: "goal", value: "B" },
          },
        ]);

        assert.ok(conflicts.some((entry) => entry.includes("allow and deny")));
        assert.ok(conflicts.some((entry) => entry.includes("Conflicting fixes")));
      },
    },
    {
      id: "2.95",
      name: "fix engine preserves immutability and semantic equivalence",
      run: async () => {
        const ast = parseCommand('choir define goal "A"').ast;
        const snapshot = JSON.parse(JSON.stringify(ast));

        const fixed = applyFixes(ast, [
          {
            ruleId: "normalize-goal",
            severity: "warning",
            message: "normalize",
            actionIndex: 0,
            fix: { type: "define", defineType: "goal", value: "A" },
          },
        ]);

        assert.deepStrictEqual(ast, snapshot);
        assert.strictEqual(semanticEquivalent(ast, fixed), true);
      },
    },
    {
      id: "2.96",
      name: "processAST validates before rules and emits deterministic trace",
      run: async () => {
        const control = makeControlPlane();
        control.intent.goals = ["enforce boundaries"];

        const ast = parseCommand('choir define mission "deterministic platform" then plan then execute').ast;
        const processed = processAST(ast, { controlPlane: control });
        assert.strictEqual(processed.trace.validationPassed, true);
        assert.deepStrictEqual(processed.trace.rulesTriggered, ["warn-execute-without-plan-ref"]);

        let rulesCalled = 0;
        const invalid = {
          type: "define",
          defineType: "goal",
        } as unknown as AST;

        const rules: Rule[] = [
          {
            id: "should-not-run",
            match: () => true,
            validate: () => {
              rulesCalled += 1;
              return {
                ruleId: "should-not-run",
                severity: "warning",
                message: "unexpected",
              };
            },
          },
        ];

        assert.throws(() => processAST(invalid, { controlPlane: control }, rules), /AST structure validation failed/);
        assert.strictEqual(rulesCalled, 0);
      },
    },
    {
      id: "2.97",
      name: "dependency graph and impact analysis are deterministic",
      run: async () => {
        const before = parseCommand('choir define goal "A" then plan then execute').ast;
        const after = parseCommand('choir define goal "B" then plan then execute').ast;

        const graph = buildDependencyGraph(after);
        assert.deepStrictEqual(Array.from(graph.nodes.keys()), ["action:0", "action:1", "action:2"]);
        assert.deepStrictEqual(graph.edges.get("action:0"), ["action:1"]);
        assert.deepStrictEqual(graph.edges.get("action:1"), ["action:2"]);
        assert.deepStrictEqual(graph.edges.get("action:2"), []);

        const diff = diffAST(before, after);
        assert.deepStrictEqual(diff.changedNodes, ["action:0"]);

        const affected = getAffectedNodes(diff, graph);
        assert.deepStrictEqual(affected, ["action:0", "action:1", "action:2"]);
      },
    },
    {
      id: "2.98",
      name: "rule indexing is stable and keyed by node type",
      run: async () => {
        const rules: Rule[] = [
          {
            id: "z-plan",
            nodeTypes: ["plan"],
            incrementalScope: "node",
            match: () => true,
            validate: () => null,
          },
          {
            id: "a-define",
            nodeTypes: ["define"],
            incrementalScope: "node",
            match: () => true,
            validate: () => null,
          },
          {
            id: "m-global",
            incrementalScope: "global",
            match: () => true,
            validate: () => null,
          },
        ];

        const index = buildRuleIndex(rules);
        assert.deepStrictEqual((index.get("define") ?? []).map((entry) => entry.id), ["a-define"]);
        assert.deepStrictEqual((index.get("plan") ?? []).map((entry) => entry.id), ["z-plan"]);
        assert.deepStrictEqual((index.get("*") ?? []).map((entry) => entry.id), ["m-global"]);
      },
    },
    {
      id: "2.99",
      name: "incremental engine executes only affected local rules",
      run: async () => {
        const state = createIncrementalRuleState();
        const calls = {
          define: 0,
          plan: 0,
          execute: 0,
        };

        const rules: Rule[] = [
          {
            id: "define-local",
            nodeTypes: ["define"],
            incrementalScope: "node",
            match: (node) => node.type === "define",
            validate: () => {
              calls.define += 1;
              return {
                ruleId: "define-local",
                severity: "warning",
                message: "define",
              };
            },
          },
          {
            id: "plan-local",
            nodeTypes: ["plan"],
            incrementalScope: "node",
            match: (node) => node.type === "plan",
            validate: () => {
              calls.plan += 1;
              return {
                ruleId: "plan-local",
                severity: "warning",
                message: "plan",
              };
            },
          },
          {
            id: "execute-local",
            nodeTypes: ["execute"],
            incrementalScope: "node",
            match: (node) => node.type === "execute",
            validate: () => {
              calls.execute += 1;
              return {
                ruleId: "execute-local",
                severity: "warning",
                message: "execute",
              };
            },
          },
        ];

        const control = makeControlPlane();
        const firstAst = parseCommand('choir define goal "A" then plan then execute').ast;
        const first = runIncrementalRules(firstAst, rules, { controlPlane: control }, { state });

        assert.strictEqual(first.metrics.rulesExecuted, 3);
        assert.deepStrictEqual(calls, { define: 1, plan: 1, execute: 1 });

        const secondAst = parseCommand('choir define goal "A" then plan then execute plan selected').ast;
        const second = runIncrementalRules(secondAst, rules, { controlPlane: control }, { state });

        assert.deepStrictEqual(second.trace.changedNodes, ["action:2"]);
        assert.deepStrictEqual(second.trace.affectedNodes, ["action:2"]);
        assert.strictEqual(second.metrics.rulesExecuted, 1);
        assert.deepStrictEqual(calls, { define: 1, plan: 1, execute: 2 });
        assert.deepStrictEqual(second.results, runRules(secondAst, rules, { controlPlane: control }));
      },
    },
    {
      id: "2.100",
      name: "incremental cache invalidates changed nodes and reuses unaffected entries",
      run: async () => {
        const state = createIncrementalRuleState();
        let evaluated = 0;

        const rules: Rule[] = [
          {
            id: "global-audit",
            incrementalScope: "global",
            match: () => true,
            validate: (_node, context) => {
              evaluated += 1;
              return {
                ruleId: "global-audit",
                severity: "warning",
                message: `index-${context.actionIndex}`,
              };
            },
          },
        ];

        const control = makeControlPlane();
        const firstAst = parseCommand('choir define goal "A" then plan then execute').ast;
        const first = runIncrementalRules(firstAst, rules, { controlPlane: control }, { state });

        assert.strictEqual(first.metrics.rulesExecuted, 3);
        assert.strictEqual(first.metrics.cacheHits, 0);

        const secondAst = parseCommand('choir define goal "A" then plan then execute plan selected').ast;
        const second = runIncrementalRules(secondAst, rules, { controlPlane: control }, { state });

        assert.deepStrictEqual(second.trace.changedNodes, ["action:2"]);
        assert.deepStrictEqual(second.trace.affectedNodes, ["action:0", "action:1", "action:2"]);
        assert.strictEqual(second.trace.cacheUsed, true);
        assert.ok(second.metrics.cacheHits >= 2);
        assert.strictEqual(second.metrics.rulesExecuted, 1);
        assert.strictEqual(evaluated, 4);
        assert.deepStrictEqual(second.results, runRules(secondAst, rules, { controlPlane: control }));
      },
    },
    {
      id: "2.101",
      name: "consistency check detects divergence and falls back to full evaluation",
      run: async () => {
        const state = createIncrementalRuleState();
        const control = makeControlPlane();

        const rules: Rule[] = [
          {
            id: "define-root-sensitive",
            nodeTypes: ["define"],
            incrementalScope: "node",
            match: (node) => node.type === "define",
            validate: (_node, context) => {
              return {
                ruleId: "define-root-sensitive",
                severity: "warning",
                message: `root-size-${JSON.stringify(context.rootAst).length}`,
              };
            },
          },
        ];

        const firstAst = parseCommand('choir define goal "A" then plan then execute').ast;
        runIncrementalRules(firstAst, rules, { controlPlane: control }, { state, consistencyCheck: "always" });

        const secondAst = parseCommand('choir define goal "A" then plan then execute plan selected').ast;
        const second = runIncrementalRules(secondAst, rules, { controlPlane: control }, { state, consistencyCheck: "always" });

        assert.strictEqual(second.trace.fallbackToFullEvaluation, true);
        assert.deepStrictEqual(second.results, runRules(secondAst, rules, { controlPlane: control }));
      },
    },
    {
      id: "2.11",
      name: "dsl compiler mutates yaml intent deterministically",
      run: async () => {
        const control = makeControlPlane();
        const first = compileDSL("choir define goal \"enforce service boundaries\"", control);
        const second = compileDSL("choir define goal \"enforce service boundaries\"", first.updatedControlPlane);
        assert.throws(
          () => compileDSL("choir define goal \"enforce service boundaries\" then define goal \"enforce service boundaries\"", control),
          /duplicate-goal/i
        );

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
        control.intent.goals = ["enforce boundaries"];
        const first = compileDSL("choir plan", control);
        const second = compileDSL("choir plan", first.updatedControlPlane);

        assert.strictEqual(first.updatedControlPlane.execution.plans.length >= 1, true);
        assert.strictEqual(second.updatedControlPlane.execution.plans.length, first.updatedControlPlane.execution.plans.length);
      },
    },
    {
      id: "2.14",
      name: "dsl compiler execute allows deterministic runtime synthesis without plan",
      run: async () => {
        const control = makeControlPlane();
        const withoutPlan = compileDSL("choir execute", control);
        assert.strictEqual(withoutPlan.changed, false);
        assert.deepStrictEqual(withoutPlan.updatedControlPlane, control);

        const withPlan = makeControlPlane();
        withPlan.execution.plans = [makePlan("plan-alpha", [makeTask("analyze", "analysis")])];
        const compiled = compileDSL("choir execute", withPlan);
        assert.strictEqual(compiled.changed, false);
        assert.deepStrictEqual(compiled.updatedControlPlane, withPlan);
      },
    },
    {
      id: "2.15",
      name: "dsl compiler rejects malformed and empty-value commands",
      run: async () => {
        const control = makeControlPlane();
        assert.throws(() => compileDSL("choir define goal enforce boundaries", control), /Expected quoted string/);
        assert.throws(() => compileDSL("choir define constraint \"\"", control), /Invalid Choir DSL command|AST semantic validation failed/);
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
        writePoliciesDSL(root, [
          "policy deny-db-constraint {",
          "  when diff.path = \"intent.constraints\" and diff.operation = add and contains \"db\" then deny",
          "}",
          "",
        ].join("\n"));

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
        writePoliciesDSL(root, [
          "policy approve-db-constraint {",
          "  when diff.path = \"intent.constraints\" and diff.operation = add and contains \"db\" then require-approval",
          "}",
          "",
        ].join("\n"));

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

        const context = {
          role: "architect" as const,
          environment: "local" as const,
        };

        const evalA = evaluatePolicies(diffs, policySet, context);
        const evalB = evaluatePolicies(diffs, policySet, context);

        assert.deepStrictEqual(evalA, evalB);
        assert.strictEqual(evalA.result.requiresApproval, true);
        assert.strictEqual(evalA.trace.decision, "require-approval");
        assert.strictEqual(evalA.trace.role, "architect");
        assert.strictEqual(evalA.trace.environment, "local");
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
        assert.deepStrictEqual(parseCommand("choir audit log").ast, {
          type: "audit-log",
        });
        assert.deepStrictEqual(parseCommand("choir audit report").ast, {
          type: "audit-report",
        });
        assert.deepStrictEqual(parseCommand("choir audit query role=architect, environment=ci").ast, {
          type: "audit-query",
          filters: {
            role: "architect",
            environment: "ci",
          },
        });
        assert.deepStrictEqual(parseCommand("choir import core@1.0.x").ast, {
          type: "import-library",
          library: "core",
          versionSelector: "1.0.x",
        });
        assert.deepStrictEqual(parseCommand("choir library list").ast, {
          type: "library-list",
        });
        assert.deepStrictEqual(parseCommand("choir library install core@1.x").ast, {
          type: "library-install",
          library: "core",
          versionSelector: "1.x",
        });
        assert.deepStrictEqual(parseCommand("choir library update core").ast, {
          type: "library-update",
          library: "core",
        });
        assert.deepStrictEqual(parseCommand("choir library lock").ast, {
          type: "library-lock",
        });
        assert.deepStrictEqual(parseCommand("choir ci run").ast, {
          type: "ci-run",
        });
      },
    },
    {
      id: "2.27",
      name: "choir editor completions are deterministic and grammar-aligned",
      run: async () => {
        const root = getDeterministicCompletions("").map((item) => item.label);
        assert.deepStrictEqual(root, ["choir"]);

        const actions = getDeterministicCompletions("choir ").map((item) => item.label);
        assert.deepStrictEqual(actions, [
          "define",
          "analyze",
          "plan",
          "refactor",
          "simulate",
          "preview",
          "execute",
          "rollback",
          "status",
          "export",
          "approve",
          "reject",
          "policy",
          "import",
          "library",
          "ci",
          "audit",
          "macro",
          "graph",
        ]);

        const defineTypes = getDeterministicCompletions("choir define ").map((item) => item.label);
        assert.deepStrictEqual(defineTypes, ["mission", "vision", "goal", "constraint", "non-goal"]);

        const analyzeTypes = getDeterministicCompletions("choir analyze ").map((item) => item.label);
        assert.deepStrictEqual(analyzeTypes, ["workspace", "hotspots", "summary"]);

        const planTail = getDeterministicCompletions("choir plan ").map((item) => item.label);
        assert.deepStrictEqual(planTail, ["for", "--optimize", "--adaptive", "then"]);

        const simulateTail = getDeterministicCompletions("choir simulate ").map((item) => item.label);
        assert.deepStrictEqual(simulateTail, ["plan", "units", "then"]);

        const executeTail = getDeterministicCompletions("choir execute ").map((item) => item.label);
        assert.deepStrictEqual(executeTail, ["plan", "--preview", "--strategy", "identifier", "then"]);

        const rollbackTail = getDeterministicCompletions("choir rollback ").map((item) => item.label);
        assert.deepStrictEqual(rollbackTail, ["--stage", "identifier", "then"]);

        const policyTail = getDeterministicCompletions("choir policy ").map((item) => item.label);
        assert.deepStrictEqual(policyTail, ["status"]);

        const macroTail = getDeterministicCompletions("choir macro ").map((item) => item.label);
        assert.deepStrictEqual(macroTail, ["list", "show", "identifier"]);

        const auditTail = getDeterministicCompletions("choir audit ").map((item) => item.label);
        assert.deepStrictEqual(auditTail, ["log", "report", "query"]);

        const importTail = getDeterministicCompletions("choir import ").map((item) => item.label);
        assert.deepStrictEqual(importTail, ["identifier"]);

        const libraryTail = getDeterministicCompletions("choir library ").map((item) => item.label);
        assert.deepStrictEqual(libraryTail, ["list", "install", "update", "lock"]);

        const ciTail = getDeterministicCompletions("choir ci ").map((item) => item.label);
        assert.deepStrictEqual(ciTail, ["run"]);

        const graphTail = getDeterministicCompletions("choir graph ").map((item) => item.label);
        assert.deepStrictEqual(graphTail, ["focus", "dependencies", "dependents", "then"]);
      },
    },
    {
      id: "2.28",
      name: "choir editor validation reuses parser behavior per command line",
      run: async () => {
        const diagnostics = validateChoirDocument([
          "# comment only",
          "choir define goal \"valid\"",
          "choir define goal invalid",
        ].join("\n"));

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].line, 2);
        assert.ok(diagnostics[0].message.includes("Expected quoted string"));
      },
    },
    {
      id: "2.29",
      name: "init wizard enforces step flow validation and deterministic dsl output",
      run: async () => {
        const wizard = new InitWizard(createWizardState());

        const emptyMission = wizard.next("   ");
        assert.strictEqual(emptyMission.status, "active");
        assert.strictEqual(emptyMission.state.currentStep, "mission");

        wizard.next("Deterministic delivery platform");
        assert.strictEqual(wizard.state.currentStep, "vision");

        wizard.next("Policy-native engineering workflow");
        assert.strictEqual(wizard.state.currentStep, "goals");

        wizard.next("enforce boundaries");
        wizard.next("  enforce   boundaries  ");
        assert.deepStrictEqual(wizard.state.data.goals, ["enforce boundaries"]);

        wizard.next("done");
        assert.strictEqual(wizard.state.currentStep, "constraints");

        wizard.next("no direct db access");
        wizard.next("done");
        assert.strictEqual(wizard.state.currentStep, "non-goals");

        wizard.next("distributed app");
        wizard.next("done");
        assert.strictEqual(wizard.state.currentStep, "review");

        const commands = buildDSL(wizard.state.data);
        assert.deepStrictEqual(commands, [
          'choir define mission "Deterministic delivery platform"',
          'choir define vision "Policy-native engineering workflow"',
          'choir define goal "enforce boundaries"',
          'choir define constraint "no direct db access"',
          'choir define non-goal "distributed app"',
        ]);

        const confirmed = wizard.next("yes");
        assert.strictEqual(confirmed.status, "confirmed");
      },
    },
    {
      id: "2.30",
      name: "init wizard session persistence supports resume and clear",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-init-wizard-"));
        try {
          const wizard = new InitWizard(createWizardState("backend"));
          wizard.next("Mission");

          saveInitSession(root, {
            version: 1,
            mode: "merge",
            state: wizard.state,
          });

          const loaded = loadInitSession(root);
          assert.ok(loaded);
          assert.strictEqual(loaded?.mode, "merge");
          assert.strictEqual(loaded?.state.currentStep, "vision");
          assert.deepStrictEqual(loaded?.state.data.goals, ["scalable service architecture"]);

          clearInitSession(root);
          assert.strictEqual(loadInitSession(root), null);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      id: "2.30a",
      name: "init chat shortcut parser accepts prefixed and stripped participant input",
      run: async () => {
        assert.deepStrictEqual(parseInitChatCommand("@choir init"), {
          type: "init",
        });
        assert.deepStrictEqual(parseInitChatCommand("init"), {
          type: "init",
        });

        assert.deepStrictEqual(parseInitChatCommand("@choir init --template backend"), {
          type: "init",
          template: "backend",
        });
        assert.deepStrictEqual(parseInitChatCommand("init --template frontend"), {
          type: "init",
          template: "frontend",
        });

        assert.deepStrictEqual(parseInitChatCommand("init --template invalid"), {
          type: "init",
          invalidTemplate: "invalid",
        });

        assert.strictEqual(parseInitChatCommand("choir init"), null);
      },
    },
    {
      id: "2.30c",
      name: "verify chat shortcut parser accepts full and quick modes",
      run: async () => {
        assert.deepStrictEqual(parseVerifyChatCommand("@choir verify"), {
          type: "verify",
          mode: "full",
        });

        assert.deepStrictEqual(parseVerifyChatCommand("verify"), {
          type: "verify",
          mode: "full",
        });

        assert.deepStrictEqual(parseVerifyChatCommand("@choir verify --quick"), {
          type: "verify",
          mode: "quick",
        });

        assert.deepStrictEqual(parseVerifyChatCommand("@choir verify --property"), {
          type: "verify",
          mode: "property",
        });

        assert.deepStrictEqual(parseVerifyChatCommand("@choir verify --contracts"), {
          type: "verify",
          mode: "contracts",
        });

        assert.deepStrictEqual(parseVerifyChatCommand("@choir verify --determinism"), {
          type: "verify",
          mode: "determinism",
        });

        assert.deepStrictEqual(parseVerifyChatCommand("@choir verify --transactions"), {
          type: "verify",
          mode: "transactions",
        });

        assert.deepStrictEqual(parseVerifyChatCommand("@choir verify --state"), {
          type: "verify",
          mode: "state",
        });

        assert.deepStrictEqual(parseVerifyChatCommand("@choir verify --policy"), {
          type: "verify",
          mode: "policy",
        });

        assert.deepStrictEqual(parseVerifyChatCommand("@choir verify --orchestration"), {
          type: "verify",
          mode: "orchestration",
        });

        assert.deepStrictEqual(parseVerifyChatCommand("@choir verify --production"), {
          type: "verify",
          mode: "production",
        });

        assert.deepStrictEqual(parseVerifyChatCommand("@choir verify --compiler"), {
          type: "verify",
          mode: "compiler",
        });

        assert.deepStrictEqual(parseVerifyChatCommand("@choir verify --full"), {
          type: "verify",
          mode: "full-system",
        });

        assert.deepStrictEqual(parseVerifyChatCommand("@choir verify --chaos"), {
          type: "verify",
          mode: "chaos",
        });

        assert.deepStrictEqual(parseVerifyChatCommand("@choir verify --chaos extreme"), {
          type: "verify",
          mode: "chaos",
          chaosMode: "extreme",
        });

        assert.strictEqual(parseVerifyChatCommand("choir verify"), null);
      },
    },
    {
      id: "2.30d",
      name: "chat DSL normalization maps set shorthand to canonical define commands",
      run: async () => {
        assert.strictEqual(
          normalizeChatDSLInput('@choir set goal "Refactor API layer"'),
          'choir define goal "Refactor API layer"'
        );

        assert.strictEqual(
          normalizeChatDSLInput('set non goal "legacy API support"'),
          'choir define non-goal "legacy API support"'
        );

        assert.strictEqual(
          normalizeChatDSLInput('@choir define goal "Deterministic planning"'),
          'choir define goal "Deterministic planning"'
        );

        assert.strictEqual(
          normalizeChatDSLInput("@choir show"),
          "choir status"
        );

        assert.strictEqual(
          normalizeChatDSLInput("@choir show status"),
          "choir status"
        );

        assert.strictEqual(
          normalizeChatDSLInput("@choir rollback"),
          "choir rollback"
        );

        const normalizedAst = parseCommand(normalizeChatDSLInput('set goal "Refactor API layer"')).ast;
        assert.strictEqual(normalizedAst.type, "define");
        assert.strictEqual(normalizedAst.defineType, "goal");
        assert.strictEqual(normalizedAst.value, "Refactor API layer");

        const showAst = parseCommand(normalizeChatDSLInput("@choir show")).ast;
        assert.strictEqual(showAst.type, "status");

        assert.deepStrictEqual(
          parseGoalMutationChatCommand('@choir remove goal: "Refactor API layer"'),
          {
            type: "remove-goal",
            goal: "Refactor API layer",
          }
        );

        assert.deepStrictEqual(
          parseGoalMutationChatCommand("@choir remove goal \"Refactor API layer\""),
          {
            type: "remove-goal",
            goal: "Refactor API layer",
          }
        );

        assert.deepStrictEqual(
          parseExportChatCommand("@choir export --format json"),
          {
            type: "export",
            format: "json",
          }
        );

        assert.deepStrictEqual(
          parseExportChatCommand("@choir export --format yaml"),
          {
            type: "export-error",
            reason: "unsupported-format",
            format: "yaml",
          }
        );
      },
    },
    {
      id: "2.30e",
      name: "preview synthesis is deterministic in fresh workspace without configured plans",
      run: async () => {
        const fixture = createHarnessFromFixture("simple-project");

        try {
          const control = fixture.harness.loadControlPlane();
          control.execution.plans = [];
          fixture.harness.saveControlPlane(control);

          const fingerprints: string[] = [];
          for (let run = 0; run < 10; run += 1) {
            const preview = await synthesizePreviewContract({
              root: fixture.root,
              controlPlane: control,
              command: "choir preview",
              persistPreviewState: false,
              recordPendingApproval: false,
            });

            assert.strictEqual(preview.planSource, "synthesized");
            assert.ok(preview.stageResults.every((stage) => stage.status === "success"));

            fingerprints.push(JSON.stringify({
              previewHash: preview.previewHash,
              simulationHash: preview.simulationHash,
              stateHash: preview.stateHash,
              planId: preview.planId,
              strategyId: preview.strategyId,
              executionStages: preview.executionStages,
              stageResults: preview.stageResults,
            }));
          }

          assert.ok(fingerprints.every((entry) => entry === fingerprints[0]));
        } finally {
          fixture.dispose();
        }
      },
    },
    {
      id: "2.30f",
      name: "preview synthesis enforces approval binding for require-approval policies",
      run: async () => {
        const fixture = createHarnessFromFixture("simple-project");

        try {
          const control = fixture.harness.loadControlPlane();
          writePoliciesDSL(fixture.root, [
            "policy preview-approval {",
            "  when diff.path = \"execution.plans\" and diff.operation = add then require-approval",
            "}",
            "",
          ].join("\n"));

          const first = await synthesizePreviewContract({
            root: fixture.root,
            controlPlane: control,
            command: "choir preview",
            persistPreviewState: false,
            recordPendingApproval: true,
          });

          assert.strictEqual(first.policy.decision, "require-approval");
          assert.strictEqual(first.approval.required, true);
          assert.strictEqual(first.approval.approved, false);
          assert.ok(first.approval.pendingId);

          approvePendingDiff(
            fixture.root,
            first.approval.pendingId as string,
            "architecture-suite",
            new Date(0).toISOString()
          );

          const second = await synthesizePreviewContract({
            root: fixture.root,
            controlPlane: control,
            command: "choir preview",
            persistPreviewState: false,
            recordPendingApproval: true,
          });

          assert.strictEqual(second.approval.required, true);
          assert.strictEqual(second.approval.approved, true);
          assert.strictEqual(second.previewHash, first.previewHash);
        } finally {
          fixture.dispose();
        }
      },
    },
    {
      id: "2.30b",
      name: "simulation chat formatter renders deterministic summary and risk labels",
      run: async () => {
        const rendered = formatSimulationChatResult({
          success: true,
          strategyId: "strategy-safe",
          units: ["repo-b", "repo-a"],
          changes: [
            {
              unitId: "repo-b",
              filesChanged: [".choir/state.json"],
              operations: ["set:meta.b=1"],
            },
            {
              unitId: "repo-a",
              filesChanged: [".choir/state.json"],
              operations: ["set:meta.a=1"],
            },
          ],
          violations: [],
          metrics: {
            risk: 2,
            changes: 2,
            violations: 0,
          },
        });

        assert.ok(rendered.includes("Simulation successful"));
        assert.ok(rendered.includes("- strategy: strategy-safe"));
        assert.ok(rendered.includes("- units: repo-b, repo-a"));

        const repoALine = rendered.indexOf("- repo-a: 1 files");
        const repoBLine = rendered.indexOf("- repo-b: 1 files");
        assert.ok(repoALine >= 0 && repoBLine >= 0);
        assert.ok(repoALine < repoBLine);

        assert.ok(rendered.includes("Risk: LOW"));
        assert.strictEqual(simulationRiskLabel(0, 9), "MEDIUM");
        assert.strictEqual(simulationRiskLabel(1, 0), "HIGH");
      },
    },
    {
      id: "2.31",
      name: "dsl parser supports macro command surface",
      run: async () => {
        assert.deepStrictEqual(parseCommand("choir macro list").ast, {
          type: "macro-list",
        });

        assert.deepStrictEqual(parseCommand("choir macro show enforce-service-boundaries").ast, {
          type: "macro-show",
          macroId: "enforce-service-boundaries",
        });

        assert.deepStrictEqual(
          parseCommand('choir macro enforce-service-boundaries entity="repository", tier="core"').ast,
          {
            type: "macro-run",
            macroId: "enforce-service-boundaries",
            args: {
              entity: "repository",
              tier: "core",
            },
          }
        );
      },
    },
    {
      id: "2.32",
      name: "macro expansion is deterministic with parameter defaults",
      run: async () => {
        const macro = getMacro(repoRoot, "enforce-service-boundaries");

        const first = expandMacro(macro, {});
        const second = expandMacro(macro, {});

        assert.deepStrictEqual(first, second);
        assert.deepStrictEqual(first, [
          'choir define goal "enforce clean service boundaries"',
          'choir define constraint "no direct db access"',
          "choir plan",
        ]);
      },
    },
    {
      id: "2.33",
      name: "macro execution compiles sequentially through yaml pipeline",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-macro-run-"));
        fs.mkdirSync(path.join(root, ".choir"), { recursive: true });
        fs.writeFileSync(path.join(root, ".choir", "macros.yaml"), [
          "macros:",
          "  - id: setup-boundaries",
          "    version: 1.0.0",
          "    parameters:",
          "      - name: entity",
          "        required: false",
          "        default: service",
          "    body:",
          "      - choir define goal \"enforce clean {{entity}} boundaries\"",
          "      - choir define constraint \"no direct db access\"",
          "      - choir plan",
          "",
        ].join("\n"), "utf-8");

        const controlPath = path.join(root, ".choir", "choir.config.yaml");
        const executed = runMacro(
          root,
          "setup-boundaries",
          { entity: "repository" },
          makeControlPlane(),
          controlPath,
          { workspaceRoot: root }
        );

        assert.strictEqual(executed.decision, "allow");
        assert.strictEqual(executed.trace.executedSteps, 3);
        assert.strictEqual(executed.steps.length, 3);
        assert.strictEqual(fs.existsSync(controlPath), true);
        assert.ok(executed.updatedControlPlane.intent.goals.includes("enforce clean repository boundaries"));
        assert.ok(executed.updatedControlPlane.intent.constraints.includes("no direct db access"));
      },
    },
    {
      id: "2.32",
      name: "macro composition rejects recursive cycles deterministically",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-macro-recursion-"));
        fs.mkdirSync(path.join(root, ".choir"), { recursive: true });
        fs.writeFileSync(path.join(root, ".choir", "macros.yaml"), [
          "macros:",
          "  - id: a",
          "    version: 1.0.0",
          "    body:",
          "      - choir macro b",
          "  - id: b",
          "    version: 1.0.0",
          "    body:",
          "      - choir macro a",
          "",
        ].join("\n"), "utf-8");

        const controlPath = path.join(root, ".choir", "choir.config.yaml");
        assert.throws(
          () => runMacro(root, "a", {}, makeControlPlane(), controlPath, { workspaceRoot: root }),
          /Macro recursion detected/
        );
      },
    },
    {
      id: "2.33",
      name: "policy role x environment matrix is deterministic",
      run: async () => {
        const baseline = controlPlaneToChoirConfig(makeControlPlane());

        const goalChange = (() => {
          const next = makeControlPlane();
          next.intent.goals = ["secure boundaries"];
          return computeDiff(baseline, controlPlaneToChoirConfig(next));
        })();

        const constraintChange = (() => {
          const next = makeControlPlane();
          next.intent.constraints = ["db access"];
          return computeDiff(baseline, controlPlaneToChoirConfig(next));
        })();

        const planChange = (() => {
          const next = makeControlPlane();
          next.execution.plans = [makePlan("plan-prod", [makeTask("t1", "analysis")])];
          return computeDiff(baseline, controlPlaneToChoirConfig(next));
        })();

        const policySet = toPolicySet([
          {
            id: "block-structural-changes-prod",
            scope: { environments: ["production"] },
            match: { path: "execution.plans", operation: "add" },
            effect: { type: "deny", message: "Cannot modify execution plans in production" },
          },
          {
            id: "ci-requires-approval",
            scope: { environments: ["ci"] },
            match: { path: "intent.constraints", operation: "add" },
            effect: { type: "require-approval" },
          },
          {
            id: "analyst-read-only",
            scope: { roles: ["analyst"] },
            match: { path: "*", operation: "add" },
            effect: { type: "deny", message: "analyst is read-only" },
          },
        ]);

        const architectLocal = evaluatePolicies(goalChange, policySet, {
          role: "architect",
          environment: "local",
        });
        assert.strictEqual(architectLocal.trace.decision, "allow");

        const conductorCi = evaluatePolicies(constraintChange, policySet, {
          role: "conductor",
          environment: "ci",
        });
        assert.strictEqual(conductorCi.trace.decision, "require-approval");

        const anyProduction = evaluatePolicies(planChange, policySet, {
          role: "architect",
          environment: "production",
        });
        assert.strictEqual(anyProduction.trace.decision, "deny");

        const analystAny = evaluatePolicies(goalChange, policySet, {
          role: "analyst",
          environment: "local",
        });
        assert.strictEqual(analystAny.trace.decision, "deny");

        assert.deepStrictEqual(
          evaluatePolicies(goalChange, policySet, { role: "analyst", environment: "local" }),
          evaluatePolicies(goalChange, policySet, { role: "analyst", environment: "local" })
        );
      },
    },
    {
      id: "2.34",
      name: "policy precedence is deterministic deny over require-approval",
      run: async () => {
        const baseline = controlPlaneToChoirConfig(makeControlPlane());
        const nextControl = makeControlPlane();
        nextControl.intent.constraints = ["db access"];
        const diffs = computeDiff(baseline, controlPlaneToChoirConfig(nextControl));

        const policySet = toPolicySet([
          {
            id: "require-db-approval",
            match: { path: "intent.constraints", operation: "add" },
            effect: { type: "require-approval" },
          },
          {
            id: "deny-db-local",
            scope: { environments: ["local"] },
            match: { path: "intent.constraints", operation: "add" },
            effect: { type: "deny", message: "db denied" },
          },
        ]);

        const evaluation = evaluatePolicies(diffs, policySet, {
          role: "architect",
          environment: "local",
        });

        assert.strictEqual(evaluation.trace.decision, "deny");
        assert.strictEqual(evaluation.result.allowed, false);
      },
    },
    {
      id: "2.35",
      name: "runtime environment detection drives policy deny in production",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-policy-env-prod-"));
        const controlPath = path.join(root, ".choir", "choir.config.yaml");

        const control = makeControlPlane();
        control.intent.goals = ["enforce boundaries"];
        writePoliciesDSL(root, [
          "policy deny-plan-prod {",
          "  when diff.path = \"execution.plans\" and environment = production then deny",
          "}",
          "",
        ].join("\n"));

        await withTemporaryEnv({ NODE_ENV: "production", CI: undefined, CHOIR_ENVIRONMENT: undefined }, () => {
          assert.strictEqual(detectEnvironment(), "production");
          const result = compileDSLAndWrite("choir plan", control, controlPath, { workspaceRoot: root });
          assert.strictEqual(result.decision, "deny");
          assert.strictEqual(result.policyTrace?.environment, "production");
          assert.strictEqual(fs.existsSync(controlPath), false);
        });
      },
    },
    {
      id: "2.36",
      name: "role capability validation denies escalation deterministically",
      run: async () => {
        validateRole({ role: "architect", environment: "local" }, "modify-yaml");
        validateRole({ role: "conductor", environment: "ci" }, "plan");
        validateRole({ role: "enforcer", environment: "staging" }, "execute");
        validateRole({ role: "analyst", environment: "local" }, "read-only");

        assert.throws(
          () => validateRole({ role: "analyst", environment: "local" }, "modify-yaml"),
          /Role violation/
        );
        assert.throws(
          () => validateRole({ role: "enforcer", environment: "local" }, "plan"),
          /Role violation/
        );
      },
    },
    {
      id: "2.37",
      name: "policy dsl parses and compiles deterministically",
      run: async () => {
        const text = [
          "policy restrict-db-access {",
          "  when diff.path = \"intent.constraints\" and diff.operation = add and contains \"db\" then require-approval",
          "}",
          "",
          "policy analyst-readonly {",
          "  when role = analyst and diff.operation = add then deny",
          "}",
          "",
        ].join("\n");

        const astA = parsePolicyDSL(text);
        const astB = parsePolicyDSL(text);
        assert.deepStrictEqual(astA, astB);

        const compiledA = compilePolicies(astA);
        const compiledB = compilePolicies(astB);
        assert.deepStrictEqual(compiledA, compiledB);
        assert.strictEqual(compiledA.rules.length, 2);
        assert.strictEqual(compiledA.rules[0].policyId, "analyst-readonly");
        assert.strictEqual(compiledA.rules[1].policyId, "restrict-db-access");
      },
    },
    {
      id: "2.38",
      name: "policy dsl rejects invalid role during parse",
      run: async () => {
        const invalid = [
          "policy bad {",
          "  when role = unknown and diff.operation = add then allow",
          "}",
          "",
        ].join("\n");

        assert.throws(() => parsePolicyDSL(invalid), /Invalid role/);
      },
    },
    {
      id: "2.39",
      name: "policy dsl loader rejects duplicate policy ids",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-policy-dsl-dup-"));
        writePoliciesDSL(root, [
          "policy dup {",
          "  when diff.operation = add then allow",
          "}",
          "",
          "policy dup {",
          "  when diff.operation = remove then deny",
          "}",
          "",
        ].join("\n"));

        assert.throws(() => loadPolicies(root), /Duplicate policy id/);
      },
    },
    {
      id: "2.40",
      name: "policy inheritance loader returns org repo and environment sources",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-policy-sources-"));

        writeOrgPoliciesDSL(root, [
          "policy org-base {",
          "  when diff.operation = add then allow",
          "}",
          "",
        ].join("\n"));

        writePoliciesDSL(root, [
          "policy repo-base {",
          "  when diff.path = \"intent.constraints\" and diff.operation = add then require-approval",
          "}",
          "",
        ].join("\n"));

        const loaded = loadAllPolicies(root, "production");
        assert.strictEqual(loaded.org.length, 1);
        assert.strictEqual(loaded.repo.length, 1);
        assert.strictEqual(loaded.environment.length > 0, true);
      },
    },
    {
      id: "2.41",
      name: "org deny policy wins over repo allow policy",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-policy-org-deny-"));
        const controlPath = path.join(root, ".choir", "choir.config.yaml");

        writeOrgPoliciesDSL(root, [
          "policy org-deny-db {",
          "  when diff.path = \"intent.constraints\" and diff.operation = add and contains \"db\" then deny",
          "}",
          "",
        ].join("\n"));

        writePoliciesDSL(root, [
          "policy repo-allow-db {",
          "  when diff.path = \"intent.constraints\" and diff.operation = add and contains \"db\" then allow",
          "}",
          "",
        ].join("\n"));

        const result = compileDSLAndWrite(
          'choir define constraint "db connection"',
          makeControlPlane(),
          controlPath,
          { workspaceRoot: root }
        );

        assert.strictEqual(result.decision, "deny");
        assert.strictEqual(fs.existsSync(controlPath), false);
      },
    },
    {
      id: "2.42",
      name: "repo cannot override org deny with assign inheritance",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-policy-no-override-deny-"));

        writeOrgPoliciesDSL(root, [
          "policy org-deny-db {",
          "  override child",
          "  when diff.path = \"intent.constraints\" and diff.operation = add then deny",
          "}",
          "",
        ].join("\n"));

        writePoliciesDSL(root, [
          "policy repo-assign-allow-db {",
          "  inherit assign",
          "  when diff.path = \"intent.constraints\" and diff.operation = add then allow",
          "}",
          "",
        ].join("\n"));

        assert.throws(() => loadPolicies(root, "local"), /cannot override/i);
      },
    },
    {
      id: "2.43",
      name: "org can allow controlled child assign for non-deny policy",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-policy-child-override-"));
        const controlPath = path.join(root, ".choir", "choir.config.yaml");

        writeOrgPoliciesDSL(root, [
          "policy org-require-review {",
          "  override child",
          "  when diff.path = \"intent.constraints\" and diff.operation = add and contains \"db\" then require-approval",
          "}",
          "",
        ].join("\n"));

        writePoliciesDSL(root, [
          "policy repo-assign-allow {",
          "  inherit assign",
          "  when diff.path = \"intent.constraints\" and diff.operation = add and contains \"db\" then allow",
          "}",
          "",
        ].join("\n"));

        const result = compileDSLAndWrite(
          'choir define constraint "db connection"',
          makeControlPlane(),
          controlPath,
          { workspaceRoot: root }
        );

        assert.strictEqual(result.decision, "allow");
        assert.strictEqual(fs.existsSync(controlPath), true);
      },
    },
    {
      id: "2.44",
      name: "environment policy layer is applied last and can enforce strict production denies",
      run: async () => {
        const prodRoot = fs.mkdtempSync(path.join(repoRoot, ".tmp-policy-env-last-prod-"));
        const prodControlPath = path.join(prodRoot, ".choir", "choir.config.yaml");

        writeOrgPoliciesDSL(prodRoot, [
          "policy org-allow-plans {",
          "  when diff.path = \"execution.plans\" and diff.operation = add then allow",
          "}",
          "",
        ].join("\n"));

        writePoliciesDSL(prodRoot, [
          "policy repo-allow-plans {",
          "  when diff.path = \"execution.plans\" and diff.operation = add then allow",
          "}",
          "",
        ].join("\n"));

        await withTemporaryEnv({ NODE_ENV: "production", CI: undefined, CHOIR_ENVIRONMENT: undefined }, () => {
          const control = makeControlPlane();
          control.intent.goals = ["enforce boundaries"];
          const result = compileDSLAndWrite("choir plan", control, prodControlPath, { workspaceRoot: prodRoot });
          assert.strictEqual(result.decision, "deny");
          assert.strictEqual(result.policyTrace?.environment, "production");
        });

        const localRoot = fs.mkdtempSync(path.join(repoRoot, ".tmp-policy-env-last-local-"));
        const localControlPath = path.join(localRoot, ".choir", "choir.config.yaml");

        writeOrgPoliciesDSL(localRoot, [
          "policy org-allow-plans {",
          "  when diff.path = \"execution.plans\" and diff.operation = add then allow",
          "}",
          "",
        ].join("\n"));

        writePoliciesDSL(localRoot, [
          "policy repo-allow-plans {",
          "  when diff.path = \"execution.plans\" and diff.operation = add then allow",
          "}",
          "",
        ].join("\n"));

        await withTemporaryEnv({ NODE_ENV: undefined, CI: undefined, CHOIR_ENVIRONMENT: undefined }, () => {
          const control = makeControlPlane();
          control.intent.goals = ["enforce boundaries"];
          const result = compileDSLAndWrite("choir plan", control, localControlPath, { workspaceRoot: localRoot });
          assert.strictEqual(result.decision, "allow");
        });
      },
    },
    {
      id: "2.45",
      name: "duplicate policy ids across org and repo layers are rejected",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-policy-dup-cross-layer-"));

        writeOrgPoliciesDSL(root, [
          "policy shared-policy {",
          "  when diff.operation = add then allow",
          "}",
          "",
        ].join("\n"));

        writePoliciesDSL(root, [
          "policy shared-policy {",
          "  when diff.operation = add then deny",
          "}",
          "",
        ].join("\n"));

        assert.throws(() => loadPolicies(root, "local"), /Duplicate policy id across layers/);
      },
    },
    {
      id: "2.46",
      name: "effective policy trace records source and final decision deterministically",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-policy-trace-sources-"));
        const controlPath = path.join(root, ".choir", "choir.config.yaml");

        writeOrgPoliciesDSL(root, [
          "policy org-deny-db {",
          "  when diff.path = \"intent.constraints\" and diff.operation = add and contains \"db\" then deny",
          "}",
          "",
        ].join("\n"));

        writePoliciesDSL(root, [
          "policy repo-allow-db {",
          "  when diff.path = \"intent.constraints\" and diff.operation = add and contains \"db\" then allow",
          "}",
          "",
        ].join("\n"));

        const first = compileDSLAndWrite(
          'choir define constraint "db connection"',
          makeControlPlane(),
          controlPath,
          { workspaceRoot: root }
        );
        const second = compileDSLAndWrite(
          'choir define constraint "db connection"',
          makeControlPlane(),
          controlPath,
          { workspaceRoot: root }
        );

        assert.deepStrictEqual(first.policyTrace, second.policyTrace);
        assert.strictEqual(first.policyTrace?.inheritanceTrace.finalDecision, "deny");
        assert.ok(first.policyTrace?.inheritanceTrace.matchedRules.some((entry) => entry.source === "org"));
        assert.ok(first.policyTrace?.inheritanceTrace.matchedRules.some((entry) => entry.source === "repo"));
      },
    },
    {
      id: "2.47",
      name: "effective policy visualization renders source-aware debug output",
      run: async () => {
        const rendered = formatPolicyInheritanceTrace({
          matchedRules: [
            {
              policyId: "org-deny-prod",
              source: "org",
              effect: "deny",
            },
            {
              policyId: "repo-allow-plans",
              source: "repo",
              effect: "allow",
            },
          ],
          finalDecision: "deny",
        });

        assert.ok(rendered.includes("Effective Policy:"));
        assert.ok(rendered.includes("[ORG] deny org-deny-prod"));
        assert.ok(rendered.includes("[REPO] allow repo-allow-plans"));
        assert.ok(rendered.includes("Final Decision: DENY"));
      },
    },
    {
      id: "2.48",
      name: "audit store records compile and policy evaluation with immutable hash chain",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-audit-compile-"));
        const controlPath = path.join(root, ".choir", "choir.config.yaml");

        compileDSLAndWrite(
          'choir define goal "enforce service boundaries"',
          makeControlPlane(),
          controlPath,
          { workspaceRoot: root, actorId: "test-actor" }
        );

        const store = readAuditStore(root);
        assert.strictEqual(store.records.length >= 2, true);

        const actions = store.records.map((record) => record.auditEvent.action);
        assert.ok(actions.includes("policy-evaluation"));
        assert.ok(actions.includes("compile-dsl"));

        for (let index = 0; index < store.records.length; index += 1) {
          const record = store.records[index];
          assert.strictEqual(record.chainIndex, index + 1);
          if (index === 0) {
            assert.strictEqual(record.previousHash, "GENESIS");
          } else {
            assert.strictEqual(record.previousHash, store.records[index - 1].hash);
          }
        }
      },
    },
    {
      id: "2.49",
      name: "audit records approval granted events",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-audit-approval-"));
        const controlPath = path.join(root, ".choir", "choir.config.yaml");

        writePoliciesDSL(root, [
          "policy require-db-approval {",
          "  when diff.path = \"intent.constraints\" and diff.operation = add and contains \"db\" then require-approval",
          "}",
          "",
        ].join("\n"));

        const first = compileDSLAndWrite(
          'choir define constraint "db connection"',
          makeControlPlane(),
          controlPath,
          { workspaceRoot: root }
        );
        assert.strictEqual(first.decision, "require-approval");
        assert.ok(first.pendingApprovalId);

        const approval = approveDiff(root, first.pendingApprovalId!, "approver-user");
        assert.strictEqual(approval.approved, true);

        const records = queryAudit(root, { action: "approval-granted" });
        assert.strictEqual(records.length, 1);
        assert.strictEqual(records[0].auditEvent.result, "success");
        assert.strictEqual(records[0].auditEvent.actor.id, "approver-user");
      },
    },
    {
      id: "2.50",
      name: "audit query and compliance reports are deterministic with multi-format export",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-audit-report-"));
        const controlPath = path.join(root, ".choir", "choir.config.yaml");

        writePoliciesDSL(root, [
          "policy deny-db {",
          "  when diff.path = \"intent.constraints\" and diff.operation = add and contains \"db\" then deny",
          "}",
          "",
        ].join("\n"));

        compileDSLAndWrite(
          'choir define constraint "db connection"',
          makeControlPlane(),
          controlPath,
          { workspaceRoot: root }
        );

        compileDSLAndWrite(
          'choir define goal "safe boundary"',
          makeControlPlane(),
          controlPath,
          { workspaceRoot: root }
        );

        const queriedA = queryAudit(root, { role: "architect" });
        const queriedB = queryAudit(root, { role: "architect" });
        assert.deepStrictEqual(queriedA, queriedB);

        const reportA = generateReport(root, {});
        const reportB = generateReport(root, {});
        assert.deepStrictEqual(reportA, reportB);

        const asJson = exportReport(reportA, "json");
        const asYaml = exportReport(reportA, "yaml");
        const asPdf = exportReport(reportA, "pdf");

        assert.ok(asJson.includes("\"totalEvents\""));
        assert.ok(asYaml.includes("totalEvents:"));
        assert.ok(asPdf.startsWith("%PDF-1.4"));
      },
    },
    {
      id: "2.51",
      name: "transactional execution writes execution audit record",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-audit-execute-"));
        const control = makeControlPlane();
        const plan = makePlan("plan-audit", [
          makeTask("t-analysis", "analysis"),
        ]);
        const built = buildExecutionPlan([plan], { smallTaskMergeThreshold: 0 });

        const executed = await runExecutionPlanTransactionally(built.executionPlan, {
          root,
          controlPlane: control,
          enforcer: {
            async proposeFixes() {
              return {
                fixes: [],
                diagnostics: [],
              };
            },
          },
          pipeline: {
            async run() {
              return {
                diagnostics: [],
                conflicts: [],
              };
            },
          },
        });
        assert.strictEqual(executed.transactions.length, 1);
        assert.strictEqual(executed.transactions[0].status, "committed");

        const executionRecords = queryAudit(root, { action: "execute-plan" });
        assert.strictEqual(executionRecords.length, 1);
        assert.strictEqual(executionRecords[0].auditEvent.result, "success");
        assert.strictEqual(executionRecords[0].executionTrace?.planId, built.executionPlan.batches[0].id);
      },
    },
    {
      id: "2.52",
      name: "macro library version selectors resolve deterministically",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-macro-library-resolve-"));

        const writeLibrary = (name: string, version: string, bodyLine: string) => {
          const dir = path.join(root, ".choir", "libraries", name, version);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "macros.yaml"), [
            `name: ${name}`,
            `version: ${version}`,
            "metadata:",
            `  description: ${name}`,
            "macros:",
            "  - id: enforce-service-boundaries",
            "    body:",
            `      - ${bodyLine}`,
            "",
          ].join("\n"), "utf-8");
        };

        writeLibrary("core", "1.0.0", 'choir define goal "v1"');
        writeLibrary("core", "1.0.2", 'choir define goal "v102"');
        writeLibrary("core", "1.1.0", 'choir define goal "v110"');

        assert.strictEqual(resolveLibraryVersion(root, "core", "1.0.0"), "1.0.0");
        assert.strictEqual(resolveLibraryVersion(root, "core", "1.0.x"), "1.0.2");
        assert.strictEqual(resolveLibraryVersion(root, "core", "1.x"), "1.1.0");
        assert.strictEqual(resolveLibraryVersion(root, "core", "1.0.x"), resolveLibraryVersion(root, "core", "1.0.x"));
      },
    },
    {
      id: "2.53",
      name: "library install update and lock are reproducible",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-macro-library-lock-"));

        const writeLibrary = (version: string) => {
          const dir = path.join(root, ".choir", "libraries", "core", version);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "macros.yaml"), [
            "name: core",
            `version: ${version}`,
            "metadata:",
            "  description: core",
            "macros:",
            "  - id: enforce-service-boundaries",
            "    body:",
            `      - choir define goal \"core-${version}\"`,
            "",
          ].join("\n"), "utf-8");
        };

        writeLibrary("1.0.0");
        writeLibrary("1.0.1");
        writeLibrary("2.0.0");

        const installed = installLibrary(root, "core@1.0.x");
        assert.strictEqual(installed.resolvedVersion, "1.0.1");
        assert.strictEqual(readMacroLock(root).libraries.core, "1.0.1");

        const updated = updateLibrary(root, "core");
        assert.strictEqual(updated.resolvedVersion, "2.0.0");
        assert.strictEqual(readMacroLock(root).libraries.core, "2.0.0");

        const locked = lockLibraries(root);
        assert.strictEqual(locked.libraries.core, "2.0.0");
      },
    },
    {
      id: "2.54",
      name: "namespaced library macro execution logs audit metadata",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-macro-library-run-"));
        const libraryDir = path.join(root, ".choir", "libraries", "core", "1.0.0");
        fs.mkdirSync(libraryDir, { recursive: true });
        fs.writeFileSync(path.join(libraryDir, "macros.yaml"), [
          "name: core",
          "version: 1.0.0",
          "metadata:",
          "  description: core",
          "macros:",
          "  - id: enforce-service-boundaries",
          "    body:",
          "      - choir define goal \"enforce service boundaries\"",
          "",
        ].join("\n"), "utf-8");

        installLibrary(root, "core@1.0.0");

        const controlPath = path.join(root, ".choir", "choir.config.yaml");
        const run = runMacro(
          root,
          "core.enforce-service-boundaries",
          {},
          makeControlPlane(),
          controlPath,
          { workspaceRoot: root }
        );

        assert.strictEqual(run.decision, "allow");
        assert.strictEqual(run.trace.libraryTrace.library, "core");
        assert.strictEqual(run.trace.libraryTrace.version, "1.0.0");

        const compileRecords = queryAudit(root, { action: "compile-dsl" });
        assert.strictEqual(
          compileRecords.some((record) => {
            const metadata = (record.auditEvent.metadata ?? {}) as Record<string, unknown>;
            return metadata.macroLibrary === "core"
              && metadata.version === "1.0.0"
              && metadata.macroId === "enforce-service-boundaries";
          }),
          true
        );

        const macroRunRecords = queryAudit(root, { action: "macro-execution" });
        assert.strictEqual(macroRunRecords.length, 1);
      },
    },
    {
      id: "2.55",
      name: "policy engine supports macro selector deterministically",
      run: async () => {
        const baseline = controlPlaneToChoirConfig(makeControlPlane());
        const next = makeControlPlane();
        next.intent.goals = ["macro-policy-target"];
        const diffs = computeDiff(baseline, controlPlaneToChoirConfig(next));

        const policySet = toPolicySet([
          {
            id: "macro-only-approval",
            match: {
              macro: "core.enforce-service-boundaries",
            },
            effect: {
              type: "require-approval",
            },
          },
        ]);

        const matching = evaluatePolicies(diffs, policySet, {
          role: "architect",
          environment: "local",
          macroId: "core.enforce-service-boundaries",
        });
        const nonMatching = evaluatePolicies(diffs, policySet, {
          role: "architect",
          environment: "local",
          macroId: "core.other-macro",
        });

        assert.strictEqual(matching.trace.decision, "require-approval");
        assert.strictEqual(nonMatching.trace.decision, "allow");
        assert.deepStrictEqual(
          evaluatePolicies(diffs, policySet, {
            role: "architect",
            environment: "local",
            macroId: "core.enforce-service-boundaries",
          }),
          matching
        );
      },
    },
    {
      id: "2.56",
      name: "breaking library changes require major bump",
      run: async () => {
        const oldLibrary = {
          name: "core",
          version: "1.0.0",
          metadata: {},
          macros: [
            {
              id: "enforce-service-boundaries",
              parameters: [
                { name: "entity", required: false, default: "service" },
              ],
              body: ['choir define goal "old"'],
            },
          ],
        };

        const nextLibrary = {
          name: "core",
          version: "1.1.0",
          metadata: {},
          macros: [
            {
              id: "enforce-service-boundaries",
              parameters: [
                { name: "entity", required: true },
              ],
              body: ['choir define goal "new"'],
            },
          ],
        };

        const breaking = detectBreakingChanges(oldLibrary, nextLibrary);
        assert.strictEqual(breaking.breaking, true);
        assert.strictEqual(breaking.reasons.length > 0, true);

        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-macro-library-breaking-"));
        const writeLibrary = (version: string, required: boolean) => {
          const dir = path.join(root, ".choir", "libraries", "core", version);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "macros.yaml"), [
            "name: core",
            `version: ${version}`,
            "metadata:",
            "  description: core",
            "macros:",
            "  - id: enforce-service-boundaries",
            "    parameters:",
            "      - name: entity",
            `        required: ${required ? "true" : "false"}`,
            ...(required ? [] : ["        default: service"]),
            "    body:",
            `      - choir define goal \"core-${version}\"`,
            "",
          ].join("\n"), "utf-8");
        };

        writeLibrary("1.0.0", false);
        writeLibrary("1.1.0", true);

        assert.throws(
          () => resolveLibraryVersion(root, "core", "1.x"),
          /Breaking change detected/
        );
      },
    },
    {
      id: "2.57",
      name: "ci config defaults are deterministic",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-ci-config-defaults-"));
        const config = loadCIConfig(root);

        assert.deepStrictEqual(config.pipeline.stages, [
          "source",
          "compile",
          "plan",
          "policy",
          "preview",
          "execute",
          "audit",
        ]);
        assert.deepStrictEqual(config.macros, []);
      },
    },
    {
      id: "2.58",
      name: "ci pipeline trace and artifacts are deterministic for identical inputs",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-ci-run-"));
        fs.mkdirSync(path.join(root, "src"), { recursive: true });
        fs.writeFileSync(path.join(root, "src", "index.ts"), [
          "export const value = 1;",
          "",
        ].join("\n"), "utf-8");

        const controlPath = path.join(root, ".choir", "choir.config.yaml");
        fs.mkdirSync(path.dirname(controlPath), { recursive: true });
        fs.writeFileSync(controlPath, YAML.stringify(makeControlPlane()), "utf-8");

        fs.writeFileSync(path.join(root, ".choir", "ci.yaml"), [
          "pipeline:",
          "  stages:",
          "    - source",
          "    - compile",
          "    - plan",
          "    - policy",
          "    - preview",
          "    - audit",
          "environments:",
          "  local:",
          "    enforcePolicy: true",
          "    requireApproval: false",
          "macros: []",
          "",
        ].join("\n"), "utf-8");

        const control = ControlPlaneSchema.parse(YAML.parse(fs.readFileSync(controlPath, "utf-8")));

        const first = await runCI({
          root,
          controlPlane: control,
          controlPath,
          context: {
            role: "conductor",
            environment: "local",
          },
          actorId: "test-runner",
        });

        const second = await runCI({
          root,
          controlPlane: control,
          controlPath,
          context: {
            role: "conductor",
            environment: "local",
          },
          actorId: "test-runner",
        });

        assert.strictEqual(first.trace.result, "success");
        assert.strictEqual(second.trace.result, "success");
        assert.strictEqual(first.trace.commitId, second.trace.commitId);
        assert.deepStrictEqual(first.trace.stagesExecuted, second.trace.stagesExecuted);
        assert.strictEqual(first.artifacts.some((artifact) => artifact.endsWith("/plan.json")), true);
        assert.strictEqual(first.artifacts.some((artifact) => artifact.endsWith("/preview.diff")), true);
        assert.strictEqual(first.artifacts.some((artifact) => artifact.endsWith("/audit.log")), true);
      },
    },
    {
      id: "2.59",
      name: "refactor engine preview is deterministic and rollback restores snapshots",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-refactor-engine-"));

        fs.mkdirSync(path.join(root, "packages", "core", "src"), { recursive: true });
        fs.mkdirSync(path.join(root, "packages", "app", "src"), { recursive: true });

        fs.writeFileSync(path.join(root, "packages", "core", "src", "math.ts"), [
          "export function addOne(value: number): number {",
          "  return value + 1;",
          "}",
          "",
        ].join("\n"), "utf-8");

        fs.writeFileSync(path.join(root, "packages", "app", "src", "main.ts"), [
          "import { addOne } from \"../../core/src/math\";",
          "",
          "export const result = addOne(1);",
          "",
        ].join("\n"), "utf-8");

        const intent = {
          type: "rename" as const,
          symbol: "addOne",
          newName: "increment",
        };

        const first = await runRefactorIntent(intent, {
          root,
          controlPlane: makeControlPlane(),
          execute: false,
        });

        const second = await runRefactorIntent(intent, {
          root,
          controlPlane: makeControlPlane(),
          execute: false,
        });

        assert.deepStrictEqual(first.preview, second.preview);
        assert.strictEqual(first.simulation.validation.passed, true);
        assert.strictEqual(first.preview.changes.length >= 1, true);

        const executed = await runRefactorIntent(intent, {
          root,
          controlPlane: makeControlPlane(),
          execute: true,
        });

        assert.strictEqual(executed.execution?.committed, true);
        assert.strictEqual(executed.preview.hash, first.preview.hash);

        const appAfter = fs.readFileSync(path.join(root, "packages", "app", "src", "main.ts"), "utf-8");
        const coreAfter = fs.readFileSync(path.join(root, "packages", "core", "src", "math.ts"), "utf-8");
        assert.ok(appAfter.includes("increment"));
        assert.ok(coreAfter.includes("function increment"));

        const snapshotId = executed.execution?.snapshotId;
        assert.ok(snapshotId);
        await rollbackRefactor(root, snapshotId as string);

        const appRolledBack = fs.readFileSync(path.join(root, "packages", "app", "src", "main.ts"), "utf-8");
        const coreRolledBack = fs.readFileSync(path.join(root, "packages", "core", "src", "math.ts"), "utf-8");
        assert.ok(appRolledBack.includes("addOne"));
        assert.ok(coreRolledBack.includes("function addOne"));
      },
    },
    {
      id: "2.60",
      name: "macro execution is blocked outside pipeline in ci mode",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-macro-ci-mode-"));
        const controlPath = path.join(root, ".choir", "choir.config.yaml");
        fs.mkdirSync(path.dirname(controlPath), { recursive: true });

        fs.writeFileSync(path.join(root, ".choir", "macros.yaml"), [
          "macros:",
          "  - id: ci-only-macro",
          "    version: 1.0.0",
          "    body:",
          "      - choir define goal \"ci-only-goal\"",
          "",
        ].join("\n"), "utf-8");

        await withTemporaryEnv({ CI: "1" }, () => {
          assert.throws(
            () => runMacro(root, "ci-only-macro", {}, makeControlPlane(), controlPath, { workspaceRoot: root }),
            /CI mode macro execution is restricted/
          );
        });
      },
    },
    {
      id: "2.60",
      name: "dsl parser supports abstraction command surface",
      run: async () => {
        assert.deepStrictEqual(
          parseCommand('choir bootstrap-service name="user-service"').ast,
          {
            type: "abstraction-run",
            identifier: "bootstrap-service",
            args: {
              name: "user-service",
            },
          }
        );

        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-abstraction-list-"));
        const abstractions = listAbstractions(root);
        assert.strictEqual(abstractions.some((entry) => entry.id === "enforce-hexagonal-architecture"), true);
        assert.strictEqual(abstractions.some((entry) => entry.id === "migrate-to-service-layer"), true);
      },
    },
    {
      id: "2.61",
      name: "abstraction execution is deterministic and idempotent",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-abstraction-run-"));
        fs.mkdirSync(path.join(root, ".choir"), { recursive: true });

        fs.writeFileSync(path.join(root, ".choir", "macros.yaml"), [
          "macros:",
          "  - id: create-service",
          "    version: 1.0.0",
          "    parameters:",
          "      - name: name",
          "        required: true",
          "    body:",
          "      - choir define goal \"create {{name}} service\"",
          "",
        ].join("\n"), "utf-8");

        fs.writeFileSync(path.join(root, ".choir", "abstractions.yaml"), [
          "abstractions:",
          "  - id: bootstrap-service",
          "    version: 1.0.0",
          "    description: Bootstrap a service stack",
          "    parameters:",
          "      - name: name",
          "        required: true",
          "    expandsTo:",
          "      - choir macro create-service name=\"{{name}}\"",
          "      - choir define constraint \"no direct db access\"",
          "      - choir plan",
          "      - choir preview",
          "",
        ].join("\n"), "utf-8");

        const controlPath = path.join(root, ".choir", "choir.config.yaml");

        const first = runAbstraction(
          root,
          "bootstrap-service",
          { name: "user" },
          makeControlPlane(),
          controlPath,
          { workspaceRoot: root }
        );

        assert.strictEqual(first.decision, "allow");
        assert.strictEqual(first.trace.result, "success");
        assert.strictEqual(first.trace.expandedCommands.length, 4);
        assert.strictEqual(first.trace.macrosUsed.includes("local.create-service"), true);
        assert.strictEqual(first.updatedControlPlane.intent.goals.includes("create user service"), true);
        assert.strictEqual(first.updatedControlPlane.intent.constraints.includes("no direct db access"), true);
        assert.strictEqual(first.updatedControlPlane.execution.plans.length > 0, true);

        const second = runAbstraction(
          root,
          "bootstrap-service",
          { name: "user" },
          first.updatedControlPlane,
          controlPath,
          { workspaceRoot: root }
        );

        assert.strictEqual(
          hashConfig(controlPlaneToChoirConfig(first.updatedControlPlane)),
          hashConfig(controlPlaneToChoirConfig(second.updatedControlPlane))
        );
      },
    },
    {
      id: "2.62",
      name: "abstraction composition rejects recursive cycles",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-abstraction-recursion-"));
        fs.mkdirSync(path.join(root, ".choir"), { recursive: true });
        fs.writeFileSync(path.join(root, ".choir", "abstractions.yaml"), [
          "abstractions:",
          "  - id: first",
          "    version: 1.0.0",
          "    description: first",
          "    expandsTo:",
          "      - choir second",
          "  - id: second",
          "    version: 1.0.0",
          "    description: second",
          "    expandsTo:",
          "      - choir first",
          "",
        ].join("\n"), "utf-8");

        const controlPath = path.join(root, ".choir", "choir.config.yaml");
        assert.throws(
          () => runAbstraction(root, "first", {}, makeControlPlane(), controlPath, { workspaceRoot: root }),
          /Abstraction recursion detected/
        );
      },
    },
    {
      id: "2.63",
      name: "abstraction validation enforces macro existence",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-abstraction-macro-validation-"));
        fs.mkdirSync(path.join(root, ".choir"), { recursive: true });
        fs.writeFileSync(path.join(root, ".choir", "abstractions.yaml"), [
          "abstractions:",
          "  - id: invalid-macro-reference",
          "    version: 1.0.0",
          "    description: invalid",
          "    expandsTo:",
          "      - choir macro missing.library-macro",
          "",
        ].join("\n"), "utf-8");

        const controlPath = path.join(root, ".choir", "choir.config.yaml");
        assert.throws(
          () => runAbstraction(root, "invalid-macro-reference", {}, makeControlPlane(), controlPath, { workspaceRoot: root }),
          /Macro not found/
        );

        const described = getAbstraction(root, "invalid-macro-reference");
        assert.strictEqual(described.id, "invalid-macro-reference");
      },
    },
    {
      id: "2.64",
      name: "dsl plan approval command mutates plan status deterministically",
      run: async () => {
        assert.deepStrictEqual(
          parseCommand("choir plan approve plan-alpha").ast,
          {
            type: "plan-approve",
            planId: "plan-alpha",
          }
        );

        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-plan-approve-"));
        const controlPath = path.join(root, ".choir", "choir.config.yaml");
        fs.mkdirSync(path.dirname(controlPath), { recursive: true });

        const control = makeControlPlane();
        control.execution.plans = [
          {
            id: "plan-alpha",
            title: "alpha",
            derivedFrom: "manual",
            tasks: [
              {
                id: "task-1",
                title: "task-1",
                type: "analysis",
                dependsOn: [],
                successCriteria: ["ok"],
              },
            ],
            status: "draft",
          },
        ];

        fs.writeFileSync(controlPath, YAML.stringify(control), "utf-8");

        const compiled = compileDSLAndWrite("choir plan approve plan-alpha", control, controlPath, {
          workspaceRoot: root,
          actorId: "test-runner",
        });

        assert.strictEqual(compiled.decision, "allow");
        assert.strictEqual(compiled.changed, true);
        assert.strictEqual(
          compiled.updatedControlPlane.execution.plans.find((plan) => plan.id === "plan-alpha")?.status,
          "approved"
        );
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
    {
      id: "3.11",
      name: "state builder and validator enforce structural correctness",
      run: async () => {
        const control = makeControlPlane();
        control.intent.goals = ["A"];

        const ast = parseCommand('choir define goal "A" then plan').ast;
        const state = buildState({
          yaml: control,
          ast,
          ruleResults: [],
          plans: control.execution.plans,
          previous: createEmptyStatePlane(),
        });

        const validation = validateState(state);
        assert.strictEqual(validation.valid, true);

        const corrupted = JSON.parse(JSON.stringify(state));
        corrupted.ast = [{ id: "action:0", type: "define" }];
        corrupted.graph.dependencies = { "action:0": ["missing-node"] };

        const corruptedValidation = validateState(corrupted);
        assert.strictEqual(corruptedValidation.valid, false);
        assert.ok(corruptedValidation.issues.some((issue) => issue.code === "graph-target-missing"));
      },
    },
    {
      id: "3.12",
      name: "state consistency check catches yaml ast and rule divergences",
      run: async () => {
        const control = makeControlPlane();
        control.intent.goals = ["A"];

        const ast = parseCommand('choir define goal "A"').ast;
        const state = buildState({
          yaml: control,
          ast,
          ruleResults: [],
          plans: control.execution.plans,
          previous: createEmptyStatePlane(),
        });

        const ok = validateConsistency({
          yaml: control,
          ast,
          state,
          ruleResults: [],
        });
        assert.strictEqual(ok.valid, true);

        const divergent = JSON.parse(JSON.stringify(state));
        divergent.intent.goals = ["B"];

        const failed = validateConsistency({
          yaml: control,
          ast,
          state: divergent,
          ruleResults: [],
        });
        assert.strictEqual(failed.valid, false);
        assert.ok(failed.issues.some((issue) => issue.code === "yaml-intent-divergence"));
      },
    },
    {
      id: "3.13",
      name: "state hash is deterministic for equivalent states",
      run: async () => {
        const state = createEmptyStatePlane();
        state.intent.goals = ["A"];

        const first = hashState(state);
        const second = hashState(JSON.parse(JSON.stringify(state)));

        assert.strictEqual(first, second);
      },
    },
    {
      id: "3.14",
      name: "state snapshots are created and rollback restores exact snapshot",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-state-snapshot-"));

        try {
          const controlPath = path.join(root, ".choir", "choir.config.yaml");
          fs.mkdirSync(path.dirname(controlPath), { recursive: true });

          const control = makeControlPlane();
          fs.writeFileSync(controlPath, YAML.stringify(control), "utf-8");

          const first = compileDSLAndWrite('choir define goal "A"', control, controlPath, {
            workspaceRoot: root,
            actorId: "test-runner",
          });

          compileDSLAndWrite('choir define goal "B"', first.updatedControlPlane, controlPath, {
            workspaceRoot: root,
            actorId: "test-runner",
          });

          const snapshots = listSnapshots(root);
          assert.strictEqual(snapshots.length >= 1, true);

          const firstSnapshot = snapshots[0];
          rollbackState(root, firstSnapshot.id);

          const rolledState = readStatePlane(root);
          assert.ok(rolledState);
          assert.deepStrictEqual(rolledState?.intent, firstSnapshot.state.intent);

          const replayed = replaySnapshots(root, snapshots.slice(0, 1).map((snapshot) => snapshot.id));
          assert.strictEqual(replayed.length, 1);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      id: "3.15",
      name: "workspace timeline model records global and per-unit events",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-state-timeline-"));

        try {
          const baseline = createEmptyStatePlane();
          persistStatePlane(root, baseline, {
            action: "seed-state",
            metadata: { unitId: "packages/auth" },
          });

          const updated = {
            ...baseline,
            intent: {
              ...baseline.intent,
              goals: ["workspace-aware replay"],
            },
          };

          persistStatePlane(root, updated, {
            action: "update-intent",
            metadata: { unitId: "packages/api" },
          });

          persistStatePlane(root, updated, {
            action: "rollback:unit",
            metadata: { unitId: "packages/api" },
          });

          const global = buildGlobalTimeline(root);
          assert.strictEqual(global.events.length, 3);
          assert.strictEqual(global.events[0]?.timestamp, 1);
          assert.strictEqual(global.events[1]?.timestamp, 2);
          assert.strictEqual(global.events[2]?.timestamp, 3);
          assert.strictEqual(global.events[0]?.unitId, "packages/auth");
          assert.strictEqual(global.events[1]?.unitId, "packages/api");
          assert.strictEqual(global.events[0]?.type, "transition");
          assert.strictEqual(global.events[2]?.type, "rollback");
          assert.ok((global.events[0]?.stateHashBefore ?? "").length > 0);
          assert.ok((global.events[1]?.stateHashAfter ?? "").length > 0);

          const apiUnit = buildUnitTimeline(root, "packages/api");
          assert.strictEqual(apiUnit.events.length, 2);
          assert.strictEqual(apiUnit.events[0]?.id, global.events[1]?.id);
          assert.strictEqual(apiUnit.events[1]?.id, global.events[2]?.id);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
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
      id: "4.25",
      name: "adaptive failure analysis is deterministic and classifies extended patterns",
      run: async () => {
        const outcome: StrategyOutcome = {
          strategyId: "s-adaptive-seed",
          strategyType: "adaptive",
          plan: makePlan("plan-adaptive-failure", [
            makeTask("t-analysis", "analysis"),
            makeTask("t-refactor", "refactor", { dependsOn: ["t-analysis"], files: ["src/adaptive.ts"] }),
            makeTask("t-enforce", "enforce", { dependsOn: ["t-refactor"] }),
          ]),
          patches: [],
          diagnostics: [],
          validation: {
            passed: false,
            diagnostics: [],
            conflicts: [],
            invariantChecks: [],
            errors: ["policy denied"],
          },
          metrics: {
            filesChanged: 2,
            patchesCount: 5,
            remainingViolations: 1,
            introducedErrors: 1,
          },
          success: false,
          fileChanges: [],
          previewHash: "",
          failures: [
            { type: "dependency-ordering", unitId: "t-refactor" },
            { type: "policy-approval", unitId: "t-enforce" },
          ],
        };

        const first = analyzeFailure(outcome);
        const second = analyzeFailure(outcome);

        assert.deepStrictEqual(first, second);
        assert.ok(first.some((pattern) => pattern.type === "dependency-ordering"));
        assert.ok(first.some((pattern) => pattern.type === "policy-violation"));
        assert.ok(first.some((pattern) => pattern.type === "high-risk"));
      },
    },
    {
      id: "4.26",
      name: "adaptive cycle determinism assertion passes for identical inputs",
      run: async () => {
        const state = createEmptyStatePlane();
        state.violations = [
          {
            id: "diag-cycle-1",
            ruleId: "rule-cycle",
            message: "cycle violation",
            severity: "warning",
            category: "AST",
            location: testLocation("src/cycle.ts", 1, 0, 1, 1),
            traceId: "trace-cycle-1",
          },
        ];

        const basePlan = makePlan("plan-adaptive-cycle", [
          makeTask("t-analysis", "analysis"),
          makeTask("t-refactor", "refactor", { dependsOn: ["t-analysis"], files: ["src/cycle.ts"] }),
          makeTask("t-enforce", "enforce", { dependsOn: ["t-refactor"] }),
        ]);

        const seed = STRATEGIES.find((strategy) => strategy.id === "s-minimal") ?? STRATEGIES[0];
        assert.ok(seed);

        const result = await assertDeterministicAdaptiveCycle(seed!, basePlan, state, {
          controlPlane: makeControlPlane(),
          root: repoRoot,
        });

        assert.ok(result.outcomes.length >= 1);
        assert.ok(result.selected.strategyId.length > 0);
      },
    },
    {
      id: "4.27",
      name: "plan --adaptive integrates memory fallback and records iteration feedback",
      run: async () => {
        await withFixture("simple-project", async ({ root }) => {
          const parsed = parseCommand("choir plan --adaptive for \"goal-adaptive\"");
          assert.deepStrictEqual(parsed.ast, {
            type: "plan",
            target: "goal-adaptive",
            adaptive: true,
          });

          const control = makeControlPlane();
          const state = readStatePlane(root) ?? createEmptyStatePlane();
          const basePlan = {
            ...makePlan("plan-adaptive-memory", [
              makeTask("t-analysis", "analysis"),
              makeTask("t-refactor", "refactor", { dependsOn: ["t-analysis"], files: ["src/index.ts"] }),
              makeTask("t-enforce", "enforce", { dependsOn: ["t-refactor"] }),
            ]),
            goalRefs: ["goal-adaptive"],
          };

          const first = await adaptiveStrategySelection(basePlan, state, {
            controlPlane: control,
            root,
          });

          const signature = buildSignature(control, state);
          const feedback = first.iterations.flatMap((iteration) =>
            iteration.outcomes.map((outcome) => ({
              outcome,
              adaptive: {
                iteration: iteration.iteration,
                selected: outcome.strategyId === iteration.selectedStrategyId,
                finalSelected: outcome.strategyId === first.selected.strategyId,
              },
            }))
          );

          recordStrategies(root, signature, feedback);

          const memory = readStrategyMemory(root);
          const matches = findMatchingStrategies(signature, memory)
            .filter((entry) => entry.plan.id === "plan-adaptive-memory");

          assert.ok(matches.length >= first.outcomes.length);
          assert.ok(matches.some((entry) => entry.adaptive?.iteration !== undefined));

          const reusable = matches.filter((entry) => canReuse(entry));
          const selectedFromMemory = selectFromMemory(reusable);

          assert.ok(selectedFromMemory);
          assert.ok((selectedFromMemory?.strategyId ?? "").length > 0);
        });
      },
    },
    {
      id: "4.28",
      name: "adaptive acceptance criteria converges to valid deterministic selection",
      run: async () => {
        const state = createEmptyStatePlane();
        const basePlan = makePlan("plan-adaptive-acceptance", [
          makeTask("t-analysis", "analysis"),
          makeTask("t-enforce", "enforce", { dependsOn: ["t-analysis"] }),
        ]);

        const first = await adaptiveStrategySelection(basePlan, state, {
          controlPlane: makeControlPlane(),
          root: repoRoot,
        });
        const second = await adaptiveStrategySelection(basePlan, state, {
          controlPlane: makeControlPlane(),
          root: repoRoot,
        });

        assert.ok(first.adaptiveTrace.iterations >= 1);
        assert.ok(first.adaptiveTrace.iterations <= MAX_ADAPTIVE_ITERATIONS);
        assert.ok(first.adaptiveTrace.decisions.length > 0);

        assert.strictEqual(first.selected.strategyId, second.selected.strategyId);
        assert.deepStrictEqual(
          first.outcomes.map((outcome) => outcome.strategyId),
          second.outcomes.map((outcome) => outcome.strategyId)
        );
        assert.deepStrictEqual(
          first.adaptiveTrace.strategiesTested,
          second.adaptiveTrace.strategiesTested
        );
      },
    },
    {
      id: "4.29",
      name: "plan optimize synthesizes deterministic plans in fresh workspaces",
      run: async () => {
        await withFixture("simple-project", async ({ root, harness }) => {
          const control = harness.loadControlPlane();
          control.execution.plans = [];

          const first = await synthesizeAndOptimizePlans({
            root,
            controlPlane: control,
            command: "choir plan --optimize",
          });
          const second = await synthesizeAndOptimizePlans({
            root,
            controlPlane: control,
            command: "choir plan --optimize",
          });

          assert.strictEqual(first.selectedPlan.synthesized, true);
          assert.ok(first.candidatePlans.length > 1);
          assert.ok(first.rankedPlans.length > 0);
          assert.ok(first.stageResults.every((stage) => stage.status === "success"));
          assert.ok(first.stageResults.some((stage) => stage.stage === "candidate-synthesis"));
          assert.ok(first.stageResults.some((stage) => stage.stage === "strategy-ranking"));
          assert.ok(first.stageResults.some((stage) => stage.stage === "strategy-selection"));
          assert.ok(first.stageResults.some((stage) => stage.stage === "orchestration-build"));
          assert.ok(first.stageResults.some((stage) => stage.stage === "simulation"));
          assert.ok(first.stageResults.some((stage) => stage.stage === "replay-verification"));
          assert.strictEqual(first.selectedPlan.id, second.selectedPlan.id);
          assert.strictEqual(first.planHash, second.planHash);
          assert.strictEqual(first.simulationHash, second.simulationHash);
          assert.deepStrictEqual(first.executionStages, second.executionStages);
        });
      },
    },
    {
      id: "4.30",
      name: "plan optimize simulation hash matches execution preview hash",
      run: async () => {
        await withFixture("simple-project", async ({ root, harness }) => {
          const control = harness.loadControlPlane();
          control.execution.plans = [];

          const optimized = await synthesizeAndOptimizePlans({
            root,
            controlPlane: control,
            command: "choir plan --optimize",
          });

          const executionControl = {
            ...control,
            execution: {
              ...control.execution,
              plans: [
                {
                  ...optimized.selectedExecutionPlan,
                  status: "approved" as const,
                },
              ],
            },
          };

          const preview = await generateExecutionPreview(optimized.selectedExecutionPlan, {
            root,
            controlPlane: executionControl,
          });

          assert.strictEqual(preview.hash, optimized.simulationHash);
        });
      },
    },
    {
      id: "4.31",
      name: "plan optimize rejects deny policy candidates deterministically",
      run: async () => {
        await withFixture("simple-project", async ({ root, harness }) => {
          const control = harness.loadControlPlane();
          control.execution.plans = [];
          writePoliciesDSL(root, [
            "policy deny-plan-synthesis {",
            "  when diff.path = \"execution.plans\" and diff.operation = add then deny",
            "}",
            "",
          ].join("\n"));

          await assert.rejects(
            () => synthesizeAndOptimizePlans({
              root,
              controlPlane: control,
              command: "choir plan --optimize",
            }),
            (error: unknown) => {
              if (typeof error !== "object" || error === null) {
                return false;
              }

              const candidate = error as { failedStage?: unknown; message?: unknown };
              return candidate.failedStage === "policy-evaluation"
                && typeof candidate.message === "string"
                && candidate.message.includes("denied by policy");
            }
          );
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

const pass5: TestPass = {
  name: "Pass 5 — Distributed Synchronization",
  tests: [
    {
      id: "5.1",
      name: "replica model and logical clock operations are deterministic",
      run: async () => {
        const replica = createReplica("repo-a", { feature: { enabled: true } }, {
          version: 2,
          clock: { counter: 2, nodeId: "repo-a" },
        });

        const incremented = incrementClock(replica.clock);
        const merged = mergeClock(
          { counter: 4, nodeId: "repo-a" },
          { counter: 9, nodeId: "repo-b" },
          "repo-a"
        );

        assert.strictEqual(replica.id, "repo-a");
        assert.strictEqual(replica.version, 2);
        assert.deepStrictEqual(incremented, { counter: 3, nodeId: "repo-a" });
        assert.deepStrictEqual(merged, { counter: 10, nodeId: "repo-a" });
      },
    },
    {
      id: "5.2",
      name: "delta computation is minimal and deterministic",
      run: async () => {
        const oldState = {
          a: 1,
          b: {
            c: 2,
            d: 3,
          },
        };
        const newState = {
          a: 1,
          b: {
            c: 4,
          },
          e: true,
        };

        const first = computeDelta(oldState, newState, {
          origin: "repo-a",
          timestamp: { counter: 7, nodeId: "repo-a" },
        });
        const second = computeDelta(oldState, newState, {
          origin: "repo-a",
          timestamp: { counter: 7, nodeId: "repo-a" },
        });

        assert.deepStrictEqual(first, second);
        assert.deepStrictEqual(
          first.operations,
          [
            { type: "update", path: "b.c", value: 4 },
            { type: "remove", path: "b.d", value: null },
            { type: "add", path: "e", value: true },
          ]
        );
      },
    },
    {
      id: "5.3",
      name: "delta application records visible conflicts and resolves by logical clock",
      run: async () => {
        const local = createReplica("repo-a", { service: { owner: "team-a" } }, {
          version: 2,
          clock: { counter: 2, nodeId: "repo-a" },
          pathClocks: {
            "service.owner": { counter: 2, nodeId: "repo-a" },
          },
        });

        const changeSet = {
          id: "changeset-owner",
          origin: "repo-b",
          timestamp: { counter: 3, nodeId: "repo-b" },
          operations: [
            {
              type: "update" as const,
              path: "service.owner",
              value: "team-b",
            },
          ],
        };

        const result = applyDelta(local, changeSet);

        assert.deepStrictEqual(result.replica.state, { service: { owner: "team-b" } });
        assert.strictEqual(result.appliedOperations, 1);
        assert.strictEqual(result.conflicts.length, 1);
        assert.strictEqual(result.conflicts[0]?.resolution, "remote");
        assert.strictEqual(result.manualResolutionRequired, false);
      },
    },
    {
      id: "5.4",
      name: "state merge is commutative and deterministic",
      run: async () => {
        const left = createReplica("repo-a", {
          flags: {
            enabled: false,
          },
          stable: 1,
        }, {
          pathClocks: {
            "flags.enabled": { counter: 5, nodeId: "repo-a" },
            stable: { counter: 5, nodeId: "repo-a" },
          },
        });

        const right = createReplica("repo-b", {
          flags: {
            enabled: true,
          },
          stable: 1,
        }, {
          pathClocks: {
            "flags.enabled": { counter: 5, nodeId: "repo-b" },
            stable: { counter: 5, nodeId: "repo-b" },
          },
        });

        const mergedAB = mergeReplicaStates(left, right);
        const mergedBA = mergeReplicaStates(right, left);

        assert.deepStrictEqual(mergedAB.state, mergedBA.state);
        assert.deepStrictEqual(
          mergeStates(left.state, right.state),
          mergeStates(right.state, left.state)
        );
      },
    },
    {
      id: "5.5",
      name: "push pull and bidirectional sync modes converge deterministically",
      run: async () => {
        const pushLocal = createReplica("repo-a", { a: 1 });
        const pushRemote = createReplica("repo-b", { a: 1, b: 2 });
        const pushed = sync(pushLocal, pushRemote, { mode: "push" });

        assert.deepStrictEqual(pushed.local.state, { a: 1 });
        assert.deepStrictEqual(pushed.remote.state, { a: 1 });

        const pullLocal = createReplica("repo-a", { a: 1 });
        const pullRemote = createReplica("repo-b", { a: 1, b: 2 });
        const pulled = sync(pullLocal, pullRemote, { mode: "pull" });

        assert.deepStrictEqual(pulled.local.state, { a: 1, b: 2 });
        assert.deepStrictEqual(pulled.remote.state, { a: 1, b: 2 });

        const biLocal = createReplica<Record<string, unknown>>("repo-a", { a: 1, c: true }, {
          clock: { counter: 2, nodeId: "repo-a" },
        });
        const biRemote = createReplica<Record<string, unknown>>("repo-b", { a: 2, b: true }, {
          clock: { counter: 3, nodeId: "repo-b" },
        });
        const bidirectional = sync(biLocal, biRemote, { mode: "bidirectional" });

        assert.strictEqual(bidirectional.trace.convergenceAchieved, true);
        assert.strictEqual(validateReplicaConvergence([bidirectional.local, bidirectional.remote]), true);
      },
    },
    {
      id: "5.6",
      name: "version vectors track per-replica updates after sync",
      run: async () => {
        const left = createReplica<Record<string, unknown>>("repo-a", { x: 1 });
        const right = createReplica<Record<string, unknown>>("repo-b", { y: 2 });
        const result = sync(left, right, { mode: "bidirectional" });

        assert.ok((result.local.versionVector["repo-a"] ?? 0) > 0);
        assert.ok((result.local.versionVector["repo-b"] ?? 0) > 0);
        assert.ok((result.remote.versionVector["repo-a"] ?? 0) > 0);
        assert.ok((result.remote.versionVector["repo-b"] ?? 0) > 0);
      },
    },
    {
      id: "5.7",
      name: "signed changesets reject tampering and require manual resolution",
      run: async () => {
        const secret = "top-secret";
        const baseline = computeDelta({}, { secure: true }, {
          origin: "repo-a",
          timestamp: { counter: 1, nodeId: "repo-a" },
        });
        const signed = signChangeSet(baseline, "repo-a", secret);

        const tampered = {
          ...signed,
          operations: [{ type: "add" as const, path: "secure", value: false }],
        };

        const target = createReplica("repo-b", {});
        const applied = applyDelta(target, tampered, {
          security: {
            trustedNodeIds: ["repo-a"],
            secret,
            requireSignature: true,
          },
          signedChangeSet: tampered,
        });

        assert.deepStrictEqual(applied.replica.state, {});
        assert.strictEqual(applied.manualResolutionRequired, true);
        assert.strictEqual(applied.conflicts[0]?.reason, "security-validation-failed");
      },
    },
    {
      id: "5.8",
      name: "transport batching compression and trace helpers remain deterministic",
      run: async () => {
        const deltaA = computeDelta({}, { a: 1 }, {
          origin: "repo-a",
          timestamp: { counter: 1, nodeId: "repo-a" },
        });
        const deltaB = computeDelta({ a: 1 }, { a: 2, b: true }, {
          origin: "repo-b",
          timestamp: { counter: 2, nodeId: "repo-b" },
        });

        const transport = new InMemoryTransport();
        transport.send(deltaA);
        transport.send(deltaB);
        const received = transport.receive();

        assert.strictEqual(received.length, 2);

        const batched = batchChangeSets(received, 1);
        assert.ok(batched.length >= 2);

        const compressed = compressChangeSets(batched);
        const decompressed = decompressChangeSets(compressed);
        assert.deepStrictEqual(decompressed, batched);

        const replicaA = createReplica("repo-a", { a: 1 });
        const replicaB = createReplica("repo-b", { a: 1 });
        const trace = createSyncTrace([replicaA, replicaB], 2, 0);
        assert.strictEqual(trace.convergenceAchieved, true);
      },
    },
    {
      id: "5.9",
      name: "manual conflict strategy marks unresolved conflicts for manual resolution",
      run: async () => {
        const local = createReplica("repo-a", { rules: { owner: "team-a" } }, {
          pathClocks: {
            "rules.owner": { counter: 3, nodeId: "repo-a" },
          },
        });

        const incoming = {
          id: "changeset-manual",
          origin: "repo-b",
          timestamp: { counter: 3, nodeId: "repo-b" },
          operations: [{ type: "update" as const, path: "rules.owner", value: "team-b" }],
        };

        const applied = applyDelta(local, incoming, {
          conflictStrategy: "manual",
          mergeHandlers: {
            "rules.owner": () => MANUAL_RESOLUTION,
          },
        });

        assert.strictEqual(applied.manualResolutionRequired, true);
        assert.strictEqual(applied.appliedOperations, 0);
        assert.deepStrictEqual(applied.replica.state, { rules: { owner: "team-a" } });
      },
    },
  ],
};

const pass6: TestPass = {
  name: "Pass 6 — Global Orchestration and Org Policy Propagation",
  tests: [
    {
      id: "6.1",
      name: "global context and synthesized plan are deterministic for identical inputs",
      run: async () => {
        const cache = createGlobalPlanningCache();
        const repos: Repo[] = [
          {
            id: "repo-a",
            dependencies: [],
            state: { status: { ready: true } },
            tasks: [
              { id: "build", action: "set:status.build=done", dependsOn: [] },
            ],
          },
          {
            id: "repo-b",
            dependencies: ["repo-a"],
            state: { status: { ready: true } },
            tasks: [
              { id: "adapt", action: "adapt:api:v2", dependsOn: [] },
            ],
          },
        ];

        const orgPolicies: OrgPolicy[] = [
          {
            id: "org-base",
            rules: [
              {
                id: "deny-eval",
                kind: "deny-action-prefix",
                effect: "deny",
                actionPrefix: "eval:",
              },
            ],
          },
        ];

        const propagated = propagatePolicies(orgPolicies, repos);
        const firstContext = buildGlobalContext(repos, propagated.byRepo["repo-a"] ?? [], { cache });
        const secondContext = buildGlobalContext(repos, propagated.byRepo["repo-a"] ?? [], { cache });
        const firstPlan = synthesizeGlobalPlan(firstContext, { cache });
        const secondPlan = synthesizeGlobalPlan(secondContext, { cache });

        assert.strictEqual(firstPlan.id, secondPlan.id);
        assert.deepStrictEqual(firstPlan.tasks, secondPlan.tasks);
      },
    },
    {
      id: "6.2",
      name: "global dependency graph includes inter-repo edges and rejects repo cycles",
      run: async () => {
        const repos: Repo[] = [
          {
            id: "repo-a",
            dependencies: [],
            state: {},
            tasks: [{ id: "publish", action: "api:breaking:v2", dependsOn: [] }],
          },
          {
            id: "repo-b",
            dependencies: ["repo-a"],
            state: {},
            tasks: [{ id: "consume", action: "adapt:api:v2", dependsOn: [] }],
          },
        ];

        const graph = buildGlobalDependencyGraph(repos);
        assert.ok(
          graph.edges.some((edge) => edge.from === "repo-a:publish" && edge.to === "repo-b:consume")
        );

        assert.throws(() => buildGlobalDependencyGraph([
          { id: "repo-a", dependencies: ["repo-b"], state: {}, tasks: [{ id: "a", action: "noop", dependsOn: [] }] },
          { id: "repo-b", dependencies: ["repo-a"], state: {}, tasks: [{ id: "b", action: "noop", dependsOn: [] }] },
        ]));
      },
    },
    {
      id: "6.3",
      name: "ordered global execution is deterministic and dependency-safe",
      run: async () => {
        const repos: Repo[] = [
          {
            id: "repo-a",
            dependencies: [],
            state: {},
            tasks: [
              { id: "a1", action: "set:meta.a1=done", dependsOn: [] },
              { id: "a2", action: "set:meta.a2=done", dependsOn: ["a1"] },
            ],
          },
          {
            id: "repo-b",
            dependencies: ["repo-a"],
            state: {},
            tasks: [{ id: "b1", action: "set:meta.b1=done", dependsOn: [] }],
          },
        ];

        const context = buildGlobalContext(repos, []);
        const plan = synthesizeGlobalPlan(context);
        const orderedA = orderGlobalPlan(plan);
        const orderedB = orderGlobalPlan(plan);

        assert.deepStrictEqual(orderedA.orderedTaskIds, orderedB.orderedTaskIds);

        const index = new Map(orderedA.orderedTaskIds.map((taskId, taskIndex) => [taskId, taskIndex] as const));
        for (const task of plan.tasks) {
          for (const dep of task.dependsOn) {
            assert.ok((index.get(dep) ?? -1) < (index.get(task.id) ?? -1));
          }
        }
      },
    },
    {
      id: "6.4",
      name: "global plan validation catches missing deps and conflicting actions",
      run: async () => {
        const invalid = {
          id: "plan-invalid",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "add:feature-x", dependsOn: ["repo-a:missing"] },
            { id: "repo-a:t2", repoId: "repo-a", action: "remove:feature-x", dependsOn: [] },
          ],
        };

        const result = validateGlobalPlan(invalid);
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors.some((error) => error.includes("Missing dependency")));
        assert.ok(result.errors.some((error) => error.includes("Conflicting actions")));
      },
    },
    {
      id: "6.5",
      name: "task batching parallelizes independent work and sequences dependencies",
      run: async () => {
        const plan = {
          id: "plan-batches",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "set:x=1", dependsOn: [] },
            { id: "repo-b:t1", repoId: "repo-b", action: "set:y=1", dependsOn: [] },
            { id: "repo-c:t1", repoId: "repo-c", action: "set:z=1", dependsOn: ["repo-a:t1", "repo-b:t1"] },
          ],
        };

        const batches = batchGlobalTasks(plan);
        assert.strictEqual(batches.length, 2);
        assert.deepStrictEqual(batches[0]?.taskIds, ["repo-a:t1", "repo-b:t1"]);
        assert.deepStrictEqual(batches[1]?.taskIds, ["repo-c:t1"]);
      },
    },
    {
      id: "6.6",
      name: "org policies are propagated to all repos with no opt-out",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: {} },
          { id: "repo-b", dependencies: ["repo-a"], state: {} },
          { id: "repo-c", dependencies: [], state: {} },
        ];

        const orgPolicies: OrgPolicy[] = [
          {
            id: "org-standard",
            rules: [
              {
                id: "require-baseline",
                kind: "require-state-path",
                effect: "deny",
                path: "security.baseline",
              },
            ],
          },
        ];

        const distribution = propagatePolicies(orgPolicies, repos);
        assert.deepStrictEqual(distribution.propagation.targets, ["repo-a", "repo-b", "repo-c"]);
        assert.strictEqual(Object.keys(distribution.byRepo).length, 3);
        assert.strictEqual((distribution.byRepo["repo-b"] ?? []).length, 1);
      },
    },
    {
      id: "6.7",
      name: "cross-repo policy evaluation detects compatibility violations and blocks execution",
      run: async () => {
        const repos: Repo[] = [
          {
            id: "repo-a",
            dependencies: [],
            state: {},
            tasks: [{ id: "publish", action: "api:breaking:v2", dependsOn: [] }],
          },
          {
            id: "repo-b",
            dependencies: ["repo-a"],
            state: {},
            tasks: [{ id: "internal", action: "refactor:internal", dependsOn: [] }],
          },
        ];

        const policy = {
          id: "cross-repo-api-compat",
          kind: "cross-repo-action-compatibility" as const,
          effect: "deny" as const,
          upstreamPrefix: "api:breaking",
          downstreamPrefix: "adapt:api",
        };

        const context = buildGlobalContext(repos, [{ id: "org-policy", source: "org", rules: [policy] }]);
        const plan = synthesizeGlobalPlan(context);
        const policyResult = evaluateGlobalPolicies(plan, [policy], repos);

        assert.strictEqual(policyResult.allowed, false);
        assert.ok(policyResult.violations.some((entry) => entry.includes("repo-b depends on repo-a")));
        assert.throws(() => blockGlobalExecution(policyResult));
      },
    },
    {
      id: "6.8",
      name: "global execution isolates failure and rolls back only impacted units",
      run: async () => {
        const repos: Repo[] = [
          {
            id: "repo-a",
            dependencies: [],
            state: { value: "initial-a" },
            tasks: [{ id: "ok", action: "set:meta.synced=true", dependsOn: [] }],
          },
          {
            id: "repo-b",
            dependencies: ["repo-a"],
            state: { value: "initial-b" },
            tasks: [{ id: "fail", action: "set:meta.synced=true", dependsOn: [] }],
          },
        ];

        const context = buildGlobalContext(repos, []);
        const plan = synthesizeGlobalPlan(context);
        const result = await executeGlobalPlan(plan, {
          repos,
          policies: [],
          executeTask: async (task, state, _repoId, _allStates, mode) => {
            if (mode === "execution" && task.id === "repo-b:fail") {
              throw new Error("simulated failure");
            }

            return {
              ...state,
              appliedBy: task.id,
            };
          },
        });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.rolledBack, true);
        assert.deepStrictEqual(result.finalStates["repo-a"], {
          value: "initial-a",
          appliedBy: "repo-a:ok",
        });
        assert.deepStrictEqual(result.finalStates["repo-b"], { value: "initial-b" });
        assert.strictEqual(result.rollbackTrace?.failedUnit, "repo-b");
        assert.deepStrictEqual(result.rollbackTrace?.rollbackSet, ["repo-b"]);
      },
    },
    {
      id: "6.9",
      name: "policy drift detection flags repo states that diverge from org expectations",
      run: async () => {
        const orgPolicies: OrgPolicy[] = [
          {
            id: "org-security",
            rules: [
              {
                id: "baseline-required",
                kind: "require-state-path",
                effect: "deny",
                path: "security.baseline",
              },
            ],
          },
        ];

        const driftedRepo: Repo = {
          id: "repo-a",
          dependencies: [],
          state: { security: {} },
        };

        const compliantRepo: Repo = {
          id: "repo-b",
          dependencies: [],
          state: { security: { baseline: "v1" } },
        };

        const driftA = detectPolicyDrift(driftedRepo, orgPolicies);
        const driftB = detectPolicyDrift(compliantRepo, orgPolicies);

        assert.strictEqual(driftA.driftDetected, true);
        assert.strictEqual(driftB.driftDetected, false);
      },
    },
    {
      id: "6.10",
      name: "incremental planning cache reuses previous graph and plan for unchanged inputs",
      run: async () => {
        const cache = createGlobalPlanningCache();
        const repos: Repo[] = [
          {
            id: "repo-a",
            dependencies: [],
            state: { marker: 1 },
            tasks: [{ id: "task", action: "set:marker=2", dependsOn: [] }],
          },
        ];

        const contextA = buildGlobalContext(repos, [], { cache });
        const planA = synthesizeGlobalPlan(contextA, { cache });
        const contextB = buildGlobalContext(repos, [], { cache });
        const planB = synthesizeGlobalPlan(contextB, { cache });

        assert.strictEqual(planA.id, planB.id);
        assert.deepStrictEqual(planA.tasks, planB.tasks);

        const changedRepos: Repo[] = [
          {
            id: "repo-a",
            dependencies: [],
            state: { marker: 1 },
            tasks: [{ id: "task", action: "set:marker=3", dependsOn: [] }],
          },
        ];
        const changedContext = buildGlobalContext(changedRepos, [], { cache });
        const changedPlan = synthesizeGlobalPlan(changedContext, { cache });

        assert.notStrictEqual(changedPlan.id, planA.id);
      },
    },
    {
      id: "6.10a",
      name: "global simulation is deterministic and does not mutate repo input state",
      run: async () => {
        const repos: Repo[] = [
          {
            id: "repo-a",
            dependencies: [],
            state: { meta: { value: "a0" } },
          },
          {
            id: "repo-b",
            dependencies: ["repo-a"],
            state: { meta: { value: "b0" } },
          },
        ];

        const plan = {
          id: "sim-plan-1",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=a1", dependsOn: [] },
            { id: "repo-b:t1", repoId: "repo-b", action: "set:meta.value=b1", dependsOn: ["repo-a:t1"] },
          ],
        };

        const before = JSON.parse(JSON.stringify(repos));
        const first = await simulatePlan(plan, { repos, policies: [] });
        const second = await simulatePlan(plan, { repos, policies: [] });

        assert.strictEqual(first.success, true);
        assert.deepStrictEqual(first.finalState, second.finalState);
        assert.deepStrictEqual(first.trace.stepsExecuted, second.trace.stepsExecuted);
        assert.deepStrictEqual(repos, before);
      },
    },
    {
      id: "6.10b",
      name: "strategy comparison ranks deterministic outcomes by real simulated metrics",
      run: async () => {
        const repos: Repo[] = [
          {
            id: "repo-a",
            dependencies: [],
            state: { meta: { value: "a0" } },
          },
        ];

        const safePlan = {
          id: "strategy-safe",
          tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=a1", dependsOn: [] }],
        };

        const riskyPlan = {
          id: "strategy-risky",
          tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "danger:mutate", dependsOn: [] }],
        };

        const result = await compareStrategies([riskyPlan, safePlan], {
          repos,
          policies: [{
            id: "org-deny-danger",
            source: "org",
            rules: [{
              id: "deny-danger",
              kind: "deny-action-prefix",
              effect: "deny",
              actionPrefix: "danger:",
            }],
          }],
        });

        assert.strictEqual(result.bestStrategy, "strategy-safe");
        assert.strictEqual(result.metrics.violations, 0);
      },
    },
    {
      id: "6.10c",
      name: "partial simulation includes selected units and required dependencies only",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: {} },
          { id: "repo-b", dependencies: ["repo-a"], state: {} },
          { id: "repo-c", dependencies: [], state: {} },
        ];

        const plan = {
          id: "sim-partial",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "set:meta.a=1", dependsOn: [] },
            { id: "repo-b:t1", repoId: "repo-b", action: "set:meta.b=1", dependsOn: ["repo-a:t1"] },
            { id: "repo-c:t1", repoId: "repo-c", action: "set:meta.c=1", dependsOn: [] },
          ],
        };

        const result = await simulateUnits(["repo-b"], plan, { repos, policies: [] });
        assert.deepStrictEqual(result.trace.stepsExecuted, ["repo-a:t1", "repo-b:t1"]);
        assert.deepStrictEqual(result.trace.unitsAffected, ["repo-a", "repo-b"]);
      },
    },
    {
      id: "6.10d",
      name: "execution is blocked when simulation gate fails",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: {} },
        ];

        const plan = {
          id: "sim-gate-fail",
          tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "set:meta.a=1", dependsOn: [] }],
        };

        const result = await executeGlobalPlan(plan, {
          repos,
          policies: [],
          validateState: () => false,
        });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.rolledBack, false);
        assert.ok(result.audit.violations.some((entry) => entry.includes("simulation gate")));
      },
    },
    {
      id: "6.10e",
      name: "simulation and execution converge to identical final state",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: { meta: { a: "0" } } },
          { id: "repo-b", dependencies: ["repo-a"], state: { meta: { b: "0" } } },
        ];

        const plan = {
          id: "sim-eq",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "set:meta.a=1", dependsOn: [] },
            { id: "repo-b:t1", repoId: "repo-b", action: "set:meta.b=1", dependsOn: ["repo-a:t1"] },
          ],
        };

        const simulated = await simulatePlan(plan, { repos, policies: [] });
        const executed = await executeGlobalPlan(plan, { repos, policies: [] });

        assert.strictEqual(simulated.success, true);
        assert.strictEqual(executed.success, true);
        assert.deepStrictEqual(executed.finalStates, simulated.finalState);
      },
    },
    {
      id: "6.10f",
      name: "strategy comparison tie-break is deterministic by lexical strategy id",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: {} },
        ];

        const alphaPlan = {
          id: "strategy-alpha",
          tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] }],
        };

        const betaPlan = {
          id: "strategy-beta",
          tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] }],
        };

        const comparison = await compareStrategies([betaPlan, alphaPlan], {
          repos,
          policies: [],
        });

        assert.strictEqual(comparison.bestStrategy, "strategy-alpha");
        assert.deepStrictEqual(comparison.metrics, {
          risk: 1,
          changes: 1,
          violations: 0,
        });
      },
    },
    {
      id: "6.10g",
      name: "execution fails closed when simulation and execution outcomes diverge",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: { meta: { value: "0" } } },
        ];

        const plan = {
          id: "sim-divergence",
          tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] }],
        };

        const modeCalls: Array<"simulation" | "execution"> = [];
        const result = await executeGlobalPlan(plan, {
          repos,
          policies: [],
          executeTask: async (_task, state, _repoId, _allStates, mode) => {
            modeCalls.push(mode);

            return mode === "simulation"
              ? { ...state, meta: { value: "sim" } }
              : { ...state, meta: { value: "exec" } };
          },
        });

        assert.deepStrictEqual(modeCalls, ["simulation", "execution", "simulation"]);
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.rolledBack, true);
        assert.ok(result.audit.violations.some((entry) =>
          entry.includes("Simulation and execution diverged")
          || entry.includes("Simulation divergence:")
        ));
      },
    },
    {
      id: "6.10ga",
      name: "integrity gate aborts execute before transaction on state tampering",
      run: async () => {
        await withFixture("simple-project", async ({ root, harness }) => {
          const control = harness.loadControlPlane();

          await runOrchestrationPipeline("preview", {
            root,
            controlPlane: control,
            command: "choir preview",
          });

          const statePath = path.join(root, ".choir", "state.json");
          const tampered = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Record<string, unknown>;
          tampered.execution = {
            ...(typeof tampered.execution === "object" && tampered.execution !== null ? tampered.execution as Record<string, unknown> : {}),
            activePlanId: "tampered-active-plan",
          };
          fs.writeFileSync(statePath, `${JSON.stringify(tampered, null, 2)}\n`, "utf-8");

          let failedStage = "";
          let errorMessage = "";
          let stageResults: Array<{ stage: string; status: "success" | "failure" }> = [];
          try {
            await runOrchestrationPipeline("execute", {
              root,
              controlPlane: control,
              command: "choir execute",
            });
          } catch (error) {
            if (error instanceof OrchestrationPipelineError) {
              failedStage = error.failedStage;
              errorMessage = error.message;
              stageResults = error.stageResults.map((stage) => ({ stage: stage.stage, status: stage.status }));
            }
          }

          assert.strictEqual(failedStage, "integrity");
          assert.ok(/STATE_SNAPSHOT_INVALID|STATE_SNAPSHOT_MISMATCH|PREVIEW_HASH_MISMATCH/.test(errorMessage));
          assert.strictEqual(stageResults.some((stage) => stage.stage === "execution" && stage.status === "success"), false);
        });
      },
    },
    {
      id: "6.10gb",
      name: "integrity gate aborts execute on orchestration DAG artifact corruption",
      run: async () => {
        await withFixture("simple-project", async ({ root, harness }) => {
          const control = harness.loadControlPlane();

          await runOrchestrationPipeline("preview", {
            root,
            controlPlane: control,
            command: "choir preview",
          });

          const latestTracePath = path.join(root, ".choir", "traces", "orchestration", "latest.json");
          const latest = JSON.parse(fs.readFileSync(latestTracePath, "utf-8")) as Record<string, unknown>;
          const modeMetadata = (typeof latest.modeMetadata === "object" && latest.modeMetadata !== null)
            ? latest.modeMetadata as Record<string, unknown>
            : {};
          const integrity = (typeof modeMetadata.integrity === "object" && modeMetadata.integrity !== null)
            ? modeMetadata.integrity as Record<string, unknown>
            : {};
          integrity.orchestrationHash = "deadbeef";
          modeMetadata.integrity = integrity;
          latest.modeMetadata = modeMetadata;
          fs.writeFileSync(latestTracePath, `${JSON.stringify(latest, null, 2)}\n`, "utf-8");

          let failedStage = "";
          let errorMessage = "";
          try {
            await runOrchestrationPipeline("execute", {
              root,
              controlPlane: control,
              command: "choir execute",
            });
          } catch (error) {
            if (error instanceof OrchestrationPipelineError) {
              failedStage = error.failedStage;
              errorMessage = error.message;
            }
          }

          assert.strictEqual(failedStage, "integrity");
          assert.ok(/DAG_HASH_MISMATCH|ORCHESTRATION_HASH_MISMATCH/.test(errorMessage));
        });
      },
    },
    {
      id: "6.10gc",
      name: "integrity gate aborts execute when inputs diverge after preview simulation",
      run: async () => {
        await withFixture("simple-project", async ({ root, harness }) => {
          const control = harness.loadControlPlane();

          await runOrchestrationPipeline("preview", {
            root,
            controlPlane: control,
            command: "choir preview",
          });

          const controlPath = path.join(root, ".choir", "choir.config.yaml");
          const parsed = YAML.parse(fs.readFileSync(controlPath, "utf-8")) as Record<string, unknown>;
          const intent = (typeof parsed.intent === "object" && parsed.intent !== null)
            ? parsed.intent as Record<string, unknown>
            : {};
          const goals = Array.isArray(intent.goals) ? intent.goals.slice() : [];
          goals.push("after-preview-input-change");
          intent.goals = goals;
          parsed.intent = intent;
          fs.writeFileSync(controlPath, YAML.stringify(parsed), "utf-8");
          const mutatedControl = harness.loadControlPlane();

          let failedStage = "";
          let errorMessage = "";
          try {
            await runOrchestrationPipeline("execute", {
              root,
              controlPlane: mutatedControl,
              command: "choir execute",
            });
          } catch (error) {
            if (error instanceof OrchestrationPipelineError) {
              failedStage = error.failedStage;
              errorMessage = error.message;
            }
          }

          assert.strictEqual(failedStage, "integrity");
          assert.ok(/STALE_SIMULATION_ARTIFACT|PREVIEW_HASH_MISMATCH|SIMULATION_EXECUTION_PARITY_MISMATCH/.test(errorMessage));
        });
      },
    },
    {
      id: "6.10h",
      name: "strategy evaluation simulates all candidates deterministically",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: { meta: { value: "0" } } },
        ];

        const evaluated = await evaluateGlobalStrategies([
          {
            id: "strategy-beta",
            plan: {
              id: "plan-beta",
              tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=2", dependsOn: [] }],
            },
          },
          {
            id: "strategy-alpha",
            plan: {
              id: "plan-alpha",
              tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] }],
            },
          },
        ], {
          repos,
          policies: [],
        });

        assert.deepStrictEqual(evaluated.map((entry) => entry.strategyId), ["strategy-alpha", "strategy-beta"]);
        assert.strictEqual(evaluated.every((entry) => entry.result.trace.stepsExecuted.length === 1), true);
      },
    },
    {
      id: "6.10i",
      name: "strategy metrics comparator enforces lexicographic priority and deterministic score",
      run: async () => {
        assert.strictEqual(compareStrategyMetricsLex(
          { violations: 0, risk: 5, changes: 1, executionCost: 3 },
          { violations: 1, risk: 0, changes: 0, executionCost: 0 }
        ) < 0, true);

        assert.strictEqual(compareStrategyMetricsLex(
          { violations: 0, risk: 2, changes: 5, executionCost: 8 },
          { violations: 0, risk: 3, changes: 0, executionCost: 0 }
        ) < 0, true);

        assert.strictEqual(compareStrategyMetricsLex(
          { violations: 0, risk: 2, changes: 2, executionCost: 4 },
          { violations: 0, risk: 2, changes: 2, executionCost: 5 }
        ) < 0, true);

        assert.strictEqual(
          computeStrategyScore(
            { violations: 0, risk: 2, changes: 3, executionCost: 4 },
            { risk: 5, changes: 2, executionCost: 1 }
          ),
          20
        );
      },
    },
    {
      id: "6.10j",
      name: "strategy selection filters violations by default and emits explainable decision",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: {} },
        ];

        const strategies = [
          {
            id: "strategy-safe",
            plan: {
              id: "plan-safe",
              tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] }],
            },
          },
          {
            id: "strategy-risky",
            plan: {
              id: "plan-risky",
              tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "danger:mutate", dependsOn: [] }],
            },
          },
        ];

        const selection = await selectBestStrategy(strategies, {
          repos,
          policies: [{
            id: "org-deny-danger",
            source: "org",
            rules: [{
              id: "deny-danger",
              kind: "deny-action-prefix",
              effect: "deny",
              actionPrefix: "danger:",
            }],
          }],
        });

        assert.strictEqual(selection.selected.strategyId, "strategy-safe");
        assert.strictEqual(selection.trace.strategiesEvaluated, 2);
        assert.strictEqual(selection.trace.strategiesRejected, 1);
        assert.ok(selection.decision.reason.includes("lexicographic priority"));
        assert.ok(selection.decision.reason.includes("rejected strategies with violations: 1"));

        await assert.rejects(
          selectBestStrategy([
            {
              id: "strategy-a",
              plan: {
                id: "plan-a",
                tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "danger:a", dependsOn: [] }],
              },
            },
            {
              id: "strategy-b",
              plan: {
                id: "plan-b",
                tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "danger:b", dependsOn: [] }],
              },
            },
          ], {
            repos,
            policies: [{
              id: "org-deny-danger-all",
              source: "org",
              rules: [{
                id: "deny-danger-all",
                kind: "deny-action-prefix",
                effect: "deny",
                actionPrefix: "danger:",
              }],
            }],
          }),
          /No valid strategies/
        );

        const allowViolationsSelection = await selectBestStrategy([
          {
            id: "strategy-beta",
            plan: {
              id: "plan-beta",
              tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "danger:beta", dependsOn: [] }],
            },
          },
          {
            id: "strategy-alpha",
            plan: {
              id: "plan-alpha",
              tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "danger:alpha", dependsOn: [] }],
            },
          },
        ], {
          repos,
          policies: [{
            id: "org-deny-danger-allow",
            source: "org",
            rules: [{
              id: "deny-danger-allow",
              kind: "deny-action-prefix",
              effect: "deny",
              actionPrefix: "danger:",
            }],
          }],
        }, {
          allowViolations: true,
        });

        assert.strictEqual(allowViolationsSelection.selected.strategyId, "strategy-alpha");
      },
    },
    {
      id: "6.10k",
      name: "rollout stage generation is deterministic across canary phased and batched strategies",
      run: async () => {
        const plan = {
          id: "rollout-stages",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "set:meta.a=1", dependsOn: [] },
            { id: "repo-b:t1", repoId: "repo-b", action: "set:meta.b=1", dependsOn: ["repo-a:t1"] },
            { id: "repo-c:t1", repoId: "repo-c", action: "set:meta.c=1", dependsOn: ["repo-b:t1"] },
            { id: "repo-d:t1", repoId: "repo-d", action: "set:meta.d=1", dependsOn: ["repo-a:t1"] },
          ],
        };

        const canary: RolloutStrategy = { type: "canary", initialPercent: 1, steps: [10, 50, 100] };
        const phased: RolloutStrategy = { type: "phased", phases: [25, 50, 100] };
        const batched: RolloutStrategy = { type: "batched", batchSize: 2 };

        const canaryFirst = buildStages(plan, canary);
        const canarySecond = buildStages(plan, canary);
        assert.deepStrictEqual(canaryFirst, canarySecond);

        const phasedStages = buildStages(plan, phased);
        const batchedStages = buildStages(plan, batched);
        assert.ok(phasedStages.length >= 2);
        assert.ok(batchedStages.length >= 2);

        const completedUnits: string[] = [];
        for (const stage of canaryFirst) {
          const dependencyValidation = respectDependencies(stage, plan, completedUnits);
          assert.strictEqual(dependencyValidation.valid, true);
          completedUnits.push(...stage.units);
        }
      },
    },
    {
      id: "6.10l",
      name: "rollout stops on stage failure and rolls back affected stage units",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: { meta: { value: "0" } } },
          { id: "repo-b", dependencies: ["repo-a"], state: { meta: { value: "0" } } },
        ];

        const plan = {
          id: "rollout-failure",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] },
            { id: "repo-b:t1", repoId: "repo-b", action: "set:meta.value=1", dependsOn: ["repo-a:t1"] },
          ],
        };

        const result = await executeRolloutPlan(plan, {
          repos,
          policies: [],
          executeTask: async (_task, state, repoId, _allStates, mode) => {
            if (mode === "execution" && repoId === "repo-b") {
              throw new Error("stage-b failure");
            }

            return { ...state, meta: { value: "1" } };
          },
        }, {
          type: "batched",
          batchSize: 1,
        }, {
          autoRollback: true,
        });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.stopped, true);
        assert.strictEqual(result.rolledBack, true);
        assert.strictEqual(result.trace.completedStages.length, 1);
        assert.ok(typeof result.trace.failedStage === "string");
        assert.strictEqual((result.finalStates["repo-a"] as { meta?: { value?: string } }).meta?.value, "1");
        assert.strictEqual((result.finalStates["repo-b"] as { meta?: { value?: string } }).meta?.value, "0");
      },
    },
    {
      id: "6.10m",
      name: "rollout threshold gates stop progression deterministically",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: { meta: { value: "0" } } },
          { id: "repo-b", dependencies: [], state: { meta: { value: "0" } } },
        ];

        const plan = {
          id: "rollout-threshold",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] },
            { id: "repo-b:t1", repoId: "repo-b", action: "set:meta.value=1", dependsOn: [] },
          ],
        };

        const result = await executeRolloutPlan(plan, {
          repos,
          policies: [],
        }, {
          type: "batched",
          batchSize: 1,
        }, {
          thresholds: {
            errorRate: 1,
            latency: 0,
          },
          autoRollback: true,
        });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.trace.completedStages.length, 0);
        assert.ok(result.failures.some((entry) => entry.includes("latency threshold")));
      },
    },
    {
      id: "6.10n",
      name: "rollout requires approval gate before execution when configured",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: { meta: { value: "0" } } },
        ];

        const plan = {
          id: "rollout-approval",
          tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] }],
        };

        const result = await executeRolloutPlan(plan, {
          repos,
          policies: [],
        }, {
          type: "all-at-once",
        }, {
          requireApproval: () => false,
        });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.trace.completedStages.length, 0);
        assert.ok(result.failures.some((entry) => entry.includes("approval required")));
      },
    },
    {
      id: "6.10o",
      name: "rollout fails closed and rolls back all units on simulation divergence",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: { meta: { value: "0" } } },
        ];

        const plan = {
          id: "rollout-divergence",
          tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] }],
        };

        const result = await executeRolloutPlan(plan, {
          repos,
          policies: [],
          executeTask: async (_task, state, _repoId, _allStates, mode) => mode === "simulation"
            ? { ...state, meta: { value: "sim" } }
            : { ...state, meta: { value: "exec" } },
        }, {
          type: "all-at-once",
        });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.rolledBack, true);
        assert.ok(result.failures.some((entry) =>
          entry.includes("diverged")
          || entry.includes("Simulation divergence:")
          || entry.includes("simulation mismatch")
        ));
        assert.strictEqual((result.finalStates["repo-a"] as { meta?: { value?: string } }).meta?.value, "0");
      },
    },
    {
      id: "6.10p",
      name: "rollback set includes failed unit and executed dependents only",
      run: async () => {
        const plan = {
          id: "rollback-set",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "set:meta.a=1", dependsOn: [] },
            { id: "repo-b:t1", repoId: "repo-b", action: "set:meta.b=1", dependsOn: ["repo-a:t1"] },
            { id: "repo-c:t1", repoId: "repo-c", action: "set:meta.c=1", dependsOn: ["repo-a:t1"] },
          ],
        };

        const graph = buildRollbackDependencyGraph(plan);
        const rollbackSet = computeRollbackSet("repo-a", graph, {
          units: {
            "repo-a": "failed",
            "repo-b": "executed",
            "repo-c": "pending",
          },
        });

        assert.deepStrictEqual(rollbackSet, ["repo-a", "repo-b"]);
      },
    },
    {
      id: "6.10q",
      name: "rollback order is reverse dependency order and deterministic",
      run: async () => {
        const plan = {
          id: "rollback-order",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "set:meta.a=1", dependsOn: [] },
            { id: "repo-b:t1", repoId: "repo-b", action: "set:meta.b=1", dependsOn: ["repo-a:t1"] },
            { id: "repo-c:t1", repoId: "repo-c", action: "set:meta.c=1", dependsOn: ["repo-b:t1"] },
          ],
        };

        const graph = buildRollbackDependencyGraph(plan);
        const ordered = orderRollback(["repo-a", "repo-b", "repo-c"], graph);
        assert.deepStrictEqual(ordered, ["repo-c", "repo-b", "repo-a"]);
      },
    },
    {
      id: "6.10r",
      name: "rollback isolation and post-rollback consistency checks fail closed",
      run: async () => {
        const plan = {
          id: "rollback-validate",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "set:meta.a=1", dependsOn: [] },
            { id: "repo-b:t1", repoId: "repo-b", action: "set:meta.b=1", dependsOn: ["repo-a:t1"] },
          ],
        };

        const graph = buildRollbackDependencyGraph(plan);
        const isolation = validateIsolation(["repo-a", "repo-z"], graph, "repo-a");
        assert.strictEqual(isolation.valid, false);

        const post = validatePostRollback({
          "repo-a": {},
          "repo-b": {},
        }, graph, {
          units: {
            "repo-a": "rolled-back",
            "repo-b": "executed",
          },
        }, [
          { id: "repo-a", dependencies: [], state: {} },
          { id: "repo-b", dependencies: ["repo-a"], state: {} },
        ]);
        assert.strictEqual(post.valid, false);
        assert.ok(post.errors.some((entry) => entry.includes("dependency violation")));
      },
    },
    {
      id: "6.10s",
      name: "transaction abort prevents stage partial state leakage",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: { meta: { value: "0" } } },
          { id: "repo-b", dependencies: [], state: { meta: { value: "0" } } },
        ];

        const plan = {
          id: "transaction-stage-abort",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] },
            { id: "repo-b:t1", repoId: "repo-b", action: "set:meta.value=1", dependsOn: [] },
          ],
        };

        const result = await executeTransaction(plan, {
          repos,
          policies: [],
          executeTask: async (task, state) => {
            if (task.repoId === "repo-b") {
              throw new Error("boom:stage");
            }

            return { ...state, meta: { value: "1" } };
          },
        });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.transaction.status, "aborted");
        assert.strictEqual((result.finalState["repo-a"] as { meta?: { value?: string } }).meta?.value, "0");
        assert.strictEqual((result.finalState["repo-b"] as { meta?: { value?: string } }).meta?.value, "0");
        assert.deepStrictEqual(result.trace.stagesExecuted, []);
      },
    },
    {
      id: "6.10t",
      name: "transaction trace id and stage sequence are deterministic",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: { meta: { value: "0" } } },
          { id: "repo-b", dependencies: ["repo-a"], state: { meta: { value: "0" } } },
        ];

        const plan = {
          id: "transaction-deterministic-trace",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] },
            { id: "repo-b:t1", repoId: "repo-b", action: "set:meta.value=1", dependsOn: ["repo-a:t1"] },
          ],
        };

        const first = await executeTransaction(plan, {
          repos,
          policies: [],
        });

        const second = await executeTransaction(plan, {
          repos,
          policies: [],
        });

        assert.strictEqual(first.success, true);
        assert.strictEqual(second.success, true);
        assert.strictEqual(first.trace.transactionId, second.trace.transactionId);
        assert.deepStrictEqual(first.trace.stagesExecuted, second.trace.stagesExecuted);
      },
    },
    {
      id: "6.10u",
      name: "transaction lock conflicts fail closed with deterministic error",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: { meta: { value: "0" } } },
        ];

        const plan = {
          id: "transaction-lock-conflict",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] },
          ],
        };

        let releaseFirst: (() => void) | undefined;
        let firstTaskEntered: (() => void) | undefined;
        const firstTaskGate = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const firstTaskStarted = new Promise<void>((resolve) => {
          firstTaskEntered = resolve;
        });

        const first = executeTransaction(plan, {
          repos,
          policies: [],
          executeTask: async (_task, state) => {
            firstTaskEntered?.();
            await firstTaskGate;
            return { ...state, meta: { value: "1" } };
          },
        });

        await firstTaskStarted;

        const second = await executeTransaction(plan, {
          repos,
          policies: [],
        });

        releaseFirst?.();
        const firstResult = await first;

        assert.strictEqual(firstResult.success, true);
        assert.strictEqual(second.success, false);
        assert.ok(second.violations.some((entry) => entry.includes("Lock conflict")));
      },
    },
    {
      id: "6.10v",
      name: "deterministic input hash and trace are stable for identical input",
      run: async () => {
        const plan = {
          id: "deterministic-input",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] },
            { id: "repo-b:t1", repoId: "repo-b", action: "set:meta.value=2", dependsOn: ["repo-a:t1"] },
          ],
        };

        const state = {
          "repo-a": { meta: { value: "0" } },
          "repo-b": { meta: { value: "0" } },
        };

        const input = {
          plan,
          state,
          policies: [],
          dependencyGraph: buildRollbackDependencyGraph(plan),
        };

        const hashA = hashInput(input);
        const hashB = hashInput(input);
        const traceA = await executeDeterministic(input);
        const traceB = await executeDeterministic(input);

        assert.strictEqual(hashA, hashB);
        assert.strictEqual(traceA.traceId, traceB.traceId);
        assert.strictEqual(traceA.finalStateHash, traceB.finalStateHash);
        assert.strictEqual(validateTrace(traceA), true);
        assert.strictEqual(verifyReplay(traceA), true);
      },
    },
    {
      id: "6.10w",
      name: "transaction deterministic trace replays to exact final state hash",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: { meta: { value: "0" } } },
          { id: "repo-b", dependencies: ["repo-a"], state: { meta: { value: "0" } } },
        ];

        const plan = {
          id: "transaction-replay-verification",
          tasks: [
            { id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] },
            { id: "repo-b:t1", repoId: "repo-b", action: "set:meta.value=2", dependsOn: ["repo-a:t1"] },
          ],
        };

        const result = await executeTransaction(plan, {
          repos,
          policies: [],
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.deterministicTrace.deterministic, true);
        const replayed = replay(result.deterministicTrace);
        assert.strictEqual(hashGlobalState(replayed), result.deterministicTrace.finalStateHash);
      },
    },
    {
      id: "6.10x",
      name: "simulation and execution deterministic hashes converge",
      run: async () => {
        const repos: Repo[] = [
          { id: "repo-a", dependencies: [], state: { meta: { value: "0" } } },
        ];

        const plan = {
          id: "simulation-execution-hash-convergence",
          tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] }],
        };

        const simulation = await simulatePlan(plan, {
          repos,
          policies: [],
        });

        const execution = await executeGlobalPlan(plan, {
          repos,
          policies: [],
        });

        assert.strictEqual(simulation.success, true);
        assert.strictEqual(execution.success, true);
        assert.ok(simulation.trace.deterministicTrace);
        assert.ok(execution.trace.deterministicTrace);
        assert.strictEqual(
          simulation.trace.deterministicTrace?.finalStateHash,
          execution.trace.deterministicTrace?.finalStateHash
        );
      },
    },
    {
      id: "6.10y",
      name: "deterministic sort is stable and ordered",
      run: async () => {
        assert.deepStrictEqual(deterministicSort(["repo-b", "repo-a", "repo-b"]), ["repo-a", "repo-b", "repo-b"]);
      },
    },
    {
      id: "6.10z",
      name: "transaction lifecycle enforces prepare-validate-commit ordering",
      run: async () => {
        const ctx = beginTransaction({
          "repo-a": { meta: { value: "0" } },
        }, [], undefined, "test-lifecycle-plan");

        assert.strictEqual(ctx.transaction.status, "pending");

        const prepared = preparePhase(ctx);
        assert.strictEqual(prepared.valid, true);
        assert.strictEqual(ctx.transaction.status, "prepared");

        applyChange(ctx, {
          unitId: "repo-a",
          nextState: { meta: { value: "1" } },
          type: "set",
        });

        let blocked = false;
        try {
          commitPhase(ctx);
        } catch {
          blocked = true;
        }
        assert.strictEqual(blocked, true);

        const validated = validatePhase(ctx, {
          repos: [{ id: "repo-a", dependencies: [], state: { meta: { value: "0" } } }],
          graph: buildRollbackDependencyGraph({
            id: "test-lifecycle-plan",
            tasks: [{ id: "repo-a:t1", repoId: "repo-a", action: "set:meta.value=1", dependsOn: [] }],
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

        assert.strictEqual(validated.valid, true);
        assert.strictEqual(ctx.transaction.status, "validated");

        commitPhase(ctx);
        assert.strictEqual(ctx.transaction.status, "committed");
        assert.strictEqual(ctx.transitions.length, 1);
      },
    },
    {
      id: "6.10aa",
      name: "idempotency guard suppresses duplicate deterministic changes",
      run: async () => {
        const ctx = beginTransaction({
          "repo-a": { meta: { value: "0" } },
        }, [], undefined, "test-idempotency-plan");

        const prepared = preparePhase(ctx);
        assert.strictEqual(prepared.valid, true);

        const change = {
          unitId: "repo-a",
          nextState: { meta: { value: "9" } },
          type: "set",
        };

        assertIdempotent(change);
        applyChange(ctx, change);
        applyChange(ctx, change);

        assert.strictEqual(ctx.transitions.length, 1);
        assert.strictEqual(hashGlobalState(ctx.workingState), hashGlobalState({
          "repo-a": { meta: { value: "9" } },
        }));
      },
    },
    {
      id: "6.11",
      name: "workspace detection reads pnpm workspace config with deterministic package ordering",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-workspace-pnpm-"));

        try {
          fs.writeFileSync(
            path.join(root, "pnpm-workspace.yaml"),
            [
              "packages:",
              "  - \"packages/*\"",
              "  - \"apps/*\"",
            ].join("\n"),
            "utf-8"
          );

          for (const packageDir of ["packages/api", "packages/zeta", "apps/web"]) {
            fs.mkdirSync(path.join(root, packageDir), { recursive: true });
            fs.writeFileSync(path.join(root, packageDir, "package.json"), "{}", "utf-8");
          }

          const detected = detectWorkspace(root);
          assert.strictEqual(detected.type, "pnpm");
          assert.deepStrictEqual(detected.packages, ["apps/web", "packages/api", "packages/zeta"]);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      id: "6.12",
      name: "workspace detection prioritizes turbo marker over package manager hints",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-workspace-turbo-"));

        try {
          fs.writeFileSync(path.join(root, "turbo.json"), "{}", "utf-8");
          fs.writeFileSync(path.join(root, "yarn.lock"), "", "utf-8");
          fs.writeFileSync(
            path.join(root, "package.json"),
            JSON.stringify({ workspaces: ["packages/*"], packageManager: "yarn@4.1.1" }),
            "utf-8"
          );

          for (const packageDir of ["packages/b", "packages/a"]) {
            fs.mkdirSync(path.join(root, packageDir), { recursive: true });
            fs.writeFileSync(path.join(root, packageDir, "package.json"), "{}", "utf-8");
          }

          const detected = detectWorkspace(root);
          assert.strictEqual(detected.type, "turbo");
          assert.deepStrictEqual(detected.packages, ["packages/a", "packages/b"]);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      id: "6.13",
      name: "workspace detection supports nx defaults and remains deterministic",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-workspace-nx-"));

        try {
          fs.writeFileSync(path.join(root, "nx.json"), "{}", "utf-8");

          for (const packageDir of ["libs/core", "apps/site", "packages/tooling"]) {
            fs.mkdirSync(path.join(root, packageDir), { recursive: true });
            fs.writeFileSync(path.join(root, packageDir, "package.json"), "{}", "utf-8");
          }

          const first = detectWorkspace(root);
          const second = detectWorkspace(root);

          assert.strictEqual(first.type, "nx");
          assert.deepStrictEqual(first.packages, ["apps/site", "libs/core", "packages/tooling"]);
          assert.deepStrictEqual(first, second);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      id: "6.14",
      name: "workspace detection reads package.json workspaces and deduplicates overlaps",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-workspace-npm-"));

        try {
          fs.writeFileSync(
            path.join(root, "package.json"),
            JSON.stringify({
              workspaces: {
                packages: ["packages/*", "packages/a"],
              },
            }),
            "utf-8"
          );

          for (const packageDir of ["packages/b", "packages/a"]) {
            fs.mkdirSync(path.join(root, packageDir), { recursive: true });
            fs.writeFileSync(path.join(root, packageDir, "package.json"), "{}", "utf-8");
          }

          const detected = detectWorkspace(root);
          assert.strictEqual(detected.type, "npm");
          assert.deepStrictEqual(detected.packages, ["packages/a", "packages/b"]);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      id: "6.15",
      name: "dependency graph transform to UI graph is deterministic and sorted",
      run: async () => {
        const ui = toUIGraph({
          nodes: [
            { id: "unit:packages/b", type: "unit", label: "b" },
            { id: "unit:packages/a", type: "unit", label: "a" },
          ],
          edges: [
            { from: "unit:packages/b", to: "unit:packages/a", type: "depends-on" },
          ],
        });

        assert.deepStrictEqual(ui.nodes.map((node) => node.id), ["unit:packages/a", "unit:packages/b"]);
        assert.deepStrictEqual(ui.edges.map((edge) => edge.id), ["edge:unit:packages/b->unit:packages/a"]);
      },
    },
    {
      id: "6.16",
      name: "graph snapshot is deterministic and projects plan/violation overlays",
      run: async () => {
        const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-graph-snapshot-"));

        try {
          fs.writeFileSync(
            path.join(root, "package.json"),
            JSON.stringify({
              workspaces: ["packages/*"],
            }),
            "utf-8"
          );

          fs.mkdirSync(path.join(root, "packages/a/src"), { recursive: true });
          fs.mkdirSync(path.join(root, "packages/b/src"), { recursive: true });

          fs.writeFileSync(
            path.join(root, "packages/a/package.json"),
            JSON.stringify({ name: "pkg-a" }),
            "utf-8"
          );
          fs.writeFileSync(
            path.join(root, "packages/b/package.json"),
            JSON.stringify({ name: "pkg-b", dependencies: { "pkg-a": "workspace:*" } }),
            "utf-8"
          );

          const control = makeControlPlane();
          control.execution.plans = [
            {
              id: "p-graph",
              title: "graph",
              derivedFrom: "goal",
              goalRefs: ["g"],
              tasks: [
                makeTask("t-a", "refactor", { files: ["packages/a/src/a.ts"] }),
                makeTask("t-b", "refactor", { files: ["packages/b/src/b.ts"], dependsOn: ["t-a"] }),
              ],
              status: "approved",
            },
          ];

          const state = createEmptyStatePlane();
          state.execution.activePlanId = "p-graph";
          state.execution.taskStatus = {
            "p-graph:t-b": "complete",
          };
          state.violations = [
            {
              id: "diag-graph-1",
              ruleId: "rule.graph",
              message: "violation",
              severity: "warning",
              location: testLocation("packages/b/src/b.ts", 1, 0, 1, 1),
              category: "pattern",
              traceId: "trace-graph-1",
            },
          ];

          const first = buildGraphSnapshot({
            root,
            control,
            state,
            mode: "full",
          });
          const second = buildGraphSnapshot({
            root,
            control,
            state,
            mode: "full",
          });

          assert.deepStrictEqual(first.graph.nodes.map((node) => node.id), ["unit:packages/a", "unit:packages/b"]);
          assert.deepStrictEqual(first.graph.edges.map((edge) => edge.id), ["edge:unit:packages/b->unit:packages/a"]);
          assert.ok(first.planOverlay);
          assert.deepStrictEqual(first.violationNodeIds, ["unit:packages/b"]);
          assert.deepStrictEqual(first.changedNodeIds, ["unit:packages/b"]);

          assert.deepStrictEqual(first.graph, second.graph);
          assert.deepStrictEqual(first.changedNodeIds, second.changedNodeIds);
          assert.deepStrictEqual(first.affectedNodeIds, second.affectedNodeIds);
          assert.deepStrictEqual(first.violationNodeIds, second.violationNodeIds);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      id: "6.17",
      name: "graph DSL commands parse into deterministic graph AST",
      run: async () => {
        const parsed = parseCommand("choir graph dependencies \"unit:packages/b\"");
        assert.strictEqual(parsed.ast.type, "graph");
        if (parsed.ast.type !== "graph") {
          return;
        }

        assert.strictEqual(parsed.ast.mode, "dependency");
        assert.strictEqual(parsed.ast.nodeId, "unit:packages/b");
      },
    },
    {
      id: "6.18",
      name: "verification harness case runner validates deterministic replay simulation and rollback",
      run: async () => {
        const result = await runVerificationCase(deterministicCase);
        assert.strictEqual(result.passed, true);
        assert.strictEqual(result.actual.deterministic, true);
        assert.strictEqual(result.actual.replayMatches, true);
        assert.strictEqual(result.actual.simulationMatches, true);
        assert.strictEqual(result.actual.rollbackSafe, true);
      },
    },
    {
      id: "6.19",
      name: "verification harness full run is deterministic and report formatting is stable",
      run: async () => {
        const suite = createVerificationSuite("quick");
        const first = await runFullVerification({
          mode: "quick",
          suite,
          throwOnFailure: false,
          detectFlakiness: true,
          flakeRuns: 2,
        });

        const second = await runFullVerification({
          mode: "quick",
          suite,
          throwOnFailure: false,
          detectFlakiness: true,
          flakeRuns: 2,
        });

        assert.strictEqual(first.passed, true);
        assert.strictEqual(second.passed, true);
        assert.strictEqual(await checkDeterminism(deterministicCase.input), true);
        assert.deepStrictEqual(first.metrics, second.metrics);
        assert.strictEqual(formatVerificationReport(first), formatVerificationReport(second));
      },
    },
    {
      id: "6.20",
      name: "property-based harness is deterministic with fixed seed and stable report",
      run: async () => {
        setSeed(424242);
        const first = await runPropertyTest(4, {
          seed: 424242,
          throwOnFailure: false,
        });
        const second = await runPropertyTest(4, {
          seed: 424242,
          throwOnFailure: false,
        });

        assert.strictEqual(first.failures, 0);
        assert.strictEqual(second.failures, 0);
        assert.strictEqual(formatChaosTestReport(first), formatChaosTestReport(second));
      },
    },
    {
      id: "6.21",
      name: "chaos harness mode is deterministic and reports invariant set",
      run: async () => {
        setSeed(515151);
        const first = await runChaosTest("light", 3, {
          seed: 515151,
          throwOnFailure: false,
        });
        const second = await runChaosTest("light", 3, {
          seed: 515151,
          throwOnFailure: false,
        });

        assert.deepStrictEqual(first.invariantsBroken, second.invariantsBroken);
        assert.strictEqual(first.mode, "light");
        assert.strictEqual(second.mode, "light");
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
  const passes: TestPass[] = [pass1, pass2, pass3, pass4, pass5, pass6, finalPass];

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
