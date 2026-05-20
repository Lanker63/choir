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
import { recordMutationTrace } from "./mutationTrace.js";
import { executeSemanticMutations } from "./semanticMutationExecutor.js";
import type { SemanticMutation } from "./semanticMutation.js";
import { deterministicTimestampFromString } from "./deterministicCore.js";

export type Pattern = {
  kind: "identifier";
  value: string;
};

export type RefactorIntent =
  | { type: "rename"; symbol: string; newName: string; declarationSelector?: string }
  | { type: "extract"; symbol: string; targetUnit?: string; targetFile?: string }
  | { type: "move"; symbol: string; from: string; to?: string; targetFile?: string }
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

type ModuleSpecifierOptions = {
  root: string;
};

const explicitEsmExtensionCache = new Map<string, boolean>();

const NON_DECLARATION_SYMBOL_KINDS = new Set([
  "ImportSpecifier",
  "NamespaceImport",
  "ImportClause",
  "ExportSpecifier",
]);

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

function isRefactorEligibleFile(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  const lower = normalized.toLowerCase();

  if (!lower.endsWith(".ts")
    && !lower.endsWith(".tsx")
    && !lower.endsWith(".js")
    && !lower.endsWith(".jsx")
    && !lower.endsWith(".mts")
    && !lower.endsWith(".cts")) {
    return false;
  }

  if (lower.endsWith(".d.ts") || lower.endsWith(".d.mts") || lower.endsWith(".d.cts")) {
    return false;
  }

  if (lower.includes("/dist/") || lower.includes("/build/") || lower.includes("/coverage/")) {
    return false;
  }

  return true;
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

  const sortedFiles = [...snapshot.files]
    .filter((file) => isRefactorEligibleFile(file.path))
    .sort((left, right) => left.path.localeCompare(right.path));
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

  return "workspaceRoot";
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

function getDeclarationAnchor(node: Node): Node {
  const maybeNameNode = "getNameNode" in node
    ? (node as { getNameNode?: () => Node | undefined }).getNameNode?.()
    : undefined;
  if (maybeNameNode) {
    return maybeNameNode;
  }

  const identifier = node.asKind(SyntaxKind.Identifier) ?? node.getFirstDescendantByKind(SyntaxKind.Identifier);
  if (identifier) {
    return identifier;
  }

  return node;
}

function symbolNodeFromDeclaration(symbolId: string, declaration: Node, root: string): SymbolNode {
  const anchor = getDeclarationAnchor(declaration);
  const sourceFile = anchor.getSourceFile();
  const compilerNode = sourceFile.compilerNode;
  const location = toSourceLocation(
    root,
    sourceFile.getFilePath(),
    anchor.getStart(),
    anchor.getEnd(),
    compilerNode
  );

  return {
    id: symbolId,
    name: anchor.getSymbol()?.getName() ?? declaration.getSymbol()?.getName() ?? declaration.getText(),
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

  const symbolIds = [...graph.symbols.values()]
    .filter((symbol) => {
      if (symbol.name !== symbolName) {
        return false;
      }

      if (intent.type === "replace-pattern") {
        return true;
      }

      return !NON_DECLARATION_SYMBOL_KINDS.has(symbol.kind);
    })
    .map((symbol) => symbol.id)
    .sort((left, right) => left.localeCompare(right));

  if (intent.type !== "rename" || intent.declarationSelector === undefined) {
    return symbolIds;
  }

  const selector = intent.declarationSelector.trim();
  const selected = symbolIds.filter((symbolId) => {
    const symbol = graph.symbols.get(symbolId);
    if (!symbol) {
      return false;
    }

    const line = symbol.declaration.start.line + 1;
    const character = symbol.declaration.start.character + 1;
    return `${symbol.declaration.file}:${line}:${character}` === selector;
  });

  if (selected.length > 0) {
    return selected;
  }

  const normalizeSelectorFile = (value: string): string => {
    const normalized = value.trim().split("\\").join("/");
    return normalized.startsWith("./") ? normalized.slice(2) : normalized;
  };

  const selectorFile = normalizeSelectorFile(selector);
  const selectedByFile = symbolIds.filter((symbolId) => {
    const symbol = graph.symbols.get(symbolId);
    if (!symbol) {
      return false;
    }

    return normalizeSelectorFile(symbol.declaration.file) === selectorFile;
  });

  if (selectedByFile.length === 1) {
    return selectedByFile;
  }

  if (selectedByFile.length > 1) {
    const fileCandidates = formatRenameCandidates(selectedByFile, graph);
    throw new Error(
      `Declaration selector "${intent.declarationSelector}" matches ${selectedByFile.length} declarations (${fileCandidates}). Use --declaration "<file:line:character>" to disambiguate.`
    );
  }

  const candidates = formatRenameCandidates(symbolIds, graph);
  throw new Error(
    `No declaration matches rename selector "${intent.declarationSelector}" for symbol "${intent.symbol}". Candidates: ${candidates}. Selector accepts either "<file>" (when unique) or "<file:line:character>".`
  );
}

function formatRenameCandidates(symbolIds: string[], graph: SymbolGraph): string {
  return symbolIds
    .map((symbolId) => {
      const symbol = graph.symbols.get(symbolId);
      if (!symbol) {
        return symbolId;
      }

      const line = symbol.declaration.start.line + 1;
      const character = symbol.declaration.start.character + 1;
      return `${symbol.declaration.file}:${line}:${character}`;
    })
    .sort((left, right) => left.localeCompare(right))
    .join(", ");
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

  if (intent.type === "rename" && symbolIds.length > 1) {
    const candidates = formatRenameCandidates(symbolIds, graph);
    throw new Error(
      `Ambiguous rename symbol "${intent.symbol}": found ${symbolIds.length} declarations (${candidates}). Rename requires a unique symbol name or --declaration \"<file>\"/\"<file:line:character>\".`
    );
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
    if (intent.type === "move") {
      if (intent.to) {
        units.add(intent.to);
      }
    } else {
      if (intent.targetUnit) {
        units.add(intent.targetUnit);
      }
    }
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
  const runtimeExtension = path.extname(root).toLowerCase();
  const strippedRuntimeRoot = [".js", ".mjs", ".cjs"].includes(runtimeExtension)
    ? root.slice(0, -runtimeExtension.length)
    : null;

  const candidates = [
    root,
    `${root}.ts`,
    `${root}.tsx`,
    `${root}.mts`,
    `${root}.cts`,
    path.join(root, "index.ts"),
    path.join(root, "index.tsx"),
    path.join(root, "index.mts"),
    path.join(root, "index.cts"),
    ...(strippedRuntimeRoot
      ? [
        `${strippedRuntimeRoot}.ts`,
        `${strippedRuntimeRoot}.tsx`,
        `${strippedRuntimeRoot}.mts`,
        `${strippedRuntimeRoot}.cts`,
        path.join(strippedRuntimeRoot, "index.ts"),
        path.join(strippedRuntimeRoot, "index.tsx"),
        path.join(strippedRuntimeRoot, "index.mts"),
        path.join(strippedRuntimeRoot, "index.cts"),
      ]
      : []),
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
  let queueIndex = 0;

  const enqueueSorted = (unit: string): void => {
    let insertAt = queue.length;
    for (let index = queueIndex; index < queue.length; index += 1) {
      if (unit.localeCompare(queue[index] as string) < 0) {
        insertAt = index;
        break;
      }
    }

    queue.splice(insertAt, 0, unit);
  };

  while (queueIndex < queue.length) {
    const unit = queue[queueIndex] as string;
    queueIndex += 1;
    order.push(unit);

    const nextDependents = [...(dependents.get(unit) ?? new Set<string>())].sort((a, b) => a.localeCompare(b));
    for (const dependent of nextDependents) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        enqueueSorted(dependent);
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

function resolveRenameableNode(node: Node): { rename(name: string): void } | null {
  const tryResolve = (candidate: Node | undefined): { rename(name: string): void } | null => {
    if (!candidate) {
      return null;
    }

    if ("rename" in candidate && typeof (candidate as { rename?: unknown }).rename === "function") {
      return candidate as { rename(name: string): void };
    }

    return null;
  };

  const identifier = node.asKind(SyntaxKind.Identifier);
  const identifierRenameable = tryResolve(identifier);
  if (identifierRenameable) {
    return identifierRenameable;
  }

  const maybeNameNode = "getNameNode" in node
    ? (node as { getNameNode?: () => Node | undefined }).getNameNode?.()
    : undefined;
  const nameNodeRenameable = tryResolve(maybeNameNode);
  if (nameNodeRenameable) {
    return nameNodeRenameable;
  }

  const descendantRenameable = tryResolve(node.getFirstDescendantByKind(SyntaxKind.Identifier));
  if (descendantRenameable) {
    return descendantRenameable;
  }

  for (const ancestor of node.getAncestors()) {
    const ancestorRenameable = tryResolve(ancestor);
    if (ancestorRenameable) {
      return ancestorRenameable;
    }

    const ancestorNameNode = "getNameNode" in ancestor
      ? (ancestor as { getNameNode?: () => Node | undefined }).getNameNode?.()
      : undefined;
    const ancestorNameNodeRenameable = tryResolve(ancestorNameNode);
    if (ancestorNameNodeRenameable) {
      return ancestorNameNodeRenameable;
    }
  }

  return tryResolve(node);
}

function renameDeclarationNode(node: Node, newName: string): void {
  const target = resolveRenameableNode(node);

  if (!target) {
    throw new Error("Declaration node does not support semantic rename");
  }

  target.rename(newName);
}

function resolveInlineVariableDeclaration(node: Node): import("ts-morph").VariableDeclaration | null {
  const direct = node.asKind(SyntaxKind.VariableDeclaration);
  if (direct) {
    return direct;
  }

  const fromIdentifier = node.asKind(SyntaxKind.Identifier)?.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  if (fromIdentifier) {
    return fromIdentifier;
  }

  return node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
    ?? node.getFirstDescendantByKind(SyntaxKind.VariableDeclaration)
    ?? null;
}

function normalizeUnitSelector(unit: string): string {
  const trimmed = unit.trim();
  if (trimmed.includes(":")) {
    return trimmed;
  }

  const firstDot = trimmed.indexOf(".");
  if (firstDot === -1) {
    return trimmed;
  }

  return `${trimmed.slice(0, firstDot)}:${trimmed.slice(firstDot + 1)}`;
}

function requiresExplicitEsmExtensions(root: string): boolean {
  const normalizedRoot = normalizePath(root);
  const cached = explicitEsmExtensionCache.get(normalizedRoot);
  if (cached !== undefined) {
    return cached;
  }

  const tsconfigPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (!tsconfigPath) {
    explicitEsmExtensionCache.set(normalizedRoot, false);
    return false;
  }

  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error) {
    explicitEsmExtensionCache.set(normalizedRoot, false);
    return false;
  }

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(tsconfigPath),
    undefined,
    tsconfigPath
  );

  const requiresExplicitByResolution = parsed.options.moduleResolution === ts.ModuleResolutionKind.Node16
    || parsed.options.moduleResolution === ts.ModuleResolutionKind.NodeNext;
  const requiresExplicitByModuleKind = parsed.options.module === ts.ModuleKind.Node16
    || parsed.options.module === ts.ModuleKind.NodeNext;
  const requiresExplicit = requiresExplicitByResolution || requiresExplicitByModuleKind;
  explicitEsmExtensionCache.set(normalizedRoot, requiresExplicit);
  return requiresExplicit;
}

function runtimeImportExtensionForFile(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) {
    return ".js";
  }

  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    return extension;
  }

  return ".js";
}

function normalizeModuleSpecifier(fromFilePath: string, toFilePath: string, options: ModuleSpecifierOptions): string {
  let relative = normalizePath(path.relative(path.dirname(fromFilePath), toFilePath));

  const needsExplicitExtension = requiresExplicitEsmExtensions(options.root);
  const runtimeExtension = runtimeImportExtensionForFile(toFilePath);
  const indexSuffixRegex = new RegExp(`\\/index(?:${runtimeExtension.replace('.', '\\.')})?$`, "i");

  if (needsExplicitExtension) {
    relative = relative.replace(/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/i, runtimeExtension);
  } else {
    relative = relative.replace(/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/i, "");
  }

  relative = relative.replace(indexSuffixRegex, needsExplicitExtension ? `/index${runtimeExtension}` : "");

  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }

  return relative;
}

function canonicalizeModulePath(value: string): string {
  return normalizePath(value)
    .replace(/\.(tsx?|jsx?|mjs|cjs)$/i, "")
    .replace(/\/index$/i, "");
}

function unitDefaultFilePath(root: string, unit: string): string {
  const normalizedUnit = normalizeUnitSelector(unit);
  if (normalizedUnit === "workspaceRoot") {
    return path.join(root, "src", "index.ts");
  }

  const [scope, name] = normalizedUnit.split(":", 2);
  if (!scope || !name || !["packages", "apps", "services", "libs"].includes(scope)) {
    throw new Error(`Unsupported move target unit: ${unit}`);
  }

  return path.join(root, scope, name, "src", "index.ts");
}

function resolveMoveTargetFileByPath(
  project: Project,
  root: string,
  sourceFilePath: string,
  targetFile: string
): import("ts-morph").SourceFile {
  const absolutePath = toAbsolute(root, targetFile);
  if (normalizePath(absolutePath) === normalizePath(sourceFilePath)) {
    throw new Error("Move refactor requires target file distinct from source declaration file");
  }

  const existing = project.getSourceFile(absolutePath);
  if (existing) {
    return existing;
  }

  return project.createSourceFile(absolutePath, "", { overwrite: false });
}

function resolveMoveTargetFile(project: Project, root: string, sourceFilePath: string, targetUnit: string): import("ts-morph").SourceFile {
  const normalizedTargetUnit = normalizeUnitSelector(targetUnit);
  const candidates = project.getSourceFiles()
    .filter((file) => normalizePath(file.getFilePath()) !== normalizePath(sourceFilePath))
    .filter((file) => deriveUnitId(root, file.getFilePath()) === normalizedTargetUnit)
    .sort((left, right) => left.getFilePath().localeCompare(right.getFilePath()));

  if (candidates.length > 0) {
    return candidates[0] as import("ts-morph").SourceFile;
  }

  const targetPath = unitDefaultFilePath(root, normalizedTargetUnit);
  const existing = project.getSourceFile(targetPath);
  if (existing) {
    return existing;
  }

  return project.createSourceFile(targetPath, "", { overwrite: false });
}

function moveFunctionDeclaration(
  declaration: import("ts-morph").FunctionDeclaration,
  targetFile: import("ts-morph").SourceFile,
  sourceFile: import("ts-morph").SourceFile,
  root: string
): void {
  const nameNode = declaration.getNameNode();
  if (!nameNode || !Node.isIdentifier(nameNode)) {
    throw new Error("Move refactor requires a named function declaration");
  }

  const symbolName = nameNode.getText();
  const localReferences = nameNode.findReferencesAsNodes().filter((reference) => {
    return reference.getSourceFile().getFilePath() === sourceFile.getFilePath()
      && reference.getStart() !== nameNode.getStart();
  });

  const declarationText = declaration.getText();

  for (const importDeclaration of targetFile.getImportDeclarations()) {
    const specifier = importDeclaration.getModuleSpecifierValue();
    if (!specifier.startsWith(".")) {
      continue;
    }

    const resolvedImport = path.resolve(path.dirname(targetFile.getFilePath()), specifier);
    if (canonicalizeModulePath(resolvedImport) !== canonicalizeModulePath(sourceFile.getFilePath())) {
      continue;
    }

    const matchingNamedImports = importDeclaration.getNamedImports()
      .filter((entry) => entry.getName() === symbolName);
    for (const namedImport of matchingNamedImports) {
      namedImport.remove();
    }

    if (!importDeclaration.getDefaultImport()
      && !importDeclaration.getNamespaceImport()
      && importDeclaration.getNamedImports().length === 0) {
      importDeclaration.remove();
    }
  }

  declaration.remove();

  targetFile.addStatements([declarationText]);

  const moduleSpecifier = normalizeModuleSpecifier(sourceFile.getFilePath(), targetFile.getFilePath(), { root });

  if (localReferences.length > 0) {
    sourceFile.addImportDeclaration({
      moduleSpecifier,
      namedImports: [symbolName],
    });
  }
}

function removeTargetImportFromSourceModule(
  targetFile: import("ts-morph").SourceFile,
  sourceFile: import("ts-morph").SourceFile,
  symbolName: string
): void {
  for (const importDeclaration of targetFile.getImportDeclarations()) {
    const specifier = importDeclaration.getModuleSpecifierValue();
    if (!specifier.startsWith(".")) {
      continue;
    }

    const resolvedImport = path.resolve(path.dirname(targetFile.getFilePath()), specifier);
    if (canonicalizeModulePath(resolvedImport) !== canonicalizeModulePath(sourceFile.getFilePath())) {
      continue;
    }

    const matchingNamedImports = importDeclaration.getNamedImports()
      .filter((entry) => entry.getName() === symbolName);
    for (const namedImport of matchingNamedImports) {
      namedImport.remove();
    }

    if (!importDeclaration.getDefaultImport()
      && !importDeclaration.getNamespaceImport()
      && importDeclaration.getNamedImports().length === 0) {
      importDeclaration.remove();
    }
  }
}

function collectIdentifierNames(sourceFile: import("ts-morph").SourceFile): Set<string> {
  return new Set(sourceFile.getDescendantsOfKind(SyntaxKind.Identifier).map((identifier) => identifier.getText()));
}

function allocateExtractImportAlias(sourceFile: import("ts-morph").SourceFile, symbolName: string): string {
  const usedNames = collectIdentifierNames(sourceFile);
  const base = `__choirExtract_${symbolName}`;
  let alias = base;
  let counter = 2;

  while (usedNames.has(alias)) {
    alias = `${base}_${counter}`;
    counter += 1;
  }

  return alias;
}

function ensureNamedImportAlias(
  sourceFile: import("ts-morph").SourceFile,
  targetFile: import("ts-morph").SourceFile,
  symbolName: string,
  root: string
): string {
  const moduleSpecifier = normalizeModuleSpecifier(sourceFile.getFilePath(), targetFile.getFilePath(), { root });
  const existingImport = sourceFile.getImportDeclaration((entry) => entry.getModuleSpecifierValue() === moduleSpecifier);
  const alias = allocateExtractImportAlias(sourceFile, symbolName);

  if (!existingImport) {
    sourceFile.addImportDeclaration({
      moduleSpecifier,
      namedImports: [{ name: symbolName, alias }],
    });
    return alias;
  }

  const existingNamedImport = existingImport.getNamedImports().find((entry) => entry.getName() === symbolName);
  if (existingNamedImport) {
    const existingAlias = existingNamedImport.getAliasNode()?.getText();
    if (existingAlias) {
      return existingAlias;
    }

    existingNamedImport.setAlias(alias);
    return alias;
  }

  existingImport.addNamedImport({ name: symbolName, alias });
  return alias;
}

function extractFunctionDeclaration(
  declaration: import("ts-morph").FunctionDeclaration,
  targetFile: import("ts-morph").SourceFile,
  sourceFile: import("ts-morph").SourceFile,
  root: string
): void {
  const nameNode = declaration.getNameNode();
  if (!nameNode || !Node.isIdentifier(nameNode)) {
    throw new Error("Extract refactor requires a named function declaration");
  }

  if (!declaration.isExported() || declaration.isDefaultExport()) {
    throw new Error("Extract refactor currently supports exported non-default top-level function declarations only");
  }

  if (!declaration.getBody()) {
    throw new Error("Extract refactor requires a concrete function implementation (not overload signature)");
  }

  if (declaration.isGenerator()) {
    throw new Error("Extract refactor does not yet support generator functions");
  }

  const symbolName = nameNode.getText();
  const existingTargetFunction = targetFile.getFunction(symbolName);
  if (existingTargetFunction) {
    throw new Error(`Extract refactor target already defines function \"${symbolName}\"`);
  }

  removeTargetImportFromSourceModule(targetFile, sourceFile, symbolName);

  const declarationText = declaration.getText();
  targetFile.addStatements([declarationText]);

  const delegatedAlias = ensureNamedImportAlias(sourceFile, targetFile, symbolName, root);
  const typeArgumentList = declaration.getTypeParameters().map((typeParameter) => typeParameter.getName()).join(", ");
  const typeArguments = typeArgumentList.length > 0 ? `<${typeArgumentList}>` : "";

  const callArguments = declaration.getParameters().map((parameter) => {
    if (parameter.isRestParameter()) {
      return `...${parameter.getNameNode().getText()}`;
    }

    return parameter.getNameNode().getText();
  }).join(", ");

  declaration.setBodyText(`return ${delegatedAlias}${typeArguments}(${callArguments});`);
}

function rewriteMovedSymbolImports(
  project: Project,
  sourceFile: import("ts-morph").SourceFile,
  targetFile: import("ts-morph").SourceFile,
  symbolName: string,
  root: string
): void {
  const sourceCanonical = canonicalizeModulePath(sourceFile.getFilePath());

  for (const file of project.getSourceFiles()) {
    for (const importDeclaration of file.getImportDeclarations()) {
      const specifier = importDeclaration.getModuleSpecifierValue();
      if (!specifier.startsWith(".")) {
        continue;
      }

      const resolvedImport = path.resolve(path.dirname(file.getFilePath()), specifier);
      if (canonicalizeModulePath(resolvedImport) !== sourceCanonical) {
        continue;
      }

      const movedNamedImports = importDeclaration.getNamedImports()
        .filter((entry) => entry.getName() === symbolName)
        .map((entry) => ({
          name: entry.getName(),
          alias: entry.getAliasNode()?.getText(),
        }));

      if (movedNamedImports.length === 0) {
        continue;
      }

      const targetSpecifier = normalizeModuleSpecifier(file.getFilePath(), targetFile.getFilePath(), { root });
      let targetImport = file.getImportDeclaration((entry) => entry.getModuleSpecifierValue() === targetSpecifier);

      if (!targetImport) {
        targetImport = file.addImportDeclaration({
          moduleSpecifier: targetSpecifier,
          namedImports: [],
        });
      }

      const existingNamedImports = new Set(
        targetImport.getNamedImports().map((entry) => `${entry.getName()}:${entry.getAliasNode()?.getText() ?? ""}`)
      );

      for (const movedNamedImport of movedNamedImports) {
        const key = `${movedNamedImport.name}:${movedNamedImport.alias ?? ""}`;
        if (existingNamedImports.has(key)) {
          continue;
        }

        targetImport.addNamedImport(
          movedNamedImport.alias
            ? { name: movedNamedImport.name, alias: movedNamedImport.alias }
            : movedNamedImport.name
        );
      }

      for (const namedImport of importDeclaration.getNamedImports().filter((entry) => entry.getName() === symbolName)) {
        namedImport.remove();
      }

      if (!importDeclaration.getDefaultImport()
        && !importDeclaration.getNamespaceImport()
        && importDeclaration.getNamedImports().length === 0) {
        importDeclaration.remove();
      }
    }
  }
}

function applyMove(plan: RefactorPlan, graph: SymbolGraph, project: Project, root: string, moveIntent: Extract<RefactorIntent, { type: "move" }>): void {
  const symbolNode = getSingleSymbolNode(plan, graph);
  const declarationNode = getDeclarationNode(project, symbolNode, root);
  const declaration = declarationNode.asKind(SyntaxKind.FunctionDeclaration)
    ?? declarationNode.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration);

  if (!declaration) {
    throw new Error("Move refactor currently supports top-level function declarations only");
  }

  const sourceFile = declaration.getSourceFile();
  const targetFile = moveIntent.targetFile
    ? resolveMoveTargetFileByPath(project, root, sourceFile.getFilePath(), moveIntent.targetFile)
    : resolveMoveTargetFile(project, root, sourceFile.getFilePath(), moveIntent.to ?? "");

  if (!moveIntent.targetFile && !moveIntent.to) {
    throw new Error("Move refactor requires target unit or target file");
  }

  if (normalizePath(sourceFile.getFilePath()) === normalizePath(targetFile.getFilePath())) {
    throw new Error("Move refactor requires target distinct from source declaration location");
  }

  const symbolName = declaration.getName();
  if (!symbolName) {
    throw new Error("Move refactor requires a named function declaration");
  }

  moveFunctionDeclaration(declaration, targetFile, sourceFile, root);
  rewriteMovedSymbolImports(project, sourceFile, targetFile, symbolName, root);
}

