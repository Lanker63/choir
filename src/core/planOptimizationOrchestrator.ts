import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { parseAST } from "../ast/parser.js";
import { ControlPlane, ControlPlaneSchema, Plan, Task } from "../schema.js";
import { buildContext, buildWorkspaceSnapshot } from "./context.js";
import {
  CompilerPipelineError,
  compileInput,
  formatCompilerErrors,
} from "./compilerPipeline.js";
import { scorePlan } from "./costPlanner.js";
import { controlPlaneToChoirConfig } from "./dslYamlCompiler.js";
import {
  SimulatedPlanOutcome,
  simulatePlanOutcome,
} from "./executionPreview.js";
import {
  generatePlan,
} from "./orchestration.js";
import { estimateDependencyDepth } from "./costPlanner.js";
import {
  computeDiff,
  detectEnvironment,
  evaluatePolicies,
  ExecutionContext,
  hashDiff,
} from "./policyEngine.js";
import { loadPolicies } from "./policyDsl.js";
import { runPipeline } from "./pipeline.js";
import { buildExecutionPlan } from "./scheduler.js";
import {
  createEmptyStatePlane,
  hashState,
  materializeStatePlane,
  readStatePlane,
  StatePlane,
} from "./state.js";
import { appendPipelineDiagnosticsRecordIfPossible, type PipelineDiagnosticsSource } from "./pipelineDiagnostics.js";
import {
  groupedStrategy,
  layeredStrategy,
  minimalStrategy,
} from "./strategyPlanner.js";
import { detectWorkspace, WorkspaceConfig } from "./workspaceDetection.js";
import {
  readPlanningTrace,
  writePlanningTrace,
  type PlanningTraceRecord,
} from "./planningTrace.js";
import { isNonNull } from "../utils/guards.js";
import { cloneJson } from "../utils/clone.js";

export type ExecutionStrategy =
  | "minimal-change"
  | "low-risk"
  | "dependency-safe"
  | "parallel-optimized"
  | "rollback-minimized";

export type PlanningStageName =
  | "compile"
  | "structure-validation"
  | "semantic-validation"
  | "cross-node-validation"
  | "candidate-synthesis"
  | "strategy-ranking"
  | "strategy-selection"
  | "orchestration-build"
  | "simulation"
  | "replay-verification"
  | "policy-evaluation"
  | "load-control-plane"
  | "workspace-analysis";

export type PlanningStageResult = {
  stage: PlanningStageName;
  status: "success" | "failure";
  detail: string;
};

export type WorkspaceModuleBoundary = {
  id: string;
  packagePath: string;
  files: string[];
};

export type WorkspaceOwnershipBoundary = {
  owner: string;
  files: string[];
};

export type WorkspaceGraph = {
  root: string;
  workspaceType: WorkspaceConfig["type"];
  packages: string[];
  packageDependencies: Record<string, string[]>;
  dependencyGraph: Record<string, string[]>;
  moduleBoundaries: WorkspaceModuleBoundary[];
  ownershipBoundaries: WorkspaceOwnershipBoundary[];
  orchestrationUnits: string[];
  diagnosticsCount: number;
  filesAnalyzed: number;
  graphHash: string;
  state: StatePlane;
};

export type OptimizationStage = {
  id: string;
  order: number;
  parallelizable: boolean;
  units: string[];
};

export type OptimizationUnit = {
  id: string;
  files: string[];
  taskIds: string[];
};

export type RollbackScope = {
  unitIds: string[];
  stageIds: string[];
  complexity: number;
};

export type PolicyDecision = "allow" | "require-approval" | "deny";

export type DAG = {
  nodes: string[];
  edges: Array<{
    from: string;
    to: string;
  }>;
  hash: string;
};

export type CandidatePlan = {
  id: string;
  strategyType: ExecutionStrategy;
  strategyId: ExecutionStrategy;
  orchestrationGraph: DAG;
  rollbackScope: RollbackScope;
  stages: OptimizationStage[];
  units: OptimizationUnit[];
  riskScore: number;
  estimatedCost: number;
  changeCount: number;
  synthesized: boolean;
};

export type RankedCandidate = CandidatePlan & {
  rank: number;
  policyDecision: PolicyDecision;
  policyViolations: number;
  dependencyRisk: number;
  blastRadius: number;
  rollbackComplexity: number;
  executionCost: number;
  changeCount: number;
  previewHash: string;
  diffHash: string;
  requiresApproval: boolean;
  selected?: boolean;
};

export type RankedPlan = RankedCandidate;
export type OptimizedPlan = CandidatePlan;

export type PlanDiff = {
  riskDelta: number;
  rollbackDelta: number;
  graphDelta: number;
  blastRadiusDelta: number;
  changedUnits: string[];
  rollbackComplexityDelta: number;
  executionDurationDelta: number;
};

