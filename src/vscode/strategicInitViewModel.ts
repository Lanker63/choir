import type { ControlPlane } from "../schema.js";

export type DomainHeatmapRow = {
  id: string;
  governanceIntensity: string;
  riskTolerance: string;
  rolloutPreferences: string[];
};

export type PackageMappingRow = {
  id: string;
  domain: string;
  governanceIntensity: string;
};

type ParsedStrategicState = {
  modelsByDomain: Map<string, DomainHeatmapRow>;
  domainByPackage: Map<string, string>;
};

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
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function parseStrategicState(state: unknown): ParsedStrategicState {
  const modelsByDomain = new Map<string, DomainHeatmapRow>();
  const domainByPackage = new Map<string, string>();

  const stateRecord = asRecord(state);
  if (!stateRecord) {
    return { modelsByDomain, domainByPackage };
  }

  const rawModels = stateRecord.models;
  if (Array.isArray(rawModels)) {
    for (const rawModel of rawModels) {
      const model = asRecord(rawModel);
      if (!model) {
        continue;
      }

      const id = typeof model.id === "string" ? model.id.trim() : "";
      if (id.length === 0) {
        continue;
      }

      modelsByDomain.set(id, {
        id,
        governanceIntensity: typeof model.governanceIntensity === "string" ? model.governanceIntensity : "inherited",
        riskTolerance: typeof model.riskTolerance === "string" ? model.riskTolerance : "moderate",
        rolloutPreferences: toStringArray(model.rolloutPreferences),
      });
    }
  }

  const discovery = asRecord(stateRecord.discovery);
  const rawDomains = discovery?.domains;
  if (Array.isArray(rawDomains)) {
    for (const rawDomain of rawDomains) {
      const domain = asRecord(rawDomain);
      if (!domain) {
        continue;
      }

      const domainId = typeof domain.id === "string" ? domain.id.trim() : "";
      if (domainId.length === 0) {
        continue;
      }

      for (const packagePath of toStringArray(domain.packages)) {
        if (!domainByPackage.has(packagePath)) {
          domainByPackage.set(packagePath, domainId);
        }
      }
    }
  }

  return { modelsByDomain, domainByPackage };
}

export function deriveDomainHeatmapRows(control: ControlPlane | null, state: unknown): DomainHeatmapRow[] {
  const controlDomains = control?.domains
    ? Object.entries(control.domains)
      .map(([id, domain]) => ({
        id,
        governanceIntensity: domain.strategicIntent?.governanceIntensity ?? "inherited",
        riskTolerance: domain.strategicIntent?.riskTolerance ?? "moderate",
        rolloutPreferences: [...(domain.strategicIntent?.rolloutPreferences ?? [])].sort((left, right) => left.localeCompare(right)),
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
    : [];

  if (controlDomains.length > 0) {
    return controlDomains;
  }

  const parsed = parseStrategicState(state);
  return [...parsed.modelsByDomain.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function derivePackageMappingRows(control: ControlPlane | null, state: unknown): PackageMappingRow[] {
  const packages = control?.packages
    ? Object.entries(control.packages).sort(([left], [right]) => left.localeCompare(right))
    : [];

  const parsed = parseStrategicState(state);

  return packages.map(([id, pkg]) => {
    const domain = (typeof pkg.domain === "string" && pkg.domain.trim().length > 0)
      ? pkg.domain
      : (parsed.domainByPackage.get(id) ?? "unmapped");
    const governanceIntensity = pkg.strategicIntent?.governanceIntensity
      ?? parsed.modelsByDomain.get(domain)?.governanceIntensity
      ?? "inherited";

    return {
      id,
      domain,
      governanceIntensity,
    };
  });
}