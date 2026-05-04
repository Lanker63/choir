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

function parseCommaDelimitedItems(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function applyChatToControlPlane(chatInput: string, control: ControlPlane): ControlPlane {
  const setMission = extractDirectiveValue(chatInput, "set\\s+mission");
  if (setMission) {
    return {
      ...control,
      mission: setMission,
    };
  }

  const setVision = extractDirectiveValue(chatInput, "set\\s+vision");
  if (setVision) {
    return {
      ...control,
      vision: setVision,
    };
  }

  const addNonGoals = extractDirectiveValue(chatInput, "add\\s+non[-\\s]?goals");
  if (addNonGoals) {
    return {
      ...control,
      "non-goals": withUniqueItems([...(control["non-goals"] ?? []), ...parseCommaDelimitedItems(addNonGoals)]),
    };
  }

  const addNonGoal = extractDirectiveValue(chatInput, "add\\s+non[-\\s]?goal");
  if (addNonGoal) {
    return {
      ...control,
      "non-goals": withUniqueItems([...(control["non-goals"] ?? []), addNonGoal]),
    };
  }

  const removeNonGoals = extractDirectiveValue(chatInput, "remove\\s+non[-\\s]?goals");
  if (removeNonGoals) {
    const toRemove = new Set(parseCommaDelimitedItems(removeNonGoals));
    return {
      ...control,
      "non-goals": (control["non-goals"] ?? []).filter((nonGoal) => !toRemove.has(nonGoal)),
    };
  }

  const removeNonGoal = extractDirectiveValue(chatInput, "remove\\s+non[-\\s]?goal");
  if (removeNonGoal) {
    return {
      ...control,
      "non-goals": (control["non-goals"] ?? []).filter((nonGoal) => nonGoal !== removeNonGoal),
    };
  }

  const addGoals = extractDirectiveValue(chatInput, "add\\s+goals");
  if (addGoals) {
    return {
      ...control,
      intent: {
        ...control.intent,
        goals: withUniqueItems([...control.intent.goals, ...parseCommaDelimitedItems(addGoals)]),
      },
    };
  }

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

  const removeGoals = extractDirectiveValue(chatInput, "remove\\s+goals");
  if (removeGoals) {
    const toRemove = new Set(parseCommaDelimitedItems(removeGoals));
    return {
      ...control,
      intent: {
        ...control.intent,
        goals: control.intent.goals.filter((goal) => !toRemove.has(goal)),
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

  const addConstraints = extractDirectiveValue(chatInput, "add\\s+constraints");
  if (addConstraints) {
    return {
      ...control,
      intent: {
        ...control.intent,
        constraints: withUniqueItems([...control.intent.constraints, ...parseCommaDelimitedItems(addConstraints)]),
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

  const removeConstraints = extractDirectiveValue(chatInput, "remove\\s+constraints");
  if (removeConstraints) {
    const toRemove = new Set(parseCommaDelimitedItems(removeConstraints));
    return {
      ...control,
      intent: {
        ...control.intent,
        constraints: control.intent.constraints.filter((constraint) => !toRemove.has(constraint)),
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
