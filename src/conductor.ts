import { analyzeWorkspace, findHotspots } from "./analyst.js";
import { runPipelineForWorkspace } from "./enforcer.js";
import { generatePlan, getExecutableTasks, taskExecutionKey } from "./core/orchestration.js";
import {
  createEmptyStatePlane,
  ExecutionState,
  readStatePlane,
  StatePlane,
  updateExecutionState,
} from "./core/state.js";
import { ExecutionTrace } from "./core/types.js";
import { ControlPlane, Plan, Task } from "./schema.js";

export type TaskResult = {
  taskId: string;
  ok: boolean;
  route: "choir.analyst" | "choir.enforcer" | "stub";
  output: unknown;
  decisions: string[];
};

export type PlanStatusRow = {
  planId: string;
  title: string;
  status: Plan["status"];
  totalTasks: number;
  pending: number;
  inProgress: number;
  complete: number;
  failed: number;
};

export type PlanStatusSummary = {
  activePlanId?: string;
  plans: PlanStatusRow[];
};

export function upsertDraftPlan(
  control: ControlPlane,
  state: StatePlane,
  goalOverride?: string
): { updatedControl: ControlPlane; plan: Plan; replaced: boolean } {
  const trimmedGoal = goalOverride?.trim();
  const planningControl = trimmedGoal && trimmedGoal.length > 0
    ? {
      ...control,
      intent: {
        ...control.intent,
        goals: [trimmedGoal],
      },
    }
    : control;

  const generated = generatePlan(planningControl, state);
  const plan: Plan = {
    ...generated,
    ...(trimmedGoal && trimmedGoal.length > 0 ? { goalRefs: [trimmedGoal] } : {}),
    status: "draft",
  };

  const existingIndex = control.execution.plans.findIndex((existing) => existing.id === plan.id);
  const nextPlans = existingIndex >= 0
    ? control.execution.plans.map((existing, index) => index === existingIndex ? plan : existing)
    : [...control.execution.plans, plan];

  const updatedControl: ControlPlane = {
    ...control,
    execution: {
      ...control.execution,
      plans: [...nextPlans].sort((left, right) => left.id.localeCompare(right.id)),
    },
  };

  return {
    updatedControl,
    plan,
    replaced: existingIndex >= 0,
  };
}

