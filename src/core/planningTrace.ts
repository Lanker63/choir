import fs from "fs";
import path from "path";
import { deterministicId, stableStringify } from "./deterministicCore.js";
import type { CandidatePlan, PlanningStageResult, RankedPlan } from "./planOptimizationOrchestrator.js";

export type PlanningTraceRecord = {
  id: string;
  timestamp: string;
  command: string;
  selectedPlanId: string;
  selectedStrategyType: string;
  orchestrationDagHash: string;
  planHash: string;
  simulationHash: string;
  workspaceHash: string;
  replayVerified: boolean;
  rankingOrder: string[];
  candidatePlans: Array<{
    id: string;
    strategyType: string;
    orchestrationDagHash: string;
    strategicContextHash?: string;
    strategicAlignment?: number;
    strategicDomains?: string[];
    governanceIntensity?: "strict" | "moderate" | "relaxed";
    rolloutBias?: {
      preferred: "canary" | "phased" | "all-at-once";
      stageSizing: "slow" | "balanced" | "fast";
      rollbackAggressiveness: "strict" | "normal" | "relaxed";
      dependencyIsolation: "high" | "medium" | "low";
      reasons: string[];
    };
    rollbackComplexity: number;
    riskScore: number;
    estimatedCost: number;
    changeCount: number;
    rank?: number;
    selected?: boolean;
  }>;
  stageResults: PlanningStageResult[];
};

type WritePlanningTraceInput = {
  command: string;
  selectedPlan: RankedPlan;
  rankedPlans: RankedPlan[];
  candidatePlans: CandidatePlan[];
  stageResults: PlanningStageResult[];
  planHash: string;
  simulationHash: string;
  workspaceHash: string;
  replayVerified: boolean;
};

function tracesDir(root: string): string {
  return path.join(root, ".choir", "traces", "planning");
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

function parseTrace(value: unknown): PlanningTraceRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<PlanningTraceRecord>;
  if (
    typeof candidate.id !== "string"
    || typeof candidate.timestamp !== "string"
    || typeof candidate.command !== "string"
    || typeof candidate.selectedPlanId !== "string"
    || typeof candidate.selectedStrategyType !== "string"
    || typeof candidate.orchestrationDagHash !== "string"
    || typeof candidate.planHash !== "string"
    || typeof candidate.simulationHash !== "string"
    || typeof candidate.workspaceHash !== "string"
    || typeof candidate.replayVerified !== "boolean"
    || !Array.isArray(candidate.rankingOrder)
    || !Array.isArray(candidate.candidatePlans)
    || !Array.isArray(candidate.stageResults)
  ) {
    return null;
  }

  return candidate as PlanningTraceRecord;
}

export function writePlanningTrace(root: string, input: WritePlanningTraceInput): PlanningTraceRecord {
  ensureTraceDir(root);

  const timestamp = new Date().toISOString();
  const rankingOrder = input.rankedPlans.map((plan) => plan.id);
  const seed = {
    command: input.command,
    selectedPlanId: input.selectedPlan.id,
    planHash: input.planHash,
    simulationHash: input.simulationHash,
    workspaceHash: input.workspaceHash,
    rankingOrder,
  };

  const record: PlanningTraceRecord = {
    id: deterministicId("planning-trace", seed, 16),
    timestamp,
    command: input.command,
    selectedPlanId: input.selectedPlan.id,
    selectedStrategyType: input.selectedPlan.strategyType,
    orchestrationDagHash: input.selectedPlan.orchestrationGraph.hash,
    planHash: input.planHash,
    simulationHash: input.simulationHash,
    workspaceHash: input.workspaceHash,
    replayVerified: input.replayVerified,
    rankingOrder,
    candidatePlans: input.rankedPlans.map((plan) => ({
      id: plan.id,
      strategyType: plan.strategyType,
      orchestrationDagHash: plan.orchestrationGraph.hash,
      strategicContextHash: plan.strategicContextHash,
      strategicAlignment: plan.strategicAlignment.score,
      strategicDomains: plan.strategicDomains,
      governanceIntensity: plan.strategicGovernanceIntensity,
      rolloutBias: plan.strategicRolloutBias,
      rollbackComplexity: plan.rollbackScope.complexity,
      riskScore: plan.riskScore,
      estimatedCost: plan.estimatedCost,
      changeCount: plan.changeCount,
      rank: plan.rank,
      selected: plan.id === input.selectedPlan.id,
    })),
    stageResults: input.stageResults,
  };

  fs.writeFileSync(traceFilePath(root, record.id), `${stableStringify(record)}\n`, "utf-8");
  fs.writeFileSync(latestTracePath(root), `${stableStringify(record)}\n`, "utf-8");

  return record;
}

export function readPlanningTrace(root: string, traceId: string): PlanningTraceRecord | null {
  const filePath = traceFilePath(root, traceId);
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

function readLatestPlanningTrace(root: string): PlanningTraceRecord | null {
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
