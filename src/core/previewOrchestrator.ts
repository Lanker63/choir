import { ControlPlane, Plan } from "../schema.js";
import {
  OrchestrationPipelineError,
  runOrchestrationPipeline,
  type PipelineStageName,
  type PipelineStageResult,
} from "./orchestrationRuntime.js";
import { type PipelineDiagnosticsSource } from "./pipelineDiagnostics.js";
import { type FileChange } from "./executionPreview.js";
import { type Diagnostic } from "./types.js";
import { type StrategyTrace } from "./strategyPlanner.js";

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

  constructor(input: {
    failedStage: PreviewSynthesisStageName;
    message: string;
    stageResults: PreviewSynthesisStageResult[];
  }) {
    super(input.message);
    this.name = "PreviewSynthesisError";
    this.failedStage = input.failedStage;
    this.stageResults = input.stageResults;
  }
}

function mapStage(stage: PipelineStageName): PreviewSynthesisStageName {
  if (stage === "compile") return "compile";
  if (stage === "structural-validation") return "structural-validation";
  if (stage === "semantic-validation") return "semantic-validation";
  if (stage === "cross-node-validation") return "cross-node-validation";
  if (stage === "candidate-synthesis") return "candidate-synthesis";
  if (stage === "strategy-ranking") return "strategy-ranking";
  if (stage === "strategy-selection") return "strategy-selection";
  if (stage === "orchestration-build") return "orchestration-build";
  if (stage === "simulation") return "simulation";
  if (stage === "replay-verification") return "replay-verification";
  if (stage === "policy") return "policy";
  return "approval";
}

function toStageResults(
  stages: PipelineStageResult[],
  contract: {
    planId: string;
    strategyId: string;
    stateHash: string;
  } | undefined
): PreviewSynthesisStageResult[] {
  const mapped = stages.map((stage) => ({
    stage: mapStage(stage.stage),
    status: stage.status,
    detail: stage.detail,
  }));

  const details = contract ?? {
    planId: "unresolved",
    strategyId: "unresolved",
    stateHash: "unknown",
  };

  return [
    { stage: "pipeline", status: "success", detail: "Unified orchestration kernel executed for preview mode." },
    { stage: "state", status: "success", detail: `State synthesized deterministically (hash=${details.stateHash.slice(0, 12)}).` },
    { stage: "plan", status: "success", detail: `Selected base plan ${details.planId}.` },
    ...mapped,
    { stage: "strategy", status: "success", detail: `Selected strategy ${details.strategyId}.` },
  ];
}

function toExecutionStages(input: {
  id: string;
  order: number;
  units: string[];
}[]): PreviewExecutionStage[] {
  return input.map((stage) => ({
    id: stage.id,
    parallelizable: stage.units.length > 1,
    workUnits: stage.units.map((unitId) => ({
      id: unitId,
      type: "orchestration-unit",
      tasks: [],
      files: [],
    })),
  }));
}

export async function synthesizePreviewContract(
  options: SynthesizePreviewContractOptions
): Promise<PreviewSynthesisContract> {
  try {
    const unified = await runOrchestrationPipeline("preview", {
      root: options.root,
      controlPlane: options.controlPlane,
      command: options.command,
      ...(options.requestedPlanId ? { requestedPlanId: options.requestedPlanId } : {}),
      ...(options.diagnosticsSource ? { diagnosticsSource: options.diagnosticsSource } : {}),
      ...(typeof options.persistPreviewState === "boolean" ? { persistPreviewState: options.persistPreviewState } : {}),
      ...(typeof options.recordPendingApproval === "boolean" ? { recordPendingApproval: options.recordPendingApproval } : {}),
    });

    if (!unified.preview) {
      throw new Error("Unified orchestration runtime did not return preview payload.");
    }

    const executionStages = toExecutionStages(unified.optimized.executionStages.map((stage) => ({
      id: stage.id,
      order: stage.order,
      units: stage.units,
    })));

    const strategyTrace: StrategyTrace = {
      evaluated: unified.candidatePlans.map((candidate) => ({
        strategyId: candidate.strategyType,
        metrics: {
          filesChanged: candidate.blastRadius,
          patchesCount: candidate.changeCount,
          remainingViolations: candidate.riskScore,
          introducedErrors: 0,
        },
        success: true,
      })),
      selectedStrategyId: unified.selectedStrategyType,
      decision: `${unified.selectedStrategyType} selected by unified orchestration runtime.`,
    };

    return {
      command: options.command,
      planId: unified.selectedPlanId,
      basePlanId: unified.selectedPlanId,
      planSource: unified.planSource,
      strategyId: unified.selectedStrategyType,
      previewHash: unified.preview.previewHash,
      simulationHash: unified.preview.simulationHash,
      stateHash: unified.preview.stateHash,
      summary: unified.preview.summary,
      diagnostics: unified.preview.diagnostics,
      fileChanges: unified.preview.fileChanges,
      executionStages,
      stageResults: toStageResults(unified.stageResults, {
        planId: unified.selectedPlanId,
        strategyId: unified.selectedStrategyType,
        stateHash: unified.preview.stateHash,
      }),
      strategyTrace,
      policy: {
        decision: unified.policy.decision,
        allowed: unified.policy.allowed,
        requiresApproval: unified.policy.requiresApproval,
        diffHash: unified.policy.diffHash,
        violations: unified.policy.violations,
      },
      approval: unified.approval,
      selectedPlan: unified.optimized.selectedExecutionPlan,
    };
  } catch (error) {
    if (error instanceof OrchestrationPipelineError) {
      throw new PreviewSynthesisError({
        failedStage: mapStage(error.failedStage),
        message: error.message,
        stageResults: toStageResults(error.stageResults, undefined),
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new PreviewSynthesisError({
      failedStage: "compile",
      message,
      stageResults: [{ stage: "compile", status: "failure", detail: message }],
    });
  }
}
