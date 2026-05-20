import type { OrchestrationTraceRecord } from "../core/orchestrationRuntimeTrace.js";
import type { StrategicSummaryView } from "../ui/contracts.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .sort((left, right) => left.localeCompare(right));
}

function deriveContextPackageDomains(contextsRaw: unknown): Map<string, string> {
  const packageDomains = new Map<string, string>();
  const contexts = asRecord(contextsRaw);
  if (!contexts) {
    return packageDomains;
  }

  const entries = Object.entries(contexts).sort(([left], [right]) => left.localeCompare(right));
  for (const [, value] of entries) {
    const context = asRecord(value);
    if (!context) {
      continue;
    }

    const domain = typeof context.domain === "string" && context.domain.trim().length > 0
      ? context.domain
      : undefined;
    if (!domain) {
      continue;
    }

    for (const packagePath of toStringArray(context.packages)) {
      if (!packageDomains.has(packagePath)) {
        packageDomains.set(packagePath, domain);
      }
    }
  }

  return packageDomains;
}

export function deriveStrategicSummary(controlPlane: object, trace?: OrchestrationTraceRecord | null): StrategicSummaryView | undefined {
  const record = controlPlane as Record<string, unknown>;
  const strategicIntentRaw = asRecord(record.strategicIntent);
  const domainsRaw = asRecord(record.domains);
  const packagesRaw = asRecord(record.packages);
  const contextPackageDomains = deriveContextPackageDomains(record.contexts);

  const global = strategicIntentRaw
    ? (() => {
      const mission = typeof strategicIntentRaw.mission === "string" ? strategicIntentRaw.mission : undefined;
      const priorities = toStringArray(strategicIntentRaw.priorities);
      const optimizationGoals = toStringArray(strategicIntentRaw.optimizationGoals);
      const riskTolerance = typeof strategicIntentRaw.riskTolerance === "string" ? strategicIntentRaw.riskTolerance : "moderate";
      const governanceIntensity = typeof strategicIntentRaw.governanceIntensity === "string" ? strategicIntentRaw.governanceIntensity : "moderate";
      const rolloutPreferences = toStringArray(strategicIntentRaw.rolloutPreferences);

      if (!mission && priorities.length === 0 && optimizationGoals.length === 0 && rolloutPreferences.length === 0) {
        return undefined;
      }

      return {
        ...(mission ? { mission } : {}),
        priorities,
        optimizationGoals,
        riskTolerance,
        governanceIntensity,
        rolloutPreferences,
      };
    })()
    : undefined;

  const domains = domainsRaw
    ? Object.entries(domainsRaw)
      .map(([id, value]) => {
        const domain = asRecord(value);
        if (!domain) {
          return null;
        }

        const mission = typeof domain.mission === "string" ? domain.mission : undefined;
        const intent = asRecord(domain.strategicIntent);
        const governanceIntensity = typeof intent?.governanceIntensity === "string" ? intent.governanceIntensity : undefined;
        const priorities = toStringArray(intent?.priorities);
        const rolloutPreferences = toStringArray(intent?.rolloutPreferences);

        if (!mission && !governanceIntensity && priorities.length === 0 && rolloutPreferences.length === 0) {
          return null;
        }

        return {
          id,
          ...(mission ? { mission } : {}),
          ...(governanceIntensity ? { governanceIntensity } : {}),
          priorities,
          rolloutPreferences,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => left.id.localeCompare(right.id))
    : [];

  const packages = packagesRaw
    ? Object.entries(packagesRaw)
      .map(([id, value]) => {
        const packageRecord = asRecord(value);
        if (!packageRecord) {
          return null;
        }

        const intent = asRecord(packageRecord.strategicIntent);
        const governanceIntensity = typeof intent?.governanceIntensity === "string" ? intent.governanceIntensity : undefined;
        const rolloutPreferences = toStringArray(intent?.rolloutPreferences);
        const directDomain = typeof packageRecord.domain === "string" && packageRecord.domain.trim().length > 0
          ? packageRecord.domain
          : undefined;
        const domain = directDomain ?? contextPackageDomains.get(id) ?? "unassigned";

        return {
          id,
          domain,
          ...(governanceIntensity ? { governanceIntensity } : {}),
          rolloutPreferences,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => left.id.localeCompare(right.id))
    : [];

  const selected = trace?.candidates.find((candidate) => candidate.selected)
    ?? (trace?.rankingOrder[0]
      ? trace.candidates.find((candidate) => candidate.id === trace.rankingOrder[0])
      : undefined);
  const selectedCandidate = selected
    ? {
      id: selected.id,
      strategyType: selected.strategyType,
      ...(typeof selected.strategicAlignment === "number" ? { strategicAlignment: selected.strategicAlignment } : {}),
      ...(selected.governanceIntensity ? { governanceIntensity: selected.governanceIntensity } : {}),
      ...(selected.strategicDomains ? { strategicDomains: [...selected.strategicDomains].sort((left, right) => left.localeCompare(right)) } : {}),
      ...(selected.rolloutBias
        ? {
          rolloutBias: {
            preferred: selected.rolloutBias.preferred,
            stageSizing: selected.rolloutBias.stageSizing,
            rollbackAggressiveness: selected.rolloutBias.rollbackAggressiveness,
            dependencyIsolation: selected.rolloutBias.dependencyIsolation,
            reasons: [...selected.rolloutBias.reasons],
          },
        }
        : {}),
    }
    : undefined;

  if (!global && domains.length === 0 && packages.length === 0 && !selectedCandidate) {
    return undefined;
  }

  return {
    ...(global ? { global } : {}),
    domains,
    packages,
    ...(selectedCandidate ? { selectedCandidate } : {}),
  };
}