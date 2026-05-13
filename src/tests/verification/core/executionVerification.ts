import fs from "fs";
import os from "os";
import path from "path";
import { ControlPlane } from "../../../schema.js";
import {
  executeGlobalPlan,
  hashState as hashGlobalState,
  type CompiledPolicy,
  type ExecuteGlobalPlanOptions,
  type GlobalPlan,
  type Repo,
} from "../../../core/globalOrchestration.js";
import {
  ExecutionOrchestrationError,
  runExecutionOrchestrator,
} from "../../../core/executionOrchestrator.js";

export type ExecutionVerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type ExecutionVerificationReport = {
  passed: boolean;
  checks: ExecutionVerificationCheck[];
  failures: string[];
};

function fixtureControlPlane(): ControlPlane {
  return {
    version: "1.0.0",
    mission: "autonomous execution verification",
    vision: "deterministic transaction-safe runtime",
    intent: {
      goals: ["execute from intent"],
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

function rollbackFixturePlan(): GlobalPlan {
  return {
    id: "verify-execution-rollback",
    tasks: [
      {
        id: "repo-a:t1",
        repoId: "repo-a",
        action: "set:meta.value=1",
        dependsOn: [],
      },
      {
        id: "repo-b:t1",
        repoId: "repo-b",
        action: "set:meta.value=2",
        dependsOn: ["repo-a:t1"],
      },
    ],
  };
}

function rollbackFixtureRepos(): Repo[] {
  return [
    {
      id: "repo-a",
      dependencies: [],
      state: { meta: { value: "0" } },
    },
    {
      id: "repo-b",
      dependencies: ["repo-a"],
      state: { meta: { value: "0" } },
    },
  ];
}

function rollbackFixtureOptions(root: string): ExecuteGlobalPlanOptions {
  return {
    repos: rollbackFixtureRepos(),
    policies: [],
    stateRoot: root,
    executeTask: async (task, state, _repoId, _allStates, mode) => {
      if (mode === "execution" && task.repoId === "repo-b") {
        throw new Error("forced-rollback");
      }

      return { ...state, meta: { value: "1" } };
    },
  };
}

function denyAllExecutionPolicy(): CompiledPolicy[] {
  return [
    {
      id: "verify-unified-deny-all",
      source: "org",
      rules: [
        {
          id: "verify-unified-deny-all-actions",
          kind: "deny-action-prefix",
          effect: "deny",
          actionPrefix: "",
          priority: 100,
        },
      ],
    },
  ];
}

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "choir-execution-verify-"));
}

export async function runExecutionVerification(): Promise<ExecutionVerificationReport> {
  const checks: ExecutionVerificationCheck[] = [];

  const freshRoot = makeTempRoot();
  try {
    const control = fixtureControlPlane();
    const executed = await runExecutionOrchestrator({
      root: freshRoot,
      controlPlane: control,
      command: "choir execute",
    });

    checks.push({
      name: "fresh-workspace-execution-synthesizes-plan",
      passed: executed.success && executed.planSource === "synthesized",
      detail: `plan=${executed.planId}, source=${executed.planSource}`,
    });

    checks.push({
      name: "simulation-parity-hash-matches-execution",
      passed: executed.simulationFutureStateHash === executed.finalStateHash,
      detail: `simulation=${executed.simulationFutureStateHash.slice(0, 12)}, execution=${executed.finalStateHash.slice(0, 12)}`,
    });

    checks.push({
      name: "replay-hash-matches-execution",
      passed: executed.replayHash === executed.finalStateHash && executed.verified,
      detail: `replay=${executed.replayHash.slice(0, 12)}, final=${executed.finalStateHash.slice(0, 12)}`,
    });

    let blockedInvalidIntent = false;
    try {
      await runExecutionOrchestrator({
        root: freshRoot,
        controlPlane: control,
        command: "choir execute plan missing-plan",
        requestedPlanId: "missing-plan",
      });
    } catch (error) {
      blockedInvalidIntent = error instanceof ExecutionOrchestrationError;
    }

    checks.push({
      name: "invalid-intent-blocks-execution",
      passed: blockedInvalidIntent,
      detail: blockedInvalidIntent ? "missing explicit plan target was blocked" : "missing explicit plan target was not blocked",
    });

    let blockedByExecutionPolicy = false;
    let blockedStage = "";
    try {
      await runExecutionOrchestrator({
        root: freshRoot,
        controlPlane: control,
        command: "choir execute",
        executionPolicies: denyAllExecutionPolicy(),
      });
    } catch (error) {
      if (error instanceof ExecutionOrchestrationError) {
        blockedByExecutionPolicy = error.failedStage === "policy-enforcement";
        blockedStage = error.failedStage;
      }
    }

    checks.push({
      name: "unified-execution-propagates-deny-policy",
      passed: blockedByExecutionPolicy,
      detail: blockedByExecutionPolicy
        ? "execution policy denied before transaction execution"
        : `execution policy was not enforced (stage=${blockedStage || "none"})`,
    });
  } finally {
    fs.rmSync(freshRoot, { recursive: true, force: true });
  }

  const determinismFingerprints: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const runRoot = makeTempRoot();
    try {
      const result = await runExecutionOrchestrator({
        root: runRoot,
        controlPlane: fixtureControlPlane(),
        command: "choir execute",
      });

      determinismFingerprints.push(JSON.stringify({
        planId: result.planId,
        strategyId: result.strategyId,
        executionHash: result.executionHash,
        finalStateHash: result.finalStateHash,
        replayHash: result.replayHash,
        executionStages: result.executionStages,
      }));
    } finally {
      fs.rmSync(runRoot, { recursive: true, force: true });
    }
  }

  const uniqueFingerprints = new Set(determinismFingerprints);
  checks.push({
    name: "execution-determinism-10x",
    passed: uniqueFingerprints.size === 1,
    detail: `runs=10, uniqueFingerprints=${uniqueFingerprints.size}`,
  });

  const rollbackRoot = makeTempRoot();
  try {
    const rollbackPlan = rollbackFixturePlan();
    const rollback = await executeGlobalPlan(rollbackPlan, rollbackFixtureOptions(rollbackRoot));

    const expectedRepoA = hashGlobalState({ "repo-a": { meta: { value: "1" } } });
    const expectedRepoB = hashGlobalState({ "repo-b": { meta: { value: "0" } } });
    const actualRepoA = hashGlobalState({ "repo-a": rollback.finalStates["repo-a"] });
    const actualRepoB = hashGlobalState({ "repo-b": rollback.finalStates["repo-b"] });

    checks.push({
      name: "rollback-restores-failed-scope-and-preserves-unrelated",
      passed: !rollback.success && rollback.rolledBack && actualRepoA === expectedRepoA && actualRepoB === expectedRepoB,
      detail: `rolledBack=${rollback.rolledBack}, repoA=${actualRepoA.slice(0, 12)}, repoB=${actualRepoB.slice(0, 12)}`,
    });
  } finally {
    fs.rmSync(rollbackRoot, { recursive: true, force: true });
  }

  const failures = checks.filter((entry) => !entry.passed).map((entry) => `${entry.name}: ${entry.detail}`);
  return {
    passed: failures.length === 0,
    checks,
    failures,
  };
}

export function formatExecutionVerificationReport(report: ExecutionVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} execution verification`,
    ...report.checks.map((entry) => `- ${entry.name}: ${entry.passed ? "PASS" : "FAIL"} (${entry.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((entry) => `- ${entry}`));
  }

  return lines.join("\n");
}
