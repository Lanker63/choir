import { deterministicHash } from "./deterministicCore.js";
import {
  CompilerPipelineError,
  compileInput,
  formatCompilerErrors,
} from "./compilerPipeline.js";
import {
  executeGlobalPlan,
  executeRolloutPlan,
  hashState as hashGlobalState,
  replay,
  simulatePlan,
  validateTrace,
  verifyReplay,
  type GlobalPlan,
  type Repo,
  type RolloutStrategy,
} from "./globalOrchestration.js";
import {
  PlanOptimizationError,
  analyzeWorkspace,
  generateCandidatePlans,
  synthesizeAndOptimizePlans,
} from "./planOptimizationOrchestrator.js";
import { ControlPlane, Plan, Task } from "../schema.js";
import {
  createEmptyStatePlane,
  hasApprovalForDiff,
  hasApprovalForPreview,
  readStatePlane,
} from "./state.js";

export type ExecutionOrchestrationStageName =
  | "compile"
  | "workspace-analysis"
  | "candidate-synthesis"
  | "strategy-selection"
  | "simulation-precheck"
  | "policy-enforcement"
  | "execution"
  | "replay-verification";

export type ExecutionOrchestrationStageResult = {
  stage: ExecutionOrchestrationStageName;
  status: "success" | "failure";
  detail: string;
};

export type ExecutionOrchestrationResult = {
  transactionId: string;
  executionHash: string;
  finalStateHash: string;
  replayHash: string;
  executionStages: {
    id: string;
    order: number;
    units: string[];
  }[];
  rollbackScope: {
    unitIds: string[];
    stageIds: string[];
    complexity: number;
  };
  deterministic: boolean;
  verified: boolean;
  success: boolean;
  strategyId: string;
  planId: string;
  planSource: "configured" | "synthesized";
  simulationFutureStateHash: string;
  policy: {
    decision: "allow" | "require-approval" | "deny";
    previewHash: string;
    diffHash: string;
    requiresApproval: boolean;
    violations: number;
  };
  stageResults: ExecutionOrchestrationStageResult[];
};

export type RunExecutionOrchestratorOptions = {
  root: string;
  controlPlane: ControlPlane;
  command: string;
  requestedPlanId?: string;
  requestedPreviewRef?: string;
  rolloutStrategy?: RolloutStrategy;
};

export class ExecutionOrchestrationError extends Error {
  readonly failedStage: ExecutionOrchestrationStageName;
  readonly stageResults: ExecutionOrchestrationStageResult[];

  constructor(input: {
    failedStage: ExecutionOrchestrationStageName;
    message: string;
    stageResults: ExecutionOrchestrationStageResult[];
  }) {
    super(input.message);
    this.name = "ExecutionOrchestrationError";
    this.failedStage = input.failedStage;
    this.stageResults = input.stageResults;
  }
}

type PreviewBindingResolution = {
  previewHash: string;
  approved: boolean;
};

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function deriveSimulationUnit(task: Task): string {
  const files = [...(task.scope?.files ?? [])]
    .map((file) => file.replace(/\\/g, "/"))
    .sort((left, right) => left.localeCompare(right));

  const first = files[0];
  if (!first) {
    return "workspace:root";
  }

  const segments = first.split("/").filter((entry) => entry.length > 0);
  if (segments.length >= 2 && ["packages", "apps", "services", "libs"].includes(segments[0])) {
    return `${segments[0]}:${segments[1]}`;
  }

  return "workspace:root";
}

