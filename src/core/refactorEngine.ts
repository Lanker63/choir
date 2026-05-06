import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import ts from "typescript";
import { Node, Project, SyntaxKind } from "ts-morph";
import { buildWorkspaceSnapshot, WorkspaceSnapshot } from "./context.js";
import { generateDiff } from "./executionPreview.js";
import { createNodeTransactionFS } from "./scheduler.js";
import { ControlPlane } from "../schema.js";
import { runPipeline } from "./pipeline.js";
import { readStatePlane, StatePlane, validateState } from "./state.js";
import { Diagnostic, SourceLocation } from "./types.js";

export type Pattern = {
  kind: "identifier";
  value: string;
};

export type RefactorIntent =
  | { type: "rename"; symbol: string; newName: string }
  | { type: "extract"; symbol: string; targetUnit: string }
  | { type: "move"; symbol: string; from: string; to: string }
  | { type: "inline"; symbol: string }
  | { type: "replace-pattern"; match: Pattern; replace: Pattern };

export type SymbolNode = {
  id: string;
  name: string;
  kind: string;
  declaration: SourceLocation;
  unitId: string;
};

export type SymbolGraph = {
  symbols: Map<string, SymbolNode>;
  references: {
    symbolId: string;
    locations: SourceLocation[];
  }[];
};

export type ImpactSet = {
  affectedUnits: string[];
  affectedFiles: string[];
  affectedSymbols: string[];
};

export type ASTTransformation = {
  id: string;
  description: string;
  apply(ast: ts.Node): ts.Node;
};

export type RefactorStep = {
  unitId: string;
  file: string;
  transformation: ASTTransformation;
};

export type RefactorPlan = {
  intent: RefactorIntent;
  impact: ImpactSet;
  steps: RefactorStep[];
  dependencyOrder: string[];
};

export type RefactorPreview = {
  hash: string;
  changes: {
    file: string;
    before: string;
    after: string;
    diff: string;
  }[];
};

export type PolicyDecision = {
  allowed: boolean;
  violations: string[];
};

export type RefactorValidationResult = {
  passed: boolean;
  astValid: boolean;
  ruleDiagnostics: Diagnostic[];
  policy: PolicyDecision;
  missingReferenceErrors: string[];
  consistencyErrors: string[];
};

export type SimulationResult = {
  plan: RefactorPlan;
  preview: RefactorPreview;
  validation: RefactorValidationResult;
};

export type RefactorTrace = {
  intent: RefactorIntent;
  affectedUnits: string[];
  stepsExecuted: number;
  validationPassed: boolean;
};

export type RefactorExecutionResult = {
  committed: boolean;
  snapshotId?: string;
  rolledBack: boolean;
  trace: RefactorTrace;
};

export type RunRefactorOptions = {
  root: string;
  controlPlane: ControlPlane;
  execute?: boolean;
};

export type RunRefactorResult = {
  symbolGraph: SymbolGraph;
  impact: ImpactSet;
  plan: RefactorPlan;
  preview: RefactorPreview;
  simulation: SimulationResult;
  execution?: RefactorExecutionResult;
};

type RefactorSnapshot = {
  id: string;
  createdAt: string;
  files: Record<string, string>;
  state: StatePlane | null;
};

type FileMap = Record<string, string>;

type RefactorApplyResult = {
  changedFiles: FileMap;
};

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function toStableFilePath(root: string, value: string): string {
  const relative = normalizePath(path.relative(root, value));
  if (relative.startsWith("../") || path.isAbsolute(relative)) {
    return normalizePath(value);
  }

  return relative;
}

function toAbsolute(root: string, value: string): string {
  return path.resolve(root, value);
}

function toSourceLocation(root: string, filePath: string, start: number, end: number, source: ts.SourceFile): SourceLocation {
  const startPosition = source.getLineAndCharacterOfPosition(start);
  const endPosition = source.getLineAndCharacterOfPosition(end);

  return {
    file: toStableFilePath(root, filePath),
    start: {
      line: startPosition.line,
      character: startPosition.character,
    },
    end: {
      line: endPosition.line,
      character: endPosition.character,
    },
  };
}

function makeHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function createProject(snapshot: WorkspaceSnapshot): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipLoadingLibFiles: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
  });

  const sortedFiles = [...snapshot.files].sort((left, right) => left.path.localeCompare(right.path));
  for (const file of sortedFiles) {
    project.createSourceFile(file.path, file.content, { overwrite: true });
  }

  return project;
}

