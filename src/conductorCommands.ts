export type ConductorCommand =
  | { kind: "plan"; goal?: string }
  | { kind: "approve"; planId?: string }
  | { kind: "preview"; planId?: string }
  | { kind: "execute"; planId?: string; previewId?: string }
  | { kind: "status" }
  | { kind: "help" };

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isPreviewHash(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value.trim());
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

  const previewMatch = prompt.match(/^preview(?:\s+(.+))?$/i);
  if (previewMatch) {
    return {
      kind: "preview",
      planId: clean(previewMatch[1]),
    };
  }

  const executeMatch = prompt.match(/^execute(?:\s+(.+))?$/i);
  if (executeMatch) {
    const value = clean(executeMatch[1]);
    if (!value) {
      return {
        kind: "execute",
      };
    }

    const parts = value.split(/\s+/).filter((part) => part.length > 0);

    if (parts.length === 1) {
      return isPreviewHash(parts[0])
        ? { kind: "execute", previewId: clean(parts[0])?.toLowerCase() }
        : { kind: "execute", planId: clean(parts[0]) };
    }

    return {
      kind: "execute",
      planId: clean(parts[0]),
      previewId: clean(parts[1])?.toLowerCase(),
    };
  }

  if (/^status$/i.test(prompt)) {
    return { kind: "status" };
  }

  return { kind: "help" };
}
