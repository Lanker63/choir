import { createHash } from "crypto";
import { SystemState } from "./distributedSync.js";

export type RepoTask = {
  id: string;
  action: string;
  dependsOn: string[];
};

export type Repo = {
  id: string;
  state: SystemState;
  dependencies: string[];
  tasks?: RepoTask[];
  teamId?: string;
  environment?: string;
};

export type GlobalDependencyNode = {
  repoId: string;
  taskId: string;
};

export type GlobalDependencyEdge = {
  from: string;
  to: string;
};

export type GlobalDependencyGraph = {
  nodes: GlobalDependencyNode[];
  edges: GlobalDependencyEdge[];
};

export type GlobalPlanTask = {
  id: string;
  repoId: string;
  action: string;
  dependsOn: string[];
};

export type GlobalPlan = {
  id: string;
  tasks: GlobalPlanTask[];
};

export type ExecutionOrder = {
  orderedTaskIds: string[];
  tasks: GlobalPlanTask[];
};

export type TaskBatch = {
  id: string;
  taskIds: string[];
  tasks: GlobalPlanTask[];
};

export type PolicySourceLayer = "org" | "team" | "repo" | "environment";
export type PolicyEffect = "allow" | "require-approval" | "deny";

export type GlobalPolicyRule =
  | {
    id: string;
    kind: "deny-action-prefix";
    effect: PolicyEffect;
    actionPrefix: string;
    repoIds?: string[];
  }
  | {
    id: string;
    kind: "require-repo-action-prefix";
    effect: PolicyEffect;
    actionPrefix: string;
    repoIds?: string[];
  }
  | {
    id: string;
    kind: "cross-repo-action-compatibility";
    effect: PolicyEffect;
    upstreamPrefix: string;
    downstreamPrefix: string;
  }
  | {
    id: string;
    kind: "require-state-path";
    effect: PolicyEffect;
    path: string;
    repoIds?: string[];
  };

export type OrgPolicy = {
  id: string;
  rules: GlobalPolicyRule[];
};

export type CompiledPolicy = {
  id: string;
  source: PolicySourceLayer;
  rules: GlobalPolicyRule[];
};

export type PolicyPropagation = {
  source: "org";
  targets: string[];
  rules: GlobalPolicyRule[];
};

export type PolicyDistribution = {
  propagation: PolicyPropagation;
  byRepo: Record<string, CompiledPolicy[]>;
};

export type PolicyResult = {
  allowed: boolean;
  requiresApproval: boolean;
  violations: string[];
  policyDecisions: string[];
  appliedPolicyIds: string[];
};

export type PlanValidationResult = {
  valid: boolean;
  errors: string[];
};

export type DriftResult = {
  repoId: string;
  driftDetected: boolean;
  violations: string[];
};

export type GlobalAudit = {
  planId: string;
  reposInvolved: string[];
  policiesApplied: string[];
  violations: string[];
};

export type GlobalTrace = {
  plan: GlobalPlan;
  executionOrder: string[];
  policyDecisions: string[];
  convergence: boolean;
};

export type GlobalContext = {
  repos: Repo[];
  policies: CompiledPolicy[];
  graph: GlobalDependencyGraph;
};

export type GlobalPlanningCache = {
  graphByKey: Map<string, GlobalDependencyGraph>;
  planByKey: Map<string, GlobalPlan>;
};

export type ExecuteGlobalPlanOptions = {
  repos: Repo[];
  policies: CompiledPolicy[];
  validateState?: (state: SystemState, repoId: string) => boolean;
  executeTask?: (task: GlobalPlanTask, repoState: SystemState, repoId: string, allStates: Record<string, SystemState>) => Promise<SystemState>;
};

