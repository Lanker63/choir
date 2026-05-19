import { deterministicHash } from "./deterministicCore.js";
import type {
  ArchitecturalPosture,
  ControlPlane,
  GovernanceIntensity,
  OptimizationGoal,
  RiskTolerance,
  RolloutPreference,
  StabilityProfile,
  StrategicPriority,
} from "../schema.js";

export type StrategicIntent = {
  // mission?: string;
  priorities: StrategicPriority[];
  optimizationGoals: OptimizationGoal[];
  riskTolerance: RiskTolerance;
  architecturalPosture: ArchitecturalPosture[];
  rolloutPreferences: RolloutPreference[];
  stabilityProfile: StabilityProfile;
  governanceIntensity: GovernanceIntensity;
};

export type ResolvedStrategicContext = {
  status: "resolved" | "failed";
  reason?: "ambiguous-domain-resolution";
  packageNames: string[];
  domains: string[];
  inheritanceChain: string[];
  intent: StrategicIntent;
  hash: string;
  explainability: {
    priorities: string[];
    optimizationGoals: string[];
    rolloutPreferences: string[];
    governanceIntensity: GovernanceIntensity;
  };
};

export type StrategicAlignment = {
  score: number;
  reasons: string[];
  hash: string;
};

export type RolloutBias = {
  preferred: "canary" | "phased" | "all-at-once";
  stageSizing: "slow" | "balanced" | "fast";
  rollbackAggressiveness: "strict" | "normal" | "relaxed";
  dependencyIsolation: "high" | "medium" | "low";
  reasons: string[];
};

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function defaultStrategicIntent(): StrategicIntent {
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

function mergeArray<T extends string>(base: T[], next: T[] | undefined): T[] {
  return next ? sortedUnique(next) as T[] : base;
}

// function normalizePartialIntent(input: StrategicIntent | undefined): StrategicIntent {
//   const base = defaultStrategicIntent();
//   if (!input) {
//     return base;
//   }

//   return {
//     mission: normalizeOptionalString(input.mission),
//     priorities: mergeArray(base.priorities, input.priorities),
//     optimizationGoals: mergeArray(base.optimizationGoals, input.optimizationGoals),
//     riskTolerance: input.riskTolerance ?? base.riskTolerance,
//     architecturalPosture: mergeArray(base.architecturalPosture, input.architecturalPosture),
//     rolloutPreferences: mergeArray(base.rolloutPreferences, input.rolloutPreferences),
//     stabilityProfile: input.stabilityProfile ?? base.stabilityProfile,
//     governanceIntensity: input.governanceIntensity ?? base.governanceIntensity,
//   };
// }

function mergeIntent(base: StrategicIntent, next: StrategicIntent | undefined): StrategicIntent {
  if (!next) {
    return base;
  }

  return {
    // mission: normalizeOptionalString(next.mission) ?? base.mission,
    priorities: mergeArray(base.priorities, next.priorities),
    optimizationGoals: mergeArray(base.optimizationGoals, next.optimizationGoals),
    riskTolerance: next.riskTolerance ?? base.riskTolerance,
    architecturalPosture: mergeArray(base.architecturalPosture, next.architecturalPosture),
    rolloutPreferences: mergeArray(base.rolloutPreferences, next.rolloutPreferences),
    stabilityProfile: next.stabilityProfile ?? base.stabilityProfile,
    governanceIntensity: next.governanceIntensity ?? base.governanceIntensity,
  };
}

function packageDomain(control: ControlPlane, packageName: string): string | undefined {
  return control.packages?.[packageName]?.domain;
}

export function resolveStrategicContext(input: {
  controlPlane: ControlPlane;
  packageNames: string[];
  unitId?: string;
}): ResolvedStrategicContext {
  const packageNames = sortedUnique(input.packageNames.map((entry) => entry.trim()).filter((entry) => entry.length > 0));
  const control = input.controlPlane;
  const strategicHierarchyEnabled = Boolean(
    // (control.strategicIntent && (
    //   (control.strategicIntent.mission?.trim().length ?? 0) > 0
    //   || (control.strategicIntent.priorities?.length ?? 0) > 0
    //   || (control.strategicIntent.optimizationGoals?.length ?? 0) > 0
    //   || (control.strategicIntent.architecturalPosture?.length ?? 0) > 0
    //   || (control.strategicIntent.rolloutPreferences?.length ?? 0) > 0
    //   || typeof control.strategicIntent.riskTolerance === "string"
    //   || typeof control.strategicIntent.stabilityProfile === "string"
    //   || typeof control.strategicIntent.governanceIntensity === "string"
    // ))
    // || 
    Object.keys(control.domains ?? {}).length > 0
    || Object.keys(control.packages ?? {}).length > 0
    || Object.keys(control.contexts ?? {}).length > 0
  );

  const globalIntent = defaultStrategicIntent(); // normalizePartialIntent(control.packages?.root?.strategicIntent);
  const globalChain: string[] = ["global"];

  if (packageNames.length === 0) {
    const hash = deterministicHash({
      packageNames,
      domains: [],
      inheritanceChain: globalChain,
      intent: globalIntent,
    });
    return {
      status: "resolved",
      packageNames,
      domains: [],
      inheritanceChain: globalChain,
      intent: globalIntent,
      hash,
      explainability: {
        priorities: [...globalIntent.priorities],
        optimizationGoals: [...globalIntent.optimizationGoals],
        rolloutPreferences: [...globalIntent.rolloutPreferences],
        governanceIntensity: globalIntent.governanceIntensity,
      },
    };
  }

  if (!strategicHierarchyEnabled) {
    const hash = deterministicHash({
      packageNames,
      domains: [],
      inheritanceChain: globalChain,
      intent: globalIntent,
    });
    return {
      status: "resolved",
      packageNames,
      domains: [],
      inheritanceChain: globalChain,
      intent: globalIntent,
      hash,
      explainability: {
        priorities: [...globalIntent.priorities],
        optimizationGoals: [...globalIntent.optimizationGoals],
        rolloutPreferences: [...globalIntent.rolloutPreferences],
        governanceIntensity: globalIntent.governanceIntensity,
      },
    };
  }

  const domainSet = new Set<string>();
  for (const packageName of packageNames) {
    const domain = packageDomain(control, packageName);
    if (domain) {
      domainSet.add(domain);
    }
  }

  const domains = sortedUnique([...domainSet]);
  if (domains.length !== 1) {
    return {
      status: "failed",
      reason: "ambiguous-domain-resolution",
      packageNames,
      domains,
      inheritanceChain: [...globalChain],
      intent: globalIntent,
      hash: deterministicHash({
        status: "failed",
        reason: "ambiguous-domain-resolution",
        packageNames,
        domains,
        inheritanceChain: globalChain,
      }),
      explainability: {
        priorities: [...globalIntent.priorities],
        optimizationGoals: [...globalIntent.optimizationGoals],
        rolloutPreferences: [...globalIntent.rolloutPreferences],
        governanceIntensity: globalIntent.governanceIntensity,
      },
    };
  }

  const domain = domains.length === 1 ? domains[0] as string : undefined;
  const domainConfig = domain ? control.domains?.[domain] : undefined;

  let effectiveIntent = mergeIntent(globalIntent, domainConfig?.strategicIntent as StrategicIntent | undefined);
  const chain = domain ? [...globalChain, `domain:${domain}`] : [...globalChain];

  for (const packageName of packageNames) {
    const packageConfig = control.packages?.[packageName];
    effectiveIntent = mergeIntent(effectiveIntent, packageConfig?.strategicIntent as StrategicIntent | undefined);
    chain.push(`package:${packageName}`);
  }

  const contexts = sortedUnique(Object.entries(control.contexts ?? {})
    .filter(([, context]) => {
      if (context.domain && domain && context.domain !== domain) {
        return false;
      }

      if (context.domain && !domain) {
        return false;
      }

      if (!context.packages || context.packages.length === 0) {
        return false;
      }

      const packageSet = new Set(context.packages);
      return packageNames.every((packageName) => packageSet.has(packageName));
    })
    .map(([contextName]) => contextName));

  for (const contextName of contexts) {
    effectiveIntent = mergeIntent(effectiveIntent, control.contexts?.[contextName]?.strategicIntent as StrategicIntent | undefined);
    chain.push(`context:${contextName}`);
  }

  if (input.unitId && input.unitId.trim().length > 0) {
    chain.push(`unit:${input.unitId.trim()}`);
  }

  const hash = deterministicHash({
    packageNames,
    domains,
    inheritanceChain: chain,
    intent: effectiveIntent,
  });

  return {
    status: "resolved",
    packageNames,
    domains,
    inheritanceChain: chain,
    intent: effectiveIntent,
    hash,
    explainability: {
      priorities: [...effectiveIntent.priorities],
      optimizationGoals: [...effectiveIntent.optimizationGoals],
      rolloutPreferences: [...effectiveIntent.rolloutPreferences],
      governanceIntensity: effectiveIntent.governanceIntensity,
    },
  };
}

export function strategicAlignmentForCandidate(input: {
  strategyType: string;
  intent: StrategicIntent;
  riskScore: number;
  rollbackComplexity: number;
}): StrategicAlignment {
  const reasons: string[] = [];
  let score = 0;

  const priorities = new Set(input.intent.priorities);
  const goals = new Set(input.intent.optimizationGoals);
  const rollout = new Set(input.intent.rolloutPreferences);
  const posture = new Set(input.intent.architecturalPosture);

  if (input.strategyType === "rollback-minimized") {
    if (priorities.has("rollback-safety")) {
      score += 6;
      reasons.push("priority:rollback-safety");
    }
    if (priorities.has("auditability") || priorities.has("correctness")) {
      score += 3;
      reasons.push("priority:correctness-or-auditability");
    }
    if (rollout.has("canary-required")) {
      score += 4;
      reasons.push("rollout:canary-required");
    }
    if (goals.has("rollback-minimized") || goals.has("deterministic-replay")) {
      score += 3;
      reasons.push("goal:rollback-or-replay");
    }
  }

  if (input.strategyType === "dependency-safe" || input.strategyType === "low-risk") {
    if (priorities.has("dependency-safety") || priorities.has("correctness")) {
      score += 4;
      reasons.push("priority:dependency-safety");
    }
    if (posture.has("conservative") || posture.has("highly-reviewed")) {
      score += 3;
      reasons.push("posture:conservative");
    }
    if (input.intent.riskTolerance === "low") {
      score += 2;
      reasons.push("riskTolerance:low");
    }
  }

  if (input.strategyType === "parallel-optimized") {
    if (priorities.has("iteration-speed") || priorities.has("developer-autonomy")) {
      score += 6;
      reasons.push("priority:iteration-speed");
    }
    if (goals.has("rapid-delivery") || goals.has("low-governance-friction")) {
      score += 4;
      reasons.push("goal:rapid-delivery");
    }
    if (input.intent.riskTolerance === "high") {
      score += 2;
      reasons.push("riskTolerance:high");
    }
  }

  if (input.intent.governanceIntensity === "strict") {
    score += 1;
    reasons.push("governance:strict");
  }

  if (input.intent.stabilityProfile === "stable") {
    score += 1;
    reasons.push("stability:stable");
  }

  // Bias towards safer candidates when strategic context is strict.
  if (input.intent.governanceIntensity === "strict") {
    score += Math.max(0, 5 - Math.min(5, input.riskScore));
    score += Math.max(0, 4 - Math.min(4, input.rollbackComplexity));
  }

  const orderedReasons = sortedUnique(reasons);
  return {
    score,
    reasons: orderedReasons,
    hash: deterministicHash({
      strategyType: input.strategyType,
      score,
      reasons: orderedReasons,
    }),
  };
}

export function deriveRolloutBias(intent: StrategicIntent): RolloutBias {
  const preferences = new Set(intent.rolloutPreferences);
  const reasons: string[] = [];

  let preferred: RolloutBias["preferred"] = "all-at-once";
  if (preferences.has("canary-required")) {
    preferred = "canary";
    reasons.push("rolloutPreference:canary-required");
  } else if (preferences.has("phased-required") || preferences.has("phased-optional")) {
    preferred = "phased";
    reasons.push("rolloutPreference:phased");
  }

  let stageSizing: RolloutBias["stageSizing"] = "balanced";
  if (intent.riskTolerance === "low" || intent.governanceIntensity === "strict") {
    stageSizing = "slow";
    reasons.push("sizing:slow-for-low-risk");
  } else if (intent.riskTolerance === "high" && intent.stabilityProfile !== "stable") {
    stageSizing = "fast";
    reasons.push("sizing:fast-for-experimentation");
  }

  let rollbackAggressiveness: RolloutBias["rollbackAggressiveness"] = "normal";
  if (intent.governanceIntensity === "strict" || intent.stabilityProfile === "stable") {
    rollbackAggressiveness = "strict";
    reasons.push("rollback:strict");
  } else if (intent.governanceIntensity === "relaxed" && intent.riskTolerance === "high") {
    rollbackAggressiveness = "relaxed";
    reasons.push("rollback:relaxed");
  }

  let dependencyIsolation: RolloutBias["dependencyIsolation"] = "medium";
  if (intent.riskTolerance === "low" || intent.governanceIntensity === "strict") {
    dependencyIsolation = "high";
    reasons.push("dependencyIsolation:high");
  } else if (intent.riskTolerance === "high") {
    dependencyIsolation = "low";
    reasons.push("dependencyIsolation:low");
  }

  return {
    preferred,
    stageSizing,
    rollbackAggressiveness,
    dependencyIsolation,
    reasons: sortedUnique(reasons),
  };
}
