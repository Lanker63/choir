import {
  AST,
  ActionNode,
  CHOIR_IDENTIFIER_PATTERN,
  DefineType,
} from "./choirRouter.js";
import { ControlPlane } from "../schema.js";

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
};

export type SystemContext = {
  controlPlane: ControlPlane;
};

export type ValidationTrace = {
  ast: AST;
  validationPassed: boolean;
  rulesTriggered: string[];
  conflicts: string[];
};

export type ProcessedAST = {
  ast: AST;
  results: RuleResult[];
  trace: ValidationTrace;
};

const DEFINE_TYPES = new Set<DefineType>([
  "mission",
  "vision",
  "goal",
  "constraint",
  "non-goal",
]);

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

export const DEFAULT_RULES: Rule[] = [
  {
    id: "warn-execute-without-plan-ref",
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

export function runRules(ast: AST, rules: Rule[], context: SystemContext): RuleResult[] {
  const actions = asActions(ast);
  const ordered = [...rules].sort((left, right) => left.id.localeCompare(right.id));
  const results: RuleResult[] = [];

  for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
    const action = actions[actionIndex];
    for (const rule of ordered) {
      if (!rule.match(action)) {
        continue;
      }

      const outcome = rule.validate(action, {
        system: context,
        rootAst: ast,
        actionIndex,
      });

      if (!outcome) {
        continue;
      }

      results.push({
        ...outcome,
        actionIndex,
      });
    }
  }

  return results;
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

export function processAST(ast: AST, context: SystemContext, rules: Rule[] = DEFAULT_RULES): ProcessedAST {
  const structure = validateStructure(ast);
  assertValidation("AST structure validation failed", structure);

  const semantics = validateSemantics(ast, context);
  assertValidation("AST semantic validation failed", semantics);

  const crossNode = validateCrossNode(ast, context);
  assertValidation("AST cross-node validation failed", crossNode);

  const results = runRules(ast, rules, context);
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
    },
  };
}

export function validateIdentifier(value: string): boolean {
  return CHOIR_IDENTIFIER_PATTERN.test(value);
}
