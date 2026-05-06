import { ChangeSummary } from "./globalOrchestration.js";

export type SimulationChatMetrics = {
  risk: number;
  changes: number;
  violations: number;
};

export type SimulationChatView = {
  success: boolean;
  strategyId: string;
  units?: string[];
  changes: ChangeSummary[];
  violations: string[];
  metrics: SimulationChatMetrics;
};

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

  return [
    view.success ? "Simulation successful" : "Simulation failed",
    `- strategy: ${view.strategyId}`,
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
  ].join("\n");
}
