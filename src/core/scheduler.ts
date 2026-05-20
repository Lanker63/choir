import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import ts from "typescript";
import { runConflictResolutionEngine } from "../fix/conflictEngine.js";
import { Fix, FixConflict, Patch, isTextPatch } from "../fix/types.js";
import { ControlPlane, Plan, Task } from "../schema.js";
import { recordAudit } from "./audit.js";
import { detectEnvironment } from "./policyEngine.js";
import { createEmptyStatePlane, StatePlane, readStatePlane, persistStatePlane } from "./state.js";
import { Diagnostic, SchedulerTrace, TransactionTrace } from "./types.js";
import { locationToOffsetRange } from "./diagnostics.js";
import { cloneJson } from "../utils/clone.js";
import { classifyPatch, recordMutationTrace } from "./mutationTrace.js";
import { CompilerWorkspace } from "./compilerWorkspace.js";

export type ExecutionNode = {
  id: string;
  task: Task;
  planId: string;
  dependencies: string[];
  files: string[];
};

export type ExecutionGraph = {
  nodes: Map<string, ExecutionNode>;
};

export type ConflictMatrix = Map<string, Set<string>>;

export type WorkUnit = {
  id: string;
  type: Task["type"];
  tasks: Task[];
  files: string[];
  planIds: string[];
};

export type ExecutionBatch = {
  id: string;
  workUnits: WorkUnit[];
  parallelizable: boolean;
};

export type ExecutionPlan = {
  batches: ExecutionBatch[];
};

export type BuildExecutionPlanResult = {
  graph: ExecutionGraph;
  conflictMatrix: ConflictMatrix;
  executionPlan: ExecutionPlan;
  trace: SchedulerTrace;
};

export type WorkUnitRunner = (unit: WorkUnit) => Promise<unknown>;

export type WorkUnitRunResult = {
  batchId: string;
  workUnitId: string;
  result: unknown;
};

export type TransactionStatus =
  | "pending"
  | "running"
  | "validated"
  | "committed"
  | "rolled-back"
  | "failed";

export type SnapshotSet = {
  files: Record<string, string>;
  stateJson: StatePlane;
};

export type InvariantCheckResult = {
  name:
    | "no-new-errors"
    | "ast-valid"
    | "type-check"
    | "no-overlap"
    | "priority-respected"
    | "idempotent";
  passed: boolean;
  details?: string;
};

export type ValidationResult = {
  passed: boolean;
  diagnostics: Diagnostic[];
  conflicts: FixConflict[];
  invariantChecks: InvariantCheckResult[];
  errors?: string[];
};

export type Transaction = {
  id: string;
  batchId: string;
  status: TransactionStatus;
  snapshots: SnapshotSet;
  proposedPatches: Patch[];
  validation: ValidationResult;
  traceId: string;
  touchedFiles: string[];
  snapshotMissingFiles: string[];
  virtualFiles: Record<string, string>;
};

export type VirtualFS = {
  files: Record<string, string>;
  stateJson: StatePlane;
};

export type AtomicMutation = {
  writes: Record<string, string>;
  deletes: string[];
};

export type TransactionFS = {
  readFiles(files: string[]): Promise<Record<string, string>>;
  readStateJson(): Promise<StatePlane>;
  atomicWrite(mutation: AtomicMutation): Promise<void>;
  writeState(state: StatePlane): Promise<void>;
};

export type TransactionEnforcer = {
  proposeFixes(workUnits: WorkUnit[]): Promise<{
    fixes: Fix[];
    diagnostics?: Diagnostic[];
  }>;
};

export type TransactionPipeline = {
  run(input: {
    fs: VirtualFS;
    controlPlane: ControlPlane;
    batch: ExecutionBatch;
    transaction: Transaction;
  }): Promise<{
    diagnostics: Diagnostic[];
    conflicts: FixConflict[];
    errors?: string[];
  }>;
};

export type TypeCheckResult = {
  passed: boolean;
  details?: string;
};

export type TransactionFileLock = {
  runExclusive<T>(files: string[], work: () => Promise<T>): Promise<T>;
};

export type TransactionalExecutionOptions = {
  root?: string;
  fs?: TransactionFS;
  enforcer: TransactionEnforcer;
  pipeline: TransactionPipeline;
  controlPlane: ControlPlane;
  fileLock?: TransactionFileLock;
  maxNewErrors?: number;
  typeCheck?: (vfs: VirtualFS) => Promise<TypeCheckResult>;
  executeLayersInParallel?: boolean;
};

export type TransactionalExecutionResult = {
  workUnitResults: WorkUnitRunResult[];
  transactions: Transaction[];
  traces: TransactionTrace[];
};

export type BatchSimulationResult = {
  batchId: string;
  transaction: Transaction;
  validation: ValidationResult;
  success: boolean;
};

export type ExecutionSimulationResult = {
  results: BatchSimulationResult[];
  validation: ValidationResult;
  allPassed: boolean;
  traces: TransactionTrace[];
};

export type SimulationExecutionOptions = {
  root?: string;
  fs?: TransactionFS;
  enforcer: TransactionEnforcer;
  pipeline: TransactionPipeline;
  controlPlane: ControlPlane;
  maxNewErrors?: number;
  typeCheck?: (vfs: VirtualFS) => Promise<TypeCheckResult>;
};

export type InMemoryTransactionFS = TransactionFS & {
  journal: Array<{ kind: "atomic-write" | "write-state"; writes: number; deletes: number }>;
  snapshot(): { files: Record<string, string>; state: StatePlane };
};

type SchedulerOptions = {
  maxBatchFiles?: number;
  smallTaskMergeThreshold?: number;
};

type InternalWorkUnit = WorkUnit & {
  nodeIds: string[];
  ruleKey?: string;
};

const DEFAULT_OPTIONS: Required<SchedulerOptions> = {
  maxBatchFiles: 20,
  smallTaskMergeThreshold: 3,
};

