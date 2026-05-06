import {
  AST,
  ActionNode,
  CHOIR_IDENTIFIER_PATTERN,
  DefineType,
} from "./choirRouter.js";
import { ControlPlane } from "../schema.js";
import { createHash } from "crypto";

export type ValidationSeverity = "error" | "warning";

export type ValidationIssue = {
  code: string;
  severity: ValidationSeverity;
  message: string;
  path: string;
};

export type ValidationResult = {
  valid: boolean;
  issues: ValidationIssue[];
};

export type ASTNode = ActionNode;

export type RuleContext = {
  system: SystemContext;
  rootAst: AST;
  actionIndex: number;
};

export type RuleResult = {
  ruleId: string;
  severity: "error" | "warning";
  message: string;
  fix?: ASTNode;
  actionIndex?: number;
  decision?: "allow" | "deny";
};

export type Rule = {
  id: string;
  match: (ast: ASTNode) => boolean;
  validate: (ast: ASTNode, context: RuleContext) => RuleResult | null;
  fix?: (ast: ASTNode) => ASTNode;
  nodeTypes?: ReadonlyArray<ASTNode["type"]>;
  incrementalScope?: "node" | "global";
};

export type SystemContext = {
  controlPlane: ControlPlane;
};

export type ValidationTrace = {
  ast: AST;
  validationPassed: boolean;
  rulesTriggered: string[];
  conflicts: string[];
  incremental?: IncrementalTrace;
  performance?: PerformanceMetrics;
};

export type ProcessedAST = {
  ast: AST;
  results: RuleResult[];
  trace: ValidationTrace;
};

export type NodeId = string;

export type DependencyGraph = {
  nodes: Map<NodeId, ASTNode>;
  edges: Map<NodeId, NodeId[]>;
};

export type ASTDiff = {
  changedNodes: NodeId[];
};

export type RuleIndex = Map<string, Rule[]>;

export type RuleCache = Map<string, RuleResult>;

export type PerformanceMetrics = {
  totalRules: number;
  rulesExecuted: number;
  cacheHits: number;
  executionTime: number;
};

export type IncrementalTrace = {
  changedNodes: NodeId[];
  affectedNodes: NodeId[];
  rulesExecuted: string[];
  cacheUsed: boolean;
  fallbackToFullEvaluation?: boolean;
};

export type IncrementalRuleState = {
  previousAst?: AST;
  previousResultsByNode: Map<NodeId, RuleResult[]>;
  cache: RuleCache;
  cacheKeysByNode: Map<NodeId, Set<string>>;
  contextSignature?: string;
  ruleSetSignature?: string;
};

export type IncrementalRunResult = {
  results: RuleResult[];
  trace: IncrementalTrace;
  metrics: PerformanceMetrics;
};

export type IncrementalRunOptions = {
  state?: IncrementalRuleState;
  previousAst?: AST;
  consistencyCheck?: "never" | "always";
};

export type ProcessASTOptions = {
  incrementalState?: IncrementalRuleState;
  consistencyCheck?: "never" | "always";
};

const DEFINE_TYPES = new Set<DefineType>([
  "mission",
  "vision",
  "goal",
  "constraint",
  "non-goal",
]);

const RULE_WILDCARD_KEY = "*";

function actionNodeTypes(): ASTNode["type"][] {
  return [
    "define",
    "analyze",
    "plan",
    "plan-approve",
    "preview",
    "execute",
    "status",
    "export",
    "approve",
    "reject",
    "policy-status",
    "import-library",
    "library-list",
    "library-install",
    "library-update",
    "library-lock",
    "ci-run",
    "audit-log",
    "audit-report",
    "audit-query",
    "macro-list",
    "macro-show",
    "macro-run",
    "abstraction-run",
  ];
}

function nodeIdForIndex(index: number): NodeId {
  return `action:${index}`;
}

function actionIndexFromNodeId(nodeId: NodeId): number {
  const [, raw] = nodeId.split(":");
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Number.MAX_SAFE_INTEGER;
  }

  return parsed;
}

function sortNodeIds(nodeIds: Iterable<NodeId>): NodeId[] {
  return Array.from(nodeIds).sort((left, right) => {
    const leftIndex = actionIndexFromNodeId(left);
    const rightIndex = actionIndexFromNodeId(right);
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return left.localeCompare(right);
  });
}

function hashPayload(payload: unknown): string {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return createHash("sha256").update(text).digest("hex");
}

