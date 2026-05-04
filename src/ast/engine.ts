import { EnforcementContext } from "../core/context.js";
import { Violation } from "../core/types.js";
import { parseAST } from "./parser.js";
import ts from "typescript";
import { RuleRegistry } from "../rules/registry.js";

export function runAST(
  context: EnforcementContext,
  registry: RuleRegistry
): Violation[] {
  parseAST(context);

  const violations: Violation[] = [];

  const rules = registry.getASTRules();

  for (const file of context.files) {
    const ast = context.astMap.get(file.path) as ts.SourceFile;

    for (const rule of rules) {
      violations.push(...rule.evaluate(file.path, ast));
    }
  }

  return violations;
}