function withDefaults(options?: SchedulerOptions): Required<SchedulerOptions> {
  return {
    maxBatchFiles: options?.maxBatchFiles ?? DEFAULT_OPTIONS.maxBatchFiles,
    smallTaskMergeThreshold: options?.smallTaskMergeThreshold ?? DEFAULT_OPTIONS.smallTaskMergeThreshold,
  };
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function taskFiles(task: Task): string[] {
  return sortedUnique((task.scope?.files ?? []).map((file) => normalizePath(file)));
}

function globalTaskId(planId: string, taskId: string): string {
  return `${planId}:${taskId}`;
}

function extractRuleKey(task: Task): string | undefined {
  const match = task.title.match(/^Fix\s+(.+)\s+violations$/i);
  if (!match) {
    return undefined;
  }

  const value = match[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function hashId(prefix: string, parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("|"), "utf-8").digest("hex").slice(0, 12);
  return `${prefix}-${digest}`;
}

function buildDependents(graph: ExecutionGraph): Map<string, string[]> {
  const dependents = new Map<string, string[]>();

  for (const nodeId of graph.nodes.keys()) {
    dependents.set(nodeId, []);
  }

  for (const [nodeId, node] of graph.nodes.entries()) {
    for (const dependencyId of node.dependencies) {
      const existing = dependents.get(dependencyId) ?? [];
      existing.push(nodeId);
      dependents.set(dependencyId, existing);
    }
  }

  for (const [nodeId, values] of dependents.entries()) {
    dependents.set(nodeId, sortedUnique(values));
  }

  return dependents;
}

function dependencyMap(graph: ExecutionGraph): Map<string, string[]> {
  return new Map(
    [...graph.nodes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([nodeId, node]) => [nodeId, sortedUnique(node.dependencies)] as const)
  );
}

function isReachable(
  start: string,
  target: string,
  dependencyByNode: Map<string, string[]>,
  cache: Map<string, Set<string>>
): boolean {
  const cached = cache.get(start);
  if (cached) {
    return cached.has(target);
  }

  const visited = new Set<string>();
  const stack = [...(dependencyByNode.get(start) ?? [])];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (visited.has(current)) {
      continue;
    }

    visited.add(current);

    const next = dependencyByNode.get(current) ?? [];
    for (const dependencyId of next) {
      if (!visited.has(dependencyId)) {
        stack.push(dependencyId);
      }
    }
  }

  cache.set(start, visited);
  return visited.has(target);
}

function fileConflict(left: ExecutionNode, right: ExecutionNode): boolean {
  if (left.files.length === 0 || right.files.length === 0) {
    return false;
  }

  const rightFileSet = new Set(right.files);
  return left.files.some((file) => rightFileSet.has(file));
}

function dependencyChainConflict(
  leftId: string,
  rightId: string,
  dependencyByNode: Map<string, string[]>,
  cache: Map<string, Set<string>>
): boolean {
  return isReachable(leftId, rightId, dependencyByNode, cache)
    || isReachable(rightId, leftId, dependencyByNode, cache);
}

function conflictCount(matrix: ConflictMatrix): number {
  let total = 0;
  for (const values of matrix.values()) {
    total += values.size;
  }

  return Math.floor(total / 2);
}

function createSingleWorkUnit(node: ExecutionNode): InternalWorkUnit {
  const unitId = hashId("wu", [node.id, ...node.files]);
  return {
    id: unitId,
    type: node.task.type,
    tasks: [node.task],
    files: [...node.files],
    planIds: [node.planId],
    nodeIds: [node.id],
    ruleKey: extractRuleKey(node.task),
  };
}

function canMergeNodeIntoUnit(
  node: ExecutionNode,
  unit: InternalWorkUnit,
  conflicts: ConflictMatrix,
  options: Required<SchedulerOptions>
): boolean {
  if (node.task.type !== unit.type) {
    return false;
  }

  const nodeRuleKey = extractRuleKey(node.task);
  if (unit.ruleKey && nodeRuleKey && unit.ruleKey !== nodeRuleKey) {
    return false;
  }

  const nodeFileCount = node.files.length;
  if (nodeFileCount > options.maxBatchFiles) {
    return false;
  }

  const mergedFiles = sortedUnique([...unit.files, ...node.files]);
  if (mergedFiles.length > options.maxBatchFiles) {
    return false;
  }

  const unitSmall = unit.files.length < options.smallTaskMergeThreshold;
  const nodeSmall = nodeFileCount < options.smallTaskMergeThreshold;
  if (!unitSmall && !nodeSmall) {
    return false;
  }

  const nodeConflicts = conflicts.get(node.id) ?? new Set<string>();
  if (unit.nodeIds.some((nodeId) => nodeConflicts.has(nodeId))) {
    return false;
  }

  return true;
}

function mergeNodeIntoUnit(node: ExecutionNode, unit: InternalWorkUnit): InternalWorkUnit {
  const mergedNodeIds = sortedUnique([...unit.nodeIds, node.id]);
  const mergedFiles = sortedUnique([...unit.files, ...node.files]);
  const mergedPlanIds = sortedUnique([...unit.planIds, node.planId]);
  const mergedTasks = [...unit.tasks, node.task].sort((left, right) => left.id.localeCompare(right.id));

  return {
    ...unit,
    id: hashId("wu", [...mergedNodeIds, ...mergedFiles]),
    tasks: mergedTasks,
    files: mergedFiles,
    planIds: mergedPlanIds,
    nodeIds: mergedNodeIds,
    ruleKey: unit.ruleKey ?? extractRuleKey(node.task),
  };
}

function layerUnits(
  layer: ExecutionNode[],
  conflicts: ConflictMatrix,
  options: Required<SchedulerOptions>,
  decisions: string[]
): InternalWorkUnit[] {
  const units: InternalWorkUnit[] = [];
  const orderedLayer = [...layer].sort((left, right) => left.id.localeCompare(right.id));

  for (const node of orderedLayer) {
    let merged = false;

    for (let index = 0; index < units.length; index += 1) {
      const unit = units[index];
      if (!canMergeNodeIntoUnit(node, unit, conflicts, options)) {
        continue;
      }

      units[index] = mergeNodeIntoUnit(node, unit);
      merged = true;
      decisions.push(`Merged ${node.id} into work unit ${units[index].id}`);
      break;
    }

    if (!merged) {
      units.push(createSingleWorkUnit(node));
    }
  }

  return units.sort((left, right) => left.id.localeCompare(right.id));
}

function unitsConflict(left: InternalWorkUnit, right: InternalWorkUnit, matrix: ConflictMatrix): boolean {
  return left.nodeIds.some((leftNodeId) => {
    const conflicts = matrix.get(leftNodeId) ?? new Set<string>();
    return right.nodeIds.some((rightNodeId) => conflicts.has(rightNodeId));
  });
}

function splitParallel(
  units: InternalWorkUnit[],
  conflictMatrix: ConflictMatrix,
  layerIndex: number
): ExecutionBatch[] {
  const grouped: InternalWorkUnit[][] = [];

  for (const unit of [...units].sort((left, right) => left.id.localeCompare(right.id))) {
    let placed = false;

    for (const batchUnits of grouped) {
      const conflictWithBatch = batchUnits.some((existing) => unitsConflict(existing, unit, conflictMatrix));
      if (conflictWithBatch) {
        continue;
      }

      batchUnits.push(unit);
      batchUnits.sort((left, right) => left.id.localeCompare(right.id));
      placed = true;
      break;
    }

    if (!placed) {
      grouped.push([unit]);
    }
  }

  return grouped.map((batchUnits, index) => ({
    id: `batch-L${layerIndex + 1}-${index + 1}`,
    workUnits: batchUnits.map((unit) => ({
      id: unit.id,
      type: unit.type,
      tasks: unit.tasks,
      files: unit.files,
      planIds: unit.planIds,
    })),
    parallelizable: batchUnits.length > 1,
  }));
}

export function buildExecutionGraph(plans: Plan[]): ExecutionGraph {
  const sortedPlans = [...plans].sort((left, right) => left.id.localeCompare(right.id));

  const rawNodes = sortedPlans.flatMap((plan) => {
    const sortedTasks = [...plan.tasks].sort((left, right) => left.id.localeCompare(right.id));

    return sortedTasks.map((task) => {
      const nodeId = globalTaskId(plan.id, task.id);
      const dependencies = sortedUnique((task.dependsOn ?? []).map((dependencyId) => globalTaskId(plan.id, dependencyId)));

      return {
        id: nodeId,
        task,
        planId: plan.id,
        dependencies,
        files: taskFiles(task),
      } satisfies ExecutionNode;
    });
  });

  const nodeIdSet = new Set(rawNodes.map((node) => node.id));
  for (const node of rawNodes) {
    for (const dependencyId of node.dependencies) {
      if (!nodeIdSet.has(dependencyId)) {
        throw new Error(`Execution graph dependency not found: ${dependencyId}`);
      }
    }
  }

  const sortedNodes = rawNodes.sort((left, right) => left.id.localeCompare(right.id));
  return {
    nodes: new Map(sortedNodes.map((node) => [node.id, node] as const)),
  };
}

export function buildConflictMatrix(graph: ExecutionGraph): ConflictMatrix {
  const nodeIds = [...graph.nodes.keys()].sort((left, right) => left.localeCompare(right));
  const dependencyByNode = dependencyMap(graph);
  const reachabilityCache = new Map<string, Set<string>>();

  const matrix: ConflictMatrix = new Map(nodeIds.map((nodeId) => [nodeId, new Set<string>()] as const));

  for (let leftIndex = 0; leftIndex < nodeIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodeIds.length; rightIndex += 1) {
      const leftId = nodeIds[leftIndex];
      const rightId = nodeIds[rightIndex];
      const leftNode = graph.nodes.get(leftId) as ExecutionNode;
      const rightNode = graph.nodes.get(rightId) as ExecutionNode;

      const hasFileConflict = fileConflict(leftNode, rightNode);
      const hasDependencyConflict = dependencyChainConflict(leftId, rightId, dependencyByNode, reachabilityCache);

      if (!hasFileConflict && !hasDependencyConflict) {
        continue;
      }

      (matrix.get(leftId) as Set<string>).add(rightId);
      (matrix.get(rightId) as Set<string>).add(leftId);
    }
  }

  return matrix;
}

