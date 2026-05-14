import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { z } from "zod";
import { sortByIdAndParameterName } from "../utils/registrySort.js";
import { DecisionTrace, recordAudit } from "./audit.js";
import { parseCommand } from "./choirRouter.js";
import {
  CompilationDecision,
  CompilationTrace,
  compileDSLAndWrite,
} from "./dslYamlCompiler.js";
import { getMacro, runMacro } from "./macros.js";
import { detectEnvironment } from "./policyEngine.js";
import { ControlPlane } from "../schema.js";

export type AbstractionParameter = {
  name: string;
  required: boolean;
  default?: string;
};

export type Abstraction = {
  id: string;
  version: string;
  description: string;
  parameters?: AbstractionParameter[];
  expandsTo: string[];
};

export type AbstractionRegistry = {
  abstractions: Abstraction[];
};

export type AbstractionTrace = {
  abstractionId: string;
  expandedCommands: string[];
  macrosUsed: string[];
  result: "success" | "failure";
};

export type AbstractionStepResult = {
  command: string;
  kind: "dsl" | "macro" | "abstraction";
  decision: CompilationDecision;
  changed: boolean;
  diffHash?: string;
  pendingApprovalId?: string;
  trace?: CompilationTrace;
};

export type AbstractionRunResult = {
  updatedControlPlane: ControlPlane;
  decision: CompilationDecision;
  trace: AbstractionTrace;
  steps: AbstractionStepResult[];
};

type AbstractionExecutionContext = {
  root: string;
  controlPath: string;
  workspaceRoot?: string;
  controlPlane: ControlPlane;
  expandedCommands: string[];
  macrosUsed: Set<string>;
  steps: AbstractionStepResult[];
  actorId: string;
  executionMode: "interactive" | "ci-pipeline";
};

type ResolvedAbstraction = {
  abstraction: Abstraction;
  qualifiedId: string;
};

const ABSTRACTION_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const PARAMETER_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_ABSTRACTION_DEPTH = 8;

const BUILTIN_ABSTRACTIONS: Abstraction[] = [
  {
    id: "enforce-hexagonal-architecture",
    version: "1.0.0",
    description: "Apply hexagonal architecture guardrails and preview planned changes.",
    expandsTo: [
      "choir macro architecture.hexagonal",
      "choir plan",
      "choir preview",
    ],
  },
  {
    id: "migrate-to-service-layer",
    version: "1.0.0",
    description: "Migrate existing modules to service-layer boundaries.",
    expandsTo: [
      "choir macro refactor.extract-service-layer",
      "choir plan",
    ],
  },
];

const AbstractionParameterSchema = z.object({
  name: z.string().regex(PARAMETER_NAME_PATTERN),
  required: z.boolean(),
  default: z.string().optional(),
}).strict();

const AbstractionSchema = z.object({
  id: z.string().regex(ABSTRACTION_ID_PATTERN),
  version: z.string().regex(SEMVER_PATTERN).default("1.0.0"),
  description: z.string().min(1),
  parameters: z.array(AbstractionParameterSchema).default([]),
  expandsTo: z.array(z.string().min(1)).min(1),
}).strict();

const AbstractionRegistrySchema = z.object({
  abstractions: z.array(AbstractionSchema).default([]),
}).strict();

const NON_EXECUTION_COMMAND_TYPES = new Set([
  "export",
  "approve",
  "reject",
  "policy-status",
  "import-library",
  "library-list",
  "library-install",
  "library-update",
  "library-lock",
  "ci-run",
  "audit-log",
  "audit-report",
  "audit-query",
  "macro-list",
  "macro-show",
]);

