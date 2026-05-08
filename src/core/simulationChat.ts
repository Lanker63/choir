import { ChangeSummary } from "./globalOrchestration.js";

export type SimulationChatMetrics = {
  risk: number;
  changes: number;
  violations: number;
};

export type SimulationChatView = {
  success: boolean;
  strategyId: string;
  planId?: string;
  planSource?: "configured" | "synthesized";
  units?: string[];
  changes: ChangeSummary[];
  violations: string[];
  metrics: SimulationChatMetrics;
  policyDecision?: "allow" | "require-approval" | "deny";
  policyViolations?: string[];
  replay?: {
    traceId: string;
    stageIds: string[];
    transitionCount: number;
    validated: boolean;
    verified: boolean;
    hashMatches: boolean;
  };
  hashes?: {
    stateBefore: string;
    stateAfter: string;
    finalState: string;
    replayState: string;
  };
  rollbackScope?: string[];
  stageResults?: {
    stage: string;
    status: "success" | "failure";
    detail: string;
  }[];
};

function shortHash(value: string): string {
  return value.slice(0, 12);
}

export function simulationRiskLabel(violations: number, riskScore: number): "LOW" | "MEDIUM" | "HIGH" {
  if (violations > 0) {
    return "HIGH";
  }

  if (riskScore >= 8) {
    return "MEDIUM";
  }

  return "LOW";
}

export function formatSimulationChatResult(view: SimulationChatView): string {
  const changeLines = view.changes.length === 0
    ? ["- none"]
    : [...view.changes]
      .sort((left, right) => left.unitId.localeCompare(right.unitId))
      .map((entry) => `- ${entry.unitId}: ${entry.filesChanged.length} files`);

  const violationLines = view.violations.length === 0
    ? ["- none"]
    : view.violations.map((entry) => `- ${entry}`);

  const unitsLabel = view.units && view.units.length > 0
    ? view.units.join(", ")
    : "all";

  const policyViolations = view.policyViolations ?? [];
  const policyViolationLines = policyViolations.length === 0
    ? ["- none"]
    : policyViolations.map((entry) => `- ${entry}`);

  const rollbackScope = view.rollbackScope ?? [];
  const rollbackLines = rollbackScope.length === 0
    ? ["- none"]
    : rollbackScope.map((unit) => `- ${unit}`);

  const stageResultLines = (view.stageResults ?? []).map((entry) => {
    const status = entry.status === "success" ? "ok" : "fail";
    return `- [${status}] ${entry.stage}: ${entry.detail}`;
  });

  return [
    view.success ? "Simulation successful" : "Simulation failed",
    `- strategy: ${view.strategyId}`,
    ...(view.planId ? [`- plan: ${view.planId}${view.planSource ? ` (${view.planSource})` : ""}`] : []),
    `- units: ${unitsLabel}`,
    "",
    "Changes:",
    ...changeLines,
    "",
    "Violations:",
    ...violationLines,
    "",
    `Risk: ${simulationRiskLabel(view.metrics.violations, view.metrics.risk)}`,
    `- riskScore: ${view.metrics.risk}`,
    `- changes: ${view.metrics.changes}`,
    `- violations: ${view.metrics.violations}`,
    "",
    `Policy: ${view.policyDecision ?? "allow"}`,
    ...policyViolationLines,
    ...(view.replay
      ? [
        "",
        "Replay:",
        `- trace: ${view.replay.traceId}`,
        `- stages: ${view.replay.stageIds.length}${view.replay.stageIds.length > 0 ? ` [${view.replay.stageIds.join(", ")}]` : ""}`,
        `- transitions: ${view.replay.transitionCount}`,
        `- validated: ${view.replay.validated}`,
        `- verified: ${view.replay.verified}`,
        `- hashMatch: ${view.replay.hashMatches}`,
      ]
      : []),
    ...(view.hashes
      ? [
        "",
        "Hashes:",
        `- stateBefore: ${shortHash(view.hashes.stateBefore)}`,
        `- stateAfter: ${shortHash(view.hashes.stateAfter)}`,
        `- finalState: ${shortHash(view.hashes.finalState)}`,
        `- replayState: ${shortHash(view.hashes.replayState)}`,
      ]
      : []),
    "",
    "Rollback scope:",
    ...rollbackLines,
    ...((stageResultLines.length > 0)
      ? [
        "",
        "Stage diagnostics:",
        ...stageResultLines,
      ]
      : []),
  ].join("\n");
}
