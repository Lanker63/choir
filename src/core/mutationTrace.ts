import fs from "fs";
import path from "path";
import { Patch, isTextPatch } from "../fix/types.js";
import { deterministicId, stableStringify } from "./deterministicCore.js";

export type MutationMechanism =
  | "text-patch"
  | "file-patch"
  | "ts-morph"
  | "yaml-structured"
  | "state-structured"
  | "workspace-snapshot";

export type MutationSafety =
  | "safe"
  | "conditionally-safe"
  | "fragile"
  | "dangerously-fragile";

export type MutationTraceRecord = {
  id: string;
  source: string;
  mechanism: MutationMechanism;
  safety: MutationSafety;
  operation: string;
  targetFiles: string[];
  payloadHash: string;
  detail?: string;
};

export type MutationTraceInput = Omit<MutationTraceRecord, "id" | "payloadHash" | "targetFiles"> & {
  targetFiles?: string[];
  payload?: unknown;
  payloadHash?: string;
};

export type MutationTraceSummary = {
  total: number;
  byMechanism: Record<MutationMechanism, number>;
  bySafety: Record<MutationSafety, number>;
};

const MECHANISMS: MutationMechanism[] = [
  "text-patch",
  "file-patch",
  "ts-morph",
  "yaml-structured",
  "state-structured",
  "workspace-snapshot",
];

const SAFETY_LEVELS: MutationSafety[] = [
  "safe",
  "conditionally-safe",
  "fragile",
  "dangerously-fragile",
];

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => normalizePath(value)).filter((value) => value.length > 0)))
    .sort((left, right) => left.localeCompare(right));
}

function tracePath(root: string): string {
  return path.join(root, ".choir", "mutation-trace.jsonl");
}

export function findMutationTraceRoot(startPath: string): string | undefined {
  let current = path.resolve(startPath);
  try {
    const stat = fs.existsSync(current) ? fs.statSync(current) : null;
    if (stat?.isFile()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  while (true) {
    if (fs.existsSync(path.join(current, ".choir"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

function patchTargetFiles(patch: Patch): string[] {
  if (isTextPatch(patch)) {
    return [patch.location.file];
  }

  if (patch.type === "create-file" || patch.type === "delete-file") {
    return [patch.file];
  }

  return [patch.from, patch.to];
}

export function classifyPatch(patch: Patch): {
  mechanism: MutationMechanism;
  safety: MutationSafety;
  operation: string;
  targetFiles: string[];
} {
  if (isTextPatch(patch)) {
    return {
      mechanism: "text-patch",
      safety: "fragile",
      operation: patch.type,
      targetFiles: sortedUnique(patchTargetFiles(patch)),
    };
  }

  return {
    mechanism: "file-patch",
    safety: patch.type === "delete-file" ? "dangerously-fragile" : "conditionally-safe",
    operation: patch.type,
    targetFiles: sortedUnique(patchTargetFiles(patch)),
  };
}

function materializeRecord(input: MutationTraceInput): MutationTraceRecord {
  const targetFiles = sortedUnique(input.targetFiles ?? []);
  const payloadHash = input.payloadHash ?? deterministicId("payload", input.payload ?? {
    source: input.source,
    mechanism: input.mechanism,
    safety: input.safety,
    operation: input.operation,
    targetFiles,
    detail: input.detail ?? "",
  }, 16);

  const base = {
    source: input.source,
    mechanism: input.mechanism,
    safety: input.safety,
    operation: input.operation,
    targetFiles,
    payloadHash,
    detail: input.detail ?? "",
  };

  return {
    id: deterministicId("mutation", base, 16),
    source: input.source,
    mechanism: input.mechanism,
    safety: input.safety,
    operation: input.operation,
    targetFiles,
    payloadHash,
    ...(input.detail ? { detail: input.detail } : {}),
  };
}

export function recordMutationTrace(root: string, input: MutationTraceInput): MutationTraceRecord {
  const record = materializeRecord(input);
  try {
    const filePath = tracePath(root);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${stableStringify(record)}\n`, "utf-8");
  } catch {
    // Mutation tracing is observability only; it must never change execution behavior.
  }

  return record;
}

function emptySummary(): MutationTraceSummary {
  return {
    total: 0,
    byMechanism: Object.fromEntries(MECHANISMS.map((mechanism) => [mechanism, 0])) as Record<MutationMechanism, number>,
    bySafety: Object.fromEntries(SAFETY_LEVELS.map((safety) => [safety, 0])) as Record<MutationSafety, number>,
  };
}

export function summarizeMutationTraces(root: string): MutationTraceSummary {
  const summary = emptySummary();
  try {
    const raw = fs.readFileSync(tracePath(root), "utf-8").trim();
    if (raw.length === 0) {
      return summary;
    }

    for (const line of raw.split(/\r?\n/)) {
      const parsed = JSON.parse(line) as Partial<MutationTraceRecord>;
      if (!parsed.mechanism || !parsed.safety) {
        continue;
      }

      if (!MECHANISMS.includes(parsed.mechanism) || !SAFETY_LEVELS.includes(parsed.safety)) {
        continue;
      }

      summary.total += 1;
      summary.byMechanism[parsed.mechanism] += 1;
      summary.bySafety[parsed.safety] += 1;
    }
  } catch {
    return summary;
  }

  return summary;
}
