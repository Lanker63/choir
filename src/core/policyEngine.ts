import { createHash } from "crypto";
import { ApprovalPolicyRule, PolicyEnvironment, PolicyRole } from "../schema.js";
import { ChoirConfig, canonicalizeConfig } from "./dslYamlCompiler.js";

export type Role = PolicyRole;
export type Environment = PolicyEnvironment;
export type PolicySource = "org" | "repo" | "environment";
export type InheritanceOperator = "assign" | "append" | "remove";

export type ExecutionContext = {
  role: Role;
  environment: Environment;
};

export type PolicyRule = {
  id: string;
  policyId?: string;
  source?: PolicySource;
  inheritanceOperator?: InheritanceOperator;
  override?: {
    allowed: boolean;
    scope: "child" | "none";
  };
  match: {
    path?: string;
    operation?: "add" | "remove" | "update";
  };
  scope?: {
    roles?: Role[];
    environments?: Environment[];
  };
  condition?: {
    contains?: string;
    countGreaterThan?: number;
  };
  effect: {
    type: "allow" | "require-approval" | "deny";
    message?: string;
  };
};

export type PolicySet = {
  rules: PolicyRule[];
};

export type YAMLDiff = {
  path: string;
  operation: "add" | "remove" | "update";
  before?: unknown;
  after?: unknown;
};

export type PolicyResult = {
  allowed: boolean;
  requiresApproval: boolean;
  violations: {
    ruleId: string;
    message: string;
  }[];
};

export type PolicyTrace = {
  role: Role;
  environment: Environment;
  diffCount: number;
  rulesMatched: string[];
  requiresApproval: boolean;
  denied: boolean;
  decision: "allow" | "require-approval" | "deny";
  policyDslTrace: PolicyDSLTrace[];
  inheritanceTrace: PolicyInheritanceTrace;
};

export type PolicyDSLTrace = {
  policyId: string;
  source: PolicySource;
  matched: boolean;
  effect: "allow" | "require-approval" | "deny";
};

export type PolicyInheritanceTrace = {
  matchedRules: {
    policyId: string;
    source: PolicySource;
    effect: "allow" | "require-approval" | "deny";
  }[];
  finalDecision: "allow" | "require-approval" | "deny";
};

export type PolicyAction = "modify-yaml" | "read-only" | "plan" | "preview" | "execute";

const ROLE_CAPABILITIES: Record<Role, PolicyAction[]> = {
  architect: ["modify-yaml"],
  analyst: ["read-only"],
  conductor: ["plan", "preview"],
  enforcer: ["execute"],
};

export function validateRole(ctx: ExecutionContext, action: PolicyAction): void {
  const capabilities = ROLE_CAPABILITIES[ctx.role] ?? [];
  if (!capabilities.includes(action)) {
    throw new Error(`Role violation: ${ctx.role} cannot ${action}`);
  }
}

export function detectEnvironment(): Environment {
  if (process.env.CI) {
    return "ci";
  }

  if (process.env.CHOIR_ENVIRONMENT === "staging") {
    return "staging";
  }

  if (process.env.NODE_ENV === "production" || process.env.CHOIR_ENVIRONMENT === "production") {
    return "production";
  }

  return "local";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareUnknown(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (!compareUnknown(left[index], right[index])) {
        return false;
      }
    }

    return true;
  }

  if (isRecord(left) && isRecord(right)) {
    const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      if (!compareUnknown(left[key], right[key])) {
        return false;
      }
    }

    return true;
  }

  return false;
}

function pathFor(parent: string, key: string): string {
  return parent.length === 0 ? key : `${parent}.${key}`;
}

function arrayPathFor(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

function pushDiff(
  diffs: YAMLDiff[],
  path: string,
  operation: "add" | "remove" | "update",
  before: unknown,
  after: unknown
): void {
  diffs.push({
    path,
    operation,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  });
}

function walkDiff(before: unknown, after: unknown, currentPath: string, diffs: YAMLDiff[]): void {
  if (compareUnknown(before, after)) {
    return;
  }

  if (before === undefined) {
    pushDiff(diffs, currentPath, "add", undefined, after);
    return;
  }

  if (after === undefined) {
    pushDiff(diffs, currentPath, "remove", before, undefined);
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const maxLength = Math.max(before.length, after.length);
    for (let index = 0; index < maxLength; index += 1) {
      walkDiff(before[index], after[index], arrayPathFor(currentPath, index), diffs);
    }

    return;
  }

  if (isRecord(before) && isRecord(after)) {
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      walkDiff(before[key], after[key], pathFor(currentPath, key), diffs);
    }

    return;
  }

  pushDiff(diffs, currentPath, "update", before, after);
}

