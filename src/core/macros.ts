import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { z } from "zod";
import { ControlPlane } from "../schema.js";
import { parseCommand } from "./choirRouter.js";
import {
  CompilationDecision,
  CompilationTrace,
  compileDSLAndWrite,
} from "./dslYamlCompiler.js";

export type MacroParameter = {
  name: string;
  required: boolean;
  default?: string;
};

export type Macro = {
  id: string;
  version?: string;
  description?: string;
  parameters?: MacroParameter[];
  body: string[];
};

export type MacroRegistry = {
  macros: Macro[];
};

export type MacroTrace = {
  macroId: string;
  expandedCommands: string[];
  executedSteps: number;
  results: string[];
};

export type MacroStepResult = {
  command: string;
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
  }

  return sorted;
}

export function listMacros(root: string): Macro[] {
  return loadMacroRegistry(root).macros;
}

export function getMacro(root: string, macroId: string): Macro {
  const macro = loadMacroRegistry(root).macros.find((entry) => entry.id === macroId);
  if (!macro) {
    throw new Error(`Macro not found: ${macroId}`);
  }

  return macro;
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
  expandedCommands: string[];
  steps: MacroStepResult[];
  results: string[];
};

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

  if (stack.includes(macroId)) {
    const cycle = [...stack, macroId].join(" -> ");
    throw new Error(`Macro recursion detected: ${cycle}`);
  }

  const macro = getMacro(context.root, macroId);
  const expanded = expandMacro(macro, args);

  for (const command of expanded) {
    const parsed = parseCommand(command);
    context.expandedCommands.push(command);

    if (parsed.ast.type === "macro-list" || parsed.ast.type === "macro-show") {
      throw new Error(`Macro body cannot include choir ${parsed.ast.type === "macro-list" ? "macro list" : "macro show"}`);
    }

    if (parsed.ast.type === "macro-run") {
      const nestedDecision = executeMacroRecursive(
        parsed.ast.macroId,
        parsed.ast.args,
        context,
        [...stack, macroId],
        depth + 1
      );

      if (nestedDecision === "deny" || nestedDecision === "require-approval") {
        return nestedDecision;
      }

      continue;
    }

    const compiled = compileDSLAndWrite(command, context.controlPlane, context.controlPath, {
      workspaceRoot: context.workspaceRoot,
    });

    context.steps.push({
      command,
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
  }
): MacroRunResult {
  const context: MacroExecutionContext = {
    root,
    controlPath,
    workspaceRoot: options?.workspaceRoot,
    controlPlane,
    expandedCommands: [],
    steps: [],
    results: [],
  };

  const decision = executeMacroRecursive(macroId, args, context, [], 0);

  return {
    updatedControlPlane: context.controlPlane,
    decision,
    trace: {
      macroId,
      expandedCommands: context.expandedCommands,
      executedSteps: context.steps.length,
      results: context.results,
    },
    steps: context.steps,
  };
}
