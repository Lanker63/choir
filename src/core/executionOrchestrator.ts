import { ControlPlane } from "../schema.js";
import {
  OrchestrationPipelineError,
  runOrchestrationPipeline,
  type PipelineStageName,
  type PipelineStageResult,
} from "./orchestrationRuntime.js";
import { type CompiledPolicy as GlobalCompiledPolicy, type RolloutStrategy } from "./globalOrchestration.js";

export type ExecutionOrchestrationStageName =
  | "compile"
  | "workspace-analysis"
  | "candidate-synthesis"
  | "strategy-selection"
  | "simulation-precheck"
  | "integrity-gate"
  | "policy-enforcement"
  | "execution"
  | "replay-verification";

export type ExecutionOrchestrationStageResult = {
  stage: ExecutionOrchestrationStageName;
  status: "success" | "failure";
  detail: string;
};

export type ExecutionOrchestrationResult = {
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
  policy: {
    decision: "allow" | "require-approval" | "deny";
    previewHash: string;
    diffHash: string;
    requiresApproval: boolean;
    violations: number;
  };
  stageResults: ExecutionOrchestrationStageResult[];
};

export type RunExecutionOrchestratorOptions = {
  root: string;
  controlPlane: ControlPlane;
  command: string;
  requestedPlanId?: string;
  requestedPreviewRef?: string;
  rolloutStrategy?: RolloutStrategy;
  executionPolicies?: GlobalCompiledPolicy[];
};

export class ExecutionOrchestrationError extends Error {
  readonly failedStage: ExecutionOrchestrationStageName;
  readonly stageResults: ExecutionOrchestrationStageResult[];

  constructor(input: {
    failedStage: ExecutionOrchestrationStageName;
    message: string;
    stageResults: ExecutionOrchestrationStageResult[];
  }) {
    super(input.message);
    this.name = "ExecutionOrchestrationError";
    this.failedStage = input.failedStage;
    this.stageResults = input.stageResults;
  }
}

function mapStage(stage: PipelineStageName): ExecutionOrchestrationStageName {
  if (stage === "compile" || stage === "structural-validation" || stage === "semantic-validation" || stage === "cross-node-validation") {
    return "compile";
  }

  if (stage === "candidate-synthesis") {
    return "candidate-synthesis";
  }

  if (stage === "strategy-ranking" || stage === "orchestration-build") {
    return "workspace-analysis";
  }

  if (stage === "strategy-selection") {
    return "strategy-selection";
  }

  if (stage === "simulation") {
    return "simulation-precheck";
  }

  if (stage === "integrity") {
    return "integrity-gate";
  }

  if (stage === "policy" || stage === "approval") {
    return "policy-enforcement";
  }

  if (stage === "execution") {
    return "execution";
  }

  return "replay-verification";
}

function toStageResults(stages: PipelineStageResult[]): ExecutionOrchestrationStageResult[] {
  const mapped = stages.map((stage) => ({
    stage: mapStage(stage.stage),
    status: stage.status,
    detail: stage.detail,
  }));

  return mapped;
}

export async function runExecutionOrchestrator(
  options: RunExecutionOrchestratorOptions
): Promise<ExecutionOrchestrationResult> {
  try {
    const unified = await runOrchestrationPipeline("execute", {
      root: options.root,
      controlPlane: options.controlPlane,
      command: options.command,
      ...(options.requestedPlanId ? { requestedPlanId: options.requestedPlanId } : {}),
      ...(options.requestedPreviewRef ? { requestedPreviewRef: options.requestedPreviewRef } : {}),
      ...(options.rolloutStrategy ? { rolloutStrategy: options.rolloutStrategy } : {}),
      ...(options.executionPolicies ? { executionPolicies: options.executionPolicies } : {}),
    });

    if (!unified.execute) {
      throw new Error("Unified orchestration runtime did not return execution payload.");
    }

    const selectedRanked = unified.optimized.rankedPlans.find((plan) => plan.id === unified.selectedPlanId)
      ?? unified.optimized.rankedPlans[0];

    return {
      transactionId: unified.execute.transactionId,
      executionHash: unified.execute.executionHash,
      finalStateHash: unified.execute.finalStateHash,
      replayHash: unified.execute.replayHash,
      executionStages: unified.execute.executionStages,
      rollbackScope: unified.execute.rollbackScope,
      deterministic: unified.execute.deterministic,
      verified: unified.execute.verified,
      success: unified.execute.success,
      strategyId: unified.execute.strategyId,
      planId: unified.execute.planId,
      planSource: unified.execute.planSource,
      simulationFutureStateHash: unified.execute.simulationFutureStateHash,
      policy: {
        decision: unified.policy.decision,
        previewHash: selectedRanked?.previewHash ?? "",
        diffHash: unified.policy.diffHash,
        requiresApproval: unified.policy.requiresApproval,
        violations: unified.policy.violations.length,
      },
      stageResults: toStageResults(unified.stageResults),
    };
  } catch (error) {
    if (error instanceof OrchestrationPipelineError) {
      throw new ExecutionOrchestrationError({
        failedStage: mapStage(error.failedStage),
        message: error.message,
        stageResults: toStageResults(error.stageResults),
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new ExecutionOrchestrationError({
      failedStage: "execution",
      message,
      stageResults: [{ stage: "execution", status: "failure", detail: message }],
    });
  }
}
