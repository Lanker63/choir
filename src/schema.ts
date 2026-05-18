import { z } from "zod";
import { DSLRuleSchema } from "./dsl/types.js";

export const CONTROL_PLANE_VERSION = "1.0.0";

const PlanDerivedFromSchema = z.enum(["goal", "constraint", "manual"]);
const PlanStatusSchema = z.enum(["draft", "approved"]);
const TaskTypeSchema = z.enum([
    "analysis",
    "refactor",
    "create",
    "delete",
    "enforce",
    "generate-typescript-module",
    "generate-api-route",
    "generate-model",
    "generate-controller",
    "generate-tests",
    "generate-config",
    "apply-ast-patch",
    "create-directory",
    "create-project-structure",
]);

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

const RuntimeModeSchema = z.enum([
    "observe-only",
    "simulation-only",
    "approval-required",
    "execution-enabled",
    "distributed-control",
]);

const RuntimeCapabilitiesSchema = z.object({
    preview: z.boolean().optional(),
    simulate: z.boolean().optional(),
    execute: z.boolean().optional(),
    optimize: z.boolean().optional(),
    import: z.boolean().optional(),
    install: z.boolean().optional(),
    update: z.boolean().optional(),
}).strict();

const StrategicPrioritySchema = z.enum([
    "correctness",
    "auditability",
    "rollback-safety",
    "minimal-blast-radius",
    "deterministic-replay",
    "iteration-speed",
    "developer-autonomy",
    "dependency-safety",
    "stability",
]);

const OptimizationGoalSchema = z.enum([
    "minimal-blast-radius",
    "deterministic-replay",
    "rapid-delivery",
    "low-governance-friction",
    "dependency-isolation",
    "rollback-minimized",
    "parallel-throughput",
]);

const RiskToleranceSchema = z.enum(["low", "moderate", "high"]);

const ArchitecturalPostureSchema = z.enum([
    "conservative",
    "highly-reviewed",
    "exploratory",
    "adaptive",
    "strict-boundaries",
    "performance-optimized",
]);

const RolloutPreferenceSchema = z.enum([
    "canary-required",
    "phased-required",
    "phased-optional",
    "all-at-once-allowed",
    "parallel-optimized",
]);

const StabilityProfileSchema = z.enum(["stable", "adaptive", "experimental"]);
const GovernanceIntensitySchema = z.enum(["strict", "moderate", "relaxed"]);

const StrategicIntentPartialSchema = z.object({
    mission: z.string().optional(),
    priorities: z.array(StrategicPrioritySchema).optional(),
    optimizationGoals: z.array(OptimizationGoalSchema).optional(),
    riskTolerance: RiskToleranceSchema.optional(),
    architecturalPosture: z.array(ArchitecturalPostureSchema).optional(),
    rolloutPreferences: z.array(RolloutPreferenceSchema).optional(),
    stabilityProfile: StabilityProfileSchema.optional(),
    governanceIntensity: GovernanceIntensitySchema.optional(),
}).strict();

const DomainStrategicSchema = z.object({
    mission: z.string().optional(),
    strategicIntent: StrategicIntentPartialSchema.optional(),
}).strict();

const PackageStrategicSchema = z.object({
    domain: z.string().min(1).optional(),
    strategicIntent: StrategicIntentPartialSchema.optional(),
}).strict();

const ContextStrategicSchema = z.object({
    domain: z.string().min(1).optional(),
    packages: z.array(z.string().min(1)).optional(),
    strategicIntent: StrategicIntentPartialSchema.optional(),
}).strict();

const RuntimeSchema = z.object({
    mode: RuntimeModeSchema.default("execution-enabled"),
}).strict();

const PackageRuntimeModeSchema = z.object({
    mode: RuntimeModeSchema.optional(),
    capabilities: RuntimeCapabilitiesSchema.optional(),
}).strict();

const PolicyRoleSchema = z.enum(["architect", "analyst", "conductor", "enforcer"]);
const PolicyEnvironmentSchema = z.enum(["local", "ci", "staging", "production"]);