function operationRank(operation: YAMLDiff["operation"]): number {
  if (operation === "add") return 0;
  if (operation === "update") return 1;
  return 2;
}

export function computeDiff(oldConfig: ChoirConfig, newConfig: ChoirConfig): YAMLDiff[] {
  const before = canonicalizeConfig(oldConfig);
  const after = canonicalizeConfig(newConfig);
  const diffs: YAMLDiff[] = [];

  walkDiff(before, after, "", diffs);

  return diffs
    .map((diff) => ({
      ...diff,
      path: diff.path.startsWith(".") ? diff.path.slice(1) : diff.path,
    }))
    .filter((diff) => diff.path.length > 0)
    .sort((left, right) =>
      left.path.localeCompare(right.path)
      || operationRank(left.operation) - operationRank(right.operation)
      || JSON.stringify(left.before ?? null).localeCompare(JSON.stringify(right.before ?? null))
      || JSON.stringify(left.after ?? null).localeCompare(JSON.stringify(right.after ?? null))
    );
}

function normalizePath(path: string): string {
  return path.replace(/\[\d+\]/g, "");
}

function matchesPath(rulePath: string, diffPath: string): boolean {
  if (rulePath.trim() === "*") {
    return true;
  }

  const normalizedRule = normalizePath(rulePath);
  const normalizedDiff = normalizePath(diffPath);
  return normalizedDiff === normalizedRule || normalizedDiff.startsWith(`${normalizedRule}.`);
}

export function matchesScope(rule: PolicyRule, ctx: ExecutionContext): boolean {
  if (rule.scope?.roles && rule.scope.roles.length > 0 && !rule.scope.roles.includes(ctx.role)) {
    return false;
  }

  if (rule.scope?.environments && rule.scope.environments.length > 0 && !rule.scope.environments.includes(ctx.environment)) {
    return false;
  }

  return true;
}

function sourceValueForCondition(diff: YAMLDiff): unknown {
  if (diff.operation === "remove") {
    return diff.before;
  }

  return diff.after;
}

function matchesCondition(rule: PolicyRule, diff: YAMLDiff): boolean {
  if (!rule.condition) {
    return true;
  }

  const source = sourceValueForCondition(diff);

  if (typeof rule.condition.contains === "string") {
    const needle = rule.condition.contains.toLowerCase();
    const haystack = String(source ?? "").toLowerCase();
    if (!haystack.includes(needle)) {
      return false;
    }
  }

  if (typeof rule.condition.countGreaterThan === "number") {
    const count = Array.isArray(source)
      ? source.length
      : (source === undefined || source === null ? 0 : 1);
    if (!(count > rule.condition.countGreaterThan)) {
      return false;
    }
  }

  return true;
}

function matches(rule: PolicyRule, diff: YAMLDiff): boolean {
  if (rule.match.operation && rule.match.operation !== diff.operation) {
    return false;
  }

  if (rule.match.path && !matchesPath(rule.match.path, diff.path)) {
    return false;
  }

  return matchesCondition(rule, diff);
}

