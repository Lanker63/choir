import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { formatCIRunResult, runCI } from "./ci.js";
import { adaptiveStrategySelection } from "./strategyPlanner.js";
import {
  approveDiff,
  compileDSLAndWrite,
  controlPlaneToChoirConfig,
  policyStatus,
  rejectDiff,
  writeYAML,
} from "./dslYamlCompiler.js";
import { detectEnvironment } from "./policyEngine.js";
import { createEmptyStatePlane, readStatePlane } from "./state.js";
import {
  formatRuntimeVerificationReport,
  runRuntimeVerification,
  type RuntimeVerificationMode,
} from "./runtimeVerification.js";
import { ControlPlaneSchema } from "../schema.js";
import { isCLIExcludedVSCodeShortcut } from "./cliSurface.js";
import { analyzeWorkspaceAtRoot, findHotspotsAtRoot } from "./workspaceAnalysis.js";
import { parseCommand, type ActionNode } from "./choirRouter.js";
import { runOrchestrationPipeline, OrchestrationPipelineError } from "./orchestrationRuntime.js";
import { persistSelectedOptimizedPlan } from "./planPersistence.js";
import { runRefactorIntent } from "./refactorEngine.js";
import { getMacro, listMacros, runMacro } from "./macros.js";
import {
  importLibrary,
  installLibrary,
  listLibraryCatalog,
  lockChoirLibraries,
  readLibraryLock,
  updateLibrary,
} from "./macroLibraries.js";
import { formatAbstractionRunResult, getAbstraction, listAbstractions, runAbstraction } from "./abstractions.js";
import { exportReport, generateReport, queryAudit, readAuditStore } from "./audit.js";
import { persistStatePlane, resolveDeterministicRollbackTarget } from "./state.js";
import {
  calibrateStrategicOrchestration,
  detectMissingControlPlanePackageReferences,
  detectStrategicPackageCatalogDelta,
  discoverStrategicDomains,
  seedStrategicDomainPromptDefaults,
  synthesizeStrategicControlPlane,
  type StrategicInitMode,
  type StrategicTemplateName,
} from "./strategicInit.js";
import {
  formatDSL,
  generateDSL,
  writeDSL,
} from "./yamlDslGenerator.js";

export type CliVerifyIntent = {
  type: "verify";
  mode: RuntimeVerificationMode;
  chaosMode?: "none" | "light" | "moderate" | "extreme";
  seed?: number;
};

export type CliCIRunIntent = {
  type: "ci-run";
};

export type CliDefineIntent = {
  type: "define";
  defineType: "mission" | "vision" | "goal" | "constraint" | "non-goal";
  value: string;
};

export type CliStatusIntent = {
  type: "status";
};

export type CliPolicyStatusIntent = {
  type: "policy-status";
};

export type CliApproveIntent = {
  type: "approve";
  diffId: string;
};

export type CliRejectIntent = {
  type: "reject";
  diffId: string;
};

export type CliExportDSLIntent = {
  type: "export-dsl";
  section: "all" | "intent" | "policy" | "plans";
};

export type CliExportJSONIntent = {
  type: "export-json";
};

export type CliRemoveGoalIntent = {
  type: "remove-goal";
  goal: string;
};

export type CliAnalyzeIntent = {
  type: "analyze";
  target: "workspace" | "hotspots" | "summary";
};

export type CliAbstractionListIntent = {
  type: "abstraction-list";
};

export type CliAbstractionDescribeIntent = {
  type: "abstraction-describe";
  id: string;
};

export type CliInitIntent = {
  type: "init";
  template?: StrategicTemplateName;
  mode: StrategicInitMode;
};

export type CliDSLActionIntent = {
  type: "dsl-action";
  command: string;
  ast: ActionNode;
};

export type CliParseErrorIntent = {
  type: "parse-error";
  reason: string;
};

export type CliIntent =
  | CliVerifyIntent
  | CliCIRunIntent
  | CliDefineIntent
  | CliStatusIntent
  | CliPolicyStatusIntent
  | CliApproveIntent
  | CliRejectIntent
  | CliExportDSLIntent
  | CliExportJSONIntent
  | CliRemoveGoalIntent
  | CliAnalyzeIntent
  | CliAbstractionListIntent
  | CliAbstractionDescribeIntent
  | CliInitIntent
  | CliDSLActionIntent
  | CliParseErrorIntent;

type CliOutputEnvelope = {
  ok: boolean;
  command: string;
  data?: unknown;
  error?: {
    message: string;
  };
};

function printCliEnvelope(envelope: CliOutputEnvelope): void {
  console.log(JSON.stringify(envelope, null, 2));
}

function usage(): string {
  return [
    "Choir CLI",
    "",
    "Usage:",
    "  choir ci run",
    "  choir verify [--quick]",
    "  choir verify --contracts",
    "  choir verify --determinism",
    "  choir verify --transactions",
    "  choir verify --state",
    "  choir verify --policy",
    "  choir verify --orchestration",
    "  choir verify --production",
    "  choir verify --libraries",
    "  choir verify --compiler",
    "  choir verify --full",
    "  choir verify --property [--seed <n>]",
    "  choir verify --chaos [none|light|moderate|extreme] [--seed <n>]",
  ].join("\n");
}

