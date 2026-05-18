import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { stableStringify } from "../../../core/deterministicCore.js";
import { ControlPlaneSchema } from "../../../schema.js";
import {
  calibrateStrategicOrchestration,
  discoverStrategicDomains,
  seedStrategicDomainPromptDefaults,
  synthesizeStrategicControlPlane,
  type StrategicDomainModel,
} from "../../../core/strategicInit.js";

type InitVerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type InitVerificationReport = {
  passed: boolean;
  checks: InitVerificationCheck[];
  failures: string[];
};

function createStrategicFixtureWorkspace(): { root: string; dispose: () => void } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "choir-init-verify-"));
  const root = path.join(tempRoot, "workspace");

  fs.mkdirSync(path.join(root, "apps", "payments-api"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps", "experimentation-web"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages", "auth-core"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages", "platform-core"), { recursive: true });
  fs.mkdirSync(path.join(root, ".choir"), { recursive: true });

  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "strategic-workspace",
    private: true,
    workspaces: ["apps/*", "packages/*"],
  }, null, 2));

  fs.writeFileSync(path.join(root, "apps", "payments-api", "package.json"), JSON.stringify({
    name: "@acme/payments-api",
    dependencies: {
      "@acme/auth-core": "workspace:*",
      "@acme/platform-core": "workspace:*",
    },
  }, null, 2));

  fs.writeFileSync(path.join(root, "apps", "experimentation-web", "package.json"), JSON.stringify({
    name: "@acme/experimentation-web",
    dependencies: {
      "@acme/platform-core": "workspace:*",
    },
  }, null, 2));

  fs.writeFileSync(path.join(root, "packages", "auth-core", "package.json"), JSON.stringify({
    name: "@acme/auth-core",
    dependencies: {
      "@acme/platform-core": "workspace:*",
    },
  }, null, 2));

  fs.writeFileSync(path.join(root, "packages", "platform-core", "package.json"), JSON.stringify({
    name: "@acme/platform-core",
  }, null, 2));

  return {
    root,
    dispose: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
  };
}

function toModels(discovery: ReturnType<typeof discoverStrategicDomains>): StrategicDomainModel[] {
  return discovery.domains.map((domain) => ({
    id: domain.id,
    mission: `Owns ${domain.id}`,
    priorities: [...domain.inferred.priorities],
    optimizationGoals: [...domain.inferred.optimizationGoals],
    riskTolerance: domain.inferred.riskTolerance,
    rolloutPreferences: [...domain.inferred.rolloutPreferences],
    stabilityProfile: domain.inferred.stabilityProfile,
    governanceIntensity: domain.inferred.governanceIntensity,
  }));
}

