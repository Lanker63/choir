import { z } from "zod";

export const DSLSeverityValues = ["error", "warn", "info"] as const;

export const DSLRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),

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

/**
 * Compiled AST rule
 */
export interface ASTRule {
  id: string;
  evaluate(file: string, ast: unknown): any[];
}