function abstractionPath(root: string): string {
  return path.join(root, ".choir", "abstractions.yaml");
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function sortRegistry(registry: AbstractionRegistry): AbstractionRegistry {
  return {
    abstractions: sortByIdAndParameterName(registry.abstractions
      .map((abstraction) => ({
        ...abstraction,
        expandsTo: [...abstraction.expandsTo],
      }))),
  };
}

function ensureUniqueParameterNames(abstraction: Abstraction): void {
  const seen = new Set<string>();
  for (const parameter of abstraction.parameters ?? []) {
    if (seen.has(parameter.name)) {
      throw new Error(`Duplicate abstraction parameter in ${abstraction.id}: ${parameter.name}`);
    }

    seen.add(parameter.name);
  }
}

function ensureUniqueAbstractionIds(registry: AbstractionRegistry): void {
  const seen = new Set<string>();

  for (const abstraction of registry.abstractions) {
    if (seen.has(abstraction.id)) {
      throw new Error(`Duplicate abstraction id: ${abstraction.id}`);
    }

    seen.add(abstraction.id);
  }
}

function validateAbstractionCommands(registry: AbstractionRegistry): void {
  const knownIds = new Set(registry.abstractions.map((abstraction) => abstraction.id));

  for (const abstraction of registry.abstractions) {
    ensureUniqueParameterNames(abstraction);

    const parameterNames = new Set((abstraction.parameters ?? []).map((parameter) => parameter.name));

    for (const line of abstraction.expandsTo) {
      const command = line.trim();
      if (command.length === 0) {
        throw new Error(`Abstraction ${abstraction.id} contains empty command line`);
      }

      const parsed = parseCommand(command);
      if (parsed.ast.type === "sequence") {
        throw new Error(`Abstraction command cannot chain actions with 'then': ${command}`);
      }

      if (parsed.ast.type === "abstraction-run" && !knownIds.has(parsed.ast.identifier)) {
        throw new Error(`Abstraction ${abstraction.id} references unknown abstraction: ${parsed.ast.identifier}`);
      }

      if (parsed.ast.type === "macro-run") {
        continue;
      }

      if (NON_EXECUTION_COMMAND_TYPES.has(parsed.ast.type)) {
        throw new Error(`Abstraction ${abstraction.id} cannot include non-execution command: ${command}`);
      }

      if (parsed.ast.type === "abstraction-run") {
        continue;
      }

      if (parsed.ast.type !== "define" && parsed.ast.type !== "analyze" && parsed.ast.type !== "plan" && parsed.ast.type !== "preview" && parsed.ast.type !== "execute" && parsed.ast.type !== "status") {
        throw new Error(`Abstraction ${abstraction.id} contains unsupported command: ${command}`);
      }
    }

    for (const parameter of abstraction.parameters ?? []) {
      if (parameter.required && typeof parameter.default === "string" && parameter.default.length > 0) {
        continue;
      }

      if (!parameter.required) {
        continue;
      }

      if (typeof parameter.default === "string" && parameter.default.length === 0) {
        throw new Error(`Required parameter ${parameter.name} in ${abstraction.id} has invalid default`);
      }
    }

    for (const command of abstraction.expandsTo) {
      const placeholders = [...command.matchAll(/\{\{(\w+)\}\}/g)].map((entry) => entry[1] ?? "");
      for (const placeholder of placeholders) {
        if (!parameterNames.has(placeholder)) {
          throw new Error(`Abstraction ${abstraction.id} references undeclared parameter: ${placeholder}`);
        }
      }
    }
  }
}

function normalizeRegistry(raw: AbstractionRegistry): AbstractionRegistry {
  const parsed = AbstractionRegistrySchema.parse(raw);
  const merged = sortRegistry({
    abstractions: [...BUILTIN_ABSTRACTIONS, ...parsed.abstractions],
  });

  ensureUniqueAbstractionIds(merged);
  validateAbstractionCommands(merged);

  return merged;
}

export function loadAbstractionRegistry(root: string): AbstractionRegistry {
  const filePath = abstractionPath(root);
  if (!fs.existsSync(filePath)) {
    return normalizeRegistry({ abstractions: [] });
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = YAML.parse(raw) ?? {};

  return normalizeRegistry(parsed);
}

export function listAbstractions(root: string): Abstraction[] {
  return loadAbstractionRegistry(root).abstractions;
}

export function getAbstraction(root: string, id: string): Abstraction {
  const abstraction = loadAbstractionRegistry(root).abstractions.find((entry) => entry.id === id);
  if (!abstraction) {
    throw new Error(`Abstraction not found: ${id}`);
  }

  return abstraction;
}

function validateParams(abstraction: Abstraction, args: Record<string, string>): void {
  const declared = new Map((abstraction.parameters ?? []).map((parameter) => [parameter.name, parameter] as const));

  for (const key of Object.keys(args)) {
    if (!declared.has(key)) {
      throw new Error(`Unknown parameter for abstraction ${abstraction.id}: ${key}`);
    }
  }

  for (const parameter of abstraction.parameters ?? []) {
    const value = args[parameter.name];
    const hasValue = typeof value === "string" && value.length > 0;
    const hasDefault = typeof parameter.default === "string";

    if (parameter.required && !hasValue && !hasDefault) {
      throw new Error(`Missing parameter: ${parameter.name}`);
    }
  }
}

function resolveParams(abstraction: Abstraction, args: Record<string, string>): Record<string, string> {
  validateParams(abstraction, args);

  const resolved: Record<string, string> = {};
  for (const parameter of abstraction.parameters ?? []) {
    if (typeof args[parameter.name] === "string" && args[parameter.name].length > 0) {
      resolved[parameter.name] = args[parameter.name];
      continue;
    }

    if (typeof parameter.default === "string") {
      resolved[parameter.name] = parameter.default;
      continue;
    }

    resolved[parameter.name] = "";
  }

  return resolved;
}

function renderTemplate(line: string, params: Record<string, string>): string {
  return line.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return params[key] ?? "";
  });
}

