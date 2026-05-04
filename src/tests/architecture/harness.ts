import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import * as YAML from "yaml";
import { applyChatToControlPlane } from "../../chatCompiler.js";
import { buildWorkspaceSnapshot } from "../../core/context.js";
import { PipelineResult, runPipeline } from "../../core/pipeline.js";
import { materializeStatePlane, StatePlane } from "../../core/state.js";
import { Diagnostic } from "../../core/types.js";
import { ControlPlane, ControlPlaneSchema } from "../../schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, "../../..");
export const fixturesRoot = path.join(repoRoot, "test-fixtures");

export type Harness = {
  loadControlPlane(): ControlPlane;
  saveControlPlane(control: ControlPlane): void;
  runPipeline(): Promise<PipelineResult>;
  sendChat(input: string): void;
  readState(): StatePlane;
  readDiagnostics(): Diagnostic[];
};

export type HarnessFixture = {
  root: string;
  harness: Harness;
  dispose(): void;
};

export type WorkspaceInputSnapshot = {
  root: string;
  controlPlaneYaml: string;
  files: Record<string, string>;
};

class ChoirHarness implements Harness {
  private diagnostics: Diagnostic[] = [];
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  loadControlPlane(): ControlPlane {
    const controlPath = this.getControlPlanePath();
    const raw = fs.readFileSync(controlPath, "utf-8");
    return ControlPlaneSchema.parse(YAML.parse(raw));
  }

  saveControlPlane(control: ControlPlane): void {
    const validated = ControlPlaneSchema.parse(control);
    const controlPath = this.getControlPlanePath();
    fs.mkdirSync(path.dirname(controlPath), { recursive: true });
    fs.writeFileSync(controlPath, YAML.stringify(validated), "utf-8");
  }

  async runPipeline(): Promise<PipelineResult> {
    const result = await runPipeline({
      controlPlane: this.loadControlPlane(),
      workspace: buildWorkspaceSnapshot(this.root),
    });

    this.diagnostics = [...result.diagnostics];
    return result;
  }

  sendChat(input: string): void {
    const current = this.loadControlPlane();
    const updated = applyChatToControlPlane(input, current);
    this.saveControlPlane(updated);
  }

  readState(): StatePlane {
    const statePath = this.getStatePath();
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8")) as StatePlane;
    return materializeStatePlane(parsed);
  }

  readDiagnostics(): Diagnostic[] {
    return [...this.diagnostics];
  }

  private getControlPlanePath(): string {
    return path.join(this.root, ".choir", "choir.config.yaml");
  }

  private getStatePath(): string {
    return path.join(this.root, ".choir", "state.json");
  }
}

