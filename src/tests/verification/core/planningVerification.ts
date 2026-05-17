import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import * as YAML from "yaml";
import { ControlPlane, ControlPlaneSchema, Plan } from "../../../schema.js";
import { generateExecutionPreview } from "../../../core/executionPreview.js";
import {
  PlanOptimizationError,
  synthesizeAndOptimizePlans,
} from "../../../core/planOptimizationOrchestrator.js";
import { stableStringify } from "../../../core/deterministicCore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../..");

export type PlanningVerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type PlanningVerificationReport = {
  passed: boolean;
  checks: PlanningVerificationCheck[];
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

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "choir-planning-verify-"));
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

export async function runPlanningVerification(): Promise<PlanningVerificationReport> {
  const checks: PlanningVerificationCheck[] = [];

  const workspace = createFixtureWorkspace("simple-project");
  try {
    const control = loadControlPlane(workspace.root);
    control.execution.plans = [];

    const first = await synthesizeAndOptimizePlans({
      root: workspace.root,
      controlPlane: control,
      command: "choir plan --optimize",
    });

    const freshWorkspacePass = first.selectedPlan.synthesized
      && first.candidatePlans.length > 1
      && first.rankedPlans.length > 0
      && first.stageResults.every((stage) => stage.status === "success");

    checks.push({
      name: "fresh-workspace-plan-synthesis",
      passed: freshWorkspacePass,
      detail: freshWorkspacePass
        ? `selected ${first.selectedPlan.id} via ${first.selectedPlan.strategyType} from ${first.candidatePlans.length} candidates`
        : "planner did not synthesize optimized plans in fresh workspace",
    });

    const fingerprints: string[] = [];
    for (let run = 0; run < 10; run += 1) {
      const optimized = await synthesizeAndOptimizePlans({
        root: workspace.root,
        controlPlane: control,
        command: "choir plan --optimize",
      });

      fingerprints.push(stableStringify({
        selectedPlanId: optimized.selectedPlan.id,
        strategyType: optimized.selectedPlan.strategyType,
        planHash: optimized.planHash,
        simulationHash: optimized.simulationHash,
        orchestrationDagHash: optimized.orchestrationDagHash,
        rankingOrder: optimized.rankedPlans.map((plan) => plan.id),
        executionStages: optimized.executionStages,
        rollbackScope: optimized.rollbackScope,
      }));
    }

    const deterministicPass = fingerprints.every((entry) => entry === fingerprints[0]);
    checks.push({
      name: "planning-determinism-10x",
      passed: deterministicPass,
      detail: deterministicPass
        ? "selected plan, hashes, and execution stages were stable across 10 runs"
        : "planning output diverged across repeated runs",
    });

    const dagDeterministicPass = first.rankedPlans.every((plan) => plan.orchestrationGraph.hash.length > 0)
      && first.orchestrationDagHash === first.selectedPlan.orchestrationGraph.hash;
    checks.push({
      name: "planning-orchestration-dag-determinism",
      passed: dagDeterministicPass,
      detail: dagDeterministicPass
        ? `selected DAG hash ${first.orchestrationDagHash}`
        : "orchestration DAG hashes were not stable or missing",
    });

    const replay = await synthesizeAndOptimizePlans({
      root: workspace.root,
      controlPlane: control,
      command: "choir plan --optimize",
      replayTraceId: first.trace.id,
    });

    const replayPass = replay.selectedPlan.id === first.selectedPlan.id
      && replay.rankedPlans.map((plan) => plan.id).join("|") === first.rankedPlans.map((plan) => plan.id).join("|")
      && replay.stageResults.some((stage) => stage.stage === "replay-verification" && stage.status === "success");
    checks.push({
      name: "planning-replay-selection",
      passed: replayPass,
      detail: replayPass
        ? `replay preserved selected strategy ${replay.selectedPlan.strategyType}`
        : "replay failed to reproduce candidate ranking/selection",
    });

    const executionControl = mergeExecutionPlan(control, first.selectedExecutionPlan);
    const preview = await generateExecutionPreview(first.selectedExecutionPlan, {
      root: workspace.root,
      controlPlane: executionControl,
    });

    const simulationParityPass = preview.hash === first.simulationHash;
    checks.push({
      name: "planning-simulation-parity",
      passed: simulationParityPass,
      detail: simulationParityPass
        ? "planning simulation hash matched execution preview hash"
        : "planning simulation hash diverged from execution preview",
    });
  } finally {
    workspace.dispose();
  }

  const denyWorkspace = createFixtureWorkspace("simple-project");
  try {
    const control = loadControlPlane(denyWorkspace.root);
    control.execution.plans = [];

    writePoliciesDSL(denyWorkspace.root, [
      "policy deny-plan-synthesis {",
      "  when diff.path = \"execution.plans\" and diff.operation = add then deny",
      "}",
      "",
    ].join("\n"));

    let denied = false;
    try {
      await synthesizeAndOptimizePlans({
        root: denyWorkspace.root,
        controlPlane: control,
        command: "choir plan --optimize",
      });
    } catch (error) {
      if (error instanceof PlanOptimizationError) {
        denied = error.failedStage === "policy-evaluation";
      }
    }

    checks.push({
      name: "planning-policy-deny-enforcement",
      passed: denied,
      detail: denied
        ? "deny policy rejected synthesized planning candidates"
        : "deny policy did not block planning candidates",
    });
  } finally {
    denyWorkspace.dispose();
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

export function formatPlanningVerificationReport(report: PlanningVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} planning verification`,
    ...report.checks.map((check) => `- ${check.name}: ${check.passed ? "PASS" : "FAIL"} (${check.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((failure) => `- ${failure}`));
  }

  return lines.join("\n");
}
