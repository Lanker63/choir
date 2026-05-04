import fs from "fs";
import yaml from "yaml";
import { DSLRule, DSLRulesSchema } from "./types.js";

export function loadDSLRules(path: string): DSLRule[] {
  console.log("Loading DSL rules from", path);
  const raw = fs.readFileSync(path, "utf-8");
  const parsed = path.endsWith(".yaml") || path.endsWith(".yml")
    ? yaml.parse(raw)
    : JSON.parse(raw);

  const result = DSLRulesSchema.safeParse(parsed);
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