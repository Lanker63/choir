import fs from "fs";
import path from "path";

export interface FileContext {
  path: string;
  content: string;
}

export interface EnforcementContext {
  root: string;
  files: FileContext[];
  astMap: Map<string, unknown>;
}

export function buildContext(root: string): EnforcementContext {
  const files: FileContext[] = [];
  let count = 0;
  const MAX_FILES = 50;

  function walk(dir: string) {
    for (const file of fs.readdirSync(dir)) {
      if (count > MAX_FILES) return;

      const full = path.join(dir, file);

      if (fs.statSync(full).isDirectory()) {
        walk(full);
      } else if (file.endsWith(".ts")) {
        count++;
        files.push({
          path: full,
          content: fs.readFileSync(full, "utf-8"),
        });
      }
    }
  }

  walk(root);

  return {
    root,
    files,
    astMap: new Map(),
  };
}