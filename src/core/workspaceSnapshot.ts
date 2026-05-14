import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { deterministicHash, deterministicId, stableStringify } from "./deterministicCore.js";

const SNAPSHOT_SCHEMA_VERSION = "1";
const DEFAULT_IGNORED_PREFIXES = [
  ".git",
  "node_modules",
  ".choir/artifacts",
  ".choir/artifacts/workspace-snapshots",
  ".choir/artifacts/materialization",
  ".choir/locks",
  ".choir/traces",
  ".choir/audit.log.jsonl",
  ".choir/pipeline.diagnostics.jsonl",
  ".choir/pipeline-diagnostics.jsonl",
  ".choir/state.json",
  ".choir/state.recovery.json",
  ".choir/state.transitions.jsonl",
  ".choir/state.snapshots.jsonl",
  ".choir/state.audit.jsonl",
];

export type WorkspaceEntryType = "file" | "directory" | "symlink";

export type WorkspaceSnapshotEntry = {
  path: string;
  type: WorkspaceEntryType;
  mode: number;
  size: number;
  contentBase64?: string;
  contentHash?: string;
  linkTarget?: string;
};

export type WorkspaceSnapshot = {
  root: string;
  entryCount: number;
  entries: WorkspaceSnapshotEntry[];
  snapshotHash: string;
};

export type WorkspaceSnapshotManifest = {
  schemaVersion: "1";
  manifestId: string;
  rootPath: string;
  workspaceSnapshotHash: string;
  entryCount: number;
  entries: WorkspaceSnapshotEntry[];
};

function compareLex(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizePathSeparators(value: string): string {
  return value.split("\\").join("/");
}

function normalizeRelativePath(value: string): string {
  const normalized = normalizePathSeparators(value).normalize("NFC");
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`Path escapes workspace root: ${value}`);
  }

  return segments.join("/");
}

function normalizeAbsolutePath(value: string): string {
  return normalizePathSeparators(path.resolve(value)).normalize("NFC");
}

function toWorkspaceRelativePath(root: string, absolutePath: string): string {
  const relative = normalizeRelativePath(path.relative(root, absolutePath));
  if (!relative || relative.startsWith("../") || relative === "..") {
    throw new Error(`Path escapes workspace root: ${absolutePath}`);
  }

  return relative;
}

function isIgnoredPath(relativePath: string, ignoredPrefixes: string[]): boolean {
  return ignoredPrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
}

function sortedEntries(entries: WorkspaceSnapshotEntry[]): WorkspaceSnapshotEntry[] {
  return [...entries].sort((left, right) => {
    const byPath = compareLex(left.path, right.path);
    if (byPath !== 0) {
      return byPath;
    }

    const byType = compareLex(left.type, right.type);
    if (byType !== 0) {
      return byType;
    }

    return left.mode - right.mode;
  });
}

function canonicalEntryDigest(entry: WorkspaceSnapshotEntry): Record<string, unknown> {
  return {
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    size: entry.size,
    ...(entry.type === "file"
      ? {
        contentHash: entry.contentHash ?? null,
      }
      : {}),
    ...(entry.type === "symlink"
      ? {
        linkTarget: entry.linkTarget ?? null,
      }
      : {}),
  };
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function snapshotArtifactsDir(root: string): string {
  return path.join(root, ".choir", "artifacts", "workspace-snapshots");
}

function assertFileEntry(entry: WorkspaceSnapshotEntry): WorkspaceSnapshotEntry & {
  type: "file";
  contentBase64: string;
  contentHash: string;
} {
  if (entry.type !== "file" || typeof entry.contentBase64 !== "string" || typeof entry.contentHash !== "string") {
    throw new Error(`Invalid snapshot file entry: ${entry.path}`);
  }

  return entry as WorkspaceSnapshotEntry & {
    type: "file";
    contentBase64: string;
    contentHash: string;
  };
}

function assertSymlinkEntry(entry: WorkspaceSnapshotEntry): WorkspaceSnapshotEntry & {
  type: "symlink";
  linkTarget: string;
} {
  if (entry.type !== "symlink" || typeof entry.linkTarget !== "string") {
    throw new Error(`Invalid snapshot symlink entry: ${entry.path}`);
  }

  return entry as WorkspaceSnapshotEntry & {
    type: "symlink";
    linkTarget: string;
  };
}

function parentDirectories(relativePath: string): string[] {
  const parts = relativePath.split("/");
  const parents: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    parents.push(parts.slice(0, index).join("/"));
  }
  return parents;
}

