import fs from "fs";
import path from "path";
import { deterministicId, stableStringify } from "./deterministicCore.js";

export type OrchestrationTraceStageResult = {
  stage: string;
  status: "success" | "failure";
  detail: string;
};

export type OrchestrationSimulationContract = {
  futureStateHash: string;
  orchestrationHash: string;
  replayHash: string;
  mutationHash?: string;
  projectedWorkspaceHash?: string;
  preWorkspaceSnapshotHash?: string;
  postWorkspaceSnapshotHash?: string;
};

export type OrchestrationReplaySummary = {
  candidateSynthesis: boolean;
  strategyRanking: boolean;
  strategySelection: boolean;
  orchestrationDag: boolean;
  simulationContract: boolean;
  verified: boolean;
};

export type OrchestrationTraceRecord = {
  id: string;
  timestamp: string;
  mode: "preview" | "simulate" | "execute" | "optimize";
  command: string;
  status: "success" | "failure";
  selectedPlanId: string;
  selectedStrategyType: string;
  planSource: "configured" | "synthesized";
  orchestrationDagHash: string;
  simulationContract: OrchestrationSimulationContract;
  replay: OrchestrationReplaySummary;
  rankingOrder: string[];
  candidates: Array<{
    id: string;
    strategyType: string;
    orchestrationDagHash: string;
    rank?: number;
    selected?: boolean;
    riskScore?: number;
    rollbackComplexity?: number;
    blastRadius?: number;
    dependencyRisk?: number;
    executionCost?: number;
    changeCount?: number;
  }>;
  stageResults: OrchestrationTraceStageResult[];
  modeMetadata?: Record<string, unknown>;
};

export type WriteOrchestrationTraceInput = {
  mode: "preview" | "simulate" | "execute" | "optimize";
  command: string;
  status: "success" | "failure";
  selectedPlanId: string;
  selectedStrategyType: string;
  planSource: "configured" | "synthesized";
  orchestrationDagHash: string;
  simulationContract: OrchestrationSimulationContract;
  replay: OrchestrationReplaySummary;
  rankingOrder: string[];
  candidates: OrchestrationTraceRecord["candidates"];
  stageResults: OrchestrationTraceStageResult[];
  modeMetadata?: Record<string, unknown>;
};

function tracesDir(root: string): string {
  return path.join(root, ".choir", "traces", "orchestration");
}

function latestTracePath(root: string): string {
  return path.join(tracesDir(root), "latest.json");
}

function traceFilePath(root: string, traceId: string): string {
  return path.join(tracesDir(root), `${traceId}.json`);
}

function ensureTraceDir(root: string): void {
  fs.mkdirSync(tracesDir(root), { recursive: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTrace(value: unknown): OrchestrationTraceRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const candidate = value as Partial<OrchestrationTraceRecord>;
  if (
    typeof candidate.id !== "string"
    || typeof candidate.timestamp !== "string"
    || (candidate.mode !== "preview" && candidate.mode !== "simulate" && candidate.mode !== "execute" && candidate.mode !== "optimize")
    || typeof candidate.command !== "string"
    || (candidate.status !== "success" && candidate.status !== "failure")
    || typeof candidate.selectedPlanId !== "string"
    || typeof candidate.selectedStrategyType !== "string"
    || (candidate.planSource !== "configured" && candidate.planSource !== "synthesized")
    || typeof candidate.orchestrationDagHash !== "string"
    || !isRecord(candidate.simulationContract)
    || !isRecord(candidate.replay)
    || !Array.isArray(candidate.rankingOrder)
    || !Array.isArray(candidate.candidates)
    || !Array.isArray(candidate.stageResults)
  ) {
    return null;
  }

  return candidate as OrchestrationTraceRecord;
}

export function writeOrchestrationTrace(root: string, input: WriteOrchestrationTraceInput): OrchestrationTraceRecord {
  ensureTraceDir(root);

  const timestamp = new Date().toISOString();
  const seed = {
    mode: input.mode,
    command: input.command,
    status: input.status,
    selectedPlanId: input.selectedPlanId,
    selectedStrategyType: input.selectedStrategyType,
    planSource: input.planSource,
    orchestrationDagHash: input.orchestrationDagHash,
    simulationContract: input.simulationContract,
    replay: input.replay,
    rankingOrder: input.rankingOrder,
    candidates: input.candidates,
  };

  const record: OrchestrationTraceRecord = {
    id: deterministicId("orchestration-trace", seed, 16),
    timestamp,
    mode: input.mode,
    command: input.command,
    status: input.status,
    selectedPlanId: input.selectedPlanId,
    selectedStrategyType: input.selectedStrategyType,
    planSource: input.planSource,
    orchestrationDagHash: input.orchestrationDagHash,
    simulationContract: input.simulationContract,
    replay: input.replay,
    rankingOrder: [...input.rankingOrder],
    candidates: [...input.candidates],
    stageResults: [...input.stageResults],
    ...(input.modeMetadata ? { modeMetadata: input.modeMetadata } : {}),
  };

  fs.writeFileSync(traceFilePath(root, record.id), `${stableStringify(record)}\n`, "utf-8");
  fs.writeFileSync(latestTracePath(root), `${stableStringify(record)}\n`, "utf-8");

  return record;
}

export function readLatestOrchestrationTrace(root: string): OrchestrationTraceRecord | null {
  const filePath = latestTracePath(root);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (raw.length === 0) {
    return null;
  }

  try {
    return parseTrace(JSON.parse(raw));
  } catch {
    return null;
  }
}