function resolveWorkspaceDeclarations(symbol: import("ts-morph").Symbol, sourceFiles: Set<string>): Node[] {
  return symbol
    .getDeclarations()
    .filter((declaration) => sourceFiles.has(declaration.getSourceFile().getFilePath()));
}

function deriveUnitId(root: string, filePath: string): string {
  const relative = toStableFilePath(root, filePath);
  const segments = relative.split("/").filter((segment) => segment.length > 0);
  if (segments.length >= 2 && ["packages", "apps", "services", "libs"].includes(segments[0])) {
    return `${segments[0]}:${segments[1]}`;
  }

  return "workspace:root";
}

function makeSymbolId(symbol: import("ts-morph").Symbol, root: string, sourceFiles: Set<string>): string | null {
  const declarations = resolveWorkspaceDeclarations(symbol, sourceFiles);
  if (declarations.length === 0) {
    return null;
  }

  const ordered = [...declarations].sort((left, right) => {
    const leftPath = left.getSourceFile().getFilePath();
    const rightPath = right.getSourceFile().getFilePath();
    if (leftPath !== rightPath) {
      return leftPath.localeCompare(rightPath);
    }

    return left.getStart() - right.getStart();
  });

  const declaration = ordered[0];
  const filePath = toStableFilePath(root, declaration.getSourceFile().getFilePath());
  const symbolName = symbol.getEscapedName();
  return `${filePath}:${declaration.getStart()}:${symbolName}`;
}

function symbolNodeFromDeclaration(symbolId: string, declaration: Node, root: string): SymbolNode {
  const sourceFile = declaration.getSourceFile();
  const compilerNode = sourceFile.compilerNode;
  const location = toSourceLocation(
    root,
    sourceFile.getFilePath(),
    declaration.getStart(),
    declaration.getEnd(),
    compilerNode
  );

  return {
    id: symbolId,
    name: declaration.getSymbol()?.getName() ?? declaration.getText(),
    kind: declaration.getKindName(),
    declaration: location,
    unitId: deriveUnitId(root, sourceFile.getFilePath()),
  };
}

export function buildRefactorSymbolGraph(snapshot: WorkspaceSnapshot): SymbolGraph {
  const project = createProject(snapshot);
  const sourceFiles = new Set(project.getSourceFiles().map((sourceFile) => sourceFile.getFilePath()));
  const symbols = new Map<string, SymbolNode>();
  const refs = new Map<string, Set<string>>();
  const locationsByKey = new Map<string, SourceLocation>();

  const sortedFiles = project.getSourceFiles().sort((left, right) => left.getFilePath().localeCompare(right.getFilePath()));
  for (const sourceFile of sortedFiles) {
    const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
    for (const identifier of identifiers) {
      const symbol = identifier.getSymbol();
      if (!symbol) {
        continue;
      }

      const symbolId = makeSymbolId(symbol, snapshot.root, sourceFiles);
      if (!symbolId) {
        continue;
      }

      if (!symbols.has(symbolId)) {
        const declarations = resolveWorkspaceDeclarations(symbol, sourceFiles)
          .sort((left, right) => left.getStart() - right.getStart());
        if (declarations.length === 0) {
          continue;
        }

        symbols.set(symbolId, symbolNodeFromDeclaration(symbolId, declarations[0], snapshot.root));
      }

      const location = toSourceLocation(
        snapshot.root,
        sourceFile.getFilePath(),
        identifier.getStart(),
        identifier.getEnd(),
        sourceFile.compilerNode
      );
      const locationKey = `${location.file}:${location.start.line}:${location.start.character}:${location.end.line}:${location.end.character}`;

      if (!refs.has(symbolId)) {
        refs.set(symbolId, new Set<string>());
      }

      refs.get(symbolId)?.add(locationKey);
      locationsByKey.set(locationKey, location);
    }
  }

  const references = [...refs.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([symbolId, locationKeys]) => ({
      symbolId,
      locations: [...locationKeys]
        .sort((left, right) => left.localeCompare(right))
        .map((key) => locationsByKey.get(key) as SourceLocation),
    }));

  return {
    symbols,
    references,
  };
}

