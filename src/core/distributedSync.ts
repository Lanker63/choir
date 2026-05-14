import { createHash } from "crypto";
import { gunzipSync, gzipSync } from "zlib";
import { isRecord } from "../utils/guards.js";
import { cloneJsonOrUndefined } from "../utils/clone.js";

export type SystemState = Record<string, unknown>;

export type LogicalClock = {
  counter: number;
  nodeId: string;
};

export type VersionVector = Record<string, number>;

export type StateOperation = {
  type: "add" | "update" | "remove";
  path: string;
  value: unknown;
  clock?: LogicalClock;
};

export type ChangeSet = {
  id: string;
  origin: string;
  timestamp: LogicalClock;
  operations: StateOperation[];
};

export type SignedChangeSet = ChangeSet & {
  signer: string;
  signature: string;
};

export type ConflictResolution = "local" | "remote" | "manual";

export type SyncConflict = {
  path: string;
  localValue: unknown;
  remoteValue: unknown;
  localClock: LogicalClock;
  remoteClock: LogicalClock;
  resolution: ConflictResolution;
  reason: string;
  requiresManualResolution: boolean;
};

export type SyncAudit = {
  source: string;
  target: string;
  changesApplied: ChangeSet[];
  conflicts: SyncConflict[];
  trace: SyncTrace;
  timestamp: LogicalClock;
};

export type SyncTrace = {
  replicasInvolved: string[];
  changesMerged: number;
  conflictsDetected: number;
  convergenceAchieved: boolean;
};

export type Replica<TState extends SystemState = SystemState> = {
  id: string;
  state: TState;
  version: number;
  clock: LogicalClock;
  versionVector: VersionVector;
  pathClocks: Record<string, LogicalClock>;
  tombstones: Record<string, LogicalClock>;
  pendingConflicts: SyncConflict[];
  syncAudit: SyncAudit[];
};

export type ConflictStrategy = "lww" | "manual";

export type MergeHandlerContext = {
  path: string;
  localClock: LogicalClock;
  remoteClock: LogicalClock;
};

export const MANUAL_RESOLUTION = Symbol("manual-resolution");

export type MergeHandlerResult = unknown | typeof MANUAL_RESOLUTION;

export type MergeHandlers = Record<string, (localValue: unknown, remoteValue: unknown, context: MergeHandlerContext) => MergeHandlerResult>;

export type SyncMode = "push" | "pull" | "bidirectional";

export interface Transport {
  send(changeSet: ChangeSet): void;
  receive(): ChangeSet[];
}

export type StateChangeEvent<TState extends SystemState = SystemState> = {
  replicaId: string;
  changeSet: ChangeSet;
  state: TState;
  clock: LogicalClock;
};

export type StateChangeListener<TState extends SystemState = SystemState> = (event: StateChangeEvent<TState>) => void;

class SyncEventBus<TState extends SystemState = SystemState> {
  private listeners = new Set<StateChangeListener<TState>>();

  subscribe(listener: StateChangeListener<TState>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: StateChangeEvent<TState>): void {
    for (const listener of this.listeners) {
      listener(cloneUnknown(event));
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

export class InMemoryTransport implements Transport {
  private queue: ChangeSet[] = [];

  send(changeSet: ChangeSet): void {
    this.queue.push(cloneUnknown(changeSet));
  }

  receive(): ChangeSet[] {
    const items = this.queue.map((entry) => cloneUnknown(entry));
    this.queue = [];
    return items;
  }
}

export type SyncSecurity = {
  trustedNodeIds: string[];
  secret: string;
  requireSignature?: boolean;
};

export type ApplyDeltaOptions<TState extends SystemState = SystemState> = {
  conflictStrategy?: ConflictStrategy;
  mergeHandlers?: MergeHandlers;
  validators?: Array<(state: TState) => boolean>;
  security?: SyncSecurity;
  signedChangeSet?: SignedChangeSet;
};

export type ApplyDeltaResult<TState extends SystemState = SystemState> = {
  replica: Replica<TState>;
  conflicts: SyncConflict[];
  trace: SyncTrace;
  appliedOperations: number;
  manualResolutionRequired: boolean;
};

export type MergeResult<TState extends SystemState = SystemState> = {
  state: TState;
  pathClocks: Record<string, LogicalClock>;
  tombstones: Record<string, LogicalClock>;
  conflicts: SyncConflict[];
};

export type SyncResult<TState extends SystemState = SystemState> = {
  local: Replica<TState>;
  remote: Replica<TState>;
  localAudit: SyncAudit;
  remoteAudit: SyncAudit;
  trace: SyncTrace;
  deltas: ChangeSet[];
};

type PathSnapshot = {
  exists: boolean;
  value: unknown;
  clock: LogicalClock;
};

type SortedOperation = StateOperation & {
  path: string;
};

const ZERO_CLOCK: LogicalClock = {
  counter: 0,
  nodeId: "GENESIS",
};

function normalizePath(pathValue: string): string {
  return pathValue
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join(".");
}

function splitPath(pathValue: string): string[] {
  return normalizePath(pathValue)
    .split(".")
    .filter((segment) => segment.length > 0);
}

function stableSortUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSortUnknown(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stableSortUnknown(value[key])])
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableSortUnknown(value));
}