export type OptimizationUIModel = {
  strategyComparison: {
    candidateId: string;
    strategyType: ExecutionStrategy;
    rank: number;
    riskScore: number;
    rollbackComplexity: number;
    blastRadius: number;
    dependencyRisk: number;
    executionCost: number;
    changeCount: number;
    orchestrationDagHash: string;
    selected: boolean;
    estimatedCost: number;
    policyDecision: PolicyDecision;
  }[];
  planComparisons: Array<{
    candidateId: string;
    versus: string;
    diff: PlanDiff;
  }>;
  dependencyGraph: Record<string, string[]>;
  timeline: string[];
  controlCenter: {
    selectedPlanId: string;
    selectedStrategyType: ExecutionStrategy;
    simulationHash: string;
    policyDecision: PolicyDecision;
  };
};

export type OptimizedPlanResult = {
  selectedPlan: OptimizedPlan;
  selectedExecutionPlan: Plan;
  planHash: string;
  simulationHash: string;
  executionStages: OptimizationStage[];
  rollbackScope: RollbackScope;
  orchestrationDagHash: string;
  policyDecision: PolicyDecision;
  candidatePlans: CandidatePlan[];
  rankedPlans: RankedPlan[];
  stageResults: PlanningStageResult[];
  trace: PlanningTraceRecord;
  ui: OptimizationUIModel;
};

export type SynthesizeAndOptimizePlansOptions = {
  root: string;
  command: string;
  targetGoal?: string;
  controlPlane?: ControlPlane;
  diagnosticsSource?: PipelineDiagnosticsSource;
  persistArtifacts?: boolean;
  replayTraceId?: string;
};

export class PlanOptimizationError extends Error {
  readonly failedStage: PlanningStageName;
  readonly stageResults: PlanningStageResult[];

  constructor(input: {
    failedStage: PlanningStageName;
    message: string;
    stageResults: PlanningStageResult[];
  }) {
    super(input.message);
    this.name = "PlanOptimizationError";
    this.failedStage = input.failedStage;
    this.stageResults = input.stageResults;
  }
}

export type CandidateExecutionPlan = {
  candidate: CandidatePlan;
  plan: Plan;
  strategyId: ExecutionStrategy;
};

type EvaluatedCandidatePlan = {
  ranked: RankedCandidate;
  simulation: SimulatedPlanOutcome;
};

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function toStableRelativePath(root: string, filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    return normalizePath(filePath);
  }

  const relative = normalizePath(path.relative(root, filePath));
  if (relative.startsWith("../") || relative === "..") {
    return normalizePath(filePath);
  }

  return relative;
}

function clonePlan(plan: Plan): Plan {
  return cloneJson(plan);
}

function loadControlPlane(root: string): ControlPlane {
  const controlPath = path.join(root, ".choir", "choir.config.yaml");
  if (!fs.existsSync(controlPath)) {
    throw new Error(`Control plane not found: ${controlPath}`);
  }

  const raw = fs.readFileSync(controlPath, "utf-8");
  return ControlPlaneSchema.parse(YAML.parse(raw));
}

function mergeExecutionPlan(control: ControlPlane, plan: Plan): ControlPlane {
  const approvedPlan: Plan = {
    ...plan,
    status: "approved",
  };

  const plans = [
    ...control.execution.plans.filter((entry) => entry.id !== approvedPlan.id),
    approvedPlan,
  ].sort((left, right) => left.id.localeCompare(right.id));

  return {
    ...control,
    execution: {
      ...control.execution,
      plans,
    },
  };
}

function mapFailureStage(error: CompilerPipelineError): PlanningStageName {
  const first = error.errors[0];
  if (!first) {
    return "structure-validation";
  }

  if (first.stage === "semantic") {
    return "semantic-validation";
  }

  if (first.stage === "cross-node") {
    return "cross-node-validation";
  }

  return "structure-validation";
}

function packageNameForPath(root: string, packagePath: string): string {
  const packageJsonPath = path.join(root, packagePath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return packagePath;
  }

  try {
    const raw = fs.readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim().length > 0
      ? parsed.name.trim()
      : packagePath;
  } catch {
    return packagePath;
  }
}

