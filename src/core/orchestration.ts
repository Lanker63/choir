import { createHash } from "crypto";
import { ControlPlane, Plan, Task } from "../schema.js";
import { StatePlane } from "./state.js";

export function taskExecutionKey(planId: string, taskId: string): string {
  return `${planId}:${taskId}`;
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "scope";
}

function primaryGoal(control: ControlPlane): { value?: string; derivedFrom: Plan["derivedFrom"] } {
  const goals = sortedUnique(control.intent.goals);
  if (goals.length > 0) {
    return { value: goals[0], derivedFrom: "goal" };
  }

  const constraints = sortedUnique(control.intent.constraints);
  if (constraints.length > 0) {
    return { value: constraints[0], derivedFrom: "constraint" };
  }

  return { derivedFrom: "manual" };
}

function normalizeFilePath(value: string): string {
  return value.split("\\").join("/");
}

function moduleFromFilePath(filePath: string): string {
  const normalized = normalizeFilePath(filePath);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return "workspace";
  }

  if (segments[0] === "src" && segments.length > 1) {
    return segments[1];
  }

  return segments[0];
}

function buildViolationScope(state: StatePlane): {
  modules: string[];
  filesByModule: Record<string, string[]>;
} {
  const byModule = new Map<string, Set<string>>();

  for (const violation of state.violations) {
    const filePath = normalizeFilePath(violation.location.file);
    const moduleName = moduleFromFilePath(filePath);
    const existing = byModule.get(moduleName) ?? new Set<string>();
    existing.add(filePath);
    byModule.set(moduleName, existing);
  }

  const modules = [...byModule.keys()].sort((left, right) => left.localeCompare(right));
  const filesByModule = Object.fromEntries(
    modules.map((moduleName) => {
      const files = [...(byModule.get(moduleName) ?? new Set<string>())].sort((left, right) => left.localeCompare(right));
      return [moduleName, files] as const;
    })
  );

  return {
    modules,
    filesByModule,
  };
}

function deterministicPlanId(control: ControlPlane, state: StatePlane): string {
  const stableInput = {
    goals: sortedUnique(control.intent.goals),
    constraints: sortedUnique(control.intent.constraints),
    nonGoals: sortedUnique(control.intent["non-goals"]),
    violations: [...state.violations]
      .map((violation) => ({
        ruleId: violation.ruleId,
        file: normalizeFilePath(violation.location.file),
        startLine: violation.location.start.line,
        startCharacter: violation.location.start.character,
        message: violation.message,
      }))
      .sort((left, right) => {
        if (left.file !== right.file) return left.file.localeCompare(right.file);
        if (left.startLine !== right.startLine) return left.startLine - right.startLine;
        if (left.startCharacter !== right.startCharacter) return left.startCharacter - right.startCharacter;
        if (left.ruleId !== right.ruleId) return left.ruleId.localeCompare(right.ruleId);
        return left.message.localeCompare(right.message);
      }),
  };

  const digest = createHash("sha256").update(JSON.stringify(stableInput)).digest("hex");
  return `plan-${digest.slice(0, 12)}`;
}

function buildRefactorTasks(
  modules: string[],
  filesByModule: Record<string, string[]>,
  constraints: string[],
  analysisTaskId: string
): Task[] {
  if (modules.length === 0) {
    return [{
      id: "refactor-alignment",
      title: "Refactor for policy alignment",
      description: "Implement deterministic fixes for known violations and architecture drift.",
      type: "refactor",
      dependsOn: [analysisTaskId],
      successCriteria: [
        "Planned fixes are applied through the enforcer pipeline",
        "No new policy violations are introduced",
        ...(constraints.length > 0 ? [`Constraints retained: ${constraints.join("; ")}`] : []),
      ],
    }];
  }

  const slugCounts = new Map<string, number>();

  return modules.map((moduleName) => {
    const baseSlug = slugify(moduleName);
    const seen = slugCounts.get(baseSlug) ?? 0;
    slugCounts.set(baseSlug, seen + 1);
    const taskId = seen === 0 ? `refactor-${baseSlug}` : `refactor-${baseSlug}-${seen + 1}`;

    return {
      id: taskId,
      title: `Refactor ${moduleName}`,
      description: `Apply enforcer-driven fixes for module ${moduleName}.`,
      type: "refactor",
      scope: {
        modules: [moduleName],
        files: filesByModule[moduleName] ?? [],
      },
      dependsOn: [analysisTaskId],
      successCriteria: [
        `Violations in module ${moduleName} are reduced or eliminated`,
        ...(constraints.length > 0 ? [`Constraints retained: ${constraints.join("; ")}`] : []),
      ],
    };
  });
}

export function generatePlan(control: ControlPlane, state: StatePlane): Plan {
  const { value: selectedGoal, derivedFrom } = primaryGoal(control);
  const { modules, filesByModule } = buildViolationScope(state);
  const constraints = sortedUnique(control.intent.constraints);
  const analysisTaskId = "analysis-violations";
  const refactorTasks = buildRefactorTasks(modules, filesByModule, constraints, analysisTaskId)
    .sort((left, right) => left.id.localeCompare(right.id));

  const enforceTask: Task = {
    id: "enforce-policy",
    title: "Run enforcement validation",
    description: "Execute the enforcer pipeline after refactors to validate architectural integrity.",
    type: "enforce",
    dependsOn: refactorTasks.map((task) => task.id),
    successCriteria: [
      "Enforcer pipeline completes successfully",
      "Blocking diagnostics are not increased",
    ],
  };

  const analysisTask: Task = {
    id: analysisTaskId,
    title: "Analyze policy and violations",
    description: "Collect violation inventory and establish deterministic refactor scope.",
    type: "analysis",
    dependsOn: [],
    scope: {
      files: sortedUnique(state.violations.map((violation) => normalizeFilePath(violation.location.file))),
      modules,
    },
    successCriteria: [
      "Violation inventory is grouped by module",
      "Dependencies for downstream tasks are explicit",
    ],
  };

  const title = selectedGoal
    ? `Plan for ${selectedGoal}`
    : "Plan for policy alignment";

  const description = selectedGoal
    ? `Deterministic orchestration for goal: ${selectedGoal}`
    : "Deterministic orchestration derived from constraints and current state.";

  return {
    id: deterministicPlanId(control, state),
    title,
    description,
    derivedFrom,
    ...(selectedGoal ? { goalRefs: [selectedGoal] } : {}),
    tasks: [analysisTask, ...refactorTasks, enforceTask],
    status: "draft",
  };
}

function isTaskComplete(plan: Plan, state: StatePlane, taskId: string): boolean {
  const key = taskExecutionKey(plan.id, taskId);
  return state.execution.taskStatus[key] === "complete";
}

export function getExecutableTasks(plan: Plan, state: StatePlane): Task[] {
  return plan.tasks.filter((task) => {
    const taskKey = taskExecutionKey(plan.id, task.id);
    if (state.execution.taskStatus[taskKey] === "complete") {
      return false;
    }

    const dependencies = task.dependsOn ?? [];
    return dependencies.every((dependencyId) => isTaskComplete(plan, state, dependencyId));
  });
}