function cloneUnknown<T>(value: T): T {
  return cloneJsonOrUndefined(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function toClock(clock: LogicalClock | undefined, fallbackNodeId: string): LogicalClock {
  if (!clock) {
    return {
      counter: 0,
      nodeId: fallbackNodeId,
    };
  }

  return {
    counter: Number.isFinite(clock.counter) ? Math.max(0, Math.floor(clock.counter)) : 0,
    nodeId: typeof clock.nodeId === "string" && clock.nodeId.trim().length > 0 ? clock.nodeId : fallbackNodeId,
  };
}

function maxClock(a: LogicalClock, b: LogicalClock): LogicalClock {
  return compareClock(a, b) >= 0 ? cloneUnknown(a) : cloneUnknown(b);
}

function sortOperations(operations: StateOperation[]): SortedOperation[] {
  const opRank: Record<StateOperation["type"], number> = {
    add: 0,
    update: 1,
    remove: 2,
  };

  return operations
    .map((operation) => ({
      ...operation,
      path: normalizePath(operation.path),
    }))
    .filter((operation) => operation.path.length > 0)
    .sort((left, right) => {
      const pathCmp = left.path.localeCompare(right.path);
      if (pathCmp !== 0) {
        return pathCmp;
      }

      const rankCmp = opRank[left.type] - opRank[right.type];
      if (rankCmp !== 0) {
        return rankCmp;
      }

      return stableStringify(left.value).localeCompare(stableStringify(right.value));
    });
}

function listLeafPaths(value: unknown, currentPath = ""): string[] {
  if (Array.isArray(value) || !isRecord(value)) {
    return currentPath.length > 0 ? [currentPath] : [];
  }

  const keys = Object.keys(value).sort((left, right) => left.localeCompare(right));
  if (keys.length === 0) {
    return currentPath.length > 0 ? [currentPath] : [];
  }

  return keys.flatMap((key) => {
    const nextPath = currentPath.length > 0 ? `${currentPath}.${key}` : key;
    return listLeafPaths(value[key], nextPath);
  });
}

function getAtPath(state: SystemState, pathValue: string): { exists: boolean; value: unknown } {
  const segments = splitPath(pathValue);
  if (segments.length === 0) {
    return { exists: false, value: undefined };
  }

  let current: unknown = state;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { exists: false, value: undefined };
    }

    current = current[segment];
  }

  return {
    exists: true,
    value: cloneUnknown(current),
  };
}

function setAtPath(state: SystemState, pathValue: string, value: unknown): SystemState {
  const normalizedPath = normalizePath(pathValue);
  if (normalizedPath.length === 0) {
    return state;
  }

  const segments = splitPath(normalizedPath);
  const next = cloneUnknown(state) as SystemState;

  let cursor: Record<string, unknown> = next;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const raw = cursor[segment];
    if (!isRecord(raw)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1]] = cloneUnknown(value);
  return next;
}

function deleteAtPath(state: SystemState, pathValue: string): SystemState {
  const normalizedPath = normalizePath(pathValue);
  if (normalizedPath.length === 0) {
    return state;
  }

  const segments = splitPath(normalizedPath);
  const next = cloneUnknown(state) as SystemState;

  let cursor: Record<string, unknown> = next;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const raw = cursor[segment];
    if (!isRecord(raw)) {
      return next;
    }

    cursor = raw;
  }

  delete cursor[segments[segments.length - 1]];
  return next;
}

