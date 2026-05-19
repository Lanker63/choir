import fs from "fs";
import os from "os";
import path from "path";
import * as YAML from "yaml";
import { ControlPlane } from "../../../schema.js";
import { runCI } from "../../../core/ci.js";
import {
  runOrchestrationPipeline,
  OrchestrationPipelineError,
} from "../../../core/orchestrationRuntime.js";
import { readPipelineDiagnosticsRecords } from "../../../core/pipelineDiagnostics.js";
import { evaluateRuntimeGovernance } from "../../../core/runtimeGovernance.js";
import { approvePendingDiff, listPendingApprovals, upsertPendingPreviewApproval } from "../../../core/state.js";

export type RuntimeGovernanceVerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type RuntimeGovernanceVerificationReport = {
  passed: boolean;
  checks: RuntimeGovernanceVerificationCheck[];
  failures: string[];
};

function fixtureControlPlane(overrides?: Partial<ControlPlane>): ControlPlane {
  return {
    version: "1.0.0",
    mission: "runtime governance verification",
    vision: "deterministic governed orchestration",
    intent: {
      goals: ["verify runtime gating"],
      constraints: [],
      "nonGoals": [],
    },
    policy: {
      rules: [],
    },
    execution: {
      plans: [],
    },
    runtime: {
      mode: "execution-enabled",
    },
    ...(overrides ?? {}),
  };
}

function makeRoot(controlPlane: ControlPlane): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choir-runtime-governance-"));
  fs.mkdirSync(path.join(root, ".choir"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".choir", "choir.config.yaml"),
    YAML.stringify(controlPlane),
    "utf-8"
  );
  return root;
}

