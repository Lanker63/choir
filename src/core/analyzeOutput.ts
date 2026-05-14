import { AnalyzeTarget } from "./choirRouter.js";

export type WorkspaceAnalysisSummary = {
  totalFiles: number;
  services: number;
  controllers: number;
  repositories: number;
} | null;

function formatWorkspaceSummary(summary: WorkspaceAnalysisSummary): string[] {
  if (!summary) {
    return ["Workspace analysis unavailable: no workspace folder found."];
  }

  return [
    "Workspace analysis:",
    `- totalFiles: ${summary.totalFiles}`,
    `- services: ${summary.services}`,
    `- controllers: ${summary.controllers}`,
    `- repositories: ${summary.repositories}`,
  ];
}

function formatHotspots(hotspots: string[]): string[] {
  if (hotspots.length === 0) {
    return ["Hotspots:", "- none"];
  }

  return ["Hotspots:", ...hotspots.map((entry) => `- ${entry}`)];
}

export function formatAnalyzeMarkdown(
  target: AnalyzeTarget,
  summary: WorkspaceAnalysisSummary,
  hotspots: string[]
): string {
  if (target === "workspace") {
    return formatWorkspaceSummary(summary).join("\n");
  }

  if (target === "hotspots") {
    return formatHotspots(hotspots).join("\n");
  }

  const lines = [
    ...formatWorkspaceSummary(summary),
    "",
    ...formatHotspots(hotspots),
  ];

  return lines.join("\n");
}