export function computeExecutionLayers(graph: ExecutionGraph): ExecutionNode[][] {
  const nodeIds = [...graph.nodes.keys()].sort((left, right) => left.localeCompare(right));
  const dependents = buildDependents(graph);
  const indegree = new Map<string, number>(
    nodeIds.map((nodeId) => [nodeId, (graph.nodes.get(nodeId) as ExecutionNode).dependencies.length] as const)
  );

  let ready = nodeIds.filter((nodeId) => (indegree.get(nodeId) ?? 0) === 0);
  const layers: ExecutionNode[][] = [];
  let processed = 0;

  while (ready.length > 0) {
    const currentLayerIds = [...ready].sort((left, right) => left.localeCompare(right));
    const currentLayer = currentLayerIds.map((nodeId) => graph.nodes.get(nodeId) as ExecutionNode);
    layers.push(currentLayer);
    processed += currentLayerIds.length;

    const nextReady = new Set<string>();

    for (const nodeId of currentLayerIds) {
      const directDependents = dependents.get(nodeId) ?? [];
      for (const dependentId of directDependents) {
        const nextValue = (indegree.get(dependentId) ?? 0) - 1;
        indegree.set(dependentId, nextValue);
        if (nextValue === 0) {
          nextReady.add(dependentId);
        }
      }
    }

    ready = [...nextReady].sort((left, right) => left.localeCompare(right));
  }

  if (processed !== nodeIds.length) {
    const unresolved = nodeIds.filter((nodeId) => (indegree.get(nodeId) ?? 0) > 0);
    throw new Error(`Cycle detected in execution graph: ${unresolved.join(", ")}`);
  }

  return layers;
}

export function buildExecutionPlan(plans: Plan[], options?: SchedulerOptions): BuildExecutionPlanResult {
  const normalizedOptions = withDefaults(options);
  const graph = buildExecutionGraph(plans);
  const layers = computeExecutionLayers(graph);
  const conflictMatrix = buildConflictMatrix(graph);
  const decisions: string[] = [];

  const batches: ExecutionBatch[] = [];

  layers.forEach((layer, layerIndex) => {
    const units = layerUnits(layer, conflictMatrix, normalizedOptions, decisions);
    const layerBatches = splitParallel(units, conflictMatrix, layerIndex);
    batches.push(...layerBatches);
  });

  const executionPlan: ExecutionPlan = {
    batches,
  };

  const totalTasks = plans.reduce((sum, plan) => sum + plan.tasks.length, 0);
  const trace: SchedulerTrace = {
    totalPlans: plans.length,
    totalTasks,
    totalBatches: batches.length,
    parallelBatches: batches.filter((batch) => batch.parallelizable).length,
    conflictsAvoided: conflictCount(conflictMatrix),
    decisions,
  };

  return {
    graph,
    conflictMatrix,
    executionPlan,
    trace,
  };
}

export async function runExecutionPlan(
  executionPlan: ExecutionPlan,
  runner: WorkUnitRunner
): Promise<WorkUnitRunResult[]> {
  const results: WorkUnitRunResult[] = [];

  for (const batch of executionPlan.batches) {
    const orderedUnits = [...batch.workUnits].sort((left, right) => left.id.localeCompare(right.id));

    if (batch.parallelizable) {
      const batchResults = await Promise.all(
        orderedUnits.map(async (workUnit) => ({
          batchId: batch.id,
          workUnitId: workUnit.id,
          result: await runner(workUnit),
        }))
      );

      results.push(...batchResults);
      continue;
    }

    for (const workUnit of orderedUnits) {
      results.push({
        batchId: batch.id,
        workUnitId: workUnit.id,
        result: await runner(workUnit),
      });
    }
  }

  return results;
}

