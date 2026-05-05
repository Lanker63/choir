import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { z } from "zod";
import { recordAudit } from "./audit.js";
import {
  MacroLibraryTrace,
  Macro,
  resolveLibraryMacro,
} from "./macroLibraries.js";
import { detectEnvironment } from "./policyEngine.js";
import { ControlPlane } from "../schema.js";
import { parseCommand } from "./choirRouter.js";
import {
  CompilationDecision,
  CompilationTrace,
  compileDSLAndWrite,
} from "./dslYamlCompiler.js";

export type MacroRegistry = {
  macros: Macro[];
};

export type MacroTrace = {
  macroId: string;
  libraryTrace: MacroLibraryTrace;
  expandedCommands: string[];
  executedSteps: number;
  results: string[];
};

export type MacroStepResult = {
  command: string;
  macroTrace: MacroLibraryTrace;
  decision: CompilationDecision;
  changed: boolean;
  diffHash?: string;
  pendingApprovalId?: string;
  trace: CompilationTrace;
};

export type MacroRunResult = {
  updatedControlPlane: ControlPlane;
  decision: CompilationDecision;
  trace: MacroTrace;
  steps: MacroStepResult[];
};

const MACRO_PARAMETER_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const MAX_MACRO_DEPTH = 8;

const MacroParameterSchema = z.object({
  name: z.string().regex(MACRO_PARAMETER_NAME_PATTERN),
  required: z.boolean(),
  default: z.string().optional(),
}).strict();

const MacroSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1).optional(),
  description: z.string().optional(),
  parameters: z.array(MacroParameterSchema).default([]),
  body: z.array(z.string().min(1)).min(1),
}).strict();

const MacroRegistrySchema = z.object({
  macros: z.array(MacroSchema).default([]),
}).strict();

function macroFilePath(root: string): string {
  return path.join(root, ".choir", "macros.yaml");
}

