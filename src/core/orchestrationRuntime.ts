import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { ControlPlane, ControlPlaneSchema, Plan, Task } from "../schema.js";
import {
  CompilerPipelineError,
  compileInput,
  formatCompilerErrors,
} from "./compilerPipeline.js";
import {
  type GlobalPlan,
  type Repo,
  type RolloutStrategy,
  executeGlobalPlan,
  executeRolloutPlan,
  hashState as hashGlobalState,
  replay,
  simulatePlan,
  simulateUnits,
  validateTrace,
  verifyReplay,
} from "./globalOrchestration.js";
import {
  CandidatePlan,
  PlanDiff,
  PlanOptimizationError,
  RankedPlan,
  diffPlans,
  rankCandidatePlans,
  synthesizeAndOptimizePlans,
  synthesizeCandidatePlans,
  type OptimizedPlanResult,
} from "./planOptimizationOrchestrator.js";
import {
  appendPipelineDiagnosticsRecordIfPossible,
  type PipelineDiagnosticsCategory,
  type PipelineDiagnosticsSource,
  type PipelineDiagnosticsStage,
} from "./pipelineDiagnostics.js";
import {
  computeDiff,
  detectEnvironment,
  evaluatePolicies,
  ExecutionContext,
  hashDiff,
} from "./policyEngine.js";
import { loadPolicies } from "./policyDsl.js";
import {
  createEmptyStatePlane,
  hasApprovalForDiff,
  hasApprovalForPreview,
  hashState as hashStatePlane,
  readStatePlane,
  updateExecutionState,
  upsertPendingPreviewApproval,
} from "./state.js";
import { controlPlaneToChoirConfig } from "./dslYamlCompiler.js";
import { deterministicHash } from "./deterministicCore.js";
import { simulatePlanOutcome, type FileChange } from "./executionPreview.js";
import {
  writeOrchestrationTrace,
  type OrchestrationReplaySummary,
  type OrchestrationSimulationContract,
  type OrchestrationTraceRecord,
} from "./orchestrationRuntimeTrace.js";
import type { Diagnostic } from "./types.js";

export { synthesizeCandidatePlans, rankCandidatePlans };

export type PipelineMode =
  | "preview"
  | "simulate"
  | "execute"
  | "optimize";

export type PipelineStageName =
  | "compile"
  | "structural-validation"
  | "semantic-validation"
  | "cross-node-validation"
  | "candidate-synthesis"
  | "strategy-ranking"
  | "strategy-selection"
  | "orchestration-build"
  | "simulation"
  | "replay-verification"
  | "policy"
  | "approval";

export type PipelineStageResult = {
  stage: PipelineStageName;
  status: "success" | "failure";
  detail: string;
};

export type Intent = {
  root: string;
  command: string;
  controlPlane?: ControlPlane;
  diagnosticsSource?: PipelineDiagnosticsSource;
  requestedPlanId?: string;
  requestedUnits?: string[];
  requestedPreviewRef?: string;
  targetGoal?: string;
  replayTraceId?: string;
  persistArtifacts?: boolean;
  persistPreviewState?: boolean;
  recordPendingApproval?: boolean;
  rolloutStrategy?: RolloutStrategy;
};

export type PipelineExecutionDAG = {
  hash: string;
  nodes: string[];
  edges: Array<{ from: string; to: string }>;
  topologicalOrder: string[];
  stageGroups: Array<{
    id: string;
    order: number;
    units: string[];
  }>;
};

export type PipelineApprovalBinding = {
  required: boolean;
  approved: boolean;
  pendingId?: string;
};

export type PipelinePolicy = {
  decision: "allow" | "require-approval" | "deny";
  allowed: boolean;
  requiresApproval: boolean;
  diffHash: string;
  violations: { ruleId: string; message: string }[];
};

export type PipelineSimulationContract = {
  futureStateHash: string;
  orchestrationHash: string;
  replayHash: string;
};

export type PipelineReplayVerification = {
  candidateSynthesis: boolean;
  strategyRanking: boolean;
  strategySelection: boolean;
  orchestrationDag: boolean;
  simulationContract: boolean;
  verified: boolean;
};

export type PipelineCandidateView = {
  id: string;
  strategyType: string;
  rank: number;
  selected: boolean;
  riskScore: number;
  rollbackComplexity: number;
  blastRadius: number;
  dependencyRisk: number;
  executionCost: number;
  changeCount: number;
  orchestrationDagHash: string;
};

