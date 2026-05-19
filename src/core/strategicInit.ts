import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import type { ControlPlane } from "../schema.js";
import { type StrategicIntent } from "./strategicIntent.js";
import { stableStringify, deterministicId } from "./deterministicCore.js";
import { defaultCapabilitiesForMode } from "./runtimeGovernance.js";
import { strategicTemplateDefaultsFromCatalog } from "./initTemplateCatalog.js";
import { detectWorkspace, type WorkspaceConfig } from "./workspaceDetection.js";

export type StrategicInitMode = "full" | "expand-domain" | "reclassify" | "recalibrate";

export type StrategicTemplateName = string;

export type StrategicPriority =
  | "correctness"
  | "auditability"
  | "rollback-safety"
  | "minimal-blast-radius"
  | "deterministic-replay"
  | "iteration-speed"
  | "developer-autonomy"
  | "dependency-safety"
  | "stability";

export type OptimizationGoal =
  | "minimal-blast-radius"
  | "deterministic-replay"
  | "rapid-delivery"
  | "low-governance-friction"
  | "dependency-isolation"
  | "rollback-minimized"
  | "parallel-throughput";

export type RolloutPreference =
  | "canary-required"
  | "phased-required"
  | "phased-optional"
  | "all-at-once-allowed"
  | "parallel-optimized";

export type RiskTolerance = "low" | "moderate" | "high";
export type StabilityProfile = "stable" | "adaptive" | "experimental";
export type GovernanceIntensity = "strict" | "moderate" | "relaxed";

export type RuntimeMode =
  | "observe-only"
  | "simulation-only"
  | "approval-required"
  | "execution-enabled"
  | "distributed-control";

export type StrategicDomainDraft = {
  id: string;
  packages: string[];
  ownershipHints: string[];
  deploymentBoundaries: string[];
  reasons: string[];
  inferred: {
    priorities: StrategicPriority[];
    optimizationGoals: OptimizationGoal[];
    riskTolerance: RiskTolerance;
    rolloutPreferences: RolloutPreference[];
    stabilityProfile: StabilityProfile;
    governanceIntensity: GovernanceIntensity;
    runtimeMode: RuntimeMode;
    runtimeCapabilities?: ControlPlane["capabilities"];
  };
};

export type StrategicDiscovery = {
  workspace: WorkspaceConfig;
  packages: Array<{
    id: string;
    packagePath: string;
    dependencies: string[];
    category: "service" | "app" | "library" | "infra" | "tooling";
    ownershipHints: string[];
    deploymentBoundary: string;
  }>;
  domains: StrategicDomainDraft[];
};

export type StrategicDomainModel = {
  id: string;
  mission: string;
  priorities: StrategicPriority[];
  optimizationGoals: OptimizationGoal[];
  riskTolerance: RiskTolerance;
  rolloutPreferences: RolloutPreference[];
  stabilityProfile: StabilityProfile;
  governanceIntensity: GovernanceIntensity;
  runtimeMode?: RuntimeMode;
  runtimeCapabilities?: ControlPlane["capabilities"];
};

export type StrategicDomainPromptDefaults = {
  mission: string;
  priorities: StrategicPriority[];
  optimizationGoals: OptimizationGoal[];
  riskTolerance: RiskTolerance;
  rolloutPreferences: RolloutPreference[];
  stabilityProfile: StabilityProfile;
  governanceIntensity: GovernanceIntensity;
  runtimeMode: RuntimeMode;
};

export type StrategicCalibration = {
  selectedStrategyType: "rollback-minimized" | "parallel-optimized" | "balanced-default";
  rolloutDefault: "canary" | "phased" | "all-at-once";
  estimatedBlastRadius: number;
  governanceModeRecommendation: RuntimeMode;
  topologyRecommendations: string[];
};

export type StrategicInitSynthesisInput = {
  mode: StrategicInitMode;
  mission?: string;
  vision?: string;
  runtimeMode: RuntimeMode;
  discovery: StrategicDiscovery;
  models: StrategicDomainModel[];
  calibration: StrategicCalibration;
};