function cloneStatePlane(state: StatePlane): StatePlane {
  return cloneJson(state);
}

function cloneFilesRecord(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(files)
      .sort((left, right) => left.localeCompare(right))
      .map((file) => [file, files[file]])
  );
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

function stableConflicts(conflicts: FixConflict[]): FixConflict[] {
  return [...conflicts].sort((left, right) => {
    if (left.fixA !== right.fixA) return left.fixA.localeCompare(right.fixA);
    if (left.fixB !== right.fixB) return left.fixB.localeCompare(right.fixB);
    return left.reason.localeCompare(right.reason);
  });
}

function resolveWithinRoot(root: string, relativeFilePath: string): string {
  const rootPath = path.resolve(root);
  const absolutePath = path.resolve(rootPath, relativeFilePath);

  if (absolutePath === rootPath || absolutePath.startsWith(`${rootPath}${path.sep}`)) {
    return absolutePath;
  }

  throw new Error(`Refusing to access file outside workspace root: ${relativeFilePath}`);
}

function collectBatchFiles(batch: ExecutionBatch): string[] {
  return sortedUnique(batch.workUnits.flatMap((unit) => unit.files.map((file) => normalizePath(file))));
}

function collectPatchFiles(patches: Patch[]): string[] {
  return sortedUnique(
    patches.flatMap((patch) => {
      if (isTextPatch(patch)) {
        return [normalizePath(patch.location.file)];
      }

      if (patch.type === "create-file" || patch.type === "delete-file") {
        return [normalizePath(patch.file)];
      }

      return [normalizePath(patch.from), normalizePath(patch.to)];
    })
  );
}

function countErrorDiagnostics(diagnostics: Diagnostic[]): number {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
}

function stableVirtualFS(vfs: VirtualFS): VirtualFS {
  return {
    files: cloneFilesRecord(vfs.files),
    stateJson: cloneStatePlane(vfs.stateJson),
  };
}

function virtualFsEqual(left: VirtualFS, right: VirtualFS): boolean {
  return JSON.stringify(stableVirtualFS(left)) === JSON.stringify(stableVirtualFS(right));
}

function normalizeBatchLayer(batchId: string, fallback: number): number {
  const match = batchId.match(/^batch-L(\d+)-/i);
  if (!match) {
    return fallback;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildRollbackMutation(tx: Transaction): AtomicMutation {
  const writes = cloneFilesRecord(tx.snapshots.files);
  const deleteSet = new Set(tx.snapshotMissingFiles);

  return {
    writes,
    deletes: [...deleteSet].sort((left, right) => left.localeCompare(right)),
  };
}

function buildCommitMutation(tx: Transaction): AtomicMutation {
  const writes: Record<string, string> = {};
  const deletes: string[] = [];

  for (const file of sortedUnique(tx.touchedFiles)) {
    if (Object.prototype.hasOwnProperty.call(tx.virtualFiles, file)) {
      writes[file] = tx.virtualFiles[file];
      continue;
    }

    deletes.push(file);
  }

  return {
    writes,
    deletes: sortedUnique(deletes),
  };
}

function snapshotsMatch(tx: Transaction, currentFiles: Record<string, string>): boolean {
  for (const file of tx.touchedFiles) {
    const expected = tx.snapshots.files[file];
    const actual = currentFiles[file];

    if (expected === undefined && actual === undefined) {
      continue;
    }

    if (expected !== actual) {
      return false;
    }
  }

  return true;
}

function updateStateAfterCommit(tx: Transaction): StatePlane {
  const nextState = cloneStatePlane(tx.snapshots.stateJson);
  nextState.execution = {
    ...nextState.execution,
    history: [
      ...nextState.execution.history,
      {
        planId: tx.batchId,
        status: "complete",
        detail: `Transaction ${tx.id} committed`,
      },
    ],
  };

  return nextState;
}

function recordPatchMutationTraces(root: string | undefined, source: string, patches: Patch[], detail?: string): void {
  if (!root) {
    return;
  }

  for (const patch of patches) {
    const classified = classifyPatch(patch);
    recordMutationTrace(root, {
      source,
      mechanism: classified.mechanism,
      safety: classified.safety,
      operation: classified.operation,
      targetFiles: classified.targetFiles,
      detail,
      payload: patch,
    });
  }
}

export function createNodeTransactionFS(root: string): TransactionFS {
  return {
    async readFiles(files: string[]): Promise<Record<string, string>> {
      const entries: Array<[string, string]> = [];

      for (const file of sortedUnique(files.map((entry) => normalizePath(entry)))) {
        const absolutePath = resolveWithinRoot(root, file);
        try {
          const content = await fs.readFile(absolutePath, "utf-8");
          entries.push([file, content]);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            throw error;
          }
        }
      }

      return Object.fromEntries(entries);
    },
    async readStateJson(): Promise<StatePlane> {
      return cloneStatePlane(readStatePlane(root) ?? createEmptyStatePlane());
    },
    async atomicWrite(mutation: AtomicMutation): Promise<void> {
      const tempFiles: Array<{ tempPath: string; targetPath: string }> = [];

      try {
        for (const file of Object.keys(mutation.writes).sort((left, right) => left.localeCompare(right))) {
          const targetPath = resolveWithinRoot(root, file);
          const tempPath = `${targetPath}.choir-tmp-${hashId("tmp", [file, String(mutation.writes[file].length)])}`;
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(tempPath, mutation.writes[file], "utf-8");
          tempFiles.push({ tempPath, targetPath });
        }

        for (const entry of tempFiles) {
          await fs.rename(entry.tempPath, entry.targetPath);
        }

        for (const file of sortedUnique(mutation.deletes.map((entry) => normalizePath(entry)))) {
          const absolutePath = resolveWithinRoot(root, file);
          try {
            await fs.unlink(absolutePath);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
              throw error;
            }
          }
        }
      } catch (error) {
        for (const entry of tempFiles) {
          try {
            await fs.unlink(entry.tempPath);
          } catch {
            // Best-effort cleanup only.
          }
        }

        throw error;
      }
    },
    async writeState(state: StatePlane): Promise<void> {
      persistStatePlane(root, state);
    },
  };
}

