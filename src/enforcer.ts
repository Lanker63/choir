import * as vscode from "vscode";
import { ControlPlane } from "./schema.js";
import { readControlPlane } from "./choirManager.js";
import { buildWorkspaceSnapshot } from "./core/context.js";
import { PipelineResult, runPipeline } from "./core/pipeline.js";
import { appendPipelineDiagnosticsRecord } from "./core/pipelineDiagnostics.js";
import { publishDiagnostics, publishFixes } from "./vscode/diagnostics.js";

export interface RunPipelineOptions {
  controlPlane?: ControlPlane;
  root?: string;
  publishResultDiagnostics?: boolean;
}

function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return null;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (activeFolder) {
      return activeFolder.uri.fsPath;
    }
  }

  return folders[0]?.uri.fsPath ?? null;
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

  let result: PipelineResult;
  try {
    result = await runPipeline({
      controlPlane,
      workspace: buildWorkspaceSnapshot(root),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendPipelineDiagnosticsRecord(root, {
      command: "pipeline-run",
      source: "extension",
      category: "pipeline",
      result: "failure",
      summary: `Pipeline run failed: ${message}`,
      stages: [
        {
          stage: "pipeline",
          status: "failure",
          detail: message,
        },
      ],
    });
    throw error;
  }

  appendPipelineDiagnosticsRecord(root, {
    command: "pipeline-run",
    source: "extension",
    category: "pipeline",
    result: "success",
    summary: `Pipeline run completed: rules=${result.trace.rulesEvaluated.length}, diagnostics=${result.diagnostics.length}`,
    stages: result.trace.phases.map((phase) => ({
      stage: phase.toLowerCase(),
      status: "success" as const,
      detail: `Phase ${phase} executed`,
    })),
    metadata: {
      runId: result.trace.runId,
      durationMs: result.trace.durationMs,
      rulesTriggered: result.trace.rulesTriggered.length,
      diagnostics: result.diagnostics.length,
      fixesGenerated: result.fixes.length,
      conflictsDetected: result.conflicts.length,
    },
  });

  if (options.publishResultDiagnostics !== false) {
    publishDiagnostics(result.diagnostics);
    publishFixes(result.fixes);
  }

  return result;
}