function createRuleSetSignature(rules: Rule[]): string {
  const normalized = [...rules]
    .map((rule) => ({
      id: rule.id,
      nodeTypes: (rule.nodeTypes ?? []).slice().sort((left, right) => left.localeCompare(right)),
      incrementalScope: rule.incrementalScope ?? "global",
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return hashPayload(normalized);
}

function createContextSignature(context: SystemContext): string {
  return hashPayload(context.controlPlane);
}

function cloneRuleResults(value: RuleResult[]): RuleResult[] {
  return deepClone(value);
}

function clearIncrementalState(state: IncrementalRuleState): void {
  state.previousAst = undefined;
  state.previousResultsByNode.clear();
  state.cache.clear();
  state.cacheKeysByNode.clear();
}

function registerCacheKey(state: IncrementalRuleState, nodeId: NodeId, cacheKey: string): void {
  const keys = state.cacheKeysByNode.get(nodeId) ?? new Set<string>();
  keys.add(cacheKey);
  state.cacheKeysByNode.set(nodeId, keys);
}

function invalidateCache(state: IncrementalRuleState, changedNodes: NodeId[]): void {
  for (const nodeId of changedNodes) {
    const keys = state.cacheKeysByNode.get(nodeId);
    if (!keys) {
      continue;
    }

    for (const key of keys) {
      state.cache.delete(key);
    }

    state.cacheKeysByNode.delete(nodeId);
  }
}

function pruneNodeState(state: IncrementalRuleState, activeNodeIds: Set<NodeId>): void {
  for (const nodeId of state.previousResultsByNode.keys()) {
    if (!activeNodeIds.has(nodeId)) {
      state.previousResultsByNode.delete(nodeId);
    }
  }

  for (const nodeId of state.cacheKeysByNode.keys()) {
    if (!activeNodeIds.has(nodeId)) {
      const keys = state.cacheKeysByNode.get(nodeId) ?? new Set<string>();
      for (const key of keys) {
        state.cache.delete(key);
      }

      state.cacheKeysByNode.delete(nodeId);
    }
  }
}

function asActions(ast: AST): ActionNode[] {
  return ast.type === "sequence" ? ast.actions : [ast];
}

function issue(
  code: string,
  severity: ValidationSeverity,
  message: string,
  path: string
): ValidationIssue {
  return {
    code,
    severity,
    message,
    path,
  };
}

function resultFromIssues(issues: ValidationIssue[]): ValidationResult {
  return {
    valid: issues.every((entry) => entry.severity !== "error"),
    issues,
  };
}

function trimValue(value: string): string {
  return value.trim();
}

function controlHasIntent(control: ControlPlane): boolean {
  return control.mission.trim().length > 0
    || control.vision.trim().length > 0
    || control.intent.goals.length > 0
    || control.intent.constraints.length > 0
    || control.intent["non-goals"].length > 0;
}

function toActionPath(index: number): string {
  return `actions[${index}]`;
}

function serializeFix(node: ASTNode): string {
  return JSON.stringify(node);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pushUnexpectedNode(issues: ValidationIssue[], node: never, path: string): void {
  issues.push(issue("unknown-node-type", "error", `Unknown AST node type at ${path}: ${String(node)}`, path));
}

function validateActionStructure(action: ActionNode, index: number, issues: ValidationIssue[]): void {
  const path = toActionPath(index);

  switch (action.type) {
    case "define": {
      if (!DEFINE_TYPES.has(action.defineType)) {
        issues.push(issue("define-type-invalid", "error", `Invalid define type: ${action.defineType}`, `${path}.defineType`));
      }

      if (typeof action.value !== "string") {
        issues.push(issue("define-value-missing", "error", "Missing value for define command", `${path}.value`));
      }

      return;
    }

    case "analyze": {
      if (action.target !== "workspace" && action.target !== "hotspots" && action.target !== "summary") {
        issues.push(issue("analyze-target-invalid", "error", `Invalid analyze target: ${String(action.target)}`, `${path}.target`));
      }

      return;
    }

    case "plan": {
      if (action.target !== undefined && typeof action.target !== "string") {
        issues.push(issue("plan-target-invalid", "error", "Plan target must be a string when present", `${path}.target`));
      }

      return;
    }

    case "plan-approve": {
      if (typeof action.planId !== "string" || action.planId.length === 0) {
        issues.push(issue("plan-approve-id-missing", "error", "Missing plan id for plan approve command", `${path}.planId`));
      }

      return;
    }

    case "preview":
    case "execute": {
      if (action.planRef && (!action.planRef.identifier || typeof action.planRef.identifier !== "string")) {
        issues.push(issue("plan-ref-invalid", "error", "Invalid plan reference identifier", `${path}.planRef.identifier`));
      }

      return;
    }

    case "status":
    case "policy-status":
    case "library-list":
    case "library-lock":
    case "ci-run":
    case "audit-log":
    case "audit-report":
    case "macro-list": {
      return;
    }

    case "export": {
      if (action.format !== "dsl") {
        issues.push(issue("export-format-invalid", "error", `Invalid export format: ${String(action.format)}`, `${path}.format`));
      }

      if (action.section !== "all" && action.section !== "intent" && action.section !== "policy" && action.section !== "plans") {
        issues.push(issue("export-section-invalid", "error", `Invalid export section: ${String(action.section)}`, `${path}.section`));
      }

      return;
    }

    case "approve":
    case "reject": {
      if (!action.diffId || typeof action.diffId !== "string") {
        issues.push(issue("diff-id-missing", "error", `Missing diff id for ${action.type}`, `${path}.diffId`));
      }

      return;
    }

    case "import-library":
    case "library-install": {
      if (!action.library || typeof action.library !== "string") {
        issues.push(issue("library-missing", "error", "Library id is required", `${path}.library`));
      }

      if (!action.versionSelector || typeof action.versionSelector !== "string") {
        issues.push(issue("version-selector-missing", "error", "Library version selector is required", `${path}.versionSelector`));
      }

      return;
    }

    case "library-update": {
      if (!action.library || typeof action.library !== "string") {
        issues.push(issue("library-missing", "error", "Library id is required", `${path}.library`));
      }

      return;
    }

    case "audit-query": {
      if (typeof action.filters !== "object" || action.filters === null) {
        issues.push(issue("audit-query-filters-invalid", "error", "Audit query filters must be an object", `${path}.filters`));
      }

      return;
    }

    case "macro-show": {
      if (!action.macroId || typeof action.macroId !== "string") {
        issues.push(issue("macro-id-missing", "error", "Macro id is required", `${path}.macroId`));
      }

      return;
    }

    case "macro-run": {
      if (!action.macroId || typeof action.macroId !== "string") {
        issues.push(issue("macro-id-missing", "error", "Macro id is required", `${path}.macroId`));
      }

      if (typeof action.args !== "object" || action.args === null || Array.isArray(action.args)) {
        issues.push(issue("macro-args-invalid", "error", "Macro args must be a key-value object", `${path}.args`));
      }

      return;
    }

    case "abstraction-run": {
      if (!action.identifier || typeof action.identifier !== "string") {
        issues.push(issue("abstraction-id-missing", "error", "Abstraction id is required", `${path}.identifier`));
      }

      if (typeof action.args !== "object" || action.args === null || Array.isArray(action.args)) {
        issues.push(issue("abstraction-args-invalid", "error", "Abstraction args must be a key-value object", `${path}.args`));
      }

      return;
    }

    case "graph": {
      if (!action.mode || typeof action.mode !== "string") {
        issues.push(issue("graph-mode-missing", "error", "Graph mode is required", `${path}.mode`));
      }

      return;
    }

    default:
      pushUnexpectedNode(issues, action, path);
  }
}

export function validateStructure(ast: AST): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (ast.type === "sequence") {
    if (!Array.isArray(ast.actions) || ast.actions.length === 0) {
      issues.push(issue("sequence-empty", "error", "Sequence must include at least one action", "actions"));
      return resultFromIssues(issues);
    }

    for (let i = 0; i < ast.actions.length; i += 1) {
      validateActionStructure(ast.actions[i], i, issues);
    }

    return resultFromIssues(issues);
  }

  validateActionStructure(ast, 0, issues);
  return resultFromIssues(issues);
}

export function validateSemantics(ast: AST, context: SystemContext): ValidationResult {
  const issues: ValidationIssue[] = [];
  const actions = asActions(ast);

  const existingGoals = new Set<string>(context.controlPlane.intent.goals.map((item) => item.toLowerCase()));
  const existingConstraints = new Set<string>(context.controlPlane.intent.constraints.map((item) => item.toLowerCase()));
  const existingNonGoals = new Set<string>(context.controlPlane.intent["non-goals"].map((item) => item.toLowerCase()));
  const existingMission = new Set<string>(context.controlPlane.mission.trim().length > 0 ? [context.controlPlane.mission.trim().toLowerCase()] : []);
  const existingVision = new Set<string>(context.controlPlane.vision.trim().length > 0 ? [context.controlPlane.vision.trim().toLowerCase()] : []);

  const seenGoals = new Set<string>();
  const seenConstraints = new Set<string>();
  const seenNonGoals = new Set<string>();
  const seenMission = new Set<string>();
  const seenVision = new Set<string>();

  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    const path = toActionPath(i);

    if (action.type === "define") {
      const value = trimValue(action.value);
      if (value.length === 0) {
        issues.push(issue("define-empty-value", "error", `Empty value is not allowed for ${action.defineType}`, `${path}.value`));
        continue;
      }

      const key = value.toLowerCase();
      if (action.defineType === "goal") {
        if (seenGoals.has(key)) {
          issues.push(issue("duplicate-goal", "error", `Duplicate goal is not allowed: ${value}`, `${path}.value`));
        }

        if (existingGoals.has(key)) {
          issues.push(issue("duplicate-goal-existing", "warning", `Goal already exists and will be treated as no-op: ${value}`, `${path}.value`));
        }

        seenGoals.add(key);
      }

      if (action.defineType === "constraint") {
        if (seenConstraints.has(key)) {
          issues.push(issue("duplicate-constraint", "error", `Duplicate constraint is not allowed: ${value}`, `${path}.value`));
        }

        if (seenNonGoals.has(key) || existingNonGoals.has(key)) {
          issues.push(issue("constraint-conflicts-non-goal", "error", `Constraint conflicts with non-goal: ${value}`, `${path}.value`));
        }

        if (existingConstraints.has(key)) {
          issues.push(issue("duplicate-constraint-existing", "warning", `Constraint already exists and will be treated as no-op: ${value}`, `${path}.value`));
        }

        seenConstraints.add(key);
      }

      if (action.defineType === "non-goal") {
        if (seenNonGoals.has(key)) {
          issues.push(issue("duplicate-non-goal", "error", `Duplicate non-goal is not allowed: ${value}`, `${path}.value`));
        }

        if (seenConstraints.has(key) || existingConstraints.has(key)) {
          issues.push(issue("non-goal-conflicts-constraint", "error", `Non-goal conflicts with constraint: ${value}`, `${path}.value`));
        }

        if (existingNonGoals.has(key)) {
          issues.push(issue("duplicate-non-goal-existing", "warning", `Non-goal already exists and will be treated as no-op: ${value}`, `${path}.value`));
        }

        seenNonGoals.add(key);
      }

      if (action.defineType === "mission") {
        if (seenMission.has(key)) {
          issues.push(issue("duplicate-mission", "error", `Duplicate mission is not allowed: ${value}`, `${path}.value`));
        }

        if (existingMission.has(key)) {
          issues.push(issue("duplicate-mission-existing", "warning", `Mission already exists and will be treated as no-op: ${value}`, `${path}.value`));
        }

        seenMission.add(key);
      }

      if (action.defineType === "vision") {
        if (seenVision.has(key)) {
          issues.push(issue("duplicate-vision", "error", `Duplicate vision is not allowed: ${value}`, `${path}.value`));
        }

        if (existingVision.has(key)) {
          issues.push(issue("duplicate-vision-existing", "warning", `Vision already exists and will be treated as no-op: ${value}`, `${path}.value`));
        }

        seenVision.add(key);
      }
    }

    if (action.type === "macro-run") {
      for (const [argKey, argValue] of Object.entries(action.args)) {
        if (trimValue(argValue).length === 0) {
          issues.push(issue("macro-arg-empty", "error", `Macro argument '${argKey}' cannot be empty`, `${path}.args.${argKey}`));
        }
      }
    }

    if (action.type === "abstraction-run") {
      for (const [argKey, argValue] of Object.entries(action.args)) {
        if (trimValue(argValue).length === 0) {
          issues.push(issue("abstraction-arg-empty", "error", `Abstraction argument '${argKey}' cannot be empty`, `${path}.args.${argKey}`));
        }
      }
    }
  }

  return resultFromIssues(issues);
}

export function validateCrossNode(ast: AST, context: SystemContext): ValidationResult {
  const issues: ValidationIssue[] = [];
  const actions = asActions(ast);
  const planIds = new Set(context.controlPlane.execution.plans.map((plan) => plan.id));

  let hasIntent = controlHasIntent(context.controlPlane);
  let hasPlan = context.controlPlane.execution.plans.length > 0;

  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    const path = toActionPath(i);

    if (action.type === "define") {
      if (trimValue(action.value).length > 0) {
        hasIntent = true;
      }

      continue;
    }

    if (action.type === "plan") {
      if (!hasIntent) {
        issues.push(issue("plan-without-intent", "error", "Cannot plan without intent", path));
      }

      hasPlan = true;
      continue;
    }

    if (action.type === "plan-approve") {
      if (!planIds.has(action.planId)) {
        issues.push(issue("plan-approve-missing-plan", "error", `Cannot approve unknown plan id: ${action.planId}`, `${path}.planId`));
      } else {
        hasPlan = true;
      }

      continue;
    }

    if (action.type === "preview") {
      if (action.planRef && !planIds.has(action.planRef.identifier)) {
        issues.push(issue("preview-missing-plan", "error", `Cannot preview unknown plan id: ${action.planRef.identifier}`, `${path}.planRef.identifier`));
      }

      continue;
    }

    if (action.type === "execute") {
      if (!hasPlan) {
        issues.push(issue("execute-without-plan", "error", "Cannot execute without plan", path));
      }

      if (action.planRef && !planIds.has(action.planRef.identifier)) {
        issues.push(issue("execute-missing-plan", "error", `Cannot execute unknown plan id: ${action.planRef.identifier}`, `${path}.planRef.identifier`));
      }
    }
  }

  return resultFromIssues(issues);
}

export function buildDependencyGraph(ast: AST): DependencyGraph {
  const actions = asActions(ast);
  const nodes = new Map<NodeId, ASTNode>();
  const edges = new Map<NodeId, NodeId[]>();

  for (let index = 0; index < actions.length; index += 1) {
    const nodeId = nodeIdForIndex(index);
    nodes.set(nodeId, actions[index]);
    edges.set(nodeId, []);
  }

  // Sequence order is authoritative and deterministic for downstream impact.
  for (let index = 0; index < actions.length - 1; index += 1) {
    const from = nodeIdForIndex(index);
    const to = nodeIdForIndex(index + 1);
    const current = edges.get(from) ?? [];
    current.push(to);
    edges.set(from, current);
  }

  for (const [nodeId, next] of edges.entries()) {
    const unique = Array.from(new Set(next));
    edges.set(nodeId, sortNodeIds(unique));
  }

  return {
    nodes,
    edges,
  };
}

export function diffAST(oldAST: AST | undefined, newAST: AST): ASTDiff {
  const newActions = asActions(newAST);
  if (!oldAST) {
    return {
      changedNodes: sortNodeIds(newActions.map((_, index) => nodeIdForIndex(index))),
    };
  }

  const oldActions = asActions(oldAST);
  if (oldActions.length !== newActions.length) {
    return {
      changedNodes: sortNodeIds(newActions.map((_, index) => nodeIdForIndex(index))),
    };
  }

  const changed: NodeId[] = [];
  for (let index = 0; index < newActions.length; index += 1) {
    if (JSON.stringify(oldActions[index]) !== JSON.stringify(newActions[index])) {
      changed.push(nodeIdForIndex(index));
    }
  }

  return {
    changedNodes: sortNodeIds(changed),
  };
}

export function getAffectedNodes(diff: ASTDiff, graph: DependencyGraph): NodeId[] {
  const queue = sortNodeIds(diff.changedNodes.filter((nodeId) => graph.nodes.has(nodeId)));
  const visited = new Set<NodeId>(queue);

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId) {
      continue;
    }

    const downstream = graph.edges.get(nodeId) ?? [];
    for (const dependent of downstream) {
      if (visited.has(dependent)) {
        continue;
      }

      visited.add(dependent);
      queue.push(dependent);
    }
  }

  return sortNodeIds(visited);
}

