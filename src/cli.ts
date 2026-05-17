#!/usr/bin/env node

import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { formatCIRunResult, runCI } from "./core/ci.js";
import { detectEnvironment } from "./core/policyEngine.js";
import {
  formatRuntimeVerificationReport,
  runRuntimeVerification,
  type RuntimeVerificationMode,
} from "./core/runtimeVerification.js";
import { ControlPlaneSchema } from "./schema.js";

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

function loadControlPlane(controlPath: string) {
  if (!fs.existsSync(controlPath)) {
    throw new Error(`Control plane not found: ${controlPath}`);
  }

  const raw = fs.readFileSync(controlPath, "utf-8");
  return ControlPlaneSchema.parse(YAML.parse(raw));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "verify") {
    try {
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
          throw new Error(`Invalid chaos mode: ${parsedMode}`);
        }

        mode = "chaos";
        chaosMode = parsedMode;
      }

      if (!mode) {
        console.error(usage());
        process.exitCode = 1;
        return;
      }

      const report = await runRuntimeVerification({
        mode,
        workspaceRoot: process.cwd(),
        chaosMode,
      });

      console.log(formatRuntimeVerificationReport(report));
      if (parsed.seed) {
        console.log(`- note: --seed ${parsed.seed} is ignored for runtime-safe verification modes`);
      }
      process.exitCode = report.status === "fail" ? 1 : 0;
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Choir verification failed: ${message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.length !== 2 || args[0] !== "ci" || args[1] !== "run") {
    console.error(usage());
    process.exitCode = 1;
    return;
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

    console.log(formatCIRunResult(result));
    process.exitCode = result.trace.result === "success" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Choir CI failed: ${message}`);
    process.exitCode = 1;
  }
}

void main();