export type StrategicInitSynthesisResult = {
  controlPlane: ControlPlane;
  report: {
    runId: string;
    mode: StrategicInitMode;
    topologyHash: string;
    strategicHash: string;
    calibrationHash: string;
    generatedAt: string;
    workspaceType: WorkspaceConfig["type"];
    packages: number;
    domains: number;
    runtimeMode: RuntimeMode;
    calibration: StrategicCalibration;
  };
};

type TemplateDefaults = {
  priorities: StrategicPriority[];
  optimizationGoals: OptimizationGoal[];
  riskTolerance: RiskTolerance;
  rolloutPreferences: RolloutPreference[];
  stabilityProfile: StabilityProfile;
  governanceIntensity: GovernanceIntensity;
  runtimeMode: RuntimeMode;
  capabilities: ControlPlane["capabilities"];
};

function readCodeownersOwners(root: string, packagePath: string): string[] {
  const codeownersPath = path.join(root, ".github", "CODEOWNERS");
  if (!fs.existsSync(codeownersPath)) {
    return [];
  }

  const normalized = packagePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const lines = fs.readFileSync(codeownersPath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const matches = lines
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .filter((parts) => {
      const pattern = parts[0] ?? "";
      const prefix = pattern.replace(/\*+$/g, "").replace(/^\//, "");
      return prefix.length > 0 && normalized.startsWith(prefix);
    })
    .sort((left, right) => {
      const l = (left[0] ?? "").length;
      const r = (right[0] ?? "").length;
      return r - l;
    });

  if (matches.length === 0) {
    return [];
  }

  const owners = matches[0]?.slice(1).filter((owner) => owner.startsWith("@")) ?? [];
  return [...new Set(owners)].sort((left, right) => left.localeCompare(right));
}

function readPackageJson(root: string, packagePath: string): { name: string; dependencies: string[] } {
  const packageJsonPath = path.join(root, packagePath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return {
      name: packagePath,
      dependencies: [],
    };
  }

  const raw = fs.readFileSync(packageJsonPath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const name = typeof parsed.name === "string" && parsed.name.trim().length > 0
    ? parsed.name.trim()
    : packagePath;

  const dependencyBlocks = ["dependencies", "devDependencies", "peerDependencies"]
    .map((key) => parsed[key])
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value));

  const dependencies = dependencyBlocks
    .flatMap((block) => Object.keys(block))
    .filter((dep) => dep.trim().length > 0)
    .sort((left, right) => left.localeCompare(right));

  return {
    name,
    dependencies: [...new Set(dependencies)],
  };
}

function inferCategory(packagePath: string): "service" | "app" | "library" | "infra" | "tooling" {
  const normalized = packagePath.toLowerCase();
  if (normalized.includes("infra") || normalized.includes("terraform") || normalized.includes("k8s")) {
    return "infra";
  }

  if (normalized.startsWith("apps/") || normalized.includes("/apps/")) {
    return "app";
  }

  if (normalized.includes("service") || normalized.startsWith("services/") || normalized.includes("/services/")) {
    return "service";
  }

  if (normalized.includes("tool") || normalized.includes("cli")) {
    return "tooling";
  }

  return "library";
}

function inferDeploymentBoundary(packagePath: string): string {
  const normalized = packagePath.replace(/\\/g, "/");
  if (normalized === ".") {
    return "workspace-root";
  }

  const [top] = normalized.split("/");
  return top ?? "workspace-root";
}

const DOMAIN_CONTAINER_SEGMENTS = new Set([
  "apps",
  "packages",
  "libs",
  "services",
  "projects",
]);

function sanitizeDomainId(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : "workspace-root";
}

function deriveDomainIdFromTopology(packagePath: string): { domain: string; reason: string } {
  const normalized = packagePath.replace(/\\/g, "/");
  if (normalized === ".") {
    return {
      domain: "workspace-root",
      reason: "topology-derived from root package",
    };
  }

  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return {
      domain: "workspace-root",
      reason: "topology-derived from empty package path",
    };
  }

  const top = segments[0] ?? "workspace-root";
  const second = segments[1];
  const selected = DOMAIN_CONTAINER_SEGMENTS.has(top) && second
    ? second
    : top;

  return {
    domain: sanitizeDomainId(selected),
    reason: `topology-derived from package path ${normalized}`,
  };
}

