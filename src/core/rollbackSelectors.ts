import { ExecutionStage } from "./globalOrchestration.js";

type StageAliasMatch = {
  order: number;
  mode: "batch" | "order";
};

function canonicalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseStageAlias(value: string): StageAliasMatch | null {
  const trimmed = value.trim().toLowerCase();

  const batchMatch = trimmed.match(/^batch-l(\d+)-\d+$/i) ?? trimmed.match(/^batch-(\d+)$/i);
  if (batchMatch) {
    return {
      order: Number(batchMatch[1]),
      mode: "batch",
    };
  }

  const orderMatch = trimmed.match(/^stage-(\d+)$/i) ?? trimmed.match(/^l(\d+)$/i) ?? trimmed.match(/^(\d+)$/);
  if (orderMatch) {
    return {
      order: Number(orderMatch[1]),
      mode: "order",
    };
  }

  return null;
}

export function resolveRollbackStageSelection(
  selector: string,
  stages: ExecutionStage[]
): {
  stage?: ExecutionStage;
  matchedBy?: "exact-id" | "canonical-id" | "batch-alias" | "order-alias";
  error?: string;
} {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    return {
      error: "Rollback stage selector is empty.",
    };
  }

  const exact = stages.find((stage) => stage.id === trimmed);
  if (exact) {
    return {
      stage: exact,
      matchedBy: "exact-id",
    };
  }

  const canonicalRequested = canonicalize(trimmed);
  const canonicalMatches = stages.filter((stage) => canonicalize(stage.id) === canonicalRequested);
  if (canonicalMatches.length === 1) {
    return {
      stage: canonicalMatches[0],
      matchedBy: "canonical-id",
    };
  }

  if (canonicalMatches.length > 1) {
    return {
      error: `Rollback stage selector is ambiguous: ${trimmed}`,
    };
  }

  const alias = parseStageAlias(trimmed);
  if (alias) {
    const stage = stages.find((entry) => entry.order === alias.order);
    if (stage) {
      return {
        stage,
        matchedBy: alias.mode === "batch" ? "batch-alias" : "order-alias",
      };
    }
  }

  return {
    error: `No deterministic stage mapping found for selector: ${trimmed}`,
  };
}

export function resolveRollbackUnitSelection(
  selector: string,
  units: string[],
  options?: {
    workUnitBindings?: Record<string, string[]>;
  }
): {
  unit?: string;
  matchedBy?: "exact-id" | "canonical-id" | "work-unit-id";
  error?: string;
} {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    return {
      error: "Rollback unit selector is empty.",
    };
  }

  if (units.includes(trimmed)) {
    return {
      unit: trimmed,
      matchedBy: "exact-id",
    };
  }

  const workUnitBindings = options?.workUnitBindings ?? {};
  const exactWorkUnitMatch = Object.prototype.hasOwnProperty.call(workUnitBindings, trimmed)
    ? workUnitBindings[trimmed]
    : undefined;
  if (exactWorkUnitMatch) {
    const candidates = Array.from(new Set(exactWorkUnitMatch)).sort((left, right) => left.localeCompare(right));
    if (candidates.length === 1) {
      return {
        unit: candidates[0],
        matchedBy: "work-unit-id",
      };
    }

    return {
      error: `Rollback work unit selector is ambiguous: ${trimmed} -> [${candidates.join(", ")}]`,
    };
  }

  const canonicalRequested = canonicalize(trimmed);
  const canonicalMatches = units.filter((unit) => canonicalize(unit) === canonicalRequested);
  if (canonicalMatches.length === 1) {
    return {
      unit: canonicalMatches[0],
      matchedBy: "canonical-id",
    };
  }

  const canonicalWorkUnitMatches = Object.entries(workUnitBindings)
    .filter(([workUnitId]) => canonicalize(workUnitId) === canonicalRequested)
    .map(([, boundUnits]) => boundUnits)
    .flat();
  if (canonicalWorkUnitMatches.length > 0) {
    const candidates = Array.from(new Set(canonicalWorkUnitMatches)).sort((left, right) => left.localeCompare(right));
    if (candidates.length === 1) {
      return {
        unit: candidates[0],
        matchedBy: "work-unit-id",
      };
    }

    return {
      error: `Rollback work unit selector is ambiguous: ${trimmed} -> [${candidates.join(", ")}]`,
    };
  }

  if (canonicalMatches.length > 1) {
    return {
      error: `Rollback unit selector is ambiguous: ${trimmed}`,
    };
  }

  return {
    error: `No deterministic unit mapping found for selector: ${trimmed}`,
  };
}
