import { globSync } from "glob";
import * as fs from "fs";
import { ControlPlane } from "../schema.js";
import { classifyHotspotEntries, resolveHotspotIgnoreGlobs } from "./hotspotClassifier.js";
import { WorkspaceGraphStore } from "./workspaceGraphStore.js";

export type WorkspaceAnalysisSummary = {
  totalFiles: number;
  services: number;
  controllers: number;
  repositories: number;
};

export function analyzeWorkspaceAtRoot(root: string): WorkspaceAnalysisSummary {
  const graphStore = new WorkspaceGraphStore({ root });
  return graphStore.getWorkspaceSummary();
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
