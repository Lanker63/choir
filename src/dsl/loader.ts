import fs from "fs";
import yaml from "yaml";
import { DSLRule } from "./types.js";

export function loadDSLRules(path: string): DSLRule[] {
  console.log("Loading DSL rules from", path);
  const raw = fs.readFileSync(path, "utf-8");

  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    return yaml.parse(raw);
  }

  return JSON.parse(raw);
}