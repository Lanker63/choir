import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { deterministicHash, deterministicId, stableStringify } from "./deterministicCore.js";

const SNAPSHOT_SCHEMA_VERSION = "1";
const HASH_CACHE_FILE_NAME = "hash-cache.json";
const DEFAULT_IGNORED_PREFIXES = [
  ".git",
  "node_modules",
  ".choir/artifacts",
  ".choir/artifacts/workspace-snapshots",
  ".choir/artifacts/materialization",
  ".choir/locks",
  ".choir/traces",
  ".choir/audit.log.jsonl",
  ".choir/mutation-trace.jsonl",
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

export type WorkspaceSnapshotCaptureOptions = {
  ignoredPrefixes?: string[];
  includeFileContent?: boolean;
  useHashCache?: boolean;
  enforceCaseInsensitivePortability?: boolean;
};

export type WorkspaceSnapshotProjectionUpdate = string | { contentBase64: string } | undefined;

export type WorkspaceSnapshotManifest = {
  schemaVersion: "1";
  manifestId: string;
  rootPath: string;
  workspaceSnapshotHash: string;
  entryCount: number;
  entries: WorkspaceSnapshotEntry[];
};

type WorkspaceHashCacheEntry = {
  size: number;
  mtimeMs: number;
  mode: number;
  hash: string;
};

type WorkspaceHashCache = {
  schemaVersion: 1;
  entries: Record<string, WorkspaceHashCacheEntry>;
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

function hashFileContent(absolutePath: string): string {
  const fd = fs.openSync(absolutePath, "r");
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead <= 0) {
        break;
      }

      hash.update(chunk.subarray(0, bytesRead));
    }

    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function snapshotArtifactsDir(root: string): string {
  return path.join(root, ".choir", "artifacts", "workspace-snapshots");
}

function hashCachePath(root: string): string {
  return path.join(snapshotArtifactsDir(root), HASH_CACHE_FILE_NAME);
}

function atomicWriteUtf8(filePath: string, payload: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${createHash("sha256").update(payload).digest("hex").slice(0, 12)}`;
  fs.writeFileSync(tmpPath, payload, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function readHashCache(root: string): WorkspaceHashCache {
  const filePath = hashCachePath(root);
  if (!fs.existsSync(filePath)) {
    return {
      schemaVersion: 1,
      entries: {},
    };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (raw.length === 0) {
      return {
        schemaVersion: 1,
        entries: {},
      };
    }

    const parsed = JSON.parse(raw) as Partial<WorkspaceHashCache>;
    if (parsed.schemaVersion !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
      return {
        schemaVersion: 1,
        entries: {},
      };
    }

    const entries = Object.fromEntries(
      Object.entries(parsed.entries)
        .filter(([, value]) => {
          const entry = value as Partial<WorkspaceHashCacheEntry>;
          return typeof entry.size === "number"
            && typeof entry.mtimeMs === "number"
            && typeof entry.mode === "number"
            && typeof entry.hash === "string";
        })
        .map(([key, value]) => [normalizeRelativePath(key), value as WorkspaceHashCacheEntry] as const)
    );

    return {
      schemaVersion: 1,
      entries,
    };
  } catch {
    return {
      schemaVersion: 1,
      entries: {},
    };
  }
}

function writeHashCache(root: string, entries: Record<string, WorkspaceHashCacheEntry>): void {
  const payload = `${stableStringify({
    schemaVersion: 1,
    entries,
  } satisfies WorkspaceHashCache)}\n`;
  atomicWriteUtf8(hashCachePath(root), payload);
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

export function captureWorkspaceSnapshot(root: string, options?: WorkspaceSnapshotCaptureOptions): WorkspaceSnapshot {
  const rootPath = path.resolve(root);
  const ignoredPrefixes = (options?.ignoredPrefixes ?? DEFAULT_IGNORED_PREFIXES)
    .map((entry) => normalizeRelativePath(entry));
  const includeFileContent = options?.includeFileContent !== false;
  const useHashCache = options?.useHashCache !== false;
  const enforceCaseInsensitivePortability = options?.enforceCaseInsensitivePortability !== false;
  const previousHashCache = useHashCache ? readHashCache(rootPath).entries : {};
  const nextHashCache: Record<string, WorkspaceHashCacheEntry> = {};
  const portabilityPathMap = new Map<string, string>();
  const entries: WorkspaceSnapshotEntry[] = [];

  const walk = (directoryPath: string): void => {
    const dirEntries = fs.readdirSync(directoryPath, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort((left, right) => compareLex(left.normalize("NFC"), right.normalize("NFC")));

    for (const name of dirEntries) {
      const absolutePath = path.join(directoryPath, name);
      const relativePath = toWorkspaceRelativePath(rootPath, absolutePath);

      if (enforceCaseInsensitivePortability) {
        const portabilityKey = relativePath.toLowerCase();
        const existingPath = portabilityPathMap.get(portabilityKey);
        if (existingPath && existingPath !== relativePath) {
          throw new Error(
            `Case-insensitive path collision detected: ${existingPath} vs ${relativePath}`
          );
        }

        portabilityPathMap.set(portabilityKey, relativePath);
      }

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

      const cacheCandidate = previousHashCache[relativePath];
      const mtimeMs = Math.floor(stat.mtimeMs);
      const cachedHashUsable = Boolean(
        cacheCandidate
          && cacheCandidate.size === stat.size
          && cacheCandidate.mtimeMs === mtimeMs
          && cacheCandidate.mode === mode
      );

      let contentHash = cachedHashUsable
        ? (cacheCandidate as WorkspaceHashCacheEntry).hash
        : hashFileContent(absolutePath);

      let contentBase64: string | undefined;
      if (includeFileContent) {
        const content = fs.readFileSync(absolutePath);
        contentHash = hashBuffer(content);
        contentBase64 = content.toString("base64");
      }

      nextHashCache[relativePath] = {
        size: stat.size,
        mtimeMs,
        mode,
        hash: contentHash,
      };

      entries.push({
        path: relativePath,
        type: "file",
        mode,
        size: stat.size,
        ...(contentBase64 ? { contentBase64 } : {}),
        contentHash,
      });
    }
  };

  walk(rootPath);

  if (useHashCache) {
    try {
      writeHashCache(rootPath, nextHashCache);
    } catch {
      // Hash cache persistence is best-effort and never affects integrity checks.
    }
  }

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
  atomicWriteUtf8(manifestPath, `${stableStringify(manifest)}\n`);

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

export function workspaceSnapshotFileContentMap(
  snapshot: WorkspaceSnapshotManifest | WorkspaceSnapshot,
  options?: { encoding?: "utf8" | "base64"; includePaths?: string[] }
): Record<string, string> {
  const files: Record<string, string> = {};
  const includePaths = options?.includePaths
    ? new Set(options.includePaths.map((entry) => normalizeRelativePath(entry)))
    : null;

  for (const entry of snapshot.entries) {
    if (entry.type !== "file") {
      continue;
    }

    if (includePaths && !includePaths.has(entry.path)) {
      continue;
    }

    const fileEntry = assertFileEntry(entry);
    if (options?.encoding === "base64") {
      files[fileEntry.path] = fileEntry.contentBase64;
      continue;
    }

    const bytes = Buffer.from(fileEntry.contentBase64, "base64");
    const decoded = bytes.toString("utf-8");
    const roundTrip = Buffer.from(decoded, "utf-8");
    if (!bytes.equals(roundTrip)) {
      throw new Error(`Binary content cannot be decoded as utf-8 for file: ${fileEntry.path}`);
    }

    files[fileEntry.path] = decoded;
  }

  return files;
}

function workspaceSnapshotFilesMap(snapshot: WorkspaceSnapshotManifest | WorkspaceSnapshot): Record<string, string> {
  return workspaceSnapshotFileContentMap(snapshot, { encoding: "utf8" });
}

function toUpdateBuffer(update: Exclude<WorkspaceSnapshotProjectionUpdate, undefined>): Buffer {
  if (typeof update === "string") {
    return Buffer.from(update, "utf-8");
  }

  return Buffer.from(update.contentBase64, "base64");
}

export function projectWorkspaceSnapshot(
  base: WorkspaceSnapshotManifest,
  updates: Record<string, WorkspaceSnapshotProjectionUpdate>
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
    const buffer = toUpdateBuffer(content);
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

  const portabilityPathMap = new Map<string, string>();
  for (const entry of entryMap.values()) {
    const portabilityKey = entry.path.toLowerCase();
    const existingPath = portabilityPathMap.get(portabilityKey);
    if (existingPath && existingPath !== entry.path) {
      throw new Error(`Case-insensitive path collision detected: ${existingPath} vs ${entry.path}`);
    }

    portabilityPathMap.set(portabilityKey, entry.path);
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
  const existing = captureWorkspaceSnapshot(rootPath, { includeFileContent: false });
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

  const verified = captureWorkspaceSnapshot(rootPath, { includeFileContent: false });
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

export function compactWorkspaceSnapshotArtifacts(root: string, options?: { retainManifests?: number }): {
  retained: number;
  removed: number;
} {
  const retainManifests = Math.max(1, options?.retainManifests ?? 256);
  const directory = snapshotArtifactsDir(root);
  if (!fs.existsSync(directory)) {
    return {
      retained: 0,
      removed: 0,
    };
  }

  const manifestFiles = fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== HASH_CACHE_FILE_NAME)
    .map((name) => {
      const filePath = path.join(directory, name);
      const stat = fs.statSync(filePath);
      return {
        name,
        filePath,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));

  const toRemove = manifestFiles.slice(retainManifests);
  for (const file of toRemove) {
    try {
      fs.rmSync(file.filePath, { force: true });
    } catch {
      // Compaction is best-effort and never weakens runtime correctness.
    }
  }

  return {
    retained: manifestFiles.length - toRemove.length,
    removed: toRemove.length,
  };
}

export class CanonicalWorkspaceHasher {
  static readonly SCHEMA_VERSION = SNAPSHOT_SCHEMA_VERSION;

  static capture(root: string, options?: WorkspaceSnapshotCaptureOptions): WorkspaceSnapshot {
    return captureWorkspaceSnapshot(root, options);
  }

  static captureHash(root: string, options?: Omit<WorkspaceSnapshotCaptureOptions, "includeFileContent">): {
    snapshotHash: string;
    entryCount: number;
  } {
    const snapshot = captureWorkspaceSnapshot(root, {
      ...options,
      includeFileContent: false,
    });

    return {
      snapshotHash: snapshot.snapshotHash,
      entryCount: snapshot.entryCount,
    };
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

  static project(
    base: WorkspaceSnapshotManifest,
    updates: Record<string, WorkspaceSnapshotProjectionUpdate>
  ): WorkspaceSnapshotManifest {
    return projectWorkspaceSnapshot(base, updates);
  }

  static compactArtifacts(root: string, options?: { retainManifests?: number }): { retained: number; removed: number } {
    return compactWorkspaceSnapshotArtifacts(root, options);
  }

  static restore(root: string, manifest: WorkspaceSnapshotManifest): { restoredHash: string; removedEntries: number } {
    return restoreWorkspaceFromSnapshot(root, manifest);
  }
}
