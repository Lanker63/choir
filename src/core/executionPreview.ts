import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { buildWorkspaceSnapshot, WorkspaceSnapshot } from "./context.js";
import { runPipeline } from "./pipeline.js";
import {
  ExecutionPlan,
  InMemoryTransactionFS,
  TransactionEnforcer,
  TransactionPipeline,
  ValidationResult,
  buildExecutionPlan,
  createInMemoryTransactionFS,
  runExecutionPlanTransactionally,
} from "./scheduler.js";
import { ControlPlane, Plan } from "../schema.js";
import { Diagnostic } from "./types.js";
import { Fix, Patch, isTextPatch } from "../fix/types.js";
import { StatePlane, createEmptyStatePlane, readStatePlane } from "./state.js";

export type FileChange = {
  file: string;
  patches: Patch[];
  diff: string;
  before: string;
  after: string;
};

export type ExecutionPreview = {
  previewId: string;
  hash: string;
  planId: string;
  summary: {
    totalFilesChanged: number;
    totalPatches: number;
    totalDiagnosticsResolved: number;
  };
  fileChanges: FileChange[];
  diagnostics: Diagnostic[];
  strategy?: {
    strategyId: string;
    cost: number;
  };
};

type GenerateExecutionPreviewOptions = {
  root: string;
  controlPlane: ControlPlane;
  state?: StatePlane;
  strategy?: {
    strategyId: string;
    cost: number;
  };
};

type PreviewSimulationContext = {
  baselineDiagnostics: Diagnostic[];
  workspaceSnapshot: WorkspaceSnapshot;
};

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function toRelativePath(root: string, value: string): string {
  const normalized = normalizePath(value);
  if (!path.isAbsolute(value)) {
    return normalized;
  }

  const relative = normalizePath(path.relative(root, value));
  if (relative.startsWith("../") || relative === "..") {
    throw new Error(`Preview cannot include paths outside workspace root: ${value}`);
  }

  return relative;
}

function clonePatch(root: string, patch: Patch): Patch {
  if (isTextPatch(patch)) {
    return {
      ...patch,
      location: {
        ...patch.location,
        file: toRelativePath(root, patch.location.file),
      },
    };
  }

  if (patch.type === "create-file" || patch.type === "delete-file") {
    return {
      ...patch,
      file: toRelativePath(root, patch.file),
    };
  }

  return {
    ...patch,
    from: toRelativePath(root, patch.from),
    to: toRelativePath(root, patch.to),
  };
}

function cloneFix(root: string, fix: Fix): Fix {
  return {
    ...fix,
    patches: fix.patches.map((patch) => clonePatch(root, patch)),
  };
}

function normalizeDiagnostic(root: string, diagnostic: Diagnostic): Diagnostic {
  return {
    ...diagnostic,
    location: {
      ...diagnostic.location,
      file: toRelativePath(root, diagnostic.location.file),
    },
    ...(diagnostic.related
      ? {
        related: diagnostic.related.map((entry) => ({
          ...entry,
          location: {
            ...entry.location,
            file: toRelativePath(root, entry.location.file),
          },
        })),
      }
      : {}),
  };
}

function patchFiles(patch: Patch): string[] {
  if (isTextPatch(patch)) {
    return [normalizePath(patch.location.file)];
  }

  if (patch.type === "create-file" || patch.type === "delete-file") {
    return [normalizePath(patch.file)];
  }

  return [normalizePath(patch.from), normalizePath(patch.to)];
}

function overlapsWithBatchFiles(fix: Fix, batchFiles: Set<string>): boolean {
  const files = fix.patches.flatMap((patch) => patchFiles(patch));
  return files.some((file) => batchFiles.has(file));
}

