import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { Environment, Role, YAMLDiff } from "./policyEngine.js";

export type AuditEvent = {
  id: string;
  timestamp: string;
  actor: {
    role: Role;
    id?: string;
  };
  environment: Environment;
  action: string;
  resource: string;
  diff?: YAMLDiff[];
  result: "success" | "failure";
  metadata?: Record<string, unknown>;
};

export type DecisionTrace = {
  policiesEvaluated: {
    policyId: string;
    source: "org" | "repo" | "environment";
    matched: boolean;
    effect: "allow" | "deny" | "require-approval";
  }[];
  finalDecision: "allow" | "deny" | "require-approval";
  reasoning: string;
};

export type ComplianceRecord = {
  auditEvent: AuditEvent;
  decisionTrace: DecisionTrace;
  executionTrace?: {
    planId: string;
    patchesApplied: number;
    filesChanged: number;
  };
};

export type AuditRecord = ComplianceRecord & {
  hash: string;
  previousHash: string;
  chainIndex: number;
};

export type AuditStore = {
  records: AuditRecord[];
};

export type ComplianceReport = {
  period: {
    from: string;
    to: string;
  };
  summary: {
    totalEvents: number;
    approvalsRequired: number;
    denials: number;
  };
  findings: {
    violations: number;
    anomalies: number;
  };
  records: ComplianceRecord[];
};

export type RetentionPolicy = {
  durationDays: number;
};

export type AuditQueryFilters = {
  role?: Role;
  environment?: Environment;
  action?: string;
  timeRange?: [string, string];
};

export type ReportExportFormat = "json" | "yaml" | "pdf";

const AUDIT_LOG_FILE = path.join(".choir", "audit.log.jsonl");
const GENESIS_HASH = "GENESIS";

function normalizePathSegment(value: string): string {
  return value.split("\\").join("/");
}

