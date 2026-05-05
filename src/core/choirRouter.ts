export type Intent =
  | "define-intent"
  | "analyze"
  | "plan"
  | "execute"
  | "preview"
  | "status";

export type RoleName = "architect" | "analyst" | "enforcer" | "conductor";

export type CapabilityAction = "modify-yaml" | "read-state" | "modify-code" | "plan" | "schedule";

export type NormalizedCommand = {
  raw: string;
  normalized: string;
  tokens: string[];
};

export type RouterTrace = {
  intent: Intent;
  rolesInvoked: string[];
  steps: string[];
  decisions: string[];
};

export type RouterRoleHandlers<TContext> = {
  architect: {
    handle: (input: string, context: TContext) => Promise<void>;
  };
  analyst: {
    handle: (input: string, context: TContext) => Promise<void>;
    status: (context: TContext) => Promise<void>;
  };
  enforcer: {
    handle: (input: string, context: TContext) => Promise<void>;
  };
  conductor: {
    handle: (input: string, context: TContext) => Promise<void>;
    plan: (input: string, context: TContext) => Promise<void>;
    preview: (input: string, context: TContext) => Promise<void>;
    execute: (input: string, context: TContext) => Promise<void>;
  };
};

const CAPABILITY_RULES: Record<RoleName, CapabilityAction[]> = {
  architect: ["modify-yaml"],
  analyst: ["read-state"],
  conductor: ["plan", "schedule"],
  enforcer: ["modify-code"],
};

