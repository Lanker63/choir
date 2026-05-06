import fs from "fs";
import path from "path";
import { deterministicHash, deterministicId, stableSortBy, stableStringify } from "./deterministicCore.js";
import type { SystemState } from "./distributedSync.js";

export type GlobalState = Record<string, SystemState>;

export type PersistedState = {
  version: string;
  currentHash: string;
  logicalTime: number;
};

export type TransitionRecord = {
  id: string;
  transactionId: string;
  logicalTime: number;
  fromHash: string;
  toHash: string;
  operation: string;
  timestamp: number;
  unitId: string;
  unitStateAfter: SystemState;
};

export type Snapshot = {
  id: string;
  stateHash: string;
  state: GlobalState;
  logicalTime: number;
};

export type AuditRecord = {
  id: string;
  previousHash: string;
  currentHash: string;
  payloadHash: string;
  timestamp: number;
};

export type PersistableTransition = {
  id: string;
  transactionId: string;
  unitId: string;
  fromHash: string;
  toHash: string;
  operation: string;
  logicalTime: number;
  unitStateAfter?: SystemState;
};

export type PersistableTransactionContext = {
  transactionId: string;
  transaction: {
    id: string;
    planId: string;
    status: "pending" | "prepared" | "validated" | "committed" | "aborted";
  };
  baseState: GlobalState;
  workingState: GlobalState;
  transitions: PersistableTransition[];
};

const STATE_VERSION = "3.0.0";
const SNAPSHOT_INTERVAL = 10;
const GENESIS_HASH = "GENESIS";

function choirDir(root: string): string {
  return path.join(root, ".choir");
}

function statePath(root: string): string {
  return path.join(choirDir(root), "state.json");
}

function transitionsPath(root: string): string {
  return path.join(choirDir(root), "state.transitions.jsonl");
}

function snapshotsPath(root: string): string {
  return path.join(choirDir(root), "state.snapshots.jsonl");
}

function auditPath(root: string): string {
  return path.join(choirDir(root), "state.audit.jsonl");
}

function cloneUnknown<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function atomicWriteJson(filePath: string, payload: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${deterministicId("tmp", payload, 12)}`;
  fs.writeFileSync(tempPath, payload, "utf-8");
  fs.renameSync(tempPath, filePath);
}

function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${stableStringify(value)}\n`, "utf-8");
}

function readJsonLines(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (raw.length === 0) {
    return [];
  }

  return raw
    .split(/\r?\n/)
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`Malformed JSONL at ${filePath}:${index + 1}`);
      }
    });
}

function ensureStorage(root: string): void {
  fs.mkdirSync(choirDir(root), { recursive: true });

  if (!fs.existsSync(transitionsPath(root))) {
    fs.writeFileSync(transitionsPath(root), "", "utf-8");
  }

  if (!fs.existsSync(snapshotsPath(root))) {
    fs.writeFileSync(snapshotsPath(root), "", "utf-8");
  }

  if (!fs.existsSync(auditPath(root))) {
    fs.writeFileSync(auditPath(root), "", "utf-8");
  }

  if (!fs.existsSync(statePath(root))) {
    const initial: PersistedState = {
      version: STATE_VERSION,
      currentHash: deterministicHash({}),
      logicalTime: 0,
    };
    atomicWriteJson(statePath(root), `${JSON.stringify(initial, null, 2)}\n`);
    return;
  }

  const existingRaw = fs.readFileSync(statePath(root), "utf-8");
  const existing = JSON.parse(existingRaw) as Record<string, unknown>;
  const currentHash = typeof existing.currentHash === "string" && existing.currentHash.trim().length > 0
    ? existing.currentHash
    : typeof existing.stateHash === "string" && existing.stateHash.trim().length > 0
      ? existing.stateHash
      : deterministicHash({});
  const logicalTime = typeof existing.logicalTime === "number" && Number.isFinite(existing.logicalTime) && existing.logicalTime >= 0
    ? Math.floor(existing.logicalTime)
    : 0;
  const version = typeof existing.version === "string" && existing.version.trim().length > 0
    ? existing.version
    : STATE_VERSION;

  if (
    typeof existing.currentHash !== "string"
    || typeof existing.logicalTime !== "number"
  ) {
    atomicWriteJson(statePath(root), `${JSON.stringify({
      ...existing,
      version,
      currentHash,
      logicalTime,
    }, null, 2)}\n`);
  }
}