function auditLogPath(root: string): string {
  return path.join(root, AUDIT_LOG_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeUnknown(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  const sortedKeys = Object.keys(value).sort((left, right) => left.localeCompare(right));
  return Object.fromEntries(
    sortedKeys.map((key) => [key, canonicalizeUnknown(value[key])])
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalizeUnknown(value));
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

function logicalTimestamp(chainIndex: number): string {
  return new Date(chainIndex * 1000).toISOString();
}

function ensureDecisionTrace(trace: DecisionTrace): DecisionTrace {
  const policiesEvaluated = [...trace.policiesEvaluated]
    .map((entry) => ({
      policyId: entry.policyId,
      source: entry.source,
      matched: entry.matched,
      effect: entry.effect,
    }))
    .sort((left, right) =>
      left.source.localeCompare(right.source)
      || left.policyId.localeCompare(right.policyId)
      || Number(left.matched) - Number(right.matched)
      || left.effect.localeCompare(right.effect)
    );

  return {
    policiesEvaluated,
    finalDecision: trace.finalDecision,
    reasoning: trace.reasoning,
  };
}

function normalizeDiffs(diffs: YAMLDiff[] | undefined): YAMLDiff[] | undefined {
  if (!Array.isArray(diffs)) {
    return undefined;
  }

  const normalized = [...diffs]
    .map((diff) => ({
      path: normalizePathSegment(diff.path),
      operation: diff.operation,
      ...(diff.before !== undefined ? { before: diff.before } : {}),
      ...(diff.after !== undefined ? { after: diff.after } : {}),
    }))
    .sort((left, right) =>
      left.path.localeCompare(right.path)
      || left.operation.localeCompare(right.operation)
      || stableStringify(left.before ?? null).localeCompare(stableStringify(right.before ?? null))
      || stableStringify(left.after ?? null).localeCompare(stableStringify(right.after ?? null))
    );

  return normalized;
}

function materializeAuditEvent(event: AuditEvent, chainIndex: number): AuditEvent {
  const timestamp = event.timestamp && event.timestamp.trim().length > 0
    ? event.timestamp
    : logicalTimestamp(chainIndex);

  const actor = {
    role: event.actor.role,
    ...(event.actor.id && event.actor.id.trim().length > 0 ? { id: event.actor.id } : {}),
  };

  const materialized: AuditEvent = {
    id: "",
    timestamp,
    actor,
    environment: event.environment,
    action: event.action,
    resource: normalizePathSegment(event.resource),
    ...(event.diff ? { diff: normalizeDiffs(event.diff) } : {}),
    result: event.result,
    ...(event.metadata ? { metadata: canonicalizeUnknown(event.metadata) as Record<string, unknown> } : {}),
  };

  const idSeed = stableStringify({
    chainIndex,
    timestamp: materialized.timestamp,
    actor: materialized.actor,
    environment: materialized.environment,
    action: materialized.action,
    resource: materialized.resource,
    diff: materialized.diff ?? [],
    result: materialized.result,
    metadata: materialized.metadata ?? {},
  });

  return {
    ...materialized,
    id: `audit-${sha256(idSeed).slice(0, 16)}`,
  };
}

function materializeComplianceRecord(input: ComplianceRecord, chainIndex: number): ComplianceRecord {
  return {
    auditEvent: materializeAuditEvent(input.auditEvent, chainIndex),
    decisionTrace: ensureDecisionTrace(input.decisionTrace),
    ...(input.executionTrace
      ? {
        executionTrace: {
          planId: input.executionTrace.planId,
          patchesApplied: input.executionTrace.patchesApplied,
          filesChanged: input.executionTrace.filesChanged,
        },
      }
      : {}),
  };
}

function toHashedRecord(record: ComplianceRecord, previousHash: string, chainIndex: number): AuditRecord {
  const payload = {
    chainIndex,
    previousHash,
    complianceRecord: record,
  };

  const hash = sha256(stableStringify(payload));

  return {
    ...record,
    previousHash,
    hash,
    chainIndex,
  };
}

function parseAuditRecord(line: string): AuditRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = JSON.parse(trimmed) as unknown;
  if (!isRecord(parsed)) {
    return null;
  }

  const auditEvent = parsed.auditEvent;
  const decisionTrace = parsed.decisionTrace;
  const hash = typeof parsed.hash === "string" ? parsed.hash : "";
  const previousHash = typeof parsed.previousHash === "string" ? parsed.previousHash : "";
  const chainIndex = typeof parsed.chainIndex === "number" ? parsed.chainIndex : NaN;

  if (!isRecord(auditEvent) || !isRecord(decisionTrace) || hash.length === 0 || previousHash.length === 0 || !Number.isFinite(chainIndex)) {
    return null;
  }

  const auditEventRole = auditEvent.actor;
  if (!isRecord(auditEventRole) || typeof auditEventRole.role !== "string") {
    return null;
  }

  const policiesEvaluatedRaw = decisionTrace.policiesEvaluated;
  if (!Array.isArray(policiesEvaluatedRaw)) {
    return null;
  }

  const policiesEvaluated = policiesEvaluatedRaw.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const policyId = typeof entry.policyId === "string" ? entry.policyId : "";
    const source = entry.source;
    const matched = typeof entry.matched === "boolean" ? entry.matched : false;
    const effect = entry.effect;

    if (
      policyId.length === 0
      || (source !== "org" && source !== "repo" && source !== "environment")
      || (effect !== "allow" && effect !== "deny" && effect !== "require-approval")
    ) {
      return [];
    }

    return [{
      policyId,
      source,
      matched,
      effect,
    } as DecisionTrace["policiesEvaluated"][number]];
  });

  const finalDecision = decisionTrace.finalDecision;
  if (finalDecision !== "allow" && finalDecision !== "deny" && finalDecision !== "require-approval") {
    return null;
  }

  const reasoning = typeof decisionTrace.reasoning === "string" ? decisionTrace.reasoning : "";

  const eventDiff = normalizeDiffs(Array.isArray(auditEvent.diff) ? auditEvent.diff as YAMLDiff[] : undefined);

  const materialized = materializeComplianceRecord({
    auditEvent: {
      id: typeof auditEvent.id === "string" ? auditEvent.id : "",
      timestamp: typeof auditEvent.timestamp === "string" ? auditEvent.timestamp : "",
      actor: {
        role: auditEventRole.role as Role,
        ...(typeof auditEventRole.id === "string" && auditEventRole.id.length > 0
          ? { id: auditEventRole.id }
          : {}),
      },
      environment: auditEvent.environment as Environment,
      action: typeof auditEvent.action === "string" ? auditEvent.action : "",
      resource: typeof auditEvent.resource === "string" ? auditEvent.resource : "",
      ...(eventDiff ? { diff: eventDiff } : {}),
      result: auditEvent.result === "failure" ? "failure" : "success",
      ...(isRecord(auditEvent.metadata) ? { metadata: auditEvent.metadata } : {}),
    },
    decisionTrace: {
      policiesEvaluated,
      finalDecision,
      reasoning,
    },
    ...(isRecord(parsed.executionTrace)
      ? {
        executionTrace: {
          planId: typeof parsed.executionTrace.planId === "string" ? parsed.executionTrace.planId : "",
          patchesApplied: typeof parsed.executionTrace.patchesApplied === "number" ? parsed.executionTrace.patchesApplied : 0,
          filesChanged: typeof parsed.executionTrace.filesChanged === "number" ? parsed.executionTrace.filesChanged : 0,
        },
      }
      : {}),
  }, chainIndex);

  return {
    ...materialized,
    hash,
    previousHash,
    chainIndex,
  };
}

