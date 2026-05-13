import fs from "fs";
import os from "os";
import path from "path";
import * as YAML from "yaml";
import { ControlPlane } from "../schema.js";
import {
  OrchestrationPipelineError,
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
  fs.writeFileSync(
    path.join(root, ".choir", "choir.config.yaml"),
    YAML.stringify(fixtureControlPlane()),
    "utf-8"
  );
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

async function runPreviewWithState(root: string): Promise<Awaited<ReturnType<typeof runOrchestrationPipeline>>> {
  return runOrchestrationPipeline("preview", {
    root,
    controlPlane: fixtureControlPlane(),
    command: "choir preview",
    persistArtifacts: false,
    persistPreviewState: true,
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

    const stateTamperRoot = makeTempRoot();
    try {
      await runPreviewWithState(stateTamperRoot);
      const statePath = path.join(stateTamperRoot, ".choir", "state.json");
      const tamperedRaw = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Record<string, unknown>;
      tamperedRaw.execution = {
        ...(typeof tamperedRaw.execution === "object" && tamperedRaw.execution !== null ? tamperedRaw.execution as Record<string, unknown> : {}),
        activePlanId: "tampered-plan-id",
      };
      fs.writeFileSync(statePath, `${JSON.stringify(tamperedRaw, null, 2)}\n`, "utf-8");

      let blocked = false;
      let preTransaction = false;
      try {
        await runMode("execute", stateTamperRoot);
      } catch (error) {
        if (error instanceof OrchestrationPipelineError) {
          blocked = error.failedStage === "integrity"
            && /STATE_SNAPSHOT_INVALID|STATE_SNAPSHOT_MISMATCH|PREVIEW_HASH_MISMATCH/.test(error.message);
          preTransaction = !error.stageResults.some((stage) => stage.stage === "execution" && stage.status === "success");
        }
      }

      checks.push({
        name: "integrity-gate-aborts-on-state-tamper-before-transaction",
        passed: blocked && preTransaction,
        detail: blocked
          ? "state tamper produced integrity failure and execution stage never committed"
          : "state tamper did not trigger integrity pre-transaction abort",
      });
    } finally {
      fs.rmSync(stateTamperRoot, { recursive: true, force: true });
    }

    const dagTamperRoot = makeTempRoot();
    try {
      await runPreviewWithState(dagTamperRoot);
      const latestTracePath = path.join(dagTamperRoot, ".choir", "traces", "orchestration", "latest.json");
      const latestTrace = JSON.parse(fs.readFileSync(latestTracePath, "utf-8")) as Record<string, unknown>;
      const modeMetadata = (typeof latestTrace.modeMetadata === "object" && latestTrace.modeMetadata !== null)
        ? latestTrace.modeMetadata as Record<string, unknown>
        : {};
      const integrity = (typeof modeMetadata.integrity === "object" && modeMetadata.integrity !== null)
        ? modeMetadata.integrity as Record<string, unknown>
        : {};
      integrity.orchestrationHash = "deadbeef";
      modeMetadata.integrity = integrity;
      latestTrace.modeMetadata = modeMetadata;
      fs.writeFileSync(latestTracePath, `${JSON.stringify(latestTrace, null, 2)}\n`, "utf-8");

      let blocked = false;
      let preTransaction = false;
      try {
        await runMode("execute", dagTamperRoot);
      } catch (error) {
        if (error instanceof OrchestrationPipelineError) {
          blocked = error.failedStage === "integrity"
            && /DAG_HASH_MISMATCH|ORCHESTRATION_HASH_MISMATCH/.test(error.message);
          preTransaction = !error.stageResults.some((stage) => stage.stage === "execution" && stage.status === "success");
        }
      }

      checks.push({
        name: "integrity-gate-detects-dag-artifact-corruption",
        passed: blocked && preTransaction,
        detail: blocked
          ? "DAG artifact corruption detected before transaction execution"
          : "DAG artifact corruption was not blocked by integrity gate",
      });
    } finally {
      fs.rmSync(dagTamperRoot, { recursive: true, force: true });
    }

    const staleSimulationRoot = makeTempRoot();
    try {
      await runPreviewWithState(staleSimulationRoot);
      const mutatedControl = fixtureControlPlane() as unknown as Record<string, unknown>;
      const intent = (typeof mutatedControl.intent === "object" && mutatedControl.intent !== null)
        ? mutatedControl.intent as Record<string, unknown>
        : {};
      const goals = Array.isArray(intent.goals) ? intent.goals.slice() : [];
      goals.push("post-simulation-input-change");
      intent.goals = goals;
      mutatedControl.intent = intent;

      let blocked = false;
      let preTransaction = false;
      try {
        await runOrchestrationPipeline("execute", {
          root: staleSimulationRoot,
          controlPlane: mutatedControl as unknown as ControlPlane,
          command: "choir execute",
          persistArtifacts: false,
          persistPreviewState: false,
          recordPendingApproval: false,
        });
      } catch (error) {
        if (error instanceof OrchestrationPipelineError) {
          blocked = error.failedStage === "integrity"
            && /STALE_SIMULATION_ARTIFACT|PREVIEW_HASH_MISMATCH|SIMULATION_EXECUTION_PARITY_MISMATCH/.test(error.message);
          preTransaction = !error.stageResults.some((stage) => stage.stage === "execution" && stage.status === "success");
        }
      }

      checks.push({
        name: "integrity-gate-detects-stale-simulation-after-input-change",
        passed: blocked && preTransaction,
        detail: blocked
          ? "input mutation after preview/simulation forced deterministic integrity abort"
          : "stale simulation/input divergence was not blocked before execution",
      });
    } finally {
      fs.rmSync(staleSimulationRoot, { recursive: true, force: true });
    }

    const strategyTamperRoot = makeTempRoot();
    try {
      await runPreviewWithState(strategyTamperRoot);
      const latestTracePath = path.join(strategyTamperRoot, ".choir", "traces", "orchestration", "latest.json");
      const latestTrace = JSON.parse(fs.readFileSync(latestTracePath, "utf-8")) as Record<string, unknown>;
      const modeMetadata = (typeof latestTrace.modeMetadata === "object" && latestTrace.modeMetadata !== null)
        ? latestTrace.modeMetadata as Record<string, unknown>
        : {};
      const integrity = (typeof modeMetadata.integrity === "object" && modeMetadata.integrity !== null)
        ? modeMetadata.integrity as Record<string, unknown>
        : {};
      integrity.strategyId = "tampered-strategy";
      modeMetadata.integrity = integrity;
      latestTrace.modeMetadata = modeMetadata;
      fs.writeFileSync(latestTracePath, `${JSON.stringify(latestTrace, null, 2)}\n`, "utf-8");

      let blocked = false;
      try {
        await runMode("execute", strategyTamperRoot);
      } catch (error) {
        if (error instanceof OrchestrationPipelineError) {
          blocked = error.failedStage === "integrity"
            && /STRATEGY_ID_MISMATCH/.test(error.message);
        }
      }

      checks.push({
        name: "integrity-gate-detects-strategy-id-mismatch",
        passed: blocked,
        detail: blocked
          ? "strategy artifact mismatch blocked execution"
          : "strategy artifact mismatch did not trigger integrity failure",
      });
    } finally {
      fs.rmSync(strategyTamperRoot, { recursive: true, force: true });
    }
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