function parseSeedArg(args: string[]): { seed?: number; remaining: string[] } {
  const seedIndex = args.indexOf("--seed");
  if (seedIndex < 0) {
    return {
      remaining: [...args],
    };
  }

  const value = args[seedIndex + 1];
  if (!value) {
    throw new Error("Missing value for --seed");
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid seed value: ${value}`);
  }

  const remaining = args.filter((_, index) => index !== seedIndex && index !== seedIndex + 1);
  return {
    seed: parsed,
    remaining,
  };
}

function normalizeDefineType(input: string): CliDefineIntent["defineType"] | null {
  if (input === "mission" || input === "vision" || input === "goal" || input === "constraint") {
    return input;
  }

  if (input === "non-goal" || input === "non" || input === "nongoal" || input === "non_goal") {
    return "non-goal";
  }

  return null;
}

function normalizeQuotedValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const doubleQuoted = trimmed.startsWith("\"") && trimmed.endsWith("\"");
    const singleQuoted = trimmed.startsWith("'") && trimmed.endsWith("'");
    if (doubleQuoted || singleQuoted) {
      return trimmed.slice(1, -1).trim();
    }
  }

  return trimmed;
}

function quoteString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/\"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");

  return `\"${escaped}\"`;
}

function parseInitMode(args: string[]): { mode: StrategicInitMode; invalidFlag?: string } {
  let mode: StrategicInitMode = "full";
  for (const arg of args) {
    if (arg === "--expand-domain") {
      mode = "expand-domain";
      continue;
    }

    if (arg === "--reclassify") {
      mode = "reclassify";
      continue;
    }

    if (arg === "--recalibrate") {
      mode = "recalibrate";
      continue;
    }

    if (arg === "--template") {
      continue;
    }

    if (arg.startsWith("--")) {
      return {
        mode,
        invalidFlag: arg,
      };
    }
  }

  return {
    mode,
  };
}

function parseInitIntent(args: string[]): CliIntent | null {
  if (args[0] !== "init") {
    return null;
  }

  const templateIndex = args.indexOf("--template");
  let template: string | undefined;
  if (templateIndex >= 0) {
    const value = args[templateIndex + 1];
    if (!value || value.trim().length === 0) {
      return {
        type: "parse-error",
        reason: "init --template requires a non-empty value",
      };
    }

    template = value.trim().toLowerCase();
  }

  const parsedMode = parseInitMode(args.slice(1));
  if (parsedMode.invalidFlag) {
    return {
      type: "parse-error",
      reason: `Unsupported init flag: ${parsedMode.invalidFlag}`,
    };
  }

  return {
    type: "init",
    ...(template ? { template } : {}),
    mode: parsedMode.mode,
  };
}

function parseAbstractionShortcutIntent(args: string[]): CliIntent | null {
  if (args.length === 2 && args[0] === "abstraction" && args[1] === "list") {
    return {
      type: "abstraction-list",
    };
  }

  if (args.length === 3 && args[0] === "abstraction" && args[1] === "describe") {
    return {
      type: "abstraction-describe",
      id: args[2] as string,
    };
  }

  return null;
}

function parseCliActionIntent(args: string[]): CliIntent | null {
  if (args.length === 0) {
    return null;
  }

  try {
    const command = `choir ${args.join(" ")}`.trim();
    const parsed = parseCommand(command);
    if (parsed.ast.type === "sequence") {
      return {
        type: "parse-error",
        reason: "CLI accepts a single command at a time; chained 'then' sequences are not supported.",
      };
    }

    if (parsed.ast.type === "graph") {
      return {
        type: "parse-error",
        reason: "Graph UI actions are VS Code-only and are not available in choir-cli.",
      };
    }

    return {
      type: "dsl-action",
      command,
      ast: parsed.ast,
    };
  } catch {
    return null;
  }
}

async function evaluateAdaptivePlanSelectionForCli(
  controlPlane: ReturnType<typeof loadControlPlane>,
  options: {
    root: string;
    requestedPlanId?: string;
    targetGoal?: string;
  }
) {
  const state = readStatePlane(options.root) ?? createEmptyStatePlane();
  const allPlans = [...controlPlane.execution.plans].sort((left, right) => left.id.localeCompare(right.id));

  let candidates = allPlans;
  if (options.requestedPlanId) {
    const requested = allPlans.find((plan) => plan.id === options.requestedPlanId);
    if (!requested) {
      throw new Error(`Plan not found: ${options.requestedPlanId}`);
    }

    candidates = [requested];
  } else if (options.targetGoal) {
    candidates = allPlans.filter((plan) => (plan.goalRefs ?? []).includes(options.targetGoal as string));
  }

  const basePlan = [...candidates].sort((left, right) => left.id.localeCompare(right.id))[0];
  if (!basePlan) {
    throw new Error("Adaptive planning unavailable: no matching execution plans found.");
  }

  const selected = await adaptiveStrategySelection(basePlan, state, {
    controlPlane,
    root: options.root,
  });

  return {
    basePlan,
    selected: selected.selected,
    outcomes: selected.outcomes,
    adaptiveTrace: selected.adaptiveTrace,
    iterations: selected.iterations,
  };
}

export function parseCliIntent(args: string[]): CliIntent {
  if (args[0] === "define") {
    if (args.length < 3) {
      return {
        type: "parse-error",
        reason: "define requires <mission|vision|goal|constraint|non-goal> and a value",
      };
    }

    const defineType = normalizeDefineType(args[1]?.toLowerCase() ?? "");
    if (!defineType) {
      return {
        type: "parse-error",
        reason: `Unsupported define type: ${args[1] ?? ""}`,
      };
    }

    const value = normalizeQuotedValue(args.slice(2).join(" "));
    if (value.length === 0) {
      return {
        type: "parse-error",
        reason: "define value must be non-empty",
      };
    }

    return {
      type: "define",
      defineType,
      value,
    };
  }

  if (args.length === 1 && args[0] === "status") {
    return {
      type: "status",
    };
  }

  if (args.length === 2 && args[0] === "policy" && args[1] === "status") {
    return {
      type: "policy-status",
    };
  }

  if (args.length === 2 && args[0] === "approve") {
    return {
      type: "approve",
      diffId: args[1] as string,
    };
  }

  if (args.length === 2 && args[0] === "reject") {
    return {
      type: "reject",
      diffId: args[1] as string,
    };
  }

  if (args.length >= 2 && args[0] === "export" && args[1] === "dsl") {
    const section = (args[2] ?? "all").toLowerCase();
    if (section !== "all" && section !== "intent" && section !== "policy" && section !== "plans") {
      return {
        type: "parse-error",
        reason: `Unsupported export dsl section: ${section}`,
      };
    }

    return {
      type: "export-dsl",
      section,
    };
  }

  if (args.length === 3 && args[0] === "export" && args[1] === "--format") {
    const format = args[2]?.toLowerCase();
    if (format !== "json") {
      return {
        type: "parse-error",
        reason: `Unsupported export format: ${args[2] ?? ""}`,
      };
    }

    return {
      type: "export-json",
    };
  }

  if (args.length >= 3 && args[0] === "remove" && args[1] === "goal") {
    const goal = normalizeQuotedValue(args.slice(2).join(" "));
    if (goal.length === 0) {
      return {
        type: "parse-error",
        reason: "remove goal requires a non-empty goal value",
      };
    }

    return {
      type: "remove-goal",
      goal,
    };
  }

  if (args.length === 2 && args[0] === "analyze") {
    const target = args[1]?.toLowerCase();
    if (target !== "workspace" && target !== "hotspots" && target !== "summary") {
      return {
        type: "parse-error",
        reason: `Unsupported analyze target: ${args[1] ?? ""}`,
      };
    }

    return {
      type: "analyze",
      target,
    };
  }

  const abstractionShortcutIntent = parseAbstractionShortcutIntent(args);
  if (abstractionShortcutIntent) {
    return abstractionShortcutIntent;
  }

  const initIntent = parseInitIntent(args);
  if (initIntent) {
    return initIntent;
  }

  if (args[0] === "verify") {
    const verifyArgs = args.slice(1);
    const parsed = parseSeedArg(verifyArgs);
    const remaining = parsed.remaining;

    let mode: RuntimeVerificationMode | null = null;
    let chaosMode: "none" | "light" | "moderate" | "extreme" | undefined;

    if (remaining.length === 0) {
      mode = "full";
    } else if (remaining.length === 1 && remaining[0] === "--quick") {
      mode = "quick";
    } else if (remaining.length === 1 && remaining[0] === "--property") {
      mode = "property";
    } else if (remaining.length === 1 && remaining[0] === "--contracts") {
      mode = "contracts";
    } else if (remaining.length === 1 && remaining[0] === "--determinism") {
      mode = "determinism";
    } else if (remaining.length === 1 && remaining[0] === "--transactions") {
      mode = "transactions";
    } else if (remaining.length === 1 && remaining[0] === "--state") {
      mode = "state";
    } else if (remaining.length === 1 && remaining[0] === "--policy") {
      mode = "policy";
    } else if (remaining.length === 1 && remaining[0] === "--orchestration") {
      mode = "orchestration";
    } else if (remaining.length === 1 && remaining[0] === "--production") {
      mode = "production";
    } else if (remaining.length === 1 && remaining[0] === "--libraries") {
      mode = "libraries";
    } else if (remaining.length === 1 && remaining[0] === "--compiler") {
      mode = "compiler";
    } else if (remaining.length === 1 && remaining[0] === "--full") {
      mode = "full-system";
    } else if (remaining[0] === "--chaos" && remaining.length <= 2) {
      const parsedMode = (remaining[1] ?? "moderate").toLowerCase();
      if (parsedMode !== "none" && parsedMode !== "light" && parsedMode !== "moderate" && parsedMode !== "extreme") {
        return {
          type: "parse-error",
          reason: `Invalid chaos mode: ${parsedMode}`,
        };
      }

      mode = "chaos";
      chaosMode = parsedMode;
    }

    if (!mode) {
      return {
        type: "parse-error",
        reason: usage(),
      };
    }

    return {
      type: "verify",
      mode,
      ...(chaosMode ? { chaosMode } : {}),
      ...(parsed.seed ? { seed: parsed.seed } : {}),
    };
  }

  if (args.length === 2 && args[0] === "ci" && args[1] === "run") {
    return {
      type: "ci-run",
    };
  }

  if (isCLIExcludedVSCodeShortcut(args)) {
    return {
      type: "parse-error",
      reason: "VS Code-only chat shortcuts are not available in choir-cli.",
    };
  }

  const actionIntent = parseCliActionIntent(args);
  if (actionIntent) {
    return actionIntent;
  }

  return {
    type: "parse-error",
    reason: usage(),
  };
}

function loadControlPlane(controlPath: string) {
  if (!fs.existsSync(controlPath)) {
    throw new Error(`Control plane not found: ${controlPath}`);
  }

  const raw = fs.readFileSync(controlPath, "utf-8");
  return ControlPlaneSchema.parse(YAML.parse(raw));
}

function handleCompiledMutationResult(command: string, compiled: ReturnType<typeof compileDSLAndWrite>): number {
  if (compiled.decision === "deny") {
    printCliEnvelope({
      ok: false,
      command,
      data: {
        decision: compiled.decision,
        diffHash: compiled.diffHash,
        violations: compiled.policyResult?.violations ?? [],
      },
      error: {
        message: "Policy denied control-plane mutation.",
      },
    });
    return 1;
  }

  if (compiled.decision === "require-approval") {
    printCliEnvelope({
      ok: false,
      command,
      data: {
        decision: compiled.decision,
        diffHash: compiled.diffHash,
        pendingApprovalId: compiled.pendingApprovalId,
      },
      error: {
        message: "Policy approval is required before mutation can be applied.",
      },
    });
    return 1;
  }

  printCliEnvelope({
    ok: true,
    command,
    data: {
      decision: compiled.decision,
      changed: compiled.changed,
      diffHash: compiled.diffHash,
    },
  });
  return 0;
}

export async function executeCliIntent(args: string[]): Promise<number> {
  let intent: CliIntent;
  try {
    intent = parseCliIntent(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printCliEnvelope({
      ok: false,
      command: "parse",
      error: {
        message: `Choir CLI parse failed: ${message}`,
      },
    });
    return 1;
  }

  if (intent.type === "parse-error") {
    printCliEnvelope({
      ok: false,
      command: "parse",
      error: {
        message: intent.reason,
      },
    });
    return 1;
  }

  if (intent.type === "verify") {
    try {
      const report = await runRuntimeVerification({
        mode: intent.mode,
        workspaceRoot: process.cwd(),
        chaosMode: intent.chaosMode,
      });

      printCliEnvelope({
        ok: report.status !== "fail",
        command: "verify",
        data: {
          mode: intent.mode,
          ...(intent.chaosMode ? { chaosMode: intent.chaosMode } : {}),
          ...(intent.seed ? { ignoredSeed: intent.seed } : {}),
          summary: formatRuntimeVerificationReport(report),
          report,
        },
      });
      return report.status === "fail" ? 1 : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printCliEnvelope({
        ok: false,
        command: "verify",
        error: {
          message: `Choir verification failed: ${message}`,
        },
      });
      return 1;
    }
  }

  const root = process.cwd();
  const controlPath = path.join(root, ".choir", "choir.config.yaml");

  if (intent.type === "ci-run") {
    try {
      const controlPlane = loadControlPlane(controlPath);
      const result = await runCI({
        root,
        controlPlane,
        controlPath,
        context: {
          role: "conductor",
          environment: detectEnvironment(),
        },
        actorId: "choir-cli",
      });

      printCliEnvelope({
        ok: result.trace.result === "success",
        command: "ci-run",
        data: {
          summary: formatCIRunResult(result),
          result,
        },
      });
      return result.trace.result === "success" ? 0 : 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printCliEnvelope({
        ok: false,
        command: "ci-run",
        error: {
          message: `Choir CI failed: ${message}`,
        },
      });
      return 1;
    }
  }

  try {
    const hasControlPlane = fs.existsSync(controlPath);
    if (!hasControlPlane && intent.type !== "init") {
      throw new Error(`Control plane not found: ${controlPath}`);
    }

    const controlPlane = hasControlPlane
      ? loadControlPlane(controlPath)
      : ControlPlaneSchema.parse({
        version: "1.0.0",
        mission: "",
        vision: "",
        intent: {
          goals: [],
          constraints: [],
          nonGoals: [],
        },
        policy: {
          rules: [],
        },
        execution: {
          plans: [],
        },
      });

    if (intent.type === "define") {
      const command = `choir define ${intent.defineType} ${quoteString(intent.value)}`;
      const compiled = compileDSLAndWrite(command, controlPlane, controlPath, {
        workspaceRoot: root,
        actorId: "choir-cli",
      });

      return handleCompiledMutationResult("define", compiled);
    }

    if (intent.type === "status") {
      const pendingApprovals = policyStatus(root).pending;
      let stateReadError: string | undefined;
      let state = null;
      try {
        state = readStatePlane(root);
      } catch (error) {
        stateReadError = error instanceof Error ? error.message : String(error);
      }

      printCliEnvelope({
        ok: true,
        command: "status",
        data: {
          mission: controlPlane.mission,
          vision: controlPlane.vision,
          intent: {
            goals: controlPlane.intent.goals.length,
            constraints: controlPlane.intent.constraints.length,
            nonGoals: controlPlane.intent.nonGoals.length,
          },
          plans: {
            total: controlPlane.execution.plans.length,
            approved: controlPlane.execution.plans.filter((plan) => plan.status === "approved").length,
          },
          approvals: {
            pending: pendingApprovals.length,
          },
          state: state
            ? {
              present: true,
              stateHash: state.stateHash,
            }
            : {
              present: false,
              ...(stateReadError ? { error: stateReadError } : {}),
            },
        },
      });
      return 0;
    }

    if (intent.type === "policy-status") {
      printCliEnvelope({
        ok: true,
        command: "policy-status",
        data: policyStatus(root),
      });
      return 0;
    }

    if (intent.type === "approve") {
      const approved = approveDiff(root, intent.diffId, "choir-cli");
      printCliEnvelope({
        ok: approved.approved,
        command: "approve",
        data: approved,
        ...(approved.approved
          ? {}
          : {
            error: {
              message: `Pending diff not found: ${intent.diffId}`,
            },
          }),
      });
      return approved.approved ? 0 : 1;
    }

    if (intent.type === "reject") {
      const rejected = rejectDiff(root, intent.diffId);
      printCliEnvelope({
        ok: rejected.removed,
        command: "reject",
        data: rejected,
        ...(rejected.removed
          ? {}
          : {
            error: {
              message: `Pending diff not found: ${intent.diffId}`,
            },
          }),
      });
      return rejected.removed ? 0 : 1;
    }

    if (intent.type === "export-dsl") {
      const config = controlPlaneToChoirConfig(controlPlane);
      const generated = generateDSL(config, { section: intent.section });
      const rootDir = path.dirname(controlPath);
      const fileName = intent.section === "all" ? "choir.dsl" : `choir.${intent.section}.dsl`;
      const outputPath = path.join(rootDir, fileName);
      writeDSL(generated.script, outputPath);

      printCliEnvelope({
        ok: true,
        command: "export-dsl",
        data: {
          section: intent.section,
          outputPath: `.choir/${fileName}`,
          generatedCommands: generated.trace.generatedCommands,
          warnings: generated.trace.warnings,
          dsl: formatDSL(generated.script),
        },
      });
      return 0;
    }

    if (intent.type === "export-json") {
      const rootDir = path.dirname(controlPath);
      const outputPath = path.join(rootDir, "choir.config.json");
      const json = `${JSON.stringify(controlPlane, null, 2)}\n`;
      fs.writeFileSync(outputPath, json, "utf-8");

      printCliEnvelope({
        ok: true,
        command: "export-json",
        data: {
          outputPath: ".choir/choir.config.json",
        },
      });
      return 0;
    }

    if (intent.type === "remove-goal") {
      const nextGoals = controlPlane.intent.goals.filter((goal) => goal !== intent.goal);
      if (nextGoals.length === controlPlane.intent.goals.length) {
        printCliEnvelope({
          ok: false,
          command: "remove-goal",
          error: {
            message: `Goal not found: ${intent.goal}`,
          },
        });
        return 1;
      }

      const updatedControl = {
        ...controlPlane,
        intent: {
          ...controlPlane.intent,
          goals: nextGoals,
        },
      };
      writeYAML(controlPlaneToChoirConfig(updatedControl), controlPath);

      printCliEnvelope({
        ok: true,
        command: "remove-goal",
        data: {
          removed: intent.goal,
          remainingGoals: nextGoals.length,
        },
      });
      return 0;
    }

    if (intent.type === "analyze") {
      const summary = analyzeWorkspaceAtRoot(root);
      const hotspots = findHotspotsAtRoot(root, controlPlane);

      const data = intent.target === "workspace"
        ? { workspace: summary }
        : intent.target === "hotspots"
          ? { hotspots }
          : { workspace: summary, hotspots };

      printCliEnvelope({
        ok: true,
        command: "analyze",
        data: {
          target: intent.target,
          ...data,
        },
      });
      return 0;
    }

    if (intent.type === "abstraction-list") {
      printCliEnvelope({
        ok: true,
        command: "abstraction-list",
        data: {
          abstractions: listAbstractions(root),
        },
      });
      return 0;
    }

    if (intent.type === "abstraction-describe") {
      const abstraction = getAbstraction(root, intent.id);
      printCliEnvelope({
        ok: true,
        command: "abstraction-describe",
        data: {
          abstraction,
        },
      });
      return 0;
    }

    if (intent.type === "init") {
      const preflightMissing = detectMissingControlPlanePackageReferences(
        discoverStrategicDomains(root, intent.template),
        controlPlane,
        {
          includePackages: intent.mode !== "reclassify",
          includePackageModes: intent.mode !== "reclassify",
        }
      );

      if (preflightMissing.hasMissingReferences) {
        printCliEnvelope({
          ok: false,
          command: "init",
          error: {
            message: "Init failed: control plane references packages not present in discovery.",
          },
          data: preflightMissing,
        });
        return 1;
      }

      const discovery = discoverStrategicDomains(root, intent.template);
      const delta = detectStrategicPackageCatalogDelta(discovery, controlPlane);
      if (intent.mode === "recalibrate" && delta.hasChanges) {
        printCliEnvelope({
          ok: false,
          command: "init",
          error: {
            message: "Init --recalibrate is blocked by package catalog drift; run init --reclassify first.",
          },
          data: delta,
        });
        return 1;
      }

      const models = discovery.domains.map((domain) => {
        const defaults = seedStrategicDomainPromptDefaults(domain, controlPlane);
        return {
          id: domain.id,
          mission: defaults.mission,
          priorities: defaults.priorities,
          optimizationGoals: defaults.optimizationGoals,
          riskTolerance: defaults.riskTolerance,
          rolloutPreferences: defaults.rolloutPreferences,
          stabilityProfile: defaults.stabilityProfile,
          governanceIntensity: defaults.governanceIntensity,
          runtimeMode: defaults.runtimeMode,
          runtimeCapabilities: domain.inferred.runtimeCapabilities,
        };
      });
      const calibration = calibrateStrategicOrchestration(discovery, models);
      const synthesized = synthesizeStrategicControlPlane(controlPlane, {
        mode: intent.mode,
        runtimeMode: calibration.governanceModeRecommendation,
        mission: controlPlane.mission,
        vision: controlPlane.vision,
        discovery,
        models,
        calibration,
      });

      writeYAML(controlPlaneToChoirConfig(synthesized.controlPlane), controlPath);

      printCliEnvelope({
        ok: true,
        command: "init",
        data: {
          mode: intent.mode,
          template: intent.template,
          report: synthesized.report,
        },
      });
      return 0;
    }

    if (intent.type === "dsl-action") {
      const ast = intent.ast;

      if (ast.type === "plan" && ast.optimize) {
        const runtime = await runOrchestrationPipeline("optimize", {
          root,
          controlPlane,
          command: intent.command,
          ...(ast.target ? { targetGoal: ast.target } : {}),
        });

        const persistedControl = persistSelectedOptimizedPlan(controlPlane, runtime.optimized.selectedExecutionPlan);
        writeYAML(controlPlaneToChoirConfig(persistedControl), controlPath);

        printCliEnvelope({
          ok: true,
          command: "plan",
          data: {
            optimize: true,
            selectedPlan: runtime.optimized.selectedPlan.id,
            persistedPlan: runtime.optimized.selectedExecutionPlan.id,
            strategyId: runtime.optimized.selectedPlan.strategyId,
            planHash: runtime.optimized.planHash,
            simulationHash: runtime.optimized.simulationHash,
            runtime,
          },
        });
        return 0;
      }

      if (ast.type === "plan" && ast.adaptive) {
        const adaptive = await evaluateAdaptivePlanSelectionForCli(controlPlane, {
          root,
          ...(ast.target ? { targetGoal: ast.target } : {}),
        });

        printCliEnvelope({
          ok: true,
          command: "plan",
          data: {
            adaptive: true,
            plan: adaptive.basePlan.id,
            selectedStrategy: adaptive.selected.strategyId,
            source: "adaptive-generation",
            trace: adaptive.adaptiveTrace,
            iterations: adaptive.iterations,
            outcomes: adaptive.outcomes.map((outcome) => ({
              strategyId: outcome.strategyId,
              success: outcome.success,
              metrics: outcome.metrics,
            })),
          },
        });
        return 0;
      }

      if (ast.type === "simulate") {
        const runtime = await runOrchestrationPipeline("simulate", {
          root,
          controlPlane,
          command: intent.command,
          ...(ast.planRef ? { requestedPlanId: ast.planRef.identifier } : {}),
          ...(ast.units ? { requestedUnits: ast.units } : {}),
        });

        printCliEnvelope({
          ok: true,
          command: "simulate",
          data: {
            runtime,
          },
        });
        return 0;
      }

      if (ast.type === "preview") {
        const runtime = await runOrchestrationPipeline("preview", {
          root,
          controlPlane,
          command: intent.command,
          ...(ast.planRef ? { requestedPlanId: ast.planRef.identifier } : {}),
          persistPreviewState: true,
          recordPendingApproval: true,
        });

        printCliEnvelope({
          ok: true,
          command: "preview",
          data: {
            runtime,
          },
        });
        return 0;
      }

      if (ast.type === "execute") {
        const runtime = await runOrchestrationPipeline("execute", {
          root,
          controlPlane,
          command: intent.command,
          ...(ast.planRef ? { requestedPlanId: ast.planRef.identifier } : {}),
          ...(ast.previewRef ? { requestedPreviewRef: ast.previewRef } : {}),
          ...(ast.rolloutStrategy ? { rolloutStrategy: ast.rolloutStrategy } : {}),
        });

        printCliEnvelope({
          ok: runtime.execute?.success ?? false,
          command: "execute",
          data: {
            runtime,
          },
          ...(runtime.execute?.success
            ? {}
            : {
              error: {
                message: "Execution did not report a successful result.",
              },
            }),
        });
        return runtime.execute?.success ? 0 : 1;
      }

      if (ast.type === "rollback") {
        const rollbackStateTarget = resolveDeterministicRollbackTarget(root);
        if (rollbackStateTarget.fromHash === rollbackStateTarget.toHash) {
          printCliEnvelope({
            ok: false,
            command: "rollback",
            error: {
              message: "Rollback skipped: no prior state transition available to restore.",
            },
          });
          return 1;
        }

        persistStatePlane(root, rollbackStateTarget.state, {
          action: ast.stageId ? "rollback:stage" : ast.unitId ? "rollback:unit" : "rollback",
          metadata: {
            command: intent.command,
            policyDecision: "allow",
            auditId: `rollback-${Date.now()}`,
            ...(ast.unitId ? { unitId: ast.unitId } : {}),
          },
        });

        printCliEnvelope({
          ok: true,
          command: "rollback",
          data: {
            selector: ast.stageId ? `stage=${ast.stageId}` : ast.unitId ? `unit=${ast.unitId}` : "auto",
            stateHashBefore: rollbackStateTarget.fromHash,
            stateHashAfter: rollbackStateTarget.toHash,
            sourceTransitionId: rollbackStateTarget.sourceTransitionId,
          },
        });
        return 0;
      }

      if (ast.type === "refactor-rename" || ast.type === "refactor-move" || ast.type === "refactor-extract" || ast.type === "refactor-inline") {
        const refactorIntent = ast.type === "refactor-rename"
          ? {
            type: "rename" as const,
            symbol: ast.symbol,
            newName: ast.newName,
            ...(ast.declarationSelector !== undefined ? { declarationSelector: ast.declarationSelector } : {}),
          }
          : ast.type === "refactor-move"
            ? {
              type: "move" as const,
              symbol: ast.symbol,
              from: "*",
              ...(ast.targetUnit !== undefined ? { to: ast.targetUnit } : {}),
              ...(ast.targetFile !== undefined ? { targetFile: ast.targetFile } : {}),
            }
            : ast.type === "refactor-extract"
              ? {
                type: "extract" as const,
                symbol: ast.symbol,
                ...(ast.targetUnit !== undefined ? { targetUnit: ast.targetUnit } : {}),
                ...(ast.targetFile !== undefined ? { targetFile: ast.targetFile } : {}),
              }
              : {
                type: "inline" as const,
                symbol: ast.symbol,
              };

        const refactorResult = await runRefactorIntent(refactorIntent, {
          root,
          controlPlane,
          execute: true,
        });

        printCliEnvelope({
          ok: refactorResult.simulation.validation.passed,
          command: ast.type,
          data: {
            impact: refactorResult.impact,
            preview: refactorResult.preview,
            simulation: refactorResult.simulation,
            execution: refactorResult.execution,
          },
          ...(refactorResult.simulation.validation.passed
            ? {}
            : {
              error: {
                message: "Refactor validation failed.",
              },
            }),
        });
        return refactorResult.simulation.validation.passed ? 0 : 1;
      }

      if (ast.type === "import-library") {
        const imported = importLibrary(root, `${ast.library}@${ast.versionSelector}`);
        printCliEnvelope({
          ok: true,
          command: "import-library",
          data: imported,
        });
        return 0;
      }

      if (ast.type === "library-list") {
        printCliEnvelope({
          ok: true,
          command: "library-list",
          data: {
            catalog: listLibraryCatalog(root),
            lock: readLibraryLock(root),
          },
        });
        return 0;
      }

      if (ast.type === "library-install") {
        const installed = installLibrary(root, `${ast.library}@${ast.versionSelector}`);
        printCliEnvelope({
          ok: true,
          command: "library-install",
          data: installed,
        });
        return 0;
      }

      if (ast.type === "library-update") {
        const updated = updateLibrary(root, ast.library);
        printCliEnvelope({
          ok: true,
          command: "library-update",
          data: updated,
        });
        return 0;
      }

      if (ast.type === "library-lock") {
        const locked = lockChoirLibraries(root);
        printCliEnvelope({
          ok: true,
          command: "library-lock",
          data: {
            lock: locked,
          },
        });
        return 0;
      }

      if (ast.type === "macro-list") {
        printCliEnvelope({
          ok: true,
          command: "macro-list",
          data: {
            macros: listMacros(root),
          },
        });
        return 0;
      }

      if (ast.type === "macro-show") {
        const macro = getMacro(root, ast.macroId);
        printCliEnvelope({
          ok: true,
          command: "macro-show",
          data: {
            macro,
          },
        });
        return 0;
      }

      if (ast.type === "macro-run") {
        const executed = runMacro(root, ast.macroId, ast.args, controlPlane, controlPath, {
          workspaceRoot: root,
          executionMode: "interactive",
        });

        printCliEnvelope({
          ok: executed.decision !== "deny" && executed.decision !== "require-approval",
          command: "macro-run",
          data: executed,
          ...(executed.decision === "deny" || executed.decision === "require-approval"
            ? {
              error: {
                message: `Macro execution blocked: ${executed.decision}`,
              },
            }
            : {}),
        });
        return executed.decision === "deny" || executed.decision === "require-approval" ? 1 : 0;
      }

      if (ast.type === "abstraction-run") {
        const executed = runAbstraction(root, ast.identifier, ast.args, controlPlane, controlPath, {
          workspaceRoot: root,
          actorId: "choir-cli",
          executionMode: "interactive",
        });

        printCliEnvelope({
          ok: executed.decision !== "deny" && executed.decision !== "require-approval",
          command: "abstraction-run",
          data: {
            result: executed,
            summary: formatAbstractionRunResult(executed),
          },
          ...(executed.decision === "deny" || executed.decision === "require-approval"
            ? {
              error: {
                message: `Abstraction execution blocked: ${executed.decision}`,
              },
            }
            : {}),
        });
        return executed.decision === "deny" || executed.decision === "require-approval" ? 1 : 0;
      }

      if (ast.type === "audit-log") {
        const records = readAuditStore(root).records;
        printCliEnvelope({
          ok: true,
          command: "audit-log",
          data: {
            total: records.length,
            records,
          },
        });
        return 0;
      }

      if (ast.type === "audit-query") {
        const role = ast.filters.role;
        const environment = ast.filters.environment;
        const action = ast.filters.action;
        const from = ast.filters.from;
        const to = ast.filters.to;

        if (role && role !== "architect" && role !== "analyst" && role !== "conductor" && role !== "enforcer") {
          printCliEnvelope({
            ok: false,
            command: "audit-query",
            error: {
              message: `Invalid audit query role: ${role}`,
            },
          });
          return 1;
        }

        if (environment && environment !== "local" && environment !== "ci" && environment !== "staging" && environment !== "production") {
          printCliEnvelope({
            ok: false,
            command: "audit-query",
            error: {
              message: `Invalid audit query environment: ${environment}`,
            },
          });
          return 1;
        }

        if ((from && !to) || (!from && to)) {
          printCliEnvelope({
            ok: false,
            command: "audit-query",
            error: {
              message: "Audit query requires both from and to when filtering by time range.",
            },
          });
          return 1;
        }

        const roleFilter = role === "architect" || role === "analyst" || role === "conductor" || role === "enforcer"
          ? role
          : undefined;
        const environmentFilter = environment === "local" || environment === "ci" || environment === "staging" || environment === "production"
          ? environment
          : undefined;

        const results = queryAudit(root, {
          ...(roleFilter ? { role: roleFilter } : {}),
          ...(environmentFilter ? { environment: environmentFilter } : {}),
          ...(action ? { action } : {}),
          ...(from && to ? { timeRange: [from, to] as [string, string] } : {}),
        });

        printCliEnvelope({
          ok: true,
          command: "audit-query",
          data: {
            total: results.length,
            records: results,
          },
        });
        return 0;
      }

      if (ast.type === "audit-report") {
        const report = generateReport(root, {});
        const reportsDir = path.join(root, ".choir", "reports");
        fs.mkdirSync(reportsDir, { recursive: true });

        const jsonPath = path.join(reportsDir, "compliance-report.json");
        const yamlPath = path.join(reportsDir, "compliance-report.yaml");
        const pdfPath = path.join(reportsDir, "compliance-report.pdf");

        fs.writeFileSync(jsonPath, exportReport(report, "json"), "utf-8");
        fs.writeFileSync(yamlPath, exportReport(report, "yaml"), "utf-8");
        fs.writeFileSync(pdfPath, exportReport(report, "pdf"), "binary");

        printCliEnvelope({
          ok: true,
          command: "audit-report",
          data: {
            report,
            exported: [
              ".choir/reports/compliance-report.json",
              ".choir/reports/compliance-report.yaml",
              ".choir/reports/compliance-report.pdf",
            ],
          },
        });
        return 0;
      }

      if (ast.type === "plan-approve") {
        const compiled = compileDSLAndWrite(intent.command, controlPlane, controlPath, {
          workspaceRoot: root,
          actorId: "choir-cli",
        });
        return handleCompiledMutationResult("plan-approve", compiled);
      }

      if (ast.type === "define" || ast.type === "status" || ast.type === "policy-status" || ast.type === "approve" || ast.type === "reject" || ast.type === "export" || ast.type === "analyze" || ast.type === "ci-run") {
        const compiled = compileDSLAndWrite(intent.command, controlPlane, controlPath, {
          workspaceRoot: root,
          actorId: "choir-cli",
        });
        return handleCompiledMutationResult(ast.type, compiled);
      }

      const compiled = compileDSLAndWrite(intent.command, controlPlane, controlPath, {
        workspaceRoot: root,
        actorId: "choir-cli",
      });
      return handleCompiledMutationResult(ast.type, compiled);
    }

    printCliEnvelope({
      ok: false,
      command: "parse",
      error: {
        message: "Command parsed but not yet implemented in CLI executor.",
      },
    });
    return 1;
  } catch (error) {
    if (error instanceof OrchestrationPipelineError) {
      printCliEnvelope({
        ok: false,
        command: intent.type,
        error: {
          message: `Pipeline failed at stage ${error.failedStage}: ${error.message}`,
        },
        data: {
          stageResults: error.stageResults,
        },
      });
      return 1;
    }

    const message = error instanceof Error ? error.message : String(error);
    printCliEnvelope({
      ok: false,
      command: intent.type,
      error: {
        message,
      },
    });
    return 1;
  }
}