export function readAuditStore(root: string): AuditStore {
  const filePath = auditLogPath(root);
  if (!fs.existsSync(filePath)) {
    return { records: [] };
  }

  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  const records = lines
    .map((line) => parseAuditRecord(line))
    .filter((record): record is AuditRecord => record !== null)
    .sort((left, right) => left.chainIndex - right.chainIndex);

  for (let index = 0; index < records.length; index += 1) {
    const current = records[index];
    const expectedIndex = index + 1;
    if (current.chainIndex !== expectedIndex) {
      throw new Error(`Audit chain index mismatch at position ${index}`);
    }

    const expectedPreviousHash = index === 0 ? GENESIS_HASH : records[index - 1].hash;
    if (current.previousHash !== expectedPreviousHash) {
      throw new Error(`Audit previousHash mismatch at chain index ${current.chainIndex}`);
    }

    const expectedHash = toHashedRecord({
      auditEvent: current.auditEvent,
      decisionTrace: current.decisionTrace,
      ...(current.executionTrace ? { executionTrace: current.executionTrace } : {}),
    }, current.previousHash, current.chainIndex).hash;

    if (current.hash !== expectedHash) {
      throw new Error(`Audit hash mismatch at chain index ${current.chainIndex}`);
    }
  }

  return {
    records,
  };
}

