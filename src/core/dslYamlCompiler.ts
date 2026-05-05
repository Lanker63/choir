import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { generatePlan } from "./orchestration.js";
import {
  approvePendingDiff,
  createEmptyStatePlane,
  hasApprovalForDiff,
  listPendingApprovals,
  readStatePlane,
  rejectPendingDiff,
  StatePlane,
  upsertPendingApproval,
} from "./state.js";
import {
  AST,
  ActionNode,
  parse,
  tokenize,
  validGrammar,
} from "./choirRouter.js";
import { ControlPlane, ControlPlaneSchema, Plan } from "../schema.js";
import { computeDiff, evaluatePolicies, hashDiff, toPolicySet } from "./policyEngine.js";

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
    approvalRules: ControlPlane["policy"]["approvalRules"];
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

export type CompilationDecision = "allow" | "deny" | "require-approval" | "no-change";

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
      approvalRules: [...config.policy.approvalRules].sort((left, right) => left.id.localeCompare(right.id)),
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
      approvalRules: control.policy.approvalRules,
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
      approvalRules: canonical.policy.approvalRules,
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

  if (action.type === "macro-list" || action.type === "macro-show" || action.type === "macro-run") {
    throw new Error("Macro commands must be expanded into concrete Choir DSL commands before YAML compilation");
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
      approvalRules: [...control.policy.approvalRules].sort((left, right) => left.id.localeCompare(right.id)),
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
    commandActor?: string;
  }
): {
  updatedControlPlane: ControlPlane;
  changed: boolean;
  trace: CompilationTrace;
  decision: CompilationDecision;
  diffHash?: string;
  pendingApprovalId?: string;
  policyResult?: {
    allowed: boolean;
    requiresApproval: boolean;
    violations: { ruleId: string; message: string }[];
  };
  policyTrace?: {
    diffCount: number;
    rulesMatched: string[];
    requiresApproval: boolean;
    denied: boolean;
    decision: string;
  };
} {
  const result = compileDSL(input, controlPlane, options);
  if (!result.changed) {
    return {
      ...result,
      decision: "no-change",
    };
  }

  const beforeConfig = controlPlaneToChoirConfig(controlPlane);
  const afterConfig = controlPlaneToChoirConfig(result.updatedControlPlane);
  const diffs = computeDiff(beforeConfig, afterConfig);
  const diffHash = hashDiff(diffs);

  const policySet = toPolicySet(controlPlane.policy.approvalRules ?? []);
  const policyEvaluation = evaluatePolicies(diffs, policySet);

  if (!policyEvaluation.result.allowed) {
    return {
      ...result,
      decision: "deny",
      diffHash,
      policyResult: policyEvaluation.result,
      policyTrace: policyEvaluation.trace,
    };
  }

  const workspaceRoot = options?.workspaceRoot;
  if (policyEvaluation.result.requiresApproval) {
    if (!workspaceRoot) {
      return {
        ...result,
        decision: "require-approval",
        diffHash,
        pendingApprovalId: `diff-${diffHash.slice(0, 12)}`,
        policyResult: policyEvaluation.result,
        policyTrace: policyEvaluation.trace,
      };
    }

    const approved = hasApprovalForDiff(workspaceRoot, diffHash);
    if (!approved) {
      const pendingId = `diff-${diffHash.slice(0, 12)}`;
      upsertPendingApproval(workspaceRoot, {
        id: pendingId,
        diffHash,
        diffs,
        createdAt: new Date().toISOString(),
        command: input,
      });

      return {
        ...result,
        decision: "require-approval",
        diffHash,
        pendingApprovalId: pendingId,
        policyResult: policyEvaluation.result,
        policyTrace: policyEvaluation.trace,
      };
    }
  }

  const config = controlPlaneToChoirConfig(result.updatedControlPlane);
  writeYAML(config, controlPath);

  if (workspaceRoot && policyEvaluation.result.requiresApproval) {
    const pendingId = `diff-${diffHash.slice(0, 12)}`;
    rejectPendingDiff(workspaceRoot, pendingId);
  }

  return {
    ...result,
    decision: "allow",
    diffHash,
    policyResult: policyEvaluation.result,
    policyTrace: policyEvaluation.trace,
  };
}

export function approveDiff(
  root: string,
  diffId: string,
  approvedBy: string
): { approved: boolean; diffHash?: string } {
  const approved = approvePendingDiff(root, diffId, approvedBy, new Date().toISOString());
  if (!approved.approved) {
    return { approved: false };
  }

  return {
    approved: true,
    diffHash: approved.approved.diffHash,
  };
}

export function rejectDiff(root: string, diffId: string): { removed: boolean } {
  const rejected = rejectPendingDiff(root, diffId);
  return {
    removed: rejected.removed,
  };
}

export function policyStatus(root: string): {
  pending: Array<{ id: string; diffHash: string; createdAt: string; command: string }>;
} {
  const pending = listPendingApprovals(root)
    .map((entry) => ({
      id: entry.id,
      diffHash: entry.diffHash,
      createdAt: entry.createdAt,
      command: entry.command,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return { pending };
}
