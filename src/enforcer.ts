import * as vscode from "vscode";
import { ControlPlane } from "./schema.js";
import { readControlPlane } from "./choirManager.js";
import { buildWorkspaceSnapshot } from "./core/context.js";
import { PipelineResult, runPipeline } from "./core/pipeline.js";
import { publishDiagnostics } from "./vscode/diagnostics.js";

export interface RunPipelineOptions {
  controlPlane?: ControlPlane;
  root?: string;
  publishResultDiagnostics?: boolean;
}

function getWorkspaceRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

export async function runPipelineForWorkspace(options: RunPipelineOptions = {}): Promise<PipelineResult | null> {
  const root = options.root ?? getWorkspaceRoot();
  if (!root) {
    return null;
  }

  const controlPlane = options.controlPlane ?? readControlPlane();
  if (!controlPlane) {
    return null;
  }

  const result = await runPipeline({
    controlPlane,
    workspace: buildWorkspaceSnapshot(root),
  });

  if (options.publishResultDiagnostics !== false) {
    publishDiagnostics(result.violations);
  }

  return result;
}
