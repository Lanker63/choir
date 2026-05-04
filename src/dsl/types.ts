import { z } from "zod";
import ts from "typescript";
import { Diagnostic } from "../core/types.js";
import { NodeId, ReadonlyNormalizedAST } from "../ast/model.js";
import { ReadonlySemanticGraph } from "../semantic/graph.js";
import { Fix } from "../fix/types.js";

export const DSLSeverityValues = [
  "error",
  "warn",
  "warning",
  "info",
  "information",
  "hint",
] as const;

export const DSLRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  priority: z.number().int().optional(),

  appliesTo: z
    .object({
      files: z.array(z.string()).optional(),
      language: z.string().optional(),
    })
    .strict()
    .optional(),

  match: z
    .object({
      imports: z.array(z.string()).optional(),
      callExpressions: z.array(z.string()).optional(),
      functionNames: z.array(z.string()).optional(),
    })
    .strict(),

  constraint: z
    .object({
      type: z.enum(["forbid", "require"]),
    })
    .strict(),

  message: z.string().min(1),
  severity: z.enum(DSLSeverityValues).optional(),
}).strict();

export const DSLRulesSchema = z.array(DSLRuleSchema);
export const dslSchema = z.toJSONSchema(DSLRulesSchema, { target: "draft-07" });

export type DSLRule = z.infer<typeof DSLRuleSchema>;

export interface RuleContext {
  filePath: string;
  sourceFile: ts.SourceFile;
  normalizedAst: ReadonlyNormalizedAST;
  semanticGraph: ReadonlySemanticGraph;
  traceId: string;
  resolveNodeId(node: ts.Node): NodeId | undefined;
}

export interface RuleResult {
  diagnostics: Diagnostic[];
  fixes?: Fix[];
}

/**
 * Compiled AST rule
 */
export interface ASTRule {
  id: string;
  priority: number;
  evaluate(context: RuleContext): RuleResult;
}