import { analyzeWorkspace, findHotspots } from "./analyst.js";
import { runPipelineForWorkspace } from "./enforcer.js";
import { recordAudit } from "./core/audit.js";
import {
  buildCostTrace,
  CostTrace,
  scorePlans,
  selectPlanSet,
} from "./core/costPlanner.js";
import { generatePlan, getExecutableTasks, taskExecutionKey } from "./core/orchestration.js";
import {
  StrategyOutcome,
  StrategyType,
  StrategyTrace,
  adaptiveStrategySelection,
  buildStrategyTrace,
} from "./core/strategyPlanner.js";
import { FileChange, simulatePlanOutcome } from "./core/executionPreview.js";
import {
  appendStrategyHistory,
  createEmptyStatePlane,
  ExecutionState,
  readStatePlane,
  StatePlane,
  updateExecutionState,
} from "./core/state.js";
import { detectEnvironment } from "./core/policyEngine.js";
import { ExecutionTrace } from "./core/types.js";
import { ControlPlane, Plan, Task } from "./schema.js";
import {
  ContextSignature,
  StrategyMemoryTrace,
  buildMemoryTrace,
  buildSignature,
  canReuse,
  findMatchingStrategies,
  readStrategyMemory,
  recordStrategies,
  recordStrategy,
  selectFromMemory,
  validatePlanStillApplies,
} from "./core/strategyMemory.js";
import { cloneJson } from "./utils/clone.js";

export type TaskResult = {
  taskId: string;
  ok: boolean;
  route: "analyst" | "enforcer" | "stub";
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
    memoryTrace: StrategyMemoryTrace;
  }[];
  executionTraces: ExecutionTrace[];
  state: StatePlane;
};

export type PreviewSelectionResult = {
  preview: MultiStrategyPreview;
  costTrace: CostTrace;
  selectedPlan: Plan;
  basePlanId: string;
  strategyTrace: StrategyTrace;
};

export type AdaptivePlanSelectionResult = {
  basePlan: Plan;
  selected: StrategyOutcome;
  outcomes: StrategyOutcome[];
  strategyTrace: StrategyTrace;
  memoryTrace: StrategyMemoryTrace;
};

export type MultiStrategyPreview = {
  previewId: string;
  hash: string;
  planId: string;
  strategies: {
    strategyId: string;
    summary: {
      filesChanged: number;
      patches: number;
      violationsRemaining: number;
    };
    diff: FileChange[];
  }[];
  selectedStrategyId: string;
};

type SelectedStrategyPlan = {
  basePlan: Plan;
  selected: StrategyOutcome;
  outcomes: StrategyOutcome[];
  trace: StrategyTrace;
  memoryTrace: StrategyMemoryTrace;
  signature: ContextSignature;
};

