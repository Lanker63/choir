import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { generatePlan } from "./orchestration.js";
import { createEmptyStatePlane, readStatePlane, StatePlane } from "./state.js";
import {
  AST,
  ActionNode,
  parse,
  tokenize,
  validGrammar,
} from "./choirRouter.js";
import { ControlPlane, ControlPlaneSchema, Plan } from "../schema.js";

export type ChoirConfig = {
  version: string;
  mission?: string;
  vision?: string;
  intent: {
    goals: string[];
    constraints: string[];
    nonGoals: string[];
  };
  policy: {
    rules: ControlPlane["policy"]["rules"];
    priorityOverrides?: ControlPlane["policy"]["priorityOverrides"];
  };
  execution: {
    plans: Plan[];
  };
};

export type CompilationChange = {
  field: string;
  before: unknown;
  after: unknown;
};

export type CompilationTrace = {
  input: string;
  ast: AST;
  changes: CompilationChange[];
};

type CompilerContext = {
  state: StatePlane;
};

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)))
    .sort((left, right) => left.localeCompare(right));
}

function canonicalizePlan(plan: Plan): Plan {
  return {
    ...plan,
    ...(Array.isArray(plan.goalRefs)
      ? { goalRefs: sortedUnique(plan.goalRefs) }
      : {}),
    tasks: [...plan.tasks]
      .map((task) => ({
        ...task,
        dependsOn: sortedUnique(task.dependsOn ?? []),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function canonicalizeConfig(config: ChoirConfig): ChoirConfig {
  return {
    version: config.version,
    mission: (config.mission ?? "").trim(),
    vision: (config.vision ?? "").trim(),
    intent: {
      goals: sortedUnique(config.intent.goals),
      constraints: sortedUnique(config.intent.constraints),
      nonGoals: sortedUnique(config.intent.nonGoals),
    },
    policy: {
      rules: [...config.policy.rules],
      ...(config.policy.priorityOverrides ? { priorityOverrides: config.policy.priorityOverrides } : {}),
    },
    execution: {
      plans: [...config.execution.plans]
        .map((plan) => canonicalizePlan(plan))
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
  };
}

export function controlPlaneToChoirConfig(control: ControlPlane): ChoirConfig {
  return canonicalizeConfig({
    version: control.version,
    mission: control.mission,
    vision: control.vision,
    intent: {
      goals: control.intent.goals,
      constraints: control.intent.constraints,
      nonGoals: control.intent["non-goals"],
    },
    policy: {
      rules: control.policy.rules,
      ...(control.policy.priorityOverrides ? { priorityOverrides: control.policy.priorityOverrides } : {}),
    },
    execution: {
      plans: control.execution.plans,
    },
  });
}

export function choirConfigToControlPlane(config: ChoirConfig): ControlPlane {
  const canonical = canonicalizeConfig(config);
  return ControlPlaneSchema.parse({
    version: canonical.version,
    mission: canonical.mission ?? "",
    vision: canonical.vision ?? "",
    intent: {
      goals: canonical.intent.goals,
      constraints: canonical.intent.constraints,
      "non-goals": canonical.intent.nonGoals,
    },
    policy: {
      rules: canonical.policy.rules,
      ...(canonical.policy.priorityOverrides ? { priorityOverrides: canonical.policy.priorityOverrides } : {}),
    },
    execution: {
      plans: canonical.execution.plans,
    },
  });
}

export function upsert(list: string[], value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Invalid Choir DSL command: empty value is not allowed");
  }

  if (list.includes(trimmed)) {
    return sortedUnique(list);
  }

  return sortedUnique([...list, trimmed]);
}

export function upsertPlan(plans: Plan[], plan: Plan): Plan[] {
  if (plans.some((existing) => existing.id === plan.id)) {
    return [...plans].map((existing) => canonicalizePlan(existing)).sort((left, right) => left.id.localeCompare(right.id));
  }

  return [...plans, canonicalizePlan(plan)].sort((left, right) => left.id.localeCompare(right.id));
}

function snapshot(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function trackChange(
  changes: CompilationChange[],
  field: string,
  before: unknown,
  after: unknown
): void {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return;
  }

  changes.push({
    field,
    before: snapshot(before),
    after: snapshot(after),
  });
}

function compileActionToYAML(
  action: ActionNode,
  config: ChoirConfig,
  context: CompilerContext,
  changes: CompilationChange[]
): ChoirConfig {
  const next = canonicalizeConfig(config);

  if (action.type === "define") {
    if (action.defineType === "goal") {
      const before = next.intent.goals;
      const after = upsert(before, action.value);
      trackChange(changes, "intent.goals", before, after);
      return {
        ...next,
        intent: {
          ...next.intent,
          goals: after,
        },
      };
    }

    if (action.defineType === "constraint") {
      const before = next.intent.constraints;
      const after = upsert(before, action.value);
      trackChange(changes, "intent.constraints", before, after);
      return {
        ...next,
        intent: {
          ...next.intent,
          constraints: after,
        },
      };
    }

    const before = next.intent.nonGoals;
    const after = upsert(before, action.value);
    trackChange(changes, "intent.nonGoals", before, after);
    return {
      ...next,
      intent: {
        ...next.intent,
        nonGoals: after,
      },
    };
  }

  if (action.type === "plan") {
    const generated = generatePlan(choirConfigToControlPlane(next), context.state);
    const draftPlan: Plan = {
      ...generated,
      ...(action.target ? { goalRefs: [action.target] } : {}),
      status: "draft",
    };

    const before = next.execution.plans;
    const after = upsertPlan(before, draftPlan);
    trackChange(changes, "execution.plans", before.map((plan) => plan.id), after.map((plan) => plan.id));

    return {
      ...next,
      execution: {
        ...next.execution,
        plans: after,
      },
    };
  }

  // analyze/preview/execute/status are non-mutating in YAML compiler mode.
  return next;
}

export function compileASTToYAML(
  ast: AST,
  config: ChoirConfig,
  context: CompilerContext
): { config: ChoirConfig; changes: CompilationChange[] } {
  const changes: CompilationChange[] = [];
  let next = canonicalizeConfig(config);

  if (ast.type === "sequence") {
    for (const action of ast.actions) {
      next = compileActionToYAML(action, next, context, changes);
    }

    return {
      config: canonicalizeConfig(next),
      changes,
    };
  }

  next = compileActionToYAML(ast, next, context, changes);
  return {
    config: canonicalizeConfig(next),
    changes,
  };
}

export function validateSchema(config: ChoirConfig): ControlPlane {
  return choirConfigToControlPlane(config);
}

export function serializeYAML(config: ChoirConfig): string {
  const control = validateSchema(canonicalizeConfig(config));
  const ordered: ControlPlane = {
    version: control.version,
    mission: control.mission,
    vision: control.vision,
    intent: {
      goals: sortedUnique(control.intent.goals),
      constraints: sortedUnique(control.intent.constraints),
      "non-goals": sortedUnique(control.intent["non-goals"]),
    },
    policy: {
      rules: [...control.policy.rules],
      ...(control.policy.priorityOverrides ? { priorityOverrides: control.policy.priorityOverrides } : {}),
    },
    execution: {
      plans: [...control.execution.plans]
        .map((plan) => canonicalizePlan(plan))
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
  };

  return YAML.stringify(ordered);
}

export function writeYAML(config: ChoirConfig, controlPath: string): void {
  const yaml = serializeYAML(config);
  fs.mkdirSync(path.dirname(controlPath), { recursive: true });
  fs.writeFileSync(controlPath, yaml, "utf-8");
}

export function hashConfig(config: ChoirConfig): string {
  const canonical = canonicalizeConfig(config);
  const payload = JSON.stringify(canonical);
  return createHash("sha256").update(payload).digest("hex");
}

export function compileDSL(
  input: string,
  controlPlane: ControlPlane,
  options?: {
    workspaceRoot?: string;
  }
): {
  updatedControlPlane: ControlPlane;
  changed: boolean;
  trace: CompilationTrace;
} {
  const tokens = tokenize(input);
  const ast = parse(tokens);

  if (!validGrammar(ast)) {
    throw new Error("Invalid Choir DSL command");
  }

  const baseConfig = controlPlaneToChoirConfig(controlPlane);
  const state = options?.workspaceRoot
    ? (readStatePlane(options.workspaceRoot) ?? createEmptyStatePlane())
    : createEmptyStatePlane();

  const compiled = compileASTToYAML(ast, baseConfig, { state });
  const updatedControl = validateSchema(compiled.config);

  const beforeHash = hashConfig(baseConfig);
  const afterHash = hashConfig(controlPlaneToChoirConfig(updatedControl));

  return {
    updatedControlPlane: updatedControl,
    changed: beforeHash !== afterHash,
    trace: {
      input,
      ast,
      changes: compiled.changes,
    },
  };
}

export function compileDSLAndWrite(
  input: string,
  controlPlane: ControlPlane,
  controlPath: string,
  options?: {
    workspaceRoot?: string;
  }
): {
  updatedControlPlane: ControlPlane;
  changed: boolean;
  trace: CompilationTrace;
} {
  const result = compileDSL(input, controlPlane, options);
  if (!result.changed) {
    return result;
  }

  const config = controlPlaneToChoirConfig(result.updatedControlPlane);
  writeYAML(config, controlPath);
  return result;
}
