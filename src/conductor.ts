import { analyzeWorkspace, findHotspots } from "./analyst.js";
import { runPipelineForWorkspace } from "./enforcer.js";
import {
  buildCostTrace,
  CostTrace,
  scorePlan,
  scorePlans,
  selectPlanSet,
} from "./core/costPlanner.js";
import { generatePlan, getExecutableTasks, taskExecutionKey } from "./core/orchestration.js";
import {
  MAX_STRATEGIES,
  StrategyResult,
  StrategyTrace,
  buildStrategyTrace,
  evaluateStrategies,
  selectBestStrategy,
} from "./core/strategyPlanner.js";
import { ExecutionPreview, generateExecutionPreview } from "./core/executionPreview.js";
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

export type CostBasedExecutionResult = {
  selectedPlans: Plan[];
  costTrace: CostTrace;
  strategyTraces: {
    basePlanId: string;
    selectedStrategyId: string;
    trace: StrategyTrace;
  }[];
  executionTraces: ExecutionTrace[];
  state: StatePlane;
};

export type PreviewSelectionResult = {
  preview: ExecutionPreview;
  costTrace: CostTrace;
  selectedPlan: Plan;
  basePlanId: string;
  strategyTrace: StrategyTrace;
};

type SelectedStrategyPlan = {
  basePlan: Plan;
  selected: StrategyResult;
  trace: StrategyTrace;
};

function sortedPlans(plans: Plan[]): Plan[] {
  return [...plans].sort((left, right) => left.id.localeCompare(right.id));
}

function normalizePreviewHash(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }

  const trimmed = input.trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(trimmed)) {
    return trimmed;
  }

  return undefined;
}

export function getApprovedPlans(control: ControlPlane): Plan[] {
  return sortedPlans(control.execution.plans.filter((plan) => plan.status === "approved"));
}

export function selectApprovedPlansForExecution(
  control: ControlPlane,
  state: StatePlane,
  requestedPlanId?: string
): { selectedPlans: Plan[]; costTrace: CostTrace } {
  const allPlans = sortedPlans(control.execution.plans);

  if (requestedPlanId) {
    const requested = allPlans.find((plan) => plan.id === requestedPlanId);
    if (!requested) {
      throw new Error(`Plan not found: ${requestedPlanId}`);
    }

    if (requested.status !== "approved") {
      throw new Error(`Plan ${requested.id} is ${requested.status}. Approve it before execution.`);
    }

    const scored = scorePlans([requested], state);
    const selectedPlans = selectPlanSet([requested], state);
    const costTrace = buildCostTrace(selectedPlans[0]!.id, scored);
    return { selectedPlans, costTrace };
  }

  const approvedPlans = getApprovedPlans(control);
  if (approvedPlans.length === 0) {
    throw new Error("No approved plans available for execution.");
  }

  const scored = scorePlans(approvedPlans, state);
  const selectedPlans = selectPlanSet(approvedPlans, state);
  const costTrace = buildCostTrace(selectedPlans[0]!.id, scored);

  return {
    selectedPlans,
    costTrace,
  };
}

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

export async function executeSelectedPlansWithCost(
  control: ControlPlane,
  options: {
    root: string;
    requestedPlanId?: string;
  }
): Promise<CostBasedExecutionResult> {
  let state = readStatePlane(options.root) ?? createEmptyStatePlane();

  const { selectedPlans, costTrace } = selectApprovedPlansForExecution(
    control,
    state,
    options.requestedPlanId
  );

  const planned: SelectedStrategyPlan[] = [];

  for (const basePlan of sortedPlans(selectedPlans)) {
    const baseCost = scorePlan(basePlan, state).totalCost;
    const strategyResults = await evaluateStrategies(basePlan, state, {
      controlPlane: control,
      maxStrategies: MAX_STRATEGIES,
      costThreshold: baseCost * 4,
    });

    const selectedStrategy = selectBestStrategy(strategyResults);
    const strategyTrace = buildStrategyTrace(strategyResults, selectedStrategy);

    planned.push({
      basePlan,
      selected: selectedStrategy,
      trace: strategyTrace,
    });
  }

  const strategyTraces: CostBasedExecutionResult["strategyTraces"] = [];
  const executionTraces: ExecutionTrace[] = [];
  const executablePlans: Plan[] = [];

  for (const plan of planned) {
    strategyTraces.push({
      basePlanId: plan.basePlan.id,
      selectedStrategyId: plan.selected.strategyId,
      trace: plan.trace,
    });

    const executed = await executePlan(plan.selected.plan, {
      controlPlane: control,
      root: options.root,
    });

    state = executed.state;
    executionTraces.push(executed.trace);
    executablePlans.push(plan.selected.plan);
  }

  return {
    selectedPlans: sortedPlans(executablePlans),
    costTrace,
    strategyTraces,
    executionTraces,
    state,
  };
}

