import { createHash } from "crypto";
import { ControlPlane, Plan } from "../schema.js";
import {
  CompilerError,
  CompilerPipelineError,
  compileInput,
  formatCompilerErrors,
} from "./compilerPipeline.js";
import { buildWorkspaceSnapshot } from "./context.js";
import { controlPlaneToChoirConfig } from "./dslYamlCompiler.js";
import { FileChange } from "./executionPreview.js";
import { generatePlan } from "./orchestration.js";
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
  hasApprovalForDiff,
  hasApprovalForPreview,
  hashState,
  materializeStatePlane,
  readStatePlane,
  StatePlane,
  upsertPendingPreviewApproval,
  updateExecutionState,
} from "./state.js";
import {
  appendPipelineDiagnosticsRecordIfPossible,
  type PipelineDiagnosticsSource,
} from "./pipelineDiagnostics.js";
import {
  adaptiveStrategySelection,
  buildStrategyTrace,
  StrategyOutcome,
  StrategyTrace,
} from "./strategyPlanner.js";
import { Diagnostic } from "./types.js";

export type PreviewSynthesisStageName =
  | "compile"
  | "structural-validation"
  | "semantic-validation"
  | "cross-node-validation"
  | "pipeline"
  | "state"
  | "plan"
  | "candidate-synthesis"
  | "strategy-ranking"
  | "strategy-selection"
  | "orchestration-build"
  | "strategy"
  | "policy"
  | "simulation"
  | "replay-verification"
  | "approval";

export type PreviewSynthesisStageResult = {
  stage: PreviewSynthesisStageName;
  status: "success" | "failure";
  detail: string;
};

export type PreviewExecutionStage = {
  id: string;
  parallelizable: boolean;
  workUnits: {
    id: string;
    type: string;
    tasks: string[];
    files: string[];
  }[];
};

export type PreviewPolicyResult = {
  decision: "allow" | "require-approval" | "deny";
  allowed: boolean;
  requiresApproval: boolean;
  diffHash: string;
  violations: { ruleId: string; message: string }[];
};

export type PreviewApprovalBinding = {
  required: boolean;
  approved: boolean;
  pendingId?: string;
};

export type PreviewSynthesisContract = {
  command: string;
  planId: string;
  basePlanId: string;
  planSource: "configured" | "synthesized";
  strategyId: string;
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
  executionStages: PreviewExecutionStage[];
  stageResults: PreviewSynthesisStageResult[];
  strategyTrace: StrategyTrace;
  policy: PreviewPolicyResult;
  approval: PreviewApprovalBinding;
  selectedPlan: Plan;
};

export type SynthesizePreviewContractOptions = {
  root: string;
  controlPlane: ControlPlane;
  command: string;
  requestedPlanId?: string;
  persistPreviewState?: boolean;
  recordPendingApproval?: boolean;
  diagnosticsSource?: PipelineDiagnosticsSource;
};

export class PreviewSynthesisError extends Error {
  readonly failedStage: PreviewSynthesisStageName;
  readonly stageResults: PreviewSynthesisStageResult[];
  readonly compilerErrors?: CompilerError[];

  constructor(input: {
    failedStage: PreviewSynthesisStageName;
    message: string;
    stageResults: PreviewSynthesisStageResult[];
    compilerErrors?: CompilerError[];
  }) {
    super(input.message);
    this.name = "PreviewSynthesisError";
    this.failedStage = input.failedStage;
    this.stageResults = input.stageResults;
    this.compilerErrors = input.compilerErrors;
  }
}

function sortedPlans(plans: Plan[]): Plan[] {
  return [...plans].sort((left, right) => left.id.localeCompare(right.id));
}

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function stableDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((left, right) => {
    if (left.location.file !== right.location.file) return left.location.file.localeCompare(right.location.file);
    if (left.location.start.line !== right.location.start.line) return left.location.start.line - right.location.start.line;
    if (left.location.start.character !== right.location.start.character) {
      return left.location.start.character - right.location.start.character;
    }
    if (left.ruleId !== right.ruleId) return left.ruleId.localeCompare(right.ruleId);
    return left.id.localeCompare(right.id);
  });
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