function packageDependencies(root: string, workspace: WorkspaceConfig): Record<string, string[]> {
  const packageByName = new Map<string, string>();
  for (const packagePath of workspace.packages) {
    const packageName = packageNameForPath(root, packagePath);
    packageByName.set(packageName, packagePath);
  }

  const dependencyMap = new Map<string, string[]>();
  for (const packagePath of workspace.packages) {
    const packageJsonPath = path.join(root, packagePath, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      dependencyMap.set(packagePath, []);
      continue;
    }

    let dependencies: string[] = [];
    try {
      const raw = fs.readFileSync(packageJsonPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const records = [
        parsed.dependencies,
        parsed.devDependencies,
        parsed.peerDependencies,
        parsed.optionalDependencies,
      ];

      const names = records.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return [];
        }

        return Object.keys(entry as Record<string, unknown>);
      });

      dependencies = sortedUnique(names
        .map((name) => packageByName.get(name))
        .filter((entry): entry is string => typeof entry === "string")
        .filter((entry) => entry !== packagePath));
    } catch {
      dependencies = [];
    }

    dependencyMap.set(packagePath, dependencies);
  }

  return Object.fromEntries([...dependencyMap.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function ownershipFromDependencyGraph(
  dependencyGraph: Record<string, string[]>
): WorkspaceOwnershipBoundary[] {
  const owners = new Map<string, string[]>();

  for (const file of Object.keys(dependencyGraph).sort((left, right) => left.localeCompare(right))) {
    const normalized = normalizePath(file);
    const topLevel = normalized.split("/").filter((entry) => entry.length > 0)[0] ?? "workspace";
    const bucket = owners.get(topLevel) ?? [];
    bucket.push(normalized);
    owners.set(topLevel, bucket);
  }

  return [...owners.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([owner, files]) => ({
      owner,
      files: sortedUnique(files),
    }));
}

function moduleBoundaries(
  root: string,
  workspace: WorkspaceConfig,
  dependencyGraph: Record<string, string[]>
): WorkspaceModuleBoundary[] {
  const files = Object.keys(dependencyGraph).map((file) => normalizePath(file));
  const modules = workspace.packages.map((packagePath) => {
    const normalizedPackagePath = normalizePath(packagePath);
    const packageFiles = files
      .filter((file) => {
        if (normalizedPackagePath === ".") {
          return true;
        }

        return file === normalizedPackagePath || file.startsWith(`${normalizedPackagePath}/`);
      })
      .map((file) => toStableRelativePath(root, file));

    return {
      id: `module:${normalizedPackagePath}`,
      packagePath: normalizedPackagePath,
      files: sortedUnique(packageFiles),
    } satisfies WorkspaceModuleBoundary;
  });

  return modules.sort((left, right) => left.id.localeCompare(right.id));
}

function withDeterministicPlanId(plan: Plan, strategyId: ExecutionStrategy): Plan {
  const normalizedTasks = [...plan.tasks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((task) => ({
      id: task.id,
      type: task.type,
      files: sortedUnique((task.scope?.files ?? []).map((file) => normalizePath(file))),
      dependsOn: sortedUnique(task.dependsOn ?? []),
      successCriteria: sortedUnique(task.successCriteria),
    }));

  const id = `plan-${createHash("sha256")
    .update(JSON.stringify({
      baseId: plan.id,
      strategyId,
      tasks: normalizedTasks,
    }))
    .digest("hex")
    .slice(0, 12)}`;

  return {
    ...clonePlan(plan),
    id,
  };
}

function refactorTasks(plan: Plan): Task[] {
  return [...plan.tasks]
    .filter((task) => task.type === "refactor")
    .sort((left, right) => left.id.localeCompare(right.id));
}

function parallelOptimizedStrategy(basePlan: Plan): Plan {
  const next = clonePlan(basePlan);
  const refactorIds = new Set(refactorTasks(next).map((task) => task.id));

  const tasks = next.tasks.map((task) => {
    if (task.type !== "refactor") {
      return task;
    }

    const dependencies = sortedUnique((task.dependsOn ?? [])
      .filter((dependencyId) => !refactorIds.has(dependencyId)));

    return {
      ...task,
      dependsOn: dependencies,
    };
  });

  return {
    ...next,
    tasks,
  };
}

function rollbackMinimizedStrategy(basePlan: Plan): Plan {
  const next = clonePlan(basePlan);
  const refactors = refactorTasks(next);
  const previousRefactor = new Map<string, string>();

  for (let index = 1; index < refactors.length; index += 1) {
    previousRefactor.set(refactors[index]!.id, refactors[index - 1]!.id);
  }

  const tasks = next.tasks.map((task) => {
    if (task.type !== "refactor") {
      return task;
    }

    const previousId = previousRefactor.get(task.id);
    if (!previousId) {
      return task;
    }

    return {
      ...task,
      dependsOn: sortedUnique([...(task.dependsOn ?? []), previousId]),
    };
  });

  return {
    ...next,
    tasks,
  };
}

function strategyTransforms(): Array<{ strategyId: ExecutionStrategy; transform: (plan: Plan, state: StatePlane) => Plan }> {
  return [
    { strategyId: "minimal-change", transform: (plan, state) => minimalStrategy(plan, state) },
    { strategyId: "low-risk", transform: (plan, state) => groupedStrategy(plan, state) },
    { strategyId: "dependency-safe", transform: (plan, state) => layeredStrategy(plan, state) },
    { strategyId: "parallel-optimized", transform: (plan) => parallelOptimizedStrategy(plan) },
    { strategyId: "rollback-minimized", transform: (plan) => rollbackMinimizedStrategy(plan) },
  ];
}

function toExecutionStages(plan: Plan): OptimizationStage[] {
  const built = buildExecutionPlan([plan]);

  return [...built.executionPlan.batches]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((batch, index) => ({
      id: batch.id,
      order: index + 1,
      parallelizable: batch.parallelizable,
      units: sortedUnique(batch.workUnits.map((unit) => unit.id)),
    }));
}

function toOptimizationUnits(plan: Plan): OptimizationUnit[] {
  const units = plan.tasks.map((task) => ({
    id: `unit:${task.id}`,
    files: sortedUnique((task.scope?.files ?? []).map((file) => normalizePath(file))),
    taskIds: [task.id],
  }));

  return units.sort((left, right) => left.id.localeCompare(right.id));
}

function deriveRollbackScopeFrom(stages: OptimizationStage[], units: OptimizationUnit[]): RollbackScope {
  return {
    unitIds: sortedUnique(units.map((unit) => unit.id)),
    stageIds: sortedUnique(stages.map((stage) => stage.id)),
    complexity: stages.length + units.length,
  };
}

function buildOrchestrationGraph(plan: Plan): DAG {
  const nodes = sortedUnique(plan.tasks.map((task) => task.id));
  const edges = plan.tasks
    .flatMap((task) => (task.dependsOn ?? []).map((dependencyId) => ({
      from: dependencyId,
      to: task.id,
    })))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));

  return {
    nodes,
    edges,
    hash: stableHash({ nodes, edges }),
  };
}

function estimateCandidateRisk(plan: Plan, state: StatePlane, stages: OptimizationStage[], units: OptimizationUnit[]): number {
  const dependencyRisk = estimateDependencyDepth(plan, state);
  const tasks = plan.tasks.length;
  return dependencyRisk + stages.length + units.length + tasks;
}

function rankingSort(left: RankedCandidate, right: RankedCandidate): number {
  return left.policyViolations - right.policyViolations
    || left.rollbackComplexity - right.rollbackComplexity
    || left.blastRadius - right.blastRadius
    || left.dependencyRisk - right.dependencyRisk
    || left.executionCost - right.executionCost
    || left.changeCount - right.changeCount
    || left.id.localeCompare(right.id);
}

function failPlanning(
  stage: PlanningStageName,
  detail: string,
  stageResults: PlanningStageResult[]
): never {
  throw new PlanOptimizationError({
    failedStage: stage,
    message: detail,
    stageResults,
  });
}

function targetControl(controlPlane: ControlPlane, targetGoal?: string): ControlPlane {
  if (!targetGoal || targetGoal.trim().length === 0) {
    return controlPlane;
  }

  return {
    ...controlPlane,
    intent: {
      ...controlPlane.intent,
      goals: [targetGoal.trim()],
    },
  };
}

export async function analyzeWorkspace(root: string, controlPlane: ControlPlane): Promise<WorkspaceGraph> {
  const workspace = detectWorkspace(root);
  const snapshot = buildWorkspaceSnapshot(root);
  const parsed = parseAST(buildContext(snapshot));

  const normalizedDependencyGraph = Object.fromEntries(
    Object.entries(parsed.dependencyGraph)
      .map(([file, deps]) => [
        toStableRelativePath(root, file),
        sortedUnique(deps.map((dep) => normalizePath(dep))),
      ] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );

  const pipeline = await runPipeline({
    controlPlane,
    workspace: snapshot,
    persistState: false,
  });

  const planningState = materializeStatePlane({
    ...(readStatePlane(root) ?? createEmptyStatePlane()),
    intent: {
      goals: [...controlPlane.intent.goals],
      constraints: [...controlPlane.intent.constraints],
      nonGoals: [...controlPlane.intent["non-goals"]],
    },
    dependencyGraph: normalizedDependencyGraph,
    violations: [...pipeline.diagnostics],
    metrics: {
      ...(readStatePlane(root)?.metrics ?? createEmptyStatePlane().metrics),
      filesScanned: snapshot.files.length,
      diagnostics: pipeline.diagnostics.length,
    },
  });

  const graphHash = stableHash({
    workspaceType: workspace.type,
    packages: [...workspace.packages].sort((left, right) => left.localeCompare(right)),
    dependencyGraph: normalizedDependencyGraph,
  });

  return {
    root,
    workspaceType: workspace.type,
    packages: [...workspace.packages].sort((left, right) => left.localeCompare(right)),
    packageDependencies: packageDependencies(root, workspace),
    dependencyGraph: normalizedDependencyGraph,
    moduleBoundaries: moduleBoundaries(root, workspace, normalizedDependencyGraph),
    ownershipBoundaries: ownershipFromDependencyGraph(normalizedDependencyGraph),
    orchestrationUnits: sortedUnique((workspace.packages.length > 0 ? workspace.packages : ["."]).map((pkg) => `unit:${normalizePath(pkg)}`)),
    diagnosticsCount: pipeline.diagnostics.length,
    filesAnalyzed: snapshot.files.length,
    graphHash,
    state: planningState,
  };
}

export function generateCandidatePlans(
  controlPlane: ControlPlane,
  graph: WorkspaceGraph,
  targetGoal?: string
): CandidateExecutionPlan[] {
  const deterministicControl = targetControl(controlPlane, targetGoal);
  const baseSynthesized = generatePlan(deterministicControl, graph.state);
  const configuredPlans = [...controlPlane.execution.plans]
    .sort((left, right) => left.id.localeCompare(right.id))
    .filter((plan) => {
      if (!targetGoal) {
        return true;
      }

      return (plan.goalRefs ?? []).includes(targetGoal);
    });

  const basePlans = configuredPlans.length > 0
    ? configuredPlans
    : [baseSynthesized];

  const candidates: CandidateExecutionPlan[] = [];
  for (const basePlan of basePlans) {
    for (const strategy of strategyTransforms()) {
      const transformed = strategy.transform(basePlan, graph.state);
      const withId = withDeterministicPlanId(transformed, strategy.strategyId);

      const stages = toExecutionStages(withId);
      const units = toOptimizationUnits(withId);
      const rollbackScope = deriveRollbackScopeFrom(stages, units);
      const orchestrationGraph = buildOrchestrationGraph(withId);
      const estimatedCost = scorePlan(withId, graph.state).totalCost;
      const changeCount = withId.tasks.reduce((total, task) => total + (task.scope?.files?.length ?? 0), 0);
      const riskScore = estimateCandidateRisk(withId, graph.state, stages, units);

      candidates.push({
        candidate: {
          id: withId.id,
          strategyType: strategy.strategyId,
          strategyId: strategy.strategyId,
          orchestrationGraph,
          rollbackScope,
          stages,
          units,
          riskScore,
          estimatedCost,
          changeCount,
          synthesized: true,
        },
        plan: withId,
        strategyId: strategy.strategyId,
      });
    }
  }

  const byKey = new Map<string, CandidateExecutionPlan>();
  for (const candidate of candidates) {
    const key = stableHash({
      id: candidate.candidate.id,
      strategy: candidate.candidate.strategyType,
      tasks: candidate.plan.tasks,
    });

    if (!byKey.has(key)) {
      byKey.set(key, candidate);
    }
  }

  return [...byKey.values()].sort((left, right) =>
    left.candidate.strategyType.localeCompare(right.candidate.strategyType)
    || left.candidate.id.localeCompare(right.candidate.id));
}

export function synthesizeCandidatePlans(input: {
  controlPlane: ControlPlane;
  graph: WorkspaceGraph;
  targetGoal?: string;
}): CandidatePlan[] {
  return generateCandidatePlans(input.controlPlane, input.graph, input.targetGoal)
    .map((entry) => entry.candidate);
}

export function rankCandidatePlans(candidates: RankedCandidate[]): RankedCandidate[] {
  return [...candidates]
    .sort(rankingSort)
    .map((plan, index) => ({
      ...plan,
      rank: index + 1,
    }));
}

function optimizePlans(plans: RankedPlan[]): RankedPlan[] {
  return rankCandidatePlans(plans);
}

export function selectBestCandidate(rankedPlans: RankedCandidate[]): RankedCandidate {
  if (rankedPlans.length === 0) {
    throw new Error("No ranked plans available for deterministic selection.");
  }

  return [...rankedPlans].sort(rankingSort)[0] as RankedCandidate;
}

function selectBestPlan(rankedPlans: RankedPlan[]): RankedPlan {
  return selectBestCandidate(rankedPlans);
}

export function diffPlans(left: RankedPlan, right: RankedPlan): PlanDiff {
  const leftUnits = new Set(left.units.map((unit) => unit.id));
  const rightUnits = new Set(right.units.map((unit) => unit.id));
  const changedUnits = sortedUnique([
    ...[...leftUnits].filter((unit) => !rightUnits.has(unit)),
    ...[...rightUnits].filter((unit) => !leftUnits.has(unit)),
  ]);

  return {
    riskDelta: right.riskScore - left.riskScore,
    rollbackDelta: right.rollbackComplexity - left.rollbackComplexity,
    graphDelta: (
      right.orchestrationGraph.nodes.length + right.orchestrationGraph.edges.length
    ) - (
      left.orchestrationGraph.nodes.length + left.orchestrationGraph.edges.length
    ),
    blastRadiusDelta: right.blastRadius - left.blastRadius,
    changedUnits,
    rollbackComplexityDelta: right.rollbackComplexity - left.rollbackComplexity,
    executionDurationDelta: right.executionCost - left.executionCost,
  };
}

async function evaluateCandidatePlan(
  root: string,
  controlPlane: ControlPlane,
  graph: WorkspaceGraph,
  candidate: CandidateExecutionPlan
): Promise<EvaluatedCandidatePlan | null> {
  const executionControl = mergeExecutionPlan(controlPlane, candidate.plan);
  const simulation = await simulatePlanOutcome(candidate.plan, {
    root,
    controlPlane: executionControl,
    state: graph.state,
  });

  const policySet = loadPolicies(root, detectEnvironment());
  const context: ExecutionContext = {
    role: "conductor",
    environment: detectEnvironment(),
  };
  const diffs = computeDiff(
    controlPlaneToChoirConfig(controlPlane),
    controlPlaneToChoirConfig(executionControl)
  );
  const policyEvaluation = evaluatePolicies(diffs, policySet, context);
  const decision = policyEvaluation.trace.decision;

  if (decision === "deny") {
    return null;
  }

  const stages = candidate.candidate.stages;
  const units = candidate.candidate.units;
  const cost = scorePlan(candidate.plan, graph.state).totalCost;
  const dependencyRisk = estimateDependencyDepth(candidate.plan, graph.state);
  const blastRadius = simulation.metrics.filesChanged;
  const rollbackComplexity = stages.length + units.length;
  const changeCount = simulation.metrics.patchesCount;
  const riskScore = dependencyRisk
    + simulation.metrics.introducedErrors
    + simulation.metrics.remainingViolations
    + blastRadius;

  return {
    ranked: {
      ...candidate.candidate,
      strategyType: candidate.strategyId,
      strategyId: candidate.strategyId,
      riskScore,
      estimatedCost: cost,
      changeCount,
      rank: 0,
      policyDecision: decision,
      policyViolations: policyEvaluation.result.violations.length,
      dependencyRisk,
      blastRadius,
      rollbackComplexity,
      executionCost: cost,
      previewHash: simulation.previewHash,
      diffHash: hashDiff(diffs),
      requiresApproval: policyEvaluation.result.requiresApproval,
    },
    simulation,
  };
}

function rankingFingerprint(rankedPlans: RankedPlan[]): string {
  return stableHash(rankedPlans.map((plan) => ({
    id: plan.id,
    strategyType: plan.strategyType,
    rank: plan.rank,
    policyViolations: plan.policyViolations,
    rollbackComplexity: plan.rollbackComplexity,
    blastRadius: plan.blastRadius,
    dependencyRisk: plan.dependencyRisk,
    executionCost: plan.executionCost,
    changeCount: plan.changeCount,
  })));
}

function buildUIModel(selected: RankedPlan, rankedPlans: RankedPlan[], workspace: WorkspaceGraph): OptimizationUIModel {
  const planComparisons = rankedPlans
    .filter((plan) => plan.id !== selected.id)
    .map((plan) => ({
      candidateId: selected.id,
      versus: plan.id,
      diff: diffPlans(selected, plan),
    }));

  return {
    strategyComparison: rankedPlans.map((plan) => ({
      candidateId: plan.id,
      strategyType: plan.strategyType,
      rank: plan.rank,
      riskScore: plan.riskScore,
      rollbackComplexity: plan.rollbackComplexity,
      blastRadius: plan.blastRadius,
      dependencyRisk: plan.dependencyRisk,
      executionCost: plan.executionCost,
      changeCount: plan.changeCount,
      orchestrationDagHash: plan.orchestrationGraph.hash,
      selected: plan.id === selected.id,
      estimatedCost: plan.estimatedCost,
      policyDecision: plan.policyDecision,
    })),
    planComparisons,
    dependencyGraph: workspace.dependencyGraph,
    timeline: selected.stages.map((stage) => `${stage.order}. ${stage.id} [${stage.units.join(",")}]`),
    controlCenter: {
      selectedPlanId: selected.id,
      selectedStrategyType: selected.strategyType,
      simulationHash: selected.previewHash,
      policyDecision: selected.policyDecision,
    },
  };
}

export async function synthesizeAndOptimizePlans(options: SynthesizeAndOptimizePlansOptions): Promise<OptimizedPlanResult> {
  const diagnosticsSource = options.diagnosticsSource ?? "chat";
  const persistArtifacts = options.persistArtifacts !== false;
  const stageResults: PlanningStageResult[] = [];
  let synthesizedCandidates: CandidatePlan[] = [];
  let rankedCandidates: RankedPlan[] = [];
  const markSuccess = (stage: PlanningStageName, detail: string): void => {
    stageResults.push({ stage, status: "success", detail });
  };
  const fail = (stage: PlanningStageName, detail: string): never => {
    stageResults.push({ stage, status: "failure", detail });

    appendPipelineDiagnosticsRecordIfPossible(options.root, {
      command: options.command,
      source: diagnosticsSource,
      category: "planning",
      result: "failure",
      summary: `Planning failed at ${stage}: ${detail}`,
      stages: stageResults,
      metadata: {
        failedStage: stage,
        synthesizedCandidates: synthesizedCandidates.length,
        rankedCandidates: rankedCandidates.length,
      },
    });

    return failPlanning(stage, detail, stageResults);
  };

  let controlPlane: ControlPlane;
  try {
    controlPlane = options.controlPlane ?? loadControlPlane(options.root);
    markSuccess("load-control-plane", "Control plane loaded for planning pipeline.");
  } catch (error) {
    if (error instanceof PlanOptimizationError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    return fail("load-control-plane", message);
  }

  try {
    compileInput(options.command, controlPlane);
    markSuccess("compile", "Compiler pipeline invoked for planning command.");
    markSuccess("structure-validation", "Compiler validation gates passed.");
    markSuccess("semantic-validation", "Semantic validation passed.");
    markSuccess("cross-node-validation", "Cross-node validation passed.");
  } catch (error) {
    if (error instanceof PlanOptimizationError) {
      throw error;
    }

    if (error instanceof CompilerPipelineError) {
      const stage = mapFailureStage(error);
      return fail(stage, formatCompilerErrors(error.errors));
    }

    const message = error instanceof Error ? error.message : String(error);
    return fail("structure-validation", message);
  }

  let workspaceGraph: WorkspaceGraph;
  try {
    workspaceGraph = await analyzeWorkspace(options.root, controlPlane);
    markSuccess("orchestration-build", `Workspace graph synthesized (hash=${workspaceGraph.graphHash.slice(0, 12)}).`);
  } catch (error) {
    if (error instanceof PlanOptimizationError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    return fail("orchestration-build", message);
  }

  let candidatePlans: CandidateExecutionPlan[];
  try {
    candidatePlans = generateCandidatePlans(controlPlane, workspaceGraph, options.targetGoal);
    if (candidatePlans.length === 0) {
      return fail("candidate-synthesis", "No candidate plans synthesized from current intent.");
    }

    synthesizedCandidates = candidatePlans.map((candidate) => candidate.candidate);
    markSuccess("candidate-synthesis", `Synthesized ${candidatePlans.length} candidate plan(s).`);
  } catch (error) {
    if (error instanceof PlanOptimizationError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    return fail("candidate-synthesis", message);
  }

  let evaluatedCandidates: EvaluatedCandidatePlan[];
  try {
    const evaluated = await Promise.all(candidatePlans.map((candidate) =>
      evaluateCandidatePlan(options.root, controlPlane, workspaceGraph, candidate)
    ));

    evaluatedCandidates = evaluated.filter(isNonNull);
    if (evaluatedCandidates.length === 0) {
      return fail("policy-evaluation", "All synthesized plans were denied by policy.");
    }

    markSuccess("policy-evaluation", `Policy filtered candidates to ${evaluatedCandidates.length} plan(s).`);
    markSuccess("simulation", `Simulated ${evaluatedCandidates.length} candidate plan(s).`);
  } catch (error) {
    if (error instanceof PlanOptimizationError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    return fail("simulation", message);
  }

  let rankedPlans: RankedPlan[];
  try {
    rankedPlans = rankCandidatePlans(evaluatedCandidates.map((entry) => entry.ranked));
    rankedCandidates = rankedPlans;
    markSuccess("strategy-ranking", `Deterministic ranking completed (${rankedPlans.length} plan(s)).`);
  } catch (error) {
    if (error instanceof PlanOptimizationError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    return fail("strategy-ranking", message);
  }

  let selectedPlan: RankedPlan;
  try {
    const selected = selectBestCandidate(rankedPlans);
    rankedPlans = rankedPlans.map((plan) => ({
      ...plan,
      selected: plan.id === selected.id,
    }));
    selectedPlan = rankedPlans.find((plan) => plan.id === selected.id) as RankedPlan;
    markSuccess("strategy-selection", `Selected ${selectedPlan.id} via deterministic ranking.`);
  } catch (error) {
    if (error instanceof PlanOptimizationError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    return fail("strategy-selection", message);
  }

  let replayVerified = false;
  try {
    const replayRanked = rankCandidatePlans(evaluatedCandidates.map((entry) => ({
      ...entry.ranked,
      rank: 0,
      selected: false,
    })));
    const replaySelected = selectBestCandidate(replayRanked);

    const rankingStable = rankingFingerprint(replayRanked) === rankingFingerprint(rankedPlans);
    const selectionStable = replaySelected.id === selectedPlan.id;

    let traceStable = true;
    if (options.replayTraceId) {
      const previousTrace = readPlanningTrace(options.root, options.replayTraceId);
      if (previousTrace) {
        traceStable = previousTrace.selectedPlanId === selectedPlan.id
          && previousTrace.rankingOrder.join("|") === rankedPlans.map((plan) => plan.id).join("|");
      }
    }

    replayVerified = rankingStable && selectionStable && traceStable;
    if (!replayVerified) {
      return fail("replay-verification", "Replay verification failed for candidate synthesis/ranking/selection.");
    }

    markSuccess("replay-verification", "Replay verification confirmed identical candidates, ranking, and selection.");
  } catch (error) {
    if (error instanceof PlanOptimizationError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    return fail("replay-verification", message);
  }

  try {
    const selectedCandidatePlan = candidatePlans.find((candidate) => candidate.plan.id === selectedPlan.id);
    if (!selectedCandidatePlan) {
      return fail("strategy-selection", `Selected plan payload not found: ${selectedPlan.id}`);
    }

    const rollbackScope = deriveRollbackScopeFrom(selectedPlan.stages, selectedPlan.units);
    const planHash = stableHash({
      selectedPlan,
      rankedPlans,
      workspaceHash: workspaceGraph.graphHash,
      stateHash: hashState(workspaceGraph.state),
    });

    markSuccess("orchestration-build", "Execution DAG and orchestration contract synthesized.");

    const trace = persistArtifacts
      ? writePlanningTrace(options.root, {
        command: options.command,
        selectedPlan,
        rankedPlans,
        candidatePlans: synthesizedCandidates,
        stageResults,
        planHash,
        simulationHash: selectedPlan.previewHash,
        workspaceHash: workspaceGraph.graphHash,
        replayVerified,
      })
      : {
        id: "planning-trace-ephemeral",
        timestamp: new Date().toISOString(),
        command: options.command,
        selectedPlanId: selectedPlan.id,
        selectedStrategyType: selectedPlan.strategyType,
        orchestrationDagHash: selectedPlan.orchestrationGraph.hash,
        planHash,
        simulationHash: selectedPlan.previewHash,
        workspaceHash: workspaceGraph.graphHash,
        replayVerified,
        rankingOrder: rankedPlans.map((plan) => plan.id),
        candidatePlans: rankedPlans.map((plan) => ({
          id: plan.id,
          strategyType: plan.strategyType,
          orchestrationDagHash: plan.orchestrationGraph.hash,
          rollbackComplexity: plan.rollbackScope.complexity,
          riskScore: plan.riskScore,
          estimatedCost: plan.estimatedCost,
          changeCount: plan.changeCount,
          rank: plan.rank,
          selected: plan.id === selectedPlan.id,
        })),
        stageResults,
      };

    appendPipelineDiagnosticsRecordIfPossible(options.root, {
      command: options.command,
      source: diagnosticsSource,
      category: "planning",
      result: "success",
      summary: `Planning synthesized ${synthesizedCandidates.length} candidates, ranked ${rankedPlans.length}, selected ${selectedPlan.id}`,
      stages: stageResults,
      metadata: {
        traceId: trace.id,
        selectedPlanId: selectedPlan.id,
        selectedStrategyType: selectedPlan.strategyType,
        replayVerified,
        orchestrationDagHash: selectedPlan.orchestrationGraph.hash,
        candidatePlans: rankedPlans.map((plan) => ({
          id: plan.id,
          strategyType: plan.strategyType,
          rank: plan.rank,
          selected: plan.id === selectedPlan.id,
          riskScore: plan.riskScore,
          rollbackComplexity: plan.rollbackComplexity,
          blastRadius: plan.blastRadius,
          dependencyRisk: plan.dependencyRisk,
          executionCost: plan.executionCost,
          changeCount: plan.changeCount,
          orchestrationDagHash: plan.orchestrationGraph.hash,
          stages: plan.stages.length,
        })),
        planComparisons: rankedPlans
          .filter((plan) => plan.id !== selectedPlan.id)
          .map((plan) => ({
            from: selectedPlan.id,
            to: plan.id,
            diff: diffPlans(selectedPlan, plan),
          })),
      },
    });

    return {
      selectedPlan,
      selectedExecutionPlan: clonePlan(selectedCandidatePlan.plan),
      planHash,
      simulationHash: selectedPlan.previewHash,
      executionStages: selectedPlan.stages,
      rollbackScope,
      orchestrationDagHash: selectedPlan.orchestrationGraph.hash,
      policyDecision: selectedPlan.policyDecision,
      candidatePlans: synthesizedCandidates,
      rankedPlans,
      stageResults,
      trace,
      ui: buildUIModel(selectedPlan, rankedPlans, workspaceGraph),
    };
  } catch (error) {
    if (error instanceof PlanOptimizationError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    return fail("orchestration-build", message);
  }
}
