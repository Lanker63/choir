import { Plan } from "../schema.js";
import { StatePlane } from "./state.js";

export type CostBreakdown = {
  editCost: number;
  fileTouchCost: number;
  riskCost: number;
  dependencyCost: number;
  violationReduction: number;
};

export type PlanScore = {
  planId: string;
  totalCost: number;
  breakdown: CostBreakdown;
};

export type CostTrace = {
  selectedPlanId: string;
  evaluatedPlans: PlanScore[];
  decision: string;
};

const COST_WEIGHTS = {
  edit: 1.0,
  files: 2.0,
  risk: 5.0,
  dependency: 1.5,
  reduction: 3.0,
} as const;

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function normalizePath(filePath: string): string {
  return filePath.split("\\").join("/");
}

function comparePlanScores(left: PlanScore, right: PlanScore): number {
  return left.totalCost - right.totalCost || left.planId.localeCompare(right.planId);
}

export function estimatePatches(plan: Plan): number {
  return plan.tasks.filter((task) => task.type === "refactor").length * 3;
}

export function estimateFiles(plan: Plan): number {
  return sortedUnique(
    plan.tasks.flatMap((task) => (task.scope?.files ?? []).map((file) => normalizePath(file)))
  ).length;
}

export function estimateRisk(plan: Plan): number {
  return plan.tasks.filter((task) => task.type === "refactor").length;
}

export function estimateDependencyDepth(plan: Plan, _state: StatePlane): number {
  const taskIds = new Set(plan.tasks.map((task) => task.id));
  const dependencyMap = new Map<string, string[]>(
    plan.tasks
      .map((task) => [
        task.id,
        sortedUnique((task.dependsOn ?? []).filter((dependencyId) => taskIds.has(dependencyId))),
      ] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );

  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (taskId: string): number => {
    const cached = memo.get(taskId);
    if (cached !== undefined) {
      return cached;
    }

    if (visiting.has(taskId)) {
      // Invalid plan dependency cycles are heavily penalized deterministically.
      const cyclePenalty = plan.tasks.length;
      memo.set(taskId, cyclePenalty);
      return cyclePenalty;
    }

    visiting.add(taskId);

    const dependencies = dependencyMap.get(taskId) ?? [];
    let maxDepth = 0;

    for (const dependencyId of dependencies) {
      maxDepth = Math.max(maxDepth, 1 + visit(dependencyId));
    }

    visiting.delete(taskId);
    memo.set(taskId, maxDepth);
    return maxDepth;
  };

  return Math.max(0, ...plan.tasks.map((task) => visit(task.id)));
}

export function estimateViolationReduction(_plan: Plan, state: StatePlane): number {
  return state.violations.length;
}

export function scorePlan(plan: Plan, state: StatePlane): PlanScore {
  const patches = estimatePatches(plan);
  const files = estimateFiles(plan);
  const risk = estimateRisk(plan);
  const depth = estimateDependencyDepth(plan, state);
  const reduction = estimateViolationReduction(plan, state);

  const totalCost =
    patches * COST_WEIGHTS.edit
    + files * COST_WEIGHTS.files
    + risk * COST_WEIGHTS.risk
    + depth * COST_WEIGHTS.dependency
    - reduction * COST_WEIGHTS.reduction;

  return {
    planId: plan.id,
    totalCost,
    breakdown: {
      editCost: patches,
      fileTouchCost: files,
      riskCost: risk,
      dependencyCost: depth,
      violationReduction: reduction,
    },
  };
}

export function scorePlans(plans: Plan[], state: StatePlane): PlanScore[] {
  return plans
    .map((plan) => scorePlan(plan, state))
    .sort(comparePlanScores);
}

export function selectBestPlan(plans: Plan[], state: StatePlane): Plan {
  if (plans.length === 0) {
    throw new Error("Cannot select best plan from an empty plan list");
  }

  const scored = scorePlans(plans, state);
  const selectedPlanId = scored[0]?.planId as string;
  const selectedPlan = plans.find((plan) => plan.id === selectedPlanId);

  if (!selectedPlan) {
    throw new Error(`Selected plan not found: ${selectedPlanId}`);
  }

  return selectedPlan;
}

export function selectPlanSet(plans: Plan[], state: StatePlane): Plan[] {
  return [selectBestPlan(plans, state)];
}

export function buildCostTrace(selectedPlanId: string, evaluatedPlans: PlanScore[]): CostTrace {
  const selected = evaluatedPlans.find((score) => score.planId === selectedPlanId);
  if (!selected) {
    throw new Error(`Selected plan score not found: ${selectedPlanId}`);
  }

  const decision = `${selectedPlanId} selected due to lowest total cost `
    + `(edit=${selected.breakdown.editCost}, files=${selected.breakdown.fileTouchCost}, risk=${selected.breakdown.riskCost}, dependency=${selected.breakdown.dependencyCost}, reduction=${selected.breakdown.violationReduction})`;

  return {
    selectedPlanId,
    evaluatedPlans: [...evaluatedPlans].sort(comparePlanScores),
    decision,
  };
}