export function approvePlan(control: ControlPlane, planId: string): {
  updatedControl: ControlPlane;
  plan?: Plan;
} {
  const existingPlan = control.execution.plans.find((plan) => plan.id === planId);
  if (!existingPlan) {
    return { updatedControl: control };
  }

  const approvedPlan: Plan = {
    ...existingPlan,
    status: "approved",
  };

  const updatedControl: ControlPlane = {
    ...control,
    execution: {
      ...control.execution,
      plans: control.execution.plans
        .map((plan) => plan.id === planId ? approvedPlan : plan)
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
  };

  return {
    updatedControl,
    plan: approvedPlan,
  };
}

export async function executeTask(
  task: Task,
  options: { controlPlane: ControlPlane; root: string }
): Promise<TaskResult> {
  if (task.type === "analysis") {
    const summary = analyzeWorkspace();
    const hotspots = findHotspots();
    return {
      taskId: task.id,
      ok: true,
      route: "choir.analyst",
      output: {
        summary,
        hotspots,
      },
      decisions: [`Task ${task.id} routed to choir.analyst`],
    };
  }

  if (task.type === "create") {
    return {
      taskId: task.id,
      ok: true,
      route: "stub",
      output: {
        message: "Create task is a deterministic stub and performs no direct code edits.",
      },
      decisions: [`Task ${task.id} routed to create stub`],
    };
  }

  const pipelineResult = await runPipelineForWorkspace({
    controlPlane: options.controlPlane,
    root: options.root,
    publishResultDiagnostics: false,
  });

  if (!pipelineResult) {
    return {
      taskId: task.id,
      ok: false,
      route: "choir.enforcer",
      output: {
        message: "No workspace root available for enforcer execution.",
      },
      decisions: [`Task ${task.id} failed because enforcer could not resolve workspace root`],
    };
  }

  const blockingDiagnostics = pipelineResult.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const ok = blockingDiagnostics === 0;

  return {
    taskId: task.id,
    ok,
    route: "choir.enforcer",
    output: {
      diagnostics: pipelineResult.diagnostics.length,
      blockingDiagnostics,
      appliedPatches: pipelineResult.appliedPatches.filter((patch) => patch.success).length,
    },
    decisions: [
      `Task ${task.id} routed to choir.enforcer`,
      `Enforcer diagnostics=${pipelineResult.diagnostics.length}, blocking=${blockingDiagnostics}`,
    ],
  };
}

function taskStatus(state: ExecutionState, planId: string, taskId: string): ExecutionState["taskStatus"][string] {
  return state.taskStatus[taskExecutionKey(planId, taskId)] ?? "pending";
}

function setTaskState(
  root: string,
  planId: string,
  taskId: string,
  status: "pending" | "in-progress" | "complete" | "failed",
  detail: string,
  result?: unknown
): StatePlane {
  const key = taskExecutionKey(planId, taskId);
  return updateExecutionState(root, (current) => ({
    ...current,
    taskStatus: {
      ...current.taskStatus,
      [key]: status,
    },
    taskResults: result === undefined
      ? current.taskResults
      : {
        ...current.taskResults,
        [key]: result,
      },
    history: [
      ...current.history,
      {
        planId,
        taskId,
        status,
        detail,
      },
    ],
  })).state;
}

export async function executePlan(
  plan: Plan,
  options: { controlPlane: ControlPlane; root: string }
): Promise<{ state: StatePlane; trace: ExecutionTrace }> {
  const trace: ExecutionTrace = {
    planId: plan.id,
    tasksExecuted: [],
    tasksSucceeded: [],
    tasksFailed: [],
    decisions: [],
  };

  let state = readStatePlane(options.root) ?? createEmptyStatePlane();

  state = updateExecutionState(options.root, (current) => {
    const seededTaskStatus = { ...current.taskStatus };

    for (const task of plan.tasks) {
      const key = taskExecutionKey(plan.id, task.id);
      if (!seededTaskStatus[key]) {
        seededTaskStatus[key] = "pending";
      }
    }

    return {
      ...current,
      activePlanId: plan.id,
      taskStatus: seededTaskStatus,
      history: [
        ...current.history,
        {
          planId: plan.id,
          status: "pending",
          detail: "Plan execution started",
        },
      ],
    };
  }).state;

  trace.decisions.push(`Initialized ${plan.tasks.length} task(s)`);

  while (true) {
    const executableTasks = getExecutableTasks(plan, state).filter((task) => {
      const status = taskStatus(state.execution, plan.id, task.id);
      return status !== "complete" && status !== "in-progress";
    });

    if (executableTasks.length === 0) {
      break;
    }

    for (const task of executableTasks) {
      trace.tasksExecuted.push(task.id);
      state = setTaskState(options.root, plan.id, task.id, "in-progress", "Task execution started");

      try {
        const result = await executeTask(task, options);
        trace.decisions.push(...result.decisions);

        if (result.ok) {
          trace.tasksSucceeded.push(task.id);
          state = setTaskState(options.root, plan.id, task.id, "complete", "Task completed", result.output);
          continue;
        }

        trace.tasksFailed.push(task.id);
        state = setTaskState(options.root, plan.id, task.id, "failed", "Task failed", result.output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        trace.tasksFailed.push(task.id);
        trace.decisions.push(`Task ${task.id} threw error: ${message}`);
        state = setTaskState(options.root, plan.id, task.id, "failed", `Task error: ${message}`);
      }
    }
  }

  const unresolvedTasks = plan.tasks.filter((task) => {
    const status = taskStatus(state.execution, plan.id, task.id);
    return status !== "complete" && status !== "failed";
  });

  for (const task of unresolvedTasks) {
    trace.tasksFailed.push(task.id);
    state = setTaskState(
      options.root,
      plan.id,
      task.id,
      "failed",
      "Task blocked because dependencies never reached complete"
    );
  }

  const finalStatus: "complete" | "failed" = trace.tasksFailed.length === 0 ? "complete" : "failed";
  state = updateExecutionState(options.root, (current) => ({
    ...current,
    activePlanId: undefined,
    history: [
      ...current.history,
      {
        planId: plan.id,
        status: finalStatus,
        detail: finalStatus === "complete" ? "Plan execution completed" : "Plan execution failed",
      },
    ],
  })).state;

  trace.decisions.push(
    finalStatus === "complete"
      ? "Plan completed with all tasks successful"
      : "Plan completed with task failures"
  );

  return { state, trace };
}

export function summarizePlanStatus(control: ControlPlane, state: StatePlane): PlanStatusSummary {
  const plans = control.execution.plans
    .map((plan) => {
      let pending = 0;
      let inProgress = 0;
      let complete = 0;
      let failed = 0;

      for (const task of plan.tasks) {
        const status = taskStatus(state.execution, plan.id, task.id);
        if (status === "pending") pending += 1;
        if (status === "in-progress") inProgress += 1;
        if (status === "complete") complete += 1;
        if (status === "failed") failed += 1;
      }

      return {
        planId: plan.id,
        title: plan.title,
        status: plan.status,
        totalTasks: plan.tasks.length,
        pending,
        inProgress,
        complete,
        failed,
      } satisfies PlanStatusRow;
    })
    .sort((left, right) => left.planId.localeCompare(right.planId));

  return {
    ...(state.execution.activePlanId ? { activePlanId: state.execution.activePlanId } : {}),
    plans,
  };
}
