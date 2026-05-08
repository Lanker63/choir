import fs from "fs";
import os from "os";
import path from "path";
import { ControlPlane } from "../schema.js";
import {
  SimulationOrchestrationError,
  runSimulationOrchestrator,
} from "./simulationOrchestrator.js";

export type SimulationVerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type SimulationVerificationReport = {
  passed: boolean;
  checks: SimulationVerificationCheck[];
  failures: string[];
};

function fixtureControlPlane(): ControlPlane {
  return {
    version: "1.0.0",
    mission: "verify autonomous simulation",
    vision: "deterministic and safe",
    intent: {
      goals: ["stabilize simulation"],
      constraints: [],
      "non-goals": [],
    },
    policy: {
      rules: [],
    },
    execution: {
      plans: [],
    },
  };
}

export async function runSimulationVerification(): Promise<SimulationVerificationReport> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choir-simulation-verify-"));
  const checks: SimulationVerificationCheck[] = [];

  try {
    const controlPlane = fixtureControlPlane();
    const simulated = await runSimulationOrchestrator({
      root,
      controlPlane,
      command: "choir simulate",
    });

    checks.push({
      name: "no-plan-simulation-synthesizes-candidate",
      passed: simulated.planSource === "synthesized" && simulated.planId.length > 0,
      detail: `plan=${simulated.planId}, source=${simulated.planSource}`,
    });

    checks.push({
      name: "simulation-uses-replayable-deterministic-trace",
      passed: simulated.replay.validated && simulated.replay.verified && simulated.replay.hashMatches,
      detail: `trace=${simulated.replay.traceId}, stages=${simulated.replay.stageIds.length}, transitions=${simulated.replay.transitionCount}`,
    });

    checks.push({
      name: "simulation-guards-against-state-mutation",
      passed: simulated.hashes.stateBefore === simulated.hashes.stateAfter,
      detail: `stateBefore=${simulated.hashes.stateBefore.slice(0, 12)}, stateAfter=${simulated.hashes.stateAfter.slice(0, 12)}`,
    });

    checks.push({
      name: "simulation-reports-policy-decision",
      passed: ["allow", "require-approval", "deny"].includes(simulated.policy.decision),
      detail: `policyDecision=${simulated.policy.decision}, violations=${simulated.policy.violations.length}`,
    });

    let blockedInvalidIntent = false;
    let invalidDetail = "missing";
    try {
      await runSimulationOrchestrator({
        root,
        controlPlane,
        command: "choir simulate plan missing-plan",
      });
      invalidDetail = "unexpectedly succeeded";
    } catch (error) {
      if (error instanceof SimulationOrchestrationError) {
        blockedInvalidIntent = true;
        invalidDetail = `${error.failedStage}: ${error.message}`;
      } else {
        invalidDetail = error instanceof Error ? error.message : String(error);
      }
    }

    checks.push({
      name: "invalid-intent-blocks-simulation",
      passed: blockedInvalidIntent,
      detail: invalidDetail,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const failures = checks
    .filter((entry) => !entry.passed)
    .map((entry) => `${entry.name}: ${entry.detail}`);

  return {
    passed: failures.length === 0,
    checks,
    failures,
  };
}

export function formatSimulationVerificationReport(report: SimulationVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} simulation verification`,
    ...report.checks.map((entry) => `- ${entry.name}: ${entry.passed ? "PASS" : "FAIL"} (${entry.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((entry) => `- ${entry}`));
  }

  return lines.join("\n");
}