export function hashWorkspaceSnapshotEntries(entries: WorkspaceSnapshotEntry[]): string {
  const payload = sortedEntries(entries).map((entry) => canonicalEntryDigest(entry));
  return deterministicHash(payload);
}

export function captureWorkspaceSnapshot(root: string, options?: { ignoredPrefixes?: string[] }): WorkspaceSnapshot {
  const rootPath = path.resolve(root);
  const ignoredPrefixes = (options?.ignoredPrefixes ?? DEFAULT_IGNORED_PREFIXES)
    .map((entry) => normalizeRelativePath(entry));
  const entries: WorkspaceSnapshotEntry[] = [];

  const walk = (directoryPath: string): void => {
    const dirEntries = fs.readdirSync(directoryPath, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort((left, right) => compareLex(left.normalize("NFC"), right.normalize("NFC")));

    for (const name of dirEntries) {
      const absolutePath = path.join(directoryPath, name);
      const relativePath = toWorkspaceRelativePath(rootPath, absolutePath);
      if (isIgnoredPath(relativePath, ignoredPrefixes)) {
        continue;
      }

      const stat = fs.lstatSync(absolutePath);
      const mode = stat.mode & 0o777;

      if (stat.isSymbolicLink()) {
        entries.push({
          path: relativePath,
          type: "symlink",
          mode,
          size: 0,
          linkTarget: normalizePathSeparators(fs.readlinkSync(absolutePath)).normalize("NFC"),
        });
        continue;
      }

      if (stat.isDirectory()) {
        entries.push({
          path: relativePath,
          type: "directory",
          mode,
          size: 0,
        });
        walk(absolutePath);
        continue;
      }

      if (!stat.isFile()) {
        throw new Error(`Unsupported workspace entry type at ${relativePath}`);
      }

      const content = fs.readFileSync(absolutePath);
      entries.push({
        path: relativePath,
        type: "file",
        mode,
        size: content.byteLength,
        contentBase64: content.toString("base64"),
        contentHash: hashBuffer(content),
      });
    }
  };

  walk(rootPath);

  const canonicalEntries = sortedEntries(entries);
  return {
    root: normalizeAbsolutePath(rootPath),
    entryCount: canonicalEntries.length,
    entries: canonicalEntries,
    snapshotHash: hashWorkspaceSnapshotEntries(canonicalEntries),
  };
}

export function manifestFromWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot,
  options?: { role?: "pre" | "post" | "capture" | "projection"; manifestId?: string }
): WorkspaceSnapshotManifest {
  const manifestId = options?.manifestId
    ?? deterministicId("workspace-snapshot", {
      role: options?.role ?? "capture",
      snapshotHash: snapshot.snapshotHash,
      entryCount: snapshot.entryCount,
    }, 16);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    manifestId,
    rootPath: snapshot.root,
    workspaceSnapshotHash: snapshot.snapshotHash,
    entryCount: snapshot.entryCount,
    entries: sortedEntries(snapshot.entries),
  };
}

export function persistWorkspaceSnapshotManifest(root: string, manifest: WorkspaceSnapshotManifest): {
  manifestPath: string;
  manifestHash: string;
} {
  const directory = snapshotArtifactsDir(root);
  fs.mkdirSync(directory, { recursive: true });

  const manifestPath = path.join(directory, `${manifest.manifestId}.json`);
  fs.writeFileSync(manifestPath, `${stableStringify(manifest)}\n`, "utf-8");

  return {
    manifestPath,
    manifestHash: deterministicHash(manifest),
  };
}

