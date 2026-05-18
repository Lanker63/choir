import { deterministicHash } from "./deterministicCore.js";
import type { ControlPlane } from "../schema.js";

export type RuntimeMode =
  | "observe-only"
  | "simulation-only"
  | "approval-required"
  | "execution-enabled"
  | "distributed-control";

export type Capability =
  | "preview"
  | "simulate"
  | "execute"
  | "optimize"
  | "import"
  | "install"
  | "update";

export type CapabilityDecision =
  | "allow"
  | "deny"
  | "require-approval";

export type RuntimeCapabilities = Record<Capability, boolean>;

export type RuntimeConfig = {
  mode: RuntimeMode;
  capabilities?: Partial<RuntimeCapabilities>;
  packageModes?: Record<string, {
    mode?: RuntimeMode;
    capabilities?: Partial<RuntimeCapabilities>;
  }>;
};

export type RuntimeCapabilityEvaluation = {
  capability: Capability;
  decision: CapabilityDecision;
  reason: "capability-disabled" | "mode-requires-approval" | "capability-enabled";
};

export type PackageRuntimeDecision = {
  packageName: string;
  mode: RuntimeMode;
  decision: CapabilityDecision;
  reason: "capability-disabled" | "mode-requires-approval" | "capability-enabled";
};

export type RuntimeGovernanceEvaluation = {
  mode: RuntimeMode;
  capability: Capability;
  decision: CapabilityDecision;
  reason:
    | "capability-disabled"
    | "mode-requires-approval"
    | "capability-enabled"
    | "package-capability-disabled"
    | "package-mode-requires-approval";
  effectiveCapabilities: RuntimeCapabilities;
  packageDecisions: PackageRuntimeDecision[];
  governanceHash: string;
};

const CAPABILITY_LIST: Capability[] = [
  "preview",
  "simulate",
  "execute",
  "optimize",
  "import",
  "install",
  "update",
];

const MODE_DEFAULTS: Record<RuntimeMode, RuntimeCapabilities> = {
  "observe-only": {
    preview: true,
    simulate: true,
    execute: false,
    optimize: true,
    import: true,
    install: false,
    update: false,
  },
  "simulation-only": {
    preview: true,
    simulate: true,
    execute: false,
    optimize: true,
    import: true,
    install: false,
    update: false,
  },
  "approval-required": {
    preview: true,
    simulate: true,
    execute: true,
    optimize: true,
    import: true,
    install: true,
    update: true,
  },
  "execution-enabled": {
    preview: true,
    simulate: true,
    execute: true,
    optimize: true,
    import: true,
    install: true,
    update: true,
  },
  "distributed-control": {
    preview: true,
    simulate: true,
    execute: true,
    optimize: true,
    import: true,
    install: true,
    update: true,
  },
};

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function withCapabilityOverrides(
  base: RuntimeCapabilities,
  overrides: Partial<RuntimeCapabilities> | undefined
): RuntimeCapabilities {
  const merged: RuntimeCapabilities = { ...base };

  for (const capability of CAPABILITY_LIST) {
    if (typeof overrides?.[capability] === "boolean") {
      merged[capability] = overrides[capability] as boolean;
    }
  }

  return merged;
}

export function defaultCapabilitiesForMode(mode: RuntimeMode): RuntimeCapabilities {
  return { ...MODE_DEFAULTS[mode] };
}

export function resolveRuntimeConfig(controlPlane: ControlPlane): RuntimeConfig {
  return {
    mode: controlPlane.runtime?.mode ?? "execution-enabled",
    ...(controlPlane.capabilities ? { capabilities: controlPlane.capabilities } : {}),
    ...(controlPlane.packageModes ? { packageModes: controlPlane.packageModes } : {}),
  };
}

export function resolveEffectiveCapabilities(runtime: RuntimeConfig): RuntimeCapabilities {
  return withCapabilityOverrides(
    defaultCapabilitiesForMode(runtime.mode),
    runtime.capabilities
  );
}