export type GlobalExecutionResult = {
  success: boolean;
  rolledBack: boolean;
  finalStates: Record<string, SystemState>;
  audit: GlobalAudit;
  trace: GlobalTrace;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (typeof value === "undefined") {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function normalizeTaskId(value: string): string {
  return value.trim();
}

function globalTaskId(repoId: string, taskId: string): string {
  return `${repoId}:${taskId}`;
}

function normalizeRepo(repo: Repo): Repo {
  const id = repo.id.trim();
  const dependencies = sortedUnique((repo.dependencies ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0));
  const tasks = (repo.tasks ?? [])
    .map((task) => ({
      id: normalizeTaskId(task.id),
      action: task.action.trim(),
      dependsOn: sortedUnique((task.dependsOn ?? []).map((entry) => normalizeTaskId(entry)).filter((entry) => entry.length > 0)),
    }))
    .filter((task) => task.id.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    ...repo,
    id,
    dependencies,
    state: cloneUnknown(repo.state),
    ...(tasks.length > 0 ? { tasks } : {}),
  };
}

function getAtPath(state: SystemState, path: string): { exists: boolean; value: unknown } {
  const segments = path.split(".").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
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

function hashId(prefix: string, payload: unknown): string {
  const digest = createHash("sha256").update(stableStringify(payload), "utf-8").digest("hex").slice(0, 12);
  return `${prefix}-${digest}`;
}

function ensureNoRepoCycles(repos: Repo[]): void {
  const byRepoId = new Map(repos.map((repo) => [repo.id, repo] as const));
  const visited = new Set<string>();
  const active = new Set<string>();

  function visit(repoId: string): void {
    if (active.has(repoId)) {
      throw new Error(`Global dependency cycle detected across repositories at ${repoId}`);
    }

    if (visited.has(repoId)) {
      return;
    }

    visited.add(repoId);
    active.add(repoId);

    const repo = byRepoId.get(repoId);
    const deps = repo?.dependencies ?? [];

    for (const dep of deps) {
      if (!byRepoId.has(dep)) {
        throw new Error(`Missing referenced repository dependency: ${dep}`);
      }
      visit(dep);
    }

    active.delete(repoId);
  }

  for (const repo of [...repos].sort((left, right) => left.id.localeCompare(right.id))) {
    visit(repo.id);
  }
}

function extractRepoTasks(repo: Repo): RepoTask[] {
  if (repo.tasks && repo.tasks.length > 0) {
    return repo.tasks;
  }

  const statePlans = Array.isArray((repo.state as Record<string, unknown>).plans)
    ? (repo.state as Record<string, unknown>).plans as Array<Record<string, unknown>>
    : [];

  const taskIds = statePlans
    .flatMap((plan) => Array.isArray(plan.taskIds) ? plan.taskIds : [])
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());

  if (taskIds.length === 0) {
    return [{
      id: "t-sync",
      action: "synchronize-repo-state",
      dependsOn: [],
    }];
  }

  const ordered = sortedUnique(taskIds);
  return ordered.map((taskId, index) => ({
    id: taskId,
    action: `execute:${taskId}`,
    dependsOn: index > 0 ? [ordered[index - 1] as string] : [],
  }));
}

function taskRoots(tasks: RepoTask[]): RepoTask[] {
  return tasks.filter((task) => task.dependsOn.length === 0).sort((left, right) => left.id.localeCompare(right.id));
}

function taskLeaves(tasks: RepoTask[]): RepoTask[] {
  const incoming = new Set(tasks.flatMap((task) => task.dependsOn));
  return tasks.filter((task) => !incoming.has(task.id)).sort((left, right) => left.id.localeCompare(right.id));
}

export function buildGlobalDependencyGraph(repos: Repo[], cache?: GlobalPlanningCache): GlobalDependencyGraph {
  const normalizedRepos = repos.map((repo) => normalizeRepo(repo)).sort((left, right) => left.id.localeCompare(right.id));
  const signature = hashId("graph", normalizedRepos.map((repo) => ({
    id: repo.id,
    dependencies: repo.dependencies,
    taskIds: extractRepoTasks(repo).map((task) => task.id),
  })));

  const cached = cache?.graphByKey.get(signature);
  if (cached) {
    return cloneUnknown(cached);
  }

  ensureNoRepoCycles(normalizedRepos);

  const repoTaskMap = new Map(normalizedRepos.map((repo) => [repo.id, extractRepoTasks(repo)] as const));
  const nodes: GlobalDependencyNode[] = [];
  const edgeSet = new Set<string>();

  for (const repo of normalizedRepos) {
    const tasks = repoTaskMap.get(repo.id) ?? [];
    const taskIdSet = new Set(tasks.map((task) => task.id));

    for (const task of tasks) {
      nodes.push({ repoId: repo.id, taskId: task.id });

      for (const localDep of task.dependsOn) {
        if (!taskIdSet.has(localDep)) {
          throw new Error(`Missing local task dependency ${repo.id}:${localDep}`);
        }

        const from = globalTaskId(repo.id, localDep);
        const to = globalTaskId(repo.id, task.id);
        edgeSet.add(`${from}->${to}`);
      }
    }
  }

  for (const repo of normalizedRepos) {
    const currentTasks = repoTaskMap.get(repo.id) ?? [];
    const currentRoots = taskRoots(currentTasks);

    for (const depRepoId of repo.dependencies) {
      const depTasks = repoTaskMap.get(depRepoId) ?? [];
      const depLeaves = taskLeaves(depTasks);

      for (const fromTask of depLeaves) {
        for (const toTask of currentRoots) {
          const from = globalTaskId(depRepoId, fromTask.id);
          const to = globalTaskId(repo.id, toTask.id);
          edgeSet.add(`${from}->${to}`);
        }
      }
    }
  }

  const edges = [...edgeSet]
    .map((entry) => {
      const [from, to] = entry.split("->");
      return {
        from,
        to,
      } satisfies GlobalDependencyEdge;
    })
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));

  const graph: GlobalDependencyGraph = {
    nodes: nodes.sort((left, right) =>
      left.repoId.localeCompare(right.repoId)
      || left.taskId.localeCompare(right.taskId)
    ),
    edges,
  };

  cache?.graphByKey.set(signature, cloneUnknown(graph));
  return graph;
}