export function readWorkspaceSnapshotManifest(root: string, manifestId: string): WorkspaceSnapshotManifest | undefined {
  const manifestPath = path.join(snapshotArtifactsDir(root), `${manifestId}.json`);
  if (!fs.existsSync(manifestPath)) {
    return undefined;
  }

  try {
    const raw = fs.readFileSync(manifestPath, "utf-8").trim();
    if (raw.length === 0) {
      return undefined;
    }

    const parsed = JSON.parse(raw) as WorkspaceSnapshotManifest;
    if (
      parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
      || typeof parsed.manifestId !== "string"
      || typeof parsed.rootPath !== "string"
      || typeof parsed.workspaceSnapshotHash !== "string"
      || typeof parsed.entryCount !== "number"
      || !Array.isArray(parsed.entries)
    ) {
      return undefined;
    }

    return {
      ...parsed,
      entries: sortedEntries(parsed.entries.map((entry) => ({
        ...entry,
        path: normalizeRelativePath(entry.path),
      }))),
    };
  } catch {
    return undefined;
  }
}

export function workspaceSnapshotFilesMap(snapshot: WorkspaceSnapshotManifest | WorkspaceSnapshot): Record<string, string> {
  const files: Record<string, string> = {};

  for (const entry of snapshot.entries) {
    if (entry.type !== "file") {
      continue;
    }

    const fileEntry = assertFileEntry(entry);
    files[fileEntry.path] = Buffer.from(fileEntry.contentBase64, "base64").toString("utf-8");
  }

  return files;
}

export function projectWorkspaceSnapshot(
  base: WorkspaceSnapshotManifest,
  updates: Record<string, string | undefined>
): WorkspaceSnapshotManifest {
  const entryMap = new Map<string, WorkspaceSnapshotEntry>(
    sortedEntries(base.entries).map((entry) => [entry.path, { ...entry }])
  );

  const addDirectoryIfMissing = (directoryPath: string): void => {
    if (!directoryPath || entryMap.has(directoryPath)) {
      return;
    }

    entryMap.set(directoryPath, {
      path: directoryPath,
      type: "directory",
      mode: 0o755,
      size: 0,
    });
  };

  for (const [rawPath, content] of Object.entries(updates).sort(([left], [right]) => compareLex(left, right))) {
    const relativePath = normalizeRelativePath(rawPath);

    if (content === undefined) {
      entryMap.delete(relativePath);
      continue;
    }

    const existing = entryMap.get(relativePath);
    const mode = existing?.type === "file" ? existing.mode : 0o644;
    const buffer = Buffer.from(content, "utf-8");
    entryMap.set(relativePath, {
      path: relativePath,
      type: "file",
      mode,
      size: buffer.byteLength,
      contentBase64: buffer.toString("base64"),
      contentHash: hashBuffer(buffer),
    });

    for (const directoryPath of parentDirectories(relativePath)) {
      addDirectoryIfMissing(directoryPath);
    }
  }

  const entries = sortedEntries([...entryMap.values()]);
  const workspaceSnapshotHash = hashWorkspaceSnapshotEntries(entries);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    manifestId: deterministicId("workspace-snapshot", {
      role: "projection",
      workspaceSnapshotHash,
      entryCount: entries.length,
    }, 16),
    rootPath: base.rootPath,
    workspaceSnapshotHash,
    entryCount: entries.length,
    entries,
  };
}

