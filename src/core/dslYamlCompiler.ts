import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { cloneJson } from "../utils/clone.js";
import { generatePlan } from "./orchestration.js";
import {
  buildState,
  approvePendingDiff,
  createEmptyStatePlane,
  hasApprovalForDiff,
  listPendingApprovals,
  persistStatePlane,
  readStatePlane,
  rejectPendingDiff,
  StatePlane,
  validateFullVsIncrementalState,
  upsertPendingApproval,
} from "./state.js";
import {
  DecisionTrace,
  recordAudit,
} from "./audit.js";
import {
  AST,
  ActionNode,
} from "./choirRouter.js";
import {
  RuleResult,
  ValidationTrace,
} from "./astValidation.js";
import { compileInput } from "./compilerPipeline.js";
import { MacroLibraryTrace } from "./macroLibraries.js";
import { ControlPlane, ControlPlaneSchema, Plan } from "../schema.js";
import {
  Environment,
  ExecutionContext,
  Role,
  PolicyAction,
  computeDiff,
  detectEnvironment,
  evaluatePolicies,
  hashDiff,
  validateRole,
} from "./policyEngine.js";
import { loadPolicies } from "./policyDsl.js";

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
  runtime?: {
    mode: NonNullable<ControlPlane["runtime"]>["mode"];
  };
  capabilities?: ControlPlane["capabilities"];
  packageModes?: ControlPlane["packageModes"];
  domains?: ControlPlane["domains"];
  packages?: ControlPlane["packages"];
  contexts?: ControlPlane["contexts"];
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
  validation: ValidationTrace;
  ruleResults: RuleResult[];
};

export type CompilationDecision = "allow" | "deny" | "require-approval" | "no-change";

export type NormalizedPlan = {
  plans: Array<{
    id: string;
    status: Plan["status"];
    goalRefs: string[];
    tasks: Array<{
      id: string;
      action: string;
      dependsOn: string[];
    }>;
  }>;
};

export type NormalizedPolicies = {
  rules: Array<{
    id: string;
    effect: string;
  }>;
};

export type IR = {
  plan: NormalizedPlan;
  policies: NormalizedPolicies;
  config: ChoirConfig;
};

type CompilerContext = {
  state: StatePlane;
};

function capabilitiesForAction(action: ActionNode): PolicyAction[] {
  if (action.type === "define") {
    return ["modify-yaml"];
  }

  if (action.type === "plan") {
    return ["plan"];
  }

  if (action.type === "plan-approve") {
    return ["plan"];
  }

  if (action.type === "ci-run") {
    return ["plan"];
  }

  if (action.type === "abstraction-run") {
    return ["plan"];
  }

  if (action.type === "preview") {
    return ["preview"];
  }

  if (action.type === "execute") {
    return ["execute"];
  }

  if (action.type === "rollback") {
    return ["execute"];
  }

  return ["read-only"];
}

function inferRoleFromAST(ast: AST): Role {
  if (ast.type === "sequence") {
    const roles = new Set<Role>();
    for (const action of ast.actions) {
      if (action.type === "define") {
        roles.add("architect");
      } else if (action.type === "plan" || action.type === "plan-approve" || action.type === "preview" || action.type === "ci-run" || action.type === "abstraction-run") {
        roles.add("conductor");
      } else if (action.type === "execute") {
        roles.add("enforcer");
      } else if (action.type === "rollback") {
        roles.add("enforcer");
      } else {
        roles.add("analyst");
      }
    }

    if (roles.size > 1) {
      throw new Error("Role violation: mixed-role command sequence is not allowed");
    }

    return [...roles][0] ?? "analyst";
  }

  if (ast.type === "define") {
    return "architect";
  }

  if (ast.type === "plan" || ast.type === "plan-approve" || ast.type === "preview" || ast.type === "ci-run" || ast.type === "abstraction-run") {
    return "conductor";
  }

  if (ast.type === "execute") {
    return "enforcer";
  }

  if (ast.type === "rollback") {
    return "enforcer";
  }

  return "analyst";
}

