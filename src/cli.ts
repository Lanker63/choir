#!/usr/bin/env node

import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { formatCIRunResult, runCI } from "./core/ci.js";
import { detectEnvironment } from "./core/policyEngine.js";
import { ChaosMode, ciIterationLimit, formatChaosTestReport, runChaosTest, runPropertyTest, setSeed } from "./core/propertyChaosHarness.js";
import { formatVerificationReport, runFullVerification } from "./core/verificationHarness.js";
import { ControlPlaneSchema } from "./schema.js";

function usage(): string {
  return [
    "Choir CLI",
    "",
    "Usage:",
    "  choir ci run",
    "  choir verify [--quick]",
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
      if (parsed.seed) {
        setSeed(parsed.seed);
      }

      if (remaining.length === 0 || (remaining.length === 1 && remaining[0] === "--quick")) {
        const report = await runFullVerification({
          mode: remaining[0] === "--quick" ? "quick" : "full",
          throwOnFailure: false,
          detectFlakiness: true,
        });
        console.log(formatVerificationReport(report));
        process.exitCode = report.passed ? 0 : 1;
        return;
      }

      if (remaining.length === 1 && remaining[0] === "--property") {
        const report = await runPropertyTest(ciIterationLimit(60, 16), {
          seed: parsed.seed,
          throwOnFailure: false,
        });
        console.log(formatChaosTestReport(report));
        process.exitCode = report.failures === 0 ? 0 : 1;
        return;
      }

      if (remaining[0] === "--chaos" && remaining.length <= 2) {
        const modeValue = (remaining[1] ?? "moderate").toLowerCase();
        if (modeValue !== "none" && modeValue !== "light" && modeValue !== "moderate" && modeValue !== "extreme") {
          throw new Error(`Invalid chaos mode: ${modeValue}`);
        }

        const report = await runChaosTest(modeValue as ChaosMode, ciIterationLimit(30, 10), {
          seed: parsed.seed,
          throwOnFailure: false,
        });
        console.log(formatChaosTestReport(report));
        process.exitCode = report.failures === 0 ? 0 : 1;
        return;
      }

      console.error(usage());
      process.exitCode = 1;
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
