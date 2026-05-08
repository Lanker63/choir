import { ControlPlane } from "../schema.js";
import {
  OrchestrationPipelineError,
  runOrchestrationPipeline,
  type PipelineStageName,
  type PipelineStageResult,
  type PipelineResult,
} from "./orchestrationRuntime.js";

export type SimulationOrchestrationStageName =
  | "compile"
  | "state"
  | "candidate-synthesis"
  | "strategy-selection"
  | "simulation"
  | "replay"
  | "mutation-guard";

export type SimulationOrchestrationStageResult = {
  stage: SimulationOrchestrationStageName;
  status: "success" | "failure";
  detail: string;
};

export type SimulationPlanSource = "configured" | "synthesized";

export type SimulationPolicyDecision = "allow" | "require-approval" | "deny";

export type SimulationOrchestrationResult = {
  success: boolean;
  strategyId: string;
  planId: string;
  planSource: SimulationPlanSource;
  units?: string[];
  changes: {
    unitId: string;
    filesChanged: string[];
    operations: string[];
  }[];
  violations: string[];
  metrics: {
    risk: number;
    changes: number;
    violations: number;
  };
  policy: {
    decision: SimulationPolicyDecision;
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
  stageResults: SimulationOrchestrationStageResult[];
};

export type RunSimulationOrchestratorOptions = {
  root: string;
  controlPlane: ControlPlane;
  command: string;
  requestedPlanId?: string;
  requestedUnits?: string[];
};

export class SimulationOrchestrationError extends Error {
  readonly failedStage: SimulationOrchestrationStageName;
  readonly stageResults: SimulationOrchestrationStageResult[];

  constructor(input: {
    failedStage: SimulationOrchestrationStageName;
    message: string;
    stageResults: SimulationOrchestrationStageResult[];
  }) {
    super(input.message);
    this.name = "SimulationOrchestrationError";
    this.failedStage = input.failedStage;
    this.stageResults = input.stageResults;
  }
}

function mapStage(stage: PipelineStageName): SimulationOrchestrationStageName {
  if (stage === "compile" || stage === "structural-validation" || stage === "semantic-validation" || stage === "cross-node-validation") {
    return "compile";
  }

  if (stage === "candidate-synthesis") {
    return "candidate-synthesis";
  }

  if (stage === "strategy-selection" || stage === "strategy-ranking") {
    return "strategy-selection";
  }

  if (stage === "simulation") {
    return "simulation";
  }

  if (stage === "replay-verification") {
    return "replay";
  }

  return "state";
}

function toStageResults(
  stages: PipelineStageResult[],
  simulatePayload: NonNullable<PipelineResult["simulate"]> | undefined
): SimulationOrchestrationStageResult[] {
  const mapped = stages.map((stage) => ({
    stage: mapStage(stage.stage),
    status: stage.status,
    detail: stage.detail,
  }));

  const stateDetail = simulatePayload
    ? `Derived deterministic state (hash=${simulatePayload.hashes.stateBefore.slice(0, 12)}).`
    : "Derived deterministic state in unified runtime.";
  const mutationDetail = simulatePayload
    ? simulatePayload.hashes.stateBefore === simulatePayload.hashes.stateAfter
      ? `No persisted state mutation detected (stateHash=${simulatePayload.hashes.stateAfter.slice(0, 12)}).`
      : `Simulation mutated persisted state (${simulatePayload.hashes.stateBefore.slice(0, 12)} -> ${simulatePayload.hashes.stateAfter.slice(0, 12)}).`
    : "Simulation mutation guard unavailable.";

  return [
    { stage: "state", status: "success", detail: stateDetail },
    ...mapped,
    {
      stage: "mutation-guard",
      status: simulatePayload && simulatePayload.hashes.stateBefore === simulatePayload.hashes.stateAfter ? "success" : "failure",
      detail: mutationDetail,
    },
  ];
}

export async function runSimulationOrchestrator(
  options: RunSimulationOrchestratorOptions
): Promise<SimulationOrchestrationResult> {
  try {
    const unified = await runOrchestrationPipeline("simulate", {
      root: options.root,
      controlPlane: options.controlPlane,
      command: options.command,
      ...(options.requestedPlanId ? { requestedPlanId: options.requestedPlanId } : {}),
      ...(options.requestedUnits ? { requestedUnits: options.requestedUnits } : {}),
    });

    if (!unified.simulate) {
      throw new Error("Unified orchestration runtime did not return simulation payload.");
    }

    return {
      success: unified.simulate.success,
      strategyId: unified.simulate.strategyId,
      planId: unified.simulate.planId,
      planSource: unified.simulate.planSource,
      ...(unified.simulate.units ? { units: unified.simulate.units } : {}),
      changes: unified.simulate.changes,
      violations: unified.simulate.violations,
      metrics: unified.simulate.metrics,
      policy: unified.simulate.policy,
      hashes: unified.simulate.hashes,
      replay: unified.simulate.replay,
      rollbackScope: unified.simulate.rollbackScope,
      stageResults: toStageResults(unified.stageResults, unified.simulate),
    };
  } catch (error) {
    if (error instanceof OrchestrationPipelineError) {
      throw new SimulationOrchestrationError({
        failedStage: mapStage(error.failedStage),
        message: error.message,
        stageResults: toStageResults(error.stageResults, undefined),
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new SimulationOrchestrationError({
      failedStage: "simulation",
      message,
      stageResults: [{ stage: "simulation", status: "failure", detail: message }],
    });
  }
}
