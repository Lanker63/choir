import ts from "typescript";
import { DSLRule, ASTRule, RuleContext } from "./types.js";
import { RuleRegistry } from "../rules/registry.js";
import { ControlPlane } from "../schema.js";
import { Diagnostic } from "../core/types.js";
import { makeDiagnosticId, sourceLocationFromOffsets } from "../core/diagnostics.js";
import { visitDepthFirst } from "../ast/visitor.js";
import { Fix } from "../fix/types.js";
import { SemanticMutation } from "../core/semanticMutation.js";

export type Rule = ASTRule;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function deriveIntentRules(control: ControlPlane): DSLRule[] {
  const derived: DSLRule[] = [];

  for (const constraint of control.intent.constraints) {
    const normalized = constraint.toLowerCase();

    if (normalized.includes("no direct db access")) {
      derived.push({
        id: "intent-no-direct-db-access",
        description: "Derived from intent constraint: no direct db access",
        match: {
          callExpressions: ["db.query", "db.execute", "sequelize.query"],
          imports: ["pg", "mysql", "mysql2", "knex"]
        },
        constraint: {
          type: "forbid"
        },
        message: "Intent violation: direct database access is forbidden",
        severity: "error"
      });
      continue;
    }

    if (normalized.includes("no eval")) {
      derived.push({
        id: "intent-no-eval",
        description: "Derived from intent constraint: no eval",
        match: {
          callExpressions: ["eval", "Function"]
        },
        constraint: {
          type: "forbid"
        },
        message: "Intent violation: eval-style execution is forbidden",
        severity: "error"
      });
      continue;
    }

    if (normalized.includes("no console.log") || normalized.includes("no console log")) {
      derived.push({
        id: "intent-no-console-log",
        description: "Derived from intent constraint: no console.log",
        match: {
          callExpressions: ["console.log"],
        },
        constraint: {
          type: "forbid",
        },
        message: "Intent violation: console.log usage is forbidden",
        severity: "warning",
      });
      continue;
    }

    const id = `intent-constraint-${slugify(constraint)}`;
    derived.push({
      id,
      description: `Derived from intent constraint: ${constraint}`,
      match: {
        functionNames: []
      },
      constraint: {
        type: "require"
      },
      message: `Intent note: constraint declared but not yet modeled as an executable matcher: ${constraint}`,
      severity: "info"
    });
  }

  for (const goal of control.intent.goals) {
    const normalized = goal.toLowerCase();
    if (!normalized.includes("security") && !normalized.includes("secure")) {
      continue;
    }

    derived.push({
      id: `intent-goal-${slugify(goal)}`,
      description: `Derived from intent goal: ${goal}`,
      match: {
        callExpressions: ["eval", "Function"]
      },
      constraint: {
        type: "forbid"
      },
      message: `Goal violation: secure goal disallows eval-style execution (${goal})`,
      severity: "warning"
    });
  }

  return derived;
}

function mergeRules(derivedRules: DSLRule[], explicitRules: DSLRule[]): DSLRule[] {
  const mergedById = new Map<string, DSLRule>();

  for (const rule of derivedRules) {
    mergedById.set(rule.id, rule);
  }

  for (const rule of explicitRules) {
    mergedById.set(rule.id, rule);
  }

  return Array.from(mergedById.values());
}

export function compileControlPlaneToRules(control: ControlPlane): Rule[] {
  const derivedRules = deriveIntentRules(control);
  const explicitRules = control.policy.rules;
  const mergedRules = mergeRules(derivedRules, explicitRules);
  return mergedRules.map((rule) => compileDSLRule(rule));
}