function resolveIntentSymbolIds(intent: RefactorIntent, graph: SymbolGraph): string[] {
  const symbolName = intent.type === "replace-pattern"
    ? intent.match.value
    : intent.symbol;

  return [...graph.symbols.values()]
    .filter((symbol) => symbol.name === symbolName)
    .map((symbol) => symbol.id)
    .sort((left, right) => left.localeCompare(right));
}

function stableImpact(impact: ImpactSet): ImpactSet {
  return {
    affectedUnits: sortedUnique(impact.affectedUnits),
    affectedFiles: sortedUnique(impact.affectedFiles),
    affectedSymbols: sortedUnique(impact.affectedSymbols),
  };
}

export function computeImpact(intent: RefactorIntent, graph: SymbolGraph): ImpactSet {
  const symbolIds = resolveIntentSymbolIds(intent, graph);
  if (symbolIds.length === 0) {
    throw new Error(`Unable to resolve symbol for refactor intent: ${intent.type}`);
  }

  const files = new Set<string>();
  const units = new Set<string>();

  for (const symbolId of symbolIds) {
    const symbol = graph.symbols.get(symbolId);
    if (symbol) {
      files.add(symbol.declaration.file);
      units.add(symbol.unitId);
    }

    const references = graph.references.find((entry) => entry.symbolId === symbolId);
    for (const location of references?.locations ?? []) {
      files.add(location.file);
      if (symbol) {
        units.add(symbol.unitId);
      }
    }
  }

  if (intent.type === "move" || intent.type === "extract") {
    units.add(intent.type === "move" ? intent.to : intent.targetUnit);
  }

  return stableImpact({
    affectedUnits: [...units],
    affectedFiles: [...files],
    affectedSymbols: symbolIds,
  });
}

function resolveRelativeImport(baseFile: string, specifier: string, existingFiles: Set<string>): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const root = path.resolve(path.dirname(baseFile), specifier);
  const candidates = [
    root,
    `${root}.ts`,
    `${root}.tsx`,
    path.join(root, "index.ts"),
    path.join(root, "index.tsx"),
  ];

  for (const candidate of candidates) {
    if (existingFiles.has(normalizePath(candidate))) {
      return normalizePath(candidate);
    }
  }

  return null;
}

function buildDependencyOrder(snapshot: WorkspaceSnapshot, affectedUnits: string[]): string[] {
  const unitDependencies = new Map<string, Set<string>>();
  const absoluteFiles = snapshot.files.map((file) => normalizePath(file.path));
  const knownFiles = new Set(absoluteFiles);

  for (const file of snapshot.files) {
    const unit = deriveUnitId(snapshot.root, file.path);
    if (!unitDependencies.has(unit)) {
      unitDependencies.set(unit, new Set<string>());
    }

    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }

      const resolved = resolveRelativeImport(file.path, statement.moduleSpecifier.text, knownFiles);
      if (!resolved) {
        continue;
      }

      const dependencyUnit = deriveUnitId(snapshot.root, resolved);
      if (dependencyUnit !== unit) {
        unitDependencies.get(unit)?.add(dependencyUnit);
      }
    }
  }

  const impacted = new Set(affectedUnits);
  const indegree = new Map<string, number>();
  for (const unit of impacted) {
    const deps = [...(unitDependencies.get(unit) ?? new Set<string>())].filter((dep) => impacted.has(dep));
    indegree.set(unit, deps.length);
  }

  const dependents = new Map<string, Set<string>>();
  for (const unit of impacted) {
    dependents.set(unit, new Set<string>());
  }

  for (const unit of impacted) {
    const deps = [...(unitDependencies.get(unit) ?? new Set<string>())].filter((dep) => impacted.has(dep));
    for (const dependency of deps) {
      dependents.get(dependency)?.add(unit);
    }
  }

  const queue = [...impacted].filter((unit) => (indegree.get(unit) ?? 0) === 0).sort((a, b) => a.localeCompare(b));
  const order: string[] = [];

  while (queue.length > 0) {
    const unit = queue.shift() as string;
    order.push(unit);

    const nextDependents = [...(dependents.get(unit) ?? new Set<string>())].sort((a, b) => a.localeCompare(b));
    for (const dependent of nextDependents) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        queue.push(dependent);
        queue.sort((a, b) => a.localeCompare(b));
      }
    }
  }

  if (order.length !== impacted.size) {
    return [...impacted].sort((left, right) => left.localeCompare(right));
  }

  return order;
}

function noOpTransformation(id: string, description: string): ASTTransformation {
  return {
    id,
    description,
    apply(ast: ts.Node): ts.Node {
      return ast;
    },
  };
}

