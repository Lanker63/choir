import fs from "fs";
import path from "path";
import type { ControlPlane, Plan, Task } from "../schema.js";
import type { StatePlane } from "./state.js";
import { detectWorkspace } from "./workspaceDetection.js";
import { readLatestOrchestrationTrace } from "./orchestrationRuntimeTrace.js";
import { deriveRolloutBias, resolveStrategicContext } from "./strategicIntent.js";

export type DependencyGraph = {
  nodes: {
    id: string;
    type: "unit" | "file" | "module";
    label: string;
  }[];
  edges: {
    from: string;
    to: string;
    type: "depends-on";
  }[];
};

export type UIGraph = {
  nodes: {
    id: string;
    label: string;
    type: string;
    metadata: Record<string, unknown>;
  }[];
  edges: {
    id: string;
    source: string;
    target: string;
    label?: string;
  }[];
};

export type GraphMode = "full" | "focused" | "dependency" | "dependents";

export type PlanOverlay = {
  planId: string;
  steps: Array<{
    nodeId: string;
    order: number;
    taskId: string;
    title: string;
  }>;
};

export type GraphTrace = {
  sourceStateHash: string;
  nodesRendered: number;
  edgesRendered: number;
};

export type GraphHotspot = {
  nodeId: string;
  score: number;
  reasons: string[];
};

export type GraphSnapshot = {
  generatedAt: string;
  mode: GraphMode;
  focusNodeId?: string;
  graph: UIGraph;
  availableModes: GraphMode[];
  changedNodeIds: string[];
  affectedNodeIds: string[];
  violationNodeIds: string[];
  planOverlay?: PlanOverlay;
  candidateOrchestration?: {
    selectedCandidateId: string;
    selectedStrategyType: string;
    selectedDagHash: string;
    candidates: Array<{
      id: string;
      strategyType: string;
      dagHash: string;
      rank?: number;
      selected?: boolean;
    }>;
  };
  capabilityGraph?: {
    libraries: string[];
    dependencies: string[];
  };
  hotspots: GraphHotspot[];
  strategicOverlays?: {
    unitProfiles: Array<{
      nodeId: string;
      packageName?: string;
      status: "resolved" | "failed";
      domains: string[];
      governanceIntensity: "strict" | "moderate" | "relaxed";
      rolloutBias: "canary" | "phased" | "all-at-once";
      riskTolerance?: "low" | "moderate" | "high";
      reason?: "ambiguous-domain-resolution" | "missing-domain-resolution";
    }>;
  };
  trace: GraphTrace;
};

type WorkspaceUnit = {
  id: string;
  label: string;
  relPath: string;
  packageName?: string;
  dependencies: string[];
};

type UnitIndex = {
  byId: Map<string, WorkspaceUnit>;
  byPath: Map<string, WorkspaceUnit>;
};

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0))).sort((left, right) => left.localeCompare(right));
}

function normalizePath(value: string): string {
  const normalized = value.split("\\").join("/").replace(/^\.\//, "");
  return normalized.length === 0 ? "." : normalized;
}

function normalizeRelative(root: string, candidatePath: string): string {
  const absolute = path.resolve(root, candidatePath);
  const relative = normalizePath(path.relative(root, absolute));
  return relative === "" ? "." : relative;
}

function readPackageJson(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  return parsed as Record<string, unknown>;
}

function extractDependencyNames(pkg: Record<string, unknown> | null): string[] {
  if (!pkg) {
    return [];
  }

  const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const collected: string[] = [];

  for (const field of fields) {
    const value = pkg[field];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    for (const depName of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
      if (depName.trim().length > 0) {
        collected.push(depName.trim());
      }
    }
  }

  return sortedUnique(collected);
}

function packageLabel(relPath: string, packageName?: string): string {
  if (packageName && packageName.length > 0) {
    return packageName;
  }

  if (relPath === ".") {
    return "workspace-root";
  }

  const parts = relPath.split("/").filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] as string : relPath;
}

