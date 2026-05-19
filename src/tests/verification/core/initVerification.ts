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
import { compileDSLAndWrite } from "../../../core/dslYamlCompiler.js";
import { defaultCapabilitiesForMode } from "../../../core/runtimeGovernance.js";

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

function createRootlessStrategicFixtureWorkspace(): { root: string; dispose: () => void } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "choir-init-rootless-verify-"));
  const root = path.join(tempRoot, "workspace");

  fs.mkdirSync(path.join(root, "client"), { recursive: true });
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.mkdirSync(path.join(root, ".choir"), { recursive: true });

  fs.writeFileSync(path.join(root, "client", "package.json"), JSON.stringify({
    name: "@acme/client",
  }, null, 2));

  fs.writeFileSync(path.join(root, "server", "package.json"), JSON.stringify({
    name: "@acme/server",
    dependencies: {
      "@acme/client": "workspace:*",
    },
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
  const rootlessFixture = createRootlessStrategicFixtureWorkspace();

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

    const packagesOmitDomainField = Object.values(packageMappings).every((entry) => !("domain" in entry));
    checks.push({
      name: "packages-canonical-omits-domain-field",
      passed: packagesOmitDomainField,
      detail: packagesOmitDomainField
        ? `packages=${sortedMappings.length}`
        : "expected synthesized packages to omit legacy domain field",
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

    const rootedCapabilitiesCoherent = stableStringify(synthA.controlPlane.capabilities ?? {})
      === stableStringify(defaultCapabilitiesForMode(runtimeMode));
    checks.push({
      name: "rooted-capabilities-match-runtime-defaults",
      passed: rootedCapabilitiesCoherent,
      detail: rootedCapabilitiesCoherent
        ? `runtime=${runtimeMode}`
        : `capabilities do not match defaults for runtime=${runtimeMode}`,
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
          && seededDefaults.governanceIntensity === "strict"
          && seededDefaults.runtimeMode === "approval-required",
        detail: `domain=${domainForPrompt.id}`,
      });

      const modelMission = models.find((model) => model.id === domainForPrompt.id)?.mission ?? "";
      const packageSeededDefaults = seedStrategicDomainPromptDefaults(domainForPrompt, synthA.controlPlane);
      checks.push({
        name: "domain-prompt-defaults-seeded-from-package-strategic-intent",
        passed: modelMission.length > 0
          && packageSeededDefaults.mission === modelMission,
        detail: `domain=${domainForPrompt.id}`,
      });

      const explicitRuntimeModels = toModels(firstDiscovery).map((model) => ({
        ...model,
        runtimeMode: "simulation-only" as const,
      }));

      const explicitRuntimeSynthesis = synthesizeStrategicControlPlane(control, {
        mode: "full",
        mission: "Mission",
        vision: "Vision",
        runtimeMode: calibrationA.governanceModeRecommendation,
        discovery: firstDiscovery,
        models: explicitRuntimeModels,
        calibration: calibrationA,
      });

      const rootedIgnoresPackageOverrides = explicitRuntimeSynthesis.controlPlane.packageModes === undefined
        || Object.keys(explicitRuntimeSynthesis.controlPlane.packageModes).length === 0;
      checks.push({
        name: "rooted-global-governance-ignores-package-overrides",
        passed: rootedIgnoresPackageOverrides,
        detail: rootedIgnoresPackageOverrides
          ? "rooted synthesis does not emit packageModes"
          : "rooted synthesis should not emit packageModes",
      });
    }

    assert.ok(firstDiscovery.domains.length > 0, "expected discovered strategic domains");

    const synthesizedOmitsDomains = synthA.controlPlane.domains === undefined || Object.keys(synthA.controlPlane.domains).length === 0;
    checks.push({
      name: "synthesized-control-omits-domain-catalog",
      passed: synthesizedOmitsDomains,
      detail: synthesizedOmitsDomains
        ? "domains are not persisted; packages are canonical"
        : "expected synthesized control plane to omit domains catalog",
    });

    const rootedGovernanceScopeExclusive = synthA.controlPlane.runtime !== undefined
      && synthA.controlPlane.capabilities !== undefined
      && (synthA.controlPlane.packageModes === undefined || Object.keys(synthA.controlPlane.packageModes).length === 0);
    checks.push({
      name: "rooted-governance-scope-exclusive",
      passed: rootedGovernanceScopeExclusive,
      detail: rootedGovernanceScopeExclusive
        ? "rooted synthesis uses global runtime/capabilities only"
        : "rooted synthesis should not persist packageModes",
    });

    let mixedGovernanceRejected = false;
    try {
      ControlPlaneSchema.parse({
        ...control,
        packageModes: {
          legacy: {
            mode: "approval-required",
            capabilities: {
              preview: true,
              simulate: true,
              execute: true,
              optimize: true,
              import: true,
              install: true,
              update: true,
            },
          },
        },
      });
    } catch {
      mixedGovernanceRejected = true;
    }
    checks.push({
      name: "mixed-global-and-package-governance-rejected",
      passed: mixedGovernanceRejected,
      detail: mixedGovernanceRejected
        ? "schema rejected mixed global runtime and packageModes"
        : "schema must reject mixed global runtime and packageModes",
    });

    const rootlessDiscovery = discoverStrategicDomains(rootlessFixture.root, undefined);
    const rootlessModels = toModels(rootlessDiscovery);
    const rootlessCalibration = calibrateStrategicOrchestration(rootlessDiscovery, rootlessModels);
    const rootlessSynthesis = synthesizeStrategicControlPlane(control, {
      mode: "full",
      mission: "Rootless Mission",
      vision: "Rootless Vision",
      runtimeMode: rootlessCalibration.governanceModeRecommendation,
      discovery: rootlessDiscovery,
      models: rootlessModels,
      calibration: rootlessCalibration,
    });

    const rootlessOmitsGlobalRuntime = rootlessSynthesis.controlPlane.runtime === undefined
      && rootlessSynthesis.controlPlane.capabilities === undefined;
    checks.push({
      name: "rootless-workspace-omits-global-runtime",
      passed: rootlessOmitsGlobalRuntime,
      detail: rootlessOmitsGlobalRuntime
        ? `packages=${rootlessDiscovery.packages.length}`
        : "runtime/capabilities should be omitted when no root package exists",
    });

    const rootlessGovernanceScopeExclusive = (rootlessSynthesis.controlPlane.packageModes !== undefined
      && Object.keys(rootlessSynthesis.controlPlane.packageModes).length > 0)
      && rootlessSynthesis.controlPlane.runtime === undefined
      && rootlessSynthesis.controlPlane.capabilities === undefined;
    checks.push({
      name: "rootless-governance-scope-exclusive",
      passed: rootlessGovernanceScopeExclusive,
      detail: rootlessGovernanceScopeExclusive
        ? "rootless synthesis uses packageModes only"
        : "rootless synthesis should persist packageModes without global runtime/capabilities",
    });

    const rootlessPackageCapabilitiesCoherent = rootlessDiscovery.packages.every((pkg) => {
      const packageMode = rootlessSynthesis.controlPlane.packageModes?.[pkg.packagePath];
      const mode = packageMode?.mode;
      if (!mode) {
        return false;
      }

      return stableStringify(packageMode.capabilities ?? {}) === stableStringify(defaultCapabilitiesForMode(mode));
    });
    checks.push({
      name: "rootless-package-capabilities-match-mode-defaults",
      passed: rootlessPackageCapabilitiesCoherent,
      detail: rootlessPackageCapabilitiesCoherent
        ? `packages=${rootlessDiscovery.packages.length}`
        : "expected packageModes capabilities to match each package mode default",
    });

    const rootlessExplicitRuntimeModels = rootlessModels.map((model) => ({
      ...model,
      runtimeMode: "simulation-only" as const,
    }));
    const rootlessExplicitSynthesis = synthesizeStrategicControlPlane(control, {
      mode: "full",
      mission: "Rootless Mission",
      vision: "Rootless Vision",
      runtimeMode: rootlessCalibration.governanceModeRecommendation,
      discovery: rootlessDiscovery,
      models: rootlessExplicitRuntimeModels,
      calibration: rootlessCalibration,
    });
    const rootlessExplicitRuntimeApplied = rootlessDiscovery.packages.every((pkg) => {
      const packageMode = rootlessExplicitSynthesis.controlPlane.packageModes?.[pkg.packagePath];
      return packageMode?.mode === "simulation-only"
        && stableStringify(packageMode.capabilities ?? {}) === stableStringify(defaultCapabilitiesForMode("simulation-only"));
    });
    checks.push({
      name: "rootless-domain-runtime-mode-overrides-package-modes",
      passed: rootlessExplicitRuntimeApplied,
      detail: rootlessExplicitRuntimeApplied
        ? `packages=${rootlessDiscovery.packages.length}`
        : "expected all rootless package modes/capabilities to follow explicit domain runtime mode",
    });

  } finally {
    fixture.dispose();
    rootlessFixture.dispose();
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