function diffStates(before: unknown, after: unknown, currentPath = ""): StateOperation[] {
  if (valuesEqual(before, after)) {
    return [];
  }

  if (Array.isArray(before) || Array.isArray(after) || !isRecord(before) || !isRecord(after)) {
    const pathValue = normalizePath(currentPath);
    if (pathValue.length === 0) {
      return [];
    }

    if (typeof after === "undefined") {
      return [{
        type: "remove",
        path: pathValue,
        value: null,
      }];
    }

    return [{
      type: typeof before === "undefined" ? "add" : "update",
      path: pathValue,
      value: cloneUnknown(after),
    }];
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const sortedKeys = [...keys].sort((left, right) => left.localeCompare(right));

  return sortedKeys.flatMap((key) => {
    const nextPath = currentPath.length > 0 ? `${currentPath}.${key}` : key;
    const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(after, key);

    if (!hasAfter) {
      return [{
        type: "remove" as const,
        path: normalizePath(nextPath),
        value: null,
      }];
    }

    if (!hasBefore) {
      return [{
        type: "add" as const,
        path: normalizePath(nextPath),
        value: cloneUnknown(after[key]),
      }];
    }

    return diffStates(before[key], after[key], nextPath);
  });
}

function buildChangeSetId(origin: string, timestamp: LogicalClock, operations: StateOperation[]): string {
  const payload = stableStringify({
    origin,
    timestamp,
    operations: sortOperations(operations),
  });

  return `changeset-${createHash("sha256").update(payload).digest("hex").slice(0, 16)}`;
}

function defaultReplicaIdFromState(state: SystemState): string {
  const digest = createHash("sha256").update(stableStringify(state)).digest("hex").slice(0, 12);
  return `replica-${digest}`;
}

function pathSnapshot<TState extends SystemState>(
  replica: Replica<TState>,
  pathValue: string,
  fallbackClock: LogicalClock
): PathSnapshot {
  const normalized = normalizePath(pathValue);
  const current = getAtPath(replica.state, normalized);
  const valueClock = replica.pathClocks[normalized];
  const tombstoneClock = replica.tombstones[normalized];

  if (current.exists) {
    return {
      exists: true,
      value: current.value,
      clock: toClock(valueClock ?? tombstoneClock ?? fallbackClock, fallbackClock.nodeId),
    };
  }

  return {
    exists: false,
    value: undefined,
    clock: toClock(tombstoneClock ?? valueClock ?? fallbackClock, fallbackClock.nodeId),
  };
}

function resolveSameClockTie(
  localSnapshot: PathSnapshot,
  remoteSnapshot: PathSnapshot,
  localId: string,
  remoteId: string
): "local" | "remote" {
  if (localId !== remoteId) {
    return localId.localeCompare(remoteId) >= 0 ? "local" : "remote";
  }

  const localPayload = stableStringify(localSnapshot.exists ? localSnapshot.value : "__deleted__");
  const remotePayload = stableStringify(remoteSnapshot.exists ? remoteSnapshot.value : "__deleted__");
  return localPayload.localeCompare(remotePayload) >= 0 ? "local" : "remote";
}

function makeConflict(
  pathValue: string,
  localSnapshot: PathSnapshot,
  remoteSnapshot: PathSnapshot,
  resolution: ConflictResolution,
  reason: string
): SyncConflict {
  return {
    path: normalizePath(pathValue),
    localValue: cloneUnknown(localSnapshot.value),
    remoteValue: cloneUnknown(remoteSnapshot.value),
    localClock: cloneUnknown(localSnapshot.clock),
    remoteClock: cloneUnknown(remoteSnapshot.clock),
    resolution,
    reason,
    requiresManualResolution: resolution === "manual",
  };
}

function validateSecurity(changeSet: ChangeSet, signedChangeSet: SignedChangeSet | undefined, security: SyncSecurity | undefined): string | null {
  if (!security) {
    return null;
  }

  const trusted = new Set(security.trustedNodeIds.map((entry) => entry.trim()).filter((entry) => entry.length > 0));
  if (!trusted.has(changeSet.origin)) {
    return `Untrusted source identity: ${changeSet.origin}`;
  }

  const requireSignature = security.requireSignature !== false;
  if (!requireSignature) {
    return null;
  }

  if (!signedChangeSet) {
    return "Missing signed changeset payload";
  }

  if (signedChangeSet.signer !== changeSet.origin) {
    return "Signer mismatch";
  }

  if (!verifySignedChangeSet(signedChangeSet, security.secret, security.trustedNodeIds)) {
    return "Signature verification failed";
  }

  return null;
}

export function incrementClock(clock: LogicalClock): LogicalClock {
  const normalized = toClock(clock, clock.nodeId);
  return {
    counter: normalized.counter + 1,
    nodeId: normalized.nodeId,
  };
}

export function mergeClock(localClock: LogicalClock, remoteClock: LogicalClock, nodeId: string): LogicalClock {
  const local = toClock(localClock, nodeId);
  const remote = toClock(remoteClock, nodeId);

  return {
    counter: Math.max(local.counter, remote.counter) + 1,
    nodeId,
  };
}

export function compareClock(left: LogicalClock, right: LogicalClock): number {
  const normalizedLeft = toClock(left, left.nodeId);
  const normalizedRight = toClock(right, right.nodeId);

  if (normalizedLeft.counter !== normalizedRight.counter) {
    return normalizedLeft.counter - normalizedRight.counter;
  }

  return normalizedLeft.nodeId.localeCompare(normalizedRight.nodeId);
}

export function createReplica<TState extends SystemState>(
  id: string,
  state: TState,
  options?: {
    version?: number;
    clock?: LogicalClock;
    versionVector?: VersionVector;
    pathClocks?: Record<string, LogicalClock>;
    tombstones?: Record<string, LogicalClock>;
    pendingConflicts?: SyncConflict[];
    syncAudit?: SyncAudit[];
  }
): Replica<TState> {
  const sanitizedId = id.trim().length > 0 ? id.trim() : defaultReplicaIdFromState(state);
  const version = Number.isFinite(options?.version) ? Math.max(0, Math.floor(options?.version ?? 0)) : 0;
  const baseClock = toClock(options?.clock ?? { counter: version, nodeId: sanitizedId }, sanitizedId);

  const derivedPathClocks = Object.fromEntries(
    listLeafPaths(state)
      .sort((left, right) => left.localeCompare(right))
      .map((pathValue) => [pathValue, cloneUnknown(baseClock)])
  ) as Record<string, LogicalClock>;

  const versionVector = {
    [sanitizedId]: version,
    ...(options?.versionVector ?? {}),
  };

  return {
    id: sanitizedId,
    state: cloneUnknown(state),
    version,
    clock: baseClock,
    versionVector,
    pathClocks: {
      ...derivedPathClocks,
      ...(options?.pathClocks ?? {}),
    },
    tombstones: {
      ...(options?.tombstones ?? {}),
    },
    pendingConflicts: [...(options?.pendingConflicts ?? [])],
    syncAudit: [...(options?.syncAudit ?? [])],
  };
}

export function computeDelta(
  oldState: SystemState,
  newState: SystemState,
  options?: {
    origin?: string;
    timestamp?: LogicalClock;
  }
): ChangeSet {
  const origin = options?.origin?.trim().length ? options.origin.trim() : "unknown";
  const timestamp = toClock(options?.timestamp ?? { counter: 0, nodeId: origin }, origin);
  const operations = sortOperations(diffStates(oldState, newState));

  return {
    id: buildChangeSetId(origin, timestamp, operations),
    origin,
    timestamp,
    operations,
  };
}

export function applyDelta<TState extends SystemState>(
  replica: Replica<TState>,
  changeSet: ChangeSet,
  options?: ApplyDeltaOptions<TState>
): ApplyDeltaResult<TState> {
  const normalizedOps = sortOperations(changeSet.operations);
  const securityError = validateSecurity(changeSet, options?.signedChangeSet, options?.security);

  if (securityError) {
    const conflict = makeConflict(
      "__security__",
      {
        exists: true,
        value: securityError,
        clock: cloneUnknown(replica.clock),
      },
      {
        exists: true,
        value: changeSet,
        clock: toClock(changeSet.timestamp, changeSet.origin),
      },
      "manual",
      "security-validation-failed"
    );

    const nextReplica = createReplica(replica.id, replica.state, {
      version: replica.version,
      clock: replica.clock,
      versionVector: replica.versionVector,
      pathClocks: replica.pathClocks,
      tombstones: replica.tombstones,
      pendingConflicts: [...replica.pendingConflicts, conflict],
      syncAudit: replica.syncAudit,
    });

    return {
      replica: nextReplica,
      conflicts: [conflict],
      trace: {
        replicasInvolved: [replica.id, changeSet.origin],
        changesMerged: 0,
        conflictsDetected: 1,
        convergenceAchieved: false,
      },
      appliedOperations: 0,
      manualResolutionRequired: true,
    };
  }

  const nextReplica = createReplica(replica.id, replica.state, {
    version: replica.version,
    clock: replica.clock,
    versionVector: replica.versionVector,
    pathClocks: replica.pathClocks,
    tombstones: replica.tombstones,
    pendingConflicts: replica.pendingConflicts,
    syncAudit: replica.syncAudit,
  });

  const conflicts: SyncConflict[] = [];
  let appliedOperations = 0;
  let nextState = cloneUnknown(nextReplica.state) as SystemState;
  const strategy = options?.conflictStrategy ?? "lww";
  const localClockFallback = toClock(nextReplica.clock, nextReplica.id);

  for (const operation of normalizedOps) {
    const pathValue = normalizePath(operation.path);
    if (pathValue.length === 0) {
      continue;
    }

    const incomingClock = toClock(operation.clock ?? changeSet.timestamp, changeSet.origin);
    const localSnapshot = pathSnapshot(nextReplica, pathValue, localClockFallback);

    const remoteSnapshot: PathSnapshot = {
      exists: operation.type !== "remove",
      value: operation.type === "remove" ? undefined : cloneUnknown(operation.value),
      clock: incomingClock,
    };

    const valuesDiffer = !valuesEqual(localSnapshot.value, remoteSnapshot.value)
      || localSnapshot.exists !== remoteSnapshot.exists;
    const isConflict = valuesDiffer && localSnapshot.exists;

    let resolution: ConflictResolution = "remote";
    const clockCmp = compareClock(remoteSnapshot.clock, localSnapshot.clock);

    if (clockCmp < 0) {
      resolution = "local";
    } else if (clockCmp === 0) {
      resolution = resolveSameClockTie(localSnapshot, remoteSnapshot, nextReplica.id, changeSet.origin);
      if (strategy === "manual" && valuesDiffer) {
        resolution = "manual";
      }
    } else if (strategy === "manual" && valuesDiffer) {
      resolution = "manual";
    }

    const mergeHandler = options?.mergeHandlers?.[pathValue];
    if (mergeHandler && valuesDiffer) {
      const handlerResult = mergeHandler(
        cloneUnknown(localSnapshot.value),
        cloneUnknown(remoteSnapshot.value),
        {
          path: pathValue,
          localClock: cloneUnknown(localSnapshot.clock),
          remoteClock: cloneUnknown(remoteSnapshot.clock),
        }
      );

      if (handlerResult === MANUAL_RESOLUTION) {
        resolution = "manual";
      } else {
        resolution = "remote";
        nextState = setAtPath(nextState, pathValue, handlerResult);
      }
    }

    if (isConflict || resolution === "manual") {
      conflicts.push(makeConflict(
        pathValue,
        localSnapshot,
        remoteSnapshot,
        resolution,
        clockCmp === 0 ? "same-path-different-values" : "clock-precedence"
      ));
    }

    if (resolution === "local" || resolution === "manual") {
      continue;
    }

    if (operation.type === "remove") {
      nextState = deleteAtPath(nextState, pathValue);
      delete nextReplica.pathClocks[pathValue];
      nextReplica.tombstones[pathValue] = cloneUnknown(incomingClock);
    } else {
      nextState = setAtPath(nextState, pathValue, operation.value);
      nextReplica.pathClocks[pathValue] = cloneUnknown(incomingClock);
      delete nextReplica.tombstones[pathValue];
    }

    appliedOperations += 1;
  }

  nextReplica.state = nextState as TState;
  nextReplica.clock = mergeClock(nextReplica.clock, changeSet.timestamp, nextReplica.id);
  nextReplica.version = Math.max(nextReplica.version, nextReplica.clock.counter);
  nextReplica.versionVector[changeSet.origin] = Math.max(
    nextReplica.versionVector[changeSet.origin] ?? 0,
    changeSet.timestamp.counter
  );
  nextReplica.versionVector[nextReplica.id] = Math.max(
    nextReplica.versionVector[nextReplica.id] ?? 0,
    nextReplica.version
  );

  const validatorFailed = (options?.validators ?? []).some((validator) => !validator(nextReplica.state));
  if (validatorFailed) {
    const conflict = makeConflict(
      "__validation__",
      {
        exists: true,
        value: replica.state,
        clock: replica.clock,
      },
      {
        exists: true,
        value: nextReplica.state,
        clock: nextReplica.clock,
      },
      "manual",
      "post-sync-validation-failed"
    );

    const rollbackReplica = createReplica(replica.id, replica.state, {
      version: replica.version,
      clock: replica.clock,
      versionVector: replica.versionVector,
      pathClocks: replica.pathClocks,
      tombstones: replica.tombstones,
      pendingConflicts: [...replica.pendingConflicts, ...conflicts, conflict],
      syncAudit: replica.syncAudit,
    });

    return {
      replica: rollbackReplica,
      conflicts: [...conflicts, conflict],
      trace: {
        replicasInvolved: [replica.id, changeSet.origin],
        changesMerged: appliedOperations,
        conflictsDetected: conflicts.length + 1,
        convergenceAchieved: false,
      },
      appliedOperations,
      manualResolutionRequired: true,
    };
  }

  nextReplica.pendingConflicts = [...nextReplica.pendingConflicts, ...conflicts];

  return {
    replica: nextReplica,
    conflicts,
    trace: {
      replicasInvolved: [replica.id, changeSet.origin],
      changesMerged: appliedOperations,
      conflictsDetected: conflicts.length,
      convergenceAchieved: conflicts.length === 0,
    },
    appliedOperations,
    manualResolutionRequired: conflicts.some((conflict) => conflict.requiresManualResolution),
  };
}

export function mergeVersionVectors(left: VersionVector, right: VersionVector): VersionVector {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const merged = [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => [key, Math.max(left[key] ?? 0, right[key] ?? 0)] as const);
  return Object.fromEntries(merged);
}

export function mergeReplicaStates<TState extends SystemState>(
  local: Replica<TState>,
  remote: Replica<TState>,
  options?: {
    conflictStrategy?: ConflictStrategy;
    mergeHandlers?: MergeHandlers;
  }
): MergeResult<TState> {
  const allPaths = new Set<string>([
    ...listLeafPaths(local.state),
    ...listLeafPaths(remote.state),
    ...Object.keys(local.tombstones),
    ...Object.keys(remote.tombstones),
  ]);

  const sortedPaths = [...allPaths]
    .map((entry) => normalizePath(entry))
    .filter((entry) => entry.length > 0)
    .sort((left, right) => left.localeCompare(right));

  let mergedState: SystemState = {};
  const pathClocks: Record<string, LogicalClock> = {};
  const tombstones: Record<string, LogicalClock> = {};
  const conflicts: SyncConflict[] = [];
  const strategy = options?.conflictStrategy ?? "lww";

  for (const pathValue of sortedPaths) {
    const localSnapshot = pathSnapshot(local, pathValue, local.clock);
    const remoteSnapshot = pathSnapshot(remote, pathValue, remote.clock);

    const valuesDiffer = !valuesEqual(localSnapshot.value, remoteSnapshot.value)
      || localSnapshot.exists !== remoteSnapshot.exists;

    let resolution: ConflictResolution = "local";
    const cmp = compareClock(localSnapshot.clock, remoteSnapshot.clock);
    if (cmp < 0) {
      resolution = "remote";
    } else if (cmp === 0) {
      resolution = resolveSameClockTie(localSnapshot, remoteSnapshot, local.id, remote.id);
      if (strategy === "manual" && valuesDiffer) {
        resolution = "manual";
      }
    } else if (strategy === "manual" && valuesDiffer) {
      resolution = "manual";
    }

    const mergeHandler = options?.mergeHandlers?.[pathValue];
    if (mergeHandler && valuesDiffer) {
      const handlerResult = mergeHandler(localSnapshot.value, remoteSnapshot.value, {
        path: pathValue,
        localClock: localSnapshot.clock,
        remoteClock: remoteSnapshot.clock,
      });

      if (handlerResult === MANUAL_RESOLUTION) {
        resolution = "manual";
      } else {
        mergedState = setAtPath(mergedState, pathValue, handlerResult);
        pathClocks[pathValue] = maxClock(localSnapshot.clock, remoteSnapshot.clock);
        continue;
      }
    }

    if (valuesDiffer || resolution === "manual") {
      conflicts.push(makeConflict(
        pathValue,
        localSnapshot,
        remoteSnapshot,
        resolution,
        cmp === 0 ? "same-path-different-values" : "clock-precedence"
      ));
    }

    if (resolution === "manual") {
      const tombstoneClock = maxClock(localSnapshot.clock, remoteSnapshot.clock);
      tombstones[pathValue] = tombstoneClock;
      continue;
    }

    const winner = resolution === "local" ? localSnapshot : remoteSnapshot;
    if (winner.exists) {
      mergedState = setAtPath(mergedState, pathValue, winner.value);
      pathClocks[pathValue] = cloneUnknown(winner.clock);
      delete tombstones[pathValue];
    } else {
      tombstones[pathValue] = cloneUnknown(winner.clock);
      delete pathClocks[pathValue];
    }
  }

  return {
    state: mergedState as TState,
    pathClocks,
    tombstones,
    conflicts,
  };
}

export function mergeStates(
  a: SystemState,
  b: SystemState,
  options?: {
    conflictStrategy?: ConflictStrategy;
    mergeHandlers?: MergeHandlers;
  }
): SystemState {
  const aId = defaultReplicaIdFromState(a);
  const bId = defaultReplicaIdFromState(b);

  const left = createReplica(aId, a);
  const right = createReplica(bId, b);
  return mergeReplicaStates(left, right, options).state;
}

function buildAudit(
  source: string,
  target: string,
  changesApplied: ChangeSet[],
  conflicts: SyncConflict[],
  trace: SyncTrace,
  timestamp: LogicalClock
): SyncAudit {
  return {
    source,
    target,
    changesApplied: changesApplied.map((entry) => cloneUnknown(entry)),
    conflicts: conflicts.map((entry) => cloneUnknown(entry)),
    trace: cloneUnknown(trace),
    timestamp: cloneUnknown(timestamp),
  };
}

function broadcastFromTransport(transport: Transport | undefined, deltas: ChangeSet[]): void {
  if (!transport) {
    return;
  }

  for (const delta of deltas) {
    transport.send(delta);
  }
}

export function sync<TState extends SystemState>(
  local: Replica<TState>,
  remote: Replica<TState>,
  options?: {
    mode?: SyncMode;
    conflictStrategy?: ConflictStrategy;
    mergeHandlers?: MergeHandlers;
    validators?: Array<(state: TState) => boolean>;
    security?: SyncSecurity;
    transport?: Transport;
  }
): SyncResult<TState> {
  const mode = options?.mode ?? "bidirectional";

  const localBaseClock = local.clock;
  const remoteBaseClock = remote.clock;
  const localNextClock = incrementClock(localBaseClock);
  const remoteNextClock = incrementClock(remoteBaseClock);

  const localToRemote = computeDelta(remote.state, local.state, {
    origin: local.id,
    timestamp: localNextClock,
  });

  const remoteToLocal = computeDelta(local.state, remote.state, {
    origin: remote.id,
    timestamp: remoteNextClock,
  });

  let nextLocal = createReplica(local.id, local.state, {
    version: local.version,
    clock: localBaseClock,
    versionVector: local.versionVector,
    pathClocks: local.pathClocks,
    tombstones: local.tombstones,
    pendingConflicts: local.pendingConflicts,
    syncAudit: local.syncAudit,
  });
  let nextRemote = createReplica(remote.id, remote.state, {
    version: remote.version,
    clock: remoteBaseClock,
    versionVector: remote.versionVector,
    pathClocks: remote.pathClocks,
    tombstones: remote.tombstones,
    pendingConflicts: remote.pendingConflicts,
    syncAudit: remote.syncAudit,
  });

  const conflicts: SyncConflict[] = [];
  const deltas: ChangeSet[] = [];
  let changesMerged = 0;

  if (mode === "push" || mode === "bidirectional") {
    const appliedToRemote = applyDelta(nextRemote, localToRemote, {
      conflictStrategy: options?.conflictStrategy,
      mergeHandlers: options?.mergeHandlers,
      validators: options?.validators,
      security: options?.security,
    });
    nextRemote = appliedToRemote.replica;
    nextLocal.clock = localNextClock;
    nextLocal.version = Math.max(nextLocal.version, localNextClock.counter);
    nextLocal.versionVector[local.id] = Math.max(nextLocal.versionVector[local.id] ?? 0, localNextClock.counter);
    conflicts.push(...appliedToRemote.conflicts);
    changesMerged += appliedToRemote.appliedOperations;
    deltas.push(localToRemote);
  }

  if (mode === "pull") {
    const appliedToLocal = applyDelta(nextLocal, remoteToLocal, {
      conflictStrategy: options?.conflictStrategy,
      mergeHandlers: options?.mergeHandlers,
      validators: options?.validators,
      security: options?.security,
    });
    nextLocal = appliedToLocal.replica;
    nextRemote.clock = remoteNextClock;
    nextRemote.version = Math.max(nextRemote.version, remoteNextClock.counter);
    nextRemote.versionVector[remote.id] = Math.max(nextRemote.versionVector[remote.id] ?? 0, remoteNextClock.counter);
    conflicts.push(...appliedToLocal.conflicts);
    changesMerged += appliedToLocal.appliedOperations;
    deltas.push(remoteToLocal);
  }

  if (mode === "bidirectional") {
    const appliedToLocal = applyDelta(nextLocal, remoteToLocal, {
      conflictStrategy: options?.conflictStrategy,
      mergeHandlers: options?.mergeHandlers,
      validators: options?.validators,
      security: options?.security,
    });
    nextLocal = appliedToLocal.replica;
    conflicts.push(...appliedToLocal.conflicts);
    changesMerged += appliedToLocal.appliedOperations;
    deltas.push(remoteToLocal);

    const merged = mergeReplicaStates(nextLocal, nextRemote, {
      conflictStrategy: options?.conflictStrategy,
      mergeHandlers: options?.mergeHandlers,
    });

    const canonicalClockNode = [local.id, remote.id].sort((a, b) => a.localeCompare(b))[0] ?? local.id;
    const canonicalClock = mergeClock(nextLocal.clock, nextRemote.clock, canonicalClockNode);
    const mergedVector = mergeVersionVectors(nextLocal.versionVector, nextRemote.versionVector);
    mergedVector[canonicalClockNode] = Math.max(mergedVector[canonicalClockNode] ?? 0, canonicalClock.counter);

    nextLocal = createReplica(local.id, merged.state, {
      version: Math.max(nextLocal.version, nextRemote.version, canonicalClock.counter),
      clock: canonicalClock,
      versionVector: mergedVector,
      pathClocks: merged.pathClocks,
      tombstones: merged.tombstones,
      pendingConflicts: [...nextLocal.pendingConflicts, ...nextRemote.pendingConflicts, ...merged.conflicts],
      syncAudit: nextLocal.syncAudit,
    });
    nextRemote = createReplica(remote.id, merged.state, {
      version: Math.max(nextLocal.version, nextRemote.version, canonicalClock.counter),
      clock: canonicalClock,
      versionVector: mergedVector,
      pathClocks: merged.pathClocks,
      tombstones: merged.tombstones,
      pendingConflicts: [...nextLocal.pendingConflicts, ...nextRemote.pendingConflicts, ...merged.conflicts],
      syncAudit: nextRemote.syncAudit,
    });

    conflicts.push(...merged.conflicts);
  }

  nextLocal.versionVector = mergeVersionVectors(nextLocal.versionVector, nextRemote.versionVector);
  nextRemote.versionVector = mergeVersionVectors(nextRemote.versionVector, nextLocal.versionVector);

  const convergenceAchieved = stableStringify(nextLocal.state) === stableStringify(nextRemote.state);
  const trace: SyncTrace = {
    replicasInvolved: [local.id, remote.id].sort((a, b) => a.localeCompare(b)),
    changesMerged,
    conflictsDetected: conflicts.length,
    convergenceAchieved,
  };

  const auditClock = mergeClock(nextLocal.clock, nextRemote.clock, local.id.localeCompare(remote.id) <= 0 ? local.id : remote.id);
  const localAudit = buildAudit(local.id, remote.id, deltas, conflicts, trace, auditClock);
  const remoteAudit = buildAudit(remote.id, local.id, deltas, conflicts, trace, auditClock);
  nextLocal.syncAudit = [...nextLocal.syncAudit, localAudit];
  nextRemote.syncAudit = [...nextRemote.syncAudit, remoteAudit];

  broadcastFromTransport(options?.transport, deltas);

  return {
    local: nextLocal,
    remote: nextRemote,
    localAudit,
    remoteAudit,
    trace,
    deltas,
  };
}

export function validateReplicaConvergence<TState extends SystemState>(replicas: Array<Replica<TState>>): boolean {
  if (replicas.length <= 1) {
    return true;
  }

  const firstHash = stableStringify(replicas[0].state);
  return replicas.every((replica) => stableStringify(replica.state) === firstHash);
}

export function signChangeSet(changeSet: ChangeSet, signer: string, secret: string): SignedChangeSet {
  const sanitizedSigner = signer.trim();
  const payload = stableStringify({
    id: changeSet.id,
    origin: changeSet.origin,
    timestamp: changeSet.timestamp,
    operations: sortOperations(changeSet.operations),
    signer: sanitizedSigner,
  });
  const signature = createHash("sha256")
    .update(payload)
    .update(secret)
    .digest("hex");

  return {
    ...cloneUnknown(changeSet),
    signer: sanitizedSigner,
    signature,
  };
}

export function verifySignedChangeSet(changeSet: SignedChangeSet, secret: string, trustedNodeIds?: string[]): boolean {
  if (trustedNodeIds && trustedNodeIds.length > 0 && !trustedNodeIds.includes(changeSet.signer)) {
    return false;
  }

  const expected = signChangeSet(
    {
      id: changeSet.id,
      origin: changeSet.origin,
      timestamp: changeSet.timestamp,
      operations: changeSet.operations,
    },
    changeSet.signer,
    secret
  );

  return expected.signature === changeSet.signature;
}

export function batchChangeSets(changeSets: ChangeSet[], maxOperationsPerBatch = 128): ChangeSet[] {
  const maxOps = Math.max(1, Math.floor(maxOperationsPerBatch));
  const sorted = [...changeSets].sort((left, right) => {
    const timeCmp = compareClock(left.timestamp, right.timestamp);
    if (timeCmp !== 0) {
      return timeCmp;
    }

    const originCmp = left.origin.localeCompare(right.origin);
    if (originCmp !== 0) {
      return originCmp;
    }

    return left.id.localeCompare(right.id);
  });

  const flattened = sorted.flatMap((entry) => sortOperations(entry.operations).map((operation) => ({
    operation,
    origin: entry.origin,
    timestamp: entry.timestamp,
  })));

  const batches: ChangeSet[] = [];
  for (let index = 0; index < flattened.length; index += maxOps) {
    const slice = flattened.slice(index, index + maxOps);
    const anchor = slice[0];
    if (!anchor) {
      continue;
    }

    const operations = slice.map((entry) => ({
      ...entry.operation,
      clock: entry.operation.clock ?? entry.timestamp,
    }));
    const timestamp = maxClock(
      anchor.timestamp,
      slice.reduce((acc, current) => maxClock(acc, current.timestamp), anchor.timestamp)
    );
    const origin = anchor.origin;

    batches.push({
      id: buildChangeSetId(origin, timestamp, operations),
      origin,
      timestamp,
      operations,
    });
  }

  return batches;
}

export function compressChangeSets(changeSets: ChangeSet[]): string {
  const payload = stableStringify(changeSets.map((entry) => ({
    ...entry,
    operations: sortOperations(entry.operations),
  })));
  return gzipSync(Buffer.from(payload, "utf-8")).toString("base64");
}

export function decompressChangeSets(payload: string): ChangeSet[] {
  const raw = gunzipSync(Buffer.from(payload, "base64")).toString("utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const origin = typeof entry.origin === "string" ? entry.origin : "unknown";
    const timestamp = toClock(isRecord(entry.timestamp)
      ? {
        counter: Number(entry.timestamp.counter),
        nodeId: String(entry.timestamp.nodeId),
      }
      : ZERO_CLOCK, origin);
    const operations = Array.isArray(entry.operations)
      ? sortOperations(entry.operations.flatMap((operation) => {
        if (!isRecord(operation) || typeof operation.path !== "string") {
          return [];
        }

        const type = operation.type === "add" || operation.type === "update" || operation.type === "remove"
          ? operation.type
          : null;
        if (!type) {
          return [];
        }

        const clock = isRecord(operation.clock)
          ? toClock({
            counter: Number(operation.clock.counter),
            nodeId: String(operation.clock.nodeId),
          }, origin)
          : undefined;

        return [{
          type,
          path: normalizePath(operation.path),
          value: cloneUnknown(operation.value),
          ...(clock ? { clock } : {}),
        } satisfies StateOperation];
      }))
      : [];

    const id = typeof entry.id === "string" && entry.id.trim().length > 0
      ? entry.id
      : buildChangeSetId(origin, timestamp, operations);

    return [{
      id,
      origin,
      timestamp,
      operations,
    } satisfies ChangeSet];
  });
}

export function createSyncTrace<TState extends SystemState>(replicas: Array<Replica<TState>>, changesMerged: number, conflictsDetected: number): SyncTrace {
  return {
    replicasInvolved: [...new Set(replicas.map((replica) => replica.id))].sort((a, b) => a.localeCompare(b)),
    changesMerged,
    conflictsDetected,
    convergenceAchieved: validateReplicaConvergence(replicas),
  };
}
