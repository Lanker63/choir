import { z } from "zod";
import { DSLRuleSchema } from "./dsl/types.js";

export const CONTROL_PLANE_VERSION = "1.0.0";

const PlanDerivedFromSchema = z.enum(["goal", "constraint", "manual"]);
const PlanStatusSchema = z.enum(["draft", "approved"]);
const TaskTypeSchema = z.enum(["analysis", "refactor", "create", "delete", "enforce"]);

const TaskScopeSchema = z.object({
    files: z.array(z.string().min(1)).optional(),
    modules: z.array(z.string().min(1)).optional(),
}).strict();

export type TaskDependencyNode = {
    id: string;
    dependsOn?: string[];
};

export function detectCycle(tasks: TaskDependencyNode[]): string[] | null {
    const dependencyMap = new Map<string, string[]>(
        tasks.map((task) => [task.id, [...(task.dependsOn ?? [])]])
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];

    const visit = (taskId: string): string[] | null => {
        if (visiting.has(taskId)) {
            const cycleStart = stack.indexOf(taskId);
            return [...stack.slice(cycleStart), taskId];
        }

        if (visited.has(taskId)) {
            return null;
        }

        visiting.add(taskId);
        stack.push(taskId);

        const dependencies = [...(dependencyMap.get(taskId) ?? [])].sort((left, right) => left.localeCompare(right));
        for (const dependencyId of dependencies) {
            if (!dependencyMap.has(dependencyId)) {
                continue;
            }

            const cycle = visit(dependencyId);
            if (cycle) {
                return cycle;
            }
        }

        stack.pop();
        visiting.delete(taskId);
        visited.add(taskId);
        return null;
    };

    const orderedTaskIds = [...dependencyMap.keys()].sort((left, right) => left.localeCompare(right));
    for (const taskId of orderedTaskIds) {
        const cycle = visit(taskId);
        if (cycle) {
            return cycle;
        }
    }

    return null;
}

const TaskSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    type: TaskTypeSchema,
    scope: TaskScopeSchema.optional(),
    dependsOn: z.array(z.string().min(1)).default([]),
    successCriteria: z.array(z.string().min(1)).min(1),
}).strict();

const PlanSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    derivedFrom: PlanDerivedFromSchema,
    goalRefs: z.array(z.string().min(1)).optional(),
    tasks: z.array(TaskSchema).default([]),
    status: PlanStatusSchema,
}).strict().superRefine((plan, context) => {
    const taskIdToIndexes = new Map<string, number[]>();

    for (let taskIndex = 0; taskIndex < plan.tasks.length; taskIndex += 1) {
        const task = plan.tasks[taskIndex];
        const existing = taskIdToIndexes.get(task.id) ?? [];
        existing.push(taskIndex);
        taskIdToIndexes.set(task.id, existing);
    }

    for (const [taskId, indexes] of taskIdToIndexes.entries()) {
        if (indexes.length <= 1) {
            continue;
        }

        for (const taskIndex of indexes) {
            context.addIssue({
                code: "custom",
                message: `Duplicate task id \"${taskId}\" in plan \"${plan.id}\"`,
                path: ["tasks", taskIndex, "id"],
            });
        }
    }

    const taskIdSet = new Set(plan.tasks.map((task) => task.id));
    for (let taskIndex = 0; taskIndex < plan.tasks.length; taskIndex += 1) {
        const task = plan.tasks[taskIndex];
        for (let dependencyIndex = 0; dependencyIndex < task.dependsOn.length; dependencyIndex += 1) {
            const dependencyId = task.dependsOn[dependencyIndex];
            if (dependencyId === task.id) {
                context.addIssue({
                    code: "custom",
                    message: `Task \"${task.id}\" cannot depend on itself`,
                    path: ["tasks", taskIndex, "dependsOn", dependencyIndex],
                });
                continue;
            }

            if (!taskIdSet.has(dependencyId)) {
                context.addIssue({
                    code: "custom",
                    message: `Task \"${task.id}\" depends on unknown task \"${dependencyId}\"`,
                    path: ["tasks", taskIndex, "dependsOn", dependencyIndex],
                });
            }
        }
    }

    const cycle = detectCycle(plan.tasks);
    if (cycle) {
        context.addIssue({
            code: "custom",
            message: `Circular task dependency detected: ${cycle.join(" -> ")}`,
            path: ["tasks"],
        });
    }
});

const ExecutionSchema = z.object({
    plans: z.array(PlanSchema).default([]),
}).strict();

const ApprovalPolicyOperationSchema = z.enum(["add", "remove", "update"]);
const PolicyRoleSchema = z.enum(["architect", "analyst", "conductor", "enforcer"]);
const PolicyEnvironmentSchema = z.enum(["local", "ci", "staging", "production"]);

const ApprovalPolicyRuleSchema = z.object({
    id: z.string().min(1),
    match: z.object({
        path: z.string().min(1).optional(),
        operation: ApprovalPolicyOperationSchema.optional(),
        macro: z.string().min(1).optional(),
    }).strict().superRefine((match, context) => {
        if (!match.path && !match.operation && !match.macro) {
            context.addIssue({
                code: "custom",
                message: "Policy match requires at least one selector: path, operation, or macro",
                path: [],
            });
        }
    }),
    scope: z.object({
        roles: z.array(PolicyRoleSchema).optional(),
        environments: z.array(PolicyEnvironmentSchema).optional(),
    }).strict().optional(),
    condition: z.object({
        contains: z.string().optional(),
        countGreaterThan: z.number().int().optional(),
    }).strict().optional(),
    effect: z.object({
        type: z.enum(["allow", "require-approval", "deny"]),
        message: z.string().optional(),
    }).strict(),
}).strict();

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
        approvalRules: z.array(ApprovalPolicyRuleSchema).default([]),
        priorityOverrides: z.object({
            AST: z.number().finite().optional(),
            semantic: z.number().finite().optional(),
            strategy: z.number().finite().optional(),
            pattern: z.number().finite().optional(),
        }).strict().optional()
    }).strict(),
    execution: ExecutionSchema.default({ plans: [] }),
}).strict().superRefine((control, context) => {
    const planIdToIndexes = new Map<string, number[]>();

    for (let planIndex = 0; planIndex < control.execution.plans.length; planIndex += 1) {
        const plan = control.execution.plans[planIndex];
        const existing = planIdToIndexes.get(plan.id) ?? [];
        existing.push(planIndex);
        planIdToIndexes.set(plan.id, existing);
    }

    for (const [planId, indexes] of planIdToIndexes.entries()) {
        if (indexes.length <= 1) {
            continue;
        }

        for (const planIndex of indexes) {
            context.addIssue({
                code: "custom",
                message: `Duplicate plan id \"${planId}\"`,
                path: ["execution", "plans", planIndex, "id"],
            });
        }
    }
});

export type ControlPlane = z.infer<typeof ControlPlaneSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type ApprovalPolicyRule = z.infer<typeof ApprovalPolicyRuleSchema>;
export type PolicyRole = z.infer<typeof PolicyRoleSchema>;
export type PolicyEnvironment = z.infer<typeof PolicyEnvironmentSchema>;