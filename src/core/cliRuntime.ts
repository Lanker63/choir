import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { formatCIRunResult, runCI } from "./ci.js";
import { detectEnvironment } from "./policyEngine.js";
import {
  formatRuntimeVerificationReport,
  runRuntimeVerification,
  type RuntimeVerificationMode,
} from "./runtimeVerification.js";
import { ControlPlaneSchema } from "../schema.js";
import { isCLIExcludedVSCodeShortcut } from "./cliSurface.js";

export type CliVerifyIntent = {
  type: "verify";
  mode: RuntimeVerificationMode;
  chaosMode?: "none" | "light" | "moderate" | "extreme";
  seed?: number;
};

export type CliCIRunIntent = {
  type: "ci-run";
};

export type CliParseErrorIntent = {
  type: "parse-error";
  reason: string;
};

export type CliIntent = CliVerifyIntent | CliCIRunIntent | CliParseErrorIntent;

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

export function parseCliIntent(args: string[]): CliIntent {
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
