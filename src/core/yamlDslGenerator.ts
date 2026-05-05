import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { DSLRule } from "../dsl/types.js";
import {
  ChoirConfig,
  canonicalizeConfig,
  compileDSL,
  controlPlaneToChoirConfig,
  choirConfigToControlPlane,
  hashConfig,
} from "./dslYamlCompiler.js";

export type DSLCommand = {
  command: string;
};

export type DSLScript = {
  commands: DSLCommand[];
};

export type YAMLtoDSLSection = "all" | "intent" | "policy" | "plans";

export type YAMLtoDSLTrace = {
  generatedCommands: number;
  sections: string[];
  warnings: string[];
};

export type GenerateDSLOptions = {
  section?: YAMLtoDSLSection;
};

export type GenerateDSLResult = {
  script: DSLScript;
  trace: YAMLtoDSLTrace;
};

export type RoundTripResult = {
  stable: boolean;
  originalHash: string;
  replayedHash: string;
  originalScriptHash: string;
  replayedScriptHash: string;
  warnings: string[];
};

function sorted(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function normalizeString(value: string): string {
  return value.trim();
}

function quoteString(value: string): string {
  const normalized = normalizeString(value);
  const escaped = normalized
    .replace(/\\/g, "\\\\")
    .replace(/\"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");

  return `\"${escaped}\"`;
}

function command(value: string): DSLCommand {
  return { command: value };
}

function hashScript(script: DSLScript): string {
  const payload = JSON.stringify(script);
  return createHash("sha256").update(payload).digest("hex");
}

function reconstructRuleDSL(rule: DSLRule): string | null {
  // Rules are currently represented as YAML-only structures in Choir's DSL command surface.
  // Returning null ensures no synthetic or lossy command is generated.
  if (!rule.id || rule.id.trim().length === 0) {
    return null;
  }

  return null;
}

function shouldInclude(section: YAMLtoDSLSection, target: Exclude<YAMLtoDSLSection, "all">): boolean {
  return section === "all" || section === target;
}

export function generateDSL(config: ChoirConfig, options?: GenerateDSLOptions): GenerateDSLResult {
  const canonical = canonicalizeConfig(config);
  const section = options?.section ?? "all";
  const warnings: string[] = [];
  const commands: DSLCommand[] = [];
  const sections: string[] = [];

  if (shouldInclude(section, "intent")) {
    sections.push("intent");

    for (const goal of sorted(canonical.intent.goals)) {
      commands.push(command(`choir define goal ${quoteString(goal)}`));
    }

    for (const constraint of sorted(canonical.intent.constraints)) {
      commands.push(command(`choir define constraint ${quoteString(constraint)}`));
    }

    for (const nonGoal of sorted(canonical.intent.nonGoals)) {
      commands.push(command(`choir define non-goal ${quoteString(nonGoal)}`));
    }
  }

  if (shouldInclude(section, "policy")) {
    sections.push("policy");

    for (const rule of [...canonical.policy.rules].sort((left, right) => left.id.localeCompare(right.id))) {
      const reconstructed = reconstructRuleDSL(rule);
      if (!reconstructed) {
        warnings.push(`Unrepresentable field: policy.rules.${rule.id}`);
        continue;
      }

      commands.push(command(reconstructed));
    }
  }

  if (shouldInclude(section, "plans")) {
    sections.push("plans");

    for (const plan of [...canonical.execution.plans].sort((left, right) => left.id.localeCompare(right.id))) {
      // Plan replay through current DSL is not lossless because plan synthesis is state-dependent.
      warnings.push(`Unrepresentable field: execution.plans.${plan.id}`);
    }
  }

  return {
    script: { commands },
    trace: {
      generatedCommands: commands.length,
      sections,
      warnings,
    },
  };
}

export function formatDSL(script: DSLScript): string {
  return script.commands.map((entry) => entry.command).join("\n");
}

export function writeDSL(script: DSLScript, outputPath: string): void {
  const text = formatDSL(script);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, text, "utf-8");
}

export function validateRoundTrip(config: ChoirConfig, options?: GenerateDSLOptions): RoundTripResult {
  const canonical = canonicalizeConfig(config);
  const generated = generateDSL(canonical, options);

  let replayed = choirConfigToControlPlane(canonical);
  for (const entry of generated.script.commands) {
    const result = compileDSL(entry.command, replayed);
    replayed = result.updatedControlPlane;
  }

  const replayedConfig = canonicalizeConfig(controlPlaneToChoirConfig(replayed));

  const originalHash = hashConfig(canonical);
  const replayedHash = hashConfig(replayedConfig);

  const replayedGenerated = generateDSL(replayedConfig, options);
  const originalScriptHash = hashScript(generated.script);
  const replayedScriptHash = hashScript(replayedGenerated.script);

  return {
    stable: originalHash === replayedHash && originalScriptHash === replayedScriptHash,
    originalHash,
    replayedHash,
    originalScriptHash,
    replayedScriptHash,
    warnings: [...generated.trace.warnings, ...replayedGenerated.trace.warnings],
  };
}
