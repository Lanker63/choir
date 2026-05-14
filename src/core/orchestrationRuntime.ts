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
  type CompiledPolicy as GlobalCompiledPolicy,
  evaluateCompiledGlobalPolicies,
  executionPreviewHash,
  hashState as hashGlobalState,
  replay,
  simulatePlan,
  simulateUnits,
  validateTrace,
  verifyReplay,
} from "./globalOrchestration.js";
import {
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
  type StatePlane,
  updateExecutionState,
  upsertPendingPreviewApproval,
} from "./state.js";
import { controlPlaneToChoirConfig } from "./dslYamlCompiler.js";
import { deterministicHash, deterministicId } from "./deterministicCore.js";
import { simulatePlanOutcome, type FileChange } from "./executionPreview.js";
import {
  applyMaterializationPlan,
  generateMaterializationPlan,
  replayMaterializationFromLineage,
} from "./materializationEngine.js";
import { CanonicalWorkspaceHasher } from "./workspaceSnapshot.js";
import {
  readLatestOrchestrationTrace,
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
  | "analyze"
  | "validate"
  | "synthesize"
  | "generate"
  | "apply"
  | "verify"
  | "commit"
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
  | "integrity"
  | "policy"
  | "approval"
  | "execution";

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
  executionPolicies?: GlobalCompiledPolicy[];
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
  mutationHash: string;
  projectedWorkspaceHash: string;
  preWorkspaceSnapshotHash: string;
  postWorkspaceSnapshotHash: string;
};

export type PipelineReplayVerification = {
  candidateSynthesis: boolean;
  strategyRanking: boolean;
  strategySelection: boolean;
  orchestrationDag: boolean;
  simulationContract: boolean;
  verified: boolean;
};

export type IntegrityViolationType =
  | "PREVIEW_HASH_MISMATCH"
  | "SIMULATION_EXECUTION_PARITY_MISMATCH"
  | "REPLAY_PARITY_FAILURE"
  | "DAG_HASH_MISMATCH"
  | "DAG_CYCLE_DETECTED"
  | "DAG_MISSING_NODE_REFERENCE"
  | "DAG_CANONICAL_ORDER_MISMATCH"
  | "STRATEGY_ID_MISMATCH"
  | "ORCHESTRATION_HASH_MISMATCH"
  | "STATE_SNAPSHOT_INVALID"
  | "STATE_SNAPSHOT_MISMATCH"
  | "STALE_SIMULATION_ARTIFACT"
  | "MUTATION_MANIFEST_TAMPERED"
  | "MANIFEST_TAMPER"
  | "WORKSPACE_SNAPSHOT_DIVERGENCE"
  | "PATCH_ORDER_DIVERGENCE"
  | "REPLAY_LINEAGE_DIVERGENCE"
  | "STATE_LINEAGE_DIVERGENCE";

export type IntegrityViolation = {
  type: IntegrityViolationType;
  detail: string;
};

