export type ConductorCommand =
  | { kind: "plan"; goal?: string }
  | { kind: "approve"; planId?: string }
  | { kind: "execute"; planId?: string }
  | { kind: "status" }
  | { kind: "help" };

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function parseConductorCommand(input: string): ConductorCommand {
  const prompt = input.trim();

  const planWithGoalMatch = prompt.match(/^plan\s+for\s+goal\s*:\s*(.+)$/i);
  if (planWithGoalMatch) {
    return {
      kind: "plan",
      goal: clean(planWithGoalMatch[1]),
    };
  }

  if (/^plan$/i.test(prompt)) {
    return { kind: "plan" };
  }

  const approveMatch = prompt.match(/^approve(?:\s+(.+))?$/i);
  if (approveMatch) {
    return {
      kind: "approve",
      planId: clean(approveMatch[1]),
    };
  }

  const executeMatch = prompt.match(/^execute(?:\s+(.+))?$/i);
  if (executeMatch) {
    return {
      kind: "execute",
      planId: clean(executeMatch[1]),
    };
  }

  if (/^status$/i.test(prompt)) {
    return { kind: "status" };
  }

  return { kind: "help" };
}
