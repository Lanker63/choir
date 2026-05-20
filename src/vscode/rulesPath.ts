import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

const CONTROL_PLANE_FILE_NAMES = ["choir.config.yaml"] as const;

function controlPlaneCandidates(root: string): string[] {
  return CONTROL_PLANE_FILE_NAMES.map((name) => path.join(root, ".choir", name));
}

export function resolveControlPlanePath(): string | null {
  const workspaces = vscode.workspace.workspaceFolders ?? [];
  if (workspaces.length === 0) return null;

  for (const workspace of workspaces) {
    const root = workspace.uri.fsPath;
    const candidates = controlPlaneCandidates(root);

    for (const file of candidates) {
      if (fs.existsSync(file)) {
        return file;
      }
    }
  }

  return null;
}