function parsePersistedState(value: unknown): PersistedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid persisted state payload");
  }

  const record = value as Record<string, unknown>;
  const version = typeof record.version === "string" && record.version.trim().length > 0
    ? record.version
    : STATE_VERSION;
  const currentHash = typeof record.currentHash === "string" && record.currentHash.trim().length > 0
    ? record.currentHash
    : deterministicHash({});
  const logicalTime = typeof record.logicalTime === "number" && Number.isFinite(record.logicalTime) && record.logicalTime >= 0
    ? Math.floor(record.logicalTime)
    : 0;

  return {
    version,
    currentHash,
    logicalTime,
  };
}

function parseTransitionRecord(value: unknown): TransitionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const transactionId = typeof record.transactionId === "string" ? record.transactionId : "";
  const fromHash = typeof record.fromHash === "string" ? record.fromHash : "";
  const toHash = typeof record.toHash === "string" ? record.toHash : "";
  const operation = typeof record.operation === "string" ? record.operation : "set";
  const unitId = typeof record.unitId === "string" ? record.unitId : "";

  if (!id || !transactionId || !fromHash || !toHash || !unitId) {
    return null;
  }

  const logicalTime = typeof record.logicalTime === "number" && Number.isFinite(record.logicalTime) && record.logicalTime > 0
    ? Math.floor(record.logicalTime)
    : 0;
  const timestamp = typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
    ? Math.floor(record.timestamp)
    : logicalTime;

  return {
    id,
    transactionId,
    logicalTime,
    fromHash,
    toHash,
    operation,
    timestamp,
    unitId,
    unitStateAfter: (record.unitStateAfter && typeof record.unitStateAfter === "object" && !Array.isArray(record.unitStateAfter)
      ? cloneUnknown(record.unitStateAfter)
      : {}) as SystemState,
  };
}

function parseSnapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const stateHash = typeof record.stateHash === "string" ? record.stateHash : "";
  const logicalTime = typeof record.logicalTime === "number" && Number.isFinite(record.logicalTime)
    ? Math.floor(record.logicalTime)
    : 0;

  if (!id || !stateHash || logicalTime < 0) {
    return null;
  }

  const state = (record.state && typeof record.state === "object" && !Array.isArray(record.state)
    ? cloneUnknown(record.state)
    : {}) as GlobalState;

  return {
    id,
    stateHash,
    state,
    logicalTime,
  };
}

function parseAuditRecord(value: unknown): AuditRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const previousHash = typeof record.previousHash === "string" ? record.previousHash : "";
  const currentHash = typeof record.currentHash === "string" ? record.currentHash : "";
  const payloadHash = typeof record.payloadHash === "string" ? record.payloadHash : "";
  const timestamp = typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
    ? Math.floor(record.timestamp)
    : 0;

  if (!id || !previousHash || !currentHash || !payloadHash || timestamp < 0) {
    return null;
  }

  return {
    id,
    previousHash,
    currentHash,
    payloadHash,
    timestamp,
  };
}

