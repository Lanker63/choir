#!/usr/bin/env node

import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { formatCIRunResult, runCI } from "./core/ci.js";
import { detectEnvironment } from "./core/policyEngine.js";
import { ControlPlaneSchema } from "./schema.js";

function usage(): string {
  return [
    "Choir CLI",
    "",
    "Usage:",
    "  choir ci run",
  ].join("\n");
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