const DOMAIN_KEYWORDS: Array<{ id: string; keywords: string[]; defaults: StrategicDomainDraft["inferred"] }> = [
  {
    id: "payments",
    keywords: ["payment", "billing", "invoice", "ledger", "settlement"],
    defaults: {
      priorities: ["correctness", "auditability", "rollback-safety"],
      optimizationGoals: ["deterministic-replay", "minimal-blast-radius", "rollback-minimized"],
      riskTolerance: "low",
      rolloutPreferences: ["canary-required", "phased-required"],
      stabilityProfile: "stable",
      governanceIntensity: "strict",
      runtimeMode: "approval-required",
    },
  },
  {
    id: "auth",
    keywords: ["auth", "identity", "access", "oauth", "session"],
    defaults: {
      priorities: ["correctness", "auditability", "dependency-safety"],
      optimizationGoals: ["deterministic-replay", "dependency-isolation"],
      riskTolerance: "low",
      rolloutPreferences: ["canary-required"],
      stabilityProfile: "stable",
      governanceIntensity: "strict",
      runtimeMode: "approval-required",
    },
  },
  {
    id: "experimentation",
    keywords: ["experiment", "abtest", "featureflag", "growth"],
    defaults: {
      priorities: ["iteration-speed", "developer-autonomy"],
      optimizationGoals: ["rapid-delivery", "parallel-throughput", "low-governance-friction"],
      riskTolerance: "high",
      rolloutPreferences: ["parallel-optimized", "phased-optional"],
      stabilityProfile: "experimental",
      governanceIntensity: "relaxed",
      runtimeMode: "simulation-only",
    },
  },
  {
    id: "analytics",
    keywords: ["analytics", "metrics", "telemetry", "events", "reporting"],
    defaults: {
      priorities: ["stability", "auditability"],
      optimizationGoals: ["parallel-throughput", "dependency-isolation"],
      riskTolerance: "moderate",
      rolloutPreferences: ["phased-optional"],
      stabilityProfile: "adaptive",
      governanceIntensity: "moderate",
      runtimeMode: "execution-enabled",
    },
  },
  {
    id: "platform",
    keywords: ["platform", "core", "runtime", "kernel"],
    defaults: {
      priorities: ["stability", "dependency-safety", "deterministic-replay"],
      optimizationGoals: ["dependency-isolation", "deterministic-replay"],
      riskTolerance: "moderate",
      rolloutPreferences: ["phased-required"],
      stabilityProfile: "adaptive",
      governanceIntensity: "moderate",
      runtimeMode: "execution-enabled",
    },
  },
  {
    id: "infra",
    keywords: ["infra", "deployment", "ops", "cluster", "iac"],
    defaults: {
      priorities: ["stability", "auditability", "rollback-safety"],
      optimizationGoals: ["minimal-blast-radius", "deterministic-replay"],
      riskTolerance: "low",
      rolloutPreferences: ["canary-required"],
      stabilityProfile: "stable",
      governanceIntensity: "strict",
      runtimeMode: "approval-required",
    },
  },
  {
    id: "developer-tools",
    keywords: ["tool", "cli", "devx", "sdk", "generator"],
    defaults: {
      priorities: ["developer-autonomy", "iteration-speed"],
      optimizationGoals: ["rapid-delivery", "low-governance-friction"],
      riskTolerance: "high",
      rolloutPreferences: ["all-at-once-allowed", "parallel-optimized"],
      stabilityProfile: "experimental",
      governanceIntensity: "relaxed",
      runtimeMode: "simulation-only",
    },
  },
];

function inferDomainDefaultsProfile(packagePath: string, packageName: string, category: string): { profileId: string; reasons: string[] } {
  const searchSpace = `${packagePath} ${packageName} ${category}`.toLowerCase();
  for (const candidate of DOMAIN_KEYWORDS) {
    const hit = candidate.keywords.find((keyword) => searchSpace.includes(keyword));
    if (hit) {
      return {
        profileId: candidate.id,
        reasons: [`default profile matched keyword ${hit}`],
      };
    }
  }

  if (category === "infra") {
    return { profileId: "infra", reasons: ["default profile inferred as infra by category"] };
  }

  if (category === "tooling") {
    return { profileId: "developer-tools", reasons: ["default profile inferred as developer-tools by category"] };
  }

  return {
    profileId: "platform",
    reasons: ["default profile fallback to platform"],
  };
}

