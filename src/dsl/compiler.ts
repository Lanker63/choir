import ts from "typescript";
import { DSLRule, ASTRule } from "./types.js";
import { RuleRegistry } from "../rules/registry.js";

export function compileDSLRule(rule: DSLRule): ASTRule {
  return {
    id: rule.id,

    evaluate(file, ast) {
      const violations: any[] = [];

      function visit(node: ts.Node) {
        // IMPORT MATCHING
        if (rule.match.imports && ts.isImportDeclaration(node)) {
          const module = node.moduleSpecifier.getText();

          const matched = rule.match.imports.some(i =>
            module.includes(i)
          );

          if (matched && rule.constraint.type === "forbid") {
            violations.push({
              ruleId: rule.id,
              message: rule.message,
              file,
              start: node.getStart(),
              end: node.getEnd(),
              severity: rule.severity ?? "error",
            });
          }
        }

        // CALL EXPRESSION MATCHING
        if (rule.match.callExpressions && ts.isCallExpression(node)) {
          const name = node.expression.getText();

          const matched = rule.match.callExpressions.some(c =>
            name.includes(c)
          );

          if (
            matched &&
            rule.constraint.type === "forbid"
          ) {
            violations.push({
              ruleId: rule.id,
              message: rule.message,
              file,
              start: node.getStart(),
              end: node.getEnd(),
              severity: rule.severity ?? "error",
            });
          }
        }

        ts.forEachChild(node, visit);
      }

      visit(ast as ts.Node);

      return violations;
    },
  };
}

export function compileAndRegister(
  dslRules: DSLRule[],
  registry: RuleRegistry
) {
  for (const rule of dslRules) {
    const compiled = compileDSLRule(rule);
    registry.registerAST(compiled);
  }
}