type PlanStrategySelection = {
  selected: StrategyOutcome;
  outcomes: StrategyOutcome[];
  trace: StrategyTrace;
  history: ReturnType<typeof appendStrategyHistory>["state"]["strategyHistory"];
  memoryTrace: StrategyMemoryTrace;
  signature: ContextSignature;
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

function cloneState(state: StatePlane): StatePlane {
  return cloneJson(state);
}

function inferStrategyType(strategyId: string): StrategyType {
  if (strategyId.startsWith("s-aggressive")) return "aggressive";
  if (strategyId.startsWith("s-grouped")) return "grouped";
  if (strategyId.startsWith("s-layered")) return "layered";
  if (strategyId.startsWith("s-minimal")) return "minimal";
  return "adaptive";
}

function fromMemoryOutcome(entry: ReturnType<typeof readStrategyMemory>[number]): StrategyOutcome {
  return {
    strategyId: entry.strategyId,
    strategyType: entry.strategyType ?? inferStrategyType(entry.strategyId),
    plan: entry.plan,
    patches: [],
    diagnostics: [],
    validation: {
      passed: entry.outcome.success,
      diagnostics: [],
      conflicts: [],
      invariantChecks: [],
    },
    metrics: entry.outcome.metrics,
    success: entry.outcome.success,
    fileChanges: [],
    previewHash: "",
  };
}

async function selectStrategyForPlan(
  basePlan: Plan,
  state: StatePlane,
  options: {
    controlPlane: ControlPlane;
    root: string;
    mode: "preview" | "execution";
  }
): Promise<PlanStrategySelection> {
  const signature = buildSignature(options.controlPlane, state);
  const memory = readStrategyMemory(options.root);
  const matches = findMatchingStrategies(signature, memory)
    .filter((entry) => entry.plan.id === basePlan.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  const reusable = matches.filter((entry) => canReuse(entry));
  const selectedFromMemory = selectFromMemory(reusable);

  if (selectedFromMemory && validatePlanStillApplies(selectedFromMemory.plan, state, {
    root: options.root,
    expectedPlanId: basePlan.id,
  })) {
    let selected = fromMemoryOutcome(selectedFromMemory);

    if (options.mode === "preview") {
      const simulated = await simulatePlanOutcome(selectedFromMemory.plan, {
        root: options.root,
        controlPlane: options.controlPlane,
        state: cloneState(state),
      });

      selected = {
        strategyId: selectedFromMemory.strategyId,
        strategyType: selectedFromMemory.strategyType ?? inferStrategyType(selectedFromMemory.strategyId),
        plan: selectedFromMemory.plan,
        patches: simulated.patches,
        diagnostics: simulated.diagnostics,
        validation: simulated.validation,
        metrics: simulated.metrics,
        success: simulated.success,
        fileChanges: simulated.fileChanges,
        previewHash: simulated.previewHash,
      };
    }

    const trace = buildStrategyTrace([selected], selected);
    trace.decision = `${selected.strategyId} reused from deterministic strategy memory (exact signature match)`;

    return {
      selected,
      outcomes: [selected],
      trace,
      history: [],
      memoryTrace: buildMemoryTrace(signature, matches.length, {
        reused: true,
        selectedStrategyId: selected.strategyId,
        fallbackToEvaluation: false,
      }),
      signature,
    };
  }

  const adaptiveSelection = await adaptiveStrategySelection(basePlan, state, {
    controlPlane: options.controlPlane,
    root: options.root,
  });

  const lineageByChild = new Map<string, { parentId: string; mutation: NonNullable<NonNullable<typeof adaptiveSelection.adaptiveTrace.evolution>[number]>["mutation"] }>();
  for (const entry of [...adaptiveSelection.adaptiveTrace.evolution]
    .sort((left, right) => left.childId.localeCompare(right.childId))) {
    if (!lineageByChild.has(entry.childId)) {
      lineageByChild.set(entry.childId, {
        parentId: entry.parentId,
        mutation: entry.mutation,
      });
    }
  }

  const feedback = adaptiveSelection.iterations
    .sort((left, right) => left.iteration - right.iteration)
    .flatMap((iteration) =>
      [...iteration.outcomes]
        .sort((left, right) => left.strategyId.localeCompare(right.strategyId))
        .map((outcome) => {
          const lineage = lineageByChild.get(outcome.strategyId);
          return {
            outcome,
            adaptive: {
              iteration: iteration.iteration,
              ...(lineage ? { parentId: lineage.parentId, mutation: lineage.mutation } : {}),
              ...(outcome.strategyId === iteration.selectedStrategyId ? { selected: true } : {}),
              ...(outcome.strategyId === adaptiveSelection.selected.strategyId ? { finalSelected: true } : {}),
            },
          };
        })
    );

  if (feedback.length > 0) {
    recordStrategies(options.root, signature, feedback);
  }

  const trace = buildStrategyTrace(
    adaptiveSelection.outcomes,
    adaptiveSelection.selected,
    adaptiveSelection.adaptiveTrace
  );
  trace.decision = `${trace.decision}; strategy memory fallback to evaluation`;

  return {
    selected: adaptiveSelection.selected,
    outcomes: adaptiveSelection.outcomes,
    trace,
    history: adaptiveSelection.history,
    memoryTrace: buildMemoryTrace(signature, matches.length, {
      reused: false,
      fallbackToEvaluation: true,
    }),
    signature,
  };
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

function selectPlansForPreview(
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

    const scored = scorePlans([requested], state);
    const selectedPlans = selectPlanSet([requested], state);
    const costTrace = buildCostTrace(selectedPlans[0]!.id, scored);
    return { selectedPlans, costTrace };
  }

  if (allPlans.length === 0) {
    throw new Error("No plans available for preview.");
  }

  const approvedPlans = getApprovedPlans(control);
  const candidates = approvedPlans.length > 0 ? approvedPlans : allPlans;
  const scored = scorePlans(candidates, state);
  const selectedPlans = selectPlanSet(candidates, state);
  const costTrace = buildCostTrace(selectedPlans[0]!.id, scored);

  return {
    selectedPlans,
    costTrace,
  };
}

function upsertDraftPlan(
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

function approvePlan(control: ControlPlane, planId: string): {
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
      route: "analyst",
      output: {
        summary,
        hotspots,
      },
      decisions: [`Task ${task.id} routed to analyst`],
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
      route: "enforcer",
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
    route: "enforcer",
    output: {
      diagnostics: pipelineResult.diagnostics.length,
      blockingDiagnostics,
      appliedPatches: pipelineResult.appliedPatches.filter((patch) => patch.success).length,
    },
    decisions: [
      `Task ${task.id} routed to enforcer`,
      `Enforcer diagnostics=${pipelineResult.diagnostics.length}, blocking=${blockingDiagnostics}`,
    ],
  };
}

function taskStatus(state: ExecutionState, planId: string, taskId: string): ExecutionState["taskStatus"][string] {
  return state.taskStatus[taskExecutionKey(planId, taskId)] ?? "pending";
}

function countExecutionPatches(state: StatePlane, planId: string, tasks: Task[]): number {
  let total = 0;

  for (const task of tasks) {
    const key = taskExecutionKey(planId, task.id);
    const entry = state.execution.taskResults[key] as Record<string, unknown> | undefined;
    if (!entry || typeof entry.appliedPatches !== "number") {
      continue;
    }

    total += entry.appliedPatches;
  }

  return total;
}

function countExecutionChangedFiles(state: StatePlane, planId: string, tasks: Task[]): number {
  const files = new Set<string>();

  for (const task of tasks) {
    const key = taskExecutionKey(planId, task.id);
    const entry = state.execution.taskResults[key] as Record<string, unknown> | undefined;
    if (!entry || !Array.isArray(entry.filesChanged)) {
      continue;
    }

    for (const value of entry.filesChanged) {
      if (typeof value === "string" && value.trim().length > 0) {
        files.add(value);
      }
    }
  }

  return files.size;
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
  options: { controlPlane: ControlPlane; root: string; ciPipelineExecution?: boolean }
): Promise<{ state: StatePlane; trace: ExecutionTrace }> {
  if (detectEnvironment() === "ci" && options.ciPipelineExecution !== true) {
    throw new Error("CI mode execution is restricted. Use 'choir ci run' to execute plans in CI.");
  }

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

  recordAudit(options.root, {
    auditEvent: {
      id: "",
      timestamp: "",
      actor: {
        role: "conductor",
      },
      environment: detectEnvironment(),
      action: "execute-plan",
      resource: `execution.plans.${plan.id}`,
      result: finalStatus === "complete" ? "success" : "failure",
      metadata: {
        tasksExecuted: trace.tasksExecuted,
        tasksSucceeded: trace.tasksSucceeded,
        tasksFailed: trace.tasksFailed,
      },
    },
    decisionTrace: {
      policiesEvaluated: [],
      finalDecision: finalStatus === "complete" ? "allow" : "deny",
      reasoning: finalStatus === "complete"
        ? "Execution completed and all tasks succeeded"
        : "Execution completed with task failures",
    },
    executionTrace: {
      planId: plan.id,
      patchesApplied: countExecutionPatches(state, plan.id, plan.tasks),
      filesChanged: countExecutionChangedFiles(state, plan.id, plan.tasks),
    },
  });

  return { state, trace };
}

export async function executeSelectedPlansWithCost(
  control: ControlPlane,
  options: {
    root: string;
    requestedPlanId?: string;
    ciPipelineExecution?: boolean;
  }
): Promise<CostBasedExecutionResult> {
  if (detectEnvironment() === "ci" && options.ciPipelineExecution !== true) {
    throw new Error("CI mode execution is restricted. Use 'choir ci run' to execute plans in CI.");
  }

  let state = readStatePlane(options.root) ?? createEmptyStatePlane();

  const { selectedPlans, costTrace } = selectApprovedPlansForExecution(
    control,
    state,
    options.requestedPlanId
  );

  const planned: SelectedStrategyPlan[] = [];

  for (const basePlan of sortedPlans(selectedPlans)) {
    const selection = await selectStrategyForPlan(basePlan, state, {
      controlPlane: control,
      root: options.root,
      mode: "execution",
    });

    if (selection.history.length > 0) {
      appendStrategyHistory(options.root, selection.history);
    }

    planned.push({
      basePlan,
      selected: selection.selected,
      outcomes: selection.outcomes,
      trace: selection.trace,
      memoryTrace: selection.memoryTrace,
      signature: selection.signature,
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
      memoryTrace: plan.memoryTrace,
    });

    const executed = await executePlan(plan.selected.plan, {
      controlPlane: control,
      root: options.root,
      ciPipelineExecution: options.ciPipelineExecution,
    });

    state = executed.state;
    executionTraces.push(executed.trace);
    executablePlans.push(plan.selected.plan);

    if (executed.trace.tasksFailed.length === 0) {
      recordStrategy(options.root, plan.signature, plan.selected);
    }
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
  const { selectedPlans, costTrace } = selectPlansForPreview(control, state, options.requestedPlanId);

  const basePlan = sortedPlans(selectedPlans)[0];
  if (!basePlan) {
    throw new Error("No approved plans available for preview.");
  }

  const selection = await selectStrategyForPlan(basePlan, state, {
    controlPlane: control,
    root: options.root,
    mode: "preview",
  });
  const selectedOutcome = selection.selected;

  if (selection.history.length > 0) {
    appendStrategyHistory(options.root, selection.history);
  }

  const preview: MultiStrategyPreview = {
    previewId: selectedOutcome.previewHash,
    hash: selectedOutcome.previewHash,
    planId: basePlan.id,
    strategies: [...selection.outcomes]
      .sort((left, right) => left.strategyId.localeCompare(right.strategyId))
      .map((outcome) => ({
        strategyId: outcome.strategyId,
        summary: {
          filesChanged: outcome.metrics.filesChanged,
          patches: outcome.metrics.patchesCount,
          violationsRemaining: outcome.metrics.remainingViolations,
        },
        diff: outcome.fileChanges,
      })),
    selectedStrategyId: selectedOutcome.strategyId,
  };

  updateExecutionState(options.root, (current) => ({
    ...current,
    lastPreview: {
      hash: preview.hash,
      planId: basePlan.id,
      strategyId: selectedOutcome.strategyId,
    },
  }));

  return {
    preview,
    costTrace,
    selectedPlan: selectedOutcome.plan,
    basePlanId: basePlan.id,
    strategyTrace: selection.trace,
  };
}

export async function evaluateAdaptivePlanSelection(
  control: ControlPlane,
  options: {
    root: string;
    requestedPlanId?: string;
    targetGoal?: string;
  }
): Promise<AdaptivePlanSelectionResult> {
  const state = readStatePlane(options.root) ?? createEmptyStatePlane();
  const allPlans = sortedPlans(control.execution.plans);

  let candidates = allPlans;
  if (options.requestedPlanId) {
    const requested = allPlans.find((plan) => plan.id === options.requestedPlanId);
    if (!requested) {
      throw new Error(`Plan not found: ${options.requestedPlanId}`);
    }
    candidates = [requested];
  } else if (options.targetGoal) {
    candidates = allPlans.filter((plan) => (plan.goalRefs ?? []).includes(options.targetGoal as string));
  }

  const basePlan = sortedPlans(candidates)[0];
  if (!basePlan) {
    throw new Error("Adaptive planning unavailable: no matching execution plans found.");
  }

  const selection = await selectStrategyForPlan(basePlan, state, {
    controlPlane: control,
    root: options.root,
    mode: "preview",
  });

  if (selection.history.length > 0) {
    appendStrategyHistory(options.root, selection.history);
  }

  return {
    basePlan,
    selected: selection.selected,
    outcomes: selection.outcomes,
    strategyTrace: selection.trace,
    memoryTrace: selection.memoryTrace,
  };
}

async function executeSelectedPlansWithPreviewGuard(
  control: ControlPlane,
  options: {
    root: string;
    previewId?: string;
    requestedPlanId?: string;
    ciPipelineExecution?: boolean;
  }
): Promise<CostBasedExecutionResult & { previewHash: string }> {
  if (detectEnvironment() === "ci" && options.ciPipelineExecution !== true) {
    throw new Error("CI mode execution is restricted. Use 'choir ci run' to execute plans in CI.");
  }

  const expectedHash = normalizePreviewHash(options.previewId);
  if (!expectedHash) {
    throw new Error("Execution requires a preview hash. Run: @choir preview [planId], then execute <planId> <previewHash>.");
  }

  const state = readStatePlane(options.root) ?? createEmptyStatePlane();
  const lastPreview = state.execution.lastPreview;
  if (!lastPreview || normalizePreviewHash(lastPreview.hash) !== expectedHash) {
    throw new Error("Preview hash is not approved in state. Generate a fresh preview before execution.");
  }

  const targetPlanId = options.requestedPlanId ?? lastPreview.planId;

  if (targetPlanId !== lastPreview.planId) {
    throw new Error(`Preview hash was generated for ${lastPreview.planId}. Generate preview for ${targetPlanId} before execution.`);
  }

  const recomputed = await generateSelectedPlanPreview(control, {
    root: options.root,
    requestedPlanId: targetPlanId,
  });

  if (normalizePreviewHash(recomputed.preview.hash) !== expectedHash) {
    throw new Error("Preview hash mismatch. Workspace or control plane changed; re-run preview before execution.");
  }

  const executed = await executeSelectedPlansWithCost(control, {
    root: options.root,
    requestedPlanId: targetPlanId,
    ciPipelineExecution: options.ciPipelineExecution,
  });

  return {
    ...executed,
    previewHash: expectedHash,
  };
}

function summarizePlanStatus(control: ControlPlane, state: StatePlane): PlanStatusSummary {
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
