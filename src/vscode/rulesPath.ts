import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export function resolveRulesPath(): string | null {
  const workspaces = vscode.workspace.workspaceFolders ?? [];
  if (workspaces.length === 0) return null;

  for (const workspace of workspaces) {
    const root = workspace.uri.fsPath;
    const candidates = [
      path.join(root, ".choir", "rules.yaml"),
      path.join(root, ".choir", "rules.yml"),
      path.join(root, "rules.yaml"),
      path.join(root, "rules.yml"),
    ];

    for (const file of candidates) {
      if (fs.existsSync(file)) {
        return file;
      }
    }
  }

  return null;
}