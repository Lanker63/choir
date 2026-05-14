import { ControlPlane, Plan } from "../schema.js";

function sortPlans(plans: Plan[]): Plan[] {
  return [...plans].sort((left, right) => left.id.localeCompare(right.id));
}

export function persistSelectedOptimizedPlan(control: ControlPlane, selectedPlan: Plan): ControlPlane {
  const normalizedSelected: Plan = {
    ...selectedPlan,
    status: selectedPlan.status ?? "draft",
  };

  const merged = control.execution.plans.some((plan) => plan.id === normalizedSelected.id)
    ? control.execution.plans.map((plan) => (plan.id === normalizedSelected.id ? normalizedSelected : plan))
    : [...control.execution.plans, normalizedSelected];

  return {
    ...control,
    execution: {
      ...control.execution,
      plans: sortPlans(merged),
    },
  };
}
