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
  compactWorkspaceSnapshotArtifacts,
  manifestFromWorkspaceSnapshot,
  readWorkspaceSnapshotManifest,
  restoreWorkspaceFromSnapshot,
  workspaceSnapshotFileContentMap,
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
import {
  semanticDiagnosticsForFixes,
  synthesizeSemanticFixesForWorkUnits,
} from "./semanticMaterializerRegistry.js";
import { classifyPatch, recordMutationTrace } from "./mutationTrace.js";

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

type MaterializationJournalStatus = "prepared" | "applying" | "verifying" | "committed" | "rolled-back";

type MaterializationJournal = {
  schemaVersion: 1;
  journalId: string;
  planId: string;
  strategyId: string;
  mutationHash: string;
  preWorkspaceSnapshotId: string;
  preWorkspaceSnapshotHash: string;
  requestedFiles: string[];
  preState: StatePlane;
  status: MaterializationJournalStatus;
  createdAt: string;
  updatedAt: string;
  manifestId?: string;
  errors: string[];
};

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function nowIso(): string {
  return new Date().toISOString();
}

function cloneState(value: StatePlane): StatePlane {
  return JSON.parse(JSON.stringify(value)) as StatePlane;
}

async function atomicWriteJsonFile(filePath: string, payload: unknown): Promise<void> {
  const serialized = `${stableStringify(payload)}\n`;
  const tempPath = `${filePath}.tmp-${deterministicHash(serialized).slice(0, 12)}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, serialized, "utf-8");
  await fs.rename(tempPath, filePath);
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

      const semanticFixes = synthesizeSemanticFixesForWorkUnits({
        root,
        controlPlane,
        workUnits,
        files,
      });
      const semanticDiagnostics = semanticDiagnosticsForFixes(semanticFixes);

      const allFixes = [...pipelineResult.fixes, ...semanticFixes]
        .map((fix) => cloneFix(root, fix))
        .sort((left, right) => left.id.localeCompare(right.id));
      const allDiagnostics = [...pipelineResult.diagnostics, ...semanticDiagnostics]
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
      const classified = classifyPatch(normalizedPatch);
      recordMutationTrace(root, {
        source: "materialization-engine",
        mechanism: classified.mechanism,
        safety: classified.safety,
        operation: classified.operation,
        targetFiles: classified.targetFiles,
        detail: `transaction=${transaction.id};batch=${transaction.batchId};order=${order}`,
        payloadHash: patchHash,
        payload: normalizedPatch,
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

function summarizeTransactionFailures(
  transactions: Transaction[],
  rollbackReasonsByBatch?: Map<string, string>
): string[] {
  return transactions
    .filter((transaction) => transaction.status !== "committed")
    .map((transaction) => {
      const errors = transaction.validation.errors ?? [];
      const failedChecks = transaction.validation.invariantChecks
        .filter((check) => !check.passed)
        .map((check) => check.details ? `${check.name}:${check.details}` : check.name);
      const rollbackReason = rollbackReasonsByBatch?.get(transaction.batchId);
      const details = [...errors, ...failedChecks, ...(rollbackReason ? [`rollback:${rollbackReason}`] : [])];
      return details.length > 0
        ? `${transaction.batchId}:${transaction.status} (${details.join(" | ")})`
        : `${transaction.batchId}:${transaction.status}`;
    });
}

async function captureRollbackSnapshot(root: string, executionPlan: ExecutionPlan, extraFiles: string[]): Promise<RollbackSnapshot> {
  const txFs = createNodeTransactionFS(root);
  const workspaceSnapshot = CanonicalWorkspaceHasher.capture(root);
  const workspaceManifest = manifestFromWorkspaceSnapshot(workspaceSnapshot, { role: "pre" });
  const planFiles = collectPlanFiles(executionPlan);
  const requestedFiles = sortedUnique([...planFiles, ...extraFiles]);
  const diskFiles = await txFs.readFiles(requestedFiles);

  return {
    workspaceManifest,
    files: diskFiles,
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

function materializationJournalDir(root: string): string {
  return path.join(materializationArtifactDir(root), "journal");
}

function materializationJournalPath(root: string, journalId: string): string {
  return path.join(materializationJournalDir(root), `${journalId}.json`);
}

async function persistMaterializationJournal(root: string, journal: MaterializationJournal): Promise<void> {
  await atomicWriteJsonFile(materializationJournalPath(root, journal.journalId), journal);
}

async function readMaterializationJournal(root: string, fileName: string): Promise<MaterializationJournal | null> {
  try {
    const raw = (await fs.readFile(path.join(materializationJournalDir(root), fileName), "utf-8")).trim();
    if (raw.length === 0) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<MaterializationJournal>;
    if (
      parsed.schemaVersion !== 1
      || typeof parsed.journalId !== "string"
      || typeof parsed.planId !== "string"
      || typeof parsed.strategyId !== "string"
      || typeof parsed.mutationHash !== "string"
      || typeof parsed.preWorkspaceSnapshotId !== "string"
      || typeof parsed.preWorkspaceSnapshotHash !== "string"
      || !Array.isArray(parsed.requestedFiles)
      || typeof parsed.preState !== "object"
      || parsed.preState === null
      || (parsed.status !== "prepared"
        && parsed.status !== "applying"
        && parsed.status !== "verifying"
        && parsed.status !== "committed"
        && parsed.status !== "rolled-back")
      || typeof parsed.createdAt !== "string"
      || typeof parsed.updatedAt !== "string"
      || !Array.isArray(parsed.errors)
    ) {
      return null;
    }

    return {
      schemaVersion: 1,
      journalId: parsed.journalId,
      planId: parsed.planId,
      strategyId: parsed.strategyId,
      mutationHash: parsed.mutationHash,
      preWorkspaceSnapshotId: parsed.preWorkspaceSnapshotId,
      preWorkspaceSnapshotHash: parsed.preWorkspaceSnapshotHash,
      requestedFiles: parsed.requestedFiles.map((entry) => String(entry)),
      preState: cloneState(parsed.preState as StatePlane),
      status: parsed.status,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      ...(typeof parsed.manifestId === "string" ? { manifestId: parsed.manifestId } : {}),
      errors: parsed.errors.map((entry) => String(entry)),
    };
  } catch {
    return null;
  }
}

async function recoverPendingMaterializationJournals(root: string): Promise<{ recovered: number; failures: string[] }> {
  const journalDirectory = materializationJournalDir(root);
  try {
    await fs.mkdir(journalDirectory, { recursive: true });
  } catch {
    return { recovered: 0, failures: [] };
  }

  const files = (await fs.readdir(journalDirectory))
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));

  let recovered = 0;
  const failures: string[] = [];

  for (const fileName of files) {
    const journal = await readMaterializationJournal(root, fileName);
    if (!journal || journal.status === "committed" || journal.status === "rolled-back") {
      continue;
    }

    const preSnapshot = readWorkspaceSnapshotManifest(root, journal.preWorkspaceSnapshotId);
    if (!preSnapshot) {
      failures.push(`journal=${journal.journalId} missing pre snapshot manifest ${journal.preWorkspaceSnapshotId}`);
      continue;
    }

    try {
      restoreWorkspaceFromSnapshot(root, preSnapshot);
      const txFs = createNodeTransactionFS(root);
      await txFs.writeState(cloneState(journal.preState));

      const nextJournal: MaterializationJournal = {
        ...journal,
        status: "rolled-back",
        updatedAt: nowIso(),
        errors: [...journal.errors, "Recovered interrupted materialization via pre-snapshot restore"],
      };
      await persistMaterializationJournal(root, nextJournal);
      recovered += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`journal=${journal.journalId} recovery failed: ${message}`);
    }
  }

  return { recovered, failures };
}

export async function recoverMaterializationLineage(root: string): Promise<{ recovered: number; failures: string[] }> {
  return recoverPendingMaterializationJournals(root);
}

async function persistManifest(root: string, manifest: ArtifactManifest): Promise<{ manifestPath: string; manifestHash: string }> {
  const dir = materializationArtifactDir(root);
  await fs.mkdir(dir, { recursive: true });

  const manifestPath = path.join(dir, `${manifest.manifestId}.json`);
  await atomicWriteJsonFile(manifestPath, manifest);

  return {
    manifestPath,
    manifestHash: deterministicHash(manifest),
  };
}

export async function compactMaterializationLineage(
  root: string,
  options?: { retainManifests?: number; retainJournals?: number; retainWorkspaceSnapshots?: number }
): Promise<{
  retainedManifests: number;
  removedManifests: number;
  retainedJournals: number;
  removedJournals: number;
  retainedWorkspaceSnapshots: number;
  removedWorkspaceSnapshots: number;
}> {
  const retainManifests = Math.max(1, options?.retainManifests ?? 256);
  const retainJournals = Math.max(1, options?.retainJournals ?? 256);
  const directory = materializationArtifactDir(root);
  await fs.mkdir(directory, { recursive: true });

  const manifestFiles = (await fs.readdir(directory))
    .filter((entry) => entry.endsWith(".json"))
    .map(async (name) => {
      const filePath = path.join(directory, name);
      const stat = await fs.stat(filePath);
      return {
        name,
        filePath,
        mtimeMs: stat.mtimeMs,
      };
    });

  const materializationEntries = (await Promise.all(manifestFiles))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  const manifestsToRemove = materializationEntries.slice(retainManifests);
  for (const entry of manifestsToRemove) {
    try {
      await fs.rm(entry.filePath, { force: true });
    } catch {
      // Best-effort compaction only.
    }
  }

  const journalDirectory = materializationJournalDir(root);
  await fs.mkdir(journalDirectory, { recursive: true });
  const journalEntries = (await Promise.all(
    (await fs.readdir(journalDirectory))
      .filter((entry) => entry.endsWith(".json"))
      .map(async (name) => {
        const filePath = path.join(journalDirectory, name);
        const stat = await fs.stat(filePath);
        return {
          name,
          filePath,
          mtimeMs: stat.mtimeMs,
        };
      })
  )).sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));

  const journalsToRemove = journalEntries.slice(retainJournals);
  for (const entry of journalsToRemove) {
    try {
      await fs.rm(entry.filePath, { force: true });
    } catch {
      // Best-effort compaction only.
    }
  }

  const workspaceCompaction = compactWorkspaceSnapshotArtifacts(root, {
    retainManifests: Math.max(1, options?.retainWorkspaceSnapshots ?? 512),
  });

  return {
    retainedManifests: materializationEntries.length - manifestsToRemove.length,
    removedManifests: manifestsToRemove.length,
    retainedJournals: journalEntries.length - journalsToRemove.length,
    removedJournals: journalsToRemove.length,
    retainedWorkspaceSnapshots: workspaceCompaction.retained,
    removedWorkspaceSnapshots: workspaceCompaction.removed,
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

  const rollbackReasonsByBatch = new Map(
    result.traces
      .filter((trace) => typeof trace.rollbackReason === "string" && trace.rollbackReason.trim().length > 0)
      .map((trace) => [trace.batchId, trace.rollbackReason as string] as const)
  );

  const failures = summarizeTransactionFailures(result.transactions, rollbackReasonsByBatch);
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
      const recovered = await recoverPendingMaterializationJournals(input.root);
      if (recovered.failures.length > 0) {
        return {
          success: false,
          rolledBack: false,
          transactionIds: [],
          mutationHash: "",
          workspaceHash: "",
          replayWorkspaceHash: "",
          preWorkspaceSnapshotId: "",
          preWorkspaceSnapshotHash: "",
          postWorkspaceSnapshotId: "",
          postWorkspaceSnapshotHash: "",
          manifestId: "",
          manifestPath: "",
          manifestHash: "",
          errors: recovered.failures,
        };
      }

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

      CanonicalWorkspaceHasher.persistManifest(input.root, rollbackSnapshot.workspaceManifest);

      let journal: MaterializationJournal = {
        schemaVersion: 1,
        journalId: deterministicId("materialization-journal", {
          planId: input.plan.planId,
          strategyId: input.plan.strategyId,
          mutationHash: input.plan.mutationSet.mutationHash,
          preWorkspaceSnapshotHash: rollbackSnapshot.workspaceManifest.workspaceSnapshotHash,
        }, 16),
        planId: input.plan.planId,
        strategyId: input.plan.strategyId,
        mutationHash: input.plan.mutationSet.mutationHash,
        preWorkspaceSnapshotId: rollbackSnapshot.workspaceManifest.manifestId,
        preWorkspaceSnapshotHash: rollbackSnapshot.workspaceManifest.workspaceSnapshotHash,
        requestedFiles: rollbackSnapshot.requestedFiles,
        preState: cloneState(rollbackSnapshot.state),
        status: "prepared",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        errors: [],
      };
      await persistMaterializationJournal(input.root, journal);

      const updateJournal = async (
        status: MaterializationJournalStatus,
        options?: { errors?: string[]; manifestId?: string }
      ): Promise<void> => {
        journal = {
          ...journal,
          status,
          updatedAt: nowIso(),
          ...(typeof options?.manifestId === "string" ? { manifestId: options.manifestId } : {}),
          ...(options?.errors
            ? { errors: [...journal.errors, ...options.errors] }
            : {}),
        };
        await persistMaterializationJournal(input.root, journal);
      };

      const rollbackWithJournal = async (errors: string[]): Promise<{ rolledBack: boolean; errors: string[] }> => {
        try {
          await rollbackWorkspace(input.root, rollbackSnapshot);
          await updateJournal("rolled-back", { errors });
          return { rolledBack: true, errors };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const combined = [...errors, `Rollback recovery failure: ${message}`];
          await updateJournal("rolled-back", { errors: combined });
          return { rolledBack: false, errors: combined };
        }
      };

      await updateJournal("applying");

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

      const rollbackReasonsByBatch = new Map(
        txResult.traces
          .filter((trace) => typeof trace.rollbackReason === "string" && trace.rollbackReason.trim().length > 0)
          .map((trace) => [trace.batchId, trace.rollbackReason as string] as const)
      );

      const failures = summarizeTransactionFailures(txResult.transactions, rollbackReasonsByBatch);
      if (failures.length > 0) {
        const rollback = await rollbackWithJournal(failures);
        return {
          success: false,
          rolledBack: rollback.rolledBack,
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
          errors: rollback.errors,
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
        const rollback = await rollbackWithJournal(replayProjection.errors);
        return {
          success: false,
          rolledBack: rollback.rolledBack,
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
          errors: rollback.errors,
        };
      }

      await updateJournal("verifying");

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
        const rollback = await rollbackWithJournal(mismatchErrors);
        return {
          success: false,
          rolledBack: rollback.rolledBack,
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
          errors: rollback.errors,
        };
      }

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
      await updateJournal("committed", { manifestId: manifest.manifestId });

      await compactMaterializationLineage(input.root, {
        retainManifests: 256,
        retainJournals: 256,
        retainWorkspaceSnapshots: 512,
      });

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

function replayInputFilesFromSnapshot(snapshot: WorkspaceSnapshotManifest, patchOperations: PatchOperation[]): Record<string, string> {
  const requiredPaths = sortedUnique(
    patchOperations.flatMap((operation) => {
      if (isTextPatch(operation.patch)) {
        return [normalizePath(operation.patch.location.file)];
      }

      if (operation.patch.type === "rename-file") {
        return [normalizePath(operation.patch.from)];
      }

      return [];
    })
  );

  return workspaceSnapshotFileContentMap(snapshot, {
    encoding: "utf8",
    includePaths: requiredPaths,
  });
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
  const recovered = await recoverPendingMaterializationJournals(input.root);
  if (recovered.failures.length > 0) {
    return {
      success: false,
      restored: false,
      manifestId: input.manifestId,
      workspaceHash: "",
      errors: recovered.failures,
    };
  }

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

  let preFiles: Record<string, string>;
  try {
    preFiles = replayInputFilesFromSnapshot(preSnapshot, manifest.mutationSet.patchOperations);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      restored: false,
      manifestId: manifest.manifestId,
      workspaceHash: "",
      errors: [`PATCH_ORDER_DIVERGENCE: ${message}`],
    };
  }

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