function applyExtract(
  plan: RefactorPlan,
  graph: SymbolGraph,
  project: Project,
  root: string,
  extractIntent: Extract<RefactorIntent, { type: "extract" }>
): void {
  const symbolNode = getSingleSymbolNode(plan, graph);
  const declarationNode = getDeclarationNode(project, symbolNode, root);
  const declaration = declarationNode.asKind(SyntaxKind.FunctionDeclaration)
    ?? declarationNode.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration);

  if (!declaration || !Node.isSourceFile(declaration.getParent())) {
    throw new Error("Extract refactor currently supports top-level function declarations only");
  }

  if (!extractIntent.targetUnit && !extractIntent.targetFile) {
    throw new Error("Extract refactor requires target unit or target file");
  }

  if (extractIntent.targetUnit && extractIntent.targetFile) {
    throw new Error("Extract refactor requires exactly one target: target unit or target file");
  }

  const sourceFile = declaration.getSourceFile();
  const targetFile = extractIntent.targetFile
    ? resolveMoveTargetFileByPath(project, root, sourceFile.getFilePath(), extractIntent.targetFile)
    : resolveMoveTargetFile(project, root, sourceFile.getFilePath(), extractIntent.targetUnit ?? "");
  if (normalizePath(sourceFile.getFilePath()) === normalizePath(targetFile.getFilePath())) {
    throw new Error("Extract refactor requires target unit distinct from source declaration location");
  }

  extractFunctionDeclaration(declaration, targetFile, sourceFile, root);
}