export type ExecutionIntegritySnapshot = {
  planId: string;
  strategyId: string;
  controlPlaneHash: string;
  previewHash: string;
  predictedExecutionHash: string;
  simulationFutureStateHash: string;
  orchestrationHash: string;
  nodeHash: string;
  edgeHash: string;
  canonicalStageHash: string;
  stateSnapshotHash: string;
  preWorkspaceSnapshotHash: string;
  postWorkspaceSnapshotHash: string;
  integrityHash: string;
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
    preWorkspaceSnapshotHash: string;
    postWorkspaceSnapshotHash: string;
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
    preWorkspaceSnapshotHash: string;
    postWorkspaceSnapshotHash: string;
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
    mutationHash: string;
    workspaceHash: string;
    replayWorkspaceHash: string;
    preWorkspaceSnapshotHash: string;
    postWorkspaceSnapshotHash: string;
    preWorkspaceSnapshotId: string;
    postWorkspaceSnapshotId: string;
    patchOrderHash: string;
    manifestId: string;
    manifestHash: string;
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
  executionPolicies?: GlobalCompiledPolicy[];
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

type ExecutionIntegrityGateInput = {
  root: string;
  controlPlane: ControlPlane;
  requestedPreviewRef?: string;
  selected: RankedPlan;
  selectedExecutionPlan: Plan;
  simulationContract: PipelineSimulationContract;
  generatedSimulation: GenerateSimulationContractResult;
  executionDag: PipelineExecutionDAG;
  replayVerification: PipelineReplayVerification;
};

type ExecutionIntegrityGateResult = {
  valid: boolean;
  snapshot: ExecutionIntegritySnapshot;
  violations: IntegrityViolation[];
};

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
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

function stageOrderForMode(mode: PipelineMode): PipelineStageName[] {
  if (mode === "execute") {
    return [
      "analyze",
      "validate",
      "synthesize",
      "generate",
      "apply",
      "verify",
      "commit",
      "compile",
      "structural-validation",
      "semantic-validation",
      "cross-node-validation",
      "candidate-synthesis",
      "strategy-ranking",
      "strategy-selection",
      "orchestration-build",
      "policy",
      "simulation",
      "replay-verification",
      "integrity",
      "approval",
      "execution",
    ];
  }

  return [
    "compile",
    "structural-validation",
    "semantic-validation",
    "cross-node-validation",
    "candidate-synthesis",
    "strategy-ranking",
    "strategy-selection",
    "orchestration-build",
    "policy",
    "simulation",
    "replay-verification",
    "approval",
  ];
}

function fallbackFailedStageForMode(mode: PipelineMode): PipelineStageName {
  if (mode === "execute") {
    return "execution";
  }

  return "simulation";
}

function inferFailedStage(mode: PipelineMode, stageResults: PipelineStageResult[]): PipelineStageName {
  const latestFailure = [...stageResults].reverse().find((stage) => stage.status === "failure");
  if (latestFailure) {
    return latestFailure.stage;
  }

  const completed = new Set(stageResults.map((stage) => stage.stage));
  const next = stageOrderForMode(mode).find((stage) => !completed.has(stage));
  if (next) {
    return next;
  }

  return fallbackFailedStageForMode(mode);
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

function policyViolationId(message: string): string {
  const match = /^Rule ([^:]+):/.exec(message);
  return match?.[1] ?? "execution-policy";
}

function executionPolicyViolations(violations: string[]): PipelinePolicy["violations"] {
  return violations.map((message) => ({
    ruleId: policyViolationId(message),
    message,
  }));
}

function integrityViolation(type: IntegrityViolationType, detail: string): IntegrityViolation {
  return { type, detail };
}

function formatIntegrityViolation(violation: IntegrityViolation): string {
  return `IntegrityViolation: type=${violation.type}; detail=${violation.detail}`;
}

function formatIntegrityViolations(violations: IntegrityViolation[]): string {
  return violations.map((entry) => formatIntegrityViolation(entry)).join("; ");
}

function normalizePreviewReference(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stateSnapshotForIntegrity(state: StatePlane): unknown {
  return {
    version: state.version,
    intent: state.intent,
    ast: state.ast,
    graph: state.graph,
    ruleViolations: state.ruleViolations,
    plans: state.plans,
    astIndex: state.astIndex,
    symbolGraph: state.symbolGraph,
    violations: state.violations,
    metrics: state.metrics,
    dependencyGraph: state.dependencyGraph,
    execution: state.execution,
    strategyHistory: state.strategyHistory,
  };
}

function hashExecutionStateSnapshot(state: StatePlane): string {
  return deterministicHash(stateSnapshotForIntegrity(state));
}

function safeReadStateSnapshot(root: string): { state: StatePlane; snapshotHash: string; readError?: string } {
  try {
    const state = readStatePlane(root) ?? createEmptyStatePlane();
    return {
      state,
      snapshotHash: hashExecutionStateSnapshot(state),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallback = createEmptyStatePlane();
    return {
      state: fallback,
      snapshotHash: hashExecutionStateSnapshot(fallback),
      readError: message,
    };
  }
}

function hashDagNodes(nodes: string[]): string {
  return deterministicHash([...nodes]);
}

function hashDagEdges(edges: Array<{ from: string; to: string }>): string {
  const canonical = [...edges]
    .map((edge) => ({ from: edge.from, to: edge.to }))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  return deterministicHash(canonical);
}

function hashCanonicalStages(stageGroups: Array<{ id: string; order: number; units: string[] }>): string {
  const canonical = [...stageGroups]
    .map((stage) => ({
      id: stage.id,
      order: stage.order,
      units: [...stage.units],
    }))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  return deterministicHash(canonical);
}

function buildExecutionIntegritySnapshot(input: {
  selected: RankedPlan;
  selectedExecutionPlan: Plan;
  controlPlane: ControlPlane;
  simulationContract: PipelineSimulationContract;
  executionDag: PipelineExecutionDAG;
  stateSnapshotHash: string;
  predictedExecutionHash: string;
  preWorkspaceSnapshotHash: string;
  postWorkspaceSnapshotHash: string;
}): ExecutionIntegritySnapshot {
  const nodeHash = hashDagNodes(input.executionDag.nodes);
  const edgeHash = hashDagEdges(input.executionDag.edges);
  const canonicalStageHash = hashCanonicalStages(input.executionDag.stageGroups);

  const payload = {
    planId: input.selectedExecutionPlan.id,
    strategyId: input.selected.strategyType,
    controlPlaneHash: deterministicHash(controlPlaneToChoirConfig(input.controlPlane)),
    previewHash: input.selected.previewHash,
    predictedExecutionHash: input.predictedExecutionHash,
    simulationFutureStateHash: input.simulationContract.futureStateHash,
    orchestrationHash: input.executionDag.hash,
    nodeHash,
    edgeHash,
    canonicalStageHash,
    stateSnapshotHash: input.stateSnapshotHash,
    preWorkspaceSnapshotHash: input.preWorkspaceSnapshotHash,
    postWorkspaceSnapshotHash: input.postWorkspaceSnapshotHash,
  };

  return {
    ...payload,
    integrityHash: deterministicHash(payload),
  };
}

function parseExecutionIntegritySnapshot(value: unknown): ExecutionIntegritySnapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const fields = [
    "planId",
    "strategyId",
    "controlPlaneHash",
    "previewHash",
    "predictedExecutionHash",
    "simulationFutureStateHash",
    "orchestrationHash",
    "nodeHash",
    "edgeHash",
    "canonicalStageHash",
    "stateSnapshotHash",
    "preWorkspaceSnapshotHash",
    "postWorkspaceSnapshotHash",
    "integrityHash",
  ] as const;

  if (!fields.every((field) => typeof record[field] === "string")) {
    return undefined;
  }

  return {
    planId: record.planId as string,
    strategyId: record.strategyId as string,
    controlPlaneHash: record.controlPlaneHash as string,
    previewHash: record.previewHash as string,
    predictedExecutionHash: record.predictedExecutionHash as string,
    simulationFutureStateHash: record.simulationFutureStateHash as string,
    orchestrationHash: record.orchestrationHash as string,
    nodeHash: record.nodeHash as string,
    edgeHash: record.edgeHash as string,
    canonicalStageHash: record.canonicalStageHash as string,
    stateSnapshotHash: record.stateSnapshotHash as string,
    preWorkspaceSnapshotHash: record.preWorkspaceSnapshotHash as string,
    postWorkspaceSnapshotHash: record.postWorkspaceSnapshotHash as string,
    integrityHash: record.integrityHash as string,
  };
}

type MaterializationTraceBinding = {
  previewHash: string;
  mutationHash: string;
  patchOrderHash?: string;
  preWorkspaceSnapshotId?: string;
  preWorkspaceSnapshotHash?: string;
  postWorkspaceSnapshotId?: string;
  postWorkspaceSnapshotHash?: string;
  workspaceHash: string;
  replayWorkspaceHash: string;
  manifestId: string;
  manifestHash: string;
};

function parseMaterializationTraceBinding(value: unknown): MaterializationTraceBinding | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const required = [
    "previewHash",
    "mutationHash",
    "workspaceHash",
    "replayWorkspaceHash",
    "manifestId",
    "manifestHash",
  ] as const;

  if (!required.every((field) => typeof record[field] === "string" && (record[field] as string).length > 0)) {
    return undefined;
  }

  return {
    previewHash: record.previewHash as string,
    mutationHash: record.mutationHash as string,
    ...(typeof record.patchOrderHash === "string" ? { patchOrderHash: record.patchOrderHash as string } : {}),
    ...(typeof record.preWorkspaceSnapshotId === "string" ? { preWorkspaceSnapshotId: record.preWorkspaceSnapshotId as string } : {}),
    ...(typeof record.preWorkspaceSnapshotHash === "string" ? { preWorkspaceSnapshotHash: record.preWorkspaceSnapshotHash as string } : {}),
    ...(typeof record.postWorkspaceSnapshotId === "string" ? { postWorkspaceSnapshotId: record.postWorkspaceSnapshotId as string } : {}),
    ...(typeof record.postWorkspaceSnapshotHash === "string" ? { postWorkspaceSnapshotHash: record.postWorkspaceSnapshotHash as string } : {}),
    workspaceHash: record.workspaceHash as string,
    replayWorkspaceHash: record.replayWorkspaceHash as string,
    manifestId: record.manifestId as string,
    manifestHash: record.manifestHash as string,
  };
}

function readMaterializationManifest(root: string, manifestId: string): Record<string, unknown> | undefined {
  const manifestPath = path.join(root, ".choir", "artifacts", "materialization", `${manifestId}.json`);
  if (!fs.existsSync(manifestPath)) {
    return undefined;
  }

  try {
    const raw = fs.readFileSync(manifestPath, "utf-8").trim();
    if (raw.length === 0) {
      return undefined;
    }

    const payload = JSON.parse(raw) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return undefined;
    }

    return payload as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readMaterializationManifestHash(root: string, manifestId: string): string | undefined {
  const payload = readMaterializationManifest(root, manifestId);
  return payload ? deterministicHash(payload) : undefined;
}

function currentWorkspaceSnapshotHash(root: string): string {
  return CanonicalWorkspaceHasher.capture(root).snapshotHash;
}

function topologicalOrderFromEdges(nodes: string[], edges: Array<{ from: string; to: string }>): { order: string[]; cyclic: boolean } {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const nodeId of nodes) {
    indegree.set(nodeId, 0);
    outgoing.set(nodeId, []);
  }

  for (const edge of edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) {
      continue;
    }

    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to].sort((left, right) => left.localeCompare(right)));
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([nodeId]) => nodeId)
    .sort((left, right) => left.localeCompare(right));
  const order: string[] = [];

  while (ready.length > 0) {
    const nodeId = ready.shift() as string;
    order.push(nodeId);

    for (const dependent of outgoing.get(nodeId) ?? []) {
      const nextDegree = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, nextDegree);
      if (nextDegree === 0) {
        ready.push(dependent);
        ready.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  return {
    order,
    cyclic: order.length !== nodes.length,
  };
}

function validateExecutionDagIntegrity(input: {
  executionDag: PipelineExecutionDAG;
  selected: RankedPlan;
  selectedExecutionPlan: Plan;
}): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  const dag = input.executionDag;
  const canonicalNodes = [...dag.nodes].sort((left, right) => left.localeCompare(right));
  if (deterministicHash(dag.nodes) !== deterministicHash(canonicalNodes)) {
    violations.push(integrityViolation("DAG_CANONICAL_ORDER_MISMATCH", "Execution DAG nodes are not in canonical order."));
  }

  const canonicalEdges = [...dag.edges]
    .map((edge) => ({ from: edge.from, to: edge.to }))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  if (deterministicHash(dag.edges) !== deterministicHash(canonicalEdges)) {
    violations.push(integrityViolation("DAG_CANONICAL_ORDER_MISMATCH", "Execution DAG edges are not in canonical order."));
  }

  const nodeSet = new Set(dag.nodes);
  const planTaskIds = sortedUnique(input.selectedExecutionPlan.tasks.map((task) => task.id));
  if (deterministicHash(planTaskIds) !== deterministicHash(canonicalNodes)) {
    violations.push(integrityViolation("DAG_HASH_MISMATCH", "Execution DAG nodes differ from selected execution plan task ids."));
  }

  for (const task of input.selectedExecutionPlan.tasks) {
    for (const dependencyId of task.dependsOn ?? []) {
      if (!nodeSet.has(dependencyId)) {
        violations.push(integrityViolation(
          "DAG_MISSING_NODE_REFERENCE",
          `Plan dependency ${dependencyId} referenced by ${task.id} is missing from execution DAG nodes.`
        ));
      }
    }
  }

  for (const edge of dag.edges) {
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) {
      violations.push(integrityViolation(
        "DAG_MISSING_NODE_REFERENCE",
        `Execution DAG edge ${edge.from} -> ${edge.to} references missing node(s).`
      ));
    }
  }

  const topo = topologicalOrderFromEdges(canonicalNodes, canonicalEdges);
  if (topo.cyclic) {
    violations.push(integrityViolation("DAG_CYCLE_DETECTED", "Execution DAG contains a dependency cycle."));
  }

  const canonicalStageGroups = [...dag.stageGroups]
    .map((stage) => ({
      id: stage.id,
      order: stage.order,
      units: [...stage.units],
    }))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  if (deterministicHash(dag.stageGroups) !== deterministicHash(canonicalStageGroups)) {
    violations.push(integrityViolation("DAG_CANONICAL_ORDER_MISMATCH", "Execution stage groups are not in canonical deterministic order."));
  }

  const topologicalOrder = canonicalStageGroups
    .flatMap((stage) => stage.units)
    .filter((unitId, index, all) => all.indexOf(unitId) === index);
  if (deterministicHash(topologicalOrder) !== deterministicHash(dag.topologicalOrder)) {
    violations.push(integrityViolation("DAG_CANONICAL_ORDER_MISMATCH", "Execution topological order diverges from stage-group projection."));
  }

  if (input.selected.orchestrationGraph.hash !== dag.hash) {
    violations.push(integrityViolation("DAG_HASH_MISMATCH", "Ranked orchestration graph hash differs from execution DAG hash."));
  }

  return violations;
}

