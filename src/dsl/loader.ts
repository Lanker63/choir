import fs from "fs";
import yaml from "yaml";
import { DSLRule, DSLRulesSchema } from "./types.js";

type UnknownRecord = Record<string, unknown>;

const LEGACY_MATCH_KEYS = ["imports", "callExpressions", "functionNames"] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLegacyRule(rule: unknown): unknown {
  if (!isRecord(rule)) {
    return rule;
  }

  const normalized: UnknownRecord = { ...rule };

  if (!isRecord(normalized.constraint)) {
    return normalized;
  }

  const constraint: UnknownRecord = { ...normalized.constraint };
  const match: UnknownRecord = isRecord(normalized.match) ? { ...normalized.match } : {};

  for (const key of LEGACY_MATCH_KEYS) {
    const legacyValue = constraint[key];
    if (!Array.isArray(legacyValue)) {
      continue;
    }

    const existing = match[key];
    if (Array.isArray(existing)) {
      match[key] = Array.from(new Set([...existing, ...legacyValue]));
    } else {
      match[key] = legacyValue;
    }

    delete constraint[key];
  }

  normalized.constraint = constraint;
  if (Object.keys(match).length > 0 || normalized.match !== undefined) {
    normalized.match = match;
  }

  return normalized;
}

function normalizeParsedRules(parsed: unknown): unknown {
  if (!Array.isArray(parsed)) {
    return parsed;
  }

  return parsed.map((rule) => normalizeLegacyRule(rule));
}

export function loadDSLRules(path: string): DSLRule[] {
  console.log("Loading DSL rules from", path);
  const raw = fs.readFileSync(path, "utf-8");
  const parsed = path.endsWith(".yaml") || path.endsWith(".yml")
    ? yaml.parse(raw)
    : JSON.parse(raw);
  const normalized = normalizeParsedRules(parsed);

  const result = DSLRulesSchema.safeParse(normalized);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const at = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
        return `- ${issue.message}${at}`;
      })
      .join("\n");

    throw new Error(`Invalid DSL rules:\n${details}`);
  }

  return result.data;
}