function graphCycleError(nodes: string[], edges: GlobalDependencyEdge[]): string | null {
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node, []] as const));
  for (const edge of edges) {
    const current = outgoing.get(edge.from) ?? [];
    current.push(edge.to);
    outgoing.set(edge.from, current.sort((left, right) => left.localeCompare(right)));
  }

  const visited = new Set<string>();
  const active = new Set<string>();

  function visit(node: string): string | null {
    if (active.has(node)) {
      return node;
    }
    if (visited.has(node)) {
      return null;
    }

    visited.add(node);
    active.add(node);
    const targets = outgoing.get(node) ?? [];
    for (const next of targets) {
      const cycle = visit(next);
      if (cycle) {
        return cycle;
      }
    }
    active.delete(node);
    return null;
  }

  for (const node of [...nodes].sort((left, right) => left.localeCompare(right))) {
    const cycle = visit(node);
    if (cycle) {
      return `Cycle detected in global plan graph at ${cycle}`;
    }
  }

  return null;
}

export function validateGlobalPlan(plan: GlobalPlan): PlanValidationResult {
  const taskIds = plan.tasks.map((task) => task.id);
  const taskSet = new Set(taskIds);
  const errors: string[] = [];

  if (taskSet.size !== taskIds.length) {
    errors.push("Duplicate global task ids detected");
  }

  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!taskSet.has(dep)) {
        errors.push(`Missing dependency ${dep} for task ${task.id}`);
      }
    }
  }

  const parsedActions = new Map<string, Map<string, Set<string>>>();
  for (const task of plan.tasks) {
    const [verbRaw, ...rest] = task.action.split(":");
    const verb = verbRaw.trim().toLowerCase();
    const target = rest.join(":").trim().toLowerCase();
    if (target.length === 0) {
      continue;
    }

    const repoMap = parsedActions.get(task.repoId) ?? new Map<string, Set<string>>();
    const verbs = repoMap.get(target) ?? new Set<string>();
    verbs.add(verb);
    repoMap.set(target, verbs);
    parsedActions.set(task.repoId, repoMap);
  }

  const conflicts: Array<[string, string[]]> = [];
  const oppositePairs: Array<[string, string]> = [
    ["add", "remove"],
    ["enable", "disable"],
    ["grant", "revoke"],
  ];

  for (const [repoId, targetMap] of parsedActions.entries()) {
    for (const [target, verbs] of targetMap.entries()) {
      for (const [a, b] of oppositePairs) {
        if (verbs.has(a) && verbs.has(b)) {
          conflicts.push([`${repoId}:${target}`, [a, b]]);
        }
      }
    }
  }

  for (const [target, verbs] of conflicts.sort((left, right) => left[0].localeCompare(right[0]))) {
    errors.push(`Conflicting actions for ${target}: ${verbs.join(" vs ")}`);
  }

  const cycle = graphCycleError(
    [...taskSet].sort((left, right) => left.localeCompare(right)),
    plan.tasks.flatMap((task) => task.dependsOn.map((dep) => ({ from: dep, to: task.id })))
  );
  if (cycle) {
    errors.push(cycle);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function topologicalLayers(plan: GlobalPlan): string[][] {
  const taskById = new Map(plan.tasks.map((task) => [task.id, task] as const));
  const indegree = new Map<string, number>(plan.tasks.map((task) => [task.id, task.dependsOn.length]));
  const outgoing = new Map<string, string[]>(plan.tasks.map((task) => [task.id, []]));

  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      const existing = outgoing.get(dep) ?? [];
      existing.push(task.id);
      outgoing.set(dep, existing);
    }
  }

  for (const [taskId, edges] of outgoing.entries()) {
    outgoing.set(taskId, edges.sort((left, right) => left.localeCompare(right)));
  }

  const remaining = new Set(plan.tasks.map((task) => task.id));
  const layers: string[][] = [];

  while (remaining.size > 0) {
    const layer = [...remaining]
      .filter((taskId) => (indegree.get(taskId) ?? 0) === 0)
      .sort((left, right) => left.localeCompare(right));

    if (layer.length === 0) {
      throw new Error("Cycle detected in global plan");
    }

    for (const taskId of layer) {
      remaining.delete(taskId);
      const next = outgoing.get(taskId) ?? [];
      for (const target of next) {
        indegree.set(target, (indegree.get(target) ?? 0) - 1);
      }
    }

    layers.push(layer);
  }

  if (layers.flat().length !== taskById.size) {
    throw new Error("Topological ordering failed to include all tasks");
  }

  return layers;
}