export async function generateSelectedPlanPreview(
  control: ControlPlane,
  options: {
    root: string;
    requestedPlanId?: string;
  }
): Promise<PreviewSelectionResult> {
  const state = readStatePlane(options.root) ?? createEmptyStatePlane();
  const { selectedPlans, costTrace } = selectApprovedPlansForExecution(control, state, options.requestedPlanId);

  const basePlan = sortedPlans(selectedPlans)[0];
  if (!basePlan) {
    throw new Error("No approved plans available for preview.");
  }

  const baseCost = scorePlan(basePlan, state).totalCost;
  const strategyResults = await evaluateStrategies(basePlan, state, {
    controlPlane: control,
    maxStrategies: MAX_STRATEGIES,
    costThreshold: baseCost * 4,
  });
  const selectedStrategy = selectBestStrategy(strategyResults);
  const strategyTrace = buildStrategyTrace(strategyResults, selectedStrategy);

  const preview = await generateExecutionPreview(selectedStrategy.plan, {
    root: options.root,
    controlPlane: control,
    state,
    strategy: {
      strategyId: selectedStrategy.strategyId,
      cost: selectedStrategy.cost.totalCost,
    },
  });

  updateExecutionState(options.root, (current) => ({
    ...current,
    lastPreview: {
      hash: preview.hash,
      planId: basePlan.id,
      strategyId: selectedStrategy.strategyId,
    },
  }));

  return {
    preview,
    costTrace,
    selectedPlan: selectedStrategy.plan,
    basePlanId: basePlan.id,
    strategyTrace,
  };
}

export async function executeSelectedPlansWithPreviewGuard(
  control: ControlPlane,
  options: {
    root: string;
    previewId?: string;
    requestedPlanId?: string;
  }
): Promise<CostBasedExecutionResult & { previewHash: string }> {
  const expectedHash = normalizePreviewHash(options.previewId);
  if (!expectedHash) {
    throw new Error("Execution requires a preview hash. Run: @choir.conductor preview [planId], then execute <planId> <previewHash>.");
  }

  const state = readStatePlane(options.root) ?? createEmptyStatePlane();
  const lastPreview = state.execution.lastPreview;
  if (!lastPreview || normalizePreviewHash(lastPreview.hash) !== expectedHash) {
    throw new Error("Preview hash is not approved in state. Generate a fresh preview before execution.");
  }

  if (options.requestedPlanId && lastPreview.planId !== options.requestedPlanId) {
    throw new Error(`Preview hash was generated for ${lastPreview.planId}. Generate preview for ${options.requestedPlanId} before execution.`);
  }

  const recomputed = await generateSelectedPlanPreview(control, {
    root: options.root,
    requestedPlanId: options.requestedPlanId,
  });

  if (normalizePreviewHash(recomputed.preview.hash) !== expectedHash) {
    throw new Error("Preview hash mismatch. Workspace or control plane changed; re-run preview before execution.");
  }

  const executed = await executeSelectedPlansWithCost(control, {
    root: options.root,
    requestedPlanId: options.requestedPlanId,
  });

  return {
    ...executed,
    previewHash: expectedHash,
  };
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
