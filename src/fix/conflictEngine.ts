import { comparePositions } from "../core/diagnostics.js";
import { Diagnostic, DiagnosticCategory, DiagnosticSeverity, SourceLocation } from "../core/types.js";
import { ControlPlane } from "../schema.js";
import { DeleteFilePatch, Fix, FixConflict, Patch, RenameFilePatch } from "./types.js";

export type RejectedFixReason =
  | "overlap"
  | "semantic-conflict"
  | "lower-priority"
  | "unsafe"
  | "dependency-failure";

export type RejectedFix = {
  fixId: string;
  reason: RejectedFixReason;
};

export type ConflictTrace = {
  evaluatedFixes: string[];
  selectedFixes: string[];
  rejectedFixes: RejectedFix[];
  conflicts: FixConflict[];
  decisions: string[];
};

export type ConflictEngineInput = {
  fixes: Fix[];
  diagnostics: Diagnostic[];
  controlPlane: ControlPlane;
};

export type ConflictEngineResult = {
  selectedFixes: Fix[];
  rejectedFixes: RejectedFix[];
  conflicts: FixConflict[];
  trace: ConflictTrace;
};

export type FixNode = {
  fix: Fix;
  score: number;
  dependencies: string[];
};

export type ConflictGraph = Map<string, Set<string>>;

type FixPair = {
  fixA: string;
  fixB: string;
};

type ConflictResolverContext = {
  reasons: ReadonlyArray<FixConflict["reason"]>;
  scoreA: number;
  scoreB: number;
};

export type ResolutionDecision = {
  winner: "a" | "b" | "none";
  reason?: RejectedFixReason;
};

export type ConflictResolver = (
  a: Fix,
  b: Fix,
  context: ConflictResolverContext
) => ResolutionDecision | undefined;

const conflictResolvers: ConflictResolver[] = [];

function registerConflictResolver(resolver: ConflictResolver): () => void {
  conflictResolvers.push(resolver);
  return () => {
    const index = conflictResolvers.indexOf(resolver);
    if (index >= 0) {
      conflictResolvers.splice(index, 1);
    }
  };
}

const PRIORITY: Record<DiagnosticCategory, number> = {
  AST: 5,
  semantic: 4,
  strategy: 3,
  pattern: 2,
};

const SEVERITY: Record<DiagnosticSeverity, number> = {
  error: 4,
  warning: 3,
  info: 2,
  hint: 1,
};

function normalizePair(a: string, b: string): FixPair {
  if (a.localeCompare(b) <= 0) {
    return { fixA: a, fixB: b };
  }

  return { fixA: b, fixB: a };
}

function pairKey(a: string, b: string): string {
  const normalized = normalizePair(a, b);
  return `${normalized.fixA}::${normalized.fixB}`;
}

function stableSortConflicts(conflicts: FixConflict[]): FixConflict[] {
  return [...conflicts].sort((left, right) => {
    if (left.fixA !== right.fixA) {
      return left.fixA.localeCompare(right.fixA);
    }

    if (left.fixB !== right.fixB) {
      return left.fixB.localeCompare(right.fixB);
    }

    return left.reason.localeCompare(right.reason);
  });
}