function buildWorkspaceUnits(root: string): WorkspaceUnit[] {
  const workspace = detectWorkspace(root);
  const unitPaths = workspace.packages.length > 0 ? workspace.packages : ["."];

  const preliminary = sortedUnique(unitPaths.map((entry) => normalizePath(entry))).map((relPath) => {
    const packageJsonPath = path.join(root, relPath, "package.json");
    const pkg = readPackageJson(packageJsonPath);
    const packageName = typeof pkg?.name === "string" && pkg.name.trim().length > 0
      ? pkg.name.trim()
      : undefined;

    return {
      relPath,
      packageName,
      dependencyNames: extractDependencyNames(pkg),
    };
  });

  const byPackageName = new Map<string, string>();
  for (const unit of preliminary) {
    if (!unit.packageName) {
      continue;
    }

    byPackageName.set(unit.packageName, unit.relPath);
  }

  const units = preliminary.map((unit) => {
    const dependencies = sortedUnique(
      unit.dependencyNames
        .map((dependencyName) => byPackageName.get(dependencyName))
        .filter((entry): entry is string => typeof entry === "string")
        .filter((entry) => entry !== unit.relPath)
    );

    return {
      id: `unit:${unit.relPath}`,
      label: packageLabel(unit.relPath, unit.packageName),
      relPath: unit.relPath,
      packageName: unit.packageName,
      dependencies,
    } satisfies WorkspaceUnit;
  });

  return units.sort((left, right) => left.id.localeCompare(right.id));
}

function buildDependencyGraph(units: WorkspaceUnit[]): DependencyGraph {
  const nodes = units.map((unit) => ({
    id: unit.id,
    type: "unit" as const,
    label: unit.label,
  }));

  const byPath = new Map(units.map((unit) => [unit.relPath, unit] as const));
  const edgeSet = new Set<string>();

  for (const unit of units) {
    for (const dependencyPath of unit.dependencies) {
      const dependency = byPath.get(dependencyPath);
      if (!dependency) {
        continue;
      }

      edgeSet.add(`${unit.id}->${dependency.id}`);
    }
  }

  const edges = [...edgeSet]
    .map((entry) => {
      const [from, to] = entry.split("->");
      return {
        from: from as string,
        to: to as string,
        type: "depends-on" as const,
      };
    })
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));

  return {
    nodes,
    edges,
  };
}

export function toUIGraph(graph: DependencyGraph): UIGraph {
  return {
    nodes: [...graph.nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => ({
        id: node.id,
        label: node.label,
        type: node.type,
        metadata: {},
      })),
    edges: [...graph.edges]
      .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to))
      .map((edge) => ({
        id: `edge:${edge.from}->${edge.to}`,
        source: edge.from,
        target: edge.to,
        label: edge.type,
      })),
  };
}

function buildUnitIndex(units: WorkspaceUnit[]): UnitIndex {
  return {
    byId: new Map(units.map((unit) => [unit.id, unit] as const)),
    byPath: new Map(units.map((unit) => [unit.relPath, unit] as const)),
  };
}

function mapFileToUnitId(root: string, filePath: string, unitIndex: UnitIndex): string | undefined {
  const relative = normalizeRelative(root, filePath);
  const candidates = [...unitIndex.byPath.values()]
    .sort((left, right) => right.relPath.length - left.relPath.length || left.relPath.localeCompare(right.relPath));

  for (const unit of candidates) {
    if (unit.relPath === ".") {
      continue;
    }

    if (relative === unit.relPath || relative.startsWith(`${unit.relPath}/`)) {
      return unit.id;
    }
  }

  const rootUnit = unitIndex.byPath.get(".");
  if (rootUnit) {
    return rootUnit.id;
  }

  return candidates[0]?.id;
}