function materializePreviewState(
  controlPlane: ControlPlane,
  currentState: StatePlane,
  diagnostics: Diagnostic[],
  filesScanned: number
): StatePlane {
  const normalizedDiagnostics = stableDiagnostics(diagnostics);
  const dependencyGraph = { ...currentState.dependencyGraph };

  for (const diagnostic of normalizedDiagnostics) {
    const file = normalizePath(diagnostic.location.file);
    if (!Object.prototype.hasOwnProperty.call(dependencyGraph, file)) {
      dependencyGraph[file] = [];
    }
  }

  return materializeStatePlane({
    ...currentState,
    intent: {
      goals: [...controlPlane.intent.goals],
      constraints: [...controlPlane.intent.constraints],
      nonGoals: [...controlPlane.intent["non-goals"]],
    },
    violations: normalizedDiagnostics,
    dependencyGraph,
    metrics: {
      ...currentState.metrics,
      diagnostics: normalizedDiagnostics.length,
      filesScanned,
    },
  });
}

function selectBasePlan(
  controlPlane: ControlPlane,
  state: StatePlane,
  requestedPlanId?: string
): { basePlan: Plan; source: "configured" | "synthesized" } {
  const plans = sortedPlans(controlPlane.execution.plans);

  if (requestedPlanId) {
    const requested = plans.find((plan) => plan.id === requestedPlanId);
    if (!requested) {
      throw new Error(`Plan not found: ${requestedPlanId}`);
    }

    return {
      basePlan: requested,
      source: "configured",
    };
  }

  const approved = plans.find((plan) => plan.status === "approved");
  if (approved) {
    return {
      basePlan: approved,
      source: "configured",
    };
  }

  const firstConfigured = plans[0];
  if (firstConfigured) {
    return {
      basePlan: firstConfigured,
      source: "configured",
    };
  }

  const generated = generatePlan(controlPlane, state);
  return {
    basePlan: generated,
    source: "synthesized",
  };
}

function toExecutionStages(plan: Plan): PreviewExecutionStage[] {
  const built = buildExecutionPlan([plan]);

  return [...built.executionPlan.batches]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((batch) => ({
      id: batch.id,
      parallelizable: batch.parallelizable,
      workUnits: [...batch.workUnits]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((unit) => ({
          id: unit.id,
          type: unit.type,
          tasks: [...unit.tasks].map((task) => task.id).sort((left, right) => left.localeCompare(right)),
          files: [...unit.files].map((file) => normalizePath(file)).sort((left, right) => left.localeCompare(right)),
        })),
    }));
}

function simulationHash(input: {
  stateHash: string;
  previewHash: string;
  strategyId: string;
  executionStages: PreviewExecutionStage[];
  diagnostics: Diagnostic[];
}): string {
  const payload = JSON.stringify({
    stateHash: input.stateHash,
    previewHash: input.previewHash,
    strategyId: input.strategyId,
    executionStages: input.executionStages,
    diagnostics: input.diagnostics.map((diagnostic) => diagnostic.id),
  });

  return createHash("sha256").update(payload).digest("hex");
}

function outcomeRankingSignature(outcomes: StrategyOutcome[]): string {
  const ranked = [...outcomes].sort((left, right) => {
    const leftRisk = left.metrics.remainingViolations + left.metrics.introducedErrors + left.metrics.filesChanged;
    const rightRisk = right.metrics.remainingViolations + right.metrics.introducedErrors + right.metrics.filesChanged;
    return leftRisk - rightRisk
      || left.metrics.filesChanged - right.metrics.filesChanged
      || left.metrics.patchesCount - right.metrics.patchesCount
      || left.strategyId.localeCompare(right.strategyId)
      || left.plan.id.localeCompare(right.plan.id);
  });

  return createHash("sha256")
    .update(JSON.stringify(ranked.map((candidate) => `${candidate.strategyId}:${candidate.plan.id}`)))
    .digest("hex");
}

