import fs from "fs";
import os from "os";
import path from "path";
import * as YAML from "yaml";
import { ControlPlane } from "../../../schema.js";
import {
  OrchestrationPipelineError,
  runOrchestrationPipeline,
  type PipelineMode,
} from "../../../core/orchestrationRuntime.js";
import { replayMaterializationFromLineage } from "../../../core/materializationEngine.js";
import { CanonicalWorkspaceHasher } from "../../../core/workspaceSnapshot.js";

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

async function withTemporaryEnv(
  updates: Partial<Record<string, string | undefined>>,
  run: () => Promise<void>
): Promise<void> {
  const keys = Object.keys(updates);
  const original: Record<string, string | undefined> = {};
  for (const key of keys) {
    original[key] = process.env[key];
    const value = updates[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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
      name: "execute-stage-flow-materialization",
      passed: ["analyze", "validate", "synthesize", "generate", "apply", "verify", "commit"]
        .every((stage) => execute.stageResults.some((entry) => entry.stage === stage && entry.status === "success")),
      detail: `stages=${execute.stageResults.map((entry) => `${entry.stage}:${entry.status}`).join(",")}`,
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

    const generationRootA = makeTempRoot();
    const generationRootB = makeTempRoot();
    try {
      const firstExecute = await runMode("execute", generationRootA);
      const secondExecute = await runMode("execute", generationRootB);

      const firstPayload = firstExecute.execute as unknown as Record<string, unknown> | undefined;
      const secondPayload = secondExecute.execute as unknown as Record<string, unknown> | undefined;
      const sameMutationHash = typeof firstPayload?.mutationHash === "string"
        && firstPayload.mutationHash === secondPayload?.mutationHash;
      const sameWorkspaceHash = typeof firstPayload?.workspaceHash === "string"
        && firstPayload.workspaceHash === secondPayload?.workspaceHash;

      checks.push({
        name: "deterministic-generation-mutation-plan",
        passed: sameMutationHash && sameWorkspaceHash,
        detail: `firstMutation=${String(firstPayload?.mutationHash ?? "")}, secondMutation=${String(secondPayload?.mutationHash ?? "")}`,
      });
    } finally {
      fs.rmSync(generationRootA, { recursive: true, force: true });
      fs.rmSync(generationRootB, { recursive: true, force: true });
    }

    const applyDeterminismRoot = makeTempRoot();
    try {
      const firstExecute = await runMode("execute", applyDeterminismRoot);
      const secondExecute = await runMode("execute", applyDeterminismRoot);

      const firstPayload = firstExecute.execute as unknown as Record<string, unknown> | undefined;
      const secondPayload = secondExecute.execute as unknown as Record<string, unknown> | undefined;

      checks.push({
        name: "deterministic-apply-workspace-state",
        passed: typeof firstPayload?.workspaceHash === "string"
          && firstPayload.workspaceHash === secondPayload?.workspaceHash
          && firstPayload.workspaceHash === firstPayload.replayWorkspaceHash
          && secondPayload?.workspaceHash === secondPayload?.replayWorkspaceHash,
        detail: `firstWorkspace=${String(firstPayload?.workspaceHash ?? "")}, secondWorkspace=${String(secondPayload?.workspaceHash ?? "")}`,
      });
    } finally {
      fs.rmSync(applyDeterminismRoot, { recursive: true, force: true });
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

    checks.push({
      name: "execute-payload-is-mutation-aware",
      passed: (() => {
        const payload = execute.execute as unknown as Record<string, unknown> | undefined;
        if (!payload) {
          return false;
        }

        return typeof payload.mutationHash === "string"
          && (payload.mutationHash as string).length > 0
          && typeof payload.workspaceHash === "string"
          && (payload.workspaceHash as string).length > 0
          && typeof payload.replayWorkspaceHash === "string"
          && (payload.replayWorkspaceHash as string).length > 0;
      })(),
      detail: execute.execute
        ? `keys=${Object.keys(execute.execute as unknown as Record<string, unknown>).sort((a, b) => a.localeCompare(b)).join(",")}`
        : "execution payload missing",
    });

    checks.push({
      name: "workspace-replay-equivalence",
      passed: (() => {
        const payload = execute.execute as unknown as Record<string, unknown> | undefined;
        if (!payload) {
          return false;
        }

        return typeof payload.workspaceHash === "string"
          && typeof payload.replayWorkspaceHash === "string"
          && payload.workspaceHash === payload.replayWorkspaceHash;
      })(),
      detail: (() => {
        const payload = execute.execute as unknown as Record<string, unknown> | undefined;
        if (!payload) {
          return "execution payload missing";
        }

        return `workspace=${String(payload.workspaceHash ?? "")}, replay=${String(payload.replayWorkspaceHash ?? "")}`;
      })(),
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
            && /STATE_SNAPSHOT_INVALID|STATE_LINEAGE_DIVERGENCE|PREVIEW_HASH_MISMATCH/.test(error.message);
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
            && /REPLAY_LINEAGE_DIVERGENCE|STATE_LINEAGE_DIVERGENCE|PREVIEW_HASH_MISMATCH|SIMULATION_EXECUTION_PARITY_MISMATCH/.test(error.message);
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

    const manifestTamperRoot = makeTempRoot();
    try {
      await runPreviewWithState(manifestTamperRoot);
      await runMode("execute", manifestTamperRoot);

      const latestTracePath = path.join(manifestTamperRoot, ".choir", "traces", "orchestration", "latest.json");
      const latestTrace = JSON.parse(fs.readFileSync(latestTracePath, "utf-8")) as Record<string, unknown>;
      const modeMetadata = (typeof latestTrace.modeMetadata === "object" && latestTrace.modeMetadata !== null)
        ? latestTrace.modeMetadata as Record<string, unknown>
        : {};
      const materialization = (typeof modeMetadata.materialization === "object" && modeMetadata.materialization !== null)
        ? modeMetadata.materialization as Record<string, unknown>
        : {};
      materialization.manifestHash = "tampered-manifest-hash";
      modeMetadata.materialization = materialization;
      latestTrace.modeMetadata = modeMetadata;
      fs.writeFileSync(latestTracePath, `${JSON.stringify(latestTrace, null, 2)}\n`, "utf-8");

      let blocked = false;
      let preTransaction = false;
      try {
        await runMode("execute", manifestTamperRoot);
      } catch (error) {
        if (error instanceof OrchestrationPipelineError) {
          blocked = error.failedStage === "integrity"
            && /MANIFEST_TAMPER|MUTATION_MANIFEST_TAMPERED/.test(error.message);
          preTransaction = !error.stageResults.some((stage) => stage.stage === "apply" && stage.status === "success");
        }
      }

      checks.push({
        name: "integrity-gate-detects-mutation-manifest-tamper",
        passed: blocked && preTransaction,
        detail: blocked
          ? "mutation manifest tamper blocked execution before transactional apply"
          : "mutation manifest tamper was not blocked by integrity gate",
      });
    } finally {
      fs.rmSync(manifestTamperRoot, { recursive: true, force: true });
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

    const replayRestoreRoot = makeTempRoot();
    try {
      const executed = await runMode("execute", replayRestoreRoot);
      const manifestId = executed.execute?.manifestId ?? "";

      for (const entry of fs.readdirSync(replayRestoreRoot).sort((left, right) => left.localeCompare(right))) {
        if (entry === ".choir") {
          continue;
        }

        fs.rmSync(path.join(replayRestoreRoot, entry), { recursive: true, force: true });
      }

      const replayed = await replayMaterializationFromLineage({
        root: replayRestoreRoot,
        manifestId,
        restore: true,
      });
      const restoredHash = CanonicalWorkspaceHasher.capture(replayRestoreRoot).snapshotHash;

      checks.push({
        name: "replay-reconstruction-restores-workspace-after-delete",
        passed: replayed.success
          && typeof executed.execute?.workspaceHash === "string"
          && replayed.workspaceHash === executed.execute.workspaceHash
          && restoredHash === executed.execute.workspaceHash,
        detail: `restored=${restoredHash}, execute=${String(executed.execute?.workspaceHash ?? "")}`,
      });
    } finally {
      fs.rmSync(replayRestoreRoot, { recursive: true, force: true });
    }

    const workspaceDivergenceRoot = makeTempRoot();
    try {
      await runPreviewWithState(workspaceDivergenceRoot);
      fs.writeFileSync(path.join(workspaceDivergenceRoot, "non_targeted_divergence.txt"), "tampered\n", "utf-8");

      let blocked = false;
      try {
        await runMode("execute", workspaceDivergenceRoot);
      } catch (error) {
        if (error instanceof OrchestrationPipelineError) {
          blocked = error.failedStage === "integrity"
            && /WORKSPACE_SNAPSHOT_DIVERGENCE|REPLAY_LINEAGE_DIVERGENCE/.test(error.message);
        }
      }

      checks.push({
        name: "integrity-gate-detects-full-workspace-divergence",
        passed: blocked,
        detail: blocked
          ? "non-targeted workspace mutation triggered integrity abort"
          : "non-targeted workspace mutation was not blocked",
      });
    } finally {
      fs.rmSync(workspaceDivergenceRoot, { recursive: true, force: true });
    }

    const patchOrderTamperRoot = makeTempRoot();
    try {
      const executed = await runMode("execute", patchOrderTamperRoot);
      const manifestId = executed.execute?.manifestId ?? "";
      const manifestPath = path.join(patchOrderTamperRoot, ".choir", "artifacts", "materialization", `${manifestId}.json`);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      const mutationSet = (typeof manifest.mutationSet === "object" && manifest.mutationSet !== null)
        ? manifest.mutationSet as Record<string, unknown>
        : {};
      let patchOperations: Array<Record<string, unknown>> = Array.isArray(mutationSet.patchOperations)
        ? mutationSet.patchOperations.slice().reverse().map((entry, index) => ({
          ...(entry as Record<string, unknown>),
          order: Number(index + 1000),
        }))
        : [];

      if (patchOperations.length === 0) {
        patchOperations = [{
          id: "tampered-patch-op",
          transactionId: "tampered-tx",
          batchId: "tampered-batch",
          order: 1000,
          files: ["tampered.ts"],
          patchHash: "tampered-patch-hash",
          patch: {
            type: "create-file",
            file: "tampered.ts",
            content: "export const tampered = true;\n",
          },
        }];
      }
      mutationSet.patchOperations = patchOperations;
      manifest.mutationSet = mutationSet;
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

      const replayed = await replayMaterializationFromLineage({
        root: patchOrderTamperRoot,
        manifestId,
        restore: false,
      });

      checks.push({
        name: "replay-detects-patch-order-tamper",
        passed: !replayed.success && replayed.errors.some((entry) => /PATCH_ORDER_DIVERGENCE/.test(entry)),
        detail: replayed.errors.join(" | ") || "unexpected success",
      });
    } finally {
      fs.rmSync(patchOrderTamperRoot, { recursive: true, force: true });
    }

    const concurrentRoot = makeTempRoot();
    try {
      const allHashes: string[] = [];
      const failureMessages: string[] = [];

      for (let round = 0; round < 3; round += 1) {
        const outcomes = await Promise.all(
          Array.from({ length: 4 }, async () => {
            try {
              const result = await runMode("execute", concurrentRoot);
              return { ok: true as const, hash: result.execute?.workspaceHash ?? "" };
            } catch (error) {
              return {
                ok: false as const,
                message: error instanceof Error ? error.message : String(error),
              };
            }
          })
        );

        failureMessages.push(
          ...outcomes
            .filter((entry): entry is { ok: false; message: string } => !entry.ok)
            .map((entry) => entry.message)
        );
        for (const outcome of outcomes) {
          if (outcome.ok && outcome.hash) {
            allHashes.push(outcome.hash);
          }
        }
      }

      const uniqueHashes = new Set(allHashes);
      const deterministicFailuresOnly = failureMessages.every((message) =>
        /IntegrityViolation|WORKSPACE_SNAPSHOT_DIVERGENCE|REPLAY_LINEAGE_DIVERGENCE|Transactional apply failed/.test(message)
      );
      checks.push({
        name: "concurrent-execute-fuzzing-is-deterministic",
        passed: allHashes.length > 0
          && uniqueHashes.size === 1
          && deterministicFailuresOnly,
        detail: `runs=${allHashes.length}, failures=${failureMessages.length}, uniqueHashes=${uniqueHashes.size}`,
      });
    } finally {
      fs.rmSync(concurrentRoot, { recursive: true, force: true });
    }

    const edgeCaseRoot = makeTempRoot();
    try {
      const unicodeDir = path.join(edgeCaseRoot, "unicøde-dir");
      const unicodeFile = path.join(unicodeDir, "ßeta.ts");
      const symlinkPath = path.join(edgeCaseRoot, "link-unicode.ts");
      fs.mkdirSync(unicodeDir, { recursive: true });
      fs.writeFileSync(unicodeFile, "export const edgeCase = 'ok';\n", "utf-8");
      fs.symlinkSync(path.relative(edgeCaseRoot, unicodeFile), symlinkPath);

      const executed = await runMode("execute", edgeCaseRoot);
      const manifestId = executed.execute?.manifestId ?? "";
      const replayed = await replayMaterializationFromLineage({
        root: edgeCaseRoot,
        manifestId,
        restore: false,
      });

      checks.push({
        name: "symlink-unicode-directory-edge-cases-are-deterministic",
        passed: replayed.success
          && replayed.workspaceHash === executed.execute?.workspaceHash
          && executed.execute?.workspaceHash === executed.execute?.replayWorkspaceHash,
        detail: `execute=${String(executed.execute?.workspaceHash ?? "")}, replay=${replayed.workspaceHash}`,
      });
    } finally {
      fs.rmSync(edgeCaseRoot, { recursive: true, force: true });
    }

    const replayFidelityRoot = makeTempRoot();
    try {
      const executed = await runMode("execute", replayFidelityRoot);
      const manifestId = executed.execute?.manifestId ?? "";
      const replayed = await replayMaterializationFromLineage({
        root: replayFidelityRoot,
        manifestId,
        restore: false,
      });

      checks.push({
        name: "replay-reconstruction-fidelity-hash-equals-execute",
        passed: replayed.success && replayed.workspaceHash === executed.execute?.workspaceHash,
        detail: `execute=${String(executed.execute?.workspaceHash ?? "")}, replay=${replayed.workspaceHash}`,
      });
    } finally {
      fs.rmSync(replayFidelityRoot, { recursive: true, force: true });
    }

    const rollbackFidelityRoot = makeTempRoot();
    try {
      const preHash = CanonicalWorkspaceHasher.capture(rollbackFidelityRoot).snapshotHash;
      let failedStage = "";
      let errorMessage = "";

      await withTemporaryEnv({ CHOIR_TEST_ROLLBACK: "1" }, async () => {
        try {
          await runMode("execute", rollbackFidelityRoot);
        } catch (error) {
          if (error instanceof OrchestrationPipelineError) {
            failedStage = error.failedStage;
            errorMessage = error.message;
          }
        }
      });

      const postHash = CanonicalWorkspaceHasher.capture(rollbackFidelityRoot).snapshotHash;

      checks.push({
        name: "rollback-recovery-restores-workspace-byte-for-byte",
        passed: failedStage === "execution"
          && /rollback=applied/.test(errorMessage)
          && preHash === postHash,
        detail: `failedStage=${failedStage || "none"}, pre=${preHash}, post=${postHash}`,
      });
    } finally {
      fs.rmSync(rollbackFidelityRoot, { recursive: true, force: true });
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
