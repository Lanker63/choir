import { createHash } from "crypto";
import { Plan, Task } from "../schema.js";
import { SchedulerTrace } from "./types.js";

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