export function evaluateCapabilityGate(
  capability: Capability,
  runtime: RuntimeConfig
): CapabilityDecision {
  const effectiveCapabilities = resolveEffectiveCapabilities(runtime);
  if (!effectiveCapabilities[capability]) {
    return "deny";
  }

  if (
    capability === "execute"
    && runtime.mode === "approval-required"
  ) {
    return "require-approval";
  }

  return "allow";
}

export function capabilityForPipelineMode(mode: "preview" | "simulate" | "execute" | "optimize"): Capability {
  if (mode === "preview") return "preview";
  if (mode === "simulate") return "simulate";
  if (mode === "execute") return "execute";
  return "optimize";
}

export function evaluateRuntimeGovernance(input: {
  controlPlane: ControlPlane;
  capability: Capability;
  packageNames?: string[];
}): RuntimeGovernanceEvaluation {
  const runtime = resolveRuntimeConfig(input.controlPlane);
  const effectiveCapabilities = resolveEffectiveCapabilities(runtime);
  const decision = evaluateCapabilityGate(input.capability, runtime);

  let reason: RuntimeGovernanceEvaluation["reason"] = "capability-enabled";
  if (decision === "deny") {
    reason = "capability-disabled";
  } else if (decision === "require-approval") {
    reason = "mode-requires-approval";
  }

  const packageNames = sortedUnique((input.packageNames ?? [])
    .map((name) => name.trim())
    .filter((name) => name.length > 0));

  const packageDecisions: PackageRuntimeDecision[] = packageNames.map((packageName) => {
    const packageRuntime = runtime.packageModes?.[packageName];
    if (!packageRuntime) {
      return {
        packageName,
        mode: runtime.mode,
        decision,
        reason: reason === "capability-enabled" ? "capability-enabled" : reason,
      };
    }

    const packageMode = packageRuntime.mode ?? runtime.mode;
    const packageEffective = withCapabilityOverrides(
      defaultCapabilitiesForMode(packageMode),
      packageRuntime.capabilities
    );

    if (!packageEffective[input.capability]) {
      return {
        packageName,
        mode: packageMode,
        decision: "deny",
        reason: "capability-disabled",
      };
    }

    if (input.capability === "execute" && packageMode === "approval-required") {
      return {
        packageName,
        mode: packageMode,
        decision: "require-approval",
        reason: "mode-requires-approval",
      };
    }

    return {
      packageName,
      mode: packageMode,
      decision: "allow",
      reason: "capability-enabled",
    };
  });

  const packageDeny = packageDecisions.find((entry) => entry.decision === "deny");
  const packageRequireApproval = packageDecisions.find((entry) => entry.decision === "require-approval");

  let finalDecision: RuntimeGovernanceEvaluation["decision"] = decision;
  let finalReason: RuntimeGovernanceEvaluation["reason"] = reason;

  if (packageDeny) {
    finalDecision = "deny";
    finalReason = "package-capability-disabled";
  } else if (packageRequireApproval && finalDecision !== "deny") {
    finalDecision = "require-approval";
    finalReason = "package-mode-requires-approval";
  }

  const governanceHash = deterministicHash({
    mode: runtime.mode,
    capability: input.capability,
    effectiveCapabilities,
    packageDecisions: packageDecisions.map((entry) => ({
      packageName: entry.packageName,
      mode: entry.mode,
      decision: entry.decision,
      reason: entry.reason,
    })),
    decision: finalDecision,
    reason: finalReason,
  });

  return {
    mode: runtime.mode,
    capability: input.capability,
    decision: finalDecision,
    reason: finalReason,
    effectiveCapabilities,
    packageDecisions,
    governanceHash,
  };
}

export function packageNamesFromPlanTaskUnits(units: string[]): string[] {
  return sortedUnique(units
    .map((unit) => unit.trim())
    .filter((unit) => unit.startsWith("packages:"))
    .map((unit) => unit.slice("packages:".length))
    .filter((entry) => entry.length > 0));
}