export function compileDSLRule(rule: DSLRule): ASTRule {
  return {
    id: rule.id,
    priority: rule.priority ?? 100,

    evaluate(context: RuleContext) {
      const diagnostics: Diagnostic[] = [];
      const fixes: Fix[] = [];
      const { filePath, sourceFile } = context;

      let diagnosticIndex = 0;

      const emitDiagnostic = (node: ts.Node, message: string): string => {
        const start = node.getStart(sourceFile);
        const end = node.getEnd();
        const location = sourceLocationFromOffsets(sourceFile, filePath, start, end);
        const diagnosticId = makeDiagnosticId([rule.id, filePath, location.start.line, location.start.character, diagnosticIndex]);

        diagnostics.push({
          id: diagnosticId,
          ruleId: rule.id,
          message,
          severity: rule.severity ?? "error",
          location,
          category: "AST",
          traceId: context.traceId,
        });

        diagnosticIndex += 1;
        return diagnosticId;
      };

      const emitImportRemovalFix = (node: ts.ImportDeclaration, diagnosticId: string): void => {
        const start = node.getStart(sourceFile);
        const end = node.getEnd();
        const before = sourceFile.getFullText();
        const after = `${before.slice(0, start)}${before.slice(end)}`;
        const semanticMutations: SemanticMutation[] = [{
          kind: "UpsertFile",
          file: filePath,
          content: after,
        }];

        fixes.push({
          id: makeDiagnosticId([rule.id, filePath, "fix", start, end]),
          ruleId: rule.id,
          title: `Remove forbidden import: ${node.moduleSpecifier.getText(sourceFile)}`,
          diagnosticIds: [diagnosticId],
          patches: [{
            type: "delete",
            location: sourceLocationFromOffsets(sourceFile, filePath, start, end),
          }],
          isPreferred: true,
          isSafe: true,
          traceId: context.traceId,
          semanticMutations,
        });
      };

      visitDepthFirst(sourceFile, (node) => {
        const nodeId = context.resolveNodeId(node);
        const nodeType = nodeId ? context.semanticGraph.getType(nodeId) : undefined;

        // IMPORT MATCHING
        if (rule.match.imports && ts.isImportDeclaration(node)) {
          const module = ts.isStringLiteral(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : node.moduleSpecifier.getText(sourceFile);

          const matched = rule.match.imports.some(i =>
            module.includes(i)
          );

          if (matched && rule.constraint.type === "forbid") {
            const diagnosticId = emitDiagnostic(node, rule.message);
            emitImportRemovalFix(node, diagnosticId);
          }
        }

        if (rule.match.astSelectors?.importModules && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const module = node.moduleSpecifier.text;
          const isExternal = !module.startsWith(".");
          const matched = rule.match.astSelectors.importModules.some((candidate) =>
            candidate === "*" ? true : module.includes(candidate)
          );
          const semanticGate = rule.match.semanticPredicates?.externalImportsOnly === true
            ? isExternal
            : true;

          const resolvedPredicate = (rule.match.semanticPredicates?.resolvedImportIncludes ?? []).length === 0
            ? true
            : (rule.match.semanticPredicates?.resolvedImportIncludes ?? []).some((candidate) => module.includes(candidate));

          if (matched && semanticGate && resolvedPredicate && rule.constraint.type === "forbid") {
            const diagnosticId = emitDiagnostic(node, rule.message);
            emitImportRemovalFix(node, diagnosticId);
          }
        }

        // CALL EXPRESSION MATCHING
        if (rule.match.callExpressions && ts.isCallExpression(node)) {
          const name = node.expression.getText(sourceFile);

          const matched = rule.match.callExpressions.some((c) =>
            c === "*" ? true : name.includes(c)
          );

          if (matched && rule.constraint.type === "forbid") {
            const typeInfo = nodeType ? ` (type: ${context.semanticGraph.getType(nodeId!)?.flags ?? "unknown"})` : "";
            emitDiagnostic(node, `${rule.message}${typeInfo}`);
          }
        }

        if (rule.match.astSelectors?.callTargets && ts.isCallExpression(node)) {
          const callTarget = node.expression.getText(sourceFile);
          const selectorMatched = rule.match.astSelectors.callTargets.some((candidate) =>
            candidate === "*" ? true : callTarget.includes(candidate)
          );
          const symbolGate = (rule.match.semanticPredicates?.symbolNames ?? []).length === 0
            ? true
            : (rule.match.semanticPredicates?.symbolNames ?? []).some((symbolName) => callTarget.includes(symbolName));

          if (selectorMatched && symbolGate && rule.constraint.type === "forbid") {
            emitDiagnostic(node, rule.message);
          }
        }

        if (rule.match.graphPolicies?.forbiddenImportPathIncludes && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const module = node.moduleSpecifier.text;
          const blockedByPolicy = rule.match.graphPolicies.forbiddenImportPathIncludes.some((candidate) => module.includes(candidate))
            || rule.match.graphPolicies.forbiddenImportPathIncludes.some((candidate) =>
              context.workspaceGraph?.hasImportPathIncludes(filePath, candidate) ?? false
            );
          if (blockedByPolicy && rule.constraint.type === "forbid") {
            emitDiagnostic(node, rule.message);
          }
        }
      });

      return {
        diagnostics,
        ...(fixes.length > 0
          ? { fixes: fixes.sort((left, right) => left.id.localeCompare(right.id)) }
          : {}),
      };
    },
  };
}

function compileAndRegister(
  dslRules: DSLRule[],
  registry: RuleRegistry
) {
  for (const rule of dslRules) {
    const compiled = compileDSLRule(rule);
    registry.registerAST(compiled);
  }
}