function includeFixDependencies(fixes: Fix[]): Fix[] {
  const byId = new Map(fixes.map((fix) => [fix.id, fix] as const));
  const selected = new Map<string, Fix>();

  function visit(fix: Fix) {
    if (selected.has(fix.id)) {
      return;
    }

    selected.set(fix.id, fix);
    for (const dependencyId of fix.dependsOn ?? []) {
      const dependency = byId.get(dependencyId);
      if (dependency) {
        visit(dependency);
      }
    }
  }

  fixes.forEach((fix) => visit(fix));
  return [...selected.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function toRelativeFilesMap(root: string, snapshot: WorkspaceSnapshot): Record<string, string> {
  const entries: Array<[string, string]> = snapshot.files.map((file) => [
    toRelativePath(root, file.path),
    file.content,
  ]);

  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function collectPlanFiles(executionPlan: ExecutionPlan): string[] {
  return sortedUnique(executionPlan.batches.flatMap((batch) => batch.workUnits.flatMap((unit) => unit.files.map((file) => normalizePath(file)))));
}

async function readFilesFromDisk(root: string, files: string[]): Promise<Record<string, string>> {
  const entries: Array<[string, string]> = [];

  for (const file of sortedUnique(files)) {
    const absolute = path.resolve(root, file);
    try {
      const content = await fs.readFile(absolute, "utf-8");
      entries.push([file, content]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  return Object.fromEntries(entries);
}

function buildSnapshotFromFiles(root: string, files: Record<string, string>): WorkspaceSnapshot {
  const tsFiles = Object.keys(files)
    .filter((file) => file.endsWith(".ts"))
    .sort((left, right) => left.localeCompare(right))
    .map((file) => ({
      path: path.resolve(root, file),
      content: files[file],
    }));

  return {
    root,
    files: tsFiles,
  };
}

async function buildSimulationContext(root: string, controlPlane: ControlPlane): Promise<PreviewSimulationContext> {
  const workspaceSnapshot = buildWorkspaceSnapshot(root);
  const baselinePipeline = await runPipeline({
    controlPlane,
    workspace: workspaceSnapshot,
  });

  return {
    baselineDiagnostics: baselinePipeline.diagnostics
      .map((diagnostic) => normalizeDiagnostic(root, diagnostic))
      .sort((left, right) => left.id.localeCompare(right.id)),
    workspaceSnapshot,
  };
}

function createPreviewEnforcer(
  root: string,
  controlPlane: ControlPlane,
  txFs: InMemoryTransactionFS
): TransactionEnforcer {
  return {
    async proposeFixes(workUnits) {
      const currentFiles = txFs.snapshot().files;
      const workspace = buildSnapshotFromFiles(root, currentFiles);
      const pipelineResult = await runPipeline({
        controlPlane,
        workspace,
      });

      const allFixes = pipelineResult.fixes
        .map((fix) => cloneFix(root, fix))
        .sort((left, right) => left.id.localeCompare(right.id));
      const allDiagnostics = pipelineResult.diagnostics
        .map((diagnostic) => normalizeDiagnostic(root, diagnostic))
        .sort((left, right) => left.id.localeCompare(right.id));

      const batchFiles = new Set(sortedUnique(workUnits.flatMap((unit) => unit.files.map((file) => normalizePath(file)))));
      if (batchFiles.size === 0) {
        return {
          fixes: [],
          diagnostics: [],
        };
      }

      const candidateFixes = allFixes.filter((fix) => overlapsWithBatchFiles(fix, batchFiles));
      const fixes = includeFixDependencies(candidateFixes);
      const diagnosticIds = new Set(fixes.flatMap((fix) => fix.diagnosticIds));
      const diagnostics = allDiagnostics.filter((diagnostic) => diagnosticIds.has(diagnostic.id));

      return {
        fixes,
        diagnostics,
      };
    },
  };
}

function createPreviewPipeline(
  root: string,
  controlPlane: ControlPlane,
  txFs: InMemoryTransactionFS
): TransactionPipeline {
  return {
    async run(input) {
      const mergedFiles = {
        ...txFs.snapshot().files,
        ...input.fs.files,
      };

      for (const file of input.transaction.touchedFiles) {
        if (!Object.prototype.hasOwnProperty.call(input.fs.files, file)) {
          delete mergedFiles[file];
        }
      }

      const workspace = buildSnapshotFromFiles(root, mergedFiles);
      const pipelineResult = await runPipeline({
        controlPlane,
        workspace,
      });

      return {
        diagnostics: pipelineResult.diagnostics
          .map((diagnostic) => normalizeDiagnostic(root, diagnostic))
          .sort((left, right) => left.id.localeCompare(right.id)),
        conflicts: pipelineResult.conflicts,
      };
    },
  };
}

export function groupPatchesByFile(patches: Patch[]): Map<string, Patch[]> {
  const grouped = new Map<string, Patch[]>();

  for (const patch of patches) {
    const files = patchFiles(patch);
    for (const file of files) {
      const existing = grouped.get(file) ?? [];
      existing.push(patch);
      grouped.set(file, existing);
    }
  }

  for (const [file, filePatches] of grouped.entries()) {
    grouped.set(file, [...filePatches]);
  }

  return new Map([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function splitLines(input: string): string[] {
  return input.length === 0 ? [] : input.replace(/\r\n/g, "\n").split("\n");
}

export function generateDiff(file: string, before: string, after: string): string {
  if (before === after) {
    return `--- ${file}\n+++ ${file}\n@@\n`;
  }

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const maxLines = Math.max(beforeLines.length, afterLines.length);

  const body: string[] = [];
  for (let index = 0; index < maxLines; index += 1) {
    const left = beforeLines[index];
    const right = afterLines[index];

    if (left === right) {
      if (left !== undefined) {
        body.push(` ${left}`);
      }
      continue;
    }

    if (left !== undefined) {
      body.push(`-${left}`);
    }

    if (right !== undefined) {
      body.push(`+${right}`);
    }
  }

  return [
    `--- ${file}`,
    `+++ ${file}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...body,
  ].join("\n");
}

function stableDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((left, right) => {
    if (left.location.file !== right.location.file) return left.location.file.localeCompare(right.location.file);
    if (left.location.start.line !== right.location.start.line) return left.location.start.line - right.location.start.line;
    if (left.location.start.character !== right.location.start.character) {
      return left.location.start.character - right.location.start.character;
    }
    if (left.ruleId !== right.ruleId) return left.ruleId.localeCompare(right.ruleId);
    return left.id.localeCompare(right.id);
  });
}

function resolvedDiagnosticsCount(before: Diagnostic[], after: Diagnostic[]): number {
  const beforeIds = new Set(before.map((diagnostic) => diagnostic.id));
  const afterIds = new Set(after.map((diagnostic) => diagnostic.id));

  let resolved = 0;
  for (const diagnosticId of beforeIds) {
    if (!afterIds.has(diagnosticId)) {
      resolved += 1;
    }
  }

  return resolved;
}

function collectPatchesFromTransactions(
  transactions: Array<{ status: string; proposedPatches: Patch[] }>
): Patch[] {
  return transactions
    .filter((transaction) => transaction.status === "committed")
    .flatMap((transaction) => transaction.proposedPatches);
}

export function hashPreview(preview: Pick<ExecutionPreview, "fileChanges">): string {
  return createHash("sha256").update(JSON.stringify(preview.fileChanges)).digest("hex");
}

export async function generateExecutionPreview(
  plan: Plan,
  options: GenerateExecutionPreviewOptions
): Promise<ExecutionPreview> {
  const root = options.root;
  const executionPlan = buildExecutionPlan([plan]).executionPlan;
  const simulationContext = await buildSimulationContext(root, options.controlPlane);

  const initialFiles = toRelativeFilesMap(root, simulationContext.workspaceSnapshot);
  const planFiles = collectPlanFiles(executionPlan);
  const diskPlanFiles = await readFilesFromDisk(root, planFiles);
  const initialState = options.state ?? readStatePlane(root) ?? createEmptyStatePlane();

  const txFs = createInMemoryTransactionFS({
    files: {
      ...initialFiles,
      ...diskPlanFiles,
    },
    state: initialState,
  });

  const executionResult = await runExecutionPlanTransactionally(executionPlan, {
    fs: txFs,
    controlPlane: options.controlPlane,
    enforcer: createPreviewEnforcer(root, options.controlPlane, txFs),
    pipeline: createPreviewPipeline(root, options.controlPlane, txFs),
    executeLayersInParallel: false,
  });

  const finalFiles = txFs.snapshot().files;
  const patches = collectPatchesFromTransactions(executionResult.transactions).map((patch) => clonePatch(root, patch));
  const grouped = groupPatchesByFile(patches);

  const changedFiles = sortedUnique(
    [...grouped.keys()].filter((file) => (initialFiles[file] ?? "") !== (finalFiles[file] ?? "") || grouped.has(file))
  );

  const fileChanges: FileChange[] = changedFiles.map((file) => {
    const before = initialFiles[file] ?? "";
    const after = finalFiles[file] ?? "";
    return {
      file,
      patches: grouped.get(file) ?? [],
      before,
      after,
      diff: generateDiff(file, before, after),
    };
  });

  const finalPipeline = await runPipeline({
    controlPlane: options.controlPlane,
    workspace: buildSnapshotFromFiles(root, finalFiles),
  });
  const finalDiagnostics = stableDiagnostics(finalPipeline.diagnostics.map((diagnostic) => normalizeDiagnostic(root, diagnostic)));

  const previewDraft = {
    previewId: "",
    hash: "",
    planId: plan.id,
    summary: {
      totalFilesChanged: fileChanges.length,
      totalPatches: patches.length,
      totalDiagnosticsResolved: resolvedDiagnosticsCount(simulationContext.baselineDiagnostics, finalDiagnostics),
    },
    fileChanges,
    diagnostics: finalDiagnostics,
    ...(options.strategy ? { strategy: options.strategy } : {}),
  } satisfies ExecutionPreview;

  const hash = hashPreview(previewDraft);

  return {
    ...previewDraft,
    hash,
    previewId: hash,
  };
}