function fallbackDomainDefaults(domainId: string): StrategicDomainDraft["inferred"] {
  const direct = DOMAIN_KEYWORDS.find((entry) => entry.id === domainId)?.defaults;
  if (direct) {
    return direct;
  }

  return {
    priorities: ["stability", "dependency-safety"],
    optimizationGoals: ["dependency-isolation", "deterministic-replay"],
    riskTolerance: "moderate",
    rolloutPreferences: ["phased-optional"],
    stabilityProfile: "adaptive",
    governanceIntensity: "moderate",
    runtimeMode: "execution-enabled",
  };
}

export function strategicTemplateDefaults(template: StrategicTemplateName | undefined): TemplateDefaults | undefined {
  const defaults = strategicTemplateDefaultsFromCatalog(template);
  if (!defaults) {
    return undefined;
  }

  return {
    priorities: [...defaults.priorities] as StrategicPriority[],
    optimizationGoals: [...defaults.optimizationGoals] as OptimizationGoal[],
    riskTolerance: defaults.riskTolerance as RiskTolerance,
    rolloutPreferences: [...defaults.rolloutPreferences] as RolloutPreference[],
    stabilityProfile: defaults.stabilityProfile as StabilityProfile,
    governanceIntensity: defaults.governanceIntensity as GovernanceIntensity,
    runtimeMode: defaults.runtimeMode as RuntimeMode,
    capabilities: { ...defaults.capabilities },
  };
}

export function discoverStrategicDomains(root: string, template: StrategicTemplateName | undefined): StrategicDiscovery {
  const workspace = detectWorkspace(root);

  const packageInfos = workspace.packages
    .map((packagePath) => {
      const pkg = readPackageJson(root, packagePath);
      const category = inferCategory(packagePath);
      return {
        id: pkg.name,
        packagePath,
        dependencies: pkg.dependencies,
        category,
        ownershipHints: readCodeownersOwners(root, packagePath),
        deploymentBoundary: inferDeploymentBoundary(packagePath),
      };
    })
    .sort((left, right) => left.packagePath.localeCompare(right.packagePath));

  const templateDefaults = strategicTemplateDefaults(template);
  const domainMap = new Map<string, StrategicDomainDraft>();

  for (const pkg of packageInfos) {
    const topologyDomain = deriveDomainIdFromTopology(pkg.packagePath);
    const defaultProfile = inferDomainDefaultsProfile(pkg.packagePath, pkg.id, pkg.category);
    const defaults = fallbackDomainDefaults(defaultProfile.profileId);
    const inferred = templateDefaults
      ? {
        priorities: [...templateDefaults.priorities],
        optimizationGoals: [...templateDefaults.optimizationGoals],
        riskTolerance: templateDefaults.riskTolerance,
        rolloutPreferences: [...templateDefaults.rolloutPreferences],
        stabilityProfile: templateDefaults.stabilityProfile,
        governanceIntensity: templateDefaults.governanceIntensity,
        runtimeMode: templateDefaults.runtimeMode,
        runtimeCapabilities: { ...templateDefaults.capabilities },
      }
      : defaults;

    const existing = domainMap.get(topologyDomain.domain);
    if (!existing) {
      domainMap.set(topologyDomain.domain, {
        id: topologyDomain.domain,
        packages: [pkg.packagePath],
        ownershipHints: [...pkg.ownershipHints],
        deploymentBoundaries: [pkg.deploymentBoundary],
        reasons: [topologyDomain.reason, ...defaultProfile.reasons],
        inferred,
      });
      continue;
    }

    existing.packages = [...new Set([...existing.packages, pkg.packagePath])].sort((left, right) => left.localeCompare(right));
    existing.ownershipHints = [...new Set([...existing.ownershipHints, ...pkg.ownershipHints])].sort((left, right) => left.localeCompare(right));
    existing.deploymentBoundaries = [...new Set([...existing.deploymentBoundaries, pkg.deploymentBoundary])].sort((left, right) => left.localeCompare(right));
    existing.reasons = [...new Set([...existing.reasons, topologyDomain.reason, ...defaultProfile.reasons])].sort((left, right) => left.localeCompare(right));
  }

  const domains = [...domainMap.values()].sort((left, right) => left.id.localeCompare(right.id));
  return {
    workspace,
    packages: packageInfos,
    domains,
  };
}

