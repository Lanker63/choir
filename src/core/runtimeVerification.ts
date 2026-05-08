import fs from "fs";
import os from "os";
import path from "path";
import { ControlPlane } from "../schema.js";
import {
  runOrchestrationPipeline,
  type PipelineMode,
} from "./orchestrationRuntime.js";

export type RuntimeVerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type RuntimeVerificationReport = {
  passed: boolean;
  checks: RuntimeVerificationCheck[];
  failures: string[];
};

function fixtureControlPlane(): ControlPlane {
  return {
    version: "1.0.0",
    mission: "unified deterministic runtime verification",
    vision: "single orchestration kernel",
    intent: {
      goals: ["stabilize unified orchestration"],
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

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choir-runtime-verify-"));
  fs.mkdirSync(path.join(root, ".choir"), { recursive: true });
  return root;
}

async function runMode(mode: PipelineMode, root: string): Promise<Awaited<ReturnType<typeof runOrchestrationPipeline>>> {
  const command = mode === "optimize"
    ? "choir plan --optimize"
    : `choir ${mode}`;

  return runOrchestrationPipeline(mode, {
    root,
    controlPlane: fixtureControlPlane(),
    command,
    persistArtifacts: false,
    persistPreviewState: false,
    recordPendingApproval: false,
  });
}

export async function runRuntimeVerification(): Promise<RuntimeVerificationReport> {
  const checks: RuntimeVerificationCheck[] = [];

  const modeRoots = {
    preview: makeTempRoot(),
    simulate: makeTempRoot(),
    execute: makeTempRoot(),
    optimize: makeTempRoot(),
  };

  try {
    const preview = await runMode("preview", modeRoots.preview);
    const simulate = await runMode("simulate", modeRoots.simulate);
    const execute = await runMode("execute", modeRoots.execute);
    const optimize = await runMode("optimize", modeRoots.optimize);

    checks.push({
      name: "preview-uses-unified-runtime",
      passed: preview.trace.mode === "preview" && preview.trace.status === "success" && Boolean(preview.preview),
      detail: `trace=${preview.trace.id}, mode=${preview.trace.mode}, selected=${preview.selectedPlanId}`,
    });

    checks.push({
      name: "simulate-uses-unified-runtime",
      passed: simulate.trace.mode === "simulate" && simulate.trace.status === "success" && Boolean(simulate.simulate),
      detail: `trace=${simulate.trace.id}, mode=${simulate.trace.mode}, selected=${simulate.selectedPlanId}`,
    });

    checks.push({
      name: "execute-uses-unified-runtime",
      passed: execute.trace.mode === "execute" && execute.trace.status === "success" && Boolean(execute.execute),
      detail: `trace=${execute.trace.id}, mode=${execute.trace.mode}, selected=${execute.selectedPlanId}`,
    });

    checks.push({
      name: "optimize-uses-unified-runtime",
      passed: optimize.trace.mode === "optimize" && optimize.trace.status === "success",
      detail: `trace=${optimize.trace.id}, mode=${optimize.trace.mode}, selected=${optimize.selectedPlanId}`,
    });

    const deterministicRoot = makeTempRoot();
    try {
      const first = await runMode("optimize", deterministicRoot);
      const second = await runMode("optimize", deterministicRoot);

      const candidatesStable = first.candidatePlans.map((candidate) => `${candidate.strategyType}:${candidate.id}`).join("|")
        === second.candidatePlans.map((candidate) => `${candidate.strategyType}:${candidate.id}`).join("|");
      checks.push({
        name: "candidate-synthesis-deterministic",
        passed: candidatesStable,
        detail: `first=${first.candidatePlans.length}, second=${second.candidatePlans.length}`,
      });

      checks.push({
        name: "replay-deterministic",
        passed: first.replayVerification.verified && second.replayVerification.verified,
        detail: `firstVerified=${first.replayVerification.verified}, secondVerified=${second.replayVerification.verified}`,
      });

      checks.push({
        name: "orchestration-dag-deterministic",
        passed: first.executionDag.hash === second.executionDag.hash,
        detail: `first=${first.executionDag.hash.slice(0, 12)}, second=${second.executionDag.hash.slice(0, 12)}`,
      });
    } finally {
      fs.rmSync(deterministicRoot, { recursive: true, force: true });
    }

    checks.push({
      name: "simulation-execution-parity",
      passed: (() => {
        const payload = execute.execute;
        if (!payload) {
          return false;
        }

        return payload.simulationFutureStateHash === payload.finalStateHash
          && execute.simulationContract.futureStateHash === payload.finalStateHash;
      })(),
      detail: execute.execute
        ? `simulation=${execute.execute.simulationFutureStateHash.slice(0, 12)}, execution=${execute.execute.finalStateHash.slice(0, 12)}`
        : "execution payload missing",
    });
  } finally {
    for (const root of Object.values(modeRoots)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const failures = checks
    .filter((check) => !check.passed)
    .map((check) => `${check.name}: ${check.detail}`);

  return {
    passed: failures.length === 0,
    checks,
    failures,
  };
}

export function formatRuntimeVerificationReport(report: RuntimeVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} runtime verification`,
    ...report.checks.map((check) => `- ${check.name}: ${check.passed ? "PASS" : "FAIL"} (${check.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((failure) => `- ${failure}`));
  }

  return lines.join("\n");
}
