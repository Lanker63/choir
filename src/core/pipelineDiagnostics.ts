import fs from "fs";
import path from "path";
import { deterministicId, stableStringify } from "./deterministicCore.js";
import { isNonNull, isRecord } from "../utils/guards.js";

export type PipelineDiagnosticsCategory =
  | "compiler"
  | "pipeline"
  | "planning"
  | "preview"
  | "simulation"
  | "execution"
  | "rollback"
  | "general";

export type PipelineDiagnosticsSource = "chat" | "extension" | "automation";

export type PipelineDiagnosticsResult = "success" | "failure";

export type PipelineDiagnosticsStage = {
  stage: string;
  status: "success" | "failure";
  detail: string;
};

export type PipelineDiagnosticsRecord = {
  id: string;
  timestamp: string;
  command: string;
  source: PipelineDiagnosticsSource;
  category: PipelineDiagnosticsCategory;
  result: PipelineDiagnosticsResult;
  summary: string;
  stages: PipelineDiagnosticsStage[];
  metadata?: Record<string, unknown>;
};

export type AppendPipelineDiagnosticsInput = {
  command: string;
  source: PipelineDiagnosticsSource;
  category: PipelineDiagnosticsCategory;
  result: PipelineDiagnosticsResult;
  summary: string;
  stages?: PipelineDiagnosticsStage[];
  metadata?: Record<string, unknown>;
  timestamp?: string;
};

const DIAGNOSTICS_LOG_FILE = path.join(".choir", "pipeline.diagnostics.jsonl");

function diagnosticsLogPath(root: string): string {
  return path.join(root, DIAGNOSTICS_LOG_FILE);
}

function ensureDiagnosticsStorage(root: string): void {
  const filePath = diagnosticsLogPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", "utf-8");
  }
}

function parseStage(value: unknown): PipelineDiagnosticsStage | null {
  if (!isRecord(value)) {
    return null;
  }

  const stage = typeof value.stage === "string" ? value.stage.trim() : "";
  const status = value.status;
  const detail = typeof value.detail === "string" ? value.detail : "";

  if (stage.length === 0) {
    return null;
  }

  if (status !== "success" && status !== "failure") {
    return null;
  }

  return {
    stage,
    status,
    detail,
  };
}

function normalizeStages(stages: PipelineDiagnosticsStage[] | undefined): PipelineDiagnosticsStage[] {
  return (stages ?? [])
    .filter((stage) => stage.stage.trim().length > 0)
    .map((stage) => ({
      stage: stage.stage.trim(),
      status: stage.status,
      detail: stage.detail,
    }));
}

function parseRecord(value: unknown): PipelineDiagnosticsRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const timestamp = typeof value.timestamp === "string" ? value.timestamp.trim() : "";
  const command = typeof value.command === "string" ? value.command.trim() : "";
  const source = value.source;
  const category = value.category;
  const result = value.result;
  const summary = typeof value.summary === "string" ? value.summary : "";

  if (id.length === 0 || timestamp.length === 0 || command.length === 0 || summary.length === 0) {
    return null;
  }

  if (source !== "chat" && source !== "extension" && source !== "automation") {
    return null;
  }

  if (
    category !== "compiler"
    && category !== "pipeline"
    && category !== "planning"
    && category !== "preview"
    && category !== "simulation"
    && category !== "execution"
    && category !== "rollback"
    && category !== "general"
  ) {
    return null;
  }

  if (result !== "success" && result !== "failure") {
    return null;
  }

  const stages = Array.isArray(value.stages)
    ? value.stages
      .map((entry) => parseStage(entry))
      .filter(isNonNull)
    : [];

  const metadata = isRecord(value.metadata) ? value.metadata : undefined;

  return {
    id,
    timestamp,
    command,
    source,
    category,
    result,
    summary,
    stages,
    ...(metadata ? { metadata } : {}),
  };
}

export function getPipelineDiagnosticsLogPath(root: string): string {
  return diagnosticsLogPath(root);
}

export function appendPipelineDiagnosticsRecord(
  root: string,
  input: AppendPipelineDiagnosticsInput
): PipelineDiagnosticsRecord {
  ensureDiagnosticsStorage(root);

  const timestamp = input.timestamp ?? new Date().toISOString();
  const stages = normalizeStages(input.stages);
  const seed = {
    timestamp,
    command: input.command,
    source: input.source,
    category: input.category,
    result: input.result,
    summary: input.summary,
    stages,
    metadata: input.metadata ?? {},
  };

  const record: PipelineDiagnosticsRecord = {
    id: deterministicId("diag", seed, 16),
    timestamp,
    command: input.command,
    source: input.source,
    category: input.category,
    result: input.result,
    summary: input.summary,
    stages,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };

  fs.appendFileSync(diagnosticsLogPath(root), `${stableStringify(record)}\n`, "utf-8");
  return record;
}

export function appendPipelineDiagnosticsRecordIfPossible(
  root: string | null | undefined,
  input: AppendPipelineDiagnosticsInput
): boolean {
  if (!root || root.trim().length === 0) {
    return false;
  }

  try {
    appendPipelineDiagnosticsRecord(root, input);
    return true;
  } catch {
    return false;
  }
}

export function readPipelineDiagnosticsRecords(
  root: string,
  options: { limit?: number } = {}
): PipelineDiagnosticsRecord[] {
  const filePath = diagnosticsLogPath(root);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (raw.length === 0) {
    return [];
  }

  const entries = raw
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .map((entry) => parseRecord(entry))
    .filter(isNonNull)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.id.localeCompare(left.id));

  const limit = options.limit;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0 && entries.length > limit) {
    return entries.slice(0, limit);
  }

  return entries;
}
