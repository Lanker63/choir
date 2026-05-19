import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import * as YAML from "yaml";
import { ControlPlane, ControlPlaneSchema } from "../../../schema.js";
import {
  synthesizeAndOptimizePlans,
} from "../../../core/planOptimizationOrchestrator.js";
import { stableStringify } from "../../../core/deterministicCore.js";
import { evaluateRuntimeGovernance } from "../../../core/runtimeGovernance.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../..");

type StrategicIntentVerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type StrategicIntentVerificationReport = {
  passed: boolean;
  checks: StrategicIntentVerificationCheck[];
  failures: string[];
};

function fixturePath(name: string): string {
  return path.join(repoRoot, "test-fixtures", name);
}

function createFixtureWorkspace(fixtureName: string): { root: string; dispose: () => void } {
  const fixtureRoot = fixturePath(fixtureName);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "choir-strategic-verify-"));
  const target = path.join(tempRoot, fixtureName);
  fs.cpSync(fixtureRoot, target, { recursive: true });
  return {
    root: target,
    dispose: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
  };
}

function loadControlPlane(root: string): ControlPlane {
  const controlPath = path.join(root, ".choir", "choir.config.yaml");
  const raw = fs.readFileSync(controlPath, "utf-8");
  return ControlPlaneSchema.parse(YAML.parse(raw));
}

function withDomain(control: ControlPlane, domain: "payments" | "experimentation"): ControlPlane {
  if (domain === "payments") {
    return ControlPlaneSchema.parse({
      ...control,
      strategicIntent: {
        priorities: ["correctness", "rollback-safety"],
        optimizationGoals: ["deterministic-replay"],
        riskTolerance: "low",
        architecturalPosture: ["conservative", "highly-reviewed"],
        rolloutPreferences: ["canary-required"],
        stabilityProfile: "stable",
        governanceIntensity: "strict",
      },
      domains: {
        payments: {
          mission: "Ensure reliable financial processing",
          strategicIntent: {
            priorities: ["correctness", "auditability", "rollback-safety"],
            optimizationGoals: ["minimal-blast-radius", "deterministic-replay"],
            riskTolerance: "low",
            architecturalPosture: ["conservative", "highly-reviewed"],
            rolloutPreferences: ["canary-required"],
            stabilityProfile: "stable",
            governanceIntensity: "strict",
          },
        },
      },
      packages: {
        ".": {
          domain: "payments",
        },
      },
      contexts: {},
    });
  }

  return ControlPlaneSchema.parse({
    ...control,
    strategicIntent: {
      priorities: ["iteration-speed", "developer-autonomy"],
      optimizationGoals: ["rapid-delivery", "low-governance-friction"],
      riskTolerance: "high",
      architecturalPosture: ["exploratory", "adaptive"],
      rolloutPreferences: ["phased-optional", "parallel-optimized"],
      stabilityProfile: "adaptive",
      governanceIntensity: "relaxed",
    },
    domains: {
      experimentation: {
        mission: "Rapid feature incubation",
        strategicIntent: {
          priorities: ["iteration-speed", "developer-autonomy"],
          optimizationGoals: ["rapid-delivery", "low-governance-friction"],
          riskTolerance: "high",
          architecturalPosture: ["exploratory", "adaptive"],
          rolloutPreferences: ["phased-optional", "parallel-optimized"],
          stabilityProfile: "adaptive",
          governanceIntensity: "moderate",
        },
      },
    },
    packages: {
      ".": {
        domain: "experimentation",
      },
    },
    contexts: {},
  });
}