export function selectExpandDomainModelingDiscovery(
  discovery: StrategicDiscovery,
  currentControl: ControlPlane
): StrategicDiscovery {
  const existingPackagePaths = new Set(Object.keys(currentControl.packages ?? {}));
  const newlyDiscoveredPackagePaths = discovery.packages
    .map((pkg) => pkg.packagePath)
    .filter((packagePath) => !existingPackagePaths.has(packagePath));

  if (newlyDiscoveredPackagePaths.length === 0) {
    return {
      workspace: discovery.workspace,
      packages: [],
      domains: [],
    };
  }

  const newPackageSet = new Set(newlyDiscoveredPackagePaths);
  const selectedDomains = discovery.domains.filter((domain) => domain.packages.some((packagePath) => newPackageSet.has(packagePath)));
  const selectedPackageSet = new Set(selectedDomains.flatMap((domain) => domain.packages));

  return {
    workspace: discovery.workspace,
    packages: discovery.packages.filter((pkg) => selectedPackageSet.has(pkg.packagePath)),
    domains: selectedDomains,
  };
}

function averageGovernance(models: StrategicDomainModel[]): GovernanceIntensity {
  const score = models.reduce((total, model) => {
    if (model.governanceIntensity === "strict") {
      return total + 2;
    }

    if (model.governanceIntensity === "moderate") {
      return total + 1;
    }

    return total;
  }, 0);

  const average = models.length > 0 ? score / models.length : 1;
  if (average >= 1.6) {
    return "strict";
  }

  if (average <= 0.4) {
    return "relaxed";
  }

  return "moderate";
}

export function calibrateStrategicOrchestration(discovery: StrategicDiscovery, models: StrategicDomainModel[]): StrategicCalibration {
  const dependencyEdges = discovery.packages.reduce((total, pkg) => total + pkg.dependencies.length, 0);
  const strictCount = models.filter((model) => model.governanceIntensity === "strict").length;
  const relaxedCount = models.filter((model) => model.governanceIntensity === "relaxed").length;
  const lowRiskCount = models.filter((model) => model.riskTolerance === "low").length;

  const estimatedBlastRadius = Math.max(1, Math.round((dependencyEdges + discovery.packages.length) / Math.max(1, discovery.packages.length)));

  let selectedStrategyType: StrategicCalibration["selectedStrategyType"] = "balanced-default";
  let rolloutDefault: StrategicCalibration["rolloutDefault"] = "phased";
  let governanceModeRecommendation: RuntimeMode = "execution-enabled";

  if (strictCount > 0 || lowRiskCount > Math.floor(models.length / 2)) {
    selectedStrategyType = "rollback-minimized";
    rolloutDefault = "canary";
    governanceModeRecommendation = "approval-required";
  } else if (relaxedCount > Math.floor(models.length / 2)) {
    selectedStrategyType = "parallel-optimized";
    rolloutDefault = "all-at-once";
    governanceModeRecommendation = "simulation-only";
  }

  const topologyRecommendations = [
    `workspaceType=${discovery.workspace.type}`,
    `packageCount=${discovery.packages.length}`,
    `dependencyEdges=${dependencyEdges}`,
    `domainCount=${models.length}`,
    `governanceBlend=${averageGovernance(models)}`,
  ];

  return {
    selectedStrategyType,
    rolloutDefault,
    estimatedBlastRadius,
    governanceModeRecommendation,
    topologyRecommendations,
  };
}