function failSynthesis(
  stage: PreviewSynthesisStageName,
  message: string,
  stageResults: PreviewSynthesisStageResult[],
  compilerErrors?: CompilerError[]
): never {
  throw new PreviewSynthesisError({
    failedStage: stage,
    message,
    stageResults,
    ...(compilerErrors ? { compilerErrors } : {}),
  });
}

export async function synthesizePreviewContract(
  options: SynthesizePreviewContractOptions
): Promise<PreviewSynthesisContract> {
  const diagnosticsSource = options.diagnosticsSource ?? "chat";
  const stageResults: PreviewSynthesisStageResult[] = [];
  let candidatePlansMetadata: Array<Record<string, unknown>> = [];
  let planComparisonsMetadata: Array<Record<string, unknown>> = [];
  let selectedCandidateId = "";
  const markSuccess = (stage: PreviewSynthesisStageName, detail: string): void => {
    stageResults.push({
      stage,
      status: "success",
      detail,
    });
  };
  const fail = (stage: PreviewSynthesisStageName, detail: string, compilerErrors?: CompilerError[]): never => {
    stageResults.push({
      stage,
      status: "failure",
      detail,
    });

    appendPipelineDiagnosticsRecordIfPossible(options.root, {
      command: options.command,
      source: diagnosticsSource,
      category: "preview",
      result: "failure",
      summary: `Preview synthesis failed at ${stage}: ${detail}`,
      stages: stageResults,
      metadata: {
        selectedCandidateId,
        candidatePlans: candidatePlansMetadata,
        planComparisons: planComparisonsMetadata,
      },
    });

    return failSynthesis(stage, detail, stageResults, compilerErrors);
  };

  try {
    compileInput(options.command, options.controlPlane);
    markSuccess("compile", "Compiler gates passed for preview command.");
    markSuccess("structural-validation", "Structural validation passed.");
    markSuccess("semantic-validation", "Semantic validation passed.");
    markSuccess("cross-node-validation", "Cross-node validation passed.");
  } catch (error) {
    if (error instanceof CompilerPipelineError) {
      return fail("compile", formatCompilerErrors(error.errors), error.errors);
    }

    const message = error instanceof Error ? error.message : String(error);
    return fail("compile", message);
  }

  const workspace = buildWorkspaceSnapshot(options.root);

  let pipelineDiagnostics: Diagnostic[] = [];
  try {
    const pipeline = await runPipeline({
      controlPlane: options.controlPlane,
      workspace,
      persistState: false,
    });

    pipelineDiagnostics = stableDiagnostics(pipeline.diagnostics);
    markSuccess("pipeline", `Pipeline simulation completed (diagnostics=${pipelineDiagnostics.length}).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("pipeline", message);
  }

  let previewState: StatePlane;
  try {
    const currentState = readStatePlane(options.root) ?? createEmptyStatePlane();
    previewState = materializePreviewState(options.controlPlane, currentState, pipelineDiagnostics, workspace.files.length);
    markSuccess("state", `State synthesized deterministically (hash=${hashState(previewState).slice(0, 12)}).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("state", message);
  }

  let selectedBasePlan: Plan;
  let planSource: "configured" | "synthesized";
  try {
    const selected = selectBasePlan(options.controlPlane, previewState, options.requestedPlanId);
    selectedBasePlan = selected.basePlan;
    planSource = selected.source;
    markSuccess("plan", `Selected base plan ${selectedBasePlan.id} (${planSource}).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("plan", message);
  }

  const executionControl = mergeExecutionPlan(options.controlPlane, selectedBasePlan);

  let selectedPlan: Plan;
  let strategyId: string;
  let fileChanges: FileChange[];
  let diagnostics: Diagnostic[];
  let previewHash: string;
  let strategyTrace: StrategyTrace;
  let summary: PreviewSynthesisContract["summary"];
  let outcomeRankingHash = "";
  try {
    const adaptive = await adaptiveStrategySelection(selectedBasePlan, previewState, {
      controlPlane: executionControl,
      root: options.root,
    });

    const rankedCandidates = [...adaptive.outcomes].sort((left, right) => {
      const leftRisk = left.metrics.remainingViolations + left.metrics.introducedErrors + left.metrics.filesChanged;
      const rightRisk = right.metrics.remainingViolations + right.metrics.introducedErrors + right.metrics.filesChanged;
      return leftRisk - rightRisk
        || left.metrics.filesChanged - right.metrics.filesChanged
        || left.metrics.patchesCount - right.metrics.patchesCount
        || left.strategyId.localeCompare(right.strategyId)
        || left.plan.id.localeCompare(right.plan.id);
    });

    candidatePlansMetadata = rankedCandidates.map((candidate, index) => {
      const riskScore = candidate.metrics.remainingViolations
        + candidate.metrics.introducedErrors
        + candidate.metrics.filesChanged;
      const rollbackComplexity = candidate.plan.tasks.length;
      const blastRadius = candidate.metrics.filesChanged;
      const stages = toExecutionStages(candidate.plan).length;
      const selected = candidate.strategyId === adaptive.selected.strategyId && candidate.plan.id === adaptive.selected.plan.id;

      return {
        id: candidate.plan.id,
        strategyType: candidate.strategyId,
        rank: index + 1,
        selected,
        riskScore,
        rollbackComplexity,
        blastRadius,
        stages,
      };
    });

    selectedCandidateId = adaptive.selected.plan.id;
    const selectedEntry = candidatePlansMetadata.find((entry) => entry.id === selectedCandidateId) ?? null;
    planComparisonsMetadata = candidatePlansMetadata
      .filter((entry) => entry.id !== selectedCandidateId)
      .map((entry) => ({
        from: selectedCandidateId,
        to: entry.id,
        diff: {
          riskDelta: Number(entry.riskScore ?? 0) - Number(selectedEntry?.riskScore ?? 0),
          rollbackDelta: Number(entry.rollbackComplexity ?? 0) - Number(selectedEntry?.rollbackComplexity ?? 0),
          graphDelta: Number(entry.stages ?? 0) - Number(selectedEntry?.stages ?? 0),
        },
      }));

    outcomeRankingHash = outcomeRankingSignature(adaptive.outcomes);

    markSuccess("candidate-synthesis", `Synthesized ${adaptive.outcomes.length} deterministic candidate plans.`);
    markSuccess("strategy-ranking", `Ranked ${adaptive.outcomes.length} candidate plans deterministically.`);

    selectedPlan = adaptive.selected.plan;
    strategyId = adaptive.selected.strategyId;
    fileChanges = adaptive.selected.fileChanges;
    diagnostics = adaptive.selected.diagnostics;
    previewHash = adaptive.selected.previewHash;
    summary = {
      filesChanged: adaptive.selected.metrics.filesChanged,
      patchesCount: adaptive.selected.metrics.patchesCount,
      remainingViolations: adaptive.selected.metrics.remainingViolations,
      introducedErrors: adaptive.selected.metrics.introducedErrors,
    };
    strategyTrace = buildStrategyTrace(adaptive.outcomes, adaptive.selected, adaptive.adaptiveTrace);

    markSuccess("strategy-selection", `Selected strategy ${strategyId} (plan=${selectedPlan.id}).`);
    markSuccess("strategy", `Selected strategy ${strategyId} from ${adaptive.outcomes.length} deterministic candidates.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("strategy", message);
  }

  let executionStages: PreviewExecutionStage[];
  let stateHashValue: string;
  let simulationHashValue: string;
  try {
    executionStages = toExecutionStages(selectedPlan);
    stateHashValue = hashState(previewState);
    simulationHashValue = simulationHash({
      stateHash: stateHashValue,
      previewHash,
      strategyId,
      executionStages,
      diagnostics,
    });

    markSuccess("orchestration-build", `Execution DAG built with ${executionStages.length} stage(s).`);
    markSuccess("simulation", `Simulation contract generated (previewHash=${previewHash.slice(0, 12)}).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("simulation", message);
  }

  try {
    const replay = await adaptiveStrategySelection(selectedBasePlan, previewState, {
      controlPlane: executionControl,
      root: options.root,
    });

    const replayRankingSignature = outcomeRankingSignature(replay.outcomes);

    const replaySelected = replay.selected.strategyId === strategyId && replay.selected.plan.id === selectedPlan.id;
    const replayRankingStable = replayRankingSignature === outcomeRankingHash;

    if (!replaySelected || !replayRankingStable) {
      return fail("replay-verification", "Replay verification failed for preview candidate synthesis/ranking/selection.");
    }

    markSuccess("replay-verification", "Replay verification confirmed deterministic candidate synthesis/ranking/selection.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("replay-verification", message);
  }

  let policy: PreviewPolicyResult;
  try {
    const selectedExecutionControl = mergeExecutionPlan(options.controlPlane, selectedPlan);
    const diffs = computeDiff(
      controlPlaneToChoirConfig(options.controlPlane),
      controlPlaneToChoirConfig(selectedExecutionControl)
    );

    const environment = detectEnvironment();
    const context: ExecutionContext = {
      role: "conductor",
      environment,
    };

    const policySet = loadPolicies(options.root, environment);
    const evaluation = evaluatePolicies(diffs, policySet, context);
    const diffHash = hashDiff(diffs);

    policy = {
      decision: evaluation.trace.decision,
      allowed: evaluation.result.allowed,
      requiresApproval: evaluation.result.requiresApproval,
      diffHash,
      violations: evaluation.result.violations,
    };

    if (!policy.allowed) {
      const violationSummary = policy.violations.length === 0
        ? "Denied by policy gate."
        : policy.violations.map((entry) => `[${entry.ruleId}] ${entry.message}`).join("; ");
      return fail("policy", `Policy denied preview contract: ${violationSummary}`);
    }

    markSuccess("policy", `Policy decision=${policy.decision} (diffHash=${diffHash.slice(0, 12)}).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("policy", message);
  }

  let approval: PreviewApprovalBinding = {
    required: false,
    approved: true,
  };

  try {
    if (policy.requiresApproval) {
      const approved = hasApprovalForPreview(options.root, previewHash)
        || hasApprovalForDiff(options.root, policy.diffHash);

      let pendingId: string | undefined;
      if (!approved && options.recordPendingApproval !== false) {
        const pending = upsertPendingPreviewApproval(options.root, previewHash, options.command);
        pendingId = pending.pendingId;
      }

      approval = {
        required: true,
        approved,
        ...(pendingId ? { pendingId } : {}),
      };
    }

    if (options.persistPreviewState !== false) {
      updateExecutionState(options.root, (current) => ({
        ...current,
        lastPreview: {
          hash: previewHash,
          planId: selectedPlan.id,
          strategyId,
        },
      }));
    }

    if (approval.required && !approval.approved) {
      const pendingSuffix = approval.pendingId ? ` (pending=${approval.pendingId})` : "";
      markSuccess("approval", `Approval required before execution${pendingSuffix}.`);
    } else {
      markSuccess("approval", "Preview hash is execution-ready (approval satisfied)." );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("approval", message);
  }

  appendPipelineDiagnosticsRecordIfPossible(options.root, {
    command: options.command,
    source: diagnosticsSource,
    category: "preview",
    result: "success",
    summary: `Preview synthesized for ${selectedPlan.id} (${strategyId})`,
    stages: stageResults,
    metadata: {
      selectedCandidateId,
      selectedStrategyType: strategyId,
      previewHash,
      simulationHash: simulationHashValue,
      candidatePlans: candidatePlansMetadata,
      planComparisons: planComparisonsMetadata,
    },
  });

  return {
    command: options.command,
    planId: selectedPlan.id,
    basePlanId: selectedBasePlan.id,
    planSource,
    strategyId,
    previewHash,
    simulationHash: simulationHashValue,
    stateHash: stateHashValue,
    summary,
    diagnostics,
    fileChanges,
    executionStages,
    stageResults,
    strategyTrace,
    policy,
    approval,
    selectedPlan,
  };
}