function dedupeConflicts(conflicts: FixConflict[]): FixConflict[] {
  const seen = new Set<string>();
  const deduped: FixConflict[] = [];

  for (const conflict of stableSortConflicts(conflicts)) {
    const key = `${conflict.fixA}::${conflict.fixB}::${conflict.reason}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(conflict);
  }

  return deduped;
}

export function overlaps(a: SourceLocation, b: SourceLocation): boolean {
  if (a.file !== b.file) {
    return false;
  }

  const aStartsBeforeBEnds = comparePositions(a.start, b.end) < 0;
  const bStartsBeforeAEnds = comparePositions(b.start, a.end) < 0;
  return aStartsBeforeBEnds && bStartsBeforeAEnds;
}

function conflictsFromDeleteFile(deleteFile: DeleteFilePatch, patch: Patch): boolean {
  if (patch.type === "delete-file") {
    return false;
  }

  if (patch.type === "rename-file") {
    return patch.from === deleteFile.file || patch.to === deleteFile.file;
  }

  if (patch.type === "create-file") {
    return patch.file === deleteFile.file;
  }

  return patch.location.file === deleteFile.file;
}

function renameFileConflicts(left: RenameFilePatch, right: RenameFilePatch): boolean {
  return left.from === right.from || left.to === right.to || left.from === right.to || left.to === right.from;
}

export function patchOverlap(a: Patch, b: Patch): boolean {
  if ((a.type === "replace" || a.type === "delete") && (b.type === "replace" || b.type === "delete")) {
    return overlaps(a.location, b.location);
  }

  return false;
}

function fileLevelConflict(a: Patch, b: Patch): boolean {
  if (a.type === "rename-file" && b.type === "rename-file") {
    return renameFileConflicts(a, b);
  }

  if (a.type === "delete-file") {
    return conflictsFromDeleteFile(a, b);
  }

  if (b.type === "delete-file") {
    return conflictsFromDeleteFile(b, a);
  }

  return false;
}

function fixPairPatchOverlap(a: Fix, b: Fix): boolean {
  return a.patches.some((left) => b.patches.some((right) => patchOverlap(left, right)));
}

function explicitSemanticConflict(a: Fix, b: Fix): boolean {
  return (a.conflictsWith ?? []).includes(b.id) || (b.conflictsWith ?? []).includes(a.id);
}

function ruleSemanticConflict(a: Fix, b: Fix): boolean {
  const aRule = a.ruleId.toLowerCase();
  const bRule = b.ruleId.toLowerCase();
  const aRenamesSymbol = aRule === "rename-symbol";
  const bRenamesSymbol = bRule === "rename-symbol";
  const aDeletesSymbol = aRule === "delete-symbol";
  const bDeletesSymbol = bRule === "delete-symbol";

  return (aRenamesSymbol && bDeletesSymbol) || (bRenamesSymbol && aDeletesSymbol);
}

export function semanticConflict(a: Fix, b: Fix): boolean {
  return explicitSemanticConflict(a, b) || ruleSemanticConflict(a, b);
}

function priorityWeight(category: DiagnosticCategory, controlPlane: ControlPlane): number {
  const override = controlPlane.policy.priorityOverrides?.[category];
  if (typeof override === "number" && Number.isFinite(override)) {
    return override;
  }

  return PRIORITY[category];
}

function computeScoreFromCategorySeverity(
  category: DiagnosticCategory,
  severity: DiagnosticSeverity,
  fix: Fix,
  controlPlane: ControlPlane
): number {
  return (
    priorityWeight(category, controlPlane) * 100
    + SEVERITY[severity] * 10
    + (fix.isPreferred ? 5 : 0)
    + (fix.isSafe !== false ? 3 : 0)
  );
}

export function score(fix: Fix, diagnostic: Diagnostic, controlPlane: ControlPlane): number {
  return computeScoreFromCategorySeverity(diagnostic.category, diagnostic.severity, fix, controlPlane);
}

function scoreForFix(fix: Fix, diagnosticsById: Map<string, Diagnostic>, controlPlane: ControlPlane): number {
  if (fix.diagnosticIds.length === 0) {
    throw new Error(`Fix ${fix.id} must declare at least one diagnosticId`);
  }

  let best = Number.NEGATIVE_INFINITY;
  for (const diagnosticId of fix.diagnosticIds) {
    const diagnostic = diagnosticsById.get(diagnosticId);
    if (!diagnostic) {
      throw new Error(`Fix ${fix.id} references missing diagnostic ${diagnosticId}`);
    }

    best = Math.max(best, score(fix, diagnostic, controlPlane));
  }

  if (best === Number.NEGATIVE_INFINITY) {
    throw new Error(`Fix ${fix.id} has no scoreable diagnostics`);
  }

  return best;
}

function buildFixNodes(input: ConflictEngineInput): FixNode[] {
  const diagnosticsById = new Map<string, Diagnostic>(
    input.diagnostics.map((diagnostic) => [diagnostic.id, diagnostic])
  );

  return [...input.fixes]
    .map((fix) => ({
      fix,
      score: scoreForFix(fix, diagnosticsById, input.controlPlane),
      dependencies: [...(fix.dependsOn ?? [])].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.fix.id.localeCompare(right.fix.id));
}

function addConflict(
  conflicts: FixConflict[],
  reasonsByPair: Map<string, Set<FixConflict["reason"]>>,
  fixA: string,
  fixB: string,
  reason: FixConflict["reason"]
): void {
  const normalized = normalizePair(fixA, fixB);
  conflicts.push({ ...normalized, reason });

  const key = pairKey(fixA, fixB);
  const reasons = reasonsByPair.get(key) ?? new Set<FixConflict["reason"]>();
  reasons.add(reason);
  reasonsByPair.set(key, reasons);
}

function buildConflicts(fixNodes: FixNode[]): {
  conflicts: FixConflict[];
  reasonsByPair: Map<string, Set<FixConflict["reason"]>>;
} {
  const conflicts: FixConflict[] = [];
  const reasonsByPair = new Map<string, Set<FixConflict["reason"]>>();

  for (let index = 0; index < fixNodes.length; index += 1) {
    const left = fixNodes[index];
    for (let nested = index + 1; nested < fixNodes.length; nested += 1) {
      const right = fixNodes[nested];
      let hasConflict = false;

      if (fixPairPatchOverlap(left.fix, right.fix)) {
        addConflict(conflicts, reasonsByPair, left.fix.id, right.fix.id, "overlapping-range");
        hasConflict = true;
      }

      const hasFileConflict = left.fix.patches.some((leftPatch) =>
        right.fix.patches.some((rightPatch) => fileLevelConflict(leftPatch, rightPatch))
      );
      if (hasFileConflict) {
        addConflict(conflicts, reasonsByPair, left.fix.id, right.fix.id, "file-conflict");
        hasConflict = true;
      }

      if (semanticConflict(left.fix, right.fix)) {
        addConflict(conflicts, reasonsByPair, left.fix.id, right.fix.id, "semantic-conflict");
        hasConflict = true;
      }

      if (hasConflict && left.score !== right.score) {
        addConflict(conflicts, reasonsByPair, left.fix.id, right.fix.id, "rule-priority");
      }
    }
  }

  return {
    conflicts: dedupeConflicts(conflicts),
    reasonsByPair,
  };
}

function buildConflictGraph(fixNodes: FixNode[], conflicts: FixConflict[]): ConflictGraph {
  const graph: ConflictGraph = new Map<string, Set<string>>();

  for (const node of fixNodes) {
    graph.set(node.fix.id, new Set<string>());
  }

  for (const conflict of conflicts) {
    graph.get(conflict.fixA)?.add(conflict.fixB);
    graph.get(conflict.fixB)?.add(conflict.fixA);
  }

  return graph;
}

function detectCircularDependencies(nodesById: Map<string, FixNode>): Set<string> {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];
  const inCycle = new Set<string>();

  const dfs = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      const cycleStart = stack.indexOf(nodeId);
      const cycleNodes = cycleStart >= 0 ? stack.slice(cycleStart) : [nodeId];
      for (const cycleNode of cycleNodes) {
        inCycle.add(cycleNode);
      }
      inCycle.add(nodeId);
      return;
    }

    if (visited.has(nodeId)) {
      return;
    }

    visiting.add(nodeId);
    stack.push(nodeId);

    const node = nodesById.get(nodeId);
    for (const dependency of node?.dependencies ?? []) {
      if (!nodesById.has(dependency)) {
        continue;
      }

      dfs(dependency);
    }

    stack.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
  };

  for (const nodeId of [...nodesById.keys()].sort((left, right) => left.localeCompare(right))) {
    dfs(nodeId);
  }

  return inCycle;
}

function isConflictGraphSaturated(fixIds: string[], graph: ConflictGraph): boolean {
  if (fixIds.length < 3) {
    return false;
  }

  return fixIds.every((fixId) => (graph.get(fixId)?.size ?? 0) >= fixIds.length - 1);
}

export function dependenciesMissing(fix: Fix, selectedFixIds: Set<string>): boolean {
  return (fix.dependsOn ?? []).some((dependency) => !selectedFixIds.has(dependency));
}

export function isSafeToApply(fix: Fix): boolean {
  if (fix.requiresConfirmation === true) {
    return false;
  }

  return fix.isSafe !== false;
}

function runCustomResolvers(
  candidate: Fix,
  selected: Fix,
  reasons: ReadonlyArray<FixConflict["reason"]>,
  scoreCandidate: number,
  scoreSelected: number
): ResolutionDecision | undefined {
  for (const resolver of conflictResolvers) {
    const decision = resolver(candidate, selected, {
      reasons,
      scoreA: scoreCandidate,
      scoreB: scoreSelected,
    });

    if (decision) {
      return decision;
    }
  }

  return undefined;
}

function determineConflictRejectionReason(
  candidate: Fix,
  selectedFix: Fix,
  pairReasons: ReadonlyArray<FixConflict["reason"]>,
  scoreCandidate: number,
  scoreSelected: number,
  resolverDecision?: ResolutionDecision
): RejectedFixReason {
  if (resolverDecision?.winner === "b") {
    return resolverDecision.reason ?? "lower-priority";
  }

  if (scoreCandidate < scoreSelected) {
    return "lower-priority";
  }

  if (scoreCandidate === scoreSelected && candidate.id.localeCompare(selectedFix.id) > 0) {
    return "lower-priority";
  }

  if (pairReasons.includes("semantic-conflict")) {
    return "semantic-conflict";
  }

  return "overlap";
}

function sortFixesBySelectionOrder(nodes: FixNode[]): FixNode[] {
  return [...nodes].sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }

    return left.fix.id.localeCompare(right.fix.id);
  });
}

function registerRejection(
  rejectedById: Map<string, RejectedFixReason>,
  fixId: string,
  reason: RejectedFixReason
): void {
  if (!rejectedById.has(fixId)) {
    rejectedById.set(fixId, reason);
  }
}

export function runConflictResolutionEngine(input: ConflictEngineInput): ConflictEngineResult {
  const fixNodes = buildFixNodes(input);
  const nodesById = new Map<string, FixNode>(fixNodes.map((node) => [node.fix.id, node]));
  const { conflicts, reasonsByPair } = buildConflicts(fixNodes);
  const conflictGraph = buildConflictGraph(fixNodes, conflicts);
  const sortedFixes = sortFixesBySelectionOrder(fixNodes);

  const selectedFixIds = new Set<string>();
  const selectedFixes: Fix[] = [];
  const rejectedById = new Map<string, RejectedFixReason>();
  const decisions: string[] = [];
  const evaluatedFixes: string[] = [];

  const circularFixes = detectCircularDependencies(nodesById);
  for (const fixId of [...circularFixes].sort((left, right) => left.localeCompare(right))) {
    registerRejection(rejectedById, fixId, "dependency-failure");
    decisions.push(`Rejected ${fixId}: circular dependency detected`);
  }

  const fixIds = fixNodes.map((node) => node.fix.id);
  if (isConflictGraphSaturated(fixIds, conflictGraph)) {
    decisions.push("Conflict graph saturated; rejecting all fixes");

    const rejectedFixes = fixIds
      .sort((left, right) => left.localeCompare(right))
      .map((fixId) => ({
        fixId,
        reason: "overlap" as RejectedFixReason,
      }));

    return {
      selectedFixes: [],
      rejectedFixes,
      conflicts,
      trace: {
        evaluatedFixes: [...fixIds].sort((left, right) => left.localeCompare(right)),
        selectedFixes: [],
        rejectedFixes,
        conflicts,
        decisions,
      },
    };
  }

  for (const node of sortedFixes) {
    const fix = node.fix;
    evaluatedFixes.push(fix.id);

    if (rejectedById.has(fix.id)) {
      continue;
    }

    if (!isSafeToApply(fix)) {
      registerRejection(rejectedById, fix.id, "unsafe");
      decisions.push(`Rejected ${fix.id}: unsafe fix requires confirmation`);
      continue;
    }

    if (dependenciesMissing(fix, selectedFixIds)) {
      registerRejection(rejectedById, fix.id, "dependency-failure");
      decisions.push(`Rejected ${fix.id}: dependencies missing`);
      continue;
    }

    const conflictingSelectedFixes = [...selectedFixIds]
      .sort((left, right) => left.localeCompare(right))
      .filter((selectedId) => conflictGraph.get(fix.id)?.has(selectedId));

    if (conflictingSelectedFixes.length > 0) {
      let rejectedReason: RejectedFixReason = "overlap";

      for (const selectedId of conflictingSelectedFixes) {
        const selectedNode = nodesById.get(selectedId);
        if (!selectedNode) {
          continue;
        }

        const reasons = [...(reasonsByPair.get(pairKey(fix.id, selectedId)) ?? new Set<FixConflict["reason"]>())]
          .sort((left, right) => left.localeCompare(right));
        const resolverDecision = runCustomResolvers(
          fix,
          selectedNode.fix,
          reasons,
          node.score,
          selectedNode.score
        );

        if (resolverDecision?.winner === "a") {
          continue;
        }

        rejectedReason = determineConflictRejectionReason(
          fix,
          selectedNode.fix,
          reasons,
          node.score,
          selectedNode.score,
          resolverDecision
        );

        break;
      }

      registerRejection(rejectedById, fix.id, rejectedReason);
      decisions.push(`Rejected ${fix.id}: conflicts with selected fix (${rejectedReason})`);
      continue;
    }

    selectedFixIds.add(fix.id);
    selectedFixes.push(fix);
    decisions.push(`Selected ${fix.id} (score=${node.score})`);
  }

  const rejectedFixes = [...rejectedById.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fixId, reason]) => ({ fixId, reason }));

  return {
    selectedFixes,
    rejectedFixes,
    conflicts,
    trace: {
      evaluatedFixes,
      selectedFixes: selectedFixes.map((fix) => fix.id),
      rejectedFixes,
      conflicts,
      decisions,
    },
  };
}