function appendAuditRecord(root: string, record: AuditRecord): void {
  const filePath = auditLogPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${stableStringify(record)}\n`, "utf-8");
}

export function recordAudit(root: string, event: ComplianceRecord): AuditRecord {
  const store = readAuditStore(root);
  const chainIndex = store.records.length + 1;
  const previousHash = chainIndex === 1 ? GENESIS_HASH : store.records[store.records.length - 1].hash;
  const record = materializeComplianceRecord(event, chainIndex);
  const hashedRecord = toHashedRecord(record, previousHash, chainIndex);
  appendAuditRecord(root, hashedRecord);
  return hashedRecord;
}

function toComplianceRecords(records: AuditRecord[]): ComplianceRecord[] {
  return records.map((record) => ({
    auditEvent: record.auditEvent,
    decisionTrace: record.decisionTrace,
    ...(record.executionTrace ? { executionTrace: record.executionTrace } : {}),
  }));
}

function inTimeRange(timestamp: string, range: [string, string]): boolean {
  return timestamp >= range[0] && timestamp <= range[1];
}

function applyRetention(records: AuditRecord[], retentionPolicy?: RetentionPolicy): AuditRecord[] {
  if (!retentionPolicy || retentionPolicy.durationDays <= 0) {
    return records;
  }

  const logicalNow = logicalTimestamp(records.length + 1);
  const nowEpoch = Date.parse(logicalNow);
  const minEpoch = nowEpoch - retentionPolicy.durationDays * 24 * 60 * 60 * 1000;

  return records.filter((record) => Date.parse(record.auditEvent.timestamp) >= minEpoch);
}

export function queryAudit(root: string, filters: AuditQueryFilters, retentionPolicy?: RetentionPolicy): ComplianceRecord[] {
  const store = readAuditStore(root);
  const retained = applyRetention(store.records, retentionPolicy);

  const filtered = retained.filter((record) => {
    if (filters.role && record.auditEvent.actor.role !== filters.role) {
      return false;
    }

    if (filters.environment && record.auditEvent.environment !== filters.environment) {
      return false;
    }

    if (filters.action && record.auditEvent.action !== filters.action) {
      return false;
    }

    if (filters.timeRange && !inTimeRange(record.auditEvent.timestamp, filters.timeRange)) {
      return false;
    }

    return true;
  });

  return toComplianceRecords(filtered);
}

export function detectAnomalies(records: ComplianceRecord[]): ComplianceRecord[] {
  return records.filter((record) => record.auditEvent.result === "failure");
}

function reportPeriod(records: ComplianceRecord[], requested?: [string, string]): { from: string; to: string } {
  if (requested) {
    return {
      from: requested[0],
      to: requested[1],
    };
  }

  if (records.length === 0) {
    const epoch = logicalTimestamp(0);
    return {
      from: epoch,
      to: epoch,
    };
  }

  return {
    from: records[0].auditEvent.timestamp,
    to: records[records.length - 1].auditEvent.timestamp,
  };
}

export function generateReport(
  root: string,
  filters: Omit<AuditQueryFilters, "timeRange"> & { timeRange?: [string, string] },
  retentionPolicy?: RetentionPolicy
): ComplianceReport {
  const records = queryAudit(root, filters, retentionPolicy);
  const anomalies = detectAnomalies(records);

  const approvalsRequired = records.filter((record) => record.decisionTrace.finalDecision === "require-approval").length;
  const denials = records.filter((record) => record.decisionTrace.finalDecision === "deny").length;

  return {
    period: reportPeriod(records, filters.timeRange),
    summary: {
      totalEvents: records.length,
      approvalsRequired,
      denials,
    },
    findings: {
      violations: denials,
      anomalies: anomalies.length,
    },
    records,
  };
}

function escapePdfText(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function buildPdfDocument(lines: string[]): string {
  const body = [
    "BT",
    "/F1 11 Tf",
    "50 760 Td",
    ...lines.map((line, index) => `${index === 0 ? "" : "T* "}(${escapePdfText(line)}) Tj`),
    "ET",
  ].join("\n");

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let offset = "%PDF-1.4\n".length;
  const offsets: number[] = [0];
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }

  const xrefStart = offset;
  const xrefEntries = [
    "0000000000 65535 f ",
    ...offsets.slice(1).map((entry) => `${entry.toString().padStart(10, "0")} 00000 n `),
  ];

  const xref = [
    `xref\n0 ${objects.length + 1}`,
    ...xrefEntries,
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    `${xrefStart}`,
    "%%EOF",
  ].join("\n");

  return `%PDF-1.4\n${objects.join("")}${xref}`;
}

export function exportReport(report: ComplianceReport, format: ReportExportFormat): string {
  if (format === "json") {
    return JSON.stringify(canonicalizeUnknown(report), null, 2);
  }

  if (format === "yaml") {
    return YAML.stringify(canonicalizeUnknown(report));
  }

  const lines = [
    "Choir Compliance Report",
    `Period: ${report.period.from} -> ${report.period.to}`,
    `Total Events: ${report.summary.totalEvents}`,
    `Approvals Required: ${report.summary.approvalsRequired}`,
    `Denied: ${report.summary.denials}`,
    `Violations: ${report.findings.violations}`,
    `Anomalies: ${report.findings.anomalies}`,
  ];

  return buildPdfDocument(lines);
}