export function loadPersistedState(root: string): PersistedState {
  ensureStorage(root);
  const raw = fs.readFileSync(statePath(root), "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  return parsePersistedState(parsed);
}

export function loadTransitionRecords(root: string): TransitionRecord[] {
  ensureStorage(root);
  return stableSortBy(
    readJsonLines(transitionsPath(root))
      .map((entry) => parseTransitionRecord(entry))
      .filter((entry): entry is TransitionRecord => entry !== null),
    (entry) => `${entry.logicalTime.toString().padStart(12, "0")}:${entry.id}`
  );
}

export function loadSnapshots(root: string): Snapshot[] {
  ensureStorage(root);
  return stableSortBy(
    readJsonLines(snapshotsPath(root))
      .map((entry) => parseSnapshot(entry))
      .filter((entry): entry is Snapshot => entry !== null),
    (entry) => `${entry.logicalTime.toString().padStart(12, "0")}:${entry.id}`
  );
}

export function loadAuditRecords(root: string): AuditRecord[] {
  ensureStorage(root);
  return readJsonLines(auditPath(root))
    .map((entry) => parseAuditRecord(entry))
    .filter((entry): entry is AuditRecord => entry !== null);
}

function validateTransitionOrder(transitions: TransitionRecord[]): void {
  const seenIds = new Set<string>();
  let expectedTime = 1;

  for (const transition of transitions) {
    if (seenIds.has(transition.id)) {
      throw new Error(`Duplicate transition id detected: ${transition.id}`);
    }

    seenIds.add(transition.id);
    if (transition.logicalTime !== expectedTime) {
      throw new Error(`Missing transition sequence: expected logicalTime ${expectedTime}, received ${transition.logicalTime}`);
    }

    expectedTime += 1;
  }
}

function createAuditRecord(previousHash: string, payload: unknown, timestamp: number, index: number): AuditRecord {
  const payloadHash = deterministicHash(payload);
  const id = deterministicId("audit", {
    previousHash,
    payloadHash,
    timestamp,
    index,
  }, 16);
  const currentHash = deterministicHash({
    id,
    previousHash,
    payloadHash,
    timestamp,
  });

  return {
    id,
    previousHash,
    currentHash,
    payloadHash,
    timestamp,
  };
}

function appendAudit(root: string, payload: unknown, timestamp: number): AuditRecord {
  const existing = loadAuditRecords(root);
  const previousHash = existing.length > 0 ? (existing[existing.length - 1] as AuditRecord).currentHash : GENESIS_HASH;
  const audit = createAuditRecord(previousHash, payload, timestamp, existing.length + 1);
  appendJsonLine(auditPath(root), audit);
  return audit;
}

function appendSnapshot(root: string, state: GlobalState, logicalTime: number): Snapshot {
  const snapshot: Snapshot = {
    id: deterministicId("snapshot", {
      logicalTime,
      stateHash: deterministicHash(state),
    }, 16),
    stateHash: deterministicHash(state),
    state: cloneUnknown(state),
    logicalTime,
  };

  appendJsonLine(snapshotsPath(root), snapshot);
  appendAudit(root, {
    type: "snapshot",
    snapshot,
  }, logicalTime);
  return snapshot;
}

function applyTransition(state: GlobalState, transition: TransitionRecord): GlobalState {
  const next = cloneUnknown(state);
  const beforeUnitHash = deterministicHash({ [transition.unitId]: next[transition.unitId] ?? {} });
  if (beforeUnitHash !== transition.fromHash) {
    throw new Error(`Transition ${transition.id} fromHash mismatch`);
  }

  next[transition.unitId] = cloneUnknown(transition.unitStateAfter);
  const afterUnitHash = deterministicHash({ [transition.unitId]: next[transition.unitId] ?? {} });
  if (afterUnitHash !== transition.toHash) {
    throw new Error(`Transition ${transition.id} toHash mismatch`);
  }

  return next;
}

function selectBaseSnapshot(snapshots: Snapshot[], logicalTime: number): Snapshot | null {
  const candidates = snapshots.filter((entry) => entry.logicalTime <= logicalTime);
  return candidates.length > 0 ? (candidates[candidates.length - 1] as Snapshot) : null;
}

export function replayTo(root: string, logicalTime: number): GlobalState {
  const transitions = loadTransitionRecords(root);
  const snapshots = loadSnapshots(root);
  validateTransitionOrder(transitions);

  const clamped = Math.max(0, Math.floor(logicalTime));
  const baseSnapshot = selectBaseSnapshot(snapshots, clamped);
  let state = cloneUnknown(baseSnapshot?.state ?? {});
  const startTime = baseSnapshot?.logicalTime ?? 0;

  for (const transition of transitions) {
    if (transition.logicalTime <= startTime || transition.logicalTime > clamped) {
      continue;
    }

    state = applyTransition(state, transition);
  }

  return state;
}

export function replayFromLogs(root: string): GlobalState {
  const persisted = loadPersistedState(root);
  const state = replayTo(root, persisted.logicalTime);
  const hash = deterministicHash(state);

  if (hash !== persisted.currentHash) {
    throw new Error(`Replay mismatch: expected ${persisted.currentHash} but reconstructed ${hash}`);
  }

  return state;
}

export function rollbackTo(root: string, snapshotId: string): GlobalState {
  const snapshots = loadSnapshots(root);
  const snapshot = snapshots.find((entry) => entry.id === snapshotId);
  if (!snapshot) {
    throw new Error(`Snapshot not found: ${snapshotId}`);
  }

  return replayTo(root, snapshot.logicalTime);
}

export function recoverState(root: string): GlobalState {
  return replayFromLogs(root);
}

export function validateAuditChain(records: AuditRecord[]): void {
  let previousHash = GENESIS_HASH;

  for (const record of records) {
    if (record.previousHash !== previousHash) {
      throw new Error(`Audit chain broken at ${record.id}: previousHash mismatch`);
    }

    const expectedHash = deterministicHash({
      id: record.id,
      previousHash: record.previousHash,
      payloadHash: record.payloadHash,
      timestamp: record.timestamp,
    });

    if (expectedHash !== record.currentHash) {
      throw new Error(`Audit chain tamper detected at ${record.id}: currentHash mismatch`);
    }

    previousHash = record.currentHash;
  }
}

export function verifyReplayConsistency(root: string): boolean {
  const records = loadAuditRecords(root);
  validateAuditChain(records);
  replayFromLogs(root);
  return true;
}

export function recordCommittedTransaction(root: string, ctx: PersistableTransactionContext): PersistedState {
  if (ctx.transaction.status !== "validated") {
    throw new Error(`Cannot persist transaction ${ctx.transactionId}: status ${ctx.transaction.status}`);
  }

  ensureStorage(root);

  const existingTransitions = loadTransitionRecords(root);
  validateTransitionOrder(existingTransitions);
  const persisted = loadPersistedState(root);
  const existingSnapshots = loadSnapshots(root);

  if (existingTransitions.length === 0 && existingSnapshots.length === 0) {
    appendSnapshot(root, ctx.baseState, 0);

    const statePayload = fs.existsSync(statePath(root))
      ? JSON.parse(fs.readFileSync(statePath(root), "utf-8")) as Record<string, unknown>
      : {};
    const bootstrapped = {
      ...statePayload,
      version: typeof statePayload.version === "string" && statePayload.version.trim().length > 0
        ? statePayload.version
        : STATE_VERSION,
      currentHash: deterministicHash(ctx.baseState),
      logicalTime: 0,
    };
    atomicWriteJson(statePath(root), `${JSON.stringify(bootstrapped, null, 2)}\n`);
  }

  const lastLogicalTime = Math.max(
    persisted.logicalTime,
    existingTransitions.length > 0 ? (existingTransitions[existingTransitions.length - 1] as TransitionRecord).logicalTime : 0
  );

  let nextLogicalTime = lastLogicalTime;

  const orderedContextTransitions = stableSortBy(ctx.transitions, (transition) =>
    `${transition.logicalTime.toString().padStart(16, "0")}:${transition.id}`
  );

  let replayState = replayTo(root, lastLogicalTime);
  for (const transition of orderedContextTransitions) {
    nextLogicalTime += 1;
    const record: TransitionRecord = {
      id: deterministicId("transition", {
        transactionId: ctx.transactionId,
        sourceId: transition.id,
        logicalTime: nextLogicalTime,
      }, 16),
      transactionId: ctx.transactionId,
      logicalTime: nextLogicalTime,
      fromHash: transition.fromHash,
      toHash: transition.toHash,
      operation: transition.operation,
      timestamp: nextLogicalTime,
      unitId: transition.unitId,
      unitStateAfter: cloneUnknown(transition.unitStateAfter ?? ctx.workingState[transition.unitId] ?? {}),
    };

    replayState = applyTransition(replayState, record);
    appendJsonLine(transitionsPath(root), record);
    appendAudit(root, {
      type: "transition",
      transition: record,
    }, record.timestamp);
  }

  const replayedHash = deterministicHash(replayState);
  const targetHash = deterministicHash(ctx.workingState);
  if (replayedHash !== targetHash) {
    throw new Error(`Persisted transition replay mismatch: expected ${targetHash}, got ${replayedHash}`);
  }

  if (orderedContextTransitions.length > 0 || nextLogicalTime % SNAPSHOT_INTERVAL === 0) {
    appendSnapshot(root, replayState, nextLogicalTime);
  }

  const statePayload = fs.existsSync(statePath(root))
    ? JSON.parse(fs.readFileSync(statePath(root), "utf-8")) as Record<string, unknown>
    : {};
  const nextPersisted: PersistedState = {
    version: typeof statePayload.version === "string" && statePayload.version.trim().length > 0
      ? statePayload.version
      : STATE_VERSION,
    currentHash: replayedHash,
    logicalTime: nextLogicalTime,
  };

  const nextStateJson = {
    ...statePayload,
    version: nextPersisted.version,
    currentHash: nextPersisted.currentHash,
    logicalTime: nextPersisted.logicalTime,
  };
  atomicWriteJson(statePath(root), `${JSON.stringify(nextStateJson, null, 2)}\n`);
  appendAudit(root, {
    type: "state",
    state: nextPersisted,
  }, nextLogicalTime + 1);

  verifyReplayConsistency(root);
  return nextPersisted;
}
