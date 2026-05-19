import { globSync } from "glob";
import * as fs from "fs";
import { ControlPlane } from "../schema.js";
import { classifyHotspotEntries, resolveHotspotIgnoreGlobs } from "./hotspotClassifier.js";

export type WorkspaceAnalysisSummary = {
  totalFiles: number;
  services: number;
  controllers: number;
  repositories: number;
};

export function analyzeWorkspaceAtRoot(root: string): WorkspaceAnalysisSummary {
  const files = globSync("**/*.{ts,js}", {
    cwd: root,
    ignore: ["node_modules/**"],
  });

  const summary: WorkspaceAnalysisSummary = {
    totalFiles: files.length,
    services: 0,
    controllers: 0,
    repositories: 0,
  };

  for (const file of files) {
    if (file.includes("service")) summary.services += 1;
    if (file.includes("controller")) summary.controllers += 1;
    if (file.includes("repository")) summary.repositories += 1;
  }

  return summary;
}

export function findHotspotsAtRoot(root: string, controlPlane: ControlPlane | null): string[] {
  const files = globSync("**/*.ts", {
    cwd: root,
    ignore: resolveHotspotIgnoreGlobs(controlPlane),
  });

  const hotspots: string[] = [];
  for (const file of files) {
    const content = fs.readFileSync(root + "/" + file, "utf-8");
    hotspots.push(...classifyHotspotEntries(file, content));
  }

  return hotspots;
}