function resolveAbstractionReference(root: string, abstractionId: string): ResolvedAbstraction {
  const abstraction = getAbstraction(root, abstractionId);
  return {
    abstraction,
    qualifiedId: `${abstraction.id}@${abstraction.version}`,
  };
}

function combineDecision(current: CompilationDecision, next: CompilationDecision): CompilationDecision {
  if (current === "deny" || next === "deny") {
    return "deny";
  }

  if (current === "require-approval" || next === "require-approval") {
    return "require-approval";
  }

  if (current === "allow" || next === "allow") {
    return "allow";
  }

  return "no-change";
}

function validateExpandedCommand(root: string, command: string): void {
  const parsed = parseCommand(command);
  if (parsed.ast.type === "sequence") {
    throw new Error(`Abstraction command cannot chain actions with 'then': ${command}`);
  }

  if (parsed.ast.type === "macro-run") {
    getMacro(root, parsed.ast.macroId);
    return;
  }

  if (parsed.ast.type === "abstraction-run") {
    getAbstraction(root, parsed.ast.identifier);
    return;
  }

  if (NON_EXECUTION_COMMAND_TYPES.has(parsed.ast.type)) {
    throw new Error(`Abstraction cannot include non-execution command: ${command}`);
  }
}

function executeAbstractionRecursive(
  abstractionId: string,
  args: Record<string, string>,
  context: AbstractionExecutionContext,
  stack: string[],
  depth: number
): CompilationDecision {
  if (depth > MAX_ABSTRACTION_DEPTH) {
    throw new Error(`Abstraction recursion limit exceeded (${MAX_ABSTRACTION_DEPTH})`);
  }

  const resolved = resolveAbstractionReference(context.root, abstractionId);
  if (stack.includes(resolved.qualifiedId)) {
    const cycle = [...stack, resolved.qualifiedId].join(" -> ");
    throw new Error(`Abstraction recursion detected: ${cycle}`);
  }

  const expandedCommands = resolved.abstraction.expandsTo.map((command) => renderTemplate(command, resolveParams(resolved.abstraction, args)));
  let decision: CompilationDecision = "no-change";

  for (const command of expandedCommands) {
    validateExpandedCommand(context.root, command);

    const parsed = parseCommand(command);
    context.expandedCommands.push(command);

    if (parsed.ast.type === "abstraction-run") {
      const nestedDecision = executeAbstractionRecursive(
        parsed.ast.identifier,
        parsed.ast.args,
        context,
        [...stack, resolved.qualifiedId],
        depth + 1
      );

      context.steps.push({
        command,
        kind: "abstraction",
        decision: nestedDecision,
        changed: nestedDecision === "allow",
      });

      decision = combineDecision(decision, nestedDecision);
      if (nestedDecision === "deny" || nestedDecision === "require-approval") {
        return nestedDecision;
      }

      continue;
    }

    if (parsed.ast.type === "macro-run") {
      const macroResult = runMacro(
        context.root,
        parsed.ast.macroId,
        parsed.ast.args,
        context.controlPlane,
        context.controlPath,
        {
          workspaceRoot: context.workspaceRoot,
          executionMode: context.executionMode,
        }
      );

      context.controlPlane = macroResult.updatedControlPlane;
      context.macrosUsed.add(`${macroResult.trace.libraryTrace.library}.${macroResult.trace.libraryTrace.macroId}`);

      const macroDiffHashes = macroResult.steps
        .map((step) => step.diffHash)
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      const macroPendingIds = macroResult.steps
        .map((step) => step.pendingApprovalId)
        .filter((value): value is string => typeof value === "string" && value.length > 0);

      context.steps.push({
        command,
        kind: "macro",
        decision: macroResult.decision,
        changed: macroResult.steps.some((step) => step.changed),
        ...(macroDiffHashes.length > 0 ? { diffHash: sortedUnique(macroDiffHashes).join(",") } : {}),
        ...(macroPendingIds.length > 0 ? { pendingApprovalId: sortedUnique(macroPendingIds).join(",") } : {}),
      });

      decision = combineDecision(decision, macroResult.decision);
      if (macroResult.decision === "deny" || macroResult.decision === "require-approval") {
        return macroResult.decision;
      }

      continue;
    }

    const compiled = compileDSLAndWrite(command, context.controlPlane, context.controlPath, {
      workspaceRoot: context.workspaceRoot,
      actorId: context.actorId,
    });

    context.controlPlane = compiled.updatedControlPlane;
    context.steps.push({
      command,
      kind: "dsl",
      decision: compiled.decision,
      changed: compiled.changed,
      diffHash: compiled.diffHash,
      pendingApprovalId: compiled.pendingApprovalId,
      trace: compiled.trace,
    });

    decision = combineDecision(decision, compiled.decision);
    if (compiled.decision === "deny" || compiled.decision === "require-approval") {
      return compiled.decision;
    }
  }

  return decision;
}

