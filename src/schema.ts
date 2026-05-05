import { z } from "zod";
import { DSLRuleSchema } from "./dsl/types.js";

export const CONTROL_PLANE_VERSION = "1.0.0";

export const ControlPlaneSchema = z.object({
    version: z.string().min(1),
    mission: z.string().default(""),
    vision: z.string().default(""),
    intent: z.object({
        goals: z.array(z.string()).default([]),
        constraints: z.array(z.string()).default([]),
        "non-goals": z.array(z.string()).default([])
    }).strict(),
    policy: z.object({
        rules: z.array(DSLRuleSchema).default([]),
        priorityOverrides: z.object({
            AST: z.number().finite().optional(),
            semantic: z.number().finite().optional(),
            strategy: z.number().finite().optional(),
            pattern: z.number().finite().optional(),
        }).strict().optional()
    }).strict()
}).strict();

export type ControlPlane = z.infer<typeof ControlPlaneSchema>;