import { DSLRule } from "./types.js";

function validateDSLStructure(rules: DSLRule[]) {
  const errors: string[] = [];

  for (const rule of rules) {
    if (!rule.id) errors.push("Missing rule id");
    if (!rule.match) errors.push(`${rule.id}: missing match`);
    if (!rule.constraint) errors.push(`${rule.id}: missing constraint`);
  }

  return errors;
}