function inferPolicyRoot(controlPath: string, workspaceRoot?: string): string {
  if (workspaceRoot) {
    return workspaceRoot;
  }

  const choirDir = path.dirname(controlPath);
  if (path.basename(choirDir) === ".choir") {
    return path.dirname(choirDir);
  }

  return path.dirname(controlPath);
}

function toDecisionTrace(
  policyTrace: {
    policyDslTrace: Array<{
      policyId: string;
      source: "org" | "repo" | "environment";
      matched: boolean;
      effect: "allow" | "require-approval" | "deny";
    }>;
    decision: "allow" | "require-approval" | "deny";
  },
  reasoning: string
): DecisionTrace {
  return {
    policiesEvaluated: [...policyTrace.policyDslTrace]
      .map((entry) => ({
        policyId: entry.policyId,
        source: entry.source,
        matched: entry.matched,
        effect: entry.effect,
      }))
      .sort((left, right) =>
        left.source.localeCompare(right.source)
        || left.policyId.localeCompare(right.policyId)
      ),
    finalDecision: policyTrace.decision,
    reasoning,
  };
}

function writeAuditEvent(
  root: string,
  event: {
    role: Role;
    actorId?: string;
    environment: Environment;
    action: string;
    resource: string;
    diff?: import("./policyEngine.js").YAMLDiff[];
    result: "success" | "failure";
    metadata?: Record<string, unknown>;
    decisionTrace: DecisionTrace;
    executionTrace?: {
      planId: string;
      patchesApplied: number;
      filesChanged: number;
    };
  }
): void {
  recordAudit(root, {
    auditEvent: {
      id: "",
      timestamp: "",
      actor: {
        role: event.role,
        ...(event.actorId ? { id: event.actorId } : {}),
      },
      environment: event.environment,
      action: event.action,
      resource: event.resource,
      ...(event.diff ? { diff: event.diff } : {}),
      result: event.result,
      ...(event.metadata ? { metadata: event.metadata } : {}),
    },
    decisionTrace: event.decisionTrace,
    ...(event.executionTrace ? { executionTrace: event.executionTrace } : {}),
  });
}

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
  const packageModeEntries = Object.entries(config.packageModes ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([packageName, value]) => ([
      packageName,
      {
        ...(value.mode ? { mode: value.mode } : {}),
        ...(value.capabilities
          ? {
            capabilities: Object.fromEntries(
              Object.entries(value.capabilities)
                .sort(([left], [right]) => left.localeCompare(right))
            ) as NonNullable<ChoirConfig["packageModes"]>[string]["capabilities"],
          }
          : {}),
      },
    ] as const));

  const domainEntries = Object.entries(config.domains ?? {})
    .sort(([left], [right]) => left.localeCompare(right));

  const packageEntries = Object.entries(config.packages ?? {})
    .sort(([left], [right]) => left.localeCompare(right));

  const contextEntries = Object.entries(config.contexts ?? {})
    .sort(([left], [right]) => left.localeCompare(right));

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
    ...(config.runtime
      ? {
        runtime: {
          mode: config.runtime.mode,
        },
      }
      : {}),
    ...(config.capabilities
      ? {
        capabilities: Object.fromEntries(
          Object.entries(config.capabilities)
            .sort(([left], [right]) => left.localeCompare(right))
        ) as ChoirConfig["capabilities"],
      }
      : {}),
    ...(packageModeEntries.length > 0
      ? { packageModes: Object.fromEntries(packageModeEntries) }
      : {}),
    ...(domainEntries.length > 0 ? { domains: Object.fromEntries(domainEntries) } : {}),
    ...(packageEntries.length > 0 ? { packages: Object.fromEntries(packageEntries) } : {}),
    ...(contextEntries.length > 0 ? { contexts: Object.fromEntries(contextEntries) } : {}),
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
    ...(control.runtime ? { runtime: { mode: control.runtime.mode } } : {}),
    ...(control.capabilities ? { capabilities: control.capabilities } : {}),
    ...(control.packageModes ? { packageModes: control.packageModes } : {}),
    ...(control.domains && Object.keys(control.domains).length > 0 ? { domains: control.domains } : {}),
    ...(control.packages && Object.keys(control.packages).length > 0 ? { packages: control.packages } : {}),
    ...(control.contexts && Object.keys(control.contexts).length > 0 ? { contexts: control.contexts } : {}),
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
    ...(canonical.runtime ? { runtime: { mode: canonical.runtime.mode } } : {}),
    ...(canonical.capabilities ? { capabilities: canonical.capabilities } : {}),
    ...(canonical.packageModes ? { packageModes: canonical.packageModes } : {}),
    ...(canonical.domains ? { domains: canonical.domains } : {}),
    ...(canonical.packages ? { packages: canonical.packages } : {}),
    ...(canonical.contexts ? { contexts: canonical.contexts } : {}),
  });
}