export async function runInitVerification(): Promise<InitVerificationReport> {
  const checks: InitVerificationCheck[] = [];
  const fixture = createStrategicFixtureWorkspace();

  try {
    const firstDiscovery = discoverStrategicDomains(fixture.root, "fintech-platform");
    const secondDiscovery = discoverStrategicDomains(fixture.root, "fintech-platform");

    const deterministicDiscovery = stableStringify(firstDiscovery) === stableStringify(secondDiscovery);
    checks.push({
      name: "workspace-discovery-deterministic",
      passed: deterministicDiscovery,
      detail: deterministicDiscovery
        ? `packages=${firstDiscovery.packages.length} domains=${firstDiscovery.domains.length}`
        : "discovery output changed between identical runs",
    });

    const models = toModels(firstDiscovery);
    const calibrationA = calibrateStrategicOrchestration(firstDiscovery, models);
    const calibrationB = calibrateStrategicOrchestration(firstDiscovery, models);
    const deterministicCalibration = stableStringify(calibrationA) === stableStringify(calibrationB);
    checks.push({
      name: "orchestration-calibration-deterministic",
      passed: deterministicCalibration,
      detail: deterministicCalibration
        ? `strategy=${calibrationA.selectedStrategyType} rollout=${calibrationA.rolloutDefault}`
        : "calibration output changed between identical runs",
    });

    const control = ControlPlaneSchema.parse({
      version: "1.0.0",
      mission: "",
      vision: "",
      intent: {
        goals: [],
        constraints: [],
        "non-goals": [],
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
      strategicIntent: {
        priorities: [],
        optimizationGoals: [],
        riskTolerance: "moderate",
        architecturalPosture: [],
        rolloutPreferences: [],
        stabilityProfile: "adaptive",
        governanceIntensity: "moderate",
      },
      domains: {},
      packages: {},
      contexts: {},
    });
    const synthA = synthesizeStrategicControlPlane(control, {
      mode: "full",
      mission: "Mission",
      vision: "Vision",
      runtimeMode: calibrationA.governanceModeRecommendation,
      discovery: firstDiscovery,
      models,
      calibration: calibrationA,
    });

    const synthB = synthesizeStrategicControlPlane(control, {
      mode: "full",
      mission: "Mission",
      vision: "Vision",
      runtimeMode: calibrationA.governanceModeRecommendation,
      discovery: firstDiscovery,
      models,
      calibration: calibrationA,
    });

    const deterministicSynthesis = stableStringify(synthA.controlPlane) === stableStringify(synthB.controlPlane);
    checks.push({
      name: "control-plane-generation-stable",
      passed: deterministicSynthesis,
      detail: deterministicSynthesis
        ? `topologyHash=${synthA.report.topologyHash} strategicHash=${synthA.report.strategicHash}`
        : "generated control plane changed between identical runs",
    });

    const packageMappings = synthA.controlPlane.packages ?? {};
    const sortedMappings = Object.keys(packageMappings).sort((left, right) => left.localeCompare(right));
    const mappingDeterministic = stableStringify(sortedMappings) === stableStringify(Object.keys(packageMappings));
    checks.push({
      name: "package-domain-mapping-deterministic",
      passed: mappingDeterministic,
      detail: mappingDeterministic
        ? `mappedPackages=${sortedMappings.length}`
        : "package/domain mapping order is not deterministic",
    });

    const runtimeMode = synthA.controlPlane.runtime?.mode ?? "execution-enabled";
    const coherentGovernance = runtimeMode === calibrationA.governanceModeRecommendation;
    checks.push({
      name: "governance-initialization-coherent",
      passed: coherentGovernance,
      detail: coherentGovernance
        ? `runtime=${runtimeMode}`
        : `runtime=${runtimeMode} expected=${calibrationA.governanceModeRecommendation}`,
    });

    const domainForPrompt = firstDiscovery.domains[0];
    assert.ok(domainForPrompt, "expected at least one discovered domain for prompt defaults test");

    if (domainForPrompt) {
      const fallbackDefaults = seedStrategicDomainPromptDefaults(domainForPrompt, control);
      checks.push({
        name: "domain-prompt-defaults-fallback-deterministic",
        passed: fallbackDefaults.mission === `Owns ${domainForPrompt.id} outcomes across ${domainForPrompt.packages.length} package(s).`
          && stableStringify(fallbackDefaults.priorities) === stableStringify([...domainForPrompt.inferred.priorities].sort((a, b) => a.localeCompare(b)))
          && fallbackDefaults.riskTolerance === domainForPrompt.inferred.riskTolerance,
        detail: `domain=${domainForPrompt.id}`,
      });

      const customizedControl = ControlPlaneSchema.parse({
        ...control,
        domains: {
          ...(control.domains ?? {}),
          [domainForPrompt.id]: {
            mission: "Existing domain mission",
            strategicIntent: {
              priorities: ["stability", "correctness"],
              optimizationGoals: ["dependency-isolation"],
              riskTolerance: "low",
              rolloutPreferences: ["canary-required"],
              stabilityProfile: "stable",
              governanceIntensity: "strict",
            },
          },
        },
      });

      const seededDefaults = seedStrategicDomainPromptDefaults(domainForPrompt, customizedControl);
      checks.push({
        name: "domain-prompt-defaults-seeded-from-control-plane",
        passed: seededDefaults.mission === "Existing domain mission"
          && stableStringify(seededDefaults.priorities) === stableStringify(["correctness", "stability"])
          && stableStringify(seededDefaults.optimizationGoals) === stableStringify(["dependency-isolation"])
          && seededDefaults.riskTolerance === "low"
          && stableStringify(seededDefaults.rolloutPreferences) === stableStringify(["canary-required"])
          && seededDefaults.stabilityProfile === "stable"
          && seededDefaults.governanceIntensity === "strict",
        detail: `domain=${domainForPrompt.id}`,
      });
    }

    assert.ok(firstDiscovery.domains.length > 0, "expected discovered strategic domains");
    assert.ok(Object.keys(synthA.controlPlane.domains ?? {}).length > 0, "expected modeled domains");
  } finally {
    fixture.dispose();
  }

  const failures = checks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.detail}`);
  return {
    passed: failures.length === 0,
    checks,
    failures,
  };
}

export function formatInitVerificationReport(report: InitVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} init verification`,
    ...report.checks.map((check) => `- ${check.name}: ${check.passed ? "PASS" : "FAIL"} (${check.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((failure) => `- ${failure}`));
  }

  return lines.join("\n");
}