export function buildRefactorPlan(intent: RefactorIntent, snapshot: WorkspaceSnapshot, graph: SymbolGraph): RefactorPlan {
  const impact = computeImpact(intent, graph);
  const dependencyOrder = buildDependencyOrder(snapshot, impact.affectedUnits);
  const unitRank = new Map(dependencyOrder.map((unit, index) => [unit, index] as const));

  const steps = [...impact.affectedFiles]
    .map((file) => {
      const absolutePath = toAbsolute(snapshot.root, file);
      const unitId = deriveUnitId(snapshot.root, absolutePath);
      return {
        unitId,
        file,
        transformation: noOpTransformation(
          `refactor:${intent.type}:${file}`,
          `Apply ${intent.type} transformation in ${file}`
        ),
      } satisfies RefactorStep;
    })
    .sort((left, right) => {
      const leftRank = unitRank.get(left.unitId) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = unitRank.get(right.unitId) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      if (left.unitId !== right.unitId) {
        return left.unitId.localeCompare(right.unitId);
      }

      return left.file.localeCompare(right.file);
    });

  return {
    intent,
    impact,
    steps,
    dependencyOrder,
  };
}

function getSingleSymbolNode(plan: RefactorPlan, graph: SymbolGraph): SymbolNode {
  const symbolId = plan.impact.affectedSymbols[0];
  const symbolNode = graph.symbols.get(symbolId);
  if (!symbolNode) {
    throw new Error(`Unable to resolve declaration for symbol ${symbolId}`);
  }

  return symbolNode;
}

function getDeclarationNode(project: Project, symbolNode: SymbolNode, root: string): Node {
  const absolute = toAbsolute(root, symbolNode.declaration.file);
  const sourceFile = project.getSourceFile(absolute);
  if (!sourceFile) {
    throw new Error(`Source file not found for declaration: ${symbolNode.declaration.file}`);
  }

  const source = sourceFile.compilerNode;
  const start = source.getPositionOfLineAndCharacter(symbolNode.declaration.start.line, symbolNode.declaration.start.character);
  const declaration = sourceFile.getDescendantAtPos(start);
  if (!declaration) {
    throw new Error(`Declaration node not found at ${symbolNode.declaration.file}`);
  }

  return declaration;
}

function renameDeclarationNode(node: Node, newName: string): void {
  const declaration = node.asKind(SyntaxKind.Identifier) ?? node.getFirstDescendantByKind(SyntaxKind.Identifier);
  const target = declaration ?? node;

  if (!("rename" in target) || typeof (target as { rename?: unknown }).rename !== "function") {
    throw new Error("Declaration node does not support semantic rename");
  }

  (target as { rename(name: string): void }).rename(newName);
}

function applyInline(plan: RefactorPlan, graph: SymbolGraph, project: Project, root: string): void {
  const symbolNode = getSingleSymbolNode(plan, graph);
  const declaration = getDeclarationNode(project, symbolNode, root).asKind(SyntaxKind.VariableDeclaration);
  if (!declaration) {
    throw new Error("Inline refactor currently supports variable declarations only");
  }

  const initializer = declaration.getInitializer();
  if (!initializer) {
    throw new Error("Inline refactor requires an initializer");
  }

  const nameNode = declaration.getNameNode();
  if (!Node.isIdentifier(nameNode)) {
    throw new Error("Inline refactor requires an identifier binding name");
  }

  const references = nameNode.findReferencesAsNodes()
    .sort((left, right) => {
      const leftPath = left.getSourceFile().getFilePath();
      const rightPath = right.getSourceFile().getFilePath();
      if (leftPath !== rightPath) {
        return leftPath.localeCompare(rightPath);
      }

      return right.getStart() - left.getStart();
    });

  for (const referenceNode of references) {
    if (referenceNode.getSourceFile().getFilePath() === declaration.getSourceFile().getFilePath()
      && referenceNode.getStart() === nameNode.getStart()) {
      continue;
    }

    referenceNode.replaceWithText(initializer.getText());
  }

  const statement = declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  const declarationList = declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclarationList);

  if (declarationList && declarationList.getDeclarations().length === 1 && statement) {
    statement.remove();
    return;
  }

  declaration.remove();
}