function sortRegistry(registry: MacroRegistry): MacroRegistry {
  return {
    macros: [...registry.macros]
      .map((macro) => ({
        ...macro,
        parameters: [...(macro.parameters ?? [])].sort((left, right) => left.name.localeCompare(right.name)),
        body: [...macro.body],
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function ensureUniqueMacroIds(registry: MacroRegistry): void {
  const seen = new Set<string>();

  for (const macro of registry.macros) {
    if (seen.has(macro.id)) {
      throw new Error(`Duplicate macro id: ${macro.id}`);
    }

    seen.add(macro.id);
  }
}

function ensureVersionedMacro(macro: Macro): void {
  if (!macro.version || !SEMVER_PATTERN.test(macro.version)) {
    throw new Error(`Unversioned macro is not allowed: ${macro.id}`);
  }
}

function ensureUniqueParameterNames(macro: Macro): void {
  const seen = new Set<string>();
  for (const parameter of macro.parameters ?? []) {
    if (seen.has(parameter.name)) {
      throw new Error(`Duplicate parameter in macro ${macro.id}: ${parameter.name}`);
    }

    seen.add(parameter.name);
  }
}

export function loadMacroRegistry(root: string): MacroRegistry {
  const filePath = macroFilePath(root);
  if (!fs.existsSync(filePath)) {
    return { macros: [] };
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = YAML.parse(raw) ?? {};
  const registry = MacroRegistrySchema.parse(parsed);
  const sorted = sortRegistry(registry);

  ensureUniqueMacroIds(sorted);
  for (const macro of sorted.macros) {
    ensureUniqueParameterNames(macro);
    ensureVersionedMacro(macro);

    for (const line of macro.body) {
      parseCommand(line);
    }
  }

  return sorted;
}

export function listMacros(root: string): Macro[] {
  return loadMacroRegistry(root).macros;
}

export function getMacro(root: string, macroId: string): Macro {
  if (macroId.includes(".")) {
    try {
      return resolveLibraryMacro(root, macroId).macro;
    } catch {
      // Fall through to local registry lookup.
    }
  }

  const local = loadMacroRegistry(root).macros.find((entry) => entry.id === macroId || `${entry.id}` === macroId);
  if (!local) {
    throw new Error(`Macro not found: ${macroId}`);
  }

  return local;
}

export function validateParams(macro: Macro, args: Record<string, string>): void {
  const declared = new Map((macro.parameters ?? []).map((parameter) => [parameter.name, parameter]));

  for (const key of Object.keys(args)) {
    if (!declared.has(key)) {
      throw new Error(`Unknown parameter for macro ${macro.id}: ${key}`);
    }
  }

  for (const parameter of macro.parameters ?? []) {
    const value = args[parameter.name];
    const hasValue = typeof value === "string" && value.length > 0;
    const hasDefault = typeof parameter.default === "string";

    if (parameter.required && !hasValue && !hasDefault) {
      throw new Error(`Missing parameter: ${parameter.name}`);
    }
  }
}

function resolveParams(macro: Macro, args: Record<string, string>): Record<string, string> {
  validateParams(macro, args);

  const resolved: Record<string, string> = {};
  for (const parameter of macro.parameters ?? []) {
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

export function renderTemplate(line: string, params: Record<string, string>): string {
  return line.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return params[key] ?? "";
  });
}

export function expandMacro(macro: Macro, args: Record<string, string>): string[] {
  const resolved = resolveParams(macro, args);
  return macro.body.map((line) => renderTemplate(line, resolved));
}

type MacroExecutionContext = {
  root: string;
  controlPath: string;
  workspaceRoot?: string;
  controlPlane: ControlPlane;
  rootMacroTrace: MacroLibraryTrace;
  expandedCommands: string[];
  steps: MacroStepResult[];
  results: string[];
};

type ResolvedMacro = {
  macro: Macro;
  trace: MacroLibraryTrace;
  qualifiedId: string;
};

function resolveMacroReference(root: string, requestedId: string): ResolvedMacro {
  if (requestedId.includes(".")) {
    const resolved = resolveLibraryMacro(root, requestedId);
    return {
      macro: resolved.macro,
      trace: resolved.trace,
      qualifiedId: `${resolved.trace.library}.${resolved.trace.macroId}`,
    };
  }

  const local = loadMacroRegistry(root).macros.find((entry) => entry.id === requestedId);
  if (!local) {
    throw new Error(`Macro not found: ${requestedId}`);
  }

  ensureVersionedMacro(local);

  return {
    macro: local,
    trace: {
      library: "local",
      version: local.version as string,
      macroId: local.id,
      resolvedVersion: local.version as string,
    },
    qualifiedId: `local.${local.id}`,
  };
}

function executeMacroRecursive(
  macroId: string,
  args: Record<string, string>,
  context: MacroExecutionContext,
  stack: string[],
  depth: number
): CompilationDecision {
  if (depth > MAX_MACRO_DEPTH) {
    throw new Error(`Macro recursion limit exceeded (${MAX_MACRO_DEPTH})`);
  }

  const resolved = resolveMacroReference(context.root, macroId);
  if (stack.includes(resolved.qualifiedId)) {
    const cycle = [...stack, resolved.qualifiedId].join(" -> ");
    throw new Error(`Macro recursion detected: ${cycle}`);
  }

  const expanded = expandMacro(resolved.macro, args);

  for (const command of expanded) {
    const parsed = parseCommand(command);
    context.expandedCommands.push(command);

    if (
      parsed.ast.type === "macro-list"
      || parsed.ast.type === "macro-show"
      || parsed.ast.type === "import-library"
      || parsed.ast.type === "library-list"
      || parsed.ast.type === "library-install"
      || parsed.ast.type === "library-update"
      || parsed.ast.type === "library-lock"
    ) {
      throw new Error(`Macro body cannot include non-execution macro command: ${command}`);
    }

    if (parsed.ast.type === "macro-run") {
      const nestedMacroId = parsed.ast.macroId.includes(".")
        ? parsed.ast.macroId
        : (resolved.trace.library !== "local"
          ? `${resolved.trace.library}.${parsed.ast.macroId}`
          : parsed.ast.macroId);

      const nestedDecision = executeMacroRecursive(
        nestedMacroId,
        parsed.ast.args,
        context,
        [...stack, resolved.qualifiedId],
        depth + 1
      );

      if (nestedDecision === "deny" || nestedDecision === "require-approval") {
        return nestedDecision;
      }

      continue;
    }

    const compiled = compileDSLAndWrite(command, context.controlPlane, context.controlPath, {
      workspaceRoot: context.workspaceRoot,
      actorId: "macro-engine",
      macroTrace: resolved.trace,
    });

    context.steps.push({
      command,
      macroTrace: resolved.trace,
      decision: compiled.decision,
      changed: compiled.changed,
      diffHash: compiled.diffHash,
      pendingApprovalId: compiled.pendingApprovalId,
      trace: compiled.trace,
    });

    context.results.push(`${command} => ${compiled.decision}`);

    if (compiled.decision === "deny" || compiled.decision === "require-approval") {
      return compiled.decision;
    }

    context.controlPlane = compiled.updatedControlPlane;
  }

  if (context.steps.length === 0) {
    return "no-change";
  }

  if (context.steps.some((step) => step.decision === "allow" && step.changed)) {
    return "allow";
  }

  return "no-change";
}

export function runMacro(
  root: string,
  macroId: string,
  args: Record<string, string>,
  controlPlane: ControlPlane,
  controlPath: string,
  options?: {
    workspaceRoot?: string;
    executionMode?: "interactive" | "ci-pipeline";
  }
): MacroRunResult {
  if (detectEnvironment() === "ci" && options?.executionMode !== "ci-pipeline") {
    throw new Error("CI mode macro execution is restricted. Use 'choir ci run' to execute macros in CI.");
  }

  const rootMacro = resolveMacroReference(root, macroId);

  const context: MacroExecutionContext = {
    root,
    controlPath,
    workspaceRoot: options?.workspaceRoot,
    controlPlane,
    rootMacroTrace: rootMacro.trace,
    expandedCommands: [],
    steps: [],
    results: [],
  };

  const decision = executeMacroRecursive(macroId, args, context, [], 0);

  recordAudit(options?.workspaceRoot ?? root, {
    auditEvent: {
      id: "",
      timestamp: "",
      actor: {
        role: "architect",
        id: "macro-engine",
      },
      environment: detectEnvironment(),
      action: "macro-execution",
      resource: `macro.${context.rootMacroTrace.library}.${context.rootMacroTrace.macroId}`,
      result: decision === "deny" || decision === "require-approval" ? "failure" : "success",
      metadata: {
        macroLibrary: context.rootMacroTrace.library,
        version: context.rootMacroTrace.version,
        macroId: context.rootMacroTrace.macroId,
        resolvedVersion: context.rootMacroTrace.resolvedVersion,
        decision,
        executedSteps: context.steps.length,
      },
    },
    decisionTrace: {
      policiesEvaluated: [],
      finalDecision: decision === "require-approval" ? "require-approval" : (decision === "deny" ? "deny" : "allow"),
      reasoning: `Macro execution finished with decision=${decision}`,
    },
  });

  return {
    updatedControlPlane: context.controlPlane,
    decision,
    trace: {
      macroId,
      libraryTrace: context.rootMacroTrace,
      expandedCommands: context.expandedCommands,
      executedSteps: context.steps.length,
      results: context.results,
    },
    steps: context.steps,
  };
}