function tokenize(input: string): string[] {
  return input
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function normalizeInput(input: string): NormalizedCommand {
  const raw = input.trim();
  const normalized = raw.toLowerCase();
  return {
    raw,
    normalized,
    tokens: tokenize(normalized),
  };
}

export function classifyIntent(input: string): Intent {
  const normalized = input.toLowerCase().trim();

  if (/^preview\b/.test(normalized)) return "preview";
  if (/^(execute|run)\b/.test(normalized)) return "execute";
  if (/^plan\b/.test(normalized)) return "plan";

  if (normalized.includes("goal") || normalized.includes("constraint")) return "define-intent";
  if (normalized.includes("analyze") || normalized.includes("summary")) return "analyze";
  if (normalized.includes("preview")) return "preview";
  if (normalized.includes("execute") || normalized.includes("run")) return "execute";
  if (normalized.includes("plan")) return "plan";

  return "status";
}

export function enforceCapabilities(role: RoleName, action: CapabilityAction): void {
  const allowed = CAPABILITY_RULES[role] ?? [];
  if (!allowed.includes(action)) {
    throw new Error(`Capability violation: ${role} cannot ${action}`);
  }
}

function trimPrefix(input: string, prefix: string): string {
  const sliced = input.slice(prefix.length).trim();
  return sliced.length > 0 ? sliced : "status";
}

function extractLegacyRoute(input: string): { role: RoleName; stripped: string } | null {
  const normalized = input.toLowerCase();

  if (normalized.startsWith("@choir.architect")) {
    return { role: "architect", stripped: trimPrefix(input, "@choir.architect") };
  }

  if (normalized.startsWith("@choir.analyst")) {
    return { role: "analyst", stripped: trimPrefix(input, "@choir.analyst") };
  }

  if (normalized.startsWith("@choir.enforcer")) {
    return { role: "enforcer", stripped: trimPrefix(input, "@choir.enforcer") };
  }

  if (normalized.startsWith("@choir.conductor")) {
    return { role: "conductor", stripped: trimPrefix(input, "@choir.conductor") };
  }

  return null;
}

function isHighLevelCommand(command: NormalizedCommand): boolean {
  return command.tokens[0] === "enforce" && command.tokens.length > 1;
}

function toConductorCommand(intent: Intent, command: NormalizedCommand): string {
  if (intent === "plan") {
    return command.normalized.includes("plan") ? command.raw : "plan";
  }

  if (intent === "preview") {
    return command.normalized.includes("preview") ? command.raw : "preview";
  }

  if (intent === "execute") {
    return command.normalized.includes("execute") ? command.raw : "execute";
  }

  return "status";
}

export async function routeIntent<TContext>(
  handlers: RouterRoleHandlers<TContext>,
  intent: Intent,
  input: string,
  context: TContext
): Promise<RouterTrace> {
  const rolesInvoked: string[] = [];
  const steps: string[] = [];
  const decisions: string[] = [];

  switch (intent) {
    case "define-intent":
      await handlers.architect.handle(input, context);
      rolesInvoked.push("architect");
      steps.push("architect.handle");
      decisions.push("Routed define-intent to architect");
      break;

    case "analyze":
      await handlers.analyst.handle(input, context);
      rolesInvoked.push("analyst");
      steps.push("analyst.handle");
      decisions.push("Routed analyze intent to analyst");
      break;

    case "plan":
      await handlers.conductor.plan(input, context);
      rolesInvoked.push("conductor");
      steps.push("conductor.plan");
      decisions.push("Routed plan intent to conductor.plan");
      break;

    case "preview":
      await handlers.conductor.preview(input, context);
      rolesInvoked.push("conductor");
      steps.push("conductor.preview");
      decisions.push("Routed preview intent to conductor.preview");
      break;

    case "execute":
      await handlers.conductor.execute(input, context);
      rolesInvoked.push("conductor");
      steps.push("conductor.execute");
      decisions.push("Routed execute intent to conductor.execute");
      break;

    case "status":
      await handlers.analyst.status(context);
      rolesInvoked.push("analyst");
      steps.push("analyst.status");
      decisions.push("Defaulted to analyst.status");
      break;
  }

  return {
    intent,
    rolesInvoked,
    steps,
    decisions,
  };
}

async function routeHighLevelCommand<TContext>(
  handlers: RouterRoleHandlers<TContext>,
  command: NormalizedCommand,
  context: TContext
): Promise<RouterTrace> {
  const objective = command.tokens.slice(1).join(" ").trim();
  const architectInput = objective.length > 0 ? `add constraint: ${objective}` : command.raw;

  await handlers.architect.handle(architectInput, context);
  await handlers.analyst.handle("find violations", context);
  await handlers.conductor.plan("plan", context);
  await handlers.conductor.preview("preview", context);

  return {
    intent: "plan",
    rolesInvoked: ["architect", "analyst", "conductor", "conductor"],
    steps: [
      "architect.handle",
      "analyst.handle",
      "conductor.plan",
      "conductor.preview",
    ],
    decisions: [
      `Detected high-level command: ${command.raw}`,
      "Applied deterministic multi-role orchestration",
    ],
  };
}

export class ChoirAgent<TContext> {
  constructor(private readonly handlers: RouterRoleHandlers<TContext>) {}

  async handle(input: string, context: TContext): Promise<RouterTrace> {
    const trimmed = input.trim();
    const legacy = extractLegacyRoute(trimmed);

    if (legacy) {
      if (legacy.role === "architect") {
        await this.handlers.architect.handle(legacy.stripped, context);
        return {
          intent: "define-intent",
          rolesInvoked: ["architect"],
          steps: ["architect.handle"],
          decisions: ["Legacy alias route: @choir.architect"],
        };
      }

      if (legacy.role === "analyst") {
        await this.handlers.analyst.handle(legacy.stripped, context);
        return {
          intent: "analyze",
          rolesInvoked: ["analyst"],
          steps: ["analyst.handle"],
          decisions: ["Legacy alias route: @choir.analyst"],
        };
      }

      if (legacy.role === "enforcer") {
        await this.handlers.enforcer.handle(legacy.stripped, context);
        return {
          intent: "execute",
          rolesInvoked: ["enforcer"],
          steps: ["enforcer.handle"],
          decisions: ["Legacy alias route: @choir.enforcer"],
        };
      }

      await this.handlers.conductor.handle(legacy.stripped, context);
      return {
        intent: classifyIntent(legacy.stripped),
        rolesInvoked: ["conductor"],
        steps: ["conductor.handle"],
        decisions: ["Legacy alias route: @choir.conductor"],
      };
    }

    const normalized = normalizeInput(trimmed);

    if (isHighLevelCommand(normalized)) {
      return routeHighLevelCommand(this.handlers, normalized, context);
    }

    const intent = classifyIntent(normalized.normalized);
    const routedInput = toConductorCommand(intent, normalized);

    return routeIntent(this.handlers, intent, routedInput, context);
  }
}