export function createInMemoryTransactionFS(initial?: {
  files?: Record<string, string>;
  state?: StatePlane;
}): InMemoryTransactionFS {
  let files = cloneFilesRecord(initial?.files ?? {});
  let state = cloneStatePlane(initial?.state ?? createEmptyStatePlane());
  const journal: Array<{ kind: "atomic-write" | "write-state"; writes: number; deletes: number }> = [];

  return {
    journal,
    async readFiles(requestedFiles: string[]): Promise<Record<string, string>> {
      const result: Record<string, string> = {};

      for (const file of sortedUnique(requestedFiles.map((entry) => normalizePath(entry)))) {
        if (!Object.prototype.hasOwnProperty.call(files, file)) {
          continue;
        }

        result[file] = files[file];
      }

      return cloneFilesRecord(result);
    },
    async readStateJson(): Promise<StatePlane> {
      return cloneStatePlane(state);
    },
    async atomicWrite(mutation: AtomicMutation): Promise<void> {
      for (const file of Object.keys(mutation.writes).sort((left, right) => left.localeCompare(right))) {
        files[file] = mutation.writes[file];
      }

      for (const file of sortedUnique(mutation.deletes.map((entry) => normalizePath(entry)))) {
        delete files[file];
      }

      journal.push({
        kind: "atomic-write",
        writes: Object.keys(mutation.writes).length,
        deletes: mutation.deletes.length,
      });
    },
    async writeState(nextState: StatePlane): Promise<void> {
      state = cloneStatePlane(nextState);
      journal.push({
        kind: "write-state",
        writes: 0,
        deletes: 0,
      });
    },
    snapshot(): { files: Record<string, string>; state: StatePlane } {
      return {
        files: cloneFilesRecord(files),
        state: cloneStatePlane(state),
      };
    },
  };
}

export class FileSetLock implements TransactionFileLock {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(files: string[], work: () => Promise<T>): Promise<T> {
    const targets = sortedUnique(files.map((file) => normalizePath(file)));
    if (targets.length === 0) {
      return work();
    }

    const pending = targets.map((file) => this.tails.get(file) ?? Promise.resolve());
    let releaseLock: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const chains = new Map<string, Promise<void>>();
    for (const file of targets) {
      const chain = (this.tails.get(file) ?? Promise.resolve()).then(() => hold);
      this.tails.set(file, chain);
      chains.set(file, chain);
    }

    await Promise.all(pending);

    try {
      return await work();
    } finally {
      releaseLock?.();
      for (const file of targets) {
        if (this.tails.get(file) === chains.get(file)) {
          this.tails.delete(file);
        }
      }
    }
  }
}

type PatchApplyResult = {
  files: Record<string, string>;
  errors: string[];
};

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

function applyPatchesToFiles(initialFiles: Record<string, string>, patches: Patch[]): PatchApplyResult {
  const files = cloneFilesRecord(initialFiles);
  const errors: string[] = [];

  for (let patchIndex = 0; patchIndex < patches.length; patchIndex += 1) {
    const patch = patches[patchIndex];

    if (!isTextPatch(patch)) {
      if (patch.type === "create-file") {
        files[normalizePath(patch.file)] = patch.content;
        continue;
      }

      if (patch.type === "delete-file") {
        delete files[normalizePath(patch.file)];
        continue;
      }

      const fromFile = normalizePath(patch.from);
      const toFile = normalizePath(patch.to);
      if (!Object.prototype.hasOwnProperty.call(files, fromFile)) {
        errors.push(`Patch ${patchIndex + 1} rename source not found: ${fromFile}`);
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(files, toFile)) {
        errors.push(`Patch ${patchIndex + 1} rename destination already exists: ${toFile}`);
        continue;
      }

      files[toFile] = files[fromFile];
      delete files[fromFile];
      continue;
    }

    const file = normalizePath(patch.location.file);
    const source = files[file];
    if (source === undefined) {
      errors.push(`Patch ${patchIndex + 1} targets missing file: ${file}`);
      continue;
    }

    const applied = applyTextPatch(source, patch);
    if (applied.error) {
      errors.push(`Patch ${patchIndex + 1} failed for ${file}: ${applied.error}`);
      continue;
    }

    files[file] = applied.next;
  }

  return {
    files: cloneFilesRecord(files),
    errors,
  };
}

function overlapKey(patch: Patch): string {
  if (isTextPatch(patch)) {
    return `text:${normalizePath(patch.location.file)}`;
  }

  if (patch.type === "rename-file") {
    return `rename:${normalizePath(patch.from)}:${normalizePath(patch.to)}`;
  }

  return `${patch.type}:${normalizePath(patch.file)}`;
}

function checkNoOverlap(patches: Patch[], sourceFiles: Record<string, string>): InvariantCheckResult {
  const textRanges: Array<{ file: string; start: number; end: number; patchIndex: number }> = [];
  const fileOps = new Set<string>();

  for (let patchIndex = 0; patchIndex < patches.length; patchIndex += 1) {
    const patch = patches[patchIndex];
    if (!isTextPatch(patch)) {
      const key = overlapKey(patch);
      if (fileOps.has(key)) {
        return {
          name: "no-overlap",
          passed: false,
          details: `Duplicate file mutation detected at patch ${patchIndex + 1}`,
        };
      }

      fileOps.add(key);
      continue;
    }

    const file = normalizePath(patch.location.file);
    const source = sourceFiles[file];
    if (source === undefined) {
      return {
        name: "no-overlap",
        passed: false,
        details: `Patch ${patchIndex + 1} references missing file ${file}`,
      };
    }

    let offsets: { start: number; end: number };
    try {
      offsets = locationToOffsetRange(source, patch.location);
    } catch (error) {
      return {
        name: "no-overlap",
        passed: false,
        details: `Patch ${patchIndex + 1} has invalid location in ${file}: ${(error as Error).message}`,
      };
    }

    const start = patch.type === "insert" && patch.position === "after" ? offsets.end : offsets.start;
    const end = patch.type === "insert" ? start : offsets.end;
    textRanges.push({ file, start, end, patchIndex });
  }

  const ordered = [...textRanges].sort((left, right) => {
    if (left.file !== right.file) return left.file.localeCompare(right.file);
    if (left.start !== right.start) return left.start - right.start;
    if (left.end !== right.end) return left.end - right.end;
    return left.patchIndex - right.patchIndex;
  });

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous.file !== current.file) {
      continue;
    }

    const sameInsertPoint = previous.start === previous.end && current.start === current.end && previous.start === current.start;
    const overlaps = current.start < previous.end;
    if (sameInsertPoint || overlaps) {
      return {
        name: "no-overlap",
        passed: false,
        details: `Overlapping text patches detected in ${current.file}`,
      };
    }
  }

  return {
    name: "no-overlap",
    passed: true,
  };
}