export function orderPlan(plan: GlobalPlan): ExecutionOrder {
  const validation = validateGlobalPlan(plan);
  if (!validation.valid) {
    throw new Error(`Global plan validation failed: ${validation.errors.join("; ")}`);
  }

  const layers = topologicalLayers(plan);
  const orderedTaskIds = layers.flat();
  const taskMap = new Map(plan.tasks.map((task) => [task.id, task] as const));

  return {
    orderedTaskIds,
    tasks: orderedTaskIds.map((taskId) => taskMap.get(taskId)).filter((task): task is GlobalPlanTask => Boolean(task)),
  };
}

export function batchTasks(plan: GlobalPlan): TaskBatch[] {
  const layers = topologicalLayers(plan);
  const taskMap = new Map(plan.tasks.map((task) => [task.id, task] as const));

  return layers.map((layer, index) => ({
    id: `batch-${String(index + 1).padStart(2, "0")}`,
    taskIds: [...layer],
    tasks: layer.map((taskId) => taskMap.get(taskId)).filter((task): task is GlobalPlanTask => Boolean(task)),
  }));
}

function flattenPolicies(policies: CompiledPolicy[]): GlobalPolicyRule[] {
  return policies
    .flatMap((policy) => policy.rules)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function taskMapByRepo(plan: GlobalPlan): Map<string, GlobalPlanTask[]> {
  const map = new Map<string, GlobalPlanTask[]>();
  for (const task of plan.tasks) {
    const existing = map.get(task.repoId) ?? [];
    existing.push(task);
    map.set(task.repoId, existing);
  }

  for (const [repoId, tasks] of map.entries()) {
    map.set(repoId, tasks.sort((left, right) => left.id.localeCompare(right.id)));
  }

  return map;
}

function repoSetFromRule(rule: GlobalPolicyRule): Set<string> | null {
  if ("repoIds" in rule && Array.isArray(rule.repoIds) && rule.repoIds.length > 0) {
    return new Set(sortedUnique(rule.repoIds));
  }

  return null;
}

function evaluateRule(
  rule: GlobalPolicyRule,
  plan: GlobalPlan,
  repos: Repo[],
  byRepo: Map<string, GlobalPlanTask[]>
): string[] {
  const scopedRepos = repoSetFromRule(rule);
  const violations: string[] = [];

  if (rule.kind === "deny-action-prefix") {
    for (const task of plan.tasks) {
      if (scopedRepos && !scopedRepos.has(task.repoId)) {
        continue;
      }

      if (task.action.startsWith(rule.actionPrefix)) {
        violations.push(`Rule ${rule.id}: denied action prefix '${rule.actionPrefix}' on ${task.id}`);
      }
    }
    return violations;
  }

  if (rule.kind === "require-repo-action-prefix") {
    const repoIds = scopedRepos
      ? [...scopedRepos].sort((left, right) => left.localeCompare(right))
      : repos.map((repo) => repo.id).sort((left, right) => left.localeCompare(right));

    for (const repoId of repoIds) {
      const tasks = byRepo.get(repoId) ?? [];
      const matched = tasks.some((task) => task.action.startsWith(rule.actionPrefix));
      if (!matched) {
        violations.push(`Rule ${rule.id}: repo ${repoId} missing required action prefix '${rule.actionPrefix}'`);
      }
    }

    return violations;
  }

  if (rule.kind === "cross-repo-action-compatibility") {
    const byRepoId = new Map(repos.map((repo) => [repo.id, repo] as const));
    for (const repo of [...repos].sort((left, right) => left.id.localeCompare(right.id))) {
      const currentTasks = byRepo.get(repo.id) ?? [];
      const hasDownstreamAdaptation = currentTasks.some((task) => task.action.startsWith(rule.downstreamPrefix));

      for (const depRepoId of repo.dependencies) {
        const depRepo = byRepoId.get(depRepoId);
        if (!depRepo) {
          continue;
        }

        const upstreamTasks = byRepo.get(depRepo.id) ?? [];
        const hasUpstreamBreakingChange = upstreamTasks.some((task) => task.action.startsWith(rule.upstreamPrefix));
        if (hasUpstreamBreakingChange && !hasDownstreamAdaptation) {
          violations.push(
            `Rule ${rule.id}: ${repo.id} depends on ${depRepo.id} upstream change '${rule.upstreamPrefix}' without downstream '${rule.downstreamPrefix}'`
          );
        }
      }
    }
    return violations;
  }

  if (rule.kind === "require-state-path") {
    const repoIds = scopedRepos
      ? [...scopedRepos].sort((left, right) => left.localeCompare(right))
      : repos.map((repo) => repo.id).sort((left, right) => left.localeCompare(right));
    const repoMap = new Map(repos.map((repo) => [repo.id, repo] as const));

    for (const repoId of repoIds) {
      const repo = repoMap.get(repoId);
      if (!repo) {
        continue;
      }

      const value = getAtPath(repo.state, rule.path);
      if (!value.exists) {
        violations.push(`Rule ${rule.id}: repo ${repo.id} missing required state path '${rule.path}'`);
      }
    }
    return violations;
  }

  return violations;
}

export function evaluateGlobalPolicies(plan: GlobalPlan, policies: GlobalPolicyRule[], repos: Repo[]): PolicyResult {
  const orderedRules = [...policies].sort((left, right) => left.id.localeCompare(right.id));
  const byRepo = taskMapByRepo(plan);
  const decisions: string[] = [];
  const violations: string[] = [];
  const appliedPolicyIds: string[] = [];
  let requiresApproval = false;
  let denied = false;

  for (const rule of orderedRules) {
    appliedPolicyIds.push(rule.id);
    const ruleViolations = evaluateRule(rule, plan, repos, byRepo);

    if (ruleViolations.length === 0) {
      decisions.push(`allow:${rule.id}`);
      continue;
    }

    violations.push(...ruleViolations);
    if (rule.effect === "deny") {
      denied = true;
      decisions.push(`deny:${rule.id}`);
      continue;
    }

    if (rule.effect === "require-approval") {
      requiresApproval = true;
      decisions.push(`require-approval:${rule.id}`);
      continue;
    }

    decisions.push(`allow-with-violation:${rule.id}`);
  }

  return {
    allowed: !denied && !requiresApproval,
    requiresApproval,
    violations: sortedUnique(violations),
    policyDecisions: decisions,
    appliedPolicyIds: sortedUnique(appliedPolicyIds),
  };
}

export function blockGlobalExecution(policyResult: PolicyResult): never {
  throw new Error(
    `Global execution blocked: ${policyResult.policyDecisions.join(", ")} :: ${policyResult.violations.join("; ")}`
  );
}

export function propagatePolicies(orgPolicies: OrgPolicy[], repos: Repo[]): PolicyDistribution {
  const orderedRepos = [...repos].map((repo) => normalizeRepo(repo)).sort((left, right) => left.id.localeCompare(right.id));
  const orderedPolicies = [...orgPolicies].sort((left, right) => left.id.localeCompare(right.id));

  const allRules = orderedPolicies.flatMap((policy) =>
    [...policy.rules].sort((left, right) => left.id.localeCompare(right.id))
  );

  const compiledOrgPolicies = orderedPolicies.map((policy) => ({
    id: policy.id,
    source: "org" as const,
    rules: [...policy.rules].sort((left, right) => left.id.localeCompare(right.id)),
  } satisfies CompiledPolicy));

  const byRepo = Object.fromEntries(
    orderedRepos.map((repo) => [repo.id, cloneUnknown(compiledOrgPolicies)])
  ) as Record<string, CompiledPolicy[]>;

  return {
    propagation: {
      source: "org",
      targets: orderedRepos.map((repo) => repo.id),
      rules: allRules,
    },
    byRepo,
  };
}

export function detectPolicyDrift(repo: Repo, orgPolicies: OrgPolicy[]): DriftResult {
  const violations: string[] = [];
  const sortedPolicies = [...orgPolicies].sort((left, right) => left.id.localeCompare(right.id));

  for (const policy of sortedPolicies) {
    for (const rule of [...policy.rules].sort((left, right) => left.id.localeCompare(right.id))) {
      if (rule.kind !== "require-state-path") {
        continue;
      }

      const repoSet = repoSetFromRule(rule);
      if (repoSet && !repoSet.has(repo.id)) {
        continue;
      }

      const value = getAtPath(repo.state, rule.path);
      if (!value.exists) {
        violations.push(`Drift: repo ${repo.id} missing required path '${rule.path}' from policy ${policy.id}:${rule.id}`);
      }
    }
  }

  return {
    repoId: repo.id,
    driftDetected: violations.length > 0,
    violations,
  };
}

export function createGlobalPlanningCache(): GlobalPlanningCache {
  return {
    graphByKey: new Map<string, GlobalDependencyGraph>(),
    planByKey: new Map<string, GlobalPlan>(),
  };
}

function globalPlanSignature(context: GlobalContext): string {
  return hashId("global-plan", {
    repos: context.repos.map((repo) => ({
      id: repo.id,
      dependencies: repo.dependencies,
      tasks: extractRepoTasks(repo).map((task) => ({
        id: task.id,
        action: task.action,
        dependsOn: task.dependsOn,
      })),
      stateHash: hashId("state", repo.state),
    })),
    policies: context.policies.map((policy) => ({
      id: policy.id,
      source: policy.source,
      ruleIds: policy.rules.map((rule) => rule.id),
    })),
    graph: context.graph,
  });
}

export function buildGlobalContext(
  repos: Repo[],
  policies: CompiledPolicy[],
  options?: {
    cache?: GlobalPlanningCache;
  }
): GlobalContext {
  const normalizedRepos = repos.map((repo) => normalizeRepo(repo)).sort((left, right) => left.id.localeCompare(right.id));
  const graph = buildGlobalDependencyGraph(normalizedRepos, options?.cache);
  const orderedPolicies = [...policies].sort((left, right) => left.id.localeCompare(right.id));

  return {
    repos: normalizedRepos,
    policies: orderedPolicies,
    graph,
  };
}

export function synthesizeGlobalPlan(
  context: GlobalContext,
  options?: {
    cache?: GlobalPlanningCache;
    previousPlan?: GlobalPlan;
  }
): GlobalPlan {
  const signature = globalPlanSignature(context);
  const cached = options?.cache?.planByKey.get(signature);
  if (cached) {
    return cloneUnknown(cached);
  }

  if (options?.previousPlan && options.previousPlan.id === signature) {
    return cloneUnknown(options.previousPlan);
  }

  const byRepoId = new Map(context.repos.map((repo) => [repo.id, repo] as const));
  const extractedByRepo = new Map(context.repos.map((repo) => [repo.id, extractRepoTasks(repo)] as const));
  const taskMap = new Map<string, GlobalPlanTask>();

  for (const repo of context.repos) {
    const tasks = extractedByRepo.get(repo.id) ?? [];
    for (const task of tasks) {
      const id = globalTaskId(repo.id, task.id);
      const dependsOn = sortedUnique(task.dependsOn.map((dep) => globalTaskId(repo.id, dep)));
      taskMap.set(id, {
        id,
        repoId: repo.id,
        action: task.action,
        dependsOn,
      });
    }
  }

  for (const edge of context.graph.edges) {
    const target = taskMap.get(edge.to);
    if (!target) {
      continue;
    }

    target.dependsOn = sortedUnique([...target.dependsOn, edge.from]);
    taskMap.set(target.id, target);
  }

  for (const [repoId, repo] of byRepoId.entries()) {
    for (const depRepoId of repo.dependencies) {
      const depTasks = extractedByRepo.get(depRepoId) ?? [];
      const currentTasks = extractedByRepo.get(repoId) ?? [];
      const currentRootIds = taskRoots(currentTasks).map((task) => globalTaskId(repoId, task.id));
      const depLeafIds = taskLeaves(depTasks).map((task) => globalTaskId(depRepoId, task.id));

      for (const rootId of currentRootIds) {
        const current = taskMap.get(rootId);
        if (!current) {
          continue;
        }

        current.dependsOn = sortedUnique([...current.dependsOn, ...depLeafIds]);
        taskMap.set(rootId, current);
      }
    }
  }

  const tasks = [...taskMap.values()]
    .map((task) => ({
      ...task,
      dependsOn: sortedUnique(task.dependsOn),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const plan: GlobalPlan = {
    id: signature,
    tasks,
  };

  const validation = validateGlobalPlan(plan);
  if (!validation.valid) {
    throw new Error(`Global plan synthesis failed: ${validation.errors.join("; ")}`);
  }

  options?.cache?.planByKey.set(signature, cloneUnknown(plan));
  return plan;
}

function defaultTaskExecutor(task: GlobalPlanTask, state: SystemState): SystemState {
  if (task.action.startsWith("set:")) {
    const payload = task.action.slice("set:".length).trim();
    const [path, valueRaw] = payload.split("=");
    if (!path || typeof valueRaw === "undefined") {
      return state;
    }

    const segments = path.split(".").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    if (segments.length === 0) {
      return state;
    }

    const next = cloneUnknown(state) as Record<string, unknown>;
    let cursor: Record<string, unknown> = next;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] as string;
      const existing = cursor[segment];
      if (!isRecord(existing)) {
        cursor[segment] = {};
      }
      cursor = cursor[segment] as Record<string, unknown>;
    }

    cursor[segments[segments.length - 1] as string] = valueRaw.trim();
    return next;
  }

  return cloneUnknown(state);
}

function rollbackAllRepos(snapshot: Record<string, SystemState>): Record<string, SystemState> {
  return cloneUnknown(snapshot);
}

export async function executeGlobalPlan(
  plan: GlobalPlan,
  options: ExecuteGlobalPlanOptions
): Promise<GlobalExecutionResult> {
  const validation = validateGlobalPlan(plan);
  if (!validation.valid) {
    throw new Error(`Global plan invalid: ${validation.errors.join("; ")}`);
  }

  const normalizedRepos = options.repos.map((repo) => normalizeRepo(repo)).sort((left, right) => left.id.localeCompare(right.id));
  const policyResult = evaluateGlobalPolicies(plan, flattenPolicies(options.policies), normalizedRepos);
  if (!policyResult.allowed) {
    blockGlobalExecution(policyResult);
  }

  const ordered = orderPlan(plan);
  const batches = batchTasks(plan);
  const states = Object.fromEntries(normalizedRepos.map((repo) => [repo.id, cloneUnknown(repo.state)])) as Record<string, SystemState>;
  const snapshot = cloneUnknown(states);
  const validateState = options.validateState ?? (() => true);
  const executeTask = options.executeTask ?? (async (task, state) => defaultTaskExecutor(task, state));

  try {
    for (const batch of batches) {
      const sortedTasks = [...batch.tasks].sort((left, right) => left.id.localeCompare(right.id));
      const results = await Promise.all(sortedTasks.map(async (task) => {
        const currentState = cloneUnknown(states[task.repoId] ?? {});
        const nextState = await executeTask(task, currentState, task.repoId, cloneUnknown(states));
        return {
          task,
          nextState,
        };
      }));

      for (const result of results.sort((left, right) => left.task.id.localeCompare(right.task.id))) {
        states[result.task.repoId] = cloneUnknown(result.nextState);
        if (!validateState(states[result.task.repoId], result.task.repoId)) {
          throw new Error(`State validation failed after task ${result.task.id}`);
        }
      }
    }

    const convergence = normalizedRepos.every((repo) => validateState(states[repo.id], repo.id));
    const audit: GlobalAudit = {
      planId: plan.id,
      reposInvolved: normalizedRepos.map((repo) => repo.id),
      policiesApplied: policyResult.appliedPolicyIds,
      violations: policyResult.violations,
    };

    return {
      success: true,
      rolledBack: false,
      finalStates: states,
      audit,
      trace: {
        plan,
        executionOrder: ordered.orderedTaskIds,
        policyDecisions: policyResult.policyDecisions,
        convergence,
      },
    };
  } catch (error) {
    const rolledBackStates = rollbackAllRepos(snapshot);
    return {
      success: false,
      rolledBack: true,
      finalStates: rolledBackStates,
      audit: {
        planId: plan.id,
        reposInvolved: normalizedRepos.map((repo) => repo.id),
        policiesApplied: policyResult.appliedPolicyIds,
        violations: [...policyResult.violations, error instanceof Error ? error.message : String(error)],
      },
      trace: {
        plan,
        executionOrder: ordered.orderedTaskIds,
        policyDecisions: policyResult.policyDecisions,
        convergence: false,
      },
    };
  }
}
