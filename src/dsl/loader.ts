import fs from "fs";
import yaml from "yaml";
import { DSLRule } from "./types";

export function loadDSLRules(path: string): DSLRule[] {
  const raw = fs.readFileSync(path, "utf-8");

  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    return yaml.parse(raw);
  }

  return JSON.parse(raw);
}