function checkNoNewErrors(
  tx: Transaction,
  diagnostics: Diagnostic[],
  maxNewErrors: number
): InvariantCheckResult {
  const baseline = countErrorDiagnostics(tx.snapshots.stateJson.violations);
  const current = countErrorDiagnostics(diagnostics);
  const allowed = baseline + maxNewErrors;

  return {
    name: "no-new-errors",
    passed: current <= allowed,
    ...(current <= allowed ? {} : { details: `Errors increased from ${baseline} to ${current}` }),
  };
}

function checkASTValidity(vfs: VirtualFS, touchedFiles: string[]): InvariantCheckResult {
  const parseTargets = sortedUnique(touchedFiles).filter((file) => /\.(ts|tsx|js|jsx)$/i.test(file));

  for (const file of parseTargets) {
    const content = vfs.files[file];
    if (typeof content !== "string") {
      continue;
    }

    const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    const syntaxDiagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (syntaxDiagnostics.length > 0) {
      const message = ts.flattenDiagnosticMessageText(syntaxDiagnostics[0]?.messageText ?? "parse error", "\n");
      return {
        name: "ast-valid",
        passed: false,
        details: `${file}: ${message}`,
      };
    }
  }

  return {
    name: "ast-valid",
    passed: true,
  };
}

async function checkType(
  vfs: VirtualFS,
  typeCheck?: (vfs: VirtualFS) => Promise<TypeCheckResult>
): Promise<InvariantCheckResult> {
  const touchesTypeScript = Object.keys(vfs.files).some((file) => /\.(ts|tsx|mts|cts)$/i.test(file));

  if (!touchesTypeScript) {
    return {
      name: "type-check",
      passed: true,
      details: "No TypeScript files touched",
    };
  }

  if (!typeCheck) {
    return {
      name: "type-check",
      passed: false,
      details: "Type check is mandatory for TypeScript mutations",
    };
  }

  const result = await typeCheck(stableVirtualFS(vfs));
  return {
    name: "type-check",
    passed: result.passed,
    ...(result.details ? { details: result.details } : {}),
  };
}

function createDefaultCompilerTypeCheck(root: string): (vfs: VirtualFS) => Promise<TypeCheckResult> {
  return async (vfs: VirtualFS) => {
    const files = Object.entries(vfs.files)
      .filter(([file]) => /\.(ts|tsx|js|jsx|mts|cts)$/i.test(file))
      .map(([file, content]) => ({
        path: path.resolve(root, file),
        content,
      }));

    const workspace = new CompilerWorkspace({
      root,
      files,
    });

    const totals = workspace.getDiagnostics().reduce((acc, entry) => ({
      total: acc.total + entry.total,
      semantic: acc.semantic + entry.semantic,
      syntactic: acc.syntactic + entry.syntactic,
    }), { total: 0, semantic: 0, syntactic: 0 });

    return {
      passed: totals.total === 0,
      details: totals.total === 0
        ? "Compiler diagnostics clean"
        : `Compiler diagnostics present (total=${totals.total}, semantic=${totals.semantic}, syntactic=${totals.syntactic})`,
    };
  };
}

function checkPriority(conflicts: FixConflict[]): InvariantCheckResult {
  const hasPriorityConflict = conflicts.some((conflict) => conflict.reason === "rule-priority");

  return {
    name: "priority-respected",
    passed: !hasPriorityConflict,
    ...(hasPriorityConflict ? { details: "Conflict engine reported rule-priority conflicts" } : {}),
  };
}

export function checkIdempotency(vfs: VirtualFS, patches: Patch[]): InvariantCheckResult {
  const secondPass = applyPatchesToFiles(vfs.files, patches);
  if (secondPass.errors.length > 0) {
    return {
      name: "idempotent",
      passed: false,
      details: secondPass.errors.join(" | "),
    };
  }

  const reapplied = {
    files: secondPass.files,
    stateJson: cloneStatePlane(vfs.stateJson),
  } satisfies VirtualFS;

  return {
    name: "idempotent",
    passed: virtualFsEqual(vfs, reapplied),
    ...(virtualFsEqual(vfs, reapplied) ? {} : { details: "Re-applying patches produced additional changes" }),
  };
}

export async function prepareTransaction(batch: ExecutionBatch, txFs: TransactionFS): Promise<Transaction> {
  const touchedFiles = collectBatchFiles(batch);
  const snapshotFiles = await txFs.readFiles(touchedFiles);
  const stateJson = await txFs.readStateJson();
  const normalizedSnapshotFiles = cloneFilesRecord(snapshotFiles);
  const normalizedTouchedFiles = sortedUnique(touchedFiles);
  const snapshotMissingFiles = normalizedTouchedFiles.filter((file) => !Object.prototype.hasOwnProperty.call(normalizedSnapshotFiles, file));

  return {
    id: hashId("tx", [batch.id, ...normalizedTouchedFiles, ...batch.workUnits.map((unit) => unit.id).sort((a, b) => a.localeCompare(b))]),
    batchId: batch.id,
    status: "pending",
    snapshots: {
      files: normalizedSnapshotFiles,
      stateJson: cloneStatePlane(stateJson),
    },
    proposedPatches: [],
    validation: {
      passed: false,
      diagnostics: [],
      conflicts: [],
      invariantChecks: [],
    },
    traceId: hashId("trace", [batch.id, ...normalizedTouchedFiles]),
    touchedFiles: normalizedTouchedFiles,
    snapshotMissingFiles,
    virtualFiles: cloneFilesRecord(normalizedSnapshotFiles),
  };
}

export function materializeVFS(tx: Transaction): VirtualFS {
  return {
    files: cloneFilesRecord(tx.virtualFiles),
    stateJson: cloneStatePlane(tx.snapshots.stateJson),
  };
}