function strategicIntentFromModels(models: StrategicDomainModel[]): StrategicIntent {
  if (models.length === 0) {
    return {
      priorities: [],
      optimizationGoals: [],
      riskTolerance: "moderate",
      architecturalPosture: [],
      rolloutPreferences: [],
      stabilityProfile: "adaptive",
      governanceIntensity: "moderate",
    };
  }

  const priorities = [...new Set(models.flatMap((model) => model.priorities))].sort((left, right) => left.localeCompare(right));
  const optimizationGoals = [...new Set(models.flatMap((model) => model.optimizationGoals))].sort((left, right) => left.localeCompare(right));
  const rolloutPreferences = [...new Set(models.flatMap((model) => model.rolloutPreferences))].sort((left, right) => left.localeCompare(right));

  const riskTolerance: RiskTolerance = models.some((model) => model.riskTolerance === "low")
    ? "low"
    : (models.every((model) => model.riskTolerance === "high") ? "high" : "moderate");

  const stabilityProfile: StabilityProfile = models.some((model) => model.stabilityProfile === "stable")
    ? "stable"
    : (models.some((model) => model.stabilityProfile === "adaptive") ? "adaptive" : "experimental");

  const governanceIntensity = averageGovernance(models);

  return {
    priorities,
    optimizationGoals,
    riskTolerance,
    architecturalPosture: [],
    rolloutPreferences,
    stabilityProfile,
    governanceIntensity,
  };
}

function toRuntimeCapabilities(
  mode: RuntimeMode,
  overrideCapabilities?: ControlPlane["capabilities"]
): ControlPlane["capabilities"] {
  if (overrideCapabilities) {
    return { ...overrideCapabilities };
  }

  return defaultCapabilitiesForMode(mode);
}

function resolveGlobalRuntimeCapabilities(
  models: StrategicDomainModel[],
  fallbackMode: RuntimeMode
): ControlPlane["capabilities"] {
  const explicit = models
    .map((model) => model.runtimeCapabilities)
    .filter((value): value is NonNullable<ControlPlane["capabilities"]> => value !== undefined);

  if (explicit.length === 0) {
    return toRuntimeCapabilities(fallbackMode);
  }

  const first = stableStringify(explicit[0]);
  const allMatch = explicit.every((capabilities) => stableStringify(capabilities) === first);
  if (!allMatch) {
    return toRuntimeCapabilities(fallbackMode);
  }

  return { ...explicit[0] };
}

function toPackageMode(model: StrategicDomainModel): NonNullable<ControlPlane["packageModes"]>[string] {
  if (model.runtimeMode) {
    return {
      mode: model.runtimeMode,
      capabilities: toRuntimeCapabilities(model.runtimeMode, model.runtimeCapabilities),
    };
  }

  if (model.governanceIntensity === "strict" || model.riskTolerance === "low") {
    const mode: RuntimeMode = "approval-required";
    return {
      mode,
      capabilities: toRuntimeCapabilities(mode, model.runtimeCapabilities),
    };
  }

  const mode: RuntimeMode = "execution-enabled";
  return {
    mode,
    capabilities: toRuntimeCapabilities(mode, model.runtimeCapabilities),
  };
}

function mergeUniqueSorted(left: string[] | undefined, right: string[] | undefined): string[] {
  return [...new Set([...(left ?? []), ...(right ?? [])])].sort((a, b) => a.localeCompare(b));
}

function defaultRuntimeModeFromPosture(
  governanceIntensity: GovernanceIntensity,
  riskTolerance: RiskTolerance
): RuntimeMode {
  if (governanceIntensity === "strict" || riskTolerance === "low") {
    return "approval-required";
  }

  return "execution-enabled";
}

function uniqueExistingDomainRuntimeMode(
  domain: StrategicDomainDraft,
  currentControl?: ControlPlane
): RuntimeMode | undefined {
  const modes = [...new Set(
    domain.packages
      .map((packagePath) => currentControl?.packageModes?.[packagePath]?.mode)
      .filter((mode): mode is RuntimeMode => typeof mode === "string")
  )].sort((left, right) => left.localeCompare(right));

  if (modes.length === 1) {
    return modes[0];
  }

  return undefined;
}

function uniqueExistingDomainMission(
  domain: StrategicDomainDraft,
  currentControl?: ControlPlane
): string | undefined {
  const missions = [...new Set(
    domain.packages
      .map((packagePath) => currentControl?.packages?.[packagePath]?.strategicIntent?.mission)
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  )].sort((left, right) => left.localeCompare(right));

  if (missions.length === 1) {
    return missions[0];
  }

  return undefined;
}

