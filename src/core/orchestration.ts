import { createHash } from "crypto";
import { ControlPlane, Plan, Task } from "../schema.js";
import { StatePlane } from "./state.js";

export function taskExecutionKey(planId: string, taskId: string): string {
  return `${planId}:${taskId}`;
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function normalizePath(value: string): string {
  const normalized = value.split("\\").join("/");
  if (normalized.startsWith("./")) {
    return normalized.slice(2);
  }

  return normalized;
}

function directoryOf(filePath: string): string {
  const normalized = normalizePath(filePath);
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) {
    return "";
  }

  return normalized.slice(0, lastSlash);
}

function joinRelative(baseDir: string, relative: string): string {
  const baseParts = baseDir.split("/").filter((part) => part.length > 0);
  const relativeParts = relative.split("/").filter((part) => part.length > 0);
  const merged = [...baseParts];

  for (const part of relativeParts) {
    if (part === ".") {
      continue;
    }

    if (part === "..") {
      merged.pop();
      continue;
    }

    merged.push(part);
  }

  return merged.join("/");
}

type Violation = StatePlane["violations"][number];

type RuleGroup = {
  ruleId: string;
  violations: Violation[];
  bestSeverityRank: number;
};

const severityRank: Record<Violation["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function constraintAliases(constraint: string): string[] {
  const normalized = constraint.toLowerCase();

  if (normalized.includes("no direct db access")) {
    return ["intent-no-direct-db-access"];
  }

  if (normalized.includes("no eval")) {
    return ["intent-no-eval"];
  }

  if (normalized.includes("no console.log") || normalized.includes("no console log")) {
    return ["intent-no-console-log"];
  }

  return [`intent-constraint-${slugify(constraint)}`];
}

function sortViolations(violations: Violation[]): Violation[] {
  return [...violations].sort((left, right) => {
    if (left.ruleId !== right.ruleId) return left.ruleId.localeCompare(right.ruleId);
    if (left.location.file !== right.location.file) return left.location.file.localeCompare(right.location.file);
    if (left.location.start.line !== right.location.start.line) return left.location.start.line - right.location.start.line;
    if (left.location.start.character !== right.location.start.character) {
      return left.location.start.character - right.location.start.character;
    }
    if (left.severity !== right.severity) return severityRank[left.severity] - severityRank[right.severity];
    return left.message.localeCompare(right.message);
  });
}

export function filterViolations(control: ControlPlane, state: StatePlane): Violation[] {
  const constraints = sortedUnique(control.intent.constraints);
  if (constraints.length === 0) {
    return sortViolations(state.violations);
  }

  const allowedRuleIds = new Set<string>();

  for (const rule of control.policy.rules) {
    allowedRuleIds.add(rule.id);
  }

  for (const constraint of constraints) {
    allowedRuleIds.add(constraint);
    for (const alias of constraintAliases(constraint)) {
      allowedRuleIds.add(alias);
    }
  }

  return sortViolations(
    state.violations.filter((violation) => allowedRuleIds.has(violation.ruleId))
  );
}