export async function simulate(
  tx: Transaction,
  workUnits: WorkUnit[],
  enforcer: TransactionEnforcer,
  controlPlane: ControlPlane
): Promise<Transaction> {
  tx.status = "running";
  const orderedUnits = [...workUnits].sort((left, right) => left.id.localeCompare(right.id));
  const proposal = await enforcer.proposeFixes(orderedUnits);
  const fixes = [...proposal.fixes].sort((left, right) => left.id.localeCompare(right.id));
  const diagnostics = stableDiagnostics(proposal.diagnostics ?? []);
  const conflictResult = runConflictResolutionEngine({
    fixes,
    diagnostics,
    controlPlane,
  });

  const selectedFixes = [...conflictResult.selectedFixes].sort((left, right) => left.id.localeCompare(right.id));
  const patches = selectedFixes.flatMap((fix) => [...fix.patches]);
  const patchFiles = collectPatchFiles(patches);
  tx.touchedFiles = sortedUnique([...tx.touchedFiles, ...patchFiles]);
  tx.snapshotMissingFiles = sortedUnique([...tx.snapshotMissingFiles, ...patchFiles.filter((file) => tx.snapshots.files[file] === undefined)]);

  const applied = applyPatchesToFiles(tx.snapshots.files, patches);
  if (applied.errors.length > 0) {
    tx.validation = {
      passed: false,
      diagnostics,
      conflicts: stableConflicts(conflictResult.conflicts),
      invariantChecks: [],
      errors: applied.errors,
    };
    tx.status = "failed";
    throw new Error(applied.errors.join(" | "));
  }

  tx.proposedPatches = patches;
  tx.virtualFiles = cloneFilesRecord(applied.files);
  tx.validation = {
    ...tx.validation,
    diagnostics,
    conflicts: stableConflicts(conflictResult.conflicts),
  };

  return tx;
}

export async function validate(
  tx: Transaction,
  vfs: VirtualFS,
  pipeline: TransactionPipeline,
  options: {
    maxNewErrors?: number;
    typeCheck?: (vfs: VirtualFS) => Promise<TypeCheckResult>;
    controlPlane: ControlPlane;
    batch: ExecutionBatch;
  }
): Promise<Transaction> {
  const pipelineResult = await pipeline.run({
    fs: stableVirtualFS(vfs),
    controlPlane: options.controlPlane,
    batch: options.batch,
    transaction: tx,
  });

  const diagnostics = stableDiagnostics(pipelineResult.diagnostics);
  const conflicts = stableConflicts([...tx.validation.conflicts, ...pipelineResult.conflicts]);
  const invariantChecks = [
    checkNoNewErrors(tx, diagnostics, options.maxNewErrors ?? 0),
    checkASTValidity(vfs, tx.touchedFiles),
    await checkType(vfs, options.typeCheck),
    checkNoOverlap(tx.proposedPatches, tx.snapshots.files),
    checkPriority(conflicts),
    checkIdempotency(vfs, tx.proposedPatches),
  ];

  const passed = invariantChecks.every((check) => check.passed) && (pipelineResult.errors?.length ?? 0) === 0;
  tx.validation = {
    passed,
    diagnostics,
    conflicts,
    invariantChecks,
    ...(pipelineResult.errors && pipelineResult.errors.length > 0 ? { errors: [...pipelineResult.errors] } : {}),
  };
  tx.status = passed ? "validated" : "failed";
  return tx;
}

class CommitPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommitPreconditionError";
  }
}

export async function commit(
  tx: Transaction,
  txFs: TransactionFS,
  lock: TransactionFileLock = new FileSetLock()
): Promise<void> {
  if (tx.status !== "validated") {
    throw new Error("Cannot commit unvalidated transaction");
  }

  await lock.runExclusive(tx.touchedFiles, async () => {
    const currentFiles = await txFs.readFiles(tx.touchedFiles);
    if (!snapshotsMatch(tx, currentFiles)) {
      throw new CommitPreconditionError("Snapshot drift detected before commit");
    }

    await txFs.atomicWrite(buildCommitMutation(tx));
    await txFs.writeState(updateStateAfterCommit(tx));
  });

  tx.status = "committed";
}

export async function rollback(
  tx: Transaction,
  txFs: TransactionFS,
  options?: { restoreFiles?: boolean; restoreState?: boolean }
): Promise<void> {
  const restoreFiles = options?.restoreFiles ?? true;
  const restoreState = options?.restoreState ?? true;

  if (restoreFiles) {
    await txFs.atomicWrite(buildRollbackMutation(tx));
  }

  if (restoreState) {
    await txFs.writeState(cloneStatePlane(tx.snapshots.stateJson));
  }

  tx.status = "rolled-back";
}

async function executeBatchTransaction(
  batch: ExecutionBatch,
  txFs: TransactionFS,
  options: TransactionalExecutionOptions,
  lock: TransactionFileLock
): Promise<{ workUnitResults: WorkUnitRunResult[]; transaction: Transaction; trace: TransactionTrace }> {
  const startTime = Date.now();
  const tx = await prepareTransaction(batch, txFs);
  let rollbackReason: string | undefined;

  try {
    await simulate(tx, batch.workUnits, options.enforcer, options.controlPlane);
    recordPatchMutationTraces(options.root, "scheduler-simulate", tx.proposedPatches, tx.id);
    const vfs = materializeVFS(tx);
    await validate(tx, vfs, options.pipeline, {
      maxNewErrors: options.maxNewErrors,
      typeCheck: options.typeCheck,
      controlPlane: options.controlPlane,
      batch,
    });

    if (tx.validation.passed) {
      recordPatchMutationTraces(options.root, "scheduler-commit", tx.proposedPatches, tx.id);
      await commit(tx, txFs, lock);
    } else {
      rollbackReason = "validation-failed";
      await rollback(tx, txFs, { restoreFiles: false, restoreState: false });
    }
  } catch (error) {
    rollbackReason = error instanceof Error ? error.message : String(error);
    const safeRestore = !(error instanceof CommitPreconditionError);

    try {
      await rollback(tx, txFs, { restoreFiles: safeRestore, restoreState: safeRestore });
    } catch (rollbackError) {
      const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      rollbackReason = `${rollbackReason}; rollback failed: ${detail}`;
      tx.status = "failed";
    }
  }

  const workUnitResults = [...batch.workUnits]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((unit) => ({
      batchId: batch.id,
      workUnitId: unit.id,
      result: {
        transactionId: tx.id,
        status: tx.status,
        validationPassed: tx.validation.passed,
      },
    } satisfies WorkUnitRunResult));

  const trace: TransactionTrace = {
    transactionId: tx.id,
    batchId: batch.id,
    patchesProposed: tx.proposedPatches.length,
    patchesApplied: tx.status === "committed" ? tx.proposedPatches.length : 0,
    validationPassed: tx.validation.passed,
    ...(rollbackReason ? { rollbackReason } : {}),
    durationMs: Date.now() - startTime,
  };

  if (options.root) {
    recordAudit(options.root, {
      auditEvent: {
        id: "",
        timestamp: "",
        actor: {
          role: "conductor",
        },
        environment: detectEnvironment(),
        action: "execute-plan",
        resource: batch.id,
        result: tx.status === "committed" ? "success" : "failure",
        metadata: {
          transactionId: tx.id,
          batchId: batch.id,
          status: tx.status,
          rollbackReason: rollbackReason ?? null,
        },
      },
      decisionTrace: {
        policiesEvaluated: [],
        finalDecision: tx.status === "committed" ? "allow" : "deny",
        reasoning: tx.status === "committed"
          ? "Transactional execution committed successfully"
          : "Transactional execution failed or rolled back",
      },
      executionTrace: {
        planId: batch.id,
        patchesApplied: tx.status === "committed" ? tx.proposedPatches.length : 0,
        filesChanged: tx.status === "committed" ? tx.touchedFiles.length : 0,
      },
    });
  }

  return {
    workUnitResults,
    transaction: tx,
    trace,
  };
}

