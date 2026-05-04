import fs from "fs";
import path from "path";

export interface FileContext {
  path: string;
  content: string;
}

export interface WorkspaceSnapshot {
  root: string;
  files: FileContext[];
}

export interface EnforcementContext {
  root: string;
  files: FileContext[];
  astMap: Map<string, unknown>;
}

function collectTsFiles(root: string): FileContext[] {
  const files: FileContext[] = [];

  function walk(dir: string) {
    const entries = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
    for (const file of entries) {
      if (file === "node_modules" || file === ".git" || file === "out") {
        continue;
      }

      const full = path.join(dir, file);

      if (fs.statSync(full).isDirectory()) {
        walk(full);
      } else if (file.endsWith(".ts")) {
        files.push({
          path: full,
          content: fs.readFileSync(full, "utf-8"),
        });
      }
    }
  }

  walk(root);
  return files;
}

export function buildWorkspaceSnapshot(root: string): WorkspaceSnapshot {
  return {
    root,
    files: collectTsFiles(root),
  };
}

export function buildContext(rootOrSnapshot: string | WorkspaceSnapshot): EnforcementContext {
  const snapshot = typeof rootOrSnapshot === "string"
    ? buildWorkspaceSnapshot(rootOrSnapshot)
    : rootOrSnapshot;

  return {
    root: snapshot.root,
    files: snapshot.files,
    astMap: new Map(),
  };
}