export function groupByRule(violations: Violation[]): Map<string, Violation[]> {
  const grouped = new Map<string, Violation[]>();

  for (const violation of sortViolations(violations)) {
    const existing = grouped.get(violation.ruleId) ?? [];
    existing.push(violation);
    grouped.set(violation.ruleId, existing);
  }

  return new Map([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function buildFileLookup(files: string[]): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const file of sortedUnique(files.map((entry) => normalizePath(entry)))) {
    const withoutExt = file.replace(/\.(ts|tsx|js|jsx)$/i, "");
    lookup.set(file, file);
    lookup.set(withoutExt, file);

    if (file.endsWith("/index.ts")) {
      const root = file.slice(0, -"/index.ts".length);
      lookup.set(root, file);
      lookup.set(`${root}/index`, file);
    }
  }

  return lookup;
}

function resolveDependency(
  sourceFile: string,
  dependency: string,
  fileLookup: Map<string, string>
): string | undefined {
  const rawDependency = dependency.split("\\").join("/");
  const normalizedDependency = normalizePath(rawDependency);

  const direct = fileLookup.get(normalizedDependency);
  if (direct) {
    return direct;
  }

  const candidates = new Set<string>([
    normalizedDependency,
    `${normalizedDependency}.ts`,
    `${normalizedDependency}.tsx`,
    `${normalizedDependency}.js`,
    `${normalizedDependency}/index.ts`,
    `${normalizedDependency}/index.tsx`,
    `${normalizedDependency}/index.js`,
  ]);

  if (rawDependency.startsWith(".")) {
    const baseDir = directoryOf(sourceFile);
    const resolved = joinRelative(baseDir, rawDependency);

    candidates.add(resolved);
    candidates.add(`${resolved}.ts`);
    candidates.add(`${resolved}.tsx`);
    candidates.add(`${resolved}.js`);
    candidates.add(`${resolved}/index.ts`);
    candidates.add(`${resolved}/index.tsx`);
    candidates.add(`${resolved}/index.js`);
  }

  for (const candidate of [...candidates].sort((left, right) => left.localeCompare(right))) {
    const resolved = fileLookup.get(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

export function computeLayers(files: string[], dependencyGraph: StatePlane["dependencyGraph"]): string[][] {
  const normalizedFiles = sortedUnique(files.map((file) => normalizePath(file)));
  if (normalizedFiles.length === 0) {
    return [];
  }

  const lookup = buildFileLookup(normalizedFiles);
  const dependencyMap = new Map<string, string[]>(
    normalizedFiles.map((file) => {
      const rawDeps = dependencyGraph[file] ?? [];
      const resolved = sortedUnique(
        rawDeps
          .map((dep) => resolveDependency(file, dep, lookup))
          .filter((dep): dep is string => typeof dep === "string")
      );

      return [file, resolved] as const;
    })
  );

  const layers: string[][] = [];
  const remaining = new Set(normalizedFiles);

  while (remaining.size > 0) {
    const layer = [...remaining]
      .sort((left, right) => left.localeCompare(right))
      .filter((file) => {
        const deps = dependencyMap.get(file) ?? [];
        return deps.every((dep) => !remaining.has(dep));
      });

    if (layer.length === 0) {
      const cycle = [...remaining].sort((left, right) => left.localeCompare(right));
      throw new Error(`Cycle detected in dependency graph for files: ${cycle.join(", ")}`);
    }

    for (const file of layer) {
      remaining.delete(file);
    }

    layers.push(layer);
  }

  return layers;
}

function generateDeterministicId(control: ControlPlane, violations: Violation[]): string {
  const payload = {
    goals: sortedUnique(control.intent.goals),
    constraints: sortedUnique(control.intent.constraints),
    violations: sortViolations(violations).map((violation) => ({
      ruleId: violation.ruleId,
      file: normalizePath(violation.location.file),
      startLine: violation.location.start.line,
      startCharacter: violation.location.start.character,
    })),
  };

  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `plan-${digest.slice(0, 12)}`;
}

function createAnalysisTask(): Task {
  return {
    id: "t-analysis",
    title: "Analyze violations",
    description: "Enumerate relevant violations and establish deterministic remediation scope.",
    type: "analysis",
    dependsOn: [],
    successCriteria: ["violations enumerated"],
  };
}

function createValidationTask(refactorTasks: Task[]): Task {
  return {
    id: "t-validate",
    title: "Validate all constraints",
    description: "Run policy enforcement to verify that constraints are satisfied.",
    type: "enforce",
    dependsOn: refactorTasks.length > 0
      ? refactorTasks.map((task) => task.id)
      : ["t-analysis"],
    successCriteria: ["zero violations"],
  };
}

function collectRuleGroups(grouped: Map<string, Violation[]>): RuleGroup[] {
  return [...grouped.entries()]
    .map(([ruleId, violations]) => {
      const bestSeverityRank = violations.reduce((best, violation) => {
        const rank = severityRank[violation.severity];
        return rank < best ? rank : best;
      }, severityRank.hint);

      return {
        ruleId,
        violations,
        bestSeverityRank,
      } satisfies RuleGroup;
    })
    .sort((left, right) => {
      if (left.bestSeverityRank !== right.bestSeverityRank) return left.bestSeverityRank - right.bestSeverityRank;
      if (left.violations.length !== right.violations.length) return right.violations.length - left.violations.length;
      return left.ruleId.localeCompare(right.ruleId);
    });
}

function orderFilesForGroup(files: string[], layers: string[][]): string[] {
  const fileSet = new Set(files.map((file) => normalizePath(file)));
  const orderedFromLayers = layers.flatMap((layer) =>
    layer.filter((file) => fileSet.has(file))
  );
  const remaining = [...fileSet]
    .filter((file) => !orderedFromLayers.includes(file))
    .sort((left, right) => left.localeCompare(right));

  return [...orderedFromLayers, ...remaining];
}

function createRefactorTasks(grouped: Map<string, Violation[]>, layers: string[][]): Task[] {
  const rankedGroups = collectRuleGroups(grouped);

  return rankedGroups.map((group, index) => {
    const groupFiles = sortedUnique(group.violations.map((violation) => normalizePath(violation.location.file)));
    const orderedFiles = orderFilesForGroup(groupFiles, layers);

    return {
      id: `t-refactor-${index + 1}`,
      title: `Fix ${group.ruleId} violations`,
      description: `Resolve ${group.violations.length} violation(s) for rule ${group.ruleId}.`,
      type: "refactor",
      scope: {
        files: orderedFiles,
      },
      dependsOn: ["t-analysis"],
      successCriteria: [
        `no ${group.ruleId} violations remain`,
      ],
    } satisfies Task;
  });
}

function deriveSource(control: ControlPlane): { derivedFrom: "goal" | "constraint"; refs: string[] } {
  const goals = sortedUnique(control.intent.goals);
  if (goals.length > 0) {
    return {
      derivedFrom: "goal",
      refs: goals,
    };
  }

  return {
    derivedFrom: "constraint",
    refs: sortedUnique(control.intent.constraints),
  };
}

export function generatePlan(control: ControlPlane, state: StatePlane): Plan {
  const filteredViolations = filterViolations(control, state);
  const grouped = groupByRule(filteredViolations);
  const files = sortedUnique(filteredViolations.map((violation) => normalizePath(violation.location.file)));
  const layers = computeLayers(files, state.dependencyGraph);
  const analysisTask = createAnalysisTask();
  const refactorTasks = createRefactorTasks(grouped, layers);
  const validationTask = createValidationTask(refactorTasks);
  const { derivedFrom, refs } = deriveSource(control);

  return {
    id: generateDeterministicId(control, filteredViolations),
    title: "Auto-generated enforcement plan",
    derivedFrom,
    goalRefs: refs,
    tasks: [analysisTask, ...refactorTasks, validationTask],
    status: "draft",
  };
}

function isTaskComplete(plan: Plan, state: StatePlane, taskId: string): boolean {
  const key = taskExecutionKey(plan.id, taskId);
  return state.execution.taskStatus[key] === "complete";
}

export function getExecutableTasks(plan: Plan, state: StatePlane): Task[] {
  return plan.tasks.filter((task) => {
    const taskKey = taskExecutionKey(plan.id, task.id);
    if (state.execution.taskStatus[taskKey] === "complete") {
      return false;
    }

    const dependencies = task.dependsOn ?? [];
    return dependencies.every((dependencyId) => isTaskComplete(plan, state, dependencyId));
  });
}