export type PipelineResult = {
  mode: PipelineMode;
  command: string;
  trace: OrchestrationTraceRecord;
  selectedPlanId: string;
  selectedStrategyType: string;
  planSource: "configured" | "synthesized";
  stageResults: PipelineStageResult[];
  simulationContract: PipelineSimulationContract;
  replayVerification: PipelineReplayVerification;
  executionDag: PipelineExecutionDAG;
  policy: PipelinePolicy;
  approval: PipelineApprovalBinding;
  optimized: OptimizedPlanResult;
  candidatePlans: PipelineCandidateView[];
  planComparisons: Array<{
    from: string;
    to: string;
    diff: PlanDiff;
  }>;
  preview?: {
    previewHash: string;
    simulationHash: string;
    stateHash: string;
    summary: {
      filesChanged: number;
      patchesCount: number;
      remainingViolations: number;
      introducedErrors: number;
    };
    diagnostics: Diagnostic[];
    fileChanges: FileChange[];
  };
  simulate?: {
    success: boolean;
    strategyId: string;
    planId: string;
    planSource: "configured" | "synthesized";
    units?: string[];
    changes: Array<{
      unitId: string;
      filesChanged: string[];
      operations: string[];
    }>;
    violations: string[];
    metrics: {
      risk: number;
      changes: number;
      violations: number;
    };
    policy: {
      decision: "allow" | "require-approval" | "deny";
      violations: string[];
    };
    hashes: {
      stateBefore: string;
      stateAfter: string;
      finalState: string;
      replayState: string;
    };
    replay: {
      traceId: string;
      stageIds: string[];
      transitionCount: number;
      validated: boolean;
      verified: boolean;
      hashMatches: boolean;
    };
    rollbackScope: string[];
  };
  execute?: {
    transactionId: string;
    executionHash: string;
    finalStateHash: string;
    replayHash: string;
    executionStages: {
      id: string;
      order: number;
      units: string[];
    }[];
    rollbackScope: {
      unitIds: string[];
      stageIds: string[];
      complexity: number;
    };
    deterministic: boolean;
    verified: boolean;
    success: boolean;
    strategyId: string;
    planId: string;
    planSource: "configured" | "synthesized";
    simulationFutureStateHash: string;
  };
};

export class OrchestrationPipelineError extends Error {
  readonly failedStage: PipelineStageName;
  readonly stageResults: PipelineStageResult[];

  constructor(input: {
    failedStage: PipelineStageName;
    message: string;
    stageResults: PipelineStageResult[];
  }) {
    super(input.message);
    this.name = "OrchestrationPipelineError";
    this.failedStage = input.failedStage;
    this.stageResults = input.stageResults;
  }
}

type GenerateSimulationContractInput = {
  root: string;
  selectedExecutionPlan: Plan;
  orchestrationHash: string;
  requestedUnits?: string[];
};

type GenerateSimulationContractResult = {
  simulationContract: PipelineSimulationContract;
  simulation: Awaited<ReturnType<typeof simulatePlan>>;
  simulationReplay: {
    validated: boolean;
    verified: boolean;
    hashMatches: boolean;
  };
  globalPlan: GlobalPlan;
  repos: Repo[];
};

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function normalizePath(value: string): string {
  return value.split("\\").join("/");
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

  return {
    ...control,
    execution: {
      ...control.execution,
      plans: [
        ...control.execution.plans.filter((entry) => entry.id !== approvedPlan.id),
        approvedPlan,
      ].sort((left, right) => left.id.localeCompare(right.id)),
    },
  };
}

function deriveSimulationUnit(task: Task): string {
  const files = [...(task.scope?.files ?? [])]
    .map((file) => file.replace(/\\/g, "/"))
    .sort((left, right) => left.localeCompare(right));

  const first = files[0];
  if (!first) {
    return "workspace:root";
  }

  const segments = first.split("/").filter((entry) => entry.length > 0);
  if (segments.length >= 2 && ["packages", "apps", "services", "libs"].includes(segments[0] as string)) {
    return `${segments[0]}:${segments[1]}`;
  }

  return "workspace:root";
}