export function restoreWorkspaceFromSnapshot(root: string, manifest: WorkspaceSnapshotManifest): {
  restoredHash: string;
  removedEntries: number;
} {
  const rootPath = path.resolve(root);
  const existing = captureWorkspaceSnapshot(rootPath);
  const targetEntries = sortedEntries(manifest.entries);
  const targetPathSet = new Set(targetEntries.map((entry) => entry.path));

  const removableEntries = sortedEntries(existing.entries)
    .filter((entry) => !targetPathSet.has(entry.path))
    .sort((left, right) => {
      const depthDelta = right.path.split("/").length - left.path.split("/").length;
      if (depthDelta !== 0) {
        return depthDelta;
      }

      if (left.type === "directory" && right.type !== "directory") {
        return 1;
      }

      if (right.type === "directory" && left.type !== "directory") {
        return -1;
      }

      return compareLex(left.path, right.path);
    });

  for (const entry of removableEntries) {
    const absolutePath = path.join(rootPath, entry.path);
    try {
      fs.rmSync(absolutePath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  const directories = targetEntries
    .filter((entry): entry is WorkspaceSnapshotEntry & { type: "directory" } => entry.type === "directory")
    .sort((left, right) => compareLex(left.path, right.path));

  for (const entry of directories) {
    const absolutePath = path.join(rootPath, entry.path);
    fs.mkdirSync(absolutePath, { recursive: true });
    try {
      fs.chmodSync(absolutePath, entry.mode);
    } catch {
      // Permission updates are best-effort and platform-dependent.
    }
  }

  const leaves = targetEntries
    .filter((entry) => entry.type !== "directory")
    .sort((left, right) => compareLex(left.path, right.path));

  for (const entry of leaves) {
    const absolutePath = path.join(rootPath, entry.path);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

    try {
      fs.rmSync(absolutePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup races before restore write.
    }

    if (entry.type === "symlink") {
      const symlinkEntry = assertSymlinkEntry(entry);
      fs.symlinkSync(symlinkEntry.linkTarget, absolutePath);
      continue;
    }

    const fileEntry = assertFileEntry(entry);
    fs.writeFileSync(absolutePath, Buffer.from(fileEntry.contentBase64, "base64"));
    try {
      fs.chmodSync(absolutePath, fileEntry.mode);
    } catch {
      // Permission updates are best-effort and platform-dependent.
    }
  }

  const verified = captureWorkspaceSnapshot(rootPath);
  if (verified.snapshotHash !== manifest.workspaceSnapshotHash) {
    throw new Error(
      `Workspace snapshot restore mismatch expected=${manifest.workspaceSnapshotHash} actual=${verified.snapshotHash}`
    );
  }

  return {
    restoredHash: verified.snapshotHash,
    removedEntries: removableEntries.length,
  };
}

export class CanonicalWorkspaceHasher {
  static readonly SCHEMA_VERSION = SNAPSHOT_SCHEMA_VERSION;

  static capture(root: string, options?: { ignoredPrefixes?: string[] }): WorkspaceSnapshot {
    return captureWorkspaceSnapshot(root, options);
  }

  static hashEntries(entries: WorkspaceSnapshotEntry[]): string {
    return hashWorkspaceSnapshotEntries(entries);
  }

  static toManifest(
    snapshot: WorkspaceSnapshot,
    options?: { role?: "pre" | "post" | "capture" | "projection"; manifestId?: string }
  ): WorkspaceSnapshotManifest {
    return manifestFromWorkspaceSnapshot(snapshot, options);
  }

  static persistManifest(root: string, manifest: WorkspaceSnapshotManifest): { manifestPath: string; manifestHash: string } {
    return persistWorkspaceSnapshotManifest(root, manifest);
  }

  static readManifest(root: string, manifestId: string): WorkspaceSnapshotManifest | undefined {
    return readWorkspaceSnapshotManifest(root, manifestId);
  }

  static project(base: WorkspaceSnapshotManifest, updates: Record<string, string | undefined>): WorkspaceSnapshotManifest {
    return projectWorkspaceSnapshot(base, updates);
  }

  static restore(root: string, manifest: WorkspaceSnapshotManifest): { restoredHash: string; removedEntries: number } {
    return restoreWorkspaceFromSnapshot(root, manifest);
  }
}