function applyInline(plan: RefactorPlan, graph: SymbolGraph, project: Project, root: string): void {
  const symbolNode = getSingleSymbolNode(plan, graph);
  const declaration = resolveInlineVariableDeclaration(getDeclarationNode(project, symbolNode, root));
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

function supportedSemanticMutations(plan: RefactorPlan, graph: SymbolGraph): SemanticMutation[] | null {
  if (plan.intent.type !== "rename" && plan.intent.type !== "inline" && plan.intent.type !== "move") {
    return null;
  }

  const symbolNode = getSingleSymbolNode(plan, graph);
  const symbolHint = {
    file: symbolNode.declaration.file,
    name: symbolNode.name,
  };

  if (plan.intent.type === "rename") {
    return [{
      kind: "RenameSymbol",
      symbolHint,
      newName: plan.intent.newName,
    }];
  }

  if (plan.intent.type === "inline") {
    return [{
      kind: "InlineSymbol",
      symbolHint,
    }];
  }

  if (plan.intent.type === "move" && plan.intent.targetFile) {
    return [{
      kind: "MoveSymbol",
      symbolHint,
      targetFile: plan.intent.targetFile,
      updateExports: true,
    }];
  }

  return null;
}

async function applyRefactorPlan(plan: RefactorPlan, graph: SymbolGraph, snapshot: WorkspaceSnapshot): Promise<RefactorApplyResult> {
  const semanticMutations = supportedSemanticMutations(plan, graph);
  if (semanticMutations && semanticMutations.length > 0) {
    const semanticResult = await executeSemanticMutations({
      root: snapshot.root,
      files: snapshot.files,
      mutations: semanticMutations,
    });

    recordMutationTrace(snapshot.root, {
      source: "refactor-engine",
      mechanism: "ts-morph",
      safety: "conditionally-safe",
      operation: `${plan.intent.type}:semantic-executor`,
      targetFiles: Object.keys(semanticResult.changedFiles),
      detail: `affectedSymbols=${plan.impact.affectedSymbols.length}`,
      payload: {
        intent: plan.intent,
        manifestId: semanticResult.manifest.id,
        replayHash: semanticResult.manifest.replayHash,
      },
    });

    return {
      changedFiles: semanticResult.changedFiles,
    };
  }

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
  } else if (plan.intent.type === "move") {
    applyMove(plan, graph, project, snapshot.root, plan.intent);
  } else if (plan.intent.type === "extract") {
    applyExtract(plan, graph, project, snapshot.root, plan.intent);
  } else {
    const unsupportedIntent: never = plan.intent;
    throw new Error(`Refactor intent is not yet executable: ${JSON.stringify(unsupportedIntent)}`);
  }

  const beforeMap = new Map(snapshot.files.map((file) => [normalizePath(file.path), file.content] as const));
  const changedFiles: FileMap = {};

  for (const sourceFile of project.getSourceFiles().sort((left, right) => left.getFilePath().localeCompare(right.getFilePath()))) {
    const filePath = normalizePath(sourceFile.getFilePath());
    const before = beforeMap.get(filePath);
    const after = sourceFile.getFullText();

    if (before === undefined) {
      if (after.trim().length === 0) {
        continue;
      }

      changedFiles[toStableFilePath(snapshot.root, filePath)] = after;
      continue;
    }

    if (before === after) {
      continue;
    }

    changedFiles[toStableFilePath(snapshot.root, filePath)] = after;
  }

  recordMutationTrace(snapshot.root, {
    source: "refactor-engine",
    mechanism: "ts-morph",
    safety: "conditionally-safe",
    operation: plan.intent.type,
    targetFiles: Object.keys(changedFiles),
    detail: `affectedSymbols=${plan.impact.affectedSymbols.length}`,
    payload: {
      intent: plan.intent,
      impact: plan.impact,
      changedFiles: Object.keys(changedFiles).sort((left, right) => left.localeCompare(right)),
    },
  });

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

  const existingFiles = snapshot.files.map((file) => ({
    path: file.path,
    content: changedByAbsolute.get(normalizePath(file.path)) ?? file.content,
  }));

  const existingFileSet = new Set(existingFiles.map((file) => normalizePath(file.path)));
  const createdFiles = [...changedByAbsolute.entries()]
    .filter(([absolutePath]) => !existingFileSet.has(absolutePath))
    .map(([absolutePath, content]) => ({
      path: absolutePath,
      content,
    }));

  return {
    root: snapshot.root,
    files: [...existingFiles, ...createdFiles]
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
    const target = (plan.intent.type === "move"
      ? (plan.intent.targetFile ?? plan.intent.to ?? "")
      : (plan.intent.targetFile ?? plan.intent.targetUnit ?? "")).toLowerCase();
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

function snapshotFilesForPreview(root: string, preview: RefactorPreview): Record<string, string> {
  const files: Record<string, string> = {};

  for (const file of sortedUnique(preview.changes.map((change) => change.file))) {
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
    createdAt: deterministicTimestampFromString(snapshotId),
    files: snapshotFilesForPreview(options.root, preview),
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

  const applied = await applyRefactorPlan(plan, graph, snapshot);
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
