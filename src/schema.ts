import { z } from "zod";

export const StrategySchema = z.object({
    project: z.object({
        name: z.string().min(1),
        goals: z.array(z.string()).default([])
    }),

    standards: z.object({
        language: z.enum(["typescript", "javascript"]).optional(),
        linting: z.string().optional(),
        testing: z.string().optional()
    }).default({}),

    constraints: z.array(z.string()).default([]),

    architecture: z.object({
        layers: z.array(z.string()).default([]),
        rules: z.array(z.string()).default([])
    }).default({ layers: [], rules: [] })
});

export type Strategy = z.infer<typeof StrategySchema>;