export function evaluatePolicies(
  diffs: YAMLDiff[],
  policies: PolicySet,
  ctx: ExecutionContext
): { result: PolicyResult; trace: PolicyTrace } {
  let denyDetected = false;
  let requiresApproval = false;
  const violations: { ruleId: string; message: string }[] = [];
  const matchedRuleIds = new Set<string>();

  const orderedDiffs = [...diffs].sort((left, right) =>
    left.path.localeCompare(right.path)
    || operationRank(left.operation) - operationRank(right.operation)
  );
  const orderedRules = [...policies.rules].sort((left, right) => left.id.localeCompare(right.id));
  const dslTraceByPolicy = new Map<string, PolicyDSLTrace>();
  const matchedInheritanceRules = new Map<string, { policyId: string; source: PolicySource; effect: "allow" | "require-approval" | "deny" }>();

  for (const rule of orderedRules) {
    if (!rule.policyId || !rule.source) {
      continue;
    }

    const key = `${rule.source}:${rule.policyId}`;
    if (!dslTraceByPolicy.has(key)) {
      dslTraceByPolicy.set(key, {
        policyId: rule.policyId,
        source: rule.source,
        matched: false,
        effect: rule.effect.type,
      });
    }
  }

  for (const diff of orderedDiffs) {
    for (const rule of orderedRules) {
      if (!matchesScope(rule, ctx)) {
        continue;
      }

      if (!matches(rule, diff)) {
        continue;
      }

      matchedRuleIds.add(rule.id);
      if (rule.policyId && rule.source) {
        const key = `${rule.source}:${rule.policyId}`;
        dslTraceByPolicy.set(key, {
          policyId: rule.policyId,
          source: rule.source,
          matched: true,
          effect: rule.effect.type,
        });

        matchedInheritanceRules.set(key, {
          policyId: rule.policyId,
          source: rule.source,
          effect: rule.effect.type,
        });
      }

      if (rule.effect.type === "deny") {
        denyDetected = true;
        violations.push({
          ruleId: rule.id,
          message: rule.effect.message ?? `Denied by policy rule ${rule.id}`,
        });
      }

      if (rule.effect.type === "require-approval") {
        requiresApproval = true;
      }
    }
  }

  const decision: "allow" | "require-approval" | "deny" = denyDetected
    ? "deny"
    : (requiresApproval ? "require-approval" : "allow");

  const result: PolicyResult = {
    allowed: decision !== "deny",
    requiresApproval: decision === "require-approval",
    violations,
  };

  return {
    result,
    trace: {
      role: ctx.role,
      environment: ctx.environment,
      diffCount: orderedDiffs.length,
      rulesMatched: [...matchedRuleIds].sort((a, b) => a.localeCompare(b)),
      requiresApproval: decision === "require-approval",
      denied: decision === "deny",
      decision,
      policyDslTrace: [...dslTraceByPolicy.values()]
        .sort((left, right) =>
          left.source.localeCompare(right.source)
          || left.policyId.localeCompare(right.policyId)
        ),
      inheritanceTrace: {
        matchedRules: [...matchedInheritanceRules.values()]
          .sort((left, right) =>
            left.source.localeCompare(right.source)
            || left.policyId.localeCompare(right.policyId)
          ),
        finalDecision: decision,
      },
    },
  };
}

export function hashDiff(diffs: YAMLDiff[]): string {
  const canonical = [...diffs].sort((left, right) =>
    left.path.localeCompare(right.path)
    || operationRank(left.operation) - operationRank(right.operation)
    || JSON.stringify(left.before ?? null).localeCompare(JSON.stringify(right.before ?? null))
    || JSON.stringify(left.after ?? null).localeCompare(JSON.stringify(right.after ?? null))
  );

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function toPolicySet(rules: ApprovalPolicyRule[]): PolicySet {
  return {
    rules: [...rules]
      .map((rule) => ({
        id: rule.id,
        match: {
          ...(rule.match.path ? { path: rule.match.path } : {}),
          ...(rule.match.operation ? { operation: rule.match.operation } : {}),
        },
        ...(rule.scope
          ? {
            scope: {
              ...(Array.isArray(rule.scope.roles) ? { roles: [...rule.scope.roles].sort((a, b) => a.localeCompare(b)) } : {}),
              ...(Array.isArray(rule.scope.environments)
                ? { environments: [...rule.scope.environments].sort((a, b) => a.localeCompare(b)) }
                : {}),
            },
          }
          : {}),
        ...(rule.condition ? { condition: rule.condition } : {}),
        effect: {
          type: rule.effect.type,
          ...(rule.effect.message ? { message: rule.effect.message } : {}),
        },
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function formatPolicyInheritanceTrace(trace: PolicyInheritanceTrace): string {
  const lines = ["Effective Policy:", ""];

  for (const matched of trace.matchedRules) {
    lines.push(`[${matched.source.toUpperCase()}] ${matched.effect} ${matched.policyId}`);
  }

  lines.push("");
  lines.push(`Final Decision: ${trace.finalDecision.toUpperCase()}`);

  return lines.join("\n");
}