function applyRename(plan: RefactorPlan, graph: SymbolGraph, project: Project, root: string, newName: string): void {
  const symbolNode = getSingleSymbolNode(plan, graph);
  const declaration = getDeclarationNode(project, symbolNode, root);
  renameDeclarationNode(declaration, newName);
}

function applyRefactorPlan(plan: RefactorPlan, graph: SymbolGraph, snapshot: WorkspaceSnapshot): RefactorApplyResult {
  const project = createProject(snapshot);

  if (plan.intent.type === "rename") {
    applyRename(plan, graph, project, snapshot.root, plan.intent.newName);
  } else if (plan.intent.type === "replace-pattern") {
    if (plan.intent.match.kind !== "identifier" || plan.intent.replace.kind !== "identifier") {
      throw new Error("replace-pattern currently supports identifier patterns only");
    }

    applyRename(plan, graph, project, snapshot.root, plan.intent.replace.value);
  } else if (plan.intent.type === "inline") {
    applyInline(plan, graph, project, snapshot.root);
  } else {
    throw new Error(`Refactor intent ${plan.intent.type} is not yet executable`);
  }

  const beforeMap = new Map(snapshot.files.map((file) => [normalizePath(file.path), file.content] as const));
  const changedFiles: FileMap = {};

  for (const sourceFile of project.getSourceFiles().sort((left, right) => left.getFilePath().localeCompare(right.getFilePath()))) {
    const filePath = normalizePath(sourceFile.getFilePath());
    const before = beforeMap.get(filePath);
    const after = sourceFile.getFullText();

    if (before === undefined || before === after) {
      continue;
    }

    changedFiles[toStableFilePath(snapshot.root, filePath)] = after;
  }

  return {
    changedFiles,
  };
}

function buildPreview(snapshot: WorkspaceSnapshot, changedFiles: FileMap): RefactorPreview {
  const sortedChanges = Object.keys(changedFiles)
    .sort((left, right) => left.localeCompare(right))
    .map((file) => {
      const absolutePath = toAbsolute(snapshot.root, file);
      const before = snapshot.files.find((entry) => normalizePath(entry.path) === normalizePath(absolutePath))?.content ?? "";
      const after = changedFiles[file];
      return {
        file,
        before,
        after,
        diff: generateDiff(file, before, after),
      };
    });

  return {
    hash: makeHash(sortedChanges.map((entry) => ({ file: entry.file, after: entry.after }))),
    changes: sortedChanges,
  };
}