export async function runRuntimeGovernanceVerification(): Promise<RuntimeGovernanceVerificationReport> {
  const checks: RuntimeGovernanceVerificationCheck[] = [];

  const observeOnlyControl = fixtureControlPlane({
    runtime: {
      mode: "observe-only",
    },
  });

  const observeRoot = makeRoot(observeOnlyControl);
  try {
    let executeBlocked = false;
    let blockedStage = "";
    try {
      await runOrchestrationPipeline("execute", {
        root: observeRoot,
        controlPlane: observeOnlyControl,
        command: "choir execute",
      });
    } catch (error) {
      if (error instanceof OrchestrationPipelineError) {
        executeBlocked = error.failedStage === "runtime-governance";
        blockedStage = error.failedStage;
      }
    }

    checks.push({
      name: "execute-blocked-in-observe-only",
      passed: executeBlocked,
      detail: executeBlocked ? "execute blocked by runtime governance" : `blockedStage=${blockedStage || "none"}`,
    });

    const simulateResult = await runOrchestrationPipeline("simulate", {
      root: observeRoot,
      controlPlane: observeOnlyControl,
      command: "choir simulate",
    });

    checks.push({
      name: "simulate-allowed-in-observe-only",
      passed: Boolean(simulateResult.simulate),
      detail: `mode=${simulateResult.mode}, trace=${simulateResult.trace.id}`,
    });

    const installGate = evaluateRuntimeGovernance({
      controlPlane: observeOnlyControl,
      capability: "install",
    });

    checks.push({
      name: "install-blocked-correctly",
      passed: installGate.decision === "deny" && installGate.reason === "capability-disabled",
      detail: `decision=${installGate.decision}, reason=${installGate.reason}`,
    });

    const diagnostics = readPipelineDiagnosticsRecords(observeRoot, { limit: 20 });
    const hasRuntimeGovernanceMetadata = diagnostics.some((entry) =>
      Boolean((entry.metadata as Record<string, unknown> | undefined)?.runtimeGovernance)
    );

    checks.push({
      name: "diagnostics-expose-governance-state",
      passed: hasRuntimeGovernanceMetadata,
      detail: `records=${diagnostics.length}`,
    });
  } finally {
    fs.rmSync(observeRoot, { recursive: true, force: true });
  }

  const approvalControl = fixtureControlPlane({
    runtime: {
      mode: "approval-required",
    },
  });
  const approvalRoot = makeRoot(approvalControl);
  try {
    const preview = await runOrchestrationPipeline("preview", {
      root: approvalRoot,
      controlPlane: approvalControl,
      command: "choir preview",
    });

    const pendingBefore = listPendingApprovals(approvalRoot);
    const previewPendingId = preview.approval.pendingId;

    let blockedWithoutApproval = false;
    let blockedDetail = "";
    try {
      await runOrchestrationPipeline("execute", {
        root: approvalRoot,
        controlPlane: approvalControl,
        command: "choir execute",
        requestedPlanId: preview.selectedPlanId,
      });
    } catch (error) {
      blockedWithoutApproval = error instanceof OrchestrationPipelineError && error.failedStage === "approval";
      blockedDetail = error instanceof Error ? error.message : String(error);
    }

    const pendingAfterBlockedExecute = listPendingApprovals(approvalRoot);
    const blockedExecuteCreatedPending = pendingAfterBlockedExecute.length > 0;

    if (previewPendingId) {
      approvePendingDiff(approvalRoot, previewPendingId, "runtime-governance-verifier", new Date().toISOString());
    }

    const pendingAfterBlock = listPendingApprovals(approvalRoot);
    for (const pending of [...pendingBefore, ...pendingAfterBlock]) {
      approvePendingDiff(approvalRoot, pending.id, "runtime-governance-verifier", new Date().toISOString());
    }

    const blockedHashMatch = /previewHash=([a-f0-9]{64})/i.exec(blockedDetail);
    if (blockedHashMatch) {
      const pending = upsertPendingPreviewApproval(approvalRoot, blockedHashMatch[1] as string, "choir execute");
      approvePendingDiff(approvalRoot, pending.pendingId, "runtime-governance-verifier", new Date().toISOString());
    }

    let approvedExecutionSucceeded = false;
    let approvedExecutionDetail = "";
    try {
      const executed = await runOrchestrationPipeline("execute", {
        root: approvalRoot,
        controlPlane: approvalControl,
        command: "choir execute",
        requestedPlanId: preview.selectedPlanId,
        requestedPreviewRef: preview.preview?.previewHash,
      });
      approvedExecutionSucceeded = Boolean(executed.execute?.success);
      approvedExecutionDetail = executed.execute?.transactionId ?? "executed";
    } catch (error) {
      approvedExecutionSucceeded = false;
      approvedExecutionDetail = error instanceof Error ? error.message : String(error);
    }

    checks.push({
      name: "approvals-enforced",
      passed: blockedWithoutApproval && approvedExecutionSucceeded,
      detail: `blockedWithoutApproval=${blockedWithoutApproval}, approvedExecutionSucceeded=${approvedExecutionSucceeded}, detail=${approvedExecutionDetail}`,
    });

    checks.push({
      name: "blocked-execute-creates-pending-approval",
      passed: blockedExecuteCreatedPending,
      detail: `blockedExecuteCreatedPending=${blockedExecuteCreatedPending}, pendingCount=${pendingAfterBlockedExecute.length}`,
    });

    const secondPreview = await runOrchestrationPipeline("preview", {
      root: approvalRoot,
      controlPlane: approvalControl,
      command: "choir preview",
      requestedPlanId: preview.selectedPlanId,
    });

    let blockedAfterFreshPreview = false;
    try {
      await runOrchestrationPipeline("execute", {
        root: approvalRoot,
        controlPlane: approvalControl,
        command: "choir execute",
        requestedPlanId: secondPreview.selectedPlanId,
        requestedPreviewRef: secondPreview.preview?.previewHash,
      });
    } catch (error) {
      blockedAfterFreshPreview = error instanceof OrchestrationPipelineError && error.failedStage === "approval";
    }

    checks.push({
      name: "fresh-preview-requires-fresh-approval",
      passed: blockedAfterFreshPreview,
      detail: `blockedAfterFreshPreview=${blockedAfterFreshPreview}`,
    });
  } finally {
    fs.rmSync(approvalRoot, { recursive: true, force: true });
  }

  const deterministicControl = fixtureControlPlane({
    runtime: {
      mode: "simulation-only",
    },
  });
  const deterministicRoot = makeRoot(deterministicControl);
  try {
    const first = await runOrchestrationPipeline("simulate", {
      root: deterministicRoot,
      controlPlane: deterministicControl,
      command: "choir simulate",
    });
    const second = await runOrchestrationPipeline("simulate", {
      root: deterministicRoot,
      controlPlane: deterministicControl,
      command: "choir simulate",
    });

    const firstGovernanceHash = String((first.trace.modeMetadata as Record<string, unknown> | undefined)?.runtimeGovernance
      ? ((first.trace.modeMetadata as Record<string, unknown>).runtimeGovernance as Record<string, unknown>).governanceHash
      : "");
    const secondGovernanceHash = String((second.trace.modeMetadata as Record<string, unknown> | undefined)?.runtimeGovernance
      ? ((second.trace.modeMetadata as Record<string, unknown>).runtimeGovernance as Record<string, unknown>).governanceHash
      : "");

    checks.push({
      name: "runtime-gates-replay-deterministically",
      passed: first.replayVerification.runtimeGovernance
        && second.replayVerification.runtimeGovernance
        && firstGovernanceHash.length > 0
        && firstGovernanceHash === secondGovernanceHash,
      detail: `first=${firstGovernanceHash.slice(0, 12)}, second=${secondGovernanceHash.slice(0, 12)}`,
    });
  } finally {
    fs.rmSync(deterministicRoot, { recursive: true, force: true });
  }

  const ciControl = fixtureControlPlane({
    runtime: {
      mode: "simulation-only",
    },
  });
  const ciRoot = makeRoot(ciControl);
  try {
    const previousCI = process.env.CI;
    process.env.CI = "true";

    let ciResult;
    try {
      ciResult = await runCI({
        root: ciRoot,
        controlPlane: ciControl,
        controlPath: path.join(ciRoot, ".choir", "choir.config.yaml"),
        context: {
          role: "conductor",
          environment: "ci",
        },
        actorId: "runtime-governance-verifier",
      });
    } finally {
      if (previousCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCI;
      }
    }

    const executeFailedByGovernance = ciResult.stageResults.some((entry) =>
      entry.stage === "execute"
      && entry.status === "failure"
      && entry.detail.includes("runtime-governance")
    );

    checks.push({
      name: "ci-honors-runtime-gating",
      passed: executeFailedByGovernance,
      detail: ciResult.stageResults.map((entry) => `${entry.stage}:${entry.status}`).join(","),
    });
  } finally {
    fs.rmSync(ciRoot, { recursive: true, force: true });
  }

  const packageModeGate = evaluateRuntimeGovernance({
    controlPlane: fixtureControlPlane({
      packageModes: {
        payments: {
          mode: "approval-required",
        },
        playground: {
          mode: "execution-enabled",
        },
      },
    }),
    capability: "execute",
    packageNames: ["payments", "playground"],
  });

  checks.push({
    name: "package-level-modes-operational",
    passed: packageModeGate.decision === "require-approval"
      && packageModeGate.packageDecisions.some((entry) => entry.packageName === "payments" && entry.decision === "require-approval")
      && packageModeGate.packageDecisions.some((entry) => entry.packageName === "playground" && entry.decision === "allow"),
    detail: packageModeGate.packageDecisions
      .map((entry) => `${entry.packageName}:${entry.mode}:${entry.decision}`)
      .join(","),
  });

  const failures = checks
    .filter((entry) => !entry.passed)
    .map((entry) => `${entry.name}: ${entry.detail}`);

  return {
    passed: failures.length === 0,
    checks,
    failures,
  };
}

export function formatRuntimeGovernanceVerificationReport(report: RuntimeGovernanceVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} runtime governance verification`,
    ...report.checks.map((entry) => `- ${entry.name}: ${entry.passed ? "PASS" : "FAIL"} (${entry.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((entry) => `- ${entry}`));
  }

  return lines.join("\n");
}