export function buildIR(controlPlane: ControlPlane): IR {
  const config = controlPlaneToChoirConfig(controlPlane);
  return {
    plan: {
      plans: config.execution.plans
        .map((plan) => ({
          id: plan.id,
          status: plan.status,
          goalRefs: sortedUnique(plan.goalRefs ?? []),
          tasks: [...plan.tasks]
            .map((task) => ({
              id: task.id,
              action: task.type,
              dependsOn: sortedUnique(task.dependsOn ?? []),
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
    policies: {
      rules: [...config.policy.rules]
        .map((rule) => ({
          id: rule.id,
          effect: rule.constraint.type,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
    config,
  };
}

export function compileToYAML(ir: IR): string {
  return serializeYAML(ir.config);
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
  return cloneJson(value);
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
    if (action.defineType === "mission") {
      const before = next.mission ?? "";
      const after = action.value.trim();
      trackChange(changes, "mission", before, after);
      return {
        ...next,
        mission: after,
      };
    }

    if (action.defineType === "vision") {
      const before = next.vision ?? "";
      const after = action.value.trim();
      trackChange(changes, "vision", before, after);
      return {
        ...next,
        vision: after,
      };
    }

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
    if (action.optimize || action.adaptive) {
      return next;
    }

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

  if (action.type === "plan-approve") {
    const before = next.execution.plans;
    const target = before.find((plan) => plan.id === action.planId);
    if (!target) {
      return next;
    }

    const after = before
      .map((plan) => (plan.id === action.planId ? { ...plan, status: "approved" as const } : plan))
      .sort((left, right) => left.id.localeCompare(right.id));

    trackChange(
      changes,
      "execution.plans",
      before.map((plan) => `${plan.id}:${plan.status}`),
      after.map((plan) => `${plan.id}:${plan.status}`)
    );

    return {
      ...next,
      execution: {
        ...next.execution,
        plans: after,
      },
    };
  }

  if (
    action.type === "macro-list"
    || action.type === "macro-show"
    || action.type === "macro-run"
    || action.type === "import-library"
    || action.type === "library-list"
    || action.type === "library-install"
    || action.type === "library-update"
    || action.type === "library-lock"
    || action.type === "ci-run"
    || action.type === "abstraction-run"
  ) {
    throw new Error("System commands must execute outside YAML compilation mode");
  }

  // analyze/preview/execute/status/audit are non-mutating in YAML compiler mode.
  return next;
}

function isExecuteOnlyAst(ast: AST): boolean {
  if (ast.type === "execute") {
    return true;
  }

  return ast.type === "sequence"
    && ast.actions.length === 1
    && ast.actions[0]?.type === "execute";
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
    ...(control.runtime
      ? {
        runtime: {
          mode: control.runtime.mode,
        },
      }
      : {}),
    ...(control.packageModes ? { packageModes: control.packageModes } : {}),
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
  const pipeline = compileInput(input, controlPlane);

  const baseConfig = controlPlaneToChoirConfig(controlPlane);
  const state = options?.workspaceRoot
    ? (readStatePlane(options.workspaceRoot) ?? createEmptyStatePlane())
    : createEmptyStatePlane();

  const compiled = compileASTToYAML(pipeline.normalizedAst, baseConfig, { state });
  const updatedControl = validateSchema(compiled.config);

  const beforeHash = hashConfig(baseConfig);
  const afterHash = hashConfig(controlPlaneToChoirConfig(updatedControl));
  const changed = beforeHash !== afterHash;

  const synthesizedRuntimeControl = !changed
    && isExecuteOnlyAst(pipeline.normalizedAst)
    && !updatedControl.runtime
    && !updatedControl.packageModes
    ? {
      ...updatedControl,
      runtime: {
        mode: "execution-enabled" as const,
      },
    }
    : updatedControl;

  return {
    updatedControlPlane: synthesizedRuntimeControl,
    changed,
    trace: {
      input,
      ast: pipeline.normalizedAst,
      changes: compiled.changes,
      validation: pipeline.validationTrace,
      ruleResults: pipeline.ruleResults,
    },
  };
}

export function compile(
  input: string,
  controlPlane: ControlPlane,
  options?: {
    workspaceRoot?: string;
  }
): string {
  const compiled = compileDSL(input, controlPlane, options);
  const ir = buildIR(compiled.updatedControlPlane);
  return compileToYAML(ir);
}

export function compileDSLAndWrite(
  input: string,
  controlPlane: ControlPlane,
  controlPath: string,
  options?: {
    workspaceRoot?: string;
    actorId?: string;
    macroTrace?: MacroLibraryTrace;
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
    role: Role;
    environment: Environment;
    diffCount: number;
    rulesMatched: string[];
    requiresApproval: boolean;
    denied: boolean;
    decision: "allow" | "require-approval" | "deny";
    policyDslTrace: Array<{
      policyId: string;
      source: "org" | "repo" | "environment";
      matched: boolean;
      effect: "allow" | "require-approval" | "deny";
    }>;
    inheritanceTrace: {
      matchedRules: Array<{
        policyId: string;
        source: "org" | "repo" | "environment";
        effect: "allow" | "require-approval" | "deny";
      }>;
      finalDecision: "allow" | "require-approval" | "deny";
    };
  };
} {
  const auditRoot = inferPolicyRoot(controlPath, options?.workspaceRoot);

  try {
    const result = compileDSL(input, controlPlane, options);

    const role = inferRoleFromAST(result.trace.ast);
    const environment = detectEnvironment();
    const ctx: ExecutionContext = {
      role,
      environment,
      ...(options?.macroTrace
        ? {
          macroId: `${options.macroTrace.library}.${options.macroTrace.macroId}`,
        }
        : {}),
    };

    const actions = result.trace.ast.type === "sequence"
      ? result.trace.ast.actions
      : [result.trace.ast];
    const requiredCapabilities = Array.from(new Set(actions.flatMap((action) => capabilitiesForAction(action))));
    for (const capability of requiredCapabilities) {
      validateRole(ctx, capability);
    }

    if (!result.changed) {
      writeAuditEvent(auditRoot, {
        role: ctx.role,
        actorId: options?.actorId,
        environment: ctx.environment,
        action: "compile-dsl",
        resource: ".choir/choir.config.yaml",
        result: "success",
        metadata: {
          changed: false,
          decision: "no-change",
          command: input,
          ...(options?.macroTrace
            ? {
              macroLibrary: options.macroTrace.library,
              version: options.macroTrace.version,
              macroId: options.macroTrace.macroId,
              resolvedVersion: options.macroTrace.resolvedVersion,
            }
            : {}),
        },
        decisionTrace: {
          policiesEvaluated: [],
          finalDecision: "allow",
          reasoning: "No control-plane mutation required",
        },
      });

      return {
        ...result,
        decision: "no-change",
        policyTrace: {
          role: ctx.role,
          environment: ctx.environment,
          diffCount: 0,
          rulesMatched: [],
          requiresApproval: false,
          denied: false,
          decision: "allow",
          policyDslTrace: [],
          inheritanceTrace: {
            matchedRules: [],
            finalDecision: "allow",
          },
        },
      };
    }

    const beforeConfig = controlPlaneToChoirConfig(controlPlane);
    const afterConfig = controlPlaneToChoirConfig(result.updatedControlPlane);
    const diffs = computeDiff(beforeConfig, afterConfig);
    const diffHash = hashDiff(diffs);

    const policyRoot = inferPolicyRoot(controlPath, options?.workspaceRoot);
    const policySet = loadPolicies(policyRoot, environment);
    const policyEvaluation = evaluatePolicies(diffs, policySet, ctx);

    const decisionTrace = toDecisionTrace(
      policyEvaluation.trace,
      `Policy evaluation completed with decision=${policyEvaluation.trace.decision} and ${policyEvaluation.trace.rulesMatched.length} matched rule(s)`
    );

    writeAuditEvent(auditRoot, {
      role: ctx.role,
      actorId: options?.actorId,
      environment: ctx.environment,
      action: "policy-evaluation",
      resource: ".choir/policies.dsl",
      diff: diffs,
      result: policyEvaluation.result.allowed ? "success" : "failure",
      metadata: {
        diffHash,
        command: input,
        ...(options?.macroTrace
          ? {
            macroLibrary: options.macroTrace.library,
            version: options.macroTrace.version,
            macroId: options.macroTrace.macroId,
            resolvedVersion: options.macroTrace.resolvedVersion,
          }
          : {}),
      },
      decisionTrace,
    });

    if (!policyEvaluation.result.allowed) {
      writeAuditEvent(auditRoot, {
        role: ctx.role,
        actorId: options?.actorId,
        environment: ctx.environment,
        action: "compile-dsl",
        resource: ".choir/choir.config.yaml",
        diff: diffs,
        result: "failure",
        metadata: {
          diffHash,
          command: input,
          decision: "deny",
          violations: policyEvaluation.result.violations,
          ...(options?.macroTrace
            ? {
              macroLibrary: options.macroTrace.library,
              version: options.macroTrace.version,
              macroId: options.macroTrace.macroId,
              resolvedVersion: options.macroTrace.resolvedVersion,
            }
            : {}),
        },
        decisionTrace,
      });

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
        writeAuditEvent(auditRoot, {
          role: ctx.role,
          actorId: options?.actorId,
          environment: ctx.environment,
          action: "compile-dsl",
          resource: ".choir/choir.config.yaml",
          diff: diffs,
          result: "failure",
          metadata: {
            diffHash,
            command: input,
            decision: "require-approval",
            pendingApprovalId: `diff-${diffHash.slice(0, 12)}`,
            ...(options?.macroTrace
              ? {
                macroLibrary: options.macroTrace.library,
                version: options.macroTrace.version,
                macroId: options.macroTrace.macroId,
                resolvedVersion: options.macroTrace.resolvedVersion,
              }
              : {}),
          },
          decisionTrace,
        });

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

        writeAuditEvent(auditRoot, {
          role: ctx.role,
          actorId: options?.actorId,
          environment: ctx.environment,
          action: "compile-dsl",
          resource: ".choir/choir.config.yaml",
          diff: diffs,
          result: "failure",
          metadata: {
            diffHash,
            command: input,
            decision: "require-approval",
            pendingApprovalId: pendingId,
            ...(options?.macroTrace
              ? {
                macroLibrary: options.macroTrace.library,
                version: options.macroTrace.version,
                macroId: options.macroTrace.macroId,
                resolvedVersion: options.macroTrace.resolvedVersion,
              }
              : {}),
          },
          decisionTrace,
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

    writeAuditEvent(auditRoot, {
      role: ctx.role,
      actorId: options?.actorId,
      environment: ctx.environment,
      action: "compile-dsl",
      resource: ".choir/choir.config.yaml",
      diff: diffs,
      result: "success",
      metadata: {
        diffHash,
        command: input,
        decision: "allow",
        ...(options?.macroTrace
          ? {
            macroLibrary: options.macroTrace.library,
            version: options.macroTrace.version,
            macroId: options.macroTrace.macroId,
            resolvedVersion: options.macroTrace.resolvedVersion,
          }
          : {}),
      },
      decisionTrace,
    });

    const config = controlPlaneToChoirConfig(result.updatedControlPlane);
    writeYAML(config, controlPath);

    const stateRoot = options?.workspaceRoot ?? inferPolicyRoot(controlPath, options?.workspaceRoot);
    const previousState = readStatePlane(stateRoot) ?? createEmptyStatePlane();
    const incrementalState = buildState({
      yaml: result.updatedControlPlane,
      ast: result.trace.ast,
      ruleResults: result.trace.ruleResults,
      plans: result.updatedControlPlane.execution.plans,
      previous: previousState,
    });
    const fullState = buildState({
      yaml: result.updatedControlPlane,
      ast: result.trace.ast,
      ruleResults: result.trace.ruleResults,
      plans: result.updatedControlPlane.execution.plans,
      previous: createEmptyStatePlane(),
    });
    const recomputeCheck = validateFullVsIncrementalState(incrementalState, fullState);
    const stateToPersist = recomputeCheck.valid ? incrementalState : fullState;

    persistStatePlane(stateRoot, stateToPersist, {
      action: "compile-dsl",
      consistency: {
        yaml: result.updatedControlPlane,
        ast: result.trace.ast,
        ruleResults: result.trace.ruleResults,
      },
      metadata: {
        command: input,
        policyDecision: "allow",
        auditId: `compile-dsl-${diffHash.slice(0, 12)}`,
        ruleTriggers: Array.from(new Set(result.trace.ruleResults.map((entry) => entry.ruleId))).sort((left, right) => left.localeCompare(right)),
      },
    });

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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeAuditEvent(auditRoot, {
      role: "analyst",
      actorId: options?.actorId,
      environment: detectEnvironment(),
      action: "compile-dsl",
      resource: ".choir/choir.config.yaml",
      result: "failure",
      metadata: {
        command: input,
        error: message,
        ...(options?.macroTrace
          ? {
            macroLibrary: options.macroTrace.library,
            version: options.macroTrace.version,
            macroId: options.macroTrace.macroId,
            resolvedVersion: options.macroTrace.resolvedVersion,
          }
          : {}),
      },
      decisionTrace: {
        policiesEvaluated: [],
        finalDecision: "deny",
        reasoning: `Compilation failed: ${message}`,
      },
    });

    throw error;
  }
}

export function approveDiff(
  root: string,
  diffId: string,
  approvedBy: string
): { approved: boolean; diffHash?: string } {
  const approved = approvePendingDiff(root, diffId, approvedBy, new Date().toISOString());
  if (!approved.approved) {
    writeAuditEvent(root, {
      role: "architect",
      actorId: approvedBy,
      environment: detectEnvironment(),
      action: "approval-granted",
      resource: diffId,
      result: "failure",
      metadata: {
        reason: "pending-diff-not-found",
      },
      decisionTrace: {
        policiesEvaluated: [],
        finalDecision: "deny",
        reasoning: "Approval failed because pending diff was not found",
      },
    });

    return { approved: false };
  }

  writeAuditEvent(root, {
    role: "architect",
    actorId: approvedBy,
    environment: detectEnvironment(),
    action: "approval-granted",
    resource: diffId,
    result: "success",
    metadata: {
      diffHash: approved.approved.diffHash,
    },
    decisionTrace: {
      policiesEvaluated: [],
      finalDecision: "allow",
      reasoning: "Pending diff approval granted",
    },
  });

  return {
    approved: true,
    diffHash: approved.approved.diffHash,
  };
}

export function rejectDiff(root: string, diffId: string): { removed: boolean } {
  const rejected = rejectPendingDiff(root, diffId);
  writeAuditEvent(root, {
    role: "architect",
    environment: detectEnvironment(),
    action: "approval-rejected",
    resource: diffId,
    result: rejected.removed ? "success" : "failure",
    metadata: {
      removed: rejected.removed,
    },
    decisionTrace: {
      policiesEvaluated: [],
      finalDecision: "deny",
      reasoning: rejected.removed
        ? "Pending diff was rejected"
        : "Reject requested for non-existent pending diff",
    },
  });

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