function orderedTasks(plan: Plan): Task[] {
  const byId = new Map(plan.tasks.map((task) => [task.id, task] as const));
  const indegree = new Map<string, number>(plan.tasks.map((task) => [task.id, 0] as const));
  const outgoing = new Map<string, string[]>(plan.tasks.map((task) => [task.id, []] as const));

  for (const task of plan.tasks) {
    const dependencies = sortedUnique(task.dependsOn ?? []);
    indegree.set(task.id, dependencies.length);
    for (const dep of dependencies) {
      if (!byId.has(dep)) {
        continue;
      }

      const existing = outgoing.get(dep) ?? [];
      existing.push(task.id);
      outgoing.set(dep, sortedUnique(existing));
    }
  }

  const queue = [...indegree.entries()]
    .filter(([, value]) => value === 0)
    .map(([taskId]) => taskId)
    .sort((left, right) => left.localeCompare(right));
  const ordered: string[] = [];
  let queueIndex = 0;

  const enqueueSorted = (taskId: string): void => {
    let insertAt = queue.length;
    for (let index = queueIndex; index < queue.length; index += 1) {
      if (taskId.localeCompare(queue[index] as string) < 0) {
        insertAt = index;
        break;
      }
    }

    queue.splice(insertAt, 0, taskId);
  };

  while (queueIndex < queue.length) {
    const taskId = queue[queueIndex] as string;
    queueIndex += 1;
    ordered.push(taskId);

    for (const next of outgoing.get(taskId) ?? []) {
      const nextValue = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, nextValue);
      if (nextValue === 0) {
        enqueueSorted(next);
      }
    }
  }

  if (ordered.length !== plan.tasks.length) {
    return [...plan.tasks].sort((left, right) => left.id.localeCompare(right.id));
  }

  return ordered
    .map((taskId) => byId.get(taskId))
    .filter((task): task is Task => Boolean(task));
}

function resolvePlanOverlay(
  root: string,
  control: ControlPlane,
  state: StatePlane,
  unitIndex: UnitIndex
): PlanOverlay | undefined {
  const plans = [...control.execution.plans].sort((left, right) => left.id.localeCompare(right.id));
  if (plans.length === 0) {
    return undefined;
  }

  const selectedPlan = plans.find((plan) => plan.id === state.execution.activePlanId)
    ?? plans.find((plan) => plan.status === "approved")
    ?? plans[0];

  const steps: PlanOverlay["steps"] = [];
  const tasks = orderedTasks(selectedPlan);
  let order = 1;

  for (const task of tasks) {
    const scopedFiles = sortedUnique(task.scope?.files ?? []);
    const mappedNodeIds = sortedUnique(
      scopedFiles
        .map((filePath) => mapFileToUnitId(root, filePath, unitIndex))
        .filter((entry): entry is string => typeof entry === "string")
    );

    const nodeId = mappedNodeIds[0]
      ?? unitIndex.byPath.get(".")?.id
      ?? [...unitIndex.byId.keys()].sort((left, right) => left.localeCompare(right))[0];

    if (!nodeId) {
      continue;
    }

    steps.push({
      nodeId,
      order,
      taskId: task.id,
      title: task.title,
    });
    order += 1;
  }

  if (steps.length === 0) {
    return undefined;
  }

  return {
    planId: selectedPlan.id,
    steps,
  };
}

function nodeSetsFromOverlay(
  root: string,
  control: ControlPlane,
  state: StatePlane,
  unitIndex: UnitIndex,
  overlay: PlanOverlay | undefined
): { changedNodeIds: string[]; affectedNodeIds: string[] } {
  const affectedNodeIds = sortedUnique((overlay?.steps ?? []).map((step) => step.nodeId));
  if (!overlay) {
    return {
      changedNodeIds: [],
      affectedNodeIds,
    };
  }

  const plan = control.execution.plans.find((entry) => entry.id === overlay.planId);
  const taskById = new Map((plan?.tasks ?? []).map((task) => [task.id, task] as const));
  const changedNodeIds = new Set<string>();

  for (const [executionKey, status] of Object.entries(state.execution.taskStatus)) {
    if (status !== "complete" && status !== "in-progress" && status !== "failed") {
      continue;
    }

    const [, taskId] = executionKey.split(":", 2);
    const task = taskById.get(taskId);
    if (!task) {
      continue;
    }

    const files = sortedUnique(task.scope?.files ?? []);
    const mapped = files
      .map((filePath) => mapFileToUnitId(root, filePath, unitIndex))
      .filter((entry): entry is string => typeof entry === "string");

    if (mapped.length === 0) {
      const overlayStep = overlay.steps.find((entry) => entry.taskId === taskId);
      if (overlayStep) {
        changedNodeIds.add(overlayStep.nodeId);
      }
      continue;
    }

    for (const nodeId of mapped) {
      changedNodeIds.add(nodeId);
    }
  }

  return {
    changedNodeIds: sortedUnique([...changedNodeIds]),
    affectedNodeIds,
  };
}

