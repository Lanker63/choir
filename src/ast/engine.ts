import { EnforcementContext } from "../core/context";
import { Violation } from "../core/types";
import { parseAST } from "./parser";
import ts from "typescript";
import { RuleRegistry } from "../rules/registry";

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