function toGlobalPlanFromPlan(plan: Plan): GlobalPlan {
  const knownTaskIds = new Set(plan.tasks.map((task) => task.id));
  const tasks = [...plan.tasks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((task) => ({
      id: `${plan.id}:${task.id}`,
      repoId: deriveSimulationUnit(task),
      action: `${task.type}:${task.id}`,
      dependsOn: sortedUnique((task.dependsOn ?? [])
        .filter((dependencyId) => knownTaskIds.has(dependencyId))
        .map((dependencyId) => `${plan.id}:${dependencyId}`)),
    }));

  return {
    id: `global-${plan.id}`,
    tasks,
  };
}

function buildSimulationRepos(plans: GlobalPlan[]): Repo[] {
  const taskById = new Map(plans.flatMap((plan) => plan.tasks.map((task) => [task.id, task] as const)));
  const repoDependencies = new Map<string, Set<string>>();

  for (const plan of plans) {
    for (const task of plan.tasks) {
      if (!repoDependencies.has(task.repoId)) {
        repoDependencies.set(task.repoId, new Set<string>());
      }

      for (const dependencyId of task.dependsOn) {
        const dependency = taskById.get(dependencyId);
        if (!dependency) {
          continue;
        }

        if (dependency.repoId !== task.repoId) {
          repoDependencies.get(task.repoId)?.add(dependency.repoId);
        }
      }
    }
  }

  return [...repoDependencies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([repoId, dependencies]) => ({
      id: repoId,
      dependencies: sortedUnique([...dependencies]),
      state: {},
    }));
}

function resolvePreviewBinding(root: string, reference: string): PreviewBindingResolution | null {
  const state = readStatePlane(root) ?? createEmptyStatePlane();

  const approval = state.approvals.find((entry) =>
    entry.id === reference
    || (entry.previewHash ?? "") === reference
    || entry.diffHash === reference
  );

  if (approval) {
    return {
      previewHash: approval.previewHash ?? approval.diffHash,
      approved: true,
    };
  }

  const pending = state.pendingApprovals.find((entry) =>
    entry.id === reference
    || (entry.previewHash ?? "") === reference
    || entry.diffHash === reference
  );

  if (!pending) {
    return null;
  }

  return {
    previewHash: pending.previewHash ?? pending.diffHash,
    approved: false,
  };
}

function executionRankingSort(
  left: {
    policyViolations: number;
    dependencyRisk: number;
    rollbackComplexity: number;
    blastRadius: number;
    executionCost: number;
    strategyId: string;
    id: string;
  },
  right: {
    policyViolations: number;
    dependencyRisk: number;
    rollbackComplexity: number;
    blastRadius: number;
    executionCost: number;
    strategyId: string;
    id: string;
  }
): number {
  return left.policyViolations - right.policyViolations
    || left.dependencyRisk - right.dependencyRisk
    || left.rollbackComplexity - right.rollbackComplexity
    || left.blastRadius - right.blastRadius
    || left.executionCost - right.executionCost
    || left.strategyId.localeCompare(right.strategyId)
    || left.id.localeCompare(right.id);
}

function fail(
  stage: ExecutionOrchestrationStageName,
  detail: string,
  stageResults: ExecutionOrchestrationStageResult[]
): never {
  stageResults.push({
    stage,
    status: "failure",
    detail,
  });

  throw new ExecutionOrchestrationError({
    failedStage: stage,
    message: detail,
    stageResults,
  });
}

export async function runExecutionOrchestrator(
  options: RunExecutionOrchestratorOptions
): Promise<ExecutionOrchestrationResult> {
  const stageResults: ExecutionOrchestrationStageResult[] = [];
  const markSuccess = (stage: ExecutionOrchestrationStageName, detail: string): void => {
    stageResults.push({
      stage,
      status: "success",
      detail,
    });
  };

  try {
    compileInput(options.command, options.controlPlane);
    markSuccess("compile", "Compiler gates passed (structure, semantic, cross-node, policy).");
  } catch (error) {
    if (error instanceof CompilerPipelineError) {
      return fail("compile", formatCompilerErrors(error.errors), stageResults);
    }

    const message = error instanceof Error ? error.message : String(error);
    return fail("compile", message, stageResults);
  }

  if (options.requestedPlanId) {
    const exists = options.controlPlane.execution.plans.some((plan) => plan.id === options.requestedPlanId);
    if (!exists) {
      return fail("candidate-synthesis", `Execution plan not found: ${options.requestedPlanId}`, stageResults);
    }
  }

  const effectiveControlPlane = options.requestedPlanId
    ? {
      ...options.controlPlane,
      execution: {
        ...options.controlPlane.execution,
        plans: options.controlPlane.execution.plans.filter((plan) => plan.id === options.requestedPlanId),
      },
    }
    : options.controlPlane;

  let optimized: Awaited<ReturnType<typeof synthesizeAndOptimizePlans>>;
  try {
    optimized = await synthesizeAndOptimizePlans({
      root: options.root,
      command: options.command,
      controlPlane: effectiveControlPlane,
    });

    markSuccess("workspace-analysis", `Workspace analyzed (graphHash=${optimized.planHash.slice(0, 12)}).`);
    markSuccess("candidate-synthesis", `Generated ${optimized.rankedPlans.length} deterministic candidate plan(s).`);
  } catch (error) {
    if (error instanceof PlanOptimizationError) {
      const detail = [
        `Plan optimization failed at stage ${error.failedStage}.`,
        ...error.stageResults.map((entry) => `- ${entry.stage}: ${entry.detail}`),
      ].join("\n");
      return fail("candidate-synthesis", detail, stageResults);
    }

    const message = error instanceof Error ? error.message : String(error);
    return fail("candidate-synthesis", message, stageResults);
  }

  let selectedRanked = [...optimized.rankedPlans].sort(executionRankingSort)[0];
  if (!selectedRanked) {
    return fail("strategy-selection", "No ranked execution strategies are available.", stageResults);
  }

  const workspace = await analyzeWorkspace(options.root, effectiveControlPlane);
  const candidates = generateCandidatePlans(effectiveControlPlane, workspace);
  const selectedCandidate = candidates.find((candidate) =>
    candidate.plan.id === selectedRanked.id && candidate.strategyId === selectedRanked.strategyId
  );

  const selectedExecutionPlan = selectedCandidate?.plan ?? optimized.selectedExecutionPlan;
  markSuccess(
    "strategy-selection",
    `Selected strategy ${selectedRanked.strategyId} (violations=${selectedRanked.policyViolations}, dependencyRisk=${selectedRanked.dependencyRisk}, rollbackComplexity=${selectedRanked.rollbackComplexity}, blastRadius=${selectedRanked.blastRadius}, executionCost=${selectedRanked.executionCost}).`
  );

  const globalPlan = toGlobalPlanFromPlan(selectedExecutionPlan);
  const repos = buildSimulationRepos([globalPlan]);

  const simulation = await simulatePlan(globalPlan, {
    repos,
    policies: [],
    stateRoot: options.root,
  });

  if (!simulation.success) {
    return fail(
      "simulation-precheck",
      `Simulation precheck failed: ${simulation.violations.join("; ") || "unknown simulation failure"}`,
      stageResults
    );
  }

  const simulationDeterministicTrace = simulation.trace.deterministicTrace;
  if (!simulationDeterministicTrace) {
    return fail("simulation-precheck", "Simulation trace missing deterministic replay metadata.", stageResults);
  }

  const simulationFutureStateHash = hashGlobalState(simulation.finalState);
  const simulationReplayHash = hashGlobalState(replay(simulationDeterministicTrace));
  const simulationTraceValid = validateTrace(simulationDeterministicTrace);
  const simulationReplayValid = verifyReplay(simulationDeterministicTrace);

  if (!simulationTraceValid || !simulationReplayValid || simulationFutureStateHash !== simulationReplayHash) {
    return fail(
      "simulation-precheck",
      `Simulation replay verification failed (trace=${simulationTraceValid}, replay=${simulationReplayValid}, hashMatch=${simulationFutureStateHash === simulationReplayHash}).`,
      stageResults
    );
  }

  markSuccess(
    "simulation-precheck",
    `Simulation parity precheck passed (futureStateHash=${simulationFutureStateHash.slice(0, 12)}).`
  );

  if (selectedRanked.policyDecision === "deny") {
    return fail(
      "policy-enforcement",
      `Policy denied execution for selected strategy ${selectedRanked.strategyId}.`,
      stageResults
    );
  }

  let approvalSatisfied = !selectedRanked.requiresApproval;
  if (selectedRanked.requiresApproval) {
    const stateApproved = hasApprovalForPreview(options.root, selectedRanked.previewHash)
      || hasApprovalForDiff(options.root, selectedRanked.diffHash);

    if (options.requestedPreviewRef) {
      const resolved = resolvePreviewBinding(options.root, options.requestedPreviewRef);
      if (!resolved) {
        return fail("policy-enforcement", `Preview binding not found: ${options.requestedPreviewRef}`, stageResults);
      }

      if (resolved.previewHash !== selectedRanked.previewHash) {
        return fail(
          "policy-enforcement",
          `Preview binding mismatch: expected ${selectedRanked.previewHash}, got ${resolved.previewHash}`,
          stageResults
        );
      }

      if (!resolved.approved) {
        return fail("policy-enforcement", `Preview binding ${options.requestedPreviewRef} is pending approval.`, stageResults);
      }

      approvalSatisfied = true;
    } else {
      approvalSatisfied = stateApproved;
    }

    if (!approvalSatisfied) {
      return fail(
        "policy-enforcement",
        `Execution requires approval for previewHash=${selectedRanked.previewHash}.`,
        stageResults
      );
    }
  }

  markSuccess(
    "policy-enforcement",
    `Policy decision=${selectedRanked.policyDecision} (requiresApproval=${selectedRanked.requiresApproval}, satisfied=${approvalSatisfied}).`
  );

  if (options.rolloutStrategy) {
    const rollout = await executeRolloutPlan(
      globalPlan,
      {
        repos,
        policies: [],
        stateRoot: options.root,
      },
      options.rolloutStrategy,
      {
        requireApproval: selectedRanked.requiresApproval
          ? async ({ previewHash }) => approvalSatisfied && previewHash === selectedRanked.previewHash
          : undefined,
      }
    );

    if (!rollout.success) {
      return fail("execution", `Execution failed: ${rollout.failures.join("; ") || "rollout failed"}`, stageResults);
    }

    const finalStateHash = hashGlobalState(rollout.finalStates);
    if (simulationFutureStateHash !== finalStateHash) {
      return fail(
        "execution",
        `Simulation parity divergence: simulation=${simulationFutureStateHash}, execution=${finalStateHash}`,
        stageResults
      );
    }

    const deterministicTrace = rollout.trace.deterministicTraces[rollout.trace.deterministicTraces.length - 1] ?? simulationDeterministicTrace;
    const replayStateHash = hashGlobalState(replay(deterministicTrace));
    const traceValid = validateTrace(deterministicTrace);
    const replayValid = verifyReplay(deterministicTrace);
    const replayHashMatches = replayStateHash === finalStateHash;

    if (!traceValid || !replayValid || !replayHashMatches) {
      return fail(
        "replay-verification",
        `Replay verification failed (trace=${traceValid}, replay=${replayValid}, hashMatch=${replayHashMatches}).`,
        stageResults
      );
    }

    markSuccess("execution", `Execution committed across ${rollout.trace.completedStages.length} stage(s).`);
    markSuccess("replay-verification", `Replay verified (hash=${replayStateHash.slice(0, 12)}).`);

    const transactionId = rollout.trace.transactionTraces[rollout.trace.transactionTraces.length - 1]?.transactionId
      ?? `rollout-${globalPlan.id}`;

    const executionStages = rollout.trace.stages.map((stage) => ({
      id: stage.id,
      order: stage.order,
      units: sortedUnique(stage.units),
    }));

    const rollbackUnits = sortedUnique(rollout.trace.rollbackTraces.flatMap((entry) => entry.rollbackSet));
    const rollbackStages = sortedUnique(rollout.trace.rollbackTraces.map((entry) => `rollback:${entry.failedUnit}`));

    return {
      transactionId,
      executionHash: deterministicHash({
        transactionId,
        planId: globalPlan.id,
        finalStateHash,
        replayStateHash,
        completedStages: rollout.trace.completedStages,
      }),
      finalStateHash,
      replayHash: replayStateHash,
      executionStages,
      rollbackScope: {
        unitIds: rollbackUnits,
        stageIds: rollbackStages,
        complexity: rollbackUnits.length + rollbackStages.length,
      },
      deterministic: true,
      verified: true,
      success: true,
      strategyId: selectedRanked.strategyId,
      planId: selectedExecutionPlan.id,
      planSource: optimized.selectedPlan.synthesized ? "synthesized" : "configured",
      simulationFutureStateHash,
      policy: {
        decision: selectedRanked.policyDecision,
        previewHash: selectedRanked.previewHash,
        diffHash: selectedRanked.diffHash,
        requiresApproval: selectedRanked.requiresApproval,
        violations: selectedRanked.policyViolations,
      },
      stageResults,
    };
  }

  const execution = await executeGlobalPlan(globalPlan, {
    repos,
    policies: [],
    stateRoot: options.root,
    approveExecution: async ({ previewHash }) => {
      if (!selectedRanked.requiresApproval) {
        return true;
      }

      return approvalSatisfied && previewHash === selectedRanked.previewHash;
    },
  });

  if (!execution.success) {
    return fail(
      "execution",
      `Execution failed: ${execution.audit.violations.join("; ") || "global execution failure"}`,
      stageResults
    );
  }

  const finalStateHash = hashGlobalState(execution.finalStates);
  if (simulationFutureStateHash !== finalStateHash) {
    return fail(
      "execution",
      `Simulation parity divergence: simulation=${simulationFutureStateHash}, execution=${finalStateHash}`,
      stageResults
    );
  }

  markSuccess("execution", `Execution committed (finalStateHash=${finalStateHash.slice(0, 12)}).`);

  const deterministicTrace = execution.trace.deterministicTrace;
  if (!deterministicTrace) {
    return fail("replay-verification", "Execution trace missing deterministic replay metadata.", stageResults);
  }

  const replayStateHash = hashGlobalState(replay(deterministicTrace));
  const traceValid = validateTrace(deterministicTrace);
  const replayValid = verifyReplay(deterministicTrace);
  const replayHashMatches = replayStateHash === finalStateHash;

  if (!traceValid || !replayValid || !replayHashMatches) {
    return fail(
      "replay-verification",
      `Replay verification failed (trace=${traceValid}, replay=${replayValid}, hashMatch=${replayHashMatches}).`,
      stageResults
    );
  }

  markSuccess("replay-verification", `Replay verified (hash=${replayStateHash.slice(0, 12)}).`);

  const transactionId = execution.trace.transactionTrace?.transactionId ?? `tx-${globalPlan.id}`;
  const executionStages = execution.trace.stages.map((stage) => ({
    id: stage.id,
    order: stage.order,
    units: sortedUnique(stage.unitIds),
  }));

  const rollbackUnits = sortedUnique(execution.rollbackTrace?.rollbackSet ?? []);
  const rollbackStages = sortedUnique(execution.rollbackTrace?.rollbackOrder.map((unitId) => `rollback:${unitId}`) ?? []);

  return {
    transactionId,
    executionHash: deterministicHash({
      transactionId,
      planId: globalPlan.id,
      finalStateHash,
      replayStateHash,
      executionOrder: execution.trace.executionOrder,
    }),
    finalStateHash,
    replayHash: replayStateHash,
    executionStages,
    rollbackScope: {
      unitIds: rollbackUnits,
      stageIds: rollbackStages,
      complexity: rollbackUnits.length + rollbackStages.length,
    },
    deterministic: true,
    verified: true,
    success: true,
    strategyId: selectedRanked.strategyId,
    planId: selectedExecutionPlan.id,
    planSource: optimized.selectedPlan.synthesized ? "synthesized" : "configured",
    simulationFutureStateHash,
    policy: {
      decision: selectedRanked.policyDecision,
      previewHash: selectedRanked.previewHash,
      diffHash: selectedRanked.diffHash,
      requiresApproval: selectedRanked.requiresApproval,
      violations: selectedRanked.policyViolations,
    },
    stageResults,
  };
}