export function seedStrategicDomainPromptDefaults(
  domain: StrategicDomainDraft,
  currentControl?: ControlPlane
): StrategicDomainPromptDefaults {
  const currentDomain = currentControl?.domains?.[domain.id];
  const currentIntent = currentDomain?.strategicIntent;
  const packageMission = uniqueExistingDomainMission(domain, currentControl);

  const mission = (typeof currentDomain?.mission === "string" && currentDomain.mission.trim().length > 0)
    ? currentDomain.mission.trim()
    : (packageMission ?? `Owns ${domain.id} outcomes across ${domain.packages.length} package(s).`);

  const priorities = (currentIntent?.priorities && currentIntent.priorities.length > 0)
    ? [...currentIntent.priorities]
    : [...domain.inferred.priorities];

  const optimizationGoals = (currentIntent?.optimizationGoals && currentIntent.optimizationGoals.length > 0)
    ? [...currentIntent.optimizationGoals]
    : [...domain.inferred.optimizationGoals];

  const rolloutPreferences = (currentIntent?.rolloutPreferences && currentIntent.rolloutPreferences.length > 0)
    ? [...currentIntent.rolloutPreferences]
    : [...domain.inferred.rolloutPreferences];

  return {
    mission,
    priorities: priorities.sort((left, right) => left.localeCompare(right)),
    optimizationGoals: optimizationGoals.sort((left, right) => left.localeCompare(right)),
    riskTolerance: currentIntent?.riskTolerance ?? domain.inferred.riskTolerance,
    rolloutPreferences: rolloutPreferences.sort((left, right) => left.localeCompare(right)),
    stabilityProfile: currentIntent?.stabilityProfile ?? domain.inferred.stabilityProfile,
    governanceIntensity: currentIntent?.governanceIntensity ?? domain.inferred.governanceIntensity,
    runtimeMode: uniqueExistingDomainRuntimeMode(domain, currentControl)
      ?? domain.inferred.runtimeMode
      ?? defaultRuntimeModeFromPosture(
        currentIntent?.governanceIntensity ?? domain.inferred.governanceIntensity,
        currentIntent?.riskTolerance ?? domain.inferred.riskTolerance,
      ),
  };
}