function groupBatchesByLayer(executionPlan: ExecutionPlan): ExecutionBatch[][] {
  const grouped = new Map<number, ExecutionBatch[]>();

  executionPlan.batches.forEach((batch, index) => {
    const layer = normalizeBatchLayer(batch.id, index + 1);
    const existing = grouped.get(layer) ?? [];
    existing.push(batch);
    grouped.set(layer, existing);
  });

  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, batches]) => [...batches].sort((left, right) => left.id.localeCompare(right.id)));
}

export async function runExecutionPlanTransactionally(
  executionPlan: ExecutionPlan,
  options: TransactionalExecutionOptions
): Promise<TransactionalExecutionResult> {
  const workspaceRoot = options.root ?? process.cwd();
  const auditRoot = options.root ?? (options.fs ? undefined : workspaceRoot);
  const effectiveTypeCheck = options.typeCheck ?? createDefaultCompilerTypeCheck(workspaceRoot);
  const txFs = options.fs ?? createNodeTransactionFS(workspaceRoot);
  const lock = options.fileLock ?? new FileSetLock();
  const batchesByLayer = groupBatchesByLayer(executionPlan);

  const executionOptions: TransactionalExecutionOptions = {
    ...options,
    ...(auditRoot ? { root: auditRoot } : {}),
    typeCheck: effectiveTypeCheck,
  };

  const workUnitResults: WorkUnitRunResult[] = [];
  const transactions: Transaction[] = [];
  const traces: TransactionTrace[] = [];

  for (const layer of batchesByLayer) {
    if (options.executeLayersInParallel) {
      const layerResults = await Promise.all(
        layer.map((batch) => executeBatchTransaction(batch, txFs, executionOptions, lock))
      );

      for (const result of layerResults.sort((left, right) => left.transaction.batchId.localeCompare(right.transaction.batchId))) {
        workUnitResults.push(...result.workUnitResults);
        transactions.push(result.transaction);
        traces.push(result.trace);
      }

      continue;
    }

    for (const batch of layer) {
      const result = await executeBatchTransaction(batch, txFs, executionOptions, lock);
      workUnitResults.push(...result.workUnitResults);
      transactions.push(result.transaction);
      traces.push(result.trace);
    }
  }

  return {
    workUnitResults,
    transactions,
    traces,
  };
}

function emptyValidationResult(errors?: string[]): ValidationResult {
  return {
    passed: false,
    diagnostics: [],
    conflicts: [],
    invariantChecks: [],
    ...(errors && errors.length > 0 ? { errors } : {}),
  };
}

function combineValidationResults(results: ValidationResult[]): ValidationResult {
  const passed = results.every((result) => result.passed);

  const diagnostics = stableDiagnostics(results.flatMap((result) => result.diagnostics));
  const conflicts = stableConflicts(results.flatMap((result) => result.conflicts));
  const invariantChecks = [...results.flatMap((result) => result.invariantChecks)];
  const errors = results.flatMap((result) => result.errors ?? []);

  return {
    passed,
    diagnostics,
    conflicts,
    invariantChecks,
    ...(errors.length > 0 ? { errors: sortedUnique(errors) } : {}),
  };
}

async function simulateBatch(
  batch: ExecutionBatch,
  txFs: TransactionFS,
  options: SimulationExecutionOptions
): Promise<{ result: BatchSimulationResult; trace: TransactionTrace }> {
  const startTime = Date.now();
  const tx = await prepareTransaction(batch, txFs);

  try {
    await simulate(tx, batch.workUnits, options.enforcer, options.controlPlane);
    const vfs = materializeVFS(tx);

    await validate(tx, vfs, options.pipeline, {
      maxNewErrors: options.maxNewErrors,
      typeCheck: options.typeCheck,
      controlPlane: options.controlPlane,
      batch,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tx.status = "failed";
    tx.validation = {
      ...emptyValidationResult([message]),
      diagnostics: tx.validation.diagnostics,
      conflicts: tx.validation.conflicts,
      invariantChecks: tx.validation.invariantChecks,
    };
  }

  const trace: TransactionTrace = {
    transactionId: tx.id,
    batchId: batch.id,
    patchesProposed: tx.proposedPatches.length,
    patchesApplied: 0,
    validationPassed: tx.validation.passed,
    ...(tx.validation.passed ? {} : { rollbackReason: "simulation-only" }),
    durationMs: Date.now() - startTime,
  };

  return {
    result: {
      batchId: batch.id,
      transaction: tx,
      validation: tx.validation,
      success: tx.validation.passed,
    },
    trace,
  };
}

async function runExecutionPlanSimulation(
  executionPlan: ExecutionPlan,
  options: SimulationExecutionOptions
): Promise<ExecutionSimulationResult> {
  const root = options.root ?? process.cwd();
  const effectiveTypeCheck = options.typeCheck ?? createDefaultCompilerTypeCheck(root);
  const txFs = options.fs ?? createNodeTransactionFS(options.root ?? process.cwd());
  const batchesByLayer = groupBatchesByLayer(executionPlan);

  const simulationOptions: SimulationExecutionOptions = {
    ...options,
    root,
    typeCheck: effectiveTypeCheck,
  };

  const results: BatchSimulationResult[] = [];
  const traces: TransactionTrace[] = [];

  for (const layer of batchesByLayer) {
    for (const batch of layer) {
      const simulated = await simulateBatch(batch, txFs, simulationOptions);
      results.push(simulated.result);
      traces.push(simulated.trace);
    }
  }

  const validation = combineValidationResults(results.map((result) => result.validation));

  return {
    results,
    validation,
    allPassed: results.every((result) => result.success),
    traces,
  };
}