function resolveViolationNodeIds(root: string, state: StatePlane, unitIndex: UnitIndex): string[] {
  const byNode = new Set<string>();

  for (const diagnostic of state.violations) {
    const nodeId = mapFileToUnitId(root, diagnostic.location.file, unitIndex);
    if (nodeId) {
      byNode.add(nodeId);
    }
  }

  return sortedUnique([...byNode]);
}

function calculateHotspots(
  uiGraph: UIGraph,
  affectedNodeIds: string[],
  violationNodeIds: string[]
): GraphHotspot[] {
  const inDegree = new Map<string, number>(uiGraph.nodes.map((node) => [node.id, 0] as const));
  const outDegree = new Map<string, number>(uiGraph.nodes.map((node) => [node.id, 0] as const));

  for (const edge of uiGraph.edges) {
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const affectedSet = new Set(affectedNodeIds);
  const violationSet = new Set(violationNodeIds);

  const hotspots = uiGraph.nodes
    .map((node) => {
      const indeg = inDegree.get(node.id) ?? 0;
      const outdeg = outDegree.get(node.id) ?? 0;
      const affected = affectedSet.has(node.id);
      const violated = violationSet.has(node.id);
      const score = indeg + outdeg + (affected ? 2 : 0) + (violated ? 4 : 0);
      const reasons: string[] = [];

      if (indeg + outdeg > 0) {
        reasons.push(`degree:${indeg + outdeg}`);
      }
      if (affected) {
        reasons.push("plan-impact");
      }
      if (violated) {
        reasons.push("policy-violation");
      }

      return {
        nodeId: node.id,
        score,
        reasons,
      } satisfies GraphHotspot;
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId));

  return hotspots.slice(0, 12);
}

function nodeReachability(
  graph: UIGraph,
  focusNodeId: string,
  direction: "out" | "in"
): Set<string> {
  const adjacency = new Map<string, string[]>(graph.nodes.map((node) => [node.id, []] as const));
  for (const edge of graph.edges) {
    const from = direction === "out" ? edge.source : edge.target;
    const to = direction === "out" ? edge.target : edge.source;
    const existing = adjacency.get(from) ?? [];
    existing.push(to);
    adjacency.set(from, sortedUnique(existing));
  }

  const visited = new Set<string>();
  const queue = [focusNodeId];
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const current = queue[queueIndex] as string;
    queueIndex += 1;
    if (visited.has(current)) {
      continue;
    }

    visited.add(current);
    const next = adjacency.get(current) ?? [];
    for (const nodeId of next) {
      if (!visited.has(nodeId)) {
        queue.push(nodeId);
      }
    }
  }

  return visited;
}

function projectGraphMode(graph: UIGraph, mode: GraphMode, focusNodeId?: string): UIGraph {
  if (mode === "full" || !focusNodeId || !graph.nodes.some((node) => node.id === focusNodeId)) {
    return graph;
  }

  const include = new Set<string>([focusNodeId]);

  if (mode === "focused") {
    for (const edge of graph.edges) {
      if (edge.source === focusNodeId) {
        include.add(edge.target);
      }
      if (edge.target === focusNodeId) {
        include.add(edge.source);
      }
    }
  }

  if (mode === "dependency") {
    for (const nodeId of nodeReachability(graph, focusNodeId, "out")) {
      include.add(nodeId);
    }
  }

  if (mode === "dependents") {
    for (const nodeId of nodeReachability(graph, focusNodeId, "in")) {
      include.add(nodeId);
    }
  }

  const nodes = graph.nodes.filter((node) => include.has(node.id));
  const nodeSet = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => nodeSet.has(edge.source) && nodeSet.has(edge.target));

  return {
    nodes,
    edges,
  };
}

