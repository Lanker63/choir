import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import * as YAML from "yaml";
import { ControlPlane, ControlPlaneSchema, Plan } from "../schema.js";
import { generateExecutionPreview } from "./executionPreview.js";
import {
  synthesizePreviewContract,
  PreviewSynthesisContract,
} from "./previewOrchestrator.js";
import { approvePendingDiff } from "./state.js";
import { stableStringify } from "./deterministicCore.js";
import { controlPlaneToChoirConfig } from "./dslYamlCompiler.js";
import { hashDiff, computeDiff } from "./policyEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

export type PreviewVerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type PreviewVerificationReport = {
  passed: boolean;
  checks: PreviewVerificationCheck[];
  failures: string[];
};

function fixturePath(name: string): string {
  return path.join(repoRoot, "test-fixtures", name);
}

function loadControlPlane(root: string): ControlPlane {
  const controlPath = path.join(root, ".choir", "choir.config.yaml");
  const raw = fs.readFileSync(controlPath, "utf-8");
  return ControlPlaneSchema.parse(YAML.parse(raw));
}

function createFixtureWorkspace(fixtureName: string): { root: string; dispose: () => void } {
  const fixtureRoot = fixturePath(fixtureName);
  if (!fs.existsSync(fixtureRoot)) {
    throw new Error(`Fixture not found: ${fixtureName}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "choir-preview-verify-"));
  const target = path.join(tempRoot, fixtureName);
  fs.cpSync(fixtureRoot, target, { recursive: true });

  return {
    root: target,
    dispose: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
  };
}

function writePoliciesDSL(root: string, text: string): void {
  const policyPath = path.join(root, ".choir", "policies.dsl");
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, text, "utf-8");
}

function mergeExecutionPlan(control: ControlPlane, plan: Plan): ControlPlane {
  const approvedPlan: Plan = {
    ...plan,
    status: "approved",
  };

  return {
    ...control,
    execution: {
      ...control.execution,
      plans: [
        ...control.execution.plans.filter((entry) => entry.id !== approvedPlan.id),
        approvedPlan,
      ].sort((left, right) => left.id.localeCompare(right.id)),
    },
  };
}

function fingerprint(contract: PreviewSynthesisContract): string {
  return stableStringify({
    previewHash: contract.previewHash,
    simulationHash: contract.simulationHash,
    stateHash: contract.stateHash,
    planId: contract.planId,
    strategyId: contract.strategyId,
    planSource: contract.planSource,
    stageResults: contract.stageResults,
    executionStages: contract.executionStages,
  });
}

export async function runPreviewVerification(): Promise<PreviewVerificationReport> {
  const checks: PreviewVerificationCheck[] = [];

  const basicWorkspace = createFixtureWorkspace("simple-project");
  try {
    const control = loadControlPlane(basicWorkspace.root);
    const synthesized = await synthesizePreviewContract({
      root: basicWorkspace.root,
      controlPlane: control,
      command: "choir preview",
      persistPreviewState: false,
      recordPendingApproval: false,
    });

    const freshPassed = synthesized.planSource === "synthesized"
      && synthesized.planId === synthesized.basePlanId
      && synthesized.stageResults.every((stage) => stage.status === "success");

    checks.push({
      name: "fresh-workspace-preview-synthesis",
      passed: freshPassed,
      detail: freshPassed
        ? `generated synthesized plan ${synthesized.planId} with strategy ${synthesized.strategyId}`
        : "preview synthesis did not produce a successful synthesized contract",
    });

    const deterministicFingerprints: string[] = [];
    for (let run = 0; run < 10; run += 1) {
      const rerun = await synthesizePreviewContract({
        root: basicWorkspace.root,
        controlPlane: control,
        command: "choir preview",
        persistPreviewState: false,
        recordPendingApproval: false,
      });

      deterministicFingerprints.push(fingerprint(rerun));
    }

    const deterministicPass = deterministicFingerprints.every((entry) => entry === deterministicFingerprints[0]);
    checks.push({
      name: "preview-determinism-10x",
      passed: deterministicPass,
      detail: deterministicPass
        ? "preview contract hash, stages, and selection were stable across 10 runs"
        : "preview contract diverged across repeated runs",
    });

    const selectedExecutionControl = mergeExecutionPlan(control, synthesized.selectedPlan);
    const parityPreview = await generateExecutionPreview(synthesized.selectedPlan, {
      root: basicWorkspace.root,
      controlPlane: selectedExecutionControl,
    });

    const parityPass = parityPreview.hash === synthesized.previewHash
      && stableStringify(parityPreview.fileChanges) === stableStringify(synthesized.fileChanges);

    checks.push({
      name: "simulation-parity-with-preview-engine",
      passed: parityPass,
      detail: parityPass
        ? "synthesized contract matched canonical preview simulation output"
        : "synthesized contract diverged from canonical preview simulation output",
    });
  } finally {
    basicWorkspace.dispose();
  }

  const approvalWorkspace = createFixtureWorkspace("simple-project");
  try {
    const control = loadControlPlane(approvalWorkspace.root);
    writePoliciesDSL(approvalWorkspace.root, [
      "policy preview-approval {",
      "  when diff.path = \"execution.plans\" and diff.operation = add then require-approval",
      "}",
      "",
    ].join("\n"));

    const first = await synthesizePreviewContract({
      root: approvalWorkspace.root,
      controlPlane: control,
      command: "choir preview",
      persistPreviewState: false,
      recordPendingApproval: true,
    });

    const previewExecutionControl = mergeExecutionPlan(control, first.selectedPlan);
    const diffHash = hashDiff(computeDiff(
      controlPlaneToChoirConfig(control),
      controlPlaneToChoirConfig(previewExecutionControl)
    ));

    let approvalPass = first.policy.decision === "require-approval"
      && first.approval.required
      && !first.approval.approved
      && typeof first.approval.pendingId === "string"
      && first.policy.diffHash === diffHash;

    if (first.approval.pendingId) {
      approvePendingDiff(
        approvalWorkspace.root,
        first.approval.pendingId,
        "preview-verification",
        new Date(0).toISOString()
      );

      const second = await synthesizePreviewContract({
        root: approvalWorkspace.root,
        controlPlane: control,
        command: "choir preview",
        persistPreviewState: false,
        recordPendingApproval: true,
      });

      approvalPass = approvalPass
        && second.approval.required
        && second.approval.approved
        && second.previewHash === first.previewHash;
    } else {
      approvalPass = false;
    }

    checks.push({
      name: "approval-hash-binding",
      passed: approvalPass,
      detail: approvalPass
        ? "require-approval policy bound execution gate to preview hash until explicit approval"
        : "approval gate was not bound deterministically to synthesized preview hash",
    });
  } finally {
    approvalWorkspace.dispose();
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

export function formatPreviewVerificationReport(report: PreviewVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} preview verification`,
    ...report.checks.map((check) => `- ${check.name}: ${check.passed ? "PASS" : "FAIL"} (${check.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((failure) => `- ${failure}`));
  }

  return lines.join("\n");
}