function toDecisionTrace(decision: CompilationDecision, reasoning: string): DecisionTrace {
  return {
    policiesEvaluated: [],
    finalDecision: decision === "deny"
      ? "deny"
      : (decision === "require-approval" ? "require-approval" : "allow"),
    reasoning,
  };
}

export function runAbstraction(
  root: string,
  abstractionId: string,
  args: Record<string, string>,
  controlPlane: ControlPlane,
  controlPath: string,
  options?: {
    workspaceRoot?: string;
    actorId?: string;
    executionMode?: "interactive" | "ci-pipeline";
  }
): AbstractionRunResult {
  const resolved = resolveAbstractionReference(root, abstractionId);

  const context: AbstractionExecutionContext = {
    root,
    controlPath,
    workspaceRoot: options?.workspaceRoot,
    controlPlane,
    expandedCommands: [],
    macrosUsed: new Set<string>(),
    steps: [],
    actorId: options?.actorId ?? "abstraction-engine",
    executionMode: options?.executionMode ?? "interactive",
  };

  const decision = executeAbstractionRecursive(abstractionId, args, context, [], 0);
  const result = decision === "deny" || decision === "require-approval" ? "failure" : "success";
  const macrosUsed = sortedUnique([...context.macrosUsed]);

  recordAudit(options?.workspaceRoot ?? root, {
    auditEvent: {
      id: "",
      timestamp: "",
      actor: {
        role: "conductor",
        id: context.actorId,
      },
      environment: detectEnvironment(),
      action: "abstraction-execution",
      resource: `abstraction.${resolved.abstraction.id}`,
      result,
      metadata: {
        abstractionId: resolved.abstraction.id,
        abstractionVersion: resolved.abstraction.version,
        expandedCommands: context.expandedCommands,
        macrosUsed,
        decision,
        executedSteps: context.steps.length,
      },
    },
    decisionTrace: toDecisionTrace(
      decision,
      `Abstraction execution finished with decision=${decision}`
    ),
  });

  return {
    updatedControlPlane: context.controlPlane,
    decision,
    trace: {
      abstractionId: resolved.abstraction.id,
      expandedCommands: context.expandedCommands,
      macrosUsed,
      result,
    },
    steps: context.steps,
  };
}

export function formatAbstractionRunResult(result: AbstractionRunResult): string {
  const stepLines = result.trace.expandedCommands.length === 0
    ? ["- none"]
    : result.trace.expandedCommands.map((step, index) => `${index + 1}. ${step}`);

  const macroLines = result.trace.macrosUsed.length === 0
    ? ["- none"]
    : result.trace.macrosUsed.map((macroId) => `- ${macroId}`);

  const finalStatus = result.trace.result === "success"
    ? "ready for execution"
    : "blocked";

  return [
    `Abstraction: ${result.trace.abstractionId}`,
    "",
    "Steps:",
    ...stepLines,
    "",
    "Macros used:",
    ...macroLines,
    "",
    `Decision: ${result.decision}`,
    `Result: ${finalStatus}`,
  ].join("\n");
}