export const ControlPlaneSchema = z.object({
    version: z.string().min(1),
    registries: z.array(z.string().min(1)).optional(),
    mission: z.string().default(""),
    vision: z.string().default(""),
    intent: z.object({
        goals: z.array(z.string()).default([]),
        constraints: z.array(z.string()).default([]),
        "non-goals": z.array(z.string()).default([])
    }).strict(),
    strategicIntent: StrategicIntentPartialSchema.optional(),
    domains: z.record(z.string().min(1), DomainStrategicSchema).optional(),
    packages: z.record(z.string().min(1), PackageStrategicSchema).optional(),
    contexts: z.record(z.string().min(1), ContextStrategicSchema).optional(),
    policy: z.object({
        rules: z.array(DSLRuleSchema).default([]),
        priorityOverrides: z.object({
            AST: z.number().finite().optional(),
            semantic: z.number().finite().optional(),
            strategy: z.number().finite().optional(),
            pattern: z.number().finite().optional(),
        }).strict().optional()
    }).strict(),
    execution: ExecutionSchema.default({ plans: [] }),
    runtime: RuntimeSchema.optional(),
    capabilities: RuntimeCapabilitiesSchema.optional(),
    packageModes: z.record(z.string().min(1), PackageRuntimeModeSchema).optional(),
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

    if (control.packageModes) {
        for (const [packageName, packageMode] of Object.entries(control.packageModes)) {
            if (packageName.trim().length === 0) {
                context.addIssue({
                    code: "custom",
                    message: "packageModes keys must be non-empty",
                    path: ["packageModes"],
                });
            }

            if (!packageMode.mode && !packageMode.capabilities) {
                context.addIssue({
                    code: "custom",
                    message: `Package mode \"${packageName}\" must define mode and/or capabilities`,
                    path: ["packageModes", packageName],
                });
            }
        }

        if (control.runtime && Object.keys(control.packageModes).length > 0) {
            context.addIssue({
                code: "custom",
                message: "cannot define both global runtime and packageModes",
                path: ["runtime"],
            });
            context.addIssue({
                code: "custom",
                message: "cannot define both global runtime and packageModes",
                path: ["packageModes"],
            });
        }

        if (control.strategicIntent && Object.keys(control.packageModes).length > 0) {
            context.addIssue({
                code: "custom",
                message: "cannot define both global strategicIntent and packageModes",
                path: ["strategicIntent"],
            });
            context.addIssue({
                code: "custom",
                message: "cannot define both global strategicIntent and packageModes",
                path: ["packageModes"],
            });
        }
    }

    const hasDomainCatalog = Object.keys(control.domains ?? {}).length > 0;

    for (const [packageName, packageConfig] of Object.entries(control.packages ?? {})) {
        if (hasDomainCatalog && packageConfig.domain && !Object.prototype.hasOwnProperty.call(control.domains ?? {}, packageConfig.domain)) {
            context.addIssue({
                code: "custom",
                message: `Package "${packageName}" maps to unknown domain "${packageConfig.domain}"`,
                path: ["packages", packageName, "domain"],
            });
        }
    }

    for (const [contextName, contextConfig] of Object.entries(control.contexts ?? {})) {
        if (hasDomainCatalog && contextConfig.domain && !Object.prototype.hasOwnProperty.call(control.domains ?? {}, contextConfig.domain)) {
            context.addIssue({
                code: "custom",
                message: `Context "${contextName}" maps to unknown domain "${contextConfig.domain}"`,
                path: ["contexts", contextName, "domain"],
            });
        }

        if (contextConfig.packages) {
            for (let packageIndex = 0; packageIndex < contextConfig.packages.length; packageIndex += 1) {
                const packageName = contextConfig.packages[packageIndex] as string;
                if (!Object.prototype.hasOwnProperty.call(control.packages ?? {}, packageName)) {
                    context.addIssue({
                        code: "custom",
                        message: `Context "${contextName}" references unknown package "${packageName}"`,
                        path: ["contexts", contextName, "packages", packageIndex],
                    });
                }
            }
        }
    }
});

export type ControlPlane = z.infer<typeof ControlPlaneSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type PolicyRole = z.infer<typeof PolicyRoleSchema>;
export type PolicyEnvironment = z.infer<typeof PolicyEnvironmentSchema>;
export type StrategicPriority = z.infer<typeof StrategicPrioritySchema>;
export type OptimizationGoal = z.infer<typeof OptimizationGoalSchema>;
export type RiskTolerance = z.infer<typeof RiskToleranceSchema>;
export type ArchitecturalPosture = z.infer<typeof ArchitecturalPostureSchema>;
export type RolloutPreference = z.infer<typeof RolloutPreferenceSchema>;
export type StabilityProfile = z.infer<typeof StabilityProfileSchema>;
export type GovernanceIntensity = z.infer<typeof GovernanceIntensitySchema>;