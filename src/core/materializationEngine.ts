import fs from "fs/promises";
import path from "path";
import { ControlPlane, Plan } from "../schema.js";
import { Fix, Patch, isTextPatch } from "../fix/types.js";
import { buildWorkspaceSnapshot, WorkspaceSnapshot } from "./context.js";
import { deterministicHash, deterministicId, stableSortBy, stableStringify } from "./deterministicCore.js";
import { locationToOffsetRange } from "./diagnostics.js";
import { FileChange, generateDiff, groupPatchesByFile, hashPreview } from "./executionPreview.js";
import {
  CanonicalWorkspaceHasher,
  manifestFromWorkspaceSnapshot,
  readWorkspaceSnapshotManifest,
  restoreWorkspaceFromSnapshot,
  workspaceSnapshotFilesMap,
  type WorkspaceSnapshotManifest,
} from "./workspaceSnapshot.js";
import { withWorkspaceMutationLock } from "./workspaceLockCoordinator.js";
import { runPipeline } from "./pipeline.js";
import {
  buildExecutionPlan,
  createInMemoryTransactionFS,
  createNodeTransactionFS,
  runExecutionPlanTransactionally,
  type ExecutionPlan,
  type Transaction,
  type TransactionEnforcer,
  type TransactionPipeline,
} from "./scheduler.js";
import { createEmptyStatePlane, readStatePlane, type StatePlane } from "./state.js";
import type { Diagnostic } from "./types.js";

export type PatchOperation = {
  id: string;
  transactionId: string;
  batchId: string;
  order: number;
  files: string[];
  patch: Patch;
  patchHash: string;
};

export type WorkspaceMutation = {
  file: string;
  operation: "create" | "update" | "delete";
  patchOperationIds: string[];
  beforeHash: string;
  afterHash: string;
  diffHash: string;
};

export type MutationSet = {
  files: string[];
  patchCount: number;
  patchOperations: PatchOperation[];
  workspaceMutations: WorkspaceMutation[];
  previewHash: string;
  mutationHash: string;
};

export type ArtifactManifest = {
  schemaVersion: "2";
  manifestId: string;
  planId: string;
  strategyId: string;
  transactionIds: string[];
  mutationSet: MutationSet;
  mutationHash: string;
  patchOrderHash: string;
  previewHash: string;
  preWorkspaceSnapshotId: string;
  preWorkspaceSnapshotHash: string;
  postWorkspaceSnapshotId: string;
  postWorkspaceSnapshotHash: string;
  workspaceHashBefore: string;
  workspaceHashAfter: string;
  replayWorkspaceHash: string;
  manifestHash: string;
};

export type MaterializationPlan = {
  planId: string;
  strategyId: string;
  executionPlan: ExecutionPlan;
  mutationSet: MutationSet;
  artifactManifest: ArtifactManifest;
};

export type GenerateMaterializationPlanInput = {
  root: string;
  controlPlane: ControlPlane;
  plan: Plan;
  strategyId: string;
};

export type ApplyMaterializationPlanInput = {
  root: string;
  controlPlane: ControlPlane;
  plan: MaterializationPlan;
};

export type ApplyMaterializationPlanResult = {
  success: boolean;
  rolledBack: boolean;
  transactionIds: string[];
  mutationHash: string;
  workspaceHash: string;
  replayWorkspaceHash: string;
  preWorkspaceSnapshotId: string;
  preWorkspaceSnapshotHash: string;
  postWorkspaceSnapshotId: string;
  postWorkspaceSnapshotHash: string;
  manifestId: string;
  manifestPath: string;
  manifestHash: string;
  errors: string[];
};

export type ReplayMaterializationResult = {
  success: boolean;
  restored: boolean;
  manifestId: string;
  workspaceHash: string;
  errors: string[];
};

