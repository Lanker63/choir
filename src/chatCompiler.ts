import { ControlPlane } from "./schema.js";

function extractDirectiveValue(input: string, directive: string): string | null {
  const regex = new RegExp(`^\\s*${directive}\\s*:?\\s*(.+)$`, "i");
  const match = input.match(regex);
  if (!match) {
    return null;
  }

  const value = match[1]?.trim();
  return value && value.length > 0 ? value : null;
}

function withUniqueItems(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter((item) => item.length > 0)));
}

export function applyChatToControlPlane(chatInput: string, control: ControlPlane): ControlPlane {
  const addGoal = extractDirectiveValue(chatInput, "add\\s+goal");
  if (addGoal) {
    return {
      ...control,
      intent: {
        ...control.intent,
        goals: withUniqueItems([...control.intent.goals, addGoal]),
      },
    };
  }

  const removeGoal = extractDirectiveValue(chatInput, "remove\\s+goal");
  if (removeGoal) {
    return {
      ...control,
      intent: {
        ...control.intent,
        goals: control.intent.goals.filter((goal) => goal !== removeGoal),
      },
    };
  }

  const addConstraint = extractDirectiveValue(chatInput, "add\\s+constraint");
  if (addConstraint) {
    return {
      ...control,
      intent: {
        ...control.intent,
        constraints: withUniqueItems([...control.intent.constraints, addConstraint]),
      },
    };
  }

  const removeConstraint = extractDirectiveValue(chatInput, "remove\\s+constraint");
  if (removeConstraint) {
    return {
      ...control,
      intent: {
        ...control.intent,
        constraints: control.intent.constraints.filter((constraint) => constraint !== removeConstraint),
      },
    };
  }

  const addLayer = extractDirectiveValue(chatInput, "add\\s+layer");
  if (addLayer) {
    const mappedConstraint = `layer:${addLayer}`;
    return {
      ...control,
      intent: {
        ...control.intent,
        constraints: withUniqueItems([...control.intent.constraints, mappedConstraint]),
      },
    };
  }

  const setVersion = extractDirectiveValue(chatInput, "set\\s+version");
  if (setVersion) {
    return {
      ...control,
      version: setVersion,
    };
  }

  return control;
}