function resolveFocusNodeId(graph: UIGraph, focusNodeId: string | undefined): string | undefined {
  if (!focusNodeId || focusNodeId.trim().length === 0) {
    return undefined;
  }

  if (graph.nodes.some((node) => node.id === focusNodeId)) {
    return focusNodeId;
  }

  const needle = focusNodeId.trim().toLowerCase();
  const matched = graph.nodes.find((node) => {
    const relPath = typeof node.metadata.relPath === "string" ? node.metadata.relPath.toLowerCase() : "";
    const packageName = typeof node.metadata.packageName === "string" ? node.metadata.packageName.toLowerCase() : "";
    return node.label.toLowerCase() === needle || relPath === needle || packageName === needle;
  });

  return matched?.id;
}

function readCapabilityGraph(root: string): {
  libraries: Array<{ id: string; version: string; selector: string }>;
  dependencies: Array<{ from: string; to: string }>;
} {
  const filePath = path.join(root, ".choir", "capability-graph.json");
  if (!fs.existsSync(filePath)) {
    return {
      libraries: [],
      dependencies: [],
    };
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
    libraries?: Array<{ id?: string; version?: string; selector?: string }>;
    dependencies?: Array<{ from?: string; to?: string; type?: string }>;
  };

  const libraries = (parsed.libraries ?? [])
    .filter((entry) => typeof entry.id === "string" && typeof entry.version === "string" && typeof entry.selector === "string")
    .map((entry) => ({
      id: entry.id as string,
      version: entry.version as string,
      selector: entry.selector as string,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const dependencies = (parsed.dependencies ?? [])
    .filter((entry) => entry.type === "depends-on" && typeof entry.from === "string" && typeof entry.to === "string")
    .map((entry) => ({
      from: entry.from as string,
      to: entry.to as string,
    }))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));

  return {
    libraries,
    dependencies,
  };
}

export function buildGraphSnapshot(input: {
  root: string;
  control: ControlPlane;
  state: StatePlane;
  mode: GraphMode;
  focusNodeId?: string;
}): GraphSnapshot {
  const units = buildWorkspaceUnits(input.root);
  const unitIndex = buildUnitIndex(units);
  const strategicByUnit = new Map<string, ReturnType<typeof resolveStrategicContext>>(
    units.map((unit) => [
      unit.id,
      resolveStrategicContext({
        controlPlane: input.control,
        packageNames: [unit.relPath],
        unitId: unit.id,
      }),
    ] as const)
  );
  const dependencyGraph = buildDependencyGraph(units);
  const uiGraph = toUIGraph(dependencyGraph);

  const enrichedGraph: UIGraph = {
    nodes: uiGraph.nodes.map((node) => {
      const unit = unitIndex.byId.get(node.id);
      return {
        ...node,
        metadata: {
          ...(unit
            ? {
              relPath: unit.relPath,
              packageName: unit.packageName,
              packageJsonPath: unit.relPath === "." ? "package.json" : `${unit.relPath}/package.json`,
            }
            : {}),
          ...(unit
            ? {
              strategic: (() => {
                const resolved = strategicByUnit.get(unit.id);
                if (!resolved) {
                  return {
                    status: "failed",
                    reason: "missing-domain-resolution",
                    domains: [],
                  };
                }

                if (resolved.status !== "resolved") {
                  return {
                    status: resolved.status,
                    reason: resolved.reason,
                    domains: resolved.domains,
                  };
                }

                const rolloutBias = deriveRolloutBias(resolved.intent);
                return {
                  status: resolved.status,
                  domains: resolved.domains,
                  governanceIntensity: resolved.intent.governanceIntensity,
                  riskTolerance: resolved.intent.riskTolerance,
                  rolloutBias: rolloutBias.preferred,
                };
              })(),
            }
            : {}),
        },
      };
    }),
    edges: uiGraph.edges,
  };

  const overlay = resolvePlanOverlay(input.root, input.control, input.state, unitIndex);
  const capabilityGraph = readCapabilityGraph(input.root);

  const capabilityNodes = capabilityGraph.libraries.map((entry) => ({
    id: `lib:${entry.id}`,
    label: `${entry.id}@${entry.version}`,
    type: "library",
    metadata: {
      selector: entry.selector,
      origin: "capability-library",
    },
  }));

  const capabilityEdges = capabilityGraph.dependencies.map((entry) => ({
    id: `edge:lib:${entry.from}->lib:${entry.to}`,
    source: `lib:${entry.from}`,
    target: `lib:${entry.to}`,
    label: "library-depends-on",
  }));

  const mergedGraph: UIGraph = {
    nodes: [...enrichedGraph.nodes, ...capabilityNodes].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...enrichedGraph.edges, ...capabilityEdges].sort((left, right) => left.id.localeCompare(right.id)),
  };

  const overlaySet = nodeSetsFromOverlay(input.root, input.control, input.state, unitIndex, overlay);
  const violationNodeIds = resolveViolationNodeIds(input.root, input.state, unitIndex);
  const resolvedFocusNodeId = resolveFocusNodeId(mergedGraph, input.focusNodeId);
  const projectedGraph = projectGraphMode(mergedGraph, input.mode, resolvedFocusNodeId);
  const projectedNodeIds = new Set(projectedGraph.nodes.map((node) => node.id));

  const changedNodeIds = overlaySet.changedNodeIds.filter((nodeId) => projectedNodeIds.has(nodeId));
  const affectedNodeIds = overlaySet.affectedNodeIds.filter((nodeId) => projectedNodeIds.has(nodeId));
  const filteredViolationNodeIds = violationNodeIds.filter((nodeId) => projectedNodeIds.has(nodeId));
  const hotspots = calculateHotspots(projectedGraph, affectedNodeIds, filteredViolationNodeIds);
  const orchestrationTrace = readLatestOrchestrationTrace(input.root);
  const strategicProfiles = units.map((unit) => {
    const resolved = strategicByUnit.get(unit.id);
    if (!resolved || resolved.status !== "resolved") {
      return {
        nodeId: unit.id,
        packageName: unit.packageName,
        status: "failed" as const,
        domains: resolved?.domains ?? [],
        governanceIntensity: "moderate" as const,
        rolloutBias: "all-at-once" as const,
        ...(resolved?.reason ? { reason: resolved.reason } : {}),
      };
    }

    const rolloutBias = deriveRolloutBias(resolved.intent);
    return {
      nodeId: unit.id,
      packageName: unit.packageName,
      status: "resolved" as const,
      domains: resolved.domains,
      governanceIntensity: resolved.intent.governanceIntensity,
      rolloutBias: rolloutBias.preferred,
      riskTolerance: resolved.intent.riskTolerance,
    };
  }).sort((left, right) => left.nodeId.localeCompare(right.nodeId));

  return {
    generatedAt: new Date().toISOString(),
    mode: input.mode,
    ...(resolvedFocusNodeId ? { focusNodeId: resolvedFocusNodeId } : {}),
    graph: projectedGraph,
    availableModes: ["full", "focused", "dependency", "dependents"],
    changedNodeIds,
    affectedNodeIds,
    violationNodeIds: filteredViolationNodeIds,
    ...(overlay
      ? {
        planOverlay: {
          planId: overlay.planId,
          steps: overlay.steps.filter((step) => projectedNodeIds.has(step.nodeId)),
        },
      }
      : {}),
    ...(orchestrationTrace
      ? {
        candidateOrchestration: {
          selectedCandidateId: orchestrationTrace.selectedPlanId,
          selectedStrategyType: orchestrationTrace.selectedStrategyType,
          selectedDagHash: orchestrationTrace.orchestrationDagHash,
          candidates: orchestrationTrace.candidates.map((candidate) => ({
            id: candidate.id,
            strategyType: candidate.strategyType,
            dagHash: candidate.orchestrationDagHash,
            ...(typeof candidate.rank === "number" ? { rank: candidate.rank } : {}),
            ...(candidate.selected === true ? { selected: true } : {}),
          })),
        },
      }
      : {}),
    ...(capabilityGraph.libraries.length > 0
      ? {
        capabilityGraph: {
          libraries: capabilityGraph.libraries.map((entry) => `${entry.id}@${entry.version} (${entry.selector})`),
          dependencies: capabilityGraph.dependencies.map((entry) => `${entry.from} -> ${entry.to}`),
        },
      }
      : {}),
    strategicOverlays: {
      unitProfiles: strategicProfiles,
    },
    hotspots,
    trace: {
      sourceStateHash: input.state.stateHash,
      nodesRendered: projectedGraph.nodes.length,
      edgesRendered: projectedGraph.edges.length,
    },
  };
}