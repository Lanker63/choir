import { createHash } from "crypto";
import { ApprovalPolicyRule } from "../schema.js";
import { ChoirConfig, canonicalizeConfig } from "./dslYamlCompiler.js";

export type PolicyRule = {
  id: string;
  match: {
    path: string;
    operation: "add" | "remove" | "update";
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
  diffCount: number;
  rulesMatched: string[];
  requiresApproval: boolean;
  denied: boolean;
  decision: string;
};

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
  const normalizedRule = normalizePath(rulePath);
  const normalizedDiff = normalizePath(diffPath);
  return normalizedDiff === normalizedRule || normalizedDiff.startsWith(`${normalizedRule}.`);
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
  if (rule.match.operation !== diff.operation) {
    return false;
  }

  if (!matchesPath(rule.match.path, diff.path)) {
    return false;
  }

  return matchesCondition(rule, diff);
}

export function evaluatePolicies(
  diffs: YAMLDiff[],
  policies: PolicySet
): { result: PolicyResult; trace: PolicyTrace } {
  let requiresApproval = false;
  let allowed = true;
  const violations: { ruleId: string; message: string }[] = [];
  const matchedRuleIds = new Set<string>();

  const orderedDiffs = [...diffs].sort((left, right) =>
    left.path.localeCompare(right.path)
    || operationRank(left.operation) - operationRank(right.operation)
  );
  const orderedRules = [...policies.rules].sort((left, right) => left.id.localeCompare(right.id));

  for (const diff of orderedDiffs) {
    for (const rule of orderedRules) {
      if (!matches(rule, diff)) {
        continue;
      }

      matchedRuleIds.add(rule.id);

      if (rule.effect.type === "deny") {
        allowed = false;
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

  const result: PolicyResult = {
    allowed,
    requiresApproval,
    violations,
  };

  const denied = !allowed;
  const decision = denied
    ? "deny"
    : (requiresApproval ? "require-approval" : "allow");

  return {
    result,
    trace: {
      diffCount: orderedDiffs.length,
      rulesMatched: [...matchedRuleIds].sort((a, b) => a.localeCompare(b)),
      requiresApproval,
      denied,
      decision,
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
          path: rule.match.path,
          operation: rule.match.operation,
        },
        ...(rule.condition ? { condition: rule.condition } : {}),
        effect: {
          type: rule.effect.type,
          ...(rule.effect.message ? { message: rule.effect.message } : {}),
        },
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}