export async function runStrategicIntentVerification(): Promise<StrategicIntentVerificationReport> {
  const checks: StrategicIntentVerificationCheck[] = [];

  const paymentsWorkspace = createFixtureWorkspace("simple-project");
  try {
    const base = loadControlPlane(paymentsWorkspace.root);
    const payments = withDomain({ ...base, execution: { plans: [] } }, "payments");

    const optimized = await synthesizeAndOptimizePlans({
      root: paymentsWorkspace.root,
      command: "choir plan --optimize",
      controlPlane: payments,
    });

    const selected = optimized.rankedPlans.find((plan) => plan.id === optimized.selectedPlan.id);
    assert.ok(selected, "expected selected ranked plan");

    checks.push({
      name: "payments-domain-prefers-rollback-and-canary",
      passed: selected?.strategyType === "rollback-minimized"
        && selected.strategicRolloutBias.preferred === "canary"
        && selected.strategicGovernanceIntensity === "strict",
      detail: `selected=${selected?.strategyType} rollout=${selected?.strategicRolloutBias.preferred} governance=${selected?.strategicGovernanceIntensity}`,
    });

    const replay = await synthesizeAndOptimizePlans({
      root: paymentsWorkspace.root,
      command: "choir plan --optimize",
      controlPlane: payments,
      replayTraceId: optimized.trace.id,
    });

    const deterministic = stableStringify({
      selected: optimized.selectedPlan.id,
      ranking: optimized.rankedPlans.map((plan) => ({ id: plan.id, alignment: plan.strategicAlignment.score, hash: plan.strategicContextHash })),
    }) === stableStringify({
      selected: replay.selectedPlan.id,
      ranking: replay.rankedPlans.map((plan) => ({ id: plan.id, alignment: plan.strategicAlignment.score, hash: plan.strategicContextHash })),
    });

    checks.push({
      name: "strategic-replay-determinism",
      passed: deterministic,
      detail: deterministic ? "strategic ranking and context hashes remained stable" : "strategic replay diverged",
    });
  } finally {
    paymentsWorkspace.dispose();
  }

  const experimentationWorkspace = createFixtureWorkspace("simple-project");
  try {
    const base = loadControlPlane(experimentationWorkspace.root);
    const experimentation = withDomain({ ...base, execution: { plans: [] } }, "experimentation");

    const optimized = await synthesizeAndOptimizePlans({
      root: experimentationWorkspace.root,
      command: "choir plan --optimize",
      controlPlane: experimentation,
    });

    const selected = optimized.rankedPlans.find((plan) => plan.id === optimized.selectedPlan.id);

    checks.push({
      name: "experimentation-domain-prefers-parallel-and-relaxed-governance",
      passed: selected?.strategyType === "parallel-optimized"
        && selected.strategicRolloutBias.stageSizing === "fast"
        && (selected.strategicGovernanceIntensity === "moderate" || selected.strategicGovernanceIntensity === "relaxed"),
      detail: `selected=${selected?.strategyType} stageSizing=${selected?.strategicRolloutBias.stageSizing} governance=${selected?.strategicGovernanceIntensity}`,
    });
  } finally {
    experimentationWorkspace.dispose();
  }

  const ambiguityWorkspace = createFixtureWorkspace("simple-project");
  try {
    const base = loadControlPlane(ambiguityWorkspace.root);
    const packageScoped = ControlPlaneSchema.parse({
      ...base,
      strategicIntent: {
        priorities: ["correctness"],
        optimizationGoals: ["deterministic-replay"],
        riskTolerance: "moderate",
        architecturalPosture: ["adaptive"],
        rolloutPreferences: ["phased-optional"],
        stabilityProfile: "adaptive",
        governanceIntensity: "moderate",
      },
      domains: {
        payments: {
          strategicIntent: {
            priorities: ["correctness"],
            optimizationGoals: ["deterministic-replay"],
            riskTolerance: "low",
            architecturalPosture: ["conservative"],
            rolloutPreferences: ["canary-required"],
            stabilityProfile: "stable",
            governanceIntensity: "strict",
          },
        },
      },
      packages: {
        ".": {
          strategicIntent: {
            priorities: ["correctness", "auditability"],
            optimizationGoals: ["deterministic-replay"],
            riskTolerance: "low",
            architecturalPosture: ["conservative"],
            rolloutPreferences: ["canary-required"],
            stabilityProfile: "stable",
            governanceIntensity: "strict",
          },
        },
      },
      contexts: {},
      execution: { plans: [] },
    });

    let packageResolutionPassesWithoutDomain = false;
    try {
      const optimized = await synthesizeAndOptimizePlans({
        root: ambiguityWorkspace.root,
        command: "choir plan --optimize",
        controlPlane: packageScoped,
      });
      packageResolutionPassesWithoutDomain = optimized.selectedPlan.strategicContextHash.length > 0;
    } catch (error) {
      packageResolutionPassesWithoutDomain = false;
    }

    checks.push({
      name: "strategic-package-resolution-without-domain-field",
      passed: packageResolutionPassesWithoutDomain,
      detail: packageResolutionPassesWithoutDomain
        ? "package-level strategic intent resolves without package domain mapping"
        : "package-level strategic resolution failed when package domain mapping was absent",
    });
  } finally {
    ambiguityWorkspace.dispose();
  }

  const governanceDeny = evaluateRuntimeGovernance({
    controlPlane: ControlPlaneSchema.parse({
      version: "1.0.0",
      mission: "",
      vision: "",
      intent: { goals: [], constraints: [], "nonGoals": [] },
      strategicIntent: {
        priorities: ["correctness"],
        optimizationGoals: ["deterministic-replay"],
        riskTolerance: "low",
        architecturalPosture: ["conservative"],
        rolloutPreferences: ["canary-required"],
        stabilityProfile: "stable",
        governanceIntensity: "strict",
      },
      domains: {},
      packages: {},
      contexts: {},
      policy: { rules: [] },
      execution: { plans: [] },
      runtime: { mode: "execution-enabled" },
      capabilities: {
        preview: true,
        simulate: true,
        execute: false,
        optimize: true,
        import: true,
        install: true,
        update: true,
      },
    }),
    capability: "execute",
  });

  checks.push({
    name: "governance-deny-precedence-preserved",
    passed: governanceDeny.decision === "deny",
    detail: `decision=${governanceDeny.decision} reason=${governanceDeny.reason}`,
  });

  const failures = checks
    .filter((check) => !check.passed)
    .map((check) => `${check.name}: ${check.detail}`);

  return {
    passed: failures.length === 0,
    checks,
    failures,
  };
}

export function formatStrategicIntentVerificationReport(report: StrategicIntentVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} strategic-intent verification`,
    ...report.checks.map((check) => `- ${check.name}: ${check.passed ? "PASS" : "FAIL"} (${check.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((failure) => `- ${failure}`));
  }

  return lines.join("\n");
}