export function synthesizeStrategicControlPlane(
  existing: ControlPlane,
  input: StrategicInitSynthesisInput
): StrategicInitSynthesisResult {
  const hasRootPackage = fs.existsSync(path.join(input.discovery.workspace.root, "package.json"));
  const singlePackageRooted = hasRootPackage && input.discovery.packages.length === 1;
  const singlePackageRuntimeMode = singlePackageRooted && input.models.length === 1
    ? input.models[0]?.runtimeMode
    : undefined;
  const effectiveRuntimeMode = singlePackageRuntimeMode ?? input.runtimeMode;
  const effectiveRuntimeCapabilities = resolveGlobalRuntimeCapabilities(input.models, effectiveRuntimeMode);
  const packageDomainMap = new Map<string, string>();
  for (const domain of input.discovery.domains) {
    for (const pkg of domain.packages) {
      packageDomainMap.set(pkg, domain.id);
    }
  }

  const domainById = new Map(input.models.map((model) => [model.id, model] as const));

  const discoveredPackages = Object.fromEntries(
    input.discovery.packages.map((pkg) => {
      const domain = packageDomainMap.get(pkg.packagePath) ?? "platform";
      const model = domainById.get(domain);
      return [
        pkg.packagePath,
        {
          ...(model
            ? {
              strategicIntent: {
                ...(model.mission.trim().length > 0 ? { mission: model.mission.trim() } : {}),
                priorities: [...model.priorities],
                optimizationGoals: [...model.optimizationGoals],
                riskTolerance: model.riskTolerance,
                architecturalPosture: [],
                rolloutPreferences: [...model.rolloutPreferences],
                stabilityProfile: model.stabilityProfile,
                governanceIntensity: model.governanceIntensity,
              },
            }
            : {}),
        },
      ];
    })
  );

  const packageModes = Object.fromEntries(
    input.discovery.packages.map((pkg) => {
      const domain = packageDomainMap.get(pkg.packagePath);
      const model = domain ? domainById.get(domain) : undefined;
      const defaultMode: RuntimeMode = "execution-enabled";
      return [
        pkg.packagePath,
        model
          ? toPackageMode(model)
          : {
            mode: defaultMode,
            capabilities: toRuntimeCapabilities(defaultMode),
          },
      ];
    })
  );

  const baseControl = input.mode === "full"
    ? {
      ...existing,
      packages: {},
      contexts: {},
      packageModes: {},
    }
    : existing;

  const { domains: _domains, ...baseWithoutDomains } = baseControl;
  const strategicScopedBase = baseWithoutDomains as ControlPlane;
  const nextPackages = input.mode === "expand-domain"
    ? {
      ...(baseControl.packages ?? {}),
      ...Object.fromEntries(
        Object.entries(discoveredPackages).filter(([id]) => !(baseControl.packages && Object.prototype.hasOwnProperty.call(baseControl.packages, id)))
      ),
    }
    : (input.mode === "recalibrate" ? (baseControl.packages ?? {}) : discoveredPackages);

  const nextPackageModes = input.mode === "recalibrate"
    ? {
      ...(strategicScopedBase.packageModes ?? {}),
      ...packageModes,
    }
    : (input.mode === "expand-domain"
      ? {
        ...(strategicScopedBase.packageModes ?? {}),
        ...Object.fromEntries(
          Object.entries(packageModes).filter(([id]) => !(strategicScopedBase.packageModes && Object.prototype.hasOwnProperty.call(strategicScopedBase.packageModes, id)))
        ),
      }
      : packageModes);

  const nextControl: ControlPlane = {
    ...strategicScopedBase,
    ...(input.mission && input.mission.trim().length > 0 ? { mission: input.mission.trim() } : {}),
    ...(input.vision && input.vision.trim().length > 0 ? { vision: input.vision.trim() } : {}),
    ...(hasRootPackage && !singlePackageRooted ? { strategicIntent: strategicIntentFromModels(input.models) } : {}),
    packages: nextPackages,
    contexts: {
      ...(strategicScopedBase.contexts ?? {}),
      "workspace:root": {
        packages: input.discovery.packages.map((pkg) => pkg.packagePath).sort((left, right) => left.localeCompare(right)),
      },
    },
    ...(hasRootPackage
      ? {
        runtime: {
          mode: effectiveRuntimeMode,
        },
        capabilities: effectiveRuntimeCapabilities,
      }
      : {}),
    ...(!hasRootPackage
      ? {
        packageModes: nextPackageModes,
      }
      : {}),
  };

  const topologyHash = deterministicId("init-topology", {
    workspace: input.discovery.workspace,
    packages: input.discovery.packages,
    domains: input.discovery.domains,
  }, 16);

  const strategicHash = deterministicId("init-strategic", {
    models: input.models,
    packages: nextControl.packages,
  }, 16);

  const calibrationHash = deterministicId("init-calibration", input.calibration, 16);
  const runId = deterministicId("init-run", {
    mode: input.mode,
    topologyHash,
    strategicHash,
    calibrationHash,
  }, 16);

  return {
    controlPlane: nextControl,
    report: {
      runId,
      mode: input.mode,
      topologyHash,
      strategicHash,
      calibrationHash,
      generatedAt: new Date().toISOString(),
      workspaceType: input.discovery.workspace.type,
      packages: input.discovery.packages.length,
      domains: input.models.length,
      runtimeMode: effectiveRuntimeMode,
      calibration: input.calibration,
    },
  };
}

export function strategicInitStatePath(root: string): string {
  return path.join(root, ".choir", "init-strategic-state.json");
}

export function writeStrategicInitState(root: string, value: unknown): void {
  const target = strategicInitStatePath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${stableStringify(value)}\n`, "utf-8");
}

export function readStrategicInitState(root: string): unknown | null {
  const target = strategicInitStatePath(root);
  if (!fs.existsSync(target)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(target, "utf-8");
    return YAML.parse(raw);
  } catch {
    return null;
  }
}