function snapshotWithChanges(snapshot: WorkspaceSnapshot, changedFiles: FileMap): WorkspaceSnapshot {
  const changedByAbsolute = new Map(
    Object.entries(changedFiles).map(([file, content]) => [normalizePath(toAbsolute(snapshot.root, file)), content] as const)
  );

  return {
    root: snapshot.root,
    files: snapshot.files
      .map((file) => ({
        path: file.path,
        content: changedByAbsolute.get(normalizePath(file.path)) ?? file.content,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function validateChangedAsts(preview: RefactorPreview): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const change of preview.changes) {
    if (!/\.(ts|tsx|js|jsx)$/.test(change.file)) {
      continue;
    }

    const sourceFile = ts.createSourceFile(change.file, change.after, ts.ScriptTarget.Latest, true);
    const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (parseDiagnostics.length > 0) {
      const message = ts.flattenDiagnosticMessageText(parseDiagnostics[0].messageText, "\n");
      errors.push(`${change.file}: ${message}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

function runIncrementalRules(affectedUnits: string[], snapshot: WorkspaceSnapshot): string[] {
  const unitSet = new Set(affectedUnits);
  const errors: string[] = [];

  const relevantFiles = snapshot.files
    .filter((file) => unitSet.has(deriveUnitId(snapshot.root, file.path)))
    .sort((left, right) => left.path.localeCompare(right.path));

  for (const file of relevantFiles) {
    if (!file.path.endsWith(".ts")) {
      continue;
    }

    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    const parseDiagnostics = (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (parseDiagnostics.length > 0) {
      const message = ts.flattenDiagnosticMessageText(parseDiagnostics[0].messageText, "\n");
      errors.push(`${toStableFilePath(snapshot.root, file.path)}: ${message}`);
    }
  }

  return errors;
}

function applyPolicies(plan: RefactorPlan, controlPlane: ControlPlane): PolicyDecision {
  const constraints = controlPlane.intent.constraints.map((constraint) => constraint.toLowerCase());
  const violations: string[] = [];

  if (plan.intent.type === "move" || plan.intent.type === "extract") {
    const target = (plan.intent.type === "move" ? plan.intent.to : plan.intent.targetUnit).toLowerCase();
    const symbol = plan.intent.symbol.toLowerCase();

    const deniesFrontendDbMove = constraints.some((constraint) =>
      constraint.includes("db") && constraint.includes("frontend")
    ) || constraints.some((constraint) => constraint.includes("no direct db access"));

    if (deniesFrontendDbMove && target.includes("frontend") && /(db|query|repository|sql)/.test(symbol)) {
      violations.push("Policy violation: cannot move DB access symbols into frontend units");
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
  };
}

function validateGlobalConsistency(snapshot: WorkspaceSnapshot): string[] {
  const filesByAbsolute = new Set(snapshot.files.map((file) => normalizePath(file.path)));
  const errors: string[] = [];

  for (const file of snapshot.files.sort((left, right) => left.path.localeCompare(right.path))) {
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);

    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }

      const specifier = statement.moduleSpecifier.text;
      const resolved = resolveRelativeImport(file.path, specifier, filesByAbsolute);
      if (specifier.startsWith(".") && !resolved) {
        errors.push(`${toStableFilePath(snapshot.root, file.path)} imports missing module ${specifier}`);
      }
    }
  }

  return sortedUnique(errors);
}

function collectMissingReferenceErrors(pipelineDiagnostics: Diagnostic[]): string[] {
  return pipelineDiagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => `${diagnostic.location.file}:${diagnostic.ruleId}:${diagnostic.message}`)
    .sort((left, right) => left.localeCompare(right));
}

export async function validateRefactor(
  plan: RefactorPlan,
  preview: RefactorPreview,
  snapshotAfter: WorkspaceSnapshot,
  controlPlane: ControlPlane,
  baseline?: {
    missingReferenceErrors: string[];
    consistencyErrors: string[];
  }
): Promise<RefactorValidationResult> {
  const astValidation = validateChangedAsts(preview);
  const policy = applyPolicies(plan, controlPlane);
  const incrementalErrors = runIncrementalRules(plan.impact.affectedUnits, snapshotAfter);
  const baselineMissing = new Set(baseline?.missingReferenceErrors ?? []);
  const baselineConsistency = new Set(baseline?.consistencyErrors ?? []);
  const consistencyErrors = validateGlobalConsistency(snapshotAfter)
    .filter((error) => !baselineConsistency.has(error));

  const pipeline = await runPipeline({
    controlPlane,
    workspace: snapshotAfter,
    persistState: false,
  });

  const missingReferenceErrors = [
    ...collectMissingReferenceErrors(pipeline.diagnostics),
    ...incrementalErrors,
  ]
    .filter((error) => !baselineMissing.has(error))
    .sort((left, right) => left.localeCompare(right));

  const passed = astValidation.ok
    && policy.allowed
    && missingReferenceErrors.length === 0
    && consistencyErrors.length === 0;

  return {
    passed,
    astValid: astValidation.ok,
    ruleDiagnostics: pipeline.diagnostics,
    policy,
    missingReferenceErrors,
    consistencyErrors,
  };
}

function refactorSnapshotDir(root: string): string {
  return path.join(root, ".choir", "refactor-snapshots");
}

function refactorSnapshotPath(root: string, snapshotId: string): string {
  return path.join(refactorSnapshotDir(root), `${snapshotId}.json`);
}

function saveRefactorSnapshot(root: string, payload: RefactorSnapshot): void {
  fs.mkdirSync(refactorSnapshotDir(root), { recursive: true });
  fs.writeFileSync(refactorSnapshotPath(root, payload.id), JSON.stringify(payload, null, 2), "utf-8");
}

function readRefactorSnapshot(root: string, snapshotId: string): RefactorSnapshot {
  const snapshotPath = refactorSnapshotPath(root, snapshotId);
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`Refactor snapshot not found: ${snapshotId}`);
  }

  return JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as RefactorSnapshot;
}

function createSnapshotId(plan: RefactorPlan, preview: RefactorPreview): string {
  const hash = makeHash({
    intent: plan.intent,
    files: preview.changes.map((change) => ({ file: change.file, after: change.after })),
  });

  return `refactor-${hash.slice(0, 16)}`;
}

function snapshotFilesForPlan(root: string, plan: RefactorPlan): Record<string, string> {
  const files: Record<string, string> = {};

  for (const file of sortedUnique(plan.impact.affectedFiles)) {
    const absolute = toAbsolute(root, file);
    if (!fs.existsSync(absolute)) {
      continue;
    }

    files[file] = fs.readFileSync(absolute, "utf-8");
  }

  return files;
}

export async function executeRefactor(
  plan: RefactorPlan,
  preview: RefactorPreview,
  validation: RefactorValidationResult,
  options: { root: string; controlPlane: ControlPlane }
): Promise<RefactorExecutionResult> {
  const trace: RefactorTrace = {
    intent: plan.intent,
    affectedUnits: [...plan.impact.affectedUnits].sort((left, right) => left.localeCompare(right)),
    stepsExecuted: 0,
    validationPassed: validation.passed,
  };

  if (!validation.passed) {
    return {
      committed: false,
      rolledBack: false,
      trace,
    };
  }

  const txFs = createNodeTransactionFS(options.root);
  const snapshotId = createSnapshotId(plan, preview);
  const snapshot: RefactorSnapshot = {
    id: snapshotId,
    createdAt: new Date().toISOString(),
    files: snapshotFilesForPlan(options.root, plan),
    state: readStatePlane(options.root),
  };
  saveRefactorSnapshot(options.root, snapshot);

  const writes: Record<string, string> = Object.fromEntries(
    preview.changes
      .map((change) => [change.file, change.after] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );

  try {
    await txFs.atomicWrite({ writes, deletes: [] });

    const postWorkspace = buildWorkspaceSnapshot(options.root);
    await runPipeline({
      controlPlane: options.controlPlane,
      workspace: postWorkspace,
      persistState: true,
    });

    const state = readStatePlane(options.root);
    if (!state) {
      throw new Error("State materialization failed after refactor commit");
    }

    const stateValidation = validateState(state);

    if (!stateValidation.valid) {
      throw new Error("State validation failed after refactor commit");
    }

    trace.stepsExecuted = plan.steps.length;

    return {
      committed: true,
      snapshotId,
      rolledBack: false,
      trace,
    };
  } catch {
    await rollbackRefactor(options.root, snapshotId);
    trace.stepsExecuted = 0;

    return {
      committed: false,
      snapshotId,
      rolledBack: true,
      trace,
    };
  }
}

export async function rollbackRefactor(root: string, snapshotId: string): Promise<void> {
  const snapshot = readRefactorSnapshot(root, snapshotId);
  const txFs = createNodeTransactionFS(root);

  await txFs.atomicWrite({
    writes: snapshot.files,
    deletes: [],
  });

  if (snapshot.state) {
    await txFs.writeState(snapshot.state);
  }
}

export async function simulate(
  plan: RefactorPlan,
  graph: SymbolGraph,
  snapshot: WorkspaceSnapshot,
  controlPlane: ControlPlane
): Promise<SimulationResult> {
  const baselinePipeline = await runPipeline({
    controlPlane,
    workspace: snapshot,
    persistState: false,
  });
  const baselineMissing = collectMissingReferenceErrors(baselinePipeline.diagnostics);
  const baselineConsistency = validateGlobalConsistency(snapshot);

  const applied = applyRefactorPlan(plan, graph, snapshot);
  const preview = buildPreview(snapshot, applied.changedFiles);
  const afterSnapshot = snapshotWithChanges(snapshot, applied.changedFiles);
  const validation = await validateRefactor(plan, preview, afterSnapshot, controlPlane, {
    missingReferenceErrors: baselineMissing,
    consistencyErrors: baselineConsistency,
  });

  return {
    plan,
    preview,
    validation,
  };
}

export async function runRefactorIntent(intent: RefactorIntent, options: RunRefactorOptions): Promise<RunRefactorResult> {
  const workspace = buildWorkspaceSnapshot(options.root);
  const symbolGraph = buildRefactorSymbolGraph(workspace);
  const impact = computeImpact(intent, symbolGraph);
  const plan = buildRefactorPlan(intent, workspace, symbolGraph);
  const simulation = await simulate(plan, symbolGraph, workspace, options.controlPlane);

  const result: RunRefactorResult = {
    symbolGraph,
    impact,
    plan,
    preview: simulation.preview,
    simulation,
  };

  if (options.execute) {
    result.execution = await executeRefactor(plan, simulation.preview, simulation.validation, {
      root: options.root,
      controlPlane: options.controlPlane,
    });
  }

  return result;
}