export function buildRuleIndex(rules: Rule[]): RuleIndex {
  const index: RuleIndex = new Map<string, Rule[]>();
  const ordered = [...rules].sort((left, right) => left.id.localeCompare(right.id));

  for (const rule of ordered) {
    const targets = rule.nodeTypes && rule.nodeTypes.length > 0
      ? Array.from(new Set(rule.nodeTypes))
      : [RULE_WILDCARD_KEY];

    for (const target of targets) {
      const bucket = index.get(target) ?? [];
      bucket.push(rule);
      index.set(target, bucket);
    }
  }

  return index;
}

export function createIncrementalRuleState(): IncrementalRuleState {
  return {
    previousAst: undefined,
    previousResultsByNode: new Map<NodeId, RuleResult[]>(),
    cache: new Map<string, RuleResult>(),
    cacheKeysByNode: new Map<NodeId, Set<string>>(),
  };
}

const defaultIncrementalRuleState = createIncrementalRuleState();

function rulesForNode(node: ASTNode, index: RuleIndex): Rule[] {
  const specific = index.get(node.type) ?? [];
  const wildcard = index.get(RULE_WILDCARD_KEY) ?? [];

  const merged = new Map<string, Rule>();
  for (const rule of [...specific, ...wildcard]) {
    merged.set(rule.id, rule);
  }

  return Array.from(merged.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function hasGlobalRules(rules: Rule[]): boolean {
  return rules.some((rule) => (rule.incrementalScope ?? "global") === "global");
}

export const DEFAULT_RULES: Rule[] = [
  {
    id: "warn-execute-without-plan-ref",
    nodeTypes: ["execute"],
    incrementalScope: "node",
    match: (node) => node.type === "execute",
    validate: (node, context) => {
      if (node.type !== "execute") {
        return null;
      }

      if (node.planRef) {
        return null;
      }

      return {
        ruleId: "warn-execute-without-plan-ref",
        severity: "warning",
        message: "Execute without explicit plan reference may be less auditable.",
        actionIndex: context.actionIndex,
      };
    },
  },
  {
    id: "warn-define-mission-short",
    nodeTypes: ["define"],
    incrementalScope: "node",
    match: (node) => node.type === "define" && node.defineType === "mission",
    validate: (node, context) => {
      if (node.type !== "define" || node.defineType !== "mission") {
        return null;
      }

      if (trimValue(node.value).length >= 10) {
        return null;
      }

      return {
        ruleId: "warn-define-mission-short",
        severity: "warning",
        message: "Mission value is very short; consider a more descriptive mission.",
        actionIndex: context.actionIndex,
      };
    },
  },
];

type EvaluatedNodeBatch = {
  resultsByNode: Map<NodeId, RuleResult[]>;
  executedRuleIds: string[];
  cacheHits: number;
  rulesExecuted: number;
  cacheUsed: boolean;
};

function serializeRuleResults(results: RuleResult[]): string {
  return JSON.stringify(results);
}

function reverseGraph(graph: DependencyGraph): Map<NodeId, NodeId[]> {
  const reversed = new Map<NodeId, NodeId[]>();

  for (const nodeId of graph.nodes.keys()) {
    reversed.set(nodeId, []);
  }

  for (const [from, downstream] of graph.edges.entries()) {
    for (const to of downstream) {
      const incoming = reversed.get(to) ?? [];
      incoming.push(from);
      reversed.set(to, incoming);
    }
  }

  for (const [nodeId, incoming] of reversed.entries()) {
    reversed.set(nodeId, sortNodeIds(incoming));
  }

  return reversed;
}

function dependencySignature(
  nodeId: NodeId,
  graph: DependencyGraph,
  reversed: Map<NodeId, NodeId[]>,
  memo: Map<NodeId, string>
): string {
  const existing = memo.get(nodeId);
  if (existing) {
    return existing;
  }

  const queue = [nodeId];
  const upstream = new Set<NodeId>([nodeId]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const incoming = reversed.get(current) ?? [];
    for (const parent of incoming) {
      if (upstream.has(parent)) {
        continue;
      }

      upstream.add(parent);
      queue.push(parent);
    }
  }

  const payload = sortNodeIds(upstream).map((id) => ({
    id,
    node: graph.nodes.get(id),
  }));
  const signature = hashPayload(payload);
  memo.set(nodeId, signature);
  return signature;
}

function ruleCacheKey(ruleId: string, nodeId: NodeId, contextSignature: string, dependencySig: string): string {
  return `${ruleId}:${nodeId}:${contextSignature}:${dependencySig}`;
}

function evaluateNodeBatch(
  ast: AST,
  nodeIds: NodeId[],
  graph: DependencyGraph,
  ruleIndex: RuleIndex,
  context: SystemContext,
  state: IncrementalRuleState | undefined,
  contextSignature: string
): EvaluatedNodeBatch {
  const reversed = reverseGraph(graph);
  const depMemo = new Map<NodeId, string>();

  const resultsByNode = new Map<NodeId, RuleResult[]>();
  const executedRuleIds: string[] = [];
  let cacheHits = 0;
  let rulesExecuted = 0;
  let cacheUsed = false;

  for (const nodeId of sortNodeIds(nodeIds)) {
    const node = graph.nodes.get(nodeId);
    if (!node) {
      continue;
    }

    const actionIndex = actionIndexFromNodeId(nodeId);
    const nodeRules = rulesForNode(node, ruleIndex);
    const nodeResults: RuleResult[] = [];

    for (const rule of nodeRules) {
      if (!rule.match(node)) {
        continue;
      }

      const depSig = dependencySignature(nodeId, graph, reversed, depMemo);
      const key = ruleCacheKey(rule.id, nodeId, contextSignature, depSig);
      const cached = state?.cache.get(key);
      if (cached) {
        nodeResults.push(deepClone(cached));
        cacheHits += 1;
        cacheUsed = true;
        continue;
      }

      rulesExecuted += 1;
      executedRuleIds.push(rule.id);

      const outcome = rule.validate(node, {
        system: context,
        rootAst: ast,
        actionIndex,
      });

      if (!outcome) {
        continue;
      }

      const normalized: RuleResult = {
        ...outcome,
        actionIndex,
      };
      nodeResults.push(normalized);

      if (state) {
        state.cache.set(key, deepClone(normalized));
        registerCacheKey(state, nodeId, key);
      }
    }

    nodeResults.sort((left, right) => left.ruleId.localeCompare(right.ruleId));
    resultsByNode.set(nodeId, nodeResults);
  }

  return {
    resultsByNode,
    executedRuleIds,
    cacheHits,
    rulesExecuted,
    cacheUsed,
  };
}

function flattenResults(graph: DependencyGraph, byNode: Map<NodeId, RuleResult[]>): RuleResult[] {
  const results: RuleResult[] = [];
  for (const nodeId of sortNodeIds(graph.nodes.keys())) {
    const nodeResults = byNode.get(nodeId) ?? [];
    for (const result of nodeResults) {
      results.push(result);
    }
  }

  return results;
}

function mapResultsByNode(results: RuleResult[], graph: DependencyGraph): Map<NodeId, RuleResult[]> {
  const mapped = new Map<NodeId, RuleResult[]>();
  for (const nodeId of graph.nodes.keys()) {
    mapped.set(nodeId, []);
  }

  for (const result of results) {
    if (result.actionIndex === undefined) {
      continue;
    }

    const nodeId = nodeIdForIndex(result.actionIndex);
    const nodeResults = mapped.get(nodeId) ?? [];
    nodeResults.push(result);
    mapped.set(nodeId, nodeResults);
  }

  for (const [nodeId, nodeResults] of mapped.entries()) {
    nodeResults.sort((left, right) => left.ruleId.localeCompare(right.ruleId));
    mapped.set(nodeId, nodeResults);
  }

  return mapped;
}

export function runRules(ast: AST, rules: Rule[], context: SystemContext): RuleResult[] {
  const graph = buildDependencyGraph(ast);
  const nodeIds = sortNodeIds(graph.nodes.keys());
  const ruleIndex = buildRuleIndex(rules);
  const contextSignature = createContextSignature(context);
  const evaluated = evaluateNodeBatch(ast, nodeIds, graph, ruleIndex, context, undefined, contextSignature);
  return flattenResults(graph, evaluated.resultsByNode);
}

export function runIncrementalRules(
  ast: AST,
  rules: Rule[],
  context: SystemContext,
  options?: IncrementalRunOptions
): IncrementalRunResult {
  const startedAt = Date.now();
  const state = options?.state ?? createIncrementalRuleState();

  const contextSignature = createContextSignature(context);
  const ruleSetSignature = createRuleSetSignature(rules);
  if (state.contextSignature !== contextSignature || state.ruleSetSignature !== ruleSetSignature) {
    clearIncrementalState(state);
    state.contextSignature = contextSignature;
    state.ruleSetSignature = ruleSetSignature;
  }

  const graph = buildDependencyGraph(ast);
  const allNodeIds = sortNodeIds(graph.nodes.keys());
  const activeNodeSet = new Set<NodeId>(allNodeIds);
  pruneNodeState(state, activeNodeSet);

  const previousAst = options?.previousAst ?? state.previousAst;
  const diff = diffAST(previousAst, ast);
  let changedNodes = diff.changedNodes;
  if (!previousAst && changedNodes.length === 0) {
    changedNodes = [...allNodeIds];
  }

  if (changedNodes.length === 0) {
    const reused = new Map<NodeId, RuleResult[]>();
    for (const nodeId of allNodeIds) {
      reused.set(nodeId, cloneRuleResults(state.previousResultsByNode.get(nodeId) ?? []));
    }

    const results = flattenResults(graph, reused);
    state.previousAst = deepClone(ast);
    state.previousResultsByNode = reused;

    return {
      results,
      trace: {
        changedNodes: [],
        affectedNodes: [],
        rulesExecuted: [],
        cacheUsed: false,
      },
      metrics: {
        totalRules: allNodeIds.length * rules.length,
        rulesExecuted: 0,
        cacheHits: 0,
        executionTime: Date.now() - startedAt,
      },
    };
  }

  let affectedNodes = getAffectedNodes({ changedNodes }, graph);
  if (hasGlobalRules(rules) && changedNodes.length > 0) {
    affectedNodes = [...allNodeIds];
  }

  invalidateCache(state, changedNodes);

  const affectedSet = new Set<NodeId>(affectedNodes);
  const resultsByNode = new Map<NodeId, RuleResult[]>();
  for (const nodeId of allNodeIds) {
    if (affectedSet.has(nodeId)) {
      continue;
    }

    const prior = state.previousResultsByNode.get(nodeId);
    if (!prior) {
      affectedSet.add(nodeId);
      continue;
    }

    resultsByNode.set(nodeId, cloneRuleResults(prior));
  }

  affectedNodes = sortNodeIds(affectedSet);

  const ruleIndex = buildRuleIndex(rules);
  const executedRuleIds: string[] = [];
  let cacheHits = 0;
  let rulesExecuted = 0;
  let cacheUsed = false;

  let pending = [...affectedNodes];
  const visited = new Set<NodeId>(pending);
  const maxIterations = Math.max(1, allNodeIds.length + rules.length);
  let iterations = 0;

  while (pending.length > 0) {
    iterations += 1;
    if (iterations > maxIterations) {
      throw new Error("Incremental rule execution exceeded deterministic fixpoint bounds");
    }

    const batch = sortNodeIds(new Set(pending));
    pending = [];

    const evaluated = evaluateNodeBatch(ast, batch, graph, ruleIndex, context, state, contextSignature);
    for (const [nodeId, nodeResults] of evaluated.resultsByNode.entries()) {
      resultsByNode.set(nodeId, nodeResults);
    }

    executedRuleIds.push(...evaluated.executedRuleIds);
    cacheHits += evaluated.cacheHits;
    rulesExecuted += evaluated.rulesExecuted;
    cacheUsed = cacheUsed || evaluated.cacheUsed;

    const fixTargets = new Set<NodeId>();
    for (const nodeResults of evaluated.resultsByNode.values()) {
      for (const result of nodeResults) {
        if (!result.fix || result.actionIndex === undefined) {
          continue;
        }

        const nodeId = nodeIdForIndex(result.actionIndex);
        if (graph.nodes.has(nodeId)) {
          fixTargets.add(nodeId);
        }
      }
    }

    if (fixTargets.size === 0) {
      continue;
    }

    const propagated = getAffectedNodes({ changedNodes: sortNodeIds(fixTargets) }, graph);
    for (const nodeId of propagated) {
      if (visited.has(nodeId)) {
        continue;
      }

      visited.add(nodeId);
      pending.push(nodeId);
    }
  }

  for (const nodeId of allNodeIds) {
    if (!resultsByNode.has(nodeId)) {
      resultsByNode.set(nodeId, []);
    }
  }

  let finalResults = flattenResults(graph, resultsByNode);
  let fallbackToFullEvaluation = false;

  if ((options?.consistencyCheck ?? "never") === "always") {
    const fullResults = runRules(ast, rules, context);
    if (serializeRuleResults(fullResults) !== serializeRuleResults(finalResults)) {
      fallbackToFullEvaluation = true;
      finalResults = fullResults;
      clearIncrementalState(state);
      state.previousResultsByNode = mapResultsByNode(finalResults, graph);
    }
  }

  if (!fallbackToFullEvaluation) {
    state.previousResultsByNode = new Map(
      Array.from(resultsByNode.entries()).map(([nodeId, nodeResults]) => [nodeId, cloneRuleResults(nodeResults)])
    );
  }

  state.previousAst = deepClone(ast);
  state.contextSignature = contextSignature;
  state.ruleSetSignature = ruleSetSignature;

  return {
    results: finalResults,
    trace: {
      changedNodes,
      affectedNodes,
      rulesExecuted: Array.from(new Set(executedRuleIds)).sort((left, right) => left.localeCompare(right)),
      cacheUsed,
      fallbackToFullEvaluation,
    },
    metrics: {
      totalRules: allNodeIds.length * rules.length,
      rulesExecuted,
      cacheHits,
      executionTime: Date.now() - startedAt,
    },
  };
}

export function detectConflicts(results: RuleResult[]): string[] {
  const conflicts: string[] = [];

  const decisions = new Set(results
    .map((entry) => entry.decision)
    .filter((entry): entry is "allow" | "deny" => entry === "allow" || entry === "deny"));

  if (decisions.has("allow") && decisions.has("deny")) {
    conflicts.push("Conflicting rule decisions: allow and deny");
  }

  const fixesByAction = new Map<number, Set<string>>();
  for (const result of results) {
    if (!result.fix || result.actionIndex === undefined) {
      continue;
    }

    const key = result.actionIndex;
    const fixSet = fixesByAction.get(key) ?? new Set<string>();
    fixSet.add(serializeFix(result.fix));
    fixesByAction.set(key, fixSet);
  }

  for (const [actionIndex, fixSet] of fixesByAction.entries()) {
    if (fixSet.size > 1) {
      conflicts.push(`Conflicting fixes for action index ${actionIndex}`);
    }
  }

  return conflicts.sort((left, right) => left.localeCompare(right));
}

export function applyFixes(ast: AST, results: RuleResult[]): AST {
  const cloned = deepClone(ast);
  const fixes = [...results]
    .filter((entry): entry is RuleResult & { fix: ASTNode } => entry.fix !== undefined)
    .sort((left, right) => left.ruleId.localeCompare(right.ruleId));

  if (fixes.length === 0) {
    return cloned;
  }

  if (cloned.type === "sequence") {
    const actions = [...cloned.actions];
    for (const fix of fixes) {
      if (fix.actionIndex === undefined || fix.actionIndex < 0 || fix.actionIndex >= actions.length) {
        throw new Error(`Invalid fix action index for rule ${fix.ruleId}`);
      }

      actions[fix.actionIndex] = deepClone(fix.fix);
    }

    return {
      type: "sequence",
      actions,
    };
  }

  const first = fixes[0];
  if (first.actionIndex !== undefined && first.actionIndex !== 0) {
    throw new Error(`Invalid fix action index for non-sequence AST in rule ${first.ruleId}`);
  }

  return deepClone(first.fix);
}

export function semanticEquivalent(before: AST, after: AST): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

function formatIssues(label: string, issues: ValidationIssue[]): string {
  const detail = issues
    .map((entry) => `- [${entry.code}] ${entry.path}: ${entry.message}`)
    .join("\n");

  return `${label}\n${detail}`;
}

function assertValidation(label: string, validation: ValidationResult): void {
  const errors = validation.issues.filter((entry) => entry.severity === "error");
  if (errors.length > 0) {
    throw new Error(formatIssues(label, errors));
  }
}

export function processAST(
  ast: AST,
  context: SystemContext,
  rules: Rule[] = DEFAULT_RULES,
  options?: ProcessASTOptions
): ProcessedAST {
  const structure = validateStructure(ast);
  assertValidation("AST structure validation failed", structure);

  const semantics = validateSemantics(ast, context);
  assertValidation("AST semantic validation failed", semantics);

  const crossNode = validateCrossNode(ast, context);
  assertValidation("AST cross-node validation failed", crossNode);

  const incremental = runIncrementalRules(ast, rules, context, {
    state: options?.incrementalState ?? defaultIncrementalRuleState,
    consistencyCheck: options?.consistencyCheck ?? "never",
  });

  const results = incremental.results;
  const ruleErrors = results.filter((entry) => entry.severity === "error");
  if (ruleErrors.length > 0) {
    const mapped: ValidationIssue[] = ruleErrors.map((entry, index) => issue(
      `rule-${entry.ruleId}`,
      "error",
      entry.message,
      entry.actionIndex === undefined ? `rule[${index}]` : toActionPath(entry.actionIndex)
    ));
    throw new Error(formatIssues("Rule validation failed", mapped));
  }

  const conflicts = detectConflicts(results);
  if (conflicts.length > 0) {
    throw new Error(`Rule conflict detected:\n${conflicts.map((entry) => `- ${entry}`).join("\n")}`);
  }

  const fixedAst = applyFixes(ast, results);
  if (!semanticEquivalent(ast, fixedAst)) {
    throw new Error("Rule fixes changed AST semantics");
  }

  return {
    ast: fixedAst,
    results,
    trace: {
      ast: fixedAst,
      validationPassed: true,
      rulesTriggered: Array.from(new Set(results.map((entry) => entry.ruleId))).sort((left, right) => left.localeCompare(right)),
      conflicts,
      incremental: incremental.trace,
      performance: incremental.metrics,
    },
  };
}

export function validateIdentifier(value: string): boolean {
  return CHOIR_IDENTIFIER_PATTERN.test(value);
}