type RollbackSnapshot = {
  workspaceManifest: WorkspaceSnapshotManifest;
  files: Record<string, string>;
  state: StatePlane;
  requestedFiles: string[];
};

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function toRelativePath(root: string, value: string): string {
  const normalized = normalizePath(value);
  if (!path.isAbsolute(value)) {
    return normalized;
  }

  const relative = normalizePath(path.relative(root, value));
  if (relative.startsWith("../") || relative === "..") {
    throw new Error(`Path escapes workspace root: ${value}`);
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

  const visit = (fix: Fix): void => {
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
  };

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

function buildSnapshotFromFiles(root: string, files: Record<string, string>): WorkspaceSnapshot {
  const tsFiles = Object.keys(files)
    .filter((file) => file.endsWith(".ts"))
    .sort((left, right) => left.localeCompare(right))
    .map((file) => ({
      path: path.resolve(root, file),
      content: files[file] as string,
    }));

  return {
    root,
    files: tsFiles,
  };
}

async function readFilesFromDisk(root: string, files: string[]): Promise<Record<string, string>> {
  const entries: Array<[string, string]> = [];

  for (const file of sortedUnique(files.map((entry) => normalizePath(entry)))) {
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

function collectPlanFiles(executionPlan: ExecutionPlan): string[] {
  return sortedUnique(
    executionPlan.batches.flatMap((batch) =>
      batch.workUnits.flatMap((unit) => unit.files.map((file) => normalizePath(file)))
    )
  );
}

function createMaterializationEnforcer(
  root: string,
  controlPlane: ControlPlane,
  loadFiles: () => Promise<Record<string, string>>
): TransactionEnforcer {
  return {
    async proposeFixes(workUnits) {
      const files = await loadFiles();
      const workspace = buildSnapshotFromFiles(root, files);
      const pipelineResult = await runPipeline({
        controlPlane,
        workspace,
        persistState: false,
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

function createMaterializationPipeline(
  root: string,
  controlPlane: ControlPlane,
  loadFiles: () => Promise<Record<string, string>>
): TransactionPipeline {
  return {
    async run(input) {
      const diskFiles = await loadFiles();
      const mergedFiles = {
        ...diskFiles,
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
        persistState: false,
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

function applyTextPatch(content: string, patch: Extract<Patch, { type: "replace" | "insert" | "delete" }>): {
  next: string;
  error?: string;
} {
  try {
    const offsets = locationToOffsetRange(content, patch.location);

    if (patch.type === "replace") {
      const actual = content.slice(offsets.start, offsets.end);
      if (patch.expectedText !== undefined && patch.expectedText !== actual) {
        return { next: content, error: "replace expectedText mismatch" };
      }

      return {
        next: `${content.slice(0, offsets.start)}${patch.text}${content.slice(offsets.end)}`,
      };
    }

    if (patch.type === "delete") {
      const actual = content.slice(offsets.start, offsets.end);
      if (patch.expectedText !== undefined && patch.expectedText !== actual) {
        return { next: content, error: "delete expectedText mismatch" };
      }

      return {
        next: `${content.slice(0, offsets.start)}${content.slice(offsets.end)}`,
      };
    }

    const insertionPoint = patch.position === "after" ? offsets.end : offsets.start;
    return {
      next: `${content.slice(0, insertionPoint)}${patch.text}${content.slice(insertionPoint)}`,
    };
  } catch (error) {
    return { next: content, error: (error as Error).message };
  }
}

function applyPatchToFiles(initialFiles: Record<string, string>, patch: Patch): {
  files: Record<string, string>;
  error?: string;
} {
  const files = { ...initialFiles };

  if (!isTextPatch(patch)) {
    if (patch.type === "create-file") {
      files[normalizePath(patch.file)] = patch.content;
      return { files };
    }

    if (patch.type === "delete-file") {
      delete files[normalizePath(patch.file)];
      return { files };
    }

    const fromFile = normalizePath(patch.from);
    const toFile = normalizePath(patch.to);
    if (!Object.prototype.hasOwnProperty.call(files, fromFile)) {
      return {
        files,
        error: `rename source not found: ${fromFile}`,
      };
    }

    if (Object.prototype.hasOwnProperty.call(files, toFile)) {
      return {
        files,
        error: `rename destination already exists: ${toFile}`,
      };
    }

    files[toFile] = files[fromFile] as string;
    delete files[fromFile];
    return { files };
  }

  const file = normalizePath(patch.location.file);
  const source = files[file];
  if (source === undefined) {
    return {
      files,
      error: `targets missing file: ${file}`,
    };
  }

  const applied = applyTextPatch(source, patch);
  if (applied.error) {
    return {
      files,
      error: applied.error,
    };
  }

  files[file] = applied.next;
  return { files };
}

function hashPatchOrder(patchOperations: PatchOperation[]): string {
  return deterministicHash(
    patchOperations.map((operation) => ({
      id: operation.id,
      order: operation.order,
      patchHash: operation.patchHash,
      files: operation.files,
    }))
  );
}

function buildSnapshotUpdates(files: Record<string, string>, requestedFiles: string[]): Record<string, string | undefined> {
  const updates: Record<string, string | undefined> = {};

  for (const file of sortedUnique(requestedFiles.map((entry) => normalizePath(entry)))) {
    updates[file] = Object.prototype.hasOwnProperty.call(files, file)
      ? files[file]
      : undefined;
  }

  return updates;
}

function previewFilesFromPatches(
  initialFiles: Record<string, string>,
  patchOperations: PatchOperation[]
): { files: Record<string, string>; errors: string[] } {
  let files = { ...initialFiles };
  const errors: string[] = [];

  for (const operation of patchOperations) {
    const next = applyPatchToFiles(files, operation.patch);
    files = next.files;
    if (next.error) {
      errors.push(`operation=${operation.id} ${next.error}`);
    }
  }

  return {
    files,
    errors,
  };
}

function buildPatchOperations(root: string, transactions: Transaction[]): PatchOperation[] {
  const orderedTransactions = stableSortBy(
    transactions.filter((transaction) => transaction.status === "committed"),
    (transaction) => `${transaction.batchId}:${transaction.id}`
  );

  const operations: PatchOperation[] = [];
  let order = 0;

  for (const transaction of orderedTransactions) {
    for (let index = 0; index < transaction.proposedPatches.length; index += 1) {
      const normalizedPatch = clonePatch(root, transaction.proposedPatches[index] as Patch);
      const files = sortedUnique(patchFiles(normalizedPatch));
      const patchHash = deterministicHash({ patch: normalizedPatch, files });
      operations.push({
        id: deterministicId("patch-op", {
          transactionId: transaction.id,
          index,
          patchHash,
        }, 16),
        transactionId: transaction.id,
        batchId: transaction.batchId,
        order,
        files,
        patch: normalizedPatch,
        patchHash,
      });
      order += 1;
    }
  }

  return operations;
}

function buildFileChanges(
  initialFiles: Record<string, string>,
  finalFiles: Record<string, string>,
  patchOperations: PatchOperation[]
): FileChange[] {
  const patches = patchOperations.map((operation) => operation.patch);
  const grouped = groupPatchesByFile(patches);

  const changedFiles = sortedUnique(
    [...grouped.keys()].filter((file) => (initialFiles[file] ?? "") !== (finalFiles[file] ?? "") || grouped.has(file))
  );

  return changedFiles.map((file) => {
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
}

function workspaceMutationKind(before: string | undefined, after: string | undefined): WorkspaceMutation["operation"] {
  if (before === undefined && after !== undefined) {
    return "create";
  }

  if (before !== undefined && after === undefined) {
    return "delete";
  }

  return "update";
}

function buildMutationSet(
  initialFiles: Record<string, string>,
  finalFiles: Record<string, string>,
  patchOperations: PatchOperation[]
): MutationSet {
  const files = sortedUnique(patchOperations.flatMap((operation) => operation.files));
  const fileChanges = buildFileChanges(initialFiles, finalFiles, patchOperations);

  const workspaceMutations: WorkspaceMutation[] = fileChanges.map((change) => {
    const operationIds = patchOperations
      .filter((operation) => operation.files.includes(change.file))
      .map((operation) => operation.id);

    const before = Object.prototype.hasOwnProperty.call(initialFiles, change.file)
      ? initialFiles[change.file]
      : undefined;
    const after = Object.prototype.hasOwnProperty.call(finalFiles, change.file)
      ? finalFiles[change.file]
      : undefined;

    return {
      file: change.file,
      operation: workspaceMutationKind(before, after),
      patchOperationIds: operationIds,
      beforeHash: deterministicHash({ file: change.file, content: before ?? null }),
      afterHash: deterministicHash({ file: change.file, content: after ?? null }),
      diffHash: deterministicHash({ file: change.file, diff: change.diff }),
    };
  });

  const previewHash = hashPreview({ fileChanges });
  const mutationHash = deterministicHash({
    files,
    patchOperations: patchOperations.map((operation) => ({
      id: operation.id,
      transactionId: operation.transactionId,
      batchId: operation.batchId,
      order: operation.order,
      files: operation.files,
      patchHash: operation.patchHash,
      patch: operation.patch,
    })),
    workspaceMutations,
    previewHash,
  });

  return {
    files,
    patchCount: patchOperations.length,
    patchOperations,
    workspaceMutations,
    previewHash,
    mutationHash,
  };
}

function summarizeTransactionFailures(transactions: Transaction[]): string[] {
  return transactions
    .filter((transaction) => transaction.status !== "committed")
    .map((transaction) => {
      const errors = transaction.validation.errors ?? [];
      return errors.length > 0
        ? `${transaction.batchId}:${transaction.status} (${errors.join(" | ")})`
        : `${transaction.batchId}:${transaction.status}`;
    });
}

async function captureRollbackSnapshot(root: string, executionPlan: ExecutionPlan, extraFiles: string[]): Promise<RollbackSnapshot> {
  const txFs = createNodeTransactionFS(root);
  const workspaceSnapshot = CanonicalWorkspaceHasher.capture(root);
  const workspaceManifest = manifestFromWorkspaceSnapshot(workspaceSnapshot, { role: "pre" });
  const workspaceFiles = workspaceSnapshotFilesMap(workspaceManifest);
  const planFiles = collectPlanFiles(executionPlan);
  const requestedFiles = sortedUnique([...Object.keys(workspaceFiles), ...planFiles, ...extraFiles]);
  const diskFiles = await txFs.readFiles(requestedFiles);

  return {
    workspaceManifest,
    files: {
      ...workspaceFiles,
      ...diskFiles,
    },
    state: await txFs.readStateJson(),
    requestedFiles,
  };
}

async function rollbackWorkspace(
  root: string,
  snapshot: RollbackSnapshot
): Promise<void> {
  const txFs = createNodeTransactionFS(root);
  restoreWorkspaceFromSnapshot(root, snapshot.workspaceManifest);
  await txFs.writeState(snapshot.state);
}

function materializationArtifactDir(root: string): string {
  return path.join(root, ".choir", "artifacts", "materialization");
}

async function persistManifest(root: string, manifest: ArtifactManifest): Promise<{ manifestPath: string; manifestHash: string }> {
  const dir = materializationArtifactDir(root);
  await fs.mkdir(dir, { recursive: true });

  const manifestPath = path.join(dir, `${manifest.manifestId}.json`);
  const payload = `${stableStringify(manifest)}\n`;
  await fs.writeFile(manifestPath, payload, "utf-8");

  return {
    manifestPath,
    manifestHash: deterministicHash(manifest),
  };
}

function buildArtifactManifest(input: {
  planId: string;
  strategyId: string;
  transactionIds: string[];
  mutationSet: MutationSet;
  preWorkspaceSnapshotId: string;
  preWorkspaceSnapshotHash: string;
  postWorkspaceSnapshotId: string;
  postWorkspaceSnapshotHash: string;
  workspaceHashBefore: string;
  workspaceHashAfter: string;
  replayWorkspaceHash: string;
}): ArtifactManifest {
  const base = {
    schemaVersion: "2" as const,
    planId: input.planId,
    strategyId: input.strategyId,
    transactionIds: sortedUnique(input.transactionIds),
    mutationSet: input.mutationSet,
    mutationHash: input.mutationSet.mutationHash,
    patchOrderHash: hashPatchOrder(input.mutationSet.patchOperations),
    previewHash: input.mutationSet.previewHash,
    preWorkspaceSnapshotId: input.preWorkspaceSnapshotId,
    preWorkspaceSnapshotHash: input.preWorkspaceSnapshotHash,
    postWorkspaceSnapshotId: input.postWorkspaceSnapshotId,
    postWorkspaceSnapshotHash: input.postWorkspaceSnapshotHash,
    workspaceHashBefore: input.workspaceHashBefore,
    workspaceHashAfter: input.workspaceHashAfter,
    replayWorkspaceHash: input.replayWorkspaceHash,
  };

  const manifestId = deterministicId("materialization", base, 16);
  const manifestHash = deterministicHash({ manifestId, ...base });

  return {
    manifestId,
    ...base,
    manifestHash,
  };
}

export async function generateMaterializationPlan(
  input: GenerateMaterializationPlanInput
): Promise<MaterializationPlan> {
  const preWorkspaceSnapshot = CanonicalWorkspaceHasher.capture(input.root);
  const preWorkspaceManifest = manifestFromWorkspaceSnapshot(preWorkspaceSnapshot, { role: "pre" });
  const executionPlan = buildExecutionPlan([input.plan]).executionPlan;
  const workspaceFiles = toRelativeFilesMap(input.root, buildWorkspaceSnapshot(input.root));
  const planFiles = collectPlanFiles(executionPlan);
  const diskPlanFiles = await readFilesFromDisk(input.root, planFiles);
  const initialState = readStatePlane(input.root) ?? createEmptyStatePlane();

  const txFs = createInMemoryTransactionFS({
    files: {
      ...workspaceFiles,
      ...diskPlanFiles,
    },
    state: initialState,
  });

  const loadMemoryFiles = async (): Promise<Record<string, string>> => txFs.snapshot().files;

  const result = await runExecutionPlanTransactionally(executionPlan, {
    root: input.root,
    fs: txFs,
    controlPlane: input.controlPlane,
    enforcer: createMaterializationEnforcer(input.root, input.controlPlane, loadMemoryFiles),
    pipeline: createMaterializationPipeline(input.root, input.controlPlane, loadMemoryFiles),
    executeLayersInParallel: false,
  });

  const failures = summarizeTransactionFailures(result.transactions);
  if (failures.length > 0) {
    throw new Error(`Materialization generation failed: ${failures.join(", ")}`);
  }

  const initialFiles = { ...workspaceFiles, ...diskPlanFiles };
  const finalFiles = txFs.snapshot().files;
  const patchOperations = buildPatchOperations(input.root, result.transactions);
  const mutationSet = buildMutationSet(initialFiles, finalFiles, patchOperations);

  const replayProjection = previewFilesFromPatches(initialFiles, mutationSet.patchOperations);
  if (replayProjection.errors.length > 0) {
    throw new Error(`Mutation replay failed during generation: ${replayProjection.errors.join(" | ")}`);
  }

  const projectedPostManifest = CanonicalWorkspaceHasher.project(
    preWorkspaceManifest,
    buildSnapshotUpdates(replayProjection.files, mutationSet.files)
  );

  const workspaceHashBefore = preWorkspaceManifest.workspaceSnapshotHash;
  const workspaceHashAfter = projectedPostManifest.workspaceSnapshotHash;
  const replayWorkspaceHash = projectedPostManifest.workspaceSnapshotHash;

  if (workspaceHashAfter !== replayWorkspaceHash) {
    throw new Error(
      `Generated workspace hash mismatch: projected=${workspaceHashAfter} replay=${replayWorkspaceHash}`
    );
  }

  const artifactManifest = buildArtifactManifest({
    planId: input.plan.id,
    strategyId: input.strategyId,
    transactionIds: result.transactions.map((transaction) => transaction.id),
    mutationSet,
    preWorkspaceSnapshotId: preWorkspaceManifest.manifestId,
    preWorkspaceSnapshotHash: preWorkspaceManifest.workspaceSnapshotHash,
    postWorkspaceSnapshotId: projectedPostManifest.manifestId,
    postWorkspaceSnapshotHash: projectedPostManifest.workspaceSnapshotHash,
    workspaceHashBefore,
    workspaceHashAfter,
    replayWorkspaceHash,
  });

  return {
    planId: input.plan.id,
    strategyId: input.strategyId,
    executionPlan,
    mutationSet,
    artifactManifest,
  };
}

export async function applyMaterializationPlan(
  input: ApplyMaterializationPlanInput
): Promise<ApplyMaterializationPlanResult> {
  return withWorkspaceMutationLock(
    input.root,
    deterministicId("workspace-owner", {
      action: "apply-materialization",
      planId: input.plan.planId,
      strategyId: input.plan.strategyId,
      mutationHash: input.plan.mutationSet.mutationHash,
    }, 16),
    async () => {
  const rollbackSnapshot = await captureRollbackSnapshot(
    input.root,
    input.plan.executionPlan,
    input.plan.mutationSet.files
  );

  if (rollbackSnapshot.workspaceManifest.workspaceSnapshotHash !== input.plan.artifactManifest.preWorkspaceSnapshotHash) {
    return {
      success: false,
      rolledBack: false,
      transactionIds: [],
      mutationHash: "",
      workspaceHash: rollbackSnapshot.workspaceManifest.workspaceSnapshotHash,
      replayWorkspaceHash: "",
      preWorkspaceSnapshotId: rollbackSnapshot.workspaceManifest.manifestId,
      preWorkspaceSnapshotHash: rollbackSnapshot.workspaceManifest.workspaceSnapshotHash,
      postWorkspaceSnapshotId: "",
      postWorkspaceSnapshotHash: "",
      manifestId: "",
      manifestPath: "",
      manifestHash: "",
      errors: [
        `Workspace snapshot divergence before apply: expected=${input.plan.artifactManifest.preWorkspaceSnapshotHash} actual=${rollbackSnapshot.workspaceManifest.workspaceSnapshotHash}`,
      ],
    };
  }

  const loadDiskFiles = async (): Promise<Record<string, string>> => {
    const snapshot = buildWorkspaceSnapshot(input.root);
    return toRelativeFilesMap(input.root, snapshot);
  };

  const txResult = await runExecutionPlanTransactionally(input.plan.executionPlan, {
    root: input.root,
    controlPlane: input.controlPlane,
    enforcer: createMaterializationEnforcer(input.root, input.controlPlane, loadDiskFiles),
    pipeline: createMaterializationPipeline(input.root, input.controlPlane, loadDiskFiles),
    executeLayersInParallel: false,
  });

  const failures = summarizeTransactionFailures(txResult.transactions);

  if (failures.length > 0) {
    await rollbackWorkspace(input.root, rollbackSnapshot);

    return {
      success: false,
      rolledBack: true,
      transactionIds: txResult.transactions.map((transaction) => transaction.id),
      mutationHash: "",
      workspaceHash: "",
      replayWorkspaceHash: "",
      preWorkspaceSnapshotId: rollbackSnapshot.workspaceManifest.manifestId,
      preWorkspaceSnapshotHash: rollbackSnapshot.workspaceManifest.workspaceSnapshotHash,
      postWorkspaceSnapshotId: "",
      postWorkspaceSnapshotHash: "",
      manifestId: "",
      manifestPath: "",
      manifestHash: "",
      errors: failures,
    };
  }

  const txFs = createNodeTransactionFS(input.root);
  const actualFilesRead = await txFs.readFiles(input.plan.mutationSet.files);
  const currentWorkspaceFiles = toRelativeFilesMap(input.root, buildWorkspaceSnapshot(input.root));
  const afterFiles = {
    ...currentWorkspaceFiles,
    ...actualFilesRead,
  };

  const patchOperations = buildPatchOperations(input.root, txResult.transactions);
  const mutationSet = buildMutationSet(rollbackSnapshot.files, afterFiles, patchOperations);
  const replayProjection = previewFilesFromPatches(rollbackSnapshot.files, mutationSet.patchOperations);

  if (replayProjection.errors.length > 0) {
    await rollbackWorkspace(input.root, rollbackSnapshot);

    return {
      success: false,
      rolledBack: true,
      transactionIds: txResult.transactions.map((transaction) => transaction.id),
      mutationHash: mutationSet.mutationHash,
      workspaceHash: "",
      replayWorkspaceHash: "",
      preWorkspaceSnapshotId: rollbackSnapshot.workspaceManifest.manifestId,
      preWorkspaceSnapshotHash: rollbackSnapshot.workspaceManifest.workspaceSnapshotHash,
      postWorkspaceSnapshotId: "",
      postWorkspaceSnapshotHash: "",
      manifestId: "",
      manifestPath: "",
      manifestHash: "",
      errors: replayProjection.errors,
    };
  }

  const postWorkspaceSnapshot = CanonicalWorkspaceHasher.capture(input.root);
  const postWorkspaceManifest = manifestFromWorkspaceSnapshot(postWorkspaceSnapshot, { role: "post" });

  const replayWorkspaceManifest = CanonicalWorkspaceHasher.project(
    rollbackSnapshot.workspaceManifest,
    buildSnapshotUpdates(replayProjection.files, mutationSet.files)
  );

  const workspaceHash = postWorkspaceManifest.workspaceSnapshotHash;
  const replayWorkspaceHash = replayWorkspaceManifest.workspaceSnapshotHash;

  const mismatchErrors: string[] = [];
  if (mutationSet.mutationHash !== input.plan.mutationSet.mutationHash) {
    mismatchErrors.push(
      `Mutation hash mismatch: expected=${input.plan.mutationSet.mutationHash}, actual=${mutationSet.mutationHash}`
    );
  }

  if (mutationSet.previewHash !== input.plan.mutationSet.previewHash) {
    mismatchErrors.push(
      `Preview hash mismatch: expected=${input.plan.mutationSet.previewHash}, actual=${mutationSet.previewHash}`
    );
  }

  const actualPatchOrderHash = hashPatchOrder(mutationSet.patchOperations);
  if (actualPatchOrderHash !== input.plan.artifactManifest.patchOrderHash) {
    mismatchErrors.push(
      `Patch order hash mismatch: expected=${input.plan.artifactManifest.patchOrderHash}, actual=${actualPatchOrderHash}`
    );
  }

  if (workspaceHash !== replayWorkspaceHash) {
    mismatchErrors.push(`Workspace replay mismatch: execution=${workspaceHash}, replay=${replayWorkspaceHash}`);
  }

  if (workspaceHash !== input.plan.artifactManifest.postWorkspaceSnapshotHash) {
    mismatchErrors.push(
      `Workspace snapshot hash mismatch: expected=${input.plan.artifactManifest.postWorkspaceSnapshotHash}, actual=${workspaceHash}`
    );
  }

  if (rollbackSnapshot.workspaceManifest.workspaceSnapshotHash !== input.plan.artifactManifest.preWorkspaceSnapshotHash) {
    mismatchErrors.push(
      `Pre-workspace snapshot hash mismatch: expected=${input.plan.artifactManifest.preWorkspaceSnapshotHash}, actual=${rollbackSnapshot.workspaceManifest.workspaceSnapshotHash}`
    );
  }

  if (process.env.CHOIR_TEST_ROLLBACK === "1" && txResult.transactions.length > 0) {
    mismatchErrors.push("Forced rollback for testing: CHOIR_TEST_ROLLBACK=1; rollback=applied");
  }

  if (mismatchErrors.length > 0) {
    await rollbackWorkspace(input.root, rollbackSnapshot);

    return {
      success: false,
      rolledBack: true,
      transactionIds: txResult.transactions.map((transaction) => transaction.id),
      mutationHash: mutationSet.mutationHash,
      workspaceHash,
      replayWorkspaceHash,
      preWorkspaceSnapshotId: rollbackSnapshot.workspaceManifest.manifestId,
      preWorkspaceSnapshotHash: rollbackSnapshot.workspaceManifest.workspaceSnapshotHash,
      postWorkspaceSnapshotId: "",
      postWorkspaceSnapshotHash: "",
      manifestId: "",
      manifestPath: "",
      manifestHash: "",
      errors: mismatchErrors,
    };
  }

  CanonicalWorkspaceHasher.persistManifest(input.root, rollbackSnapshot.workspaceManifest);
  CanonicalWorkspaceHasher.persistManifest(input.root, postWorkspaceManifest);

  const manifest = buildArtifactManifest({
    planId: input.plan.planId,
    strategyId: input.plan.strategyId,
    transactionIds: txResult.transactions.map((transaction) => transaction.id),
    mutationSet,
    preWorkspaceSnapshotId: rollbackSnapshot.workspaceManifest.manifestId,
    preWorkspaceSnapshotHash: rollbackSnapshot.workspaceManifest.workspaceSnapshotHash,
    postWorkspaceSnapshotId: postWorkspaceManifest.manifestId,
    postWorkspaceSnapshotHash: postWorkspaceManifest.workspaceSnapshotHash,
    workspaceHashBefore: rollbackSnapshot.workspaceManifest.workspaceSnapshotHash,
    workspaceHashAfter: workspaceHash,
    replayWorkspaceHash,
  });

  const persisted = await persistManifest(input.root, manifest);

  return {
    success: true,
    rolledBack: false,
    transactionIds: txResult.transactions.map((transaction) => transaction.id),
    mutationHash: mutationSet.mutationHash,
    workspaceHash,
    replayWorkspaceHash,
    preWorkspaceSnapshotId: rollbackSnapshot.workspaceManifest.manifestId,
    preWorkspaceSnapshotHash: rollbackSnapshot.workspaceManifest.workspaceSnapshotHash,
    postWorkspaceSnapshotId: postWorkspaceManifest.manifestId,
    postWorkspaceSnapshotHash: postWorkspaceManifest.workspaceSnapshotHash,
    manifestId: manifest.manifestId,
    manifestPath: persisted.manifestPath,
    manifestHash: persisted.manifestHash,
    errors: [],
  };
    }
  );
}

async function readArtifactManifest(root: string, manifestId: string): Promise<ArtifactManifest | undefined> {
  const manifestPath = path.join(materializationArtifactDir(root), `${manifestId}.json`);
  try {
    const raw = (await fs.readFile(manifestPath, "utf-8")).trim();
    if (raw.length === 0) {
      return undefined;
    }

    return JSON.parse(raw) as ArtifactManifest;
  } catch {
    return undefined;
  }
}

export async function replayMaterializationFromLineage(input: {
  root: string;
  manifestId: string;
  restore?: boolean;
}): Promise<ReplayMaterializationResult> {
  return withWorkspaceMutationLock(
    input.root,
    deterministicId("workspace-owner", {
      action: "replay-materialization",
      manifestId: input.manifestId,
    }, 16),
    async () => {
  const manifest = await readArtifactManifest(input.root, input.manifestId);
  if (!manifest) {
    return {
      success: false,
      restored: false,
      manifestId: input.manifestId,
      workspaceHash: "",
      errors: ["MANIFEST_TAMPER: materialization manifest missing or unreadable"],
    };
  }

  const preSnapshot = readWorkspaceSnapshotManifest(input.root, manifest.preWorkspaceSnapshotId);
  const postSnapshot = readWorkspaceSnapshotManifest(input.root, manifest.postWorkspaceSnapshotId);
  if (!preSnapshot || !postSnapshot) {
    return {
      success: false,
      restored: false,
      manifestId: manifest.manifestId,
      workspaceHash: "",
      errors: [
        `MANIFEST_TAMPER: snapshot manifest missing pre=${manifest.preWorkspaceSnapshotId} post=${manifest.postWorkspaceSnapshotId}`,
      ],
    };
  }

  const patchOrderHash = hashPatchOrder(manifest.mutationSet.patchOperations);
  if (patchOrderHash !== manifest.patchOrderHash) {
    return {
      success: false,
      restored: false,
      manifestId: manifest.manifestId,
      workspaceHash: "",
      errors: [
        `PATCH_ORDER_DIVERGENCE: expected=${manifest.patchOrderHash} actual=${patchOrderHash}`,
      ],
    };
  }

  const preFiles = workspaceSnapshotFilesMap(preSnapshot);
  const replayProjection = previewFilesFromPatches(preFiles, manifest.mutationSet.patchOperations);
  if (replayProjection.errors.length > 0) {
    return {
      success: false,
      restored: false,
      manifestId: manifest.manifestId,
      workspaceHash: "",
      errors: replayProjection.errors.map((entry) => `PATCH_ORDER_DIVERGENCE: ${entry}`),
    };
  }

  const replayWorkspaceManifest = CanonicalWorkspaceHasher.project(
    preSnapshot,
    buildSnapshotUpdates(replayProjection.files, manifest.mutationSet.files)
  );

  if (replayWorkspaceManifest.workspaceSnapshotHash !== manifest.postWorkspaceSnapshotHash) {
    return {
      success: false,
      restored: false,
      manifestId: manifest.manifestId,
      workspaceHash: replayWorkspaceManifest.workspaceSnapshotHash,
      errors: [
        `WORKSPACE_SNAPSHOT_DIVERGENCE: expected=${manifest.postWorkspaceSnapshotHash} actual=${replayWorkspaceManifest.workspaceSnapshotHash}`,
      ],
    };
  }

  if (replayWorkspaceManifest.workspaceSnapshotHash !== postSnapshot.workspaceSnapshotHash) {
    return {
      success: false,
      restored: false,
      manifestId: manifest.manifestId,
      workspaceHash: replayWorkspaceManifest.workspaceSnapshotHash,
      errors: [
        `REPLAY_LINEAGE_DIVERGENCE: replay=${replayWorkspaceManifest.workspaceSnapshotHash} persisted=${postSnapshot.workspaceSnapshotHash}`,
      ],
    };
  }

  if (input.restore !== false) {
    restoreWorkspaceFromSnapshot(input.root, postSnapshot);
  }

  return {
    success: true,
    restored: input.restore !== false,
    manifestId: manifest.manifestId,
    workspaceHash: replayWorkspaceManifest.workspaceSnapshotHash,
    errors: [],
  };
    }
  );
}