function toGlobalPlanFromPlan(plan: Plan): GlobalPlan {
  const knownTaskIds = new Set(plan.tasks.map((task) => task.id));
  const tasks = [...plan.tasks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((task) => ({
      id: `${plan.id}:${task.id}`,
      repoId: deriveSimulationUnit(task),
      action: `${task.type}:${task.id}`,
      dependsOn: sortedUnique((task.dependsOn ?? [])
        .filter((dependencyId) => knownTaskIds.has(dependencyId))
        .map((dependencyId) => `${plan.id}:${dependencyId}`)),
    }));

  return {
    id: `global-${plan.id}`,
    tasks,
  };
}

function buildSimulationRepos(plans: GlobalPlan[]): Repo[] {
  const taskById = new Map(plans.flatMap((plan) => plan.tasks.map((task) => [task.id, task] as const)));
  const repoDependencies = new Map<string, Set<string>>();

  for (const plan of plans) {
    for (const task of plan.tasks) {
      if (!repoDependencies.has(task.repoId)) {
        repoDependencies.set(task.repoId, new Set<string>());
      }

      for (const dependencyId of task.dependsOn) {
        const dependency = taskById.get(dependencyId);
        if (!dependency) {
          continue;
        }

        if (dependency.repoId !== task.repoId) {
          repoDependencies.get(task.repoId)?.add(dependency.repoId);
        }
      }
    }
  }

  return [...repoDependencies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([repoId, dependencies]) => ({
      id: repoId,
      dependencies: sortedUnique([...dependencies]),
      state: {},
    }));
}

function computeSimulationMetrics(simulated: Awaited<ReturnType<typeof simulatePlan>>): {
  risk: number;
  changes: number;
  violations: number;
} {
  const changes = simulated.changes.reduce((sum, entry) => sum + entry.operations.length, 0);
  const violations = simulated.violations.length;
  const risk = (violations * 5) + changes;
  return {
    risk,
    changes,
    violations,
  };
}

function toCandidateView(rankedPlans: RankedPlan[], selectedPlanId: string): PipelineCandidateView[] {
  return rankedPlans.map((plan) => ({
    id: plan.id,
    strategyType: plan.strategyType,
    rank: plan.rank,
    selected: plan.id === selectedPlanId,
    riskScore: plan.riskScore,
    rollbackComplexity: plan.rollbackComplexity,
    blastRadius: plan.blastRadius,
    dependencyRisk: plan.dependencyRisk,
    executionCost: plan.executionCost,
    changeCount: plan.changeCount,
    orchestrationDagHash: plan.orchestrationGraph.hash,
  }));
}

function toPlanComparisons(rankedPlans: RankedPlan[], selected: RankedPlan): Array<{ from: string; to: string; diff: PlanDiff }> {
  return rankedPlans
    .filter((plan) => plan.id !== selected.id)
    .map((plan) => ({
      from: selected.id,
      to: plan.id,
      diff: diffPlans(selected, plan),
    }));
}

function mapPlanningFailureStage(stage: string): PipelineStageName {
  if (stage === "compile") return "compile";
  if (stage === "structure-validation") return "structural-validation";
  if (stage === "semantic-validation") return "semantic-validation";
  if (stage === "cross-node-validation") return "cross-node-validation";
  if (stage === "candidate-synthesis") return "candidate-synthesis";
  if (stage === "strategy-ranking") return "strategy-ranking";
  if (stage === "strategy-selection") return "strategy-selection";
  if (stage === "orchestration-build") return "orchestration-build";
  if (stage === "simulation") return "simulation";
  if (stage === "replay-verification") return "replay-verification";
  if (stage === "policy-evaluation") return "policy";
  return "compile";
}

function diagnosticsCategoryForMode(mode: PipelineMode): PipelineDiagnosticsCategory {
  if (mode === "preview") return "preview";
  if (mode === "simulate") return "simulation";
  if (mode === "execute") return "execution";
  return "planning";
}

function toDiagnosticsStages(stageResults: PipelineStageResult[]): PipelineDiagnosticsStage[] {
  return stageResults.map((stage) => ({
    stage: stage.stage,
    status: stage.status,
    detail: stage.detail,
  }));
}

function mapPolicyDecision(input: ReturnType<typeof evaluatePolicies>["trace"]["decision"]): "allow" | "require-approval" | "deny" {
  return input;
}

function mapExecutionStages(optimized: OptimizedPlanResult): Array<{ id: string; order: number; units: string[] }> {
  return optimized.executionStages.map((stage) => ({
    id: stage.id,
    order: stage.order,
    units: [...stage.units],
  }));
}

export function buildExecutionDAG(selectedPlan: RankedPlan): PipelineExecutionDAG {
  return {
    hash: selectedPlan.orchestrationGraph.hash,
    nodes: [...selectedPlan.orchestrationGraph.nodes],
    edges: selectedPlan.orchestrationGraph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    topologicalOrder: selectedPlan.stages
      .flatMap((stage) => stage.units)
      .filter((unit, index, all) => all.indexOf(unit) === index),
    stageGroups: selectedPlan.stages.map((stage) => ({
      id: stage.id,
      order: stage.order,
      units: [...stage.units],
    })),
  };
}

export async function generateSimulationContract(
  input: GenerateSimulationContractInput
): Promise<GenerateSimulationContractResult> {
  const globalPlan = toGlobalPlanFromPlan(input.selectedExecutionPlan);
  const repos = buildSimulationRepos([globalPlan]);
  const simulation = input.requestedUnits && input.requestedUnits.length > 0
    ? await simulateUnits(input.requestedUnits, globalPlan, {
      repos,
      policies: [],
      stateRoot: input.root,
    })
    : await simulatePlan(globalPlan, {
      repos,
      policies: [],
      stateRoot: input.root,
    });

  if (!simulation.success) {
    throw new Error(`Simulation failed: ${simulation.violations.join("; ") || "unknown simulation failure"}`);
  }

  const deterministicTrace = simulation.trace.deterministicTrace;
  if (!deterministicTrace) {
    throw new Error("Simulation trace missing deterministic replay metadata.");
  }

  const futureStateHash = hashGlobalState(simulation.finalState);
  const replayHash = hashGlobalState(replay(deterministicTrace));
  const validated = validateTrace(deterministicTrace);
  const verified = verifyReplay(deterministicTrace);
  const hashMatches = replayHash === futureStateHash;

  if (!validated || !verified || !hashMatches) {
    throw new Error(`Simulation replay verification failed (trace=${validated}, replay=${verified}, hashMatch=${hashMatches}).`);
  }

  return {
    simulationContract: {
      futureStateHash,
      orchestrationHash: input.orchestrationHash,
      replayHash,
    },
    simulation,
    simulationReplay: {
      validated,
      verified,
      hashMatches,
    },
    globalPlan,
    repos,
  };
}

export async function verifyReplayDeterminism(input: {
  root: string;
  command: string;
  controlPlane: ControlPlane;
  targetGoal?: string;
  selected: OptimizedPlanResult;
  simulationContract: PipelineSimulationContract;
}): Promise<{
  replayVerification: PipelineReplayVerification;
  replayOptimized: OptimizedPlanResult;
}> {
  const replayOptimized = await synthesizeAndOptimizePlans({
    root: input.root,
    command: input.command,
    controlPlane: input.controlPlane,
    ...(input.targetGoal ? { targetGoal: input.targetGoal } : {}),
    persistArtifacts: false,
    replayTraceId: input.selected.trace.id,
  });

  const candidateSynthesis = replayOptimized.candidatePlans.map((plan) => `${plan.strategyType}:${plan.id}`).join("|")
    === input.selected.candidatePlans.map((plan) => `${plan.strategyType}:${plan.id}`).join("|");
  const strategyRanking = replayOptimized.rankedPlans.map((plan) => plan.id).join("|")
    === input.selected.rankedPlans.map((plan) => plan.id).join("|");
  const strategySelection = replayOptimized.selectedPlan.id === input.selected.selectedPlan.id;
  const orchestrationDag = replayOptimized.selectedPlan.orchestrationGraph.hash === input.selected.selectedPlan.orchestrationGraph.hash;

  const replaySimulation = await generateSimulationContract({
    root: input.root,
    selectedExecutionPlan: replayOptimized.selectedExecutionPlan,
    orchestrationHash: replayOptimized.selectedPlan.orchestrationGraph.hash,
  });

  const simulationContract = replaySimulation.simulationContract.futureStateHash === input.simulationContract.futureStateHash
    && replaySimulation.simulationContract.orchestrationHash === input.simulationContract.orchestrationHash
    && replaySimulation.simulationContract.replayHash === input.simulationContract.replayHash;

  const replayVerification: PipelineReplayVerification = {
    candidateSynthesis,
    strategyRanking,
    strategySelection,
    orchestrationDag,
    simulationContract,
    verified: candidateSynthesis && strategyRanking && strategySelection && orchestrationDag && simulationContract,
  };

  return {
    replayVerification,
    replayOptimized,
  };
}

export async function runOrchestrationPipeline(
  mode: PipelineMode,
  intent: Intent
): Promise<PipelineResult> {
  const diagnosticsSource = intent.diagnosticsSource ?? "chat";
  const stageResults: PipelineStageResult[] = [];

  let selectedPlanId = "unresolved";
  let selectedStrategyType = "unresolved";
  let planSource: "configured" | "synthesized" = "synthesized";
  let executionDag: PipelineExecutionDAG = {
    hash: "",
    nodes: [],
    edges: [],
    topologicalOrder: [],
    stageGroups: [],
  };
  let simulationContract: PipelineSimulationContract = {
    futureStateHash: "",
    orchestrationHash: "",
    replayHash: "",
  };
  let replayVerification: PipelineReplayVerification = {
    candidateSynthesis: false,
    strategyRanking: false,
    strategySelection: false,
    orchestrationDag: false,
    simulationContract: false,
    verified: false,
  };
  let policy: PipelinePolicy = {
    decision: "allow",
    allowed: true,
    requiresApproval: false,
    diffHash: "",
    violations: [],
  };
  let approval: PipelineApprovalBinding = {
    required: false,
    approved: true,
  };

  const markSuccess = (stage: PipelineStageName, detail: string): void => {
    stageResults.push({ stage, status: "success", detail });
  };

  const fail = (stage: PipelineStageName, detail: string): never => {
    stageResults.push({ stage, status: "failure", detail });
    throw new OrchestrationPipelineError({
      failedStage: stage,
      message: detail,
      stageResults,
    });
  };

  let controlPlane: ControlPlane;
  let optimized: OptimizedPlanResult;
  let candidatePlans: PipelineCandidateView[] = [];
  let planComparisons: Array<{ from: string; to: string; diff: PlanDiff }> = [];
  let previewResult: PipelineResult["preview"];
  let simulateResult: PipelineResult["simulate"];
  let executeResult: PipelineResult["execute"];

  try {
    const requestedPlanId = intent.requestedPlanId?.trim();

    try {
      controlPlane = intent.controlPlane ?? loadControlPlane(intent.root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail("compile", message);
    }

    try {
      compileInput(intent.command, controlPlane);
      markSuccess("compile", "Compiler gates passed for unified orchestration pipeline.");
      markSuccess("structural-validation", "Structural validation passed.");
      markSuccess("semantic-validation", "Semantic validation passed.");
      markSuccess("cross-node-validation", "Cross-node validation passed.");
    } catch (error) {
      if (error instanceof CompilerPipelineError) {
        return fail("compile", formatCompilerErrors(error.errors));
      }

      const message = error instanceof Error ? error.message : String(error);
      return fail("compile", message);
    }

    try {
      const effectiveControlPlane = requestedPlanId
        ? {
          ...controlPlane,
          execution: {
            ...controlPlane.execution,
            plans: controlPlane.execution.plans.filter((plan) => plan.id === requestedPlanId),
          },
        }
        : controlPlane;

      optimized = await synthesizeAndOptimizePlans({
        root: intent.root,
        command: intent.command,
        controlPlane: effectiveControlPlane,
        ...(intent.targetGoal ? { targetGoal: intent.targetGoal } : {}),
        ...(intent.replayTraceId ? { replayTraceId: intent.replayTraceId } : {}),
        persistArtifacts: intent.persistArtifacts,
        diagnosticsSource,
      });
    } catch (error) {
      if (error instanceof PlanOptimizationError) {
        return fail(mapPlanningFailureStage(error.failedStage), error.message);
      }

      const message = error instanceof Error ? error.message : String(error);
      return fail("candidate-synthesis", message);
    }

    if (requestedPlanId && !optimized.rankedPlans.some((plan) => plan.id === requestedPlanId)) {
      return fail("candidate-synthesis", `Requested plan not found in synthesized candidates: ${requestedPlanId}`);
    }

    const selected = requestedPlanId
      ? optimized.rankedPlans.find((plan) => plan.id === requestedPlanId)
      : optimized.rankedPlans.find((plan) => plan.id === optimized.selectedPlan.id);

    if (!selected) {
      return fail("strategy-selection", "Unable to resolve selected strategy candidate.");
    }

    selectedPlanId = selected.id;
    selectedStrategyType = selected.strategyType;
    planSource = selected.synthesized ? "synthesized" : "configured";

    candidatePlans = toCandidateView(optimized.rankedPlans, selected.id);
    planComparisons = toPlanComparisons(optimized.rankedPlans, selected);

    markSuccess("candidate-synthesis", `Synthesized ${candidatePlans.length} deterministic candidate plan(s).`);
    markSuccess("strategy-ranking", `Ranked ${candidatePlans.length} candidate plan(s) deterministically.`);
    markSuccess("strategy-selection", `Selected ${selected.id} via strategy ${selected.strategyType}.`);

    executionDag = buildExecutionDAG(selected);
    markSuccess("orchestration-build", `Execution DAG built with hash ${executionDag.hash.slice(0, 12)}.`);

    const selectedExecutionPlan = optimized.selectedExecutionPlan;

    const generatedSimulation = await generateSimulationContract({
      root: intent.root,
      selectedExecutionPlan,
      orchestrationHash: executionDag.hash,
    });

    simulationContract = generatedSimulation.simulationContract;
    markSuccess("simulation", `Simulation contract generated (futureStateHash=${simulationContract.futureStateHash.slice(0, 12)}).`);

    const replayOutcome = await verifyReplayDeterminism({
      root: intent.root,
      command: intent.command,
      controlPlane,
      ...(intent.targetGoal ? { targetGoal: intent.targetGoal } : {}),
      selected: optimized,
      simulationContract,
    });

    replayVerification = replayOutcome.replayVerification;
    if (!replayVerification.verified) {
      return fail("replay-verification", "Replay verification failed for unified orchestration runtime.");
    }

    markSuccess("replay-verification", "Replay verification confirmed deterministic synthesis, ranking, selection, DAG, and simulation contract.");

    const selectedExecutionControl = mergeExecutionPlan(controlPlane, selectedExecutionPlan);
    const diffs = computeDiff(
      controlPlaneToChoirConfig(controlPlane),
      controlPlaneToChoirConfig(selectedExecutionControl)
    );

    const environment = detectEnvironment();
    const context: ExecutionContext = {
      role: "conductor",
      environment,
    };
    const policySet = loadPolicies(intent.root, environment);
    const evaluation = evaluatePolicies(diffs, policySet, context);
    const diffHash = hashDiff(diffs);
    policy = {
      decision: mapPolicyDecision(evaluation.trace.decision),
      allowed: evaluation.result.allowed,
      requiresApproval: evaluation.result.requiresApproval,
      diffHash,
      violations: evaluation.result.violations,
    };

    if (!policy.allowed || policy.decision === "deny") {
      const violationSummary = policy.violations.length === 0
        ? "Denied by policy gate."
        : policy.violations.map((entry) => `[${entry.ruleId}] ${entry.message}`).join("; ");
      return fail("policy", `Policy denied orchestration: ${violationSummary}`);
    }

    markSuccess("policy", `Policy decision=${policy.decision} (diffHash=${policy.diffHash.slice(0, 12)}).`);

    if (policy.requiresApproval) {
      const approved = hasApprovalForPreview(intent.root, selected.previewHash)
        || hasApprovalForDiff(intent.root, policy.diffHash);

      let pendingId: string | undefined;
      if (!approved && mode === "preview" && intent.recordPendingApproval !== false) {
        pendingId = upsertPendingPreviewApproval(intent.root, selected.previewHash, intent.command).pendingId;
      }

      approval = {
        required: true,
        approved,
        ...(pendingId ? { pendingId } : {}),
      };

      if (mode === "execute" && !approved) {
        return fail("approval", `Execution requires approval for previewHash=${selected.previewHash}.`);
      }
    }

    if (!approval.required) {
      approval = {
        required: false,
        approved: true,
      };
    }

    markSuccess("approval", approval.required
      ? approval.approved
        ? "Approval required and satisfied."
        : `Approval required and pending${approval.pendingId ? ` (${approval.pendingId})` : ""}.`
      : "Approval not required.");

    if (mode === "preview") {
      const preview = await simulatePlanOutcome(selectedExecutionPlan, {
        root: intent.root,
        controlPlane: selectedExecutionControl,
      });

      const stateHash = hashStatePlane(readStatePlane(intent.root) ?? createEmptyStatePlane());
      const simulationHash = deterministicHash({
        previewHash: preview.previewHash,
        futureStateHash: simulationContract.futureStateHash,
        orchestrationHash: simulationContract.orchestrationHash,
        replayHash: simulationContract.replayHash,
      });

      if (intent.persistPreviewState !== false) {
        updateExecutionState(intent.root, (current) => ({
          ...current,
          lastPreview: {
            hash: preview.previewHash,
            planId: selectedExecutionPlan.id,
            strategyId: selected.strategyType,
          },
        }));
      }

      previewResult = {
        previewHash: preview.previewHash,
        simulationHash,
        stateHash,
        summary: {
          filesChanged: preview.metrics.filesChanged,
          patchesCount: preview.metrics.patchesCount,
          remainingViolations: preview.metrics.remainingViolations,
          introducedErrors: preview.metrics.introducedErrors,
        },
        diagnostics: preview.diagnostics,
        fileChanges: preview.fileChanges,
      };
    } else if (mode === "simulate") {
      const stateBefore = hashStatePlane(readStatePlane(intent.root) ?? createEmptyStatePlane());
      const globalPlan = toGlobalPlanFromPlan(selectedExecutionPlan);
      const repos = buildSimulationRepos([globalPlan]);
      const requestedUnits = sortedUnique((intent.requestedUnits ?? []).map((unit) => unit.trim()).filter((unit) => unit.length > 0));
      const availableUnits = sortedUnique(globalPlan.tasks.map((task) => task.repoId));
      const unknownUnits = requestedUnits.filter((unit) => !availableUnits.includes(unit));
      if (unknownUnits.length > 0) {
        return fail("simulation", `Simulation units not found in selected plan ${selectedExecutionPlan.id}: ${unknownUnits.join(", ")}`);
      }

      const simulated = requestedUnits.length > 0
        ? await simulateUnits(requestedUnits, globalPlan, {
          repos,
          policies: [],
          stateRoot: intent.root,
        })
        : await simulatePlan(globalPlan, {
          repos,
          policies: [],
          stateRoot: intent.root,
        });

      const stateAfter = hashStatePlane(readStatePlane(intent.root) ?? createEmptyStatePlane());
      if (stateBefore !== stateAfter) {
        return fail("simulation", `Simulation mutated persisted state (${stateBefore.slice(0, 12)} -> ${stateAfter.slice(0, 12)}).`);
      }

      const deterministicTrace = simulated.trace.deterministicTrace;
      if (!deterministicTrace) {
        return fail("simulation", "Simulation trace is missing deterministic replay metadata.");
      }

      const replayStateHash = hashGlobalState(replay(deterministicTrace));
      const finalStateHash = hashGlobalState(simulated.finalState);
      const validated = validateTrace(deterministicTrace);
      const verified = verifyReplay(deterministicTrace);
      const hashMatches = replayStateHash === finalStateHash;
      if (!validated || !verified || !hashMatches) {
        return fail("simulation", `Simulation replay verification failed (validated=${validated}, verified=${verified}, hashMatches=${hashMatches}).`);
      }

      const metrics = computeSimulationMetrics(simulated);
      const primaryPolicy = simulated.policyDecisions[0];
      const policyDecision = primaryPolicy?.requiresApproval
        ? "require-approval"
        : primaryPolicy?.allowed === false
          ? "deny"
          : "allow";

      simulateResult = {
        success: simulated.success,
        strategyId: globalPlan.id,
        planId: selectedExecutionPlan.id,
        planSource,
        ...(requestedUnits.length > 0 ? { units: requestedUnits } : {}),
        changes: simulated.changes,
        violations: simulated.violations,
        metrics,
        policy: {
          decision: policyDecision,
          violations: primaryPolicy?.violations ?? [],
        },
        hashes: {
          stateBefore,
          stateAfter,
          finalState: finalStateHash,
          replayState: replayStateHash,
        },
        replay: {
          traceId: deterministicTrace.traceId,
          stageIds: deterministicTrace.stages.map((entry) => entry.stageId),
          transitionCount: deterministicTrace.stages.reduce((sum, entry) => sum + entry.operations.length, 0),
          validated,
          verified,
          hashMatches,
        },
        rollbackScope: simulated.success ? [] : sortedUnique(simulated.trace.unitsAffected),
      };
    } else if (mode === "execute") {
      const globalPlan = toGlobalPlanFromPlan(selectedExecutionPlan);
      const repos = buildSimulationRepos([globalPlan]);

      if (intent.rolloutStrategy) {
        const rollout = await executeRolloutPlan(
          globalPlan,
          {
            repos,
            policies: [],
            stateRoot: intent.root,
          },
          intent.rolloutStrategy,
          {
            requireApproval: policy.requiresApproval
              ? async ({ previewHash }) => approval.approved && previewHash === selected.previewHash
              : undefined,
          }
        );

        if (!rollout.success) {
          return fail("approval", `Execution failed: ${rollout.failures.join("; ") || "rollout execution failure"}`);
        }

        const finalStateHash = hashGlobalState(rollout.finalStates);
        if (simulationContract.futureStateHash !== finalStateHash) {
          return fail("approval", `Simulation parity divergence: simulation=${simulationContract.futureStateHash}, execution=${finalStateHash}`);
        }

        const deterministicTrace = rollout.trace.deterministicTraces[rollout.trace.deterministicTraces.length - 1] ?? generatedSimulation.simulation.trace.deterministicTrace;
        if (!deterministicTrace) {
          return fail("approval", "Execution trace missing deterministic replay metadata.");
        }

        const replayStateHash = hashGlobalState(replay(deterministicTrace));
        const traceValid = validateTrace(deterministicTrace);
        const replayValid = verifyReplay(deterministicTrace);
        const replayHashMatches = replayStateHash === finalStateHash;

        if (!traceValid || !replayValid || !replayHashMatches) {
          return fail("approval", `Replay verification failed (trace=${traceValid}, replay=${replayValid}, hashMatch=${replayHashMatches}).`);
        }

        const transactionId = rollout.trace.transactionTraces[rollout.trace.transactionTraces.length - 1]?.transactionId
          ?? `rollout-${globalPlan.id}`;
        const executionStages = rollout.trace.stages.map((stage) => ({
          id: stage.id,
          order: stage.order,
          units: sortedUnique(stage.units),
        }));
        const rollbackUnits = sortedUnique(rollout.trace.rollbackTraces.flatMap((entry) => entry.rollbackSet));
        const rollbackStages = sortedUnique(rollout.trace.rollbackTraces.map((entry) => `rollback:${entry.failedUnit}`));

        executeResult = {
          transactionId,
          executionHash: deterministicHash({
            transactionId,
            planId: globalPlan.id,
            finalStateHash,
            replayStateHash,
            completedStages: rollout.trace.completedStages,
          }),
          finalStateHash,
          replayHash: replayStateHash,
          executionStages,
          rollbackScope: {
            unitIds: rollbackUnits,
            stageIds: rollbackStages,
            complexity: rollbackUnits.length + rollbackStages.length,
          },
          deterministic: true,
          verified: true,
          success: true,
          strategyId: selected.strategyType,
          planId: selectedExecutionPlan.id,
          planSource,
          simulationFutureStateHash: simulationContract.futureStateHash,
        };
      } else {
        const execution = await executeGlobalPlan(globalPlan, {
          repos,
          policies: [],
          stateRoot: intent.root,
          approveExecution: async ({ previewHash }) => {
            if (!policy.requiresApproval) {
              return true;
            }

            return approval.approved && previewHash === selected.previewHash;
          },
        });

        if (!execution.success) {
          return fail("approval", `Execution failed: ${execution.audit.violations.join("; ") || "global execution failure"}`);
        }

        const finalStateHash = hashGlobalState(execution.finalStates);
        if (simulationContract.futureStateHash !== finalStateHash) {
          return fail("approval", `Simulation parity divergence: simulation=${simulationContract.futureStateHash}, execution=${finalStateHash}`);
        }

        const deterministicTrace = execution.trace.deterministicTrace;
        if (!deterministicTrace) {
          return fail("approval", "Execution trace missing deterministic replay metadata.");
        }

        const replayStateHash = hashGlobalState(replay(deterministicTrace));
        const traceValid = validateTrace(deterministicTrace);
        const replayValid = verifyReplay(deterministicTrace);
        const replayHashMatches = replayStateHash === finalStateHash;

        if (!traceValid || !replayValid || !replayHashMatches) {
          return fail("approval", `Replay verification failed (trace=${traceValid}, replay=${replayValid}, hashMatch=${replayHashMatches}).`);
        }

        const transactionId = execution.trace.transactionTrace?.transactionId ?? `tx-${globalPlan.id}`;
        const executionStages = execution.trace.stages.map((stage) => ({
          id: stage.id,
          order: stage.order,
          units: sortedUnique(stage.unitIds),
        }));
        const rollbackUnits = sortedUnique(execution.rollbackTrace?.rollbackSet ?? []);
        const rollbackStages = sortedUnique(execution.rollbackTrace?.rollbackOrder.map((unitId) => `rollback:${unitId}`) ?? []);

        executeResult = {
          transactionId,
          executionHash: deterministicHash({
            transactionId,
            planId: globalPlan.id,
            finalStateHash,
            replayStateHash,
            executionOrder: execution.trace.executionOrder,
          }),
          finalStateHash,
          replayHash: replayStateHash,
          executionStages,
          rollbackScope: {
            unitIds: rollbackUnits,
            stageIds: rollbackStages,
            complexity: rollbackUnits.length + rollbackStages.length,
          },
          deterministic: true,
          verified: true,
          success: true,
          strategyId: selected.strategyType,
          planId: selectedExecutionPlan.id,
          planSource,
          simulationFutureStateHash: simulationContract.futureStateHash,
        };
      }
    }

    const trace = writeOrchestrationTrace(intent.root, {
      mode,
      command: intent.command,
      status: "success",
      selectedPlanId,
      selectedStrategyType,
      planSource,
      orchestrationDagHash: executionDag.hash,
      simulationContract: simulationContract as OrchestrationSimulationContract,
      replay: replayVerification as OrchestrationReplaySummary,
      rankingOrder: optimized.rankedPlans.map((plan) => plan.id),
      candidates: candidatePlans.map((candidate) => ({
        id: candidate.id,
        strategyType: candidate.strategyType,
        orchestrationDagHash: candidate.orchestrationDagHash,
        rank: candidate.rank,
        selected: candidate.selected,
        riskScore: candidate.riskScore,
        rollbackComplexity: candidate.rollbackComplexity,
        blastRadius: candidate.blastRadius,
        dependencyRisk: candidate.dependencyRisk,
        executionCost: candidate.executionCost,
        changeCount: candidate.changeCount,
      })),
      stageResults,
      modeMetadata: {
        policyDecision: policy.decision,
        approvalRequired: approval.required,
        approvalSatisfied: approval.approved,
      },
    });

    appendPipelineDiagnosticsRecordIfPossible(intent.root, {
      command: intent.command,
      source: diagnosticsSource,
      category: diagnosticsCategoryForMode(mode),
      result: "success",
      summary: `Unified orchestration completed in mode ${mode} with selected plan ${selectedPlanId}.`,
      stages: toDiagnosticsStages(stageResults),
      metadata: {
        traceId: trace.id,
        mode,
        selectedPlanId,
        selectedStrategyType,
        simulationContract,
        replayVerification,
        candidatePlans,
        planComparisons,
      },
    });

    return {
      mode,
      command: intent.command,
      trace,
      selectedPlanId,
      selectedStrategyType,
      planSource,
      stageResults,
      simulationContract,
      replayVerification,
      executionDag,
      policy,
      approval,
      optimized,
      candidatePlans,
      planComparisons,
      ...(previewResult ? { preview: previewResult } : {}),
      ...(simulateResult ? { simulate: simulateResult } : {}),
      ...(executeResult ? { execute: executeResult } : {}),
    };
  } catch (error) {
    const failedStage = error instanceof OrchestrationPipelineError
      ? error.failedStage
      : "compile";
    const message = error instanceof Error ? error.message : String(error);

    const trace = writeOrchestrationTrace(intent.root, {
      mode,
      command: intent.command,
      status: "failure",
      selectedPlanId,
      selectedStrategyType,
      planSource,
      orchestrationDagHash: executionDag.hash,
      simulationContract: simulationContract as OrchestrationSimulationContract,
      replay: replayVerification as OrchestrationReplaySummary,
      rankingOrder: [],
      candidates: [],
      stageResults,
      modeMetadata: {
        orchestration: {
          status: "failed",
          stage: failedStage,
        },
      },
    });

    appendPipelineDiagnosticsRecordIfPossible(intent.root, {
      command: intent.command,
      source: diagnosticsSource,
      category: diagnosticsCategoryForMode(mode),
      result: "failure",
      summary: `Unified orchestration failed at ${failedStage}: ${message}`,
      stages: toDiagnosticsStages(stageResults),
      metadata: {
        traceId: trace.id,
        mode,
        failedStage,
        orchestration: {
          status: "failed",
          stage: failedStage,
        },
      },
    });

    if (error instanceof OrchestrationPipelineError) {
      throw error;
    }

    throw new OrchestrationPipelineError({
      failedStage,
      message,
      stageResults,
    });
  }
}
