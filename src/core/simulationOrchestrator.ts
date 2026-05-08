import { ControlPlane, Plan, Task } from "../schema.js";
import { AST, SimulateNode } from "./choirRouter.js";
import {
  CompilerPipelineError,
  compileInput,
  formatCompilerErrors,
} from "./compilerPipeline.js";
import {
  compareStrategies,
  hashState as hashGlobalState,
  replay,
  simulatePlan,
  simulateUnits,
  validateTrace,
  verifyReplay,
  type ChangeSummary,
  type ComparisonResult,
  type GlobalPlan,
  type PolicyResult,
  type Repo,
  type SimulationResult,
} from "./globalOrchestration.js";
import { generatePlan } from "./orchestration.js";
import {
  buildState,
  createEmptyStatePlane,
  hashState as hashStatePlane,
  readStatePlane,
} from "./state.js";

export type SimulationOrchestrationStageName =
  | "compile"
  | "state"
  | "candidate-synthesis"
  | "strategy-selection"
  | "simulation"
  | "replay"
  | "mutation-guard";

export type SimulationOrchestrationStageResult = {
  stage: SimulationOrchestrationStageName;
  status: "success" | "failure";
  detail: string;
};

export type SimulationPlanSource = "configured" | "synthesized";

export type SimulationPolicyDecision = "allow" | "require-approval" | "deny";

export type SimulationOrchestrationResult = {
  success: boolean;
  strategyId: string;
  planId: string;
  planSource: SimulationPlanSource;
  units?: string[];
  changes: ChangeSummary[];
  violations: string[];
  metrics: {
    risk: number;
    changes: number;
    violations: number;
  };
  policy: {
    decision: SimulationPolicyDecision;
    violations: string[];
  };
  hashes: {
    stateBefore: string;
    stateAfter: string;
    finalState: string;
    replayState: string;
  };
  replay: {
    traceId: string;
    stageIds: string[];
    transitionCount: number;
    validated: boolean;
    verified: boolean;
    hashMatches: boolean;
  };
  rollbackScope: string[];
  stageResults: SimulationOrchestrationStageResult[];
  comparison?: ComparisonResult;
};

export type RunSimulationOrchestratorOptions = {
  root: string;
  controlPlane: ControlPlane;
  command: string;
  requestedPlanId?: string;
  requestedUnits?: string[];
};

export class SimulationOrchestrationError extends Error {
  readonly failedStage: SimulationOrchestrationStageName;
  readonly stageResults: SimulationOrchestrationStageResult[];

  constructor(input: {
    failedStage: SimulationOrchestrationStageName;
    message: string;
    stageResults: SimulationOrchestrationStageResult[];
  }) {
    super(input.message);
    this.name = "SimulationOrchestrationError";
    this.failedStage = input.failedStage;
    this.stageResults = input.stageResults;
  }
}