export function createHarnessFromFixture(fixtureName: string): HarnessFixture {
  const source = path.join(fixturesRoot, fixtureName);
  if (!fs.existsSync(source)) {
    throw new Error(`Fixture not found: ${fixtureName}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "choir-harness-"));
  const target = path.join(tempRoot, fixtureName);
  fs.cpSync(source, target, { recursive: true });

  return {
    root: target,
    harness: new ChoirHarness(target),
    dispose() {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

export function listFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const results: string[] = [];

  const walk = (currentPath: string, relativePrefix: string): void => {
    const entries = fs.readdirSync(currentPath).sort((a, b) => a.localeCompare(b));
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry);
      const relativePath = path.join(relativePrefix, entry);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath, relativePath);
      } else {
        results.push(relativePath);
      }
    }
  };

  walk(dirPath, "");
  return results.sort((a, b) => a.localeCompare(b));
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function snapshotWorkspace(root: string): WorkspaceInputSnapshot {
  const controlPlanePath = path.join(root, ".choir", "choir.config.yaml");
  const controlPlaneYaml = fs.readFileSync(controlPlanePath, "utf-8");

  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) {
      return;
    }

    const entries = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);

      if (stat.isDirectory() && (entry === "node_modules" || entry === ".git" || entry === "out")) {
        continue;
      }

      if (stat.isDirectory()) {
        walk(full);
        continue;
      }

      const relative = path.relative(root, full).split(path.sep).join("/");
      if (relative === ".choir/state.json") {
        continue;
      }

      files[relative] = fs.readFileSync(full, "utf-8");
    }
  };

  walk(root);

  return {
    root,
    controlPlaneYaml,
    files: Object.fromEntries(
      Object.entries(files).sort(([left], [right]) => left.localeCompare(right))
    ),
  };
}

function toPortableRelativePath(root: string, value: string): string {
  if (!path.isAbsolute(value)) {
    return value.split(path.sep).join("/");
  }

  const relative = path.relative(root, value);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return value.split(path.sep).join("/");
  }

  return relative.split(path.sep).join("/");
}

function relativizeRecord<T>(
  root: string,
  record: Record<string, T>
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [toPortableRelativePath(root, key), value])
  );
}

function canonicalizeState(root: string, state: StatePlane): StatePlane {
  return {
    astIndex: relativizeRecord(root, state.astIndex),
    symbolGraph: relativizeRecord(root, state.symbolGraph),
    violations: state.violations.map((violation) => ({
      ...violation,
      location: {
        ...violation.location,
        file: toPortableRelativePath(root, violation.location.file),
      },
    })),
    metrics: { ...state.metrics },
    dependencyGraph: relativizeRecord(root, state.dependencyGraph),
  };
}

export async function validateStateDeterminism(
  snapshot: WorkspaceInputSnapshot,
  state: StatePlane
): Promise<boolean> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "choir-state-check-"));

  try {
    const controlPlane = ControlPlaneSchema.parse(YAML.parse(snapshot.controlPlaneYaml));

    const controlPlanePath = path.join(tempRoot, ".choir", "choir.config.yaml");
    fs.mkdirSync(path.dirname(controlPlanePath), { recursive: true });
    fs.writeFileSync(controlPlanePath, snapshot.controlPlaneYaml, "utf-8");

    for (const [relativePath, content] of Object.entries(snapshot.files)) {
      const targetPath = path.join(tempRoot, relativePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, content, "utf-8");
    }

    await runPipeline({
      controlPlane,
      workspace: buildWorkspaceSnapshot(tempRoot),
    });

    const replayedStatePath = path.join(tempRoot, ".choir", "state.json");
    const replayedState = JSON.parse(fs.readFileSync(replayedStatePath, "utf-8")) as StatePlane;

    const canonicalActual = materializeStatePlane(canonicalizeState(snapshot.root, state));
    const canonicalReplayed = materializeStatePlane(canonicalizeState(tempRoot, replayedState));

    return JSON.stringify(canonicalActual) === JSON.stringify(canonicalReplayed);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function searchCodebase(query: string | RegExp): string[] {
  const srcRoot = path.join(repoRoot, "src");
  const matches: string[] = [];

  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.endsWith(".ts")) {
        continue;
      }

      const fileContent = fs.readFileSync(fullPath, "utf-8");
      const lines = fileContent.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        let found = false;

        if (typeof query === "string") {
          found = line.includes(query);
        } else {
          const flags = query.flags.replace("g", "");
          const regex = new RegExp(query.source, flags);
          found = regex.test(line);
        }

        if (found) {
          const relative = path.relative(repoRoot, fullPath).split(path.sep).join("/");
          matches.push(`${relative}:${index + 1}`);
        }
      }
    }
  };

  walk(srcRoot);
  return matches;
}

export function simulateRuleEditorValidation(): { source: "pipeline" | "unknown" } {
  const providerPath = path.join(repoRoot, "src", "vscode", "RuleEditorProvider.ts");
  const code = fs.readFileSync(providerPath, "utf-8");

  if (code.includes("runPipelineForWorkspace")) {
    return { source: "pipeline" };
  }

  return { source: "unknown" };
}