function validateExecutionIntegrity(input: ExecutionIntegrityGateInput): ExecutionIntegrityGateResult {
  const violations: IntegrityViolation[] = [];
  const stateSnapshot = safeReadStateSnapshot(input.root);
  const workspaceSnapshotHash = currentWorkspaceSnapshotHash(input.root);
  if (stateSnapshot.readError) {
    violations.push(integrityViolation("STATE_SNAPSHOT_INVALID", stateSnapshot.readError));
  }

  const predictedExecutionHash = hashGlobalState(input.generatedSimulation.simulation.finalState);
  if (predictedExecutionHash !== input.simulationContract.futureStateHash) {
    violations.push(integrityViolation(
      "SIMULATION_EXECUTION_PARITY_MISMATCH",
      `simulation.futureStateHash=${input.simulationContract.futureStateHash} predictedExecutionHash=${predictedExecutionHash}`
    ));
  }

  const simulatedTrace = input.generatedSimulation.simulation.trace.deterministicTrace;
  if (!simulatedTrace) {
    violations.push(integrityViolation("REPLAY_PARITY_FAILURE", "Simulation trace is missing deterministic replay metadata."));
  } else {
    const replayHash = hashGlobalState(replay(simulatedTrace));
    if (replayHash !== input.simulationContract.replayHash) {
      violations.push(integrityViolation(
        "REPLAY_PARITY_FAILURE",
        `simulation.replayHash=${input.simulationContract.replayHash} computedReplayHash=${replayHash}`
      ));
    }
  }

  if (!input.replayVerification.verified) {
    violations.push(integrityViolation("REPLAY_PARITY_FAILURE", "Replay verification is not authoritative for this execution candidate."));
  }

  if (input.simulationContract.orchestrationHash !== input.executionDag.hash) {
    violations.push(integrityViolation(
      "ORCHESTRATION_HASH_MISMATCH",
      `simulation.orchestrationHash=${input.simulationContract.orchestrationHash} executionDag.hash=${input.executionDag.hash}`
    ));
  }

  if (input.selected.strategyType.trim() !== input.selected.strategyId.trim()) {
    violations.push(integrityViolation(
      "STRATEGY_ID_MISMATCH",
      `selected.strategyType=${input.selected.strategyType} selected.strategyId=${input.selected.strategyId}`
    ));
  }

  violations.push(...validateExecutionDagIntegrity({
    executionDag: input.executionDag,
    selected: input.selected,
    selectedExecutionPlan: input.selectedExecutionPlan,
  }));

  const snapshot = buildExecutionIntegritySnapshot({
    selected: input.selected,
    selectedExecutionPlan: input.selectedExecutionPlan,
    controlPlane: input.controlPlane,
    simulationContract: input.simulationContract,
    executionDag: input.executionDag,
    stateSnapshotHash: stateSnapshot.snapshotHash,
    predictedExecutionHash,
    preWorkspaceSnapshotHash: input.simulationContract.preWorkspaceSnapshotHash,
    postWorkspaceSnapshotHash: input.simulationContract.postWorkspaceSnapshotHash,
  });

  if (
    input.simulationContract.preWorkspaceSnapshotHash
    && input.simulationContract.preWorkspaceSnapshotHash !== workspaceSnapshotHash
  ) {
    violations.push(integrityViolation(
      "WORKSPACE_SNAPSHOT_DIVERGENCE",
      `simulation.preWorkspaceSnapshotHash=${input.simulationContract.preWorkspaceSnapshotHash} currentWorkspaceSnapshotHash=${workspaceSnapshotHash}`
    ));
  }

  const requestedPreviewRef = normalizePreviewReference(input.requestedPreviewRef);
  if (requestedPreviewRef && requestedPreviewRef !== snapshot.previewHash) {
    violations.push(integrityViolation(
      "PREVIEW_HASH_MISMATCH",
      `requestedPreviewRef=${requestedPreviewRef} currentPreviewHash=${snapshot.previewHash}`
    ));
  }

  const lastPreview = stateSnapshot.state.execution.lastPreview;
  if (lastPreview) {
    const lastPreviewHash = normalizePreviewReference(lastPreview.hash);
    if (lastPreviewHash && lastPreviewHash !== snapshot.previewHash) {
      violations.push(integrityViolation(
        "PREVIEW_HASH_MISMATCH",
        `state.lastPreview.hash=${lastPreviewHash} currentPreviewHash=${snapshot.previewHash}`
      ));
    }

    if (lastPreview.planId !== input.selectedExecutionPlan.id) {
      violations.push(integrityViolation(
        "STATE_LINEAGE_DIVERGENCE",
        `state.lastPreview.planId=${lastPreview.planId} selectedExecutionPlan.id=${input.selectedExecutionPlan.id}`
      ));
    }
  }

  const requiresHistoricalArtifact = Boolean(lastPreview) || Boolean(requestedPreviewRef);
  const latestTrace = readLatestOrchestrationTrace(input.root);
  if (requiresHistoricalArtifact && !latestTrace) {
    violations.push(integrityViolation(
      "REPLAY_LINEAGE_DIVERGENCE",
      "No orchestration trace artifact found for preview/simulation binding."
    ));
  }

  if (requiresHistoricalArtifact && latestTrace && latestTrace.status === "success") {
    const latestIntegrity = parseExecutionIntegritySnapshot((latestTrace.modeMetadata as Record<string, unknown> | undefined)?.integrity);
    if (!latestIntegrity) {
      violations.push(integrityViolation(
        "REPLAY_LINEAGE_DIVERGENCE",
        `Latest orchestration trace ${latestTrace.id} is missing integrity metadata.`
      ));
    } else {
      if (latestIntegrity.previewHash !== snapshot.previewHash) {
        violations.push(integrityViolation(
          "REPLAY_LINEAGE_DIVERGENCE",
          `latestTrace.previewHash=${latestIntegrity.previewHash} currentPreviewHash=${snapshot.previewHash}`
        ));
      }

      if (latestIntegrity.controlPlaneHash !== snapshot.controlPlaneHash) {
        violations.push(integrityViolation(
          "REPLAY_LINEAGE_DIVERGENCE",
          "Latest orchestration artifact control-plane hash differs from current control-plane hash."
        ));
      }

      if (latestIntegrity.stateSnapshotHash !== snapshot.stateSnapshotHash) {
        violations.push(integrityViolation(
          "STATE_LINEAGE_DIVERGENCE",
          `latestTrace.stateSnapshotHash=${latestIntegrity.stateSnapshotHash} currentStateSnapshotHash=${snapshot.stateSnapshotHash}`
        ));
      }

      if (
        latestIntegrity.preWorkspaceSnapshotHash
        && latestIntegrity.preWorkspaceSnapshotHash !== workspaceSnapshotHash
      ) {
        violations.push(integrityViolation(
          "WORKSPACE_SNAPSHOT_DIVERGENCE",
          `latestTrace.preWorkspaceSnapshotHash=${latestIntegrity.preWorkspaceSnapshotHash} currentWorkspaceSnapshotHash=${workspaceSnapshotHash}`
        ));
      }

      if (latestIntegrity.orchestrationHash !== snapshot.orchestrationHash
        || latestIntegrity.nodeHash !== snapshot.nodeHash
        || latestIntegrity.edgeHash !== snapshot.edgeHash) {
        violations.push(integrityViolation(
          "DAG_HASH_MISMATCH",
          "Latest orchestration artifact DAG signature differs from current deterministic DAG signature."
        ));
      }

      if (latestIntegrity.canonicalStageHash !== snapshot.canonicalStageHash) {
        violations.push(integrityViolation(
          "DAG_CANONICAL_ORDER_MISMATCH",
          "Latest orchestration artifact canonical stage ordering differs from current deterministic stage ordering."
        ));
      }

      if (latestIntegrity.predictedExecutionHash !== snapshot.predictedExecutionHash
        || latestIntegrity.simulationFutureStateHash !== snapshot.simulationFutureStateHash) {
        violations.push(integrityViolation(
          "SIMULATION_EXECUTION_PARITY_MISMATCH",
          "Latest simulation artifact future-state projection differs from current deterministic simulation projection."
        ));
      }

      if (latestIntegrity.strategyId !== snapshot.strategyId) {
        violations.push(integrityViolation(
          "STRATEGY_ID_MISMATCH",
          `latestTrace.strategyId=${latestIntegrity.strategyId} currentStrategyId=${snapshot.strategyId}`
        ));
      }
    }

    const latestMaterialization = parseMaterializationTraceBinding(
      (latestTrace.modeMetadata as Record<string, unknown> | undefined)?.materialization
    );
    if (latestMaterialization) {
      if (latestMaterialization.previewHash !== snapshot.previewHash) {
        violations.push(integrityViolation(
          "REPLAY_LINEAGE_DIVERGENCE",
          `latestMaterialization.previewHash=${latestMaterialization.previewHash} currentPreviewHash=${snapshot.previewHash}`
        ));
      }

      const persistedManifest = readMaterializationManifest(input.root, latestMaterialization.manifestId);
      const persistedManifestHash = readMaterializationManifestHash(input.root, latestMaterialization.manifestId);
      if (!persistedManifestHash || !persistedManifest) {
        violations.push(integrityViolation(
          "MANIFEST_TAMPER",
          `Materialization manifest missing or unreadable: ${latestMaterialization.manifestId}`
        ));
      } else if (persistedManifestHash !== latestMaterialization.manifestHash) {
        violations.push(integrityViolation(
          "MANIFEST_TAMPER",
          `Materialization manifest hash mismatch: expected=${latestMaterialization.manifestHash} actual=${persistedManifestHash}`
        ));
      } else {
        const persistedPostWorkspaceHash = typeof persistedManifest.postWorkspaceSnapshotHash === "string"
          ? persistedManifest.postWorkspaceSnapshotHash
          : latestMaterialization.postWorkspaceSnapshotHash;

        if (persistedPostWorkspaceHash && persistedPostWorkspaceHash !== workspaceSnapshotHash) {
          violations.push(integrityViolation(
            "WORKSPACE_SNAPSHOT_DIVERGENCE",
            `materialization.postWorkspaceSnapshotHash=${persistedPostWorkspaceHash} currentWorkspaceSnapshotHash=${workspaceSnapshotHash}`
          ));
        }

        if (persistedPostWorkspaceHash && typeof latestMaterialization.workspaceHash === "string" && latestMaterialization.workspaceHash !== persistedPostWorkspaceHash) {
          violations.push(integrityViolation(
            "REPLAY_LINEAGE_DIVERGENCE",
            `trace.workspaceHash=${latestMaterialization.workspaceHash} manifest.postWorkspaceSnapshotHash=${persistedPostWorkspaceHash}`
          ));
        }

        const patchOperations = (
          typeof persistedManifest.mutationSet === "object"
          && persistedManifest.mutationSet !== null
          && Array.isArray((persistedManifest.mutationSet as Record<string, unknown>).patchOperations)
        )
          ? (persistedManifest.mutationSet as Record<string, unknown>).patchOperations as Array<Record<string, unknown>>
          : [];

        const computedPatchOrderHash = deterministicHash(
          patchOperations.map((entry) => ({
            id: typeof entry.id === "string" ? entry.id : "",
            order: typeof entry.order === "number" ? entry.order : -1,
            patchHash: typeof entry.patchHash === "string" ? entry.patchHash : "",
            files: Array.isArray(entry.files) ? [...entry.files] : [],
          }))
        );

        const persistedPatchOrderHash = typeof persistedManifest.patchOrderHash === "string"
          ? persistedManifest.patchOrderHash
          : latestMaterialization.patchOrderHash;

        if (persistedPatchOrderHash && persistedPatchOrderHash !== computedPatchOrderHash) {
          violations.push(integrityViolation(
            "PATCH_ORDER_DIVERGENCE",
            `manifest.patchOrderHash=${persistedPatchOrderHash} computedPatchOrderHash=${computedPatchOrderHash}`
          ));
        }
      }
    }
  }

  return {
    valid: violations.length === 0,
    snapshot,
    violations,
  };
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
      policies: input.executionPolicies ?? [],
      stateRoot: input.root,
    })
    : await simulatePlan(globalPlan, {
      repos,
      policies: input.executionPolicies ?? [],
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
  const preWorkspaceSnapshotHash = currentWorkspaceSnapshotHash(input.root);

  if (!validated || !verified || !hashMatches) {
    throw new Error(`Simulation replay verification failed (trace=${validated}, replay=${verified}, hashMatch=${hashMatches}).`);
  }

  return {
    simulationContract: {
      futureStateHash,
      orchestrationHash: input.orchestrationHash,
      replayHash,
      mutationHash: "",
      projectedWorkspaceHash: "",
      preWorkspaceSnapshotHash,
      postWorkspaceSnapshotHash: preWorkspaceSnapshotHash,
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
  executionPolicies?: GlobalCompiledPolicy[];
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
    executionPolicies: input.executionPolicies,
  });

  const simulationContract = replaySimulation.simulationContract.futureStateHash === input.simulationContract.futureStateHash
    && replaySimulation.simulationContract.orchestrationHash === input.simulationContract.orchestrationHash
    && replaySimulation.simulationContract.replayHash === input.simulationContract.replayHash
    && replaySimulation.simulationContract.mutationHash === input.simulationContract.mutationHash
    && replaySimulation.simulationContract.projectedWorkspaceHash === input.simulationContract.projectedWorkspaceHash
    && replaySimulation.simulationContract.preWorkspaceSnapshotHash === input.simulationContract.preWorkspaceSnapshotHash
    && replaySimulation.simulationContract.postWorkspaceSnapshotHash === input.simulationContract.postWorkspaceSnapshotHash;

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
    mutationHash: "",
    projectedWorkspaceHash: "",
    preWorkspaceSnapshotHash: "",
    postWorkspaceSnapshotHash: "",
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

  let controlPlane: ControlPlane | undefined;
  let optimized: OptimizedPlanResult;
  let candidatePlans: PipelineCandidateView[] = [];
  let planComparisons: Array<{ from: string; to: string; diff: PlanDiff }> = [];
  let previewResult: PipelineResult["preview"];
  let simulateResult: PipelineResult["simulate"];
  let executeResult: PipelineResult["execute"];
  let integritySnapshot: ExecutionIntegritySnapshot | undefined;
  let integrityViolations: IntegrityViolation[] = [];
  let selectedForTrace: RankedPlan | undefined;
  let selectedExecutionPlanForTrace: Plan | undefined;
  let generatedSimulationForTrace: GenerateSimulationContractResult | undefined;

  try {
    const requestedPlanId = intent.requestedPlanId?.trim();

    try {
      controlPlane = intent.controlPlane ?? loadControlPlane(intent.root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail("compile", message);
    }

    if (!controlPlane) {
      return fail("compile", "Control plane could not be resolved for orchestration runtime.");
    }

    const activeControlPlane = controlPlane;

    try {
      compileInput(intent.command, activeControlPlane);
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
          ...activeControlPlane,
          execution: {
            ...activeControlPlane.execution,
            plans: activeControlPlane.execution.plans.filter((plan) => plan.id === requestedPlanId),
          },
        }
        : activeControlPlane;

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

    selectedForTrace = selected;

    selectedPlanId = selected.id;
    selectedStrategyType = selected.strategyType;
    planSource = selected.synthesized ? "synthesized" : "configured";

    candidatePlans = toCandidateView(optimized.rankedPlans, selected.id);
    planComparisons = toPlanComparisons(optimized.rankedPlans, selected);

    markSuccess("candidate-synthesis", `Synthesized ${candidatePlans.length} deterministic candidate plan(s).`);
    markSuccess("strategy-ranking", `Ranked ${candidatePlans.length} candidate plan(s) deterministically.`);
    markSuccess("strategy-selection", `Selected ${selected.id} via strategy ${selected.strategyType}.`);
    if (mode === "execute") {
      markSuccess("synthesize", `Selected deterministic orchestration candidate ${selected.id}.`);
    }

    executionDag = buildExecutionDAG(selected);
    markSuccess("orchestration-build", `Execution DAG built with hash ${executionDag.hash.slice(0, 12)}.`);
    if (mode === "execute") {
      markSuccess("analyze", `Analyzed workspace and execution DAG (hash=${executionDag.hash.slice(0, 12)}).`);
    }

    const selectedExecutionPlan = optimized.selectedExecutionPlan;
    selectedExecutionPlanForTrace = selectedExecutionPlan;
    const selectedExecutionControl = mergeExecutionPlan(activeControlPlane, selectedExecutionPlan);
    const diffs = computeDiff(
      controlPlaneToChoirConfig(activeControlPlane),
      controlPlaneToChoirConfig(selectedExecutionControl)
    );

    const environment = detectEnvironment();
    const context: ExecutionContext = {
      role: "conductor",
      environment,
    };
    const policySet = loadPolicies(intent.root, environment);
    const evaluation = evaluatePolicies(diffs, policySet, context);
    const executionPolicies = intent.executionPolicies ?? [];
    const selectedGlobalPlan = toGlobalPlanFromPlan(selectedExecutionPlan);
    const selectedRepos = buildSimulationRepos([selectedGlobalPlan]);
    const executionPolicyResult = evaluateCompiledGlobalPolicies(selectedGlobalPlan, executionPolicies, selectedRepos);
    const executionPolicyDenied = !executionPolicyResult.allowed && !executionPolicyResult.requiresApproval;
    const dslDecision = mapPolicyDecision(evaluation.trace.decision);
    const diffHash = hashDiff(diffs);
    const denied = dslDecision === "deny" || executionPolicyDenied;
    const requiresApproval = !denied && (evaluation.result.requiresApproval || executionPolicyResult.requiresApproval);
    policy = {
      decision: denied ? "deny" : (requiresApproval ? "require-approval" : "allow"),
      allowed: !denied,
      requiresApproval,
      diffHash,
      violations: [
        ...evaluation.result.violations,
        ...executionPolicyViolations(executionPolicyResult.violations),
      ],
    };

    if (!policy.allowed || policy.decision === "deny") {
      const violationSummary = policy.violations.length === 0
        ? "Denied by policy gate."
        : policy.violations.map((entry) => `[${entry.ruleId}] ${entry.message}`).join("; ");
      return fail("policy", `Policy denied orchestration: ${violationSummary}`);
    }

    markSuccess("policy", `Policy decision=${policy.decision} (diffHash=${policy.diffHash.slice(0, 12)}).`);

    const generatedSimulation = await generateSimulationContract({
      root: intent.root,
      selectedExecutionPlan,
      orchestrationHash: executionDag.hash,
      executionPolicies,
    });
    generatedSimulationForTrace = generatedSimulation;

    simulationContract = generatedSimulation.simulationContract;
    markSuccess("simulation", `Simulation contract generated (futureStateHash=${simulationContract.futureStateHash.slice(0, 12)}).`);

    const replayOutcome = await verifyReplayDeterminism({
      root: intent.root,
      command: intent.command,
      controlPlane: activeControlPlane,
      ...(intent.targetGoal ? { targetGoal: intent.targetGoal } : {}),
      selected: optimized,
      simulationContract,
      executionPolicies,
    });

    replayVerification = replayOutcome.replayVerification;
    if (!replayVerification.verified) {
      return fail("replay-verification", "Replay verification failed for unified orchestration runtime.");
    }

    markSuccess("replay-verification", "Replay verification confirmed deterministic synthesis, ranking, selection, DAG, and simulation contract.");

    if (mode === "execute") {
      const integrity = validateExecutionIntegrity({
        root: intent.root,
        controlPlane: activeControlPlane,
        requestedPreviewRef: intent.requestedPreviewRef,
        selected,
        selectedExecutionPlan,
        simulationContract,
        generatedSimulation,
        executionDag,
        replayVerification,
      });

      integritySnapshot = integrity.snapshot;
      integrityViolations = integrity.violations;

      if (!integrity.valid) {
        return fail("integrity", formatIntegrityViolations(integrity.violations));
      }

      markSuccess(
        "integrity",
        `Execution integrity gate passed (integrityHash=${integrity.snapshot.integrityHash.slice(0, 12)}).`
      );
    }

    if (policy.requiresApproval) {
      const dslApproved = !evaluation.result.requiresApproval
        || hasApprovalForPreview(intent.root, selected.previewHash)
        || hasApprovalForDiff(intent.root, policy.diffHash);
      const executionApprovalPreviewHash = executionPolicyResult.requiresApproval
        ? executionPreviewHash(
          selectedGlobalPlan,
          generatedSimulation.simulation.context.baseState,
          executionPolicyResult,
          generatedSimulation.simulation.trace.stepsExecuted
        )
        : undefined;
      const executionApproved = !executionPolicyResult.requiresApproval
        || (executionApprovalPreviewHash ? hasApprovalForPreview(intent.root, executionApprovalPreviewHash) : false);
      const approved = dslApproved && executionApproved;

      let pendingId: string | undefined;
      if (!approved && mode === "preview" && intent.recordPendingApproval !== false) {
        if (evaluation.result.requiresApproval && !dslApproved) {
          pendingId = upsertPendingPreviewApproval(intent.root, selected.previewHash, intent.command).pendingId;
        }
        if (executionApprovalPreviewHash && !executionApproved) {
          const pending = upsertPendingPreviewApproval(intent.root, executionApprovalPreviewHash, intent.command).pendingId;
          pendingId = pendingId ?? pending;
        }
      }

      approval = {
        required: true,
        approved,
        ...(pendingId ? { pendingId } : {}),
      };

      if (mode === "execute" && !approved) {
        const missingHashes = [
          ...(evaluation.result.requiresApproval && !dslApproved ? [selected.previewHash] : []),
          ...(executionApprovalPreviewHash && !executionApproved ? [executionApprovalPreviewHash] : []),
        ];
        return fail("approval", `Execution requires approval for previewHash=${missingHashes.join(", ") || selected.previewHash}.`);
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
    if (mode === "execute") {
      markSuccess("validate", "Deterministic validation gates passed (policy, replay, integrity, approval).");
    }

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
        preWorkspaceSnapshotHash: simulationContract.preWorkspaceSnapshotHash,
        postWorkspaceSnapshotHash: simulationContract.postWorkspaceSnapshotHash,
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
          policies: executionPolicies,
          stateRoot: intent.root,
        })
        : await simulatePlan(globalPlan, {
          repos,
          policies: executionPolicies,
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
        preWorkspaceSnapshotHash: simulationContract.preWorkspaceSnapshotHash,
        postWorkspaceSnapshotHash: simulationContract.postWorkspaceSnapshotHash,
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
      const materialization = await generateMaterializationPlan({
        root: intent.root,
        controlPlane: selectedExecutionControl,
        plan: selectedExecutionPlan,
        strategyId: selected.strategyType,
      });

      if (selected.previewHash !== materialization.mutationSet.previewHash) {
        return fail(
          "generate",
          `Generated preview hash mismatch: selected=${selected.previewHash}, generated=${materialization.mutationSet.previewHash}`
        );
      }

      simulationContract = {
        ...simulationContract,
        mutationHash: materialization.mutationSet.mutationHash,
        projectedWorkspaceHash: materialization.artifactManifest.workspaceHashAfter,
        preWorkspaceSnapshotHash: materialization.artifactManifest.preWorkspaceSnapshotHash,
        postWorkspaceSnapshotHash: materialization.artifactManifest.postWorkspaceSnapshotHash,
      };

      markSuccess(
        "generate",
        `Generated deterministic mutation set (mutationHash=${materialization.mutationSet.mutationHash.slice(0, 12)}).`
      );

      const applied = await applyMaterializationPlan({
        root: intent.root,
        controlPlane: selectedExecutionControl,
        plan: materialization,
      });

      if (!applied.success) {
        const message = `Transactional apply failed: ${applied.errors.join("; ") || "unknown apply failure"}`;
        if (applied.errors.some((entry) => /Forced rollback for testing/.test(entry))) {
          return fail("execution", message);
        }

        return fail("apply", message);
      }

      simulationContract = {
        ...simulationContract,
        preWorkspaceSnapshotHash: applied.preWorkspaceSnapshotHash,
        postWorkspaceSnapshotHash: applied.postWorkspaceSnapshotHash,
      };

      markSuccess(
        "apply",
        `Applied deterministic mutation transaction(s): ${applied.transactionIds.length}`
      );

      const verifyErrors: string[] = [];
      if (applied.mutationHash !== materialization.mutationSet.mutationHash) {
        verifyErrors.push(
          `mutationHash mismatch expected=${materialization.mutationSet.mutationHash} actual=${applied.mutationHash}`
        );
      }

      if (applied.workspaceHash !== materialization.artifactManifest.workspaceHashAfter) {
        verifyErrors.push(
          `workspaceHash mismatch expected=${materialization.artifactManifest.workspaceHashAfter} actual=${applied.workspaceHash}`
        );
      }

      if (applied.replayWorkspaceHash !== applied.workspaceHash) {
        verifyErrors.push(
          `replay workspace mismatch replay=${applied.replayWorkspaceHash} execution=${applied.workspaceHash}`
        );
      }

      if (applied.preWorkspaceSnapshotHash !== materialization.artifactManifest.preWorkspaceSnapshotHash) {
        verifyErrors.push(
          `preWorkspaceSnapshotHash mismatch expected=${materialization.artifactManifest.preWorkspaceSnapshotHash} actual=${applied.preWorkspaceSnapshotHash}`
        );
      }

      if (applied.postWorkspaceSnapshotHash !== materialization.artifactManifest.postWorkspaceSnapshotHash) {
        verifyErrors.push(
          `postWorkspaceSnapshotHash mismatch expected=${materialization.artifactManifest.postWorkspaceSnapshotHash} actual=${applied.postWorkspaceSnapshotHash}`
        );
      }

      const replayReconstruction = await replayMaterializationFromLineage({
        root: intent.root,
        manifestId: applied.manifestId,
        restore: false,
      });

      if (!replayReconstruction.success) {
        verifyErrors.push(
          `replay reconstruction failed: ${replayReconstruction.errors.join(" | ")}`
        );
      } else if (replayReconstruction.workspaceHash !== applied.workspaceHash) {
        verifyErrors.push(
          `replay reconstruction workspace mismatch replay=${replayReconstruction.workspaceHash} execution=${applied.workspaceHash}`
        );
      }

      if (verifyErrors.length > 0) {
        return fail("verify", `Materialization verification failed: ${verifyErrors.join("; ")}`);
      }

      markSuccess(
        "verify",
        `Verified mutation parity (workspaceHash=${applied.workspaceHash.slice(0, 12)}).`
      );

      const transactionId = applied.transactionIds[applied.transactionIds.length - 1]
        ?? deterministicId("tx", {
          planId: selectedExecutionPlan.id,
          strategyId: selected.strategyType,
          workspaceHash: applied.workspaceHash,
        }, 16);

      executeResult = {
        transactionId,
        executionHash: deterministicHash({
          transactionId,
          planId: selectedExecutionPlan.id,
          strategyId: selected.strategyType,
          finalStateHash: simulationContract.futureStateHash,
          replayHash: simulationContract.replayHash,
          mutationHash: applied.mutationHash,
          patchOrderHash: materialization.artifactManifest.patchOrderHash,
          workspaceHash: applied.workspaceHash,
          replayWorkspaceHash: applied.replayWorkspaceHash,
          preWorkspaceSnapshotHash: applied.preWorkspaceSnapshotHash,
          postWorkspaceSnapshotHash: applied.postWorkspaceSnapshotHash,
          preWorkspaceSnapshotId: applied.preWorkspaceSnapshotId,
          postWorkspaceSnapshotId: applied.postWorkspaceSnapshotId,
          manifestId: applied.manifestId,
          manifestHash: applied.manifestHash,
        }),
        finalStateHash: simulationContract.futureStateHash,
        replayHash: simulationContract.replayHash,
        mutationHash: applied.mutationHash,
        patchOrderHash: materialization.artifactManifest.patchOrderHash,
        workspaceHash: applied.workspaceHash,
        replayWorkspaceHash: applied.replayWorkspaceHash,
        preWorkspaceSnapshotHash: applied.preWorkspaceSnapshotHash,
        postWorkspaceSnapshotHash: applied.postWorkspaceSnapshotHash,
        preWorkspaceSnapshotId: applied.preWorkspaceSnapshotId,
        postWorkspaceSnapshotId: applied.postWorkspaceSnapshotId,
        manifestId: applied.manifestId,
        manifestHash: applied.manifestHash,
        executionStages: optimized.executionStages.map((stage) => ({
          id: stage.id,
          order: stage.order,
          units: sortedUnique(stage.units),
        })),
        rollbackScope: {
          unitIds: sortedUnique(optimized.rollbackScope.unitIds),
          stageIds: sortedUnique(optimized.rollbackScope.stageIds),
          complexity: optimized.rollbackScope.complexity,
        },
        deterministic: true,
        verified: true,
        success: true,
        strategyId: selected.strategyType,
        planId: selectedExecutionPlan.id,
        planSource,
        simulationFutureStateHash: simulationContract.futureStateHash,
      };

      markSuccess(
        "commit",
        `Committed materialization manifest ${applied.manifestId} (hash=${applied.manifestHash.slice(0, 12)}).`
      );
      markSuccess(
        "execution",
        `Execution committed transaction ${executeResult.transactionId} with deterministic materialization parity.`
      );
    }

    if (!integritySnapshot && selectedForTrace && selectedExecutionPlanForTrace && generatedSimulationForTrace && controlPlane) {
      const stateSnapshot = safeReadStateSnapshot(intent.root);
      if (stateSnapshot.readError) {
        integrityViolations = [
          ...integrityViolations,
          integrityViolation("STATE_SNAPSHOT_INVALID", stateSnapshot.readError),
        ];
      }

      integritySnapshot = buildExecutionIntegritySnapshot({
        selected: selectedForTrace,
        selectedExecutionPlan: selectedExecutionPlanForTrace,
        controlPlane,
        simulationContract,
        executionDag,
        stateSnapshotHash: stateSnapshot.snapshotHash,
        predictedExecutionHash: hashGlobalState(generatedSimulationForTrace.simulation.finalState),
        preWorkspaceSnapshotHash: simulationContract.preWorkspaceSnapshotHash,
        postWorkspaceSnapshotHash: simulationContract.postWorkspaceSnapshotHash,
      });
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
        ...(executeResult
          ? {
            materialization: {
              previewHash: selected.previewHash,
              mutationHash: executeResult.mutationHash,
              patchOrderHash: executeResult.patchOrderHash,
              workspaceHash: executeResult.workspaceHash,
              replayWorkspaceHash: executeResult.replayWorkspaceHash,
              preWorkspaceSnapshotHash: executeResult.preWorkspaceSnapshotHash,
              postWorkspaceSnapshotHash: executeResult.postWorkspaceSnapshotHash,
              preWorkspaceSnapshotId: executeResult.preWorkspaceSnapshotId,
              postWorkspaceSnapshotId: executeResult.postWorkspaceSnapshotId,
              manifestId: executeResult.manifestId,
              manifestHash: executeResult.manifestHash,
            },
          }
          : {}),
        ...(integritySnapshot ? { integrity: integritySnapshot } : {}),
        ...(integrityViolations.length > 0
          ? { integrityViolations: integrityViolations.map((entry) => formatIntegrityViolation(entry)) }
          : {}),
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
        ...(executeResult
          ? {
            materialization: {
              previewHash: selected.previewHash,
              mutationHash: executeResult.mutationHash,
              patchOrderHash: executeResult.patchOrderHash,
              workspaceHash: executeResult.workspaceHash,
              replayWorkspaceHash: executeResult.replayWorkspaceHash,
              preWorkspaceSnapshotHash: executeResult.preWorkspaceSnapshotHash,
              postWorkspaceSnapshotHash: executeResult.postWorkspaceSnapshotHash,
              preWorkspaceSnapshotId: executeResult.preWorkspaceSnapshotId,
              postWorkspaceSnapshotId: executeResult.postWorkspaceSnapshotId,
              manifestId: executeResult.manifestId,
              manifestHash: executeResult.manifestHash,
            },
          }
          : {}),
        ...(integritySnapshot ? { integrity: integritySnapshot } : {}),
        ...(integrityViolations.length > 0
          ? { integrityViolations: integrityViolations.map((entry) => formatIntegrityViolation(entry)) }
          : {}),
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
      : inferFailedStage(mode, stageResults);
    const message = error instanceof Error ? error.message : String(error);

    if (!(error instanceof OrchestrationPipelineError) && !stageResults.some((stage) => stage.status === "failure")) {
      stageResults.push({
        stage: failedStage,
        status: "failure",
        detail: message,
      });
    }

    if (!integritySnapshot && selectedForTrace && selectedExecutionPlanForTrace && generatedSimulationForTrace && controlPlane) {
      const stateSnapshot = safeReadStateSnapshot(intent.root);
      if (stateSnapshot.readError) {
        integrityViolations = [
          ...integrityViolations,
          integrityViolation("STATE_SNAPSHOT_INVALID", stateSnapshot.readError),
        ];
      }

      integritySnapshot = buildExecutionIntegritySnapshot({
        selected: selectedForTrace,
        selectedExecutionPlan: selectedExecutionPlanForTrace,
        controlPlane,
        simulationContract,
        executionDag,
        stateSnapshotHash: stateSnapshot.snapshotHash,
        predictedExecutionHash: hashGlobalState(generatedSimulationForTrace.simulation.finalState),
        preWorkspaceSnapshotHash: simulationContract.preWorkspaceSnapshotHash,
        postWorkspaceSnapshotHash: simulationContract.postWorkspaceSnapshotHash,
      });
    }

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
        ...(integritySnapshot ? { integrity: integritySnapshot } : {}),
        ...(integrityViolations.length > 0
          ? { integrityViolations: integrityViolations.map((entry) => formatIntegrityViolation(entry)) }
          : {}),
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
        ...(integritySnapshot ? { integrity: integritySnapshot } : {}),
        ...(integrityViolations.length > 0
          ? { integrityViolations: integrityViolations.map((entry) => formatIntegrityViolation(entry)) }
          : {}),
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
