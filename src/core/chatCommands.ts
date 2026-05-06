import { InitTemplateName } from "./initWizard.js";

export type AbstractionChatCommand =
  | { type: "list" }
  | { type: "describe"; id: string }
  | { type: "run"; id: string };

export type InitChatCommand = {
  type: "init";
  template?: InitTemplateName;
  invalidTemplate?: string;
};

export type GraphChatCommand = {
  mode: "full" | "focused" | "dependency" | "dependents";
  nodeId?: string;
};

export type PanelChatCommand = {
  target: "control" | "timeline";
};

export type VerifyChatCommand = {
  type: "verify";
  mode: "full" | "quick" | "property" | "chaos";
  chaosMode?: "none" | "light" | "moderate" | "extreme";
};

export function parseAbstractionChatCommand(input: string): AbstractionChatCommand | null {
  const normalized = input.trim();

  if (/^(?:@choir\s+)?list\s+abstractions\s*$/i.test(normalized)) {
    return { type: "list" };
  }

  const describe = normalized.match(/^(?:@choir\s+)?describe\s+([a-zA-Z0-9._-]+)\s*$/i);
  if (describe) {
    return { type: "describe", id: describe[1] as string };
  }

  const run = normalized.match(/^(?:@choir\s+)?run\s+([a-zA-Z0-9._-]+)\s*$/i);
  if (run) {
    return { type: "run", id: run[1] as string };
  }

  return null;
}

export function parseInitChatCommand(input: string): InitChatCommand | null {
  const normalized = input.trim();
  const match = normalized.match(/^(?:@choir\s+)?init(?:\s+--template\s+([a-zA-Z0-9._-]+))?\s*$/i);
  if (!match) {
    return null;
  }

  const templateValue = match[1]?.toLowerCase();
  if (!templateValue) {
    return { type: "init" };
  }

  if (templateValue === "backend" || templateValue === "frontend") {
    return { type: "init", template: templateValue };
  }

  return {
    type: "init",
    invalidTemplate: templateValue,
  };
}

export function parseGraphChatCommand(input: string): GraphChatCommand | null {
  const normalized = input.trim();

  if (/^(?:@choir\s+)?graph\s*$/i.test(normalized)) {
    return { mode: "full" };
  }

  const focus = normalized.match(/^(?:@choir\s+)?graph\s+focus\s+([a-zA-Z0-9._/-]+)\s*$/i);
  if (focus) {
    return {
      mode: "focused",
      nodeId: focus[1],
    };
  }

  const dependencies = normalized.match(/^(?:@choir\s+)?graph\s+dependencies\s+([a-zA-Z0-9._/-]+)\s*$/i);
  if (dependencies) {
    return {
      mode: "dependency",
      nodeId: dependencies[1],
    };
  }

  const dependents = normalized.match(/^(?:@choir\s+)?graph\s+dependents\s+([a-zA-Z0-9._/-]+)\s*$/i);
  if (dependents) {
    return {
      mode: "dependents",
      nodeId: dependents[1],
    };
  }

  return null;
}

export function parsePanelChatCommand(input: string): PanelChatCommand | null {
  const normalized = input.trim();

  if (/^(?:@choir\s+)?control\s*$/i.test(normalized)) {
    return { target: "control" };
  }

  if (/^(?:@choir\s+)?timeline\s*$/i.test(normalized)) {
    return { target: "timeline" };
  }

  return null;
}

export function parseVerifyChatCommand(input: string): VerifyChatCommand | null {
  const normalized = input.trim();

  if (/^(?:@choir\s+)?verify\s+--property\s*$/i.test(normalized)) {
    return {
      type: "verify",
      mode: "property",
    };
  }

  const chaos = normalized.match(/^(?:@choir\s+)?verify\s+--chaos(?:\s+(none|light|moderate|extreme))?\s*$/i);
  if (chaos) {
    return {
      type: "verify",
      mode: "chaos",
      ...(chaos[1] ? { chaosMode: chaos[1].toLowerCase() as VerifyChatCommand["chaosMode"] } : {}),
    };
  }

  if (/^(?:@choir\s+)?verify\s*$/i.test(normalized)) {
    return {
      type: "verify",
      mode: "full",
    };
  }

  if (/^(?:@choir\s+)?verify\s+--quick\s*$/i.test(normalized)) {
    return {
      type: "verify",
      mode: "quick",
    };
  }

  return null;
}
