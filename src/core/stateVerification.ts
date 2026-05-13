import fs from "fs";
import os from "os";
import path from "path";
import { deterministicHash } from "./deterministicCore.js";
import {
  executeTransaction,
  type ExecuteGlobalPlanOptions,
  type GlobalPlan,
  type Repo,
} from "./globalOrchestration.js";
import {
  buildStateTimeline,
  createEmptyStatePlane,
  listSnapshots,
} from "./state.js";
import {
  loadAuditRecords,
  loadSnapshots,
  loadTransitionRecords,
  recoverState,
  replayFromLogs,
  replayTo,
  rollbackTo,
  validateAuditChain,
  verifyReplayConsistency,
} from "./persistentStateAudit.js";

export type StateVerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type StateVerificationReport = {
  passed: boolean;
  checks: StateVerificationCheck[];
  failures: string[];
};

function fixturePlan(): GlobalPlan {
  return {
    id: "verify-state-plan",
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

function fixtureRepos(): Repo[] {
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

function options(root: string): ExecuteGlobalPlanOptions {
  return {
    repos: fixtureRepos(),
    policies: [],
    stateRoot: root,
    executeTask: async (task, state) => {
      if (task.repoId === "repo-a") {
        return { ...state, meta: { value: "1" } };
      }

      return { ...state, meta: { value: "2" } };
    },
  };
}

export async function runStateVerification(): Promise<StateVerificationReport> {
  const checks: StateVerificationCheck[] = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choir-state-verify-"));

  try {
    const plan = fixturePlan();
    const execution = await executeTransaction(plan, options(root), "execution");

    const replayed = replayFromLogs(root);
    checks.push({
      name: "replay-reconstructs-current-state",
      passed: execution.success && deterministicHash(replayed) === deterministicHash(execution.finalState),
      detail: execution.success
        ? "replayFromLogs hash matched committed final state hash"
        : "execution did not commit, cannot validate replay",
    });

    const transitions = loadTransitionRecords(root);
    const ordered = transitions.every((entry, index) => entry.logicalTime === index + 1);
    checks.push({
      name: "transitions-are-complete-and-ordered",
      passed: transitions.length > 0 && ordered,
      detail: ordered
        ? `recorded ${transitions.length} ordered transitions`
        : "transition logicalTime sequence has gaps",
    });

    const snapshots = loadSnapshots(root);
    const latestSnapshot = snapshots[snapshots.length - 1];
    const rollbackState = latestSnapshot ? rollbackTo(root, latestSnapshot.id) : {};
    const replayAtSnapshot = latestSnapshot ? replayTo(root, latestSnapshot.logicalTime) : {};
    checks.push({
      name: "snapshot-restore-is-exact",
      passed: !!latestSnapshot && deterministicHash(rollbackState) === deterministicHash(replayAtSnapshot),
      detail: latestSnapshot
        ? "rollbackTo(snapshot) matched replayTo(snapshot.logicalTime)"
        : "no snapshot recorded",
    });

    const audit = loadAuditRecords(root);
    validateAuditChain(audit);
    checks.push({
      name: "audit-chain-valid",
      passed: audit.length > 0,
      detail: audit.length > 0 ? `validated ${audit.length} audit records` : "no audit records found",
    });

    const auditFile = path.join(root, ".choir", "state.audit.jsonl");
    const originalAudit = fs.readFileSync(auditFile, "utf-8");
    const trimmed = originalAudit.trim();
    const lines = trimmed.length > 0 ? trimmed.split(/\r?\n/) : [];
    if (lines.length > 0) {
      const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
      first.payloadHash = "tampered";
      lines[0] = JSON.stringify(first);
      fs.writeFileSync(auditFile, `${lines.join("\n")}\n`, "utf-8");
    }

    let tamperDetected = false;
    try {
      verifyReplayConsistency(root);
    } catch {
      tamperDetected = true;
    }

    fs.writeFileSync(auditFile, originalAudit, "utf-8");

    checks.push({
      name: "audit-tamper-detected",
      passed: tamperDetected,
      detail: tamperDetected ? "audit chain validation failed after tamper" : "tamper was not detected",
    });

    const recovered = recoverState(root);
    checks.push({
      name: "crash-recovery-restores-state",
      passed: deterministicHash(recovered) === deterministicHash(execution.finalState),
      detail: "recoverState replayed logs to committed state",
    });

    // Append a malformed snapshot payload to ensure replay listing remains resilient
    // when historical records contain unexpected ast shapes.
    const malformedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "choir-state-verify-malformed-"));
    let malformedReplayHandled = false;
    try {
      const snapshotsPath = path.join(malformedRoot, ".choir", "state.snapshots.jsonl");
      fs.mkdirSync(path.dirname(snapshotsPath), { recursive: true });

      const baselineState = createEmptyStatePlane();
      const malformedSnapshot = {
        id: "malformed-snapshot",
        timestamp: new Date().toISOString(),
        hash: "malformed-snapshot-hash",
        state: {
          ...baselineState,
          ast: { broken: true },
        },
      };
      fs.appendFileSync(snapshotsPath, `${JSON.stringify(malformedSnapshot)}\n`, "utf-8");

      void listSnapshots(malformedRoot);
      void buildStateTimeline(malformedRoot);
      malformedReplayHandled = true;
    } catch {
      malformedReplayHandled = false;
    } finally {
      fs.rmSync(malformedRoot, { recursive: true, force: true });
    }

    checks.push({
      name: "malformed-snapshot-does-not-break-replay",
      passed: malformedReplayHandled,
      detail: malformedReplayHandled
        ? "listSnapshots/buildStateTimeline tolerated malformed ast payload"
        : "malformed snapshot caused replay listing to fail",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const failures = checks.filter((entry) => !entry.passed).map((entry) => `${entry.name}: ${entry.detail}`);
  return {
    passed: failures.length === 0,
    checks,
    failures,
  };
}

export function formatStateVerificationReport(report: StateVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} state verification`,
    ...report.checks.map((entry) => `- ${entry.name}: ${entry.passed ? "PASS" : "FAIL"} (${entry.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((entry) => `- ${entry}`));
  }

  return lines.join("\n");
}