type CandidatePlan = {
  plan: Plan;
  source: SimulationPlanSource;
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

function policyDecision(policy: PolicyResult | undefined): SimulationPolicyDecision {
  if (!policy) {
    return "allow";
  }

  if (policy.requiresApproval) {
    return "require-approval";
  }

  return policy.allowed ? "allow" : "deny";
}

function computeFallbackMetrics(result: SimulationResult): { risk: number; changes: number; violations: number } {
  const changes = result.changes.reduce((sum, entry) => sum + entry.operations.length, 0);
  const violations = result.violations.length;
  const risk = (violations * 5) + changes;
  return {
    risk,
    changes,
    violations,
  };
}

function fail(
  stage: SimulationOrchestrationStageName,
  detail: string,
  stageResults: SimulationOrchestrationStageResult[]
): never {
  stageResults.push({
    stage,
    status: "failure",
    detail,
  });

  throw new SimulationOrchestrationError({
    failedStage: stage,
    message: detail,
    stageResults,
  });
}

function resolveRequestedTargets(
  ast: AST,
  requestedPlanId?: string,
  requestedUnits?: string[]
): {
  planId?: string;
  units: string[];
} {
  if (requestedPlanId || (requestedUnits && requestedUnits.length > 0)) {
    return {
      ...(requestedPlanId ? { planId: requestedPlanId } : {}),
      units: sortedUnique(requestedUnits ?? []),
    };
  }

  let simulateNode: SimulateNode | undefined;
  if (ast.type === "simulate") {
    simulateNode = ast;
  } else if (ast.type === "sequence") {
    simulateNode = ast.actions.find((action): action is SimulateNode => action.type === "simulate");
  }

  if (!simulateNode) {
    return {
      units: sortedUnique(requestedUnits ?? []),
    };
  }

  return {
    ...(simulateNode.planRef ? { planId: simulateNode.planRef.identifier } : {}),
    units: sortedUnique(simulateNode.units ?? []),
  };
}

export async function runSimulationOrchestrator(
  options: RunSimulationOrchestratorOptions
): Promise<SimulationOrchestrationResult> {
  const stageResults: SimulationOrchestrationStageResult[] = [];
  const markSuccess = (stage: SimulationOrchestrationStageName, detail: string): void => {
    stageResults.push({
      stage,
      status: "success",
      detail,
    });
  };

  let compileResult: ReturnType<typeof compileInput>;
  try {
    compileResult = compileInput(options.command, options.controlPlane);
    markSuccess("compile", "Compiler gates passed (structure, semantic, cross-node, policy).");
  } catch (error) {
    if (error instanceof CompilerPipelineError) {
      return fail("compile", formatCompilerErrors(error.errors), stageResults);
    }

    const message = error instanceof Error ? error.message : String(error);
    return fail("compile", message, stageResults);
  }

  const previousState = readStatePlane(options.root) ?? createEmptyStatePlane();
  const derivedState = buildState({
    yaml: options.controlPlane,
    ast: compileResult.normalizedAst,
    ruleResults: compileResult.ruleResults,
    plans: options.controlPlane.execution.plans,
    previous: previousState,
  });
  markSuccess("state", `Derived deterministic state (hash=${hashStatePlane(derivedState).slice(0, 12)}).`);

  const requested = resolveRequestedTargets(
    compileResult.normalizedAst,
    options.requestedPlanId,
    options.requestedUnits
  );

  const configuredCandidates = [...options.controlPlane.execution.plans]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((plan) => ({
      plan,
      source: "configured" as const,
    }));

  const synthesized: CandidatePlan = {
    plan: generatePlan(options.controlPlane, derivedState),
    source: "synthesized",
  };

  const candidateById = new Map<string, CandidatePlan>();
  for (const candidate of configuredCandidates) {
    candidateById.set(candidate.plan.id, candidate);
  }
  if (!candidateById.has(synthesized.plan.id) || configuredCandidates.length === 0) {
    candidateById.set(synthesized.plan.id, synthesized);
  }

  let candidates = [...candidateById.values()].sort((left, right) => left.plan.id.localeCompare(right.plan.id));
  if (requested.planId) {
    const requestedCandidate = candidates.find((candidate) => candidate.plan.id === requested.planId);
    if (!requestedCandidate) {
      return fail("candidate-synthesis", `Simulation plan not found: ${requested.planId}`, stageResults);
    }

    candidates = [requestedCandidate];
  }

  if (candidates.length === 0) {
    return fail("candidate-synthesis", "Simulation unavailable: no deterministic candidate plans could be derived.", stageResults);
  }

  markSuccess(
    "candidate-synthesis",
    `Prepared ${candidates.length} deterministic candidate plan(s): ${candidates.map((candidate) => candidate.plan.id).join(", ")}.`
  );

  const globalById = new Map(candidates.map((candidate) => [candidate.plan.id, toGlobalPlanFromPlan(candidate.plan)] as const));
  const allGlobalPlans = [...globalById.values()].sort((left, right) => left.id.localeCompare(right.id));
  const repos = buildSimulationRepos(allGlobalPlans);

  let chosenCandidate = candidates[0] as CandidatePlan;
  let comparison: ComparisonResult | undefined;

  if (!requested.planId && allGlobalPlans.length > 1) {
    comparison = await compareStrategies(allGlobalPlans, {
      repos,
      policies: [],
    });

    const selected = candidates.find((candidate) => `global-${candidate.plan.id}` === comparison?.bestStrategy);
    if (selected) {
      chosenCandidate = selected;
    }

    markSuccess(
      "strategy-selection",
      `Selected strategy ${comparison.bestStrategy} from ${allGlobalPlans.length} candidates (violations=${comparison.metrics.violations}, risk=${comparison.metrics.risk}, changes=${comparison.metrics.changes}).`
    );
  } else {
    markSuccess("strategy-selection", `Selected deterministic strategy ${`global-${chosenCandidate.plan.id}`}.`);
  }

  const chosenGlobal = globalById.get(chosenCandidate.plan.id);
  if (!chosenGlobal) {
    return fail("strategy-selection", `Unable to resolve selected global plan for ${chosenCandidate.plan.id}.`, stageResults);
  }

  const requestedUnits = requested.units;
  const availableUnits = sortedUnique(chosenGlobal.tasks.map((task) => task.repoId));
  const unknownUnits = requestedUnits.filter((unit) => !availableUnits.includes(unit));
  if (unknownUnits.length > 0) {
    return fail(
      "strategy-selection",
      `Simulation units not found in selected plan ${chosenCandidate.plan.id}: ${unknownUnits.join(", ")}`,
      stageResults
    );
  }

  const stateBefore = hashStatePlane(readStatePlane(options.root) ?? createEmptyStatePlane());

  const simulated = requestedUnits.length > 0
    ? await simulateUnits(requestedUnits, chosenGlobal, { repos, policies: [] })
    : await simulatePlan(chosenGlobal, { repos, policies: [] });

  markSuccess(
    "simulation",
    `Simulation completed with success=${simulated.success}, unitsAffected=${simulated.trace.unitsAffected.length}, changes=${simulated.changes.length}.`
  );

  const stateAfter = hashStatePlane(readStatePlane(options.root) ?? createEmptyStatePlane());
  if (stateBefore !== stateAfter) {
    return fail(
      "mutation-guard",
      `Simulation mutated persisted state (${stateBefore.slice(0, 12)} -> ${stateAfter.slice(0, 12)}).`,
      stageResults
    );
  }

  markSuccess("mutation-guard", `No persisted state mutation detected (stateHash=${stateAfter.slice(0, 12)}).`);

  const deterministicTrace = simulated.trace.deterministicTrace;
  if (!deterministicTrace) {
    return fail("replay", "Simulation trace is missing deterministic replay metadata.", stageResults);
  }

  const replayState = replay(deterministicTrace);
  const replayStateHash = hashGlobalState(replayState);
  const finalStateHash = hashGlobalState(simulated.finalState);
  const validated = validateTrace(deterministicTrace);
  const verified = verifyReplay(deterministicTrace);
  const hashMatches = replayStateHash === finalStateHash;

  if (!validated || !verified || !hashMatches) {
    return fail(
      "replay",
      `Replay verification failed (validated=${validated}, verified=${verified}, hashMatches=${hashMatches}).`,
      stageResults
    );
  }

  markSuccess(
    "replay",
    `Replay verified (trace=${deterministicTrace.traceId}, hash=${finalStateHash.slice(0, 12)}).`
  );

  const primaryPolicy = simulated.policyDecisions[0];
  const metrics = comparison?.metrics ?? computeFallbackMetrics(simulated);

  return {
    success: simulated.success,
    strategyId: chosenGlobal.id,
    planId: chosenCandidate.plan.id,
    planSource: chosenCandidate.source,
    ...(requestedUnits.length > 0 ? { units: requestedUnits } : {}),
    changes: simulated.changes,
    violations: simulated.violations,
    metrics,
    policy: {
      decision: policyDecision(primaryPolicy),
      violations: primaryPolicy?.violations ?? [],
    },
    hashes: {
      stateBefore,
      stateAfter,
      finalState: finalStateHash,
      replayState: replayStateHash,
    },
    replay: {
      traceId: deterministicTrace.traceId,
      stageIds: deterministicTrace.stages.map((entry) => entry.stageId),
      transitionCount: deterministicTrace.stages.reduce((sum, entry) => sum + entry.operations.length, 0),
      validated,
      verified,
      hashMatches,
    },
    rollbackScope: simulated.success ? [] : sortedUnique(simulated.trace.unitsAffected),
    stageResults,
    ...(comparison ? { comparison } : {}),
  };
}
