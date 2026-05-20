import path from "path";
import fs from "fs";
import ts from "typescript";
import { Node, Project, SyntaxKind, type SourceFile } from "ts-morph";
import { deterministicHash, deterministicId, stableSortBy } from "./deterministicCore.js";
import { CompilerWorkspace } from "./compilerWorkspace.js";
import type { FileContext } from "./context.js";
import type { SemanticMutation, SemanticMutationManifest } from "./semanticMutation.js";
import { WorkspaceGraphStore } from "./workspaceGraphStore.js";

export type { SemanticMutation } from "./semanticMutation.js";

export type ExecuteSemanticMutationsInput = {
  root: string;
  files?: readonly FileContext[];
  mutations: SemanticMutation[];
};

export type ExecuteSemanticMutationsResult = {
  changedFiles: Record<string, string>;
  deletedFiles: string[];
  manifest: SemanticMutationManifest;
};

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function toRelative(root: string, filePath: string): string {
  const normalized = normalizePath(filePath);
  if (!path.isAbsolute(filePath)) {
    return normalized;
  }

  const relative = normalizePath(path.relative(root, filePath));
  if (relative.startsWith("../") || relative === "..") {
    throw new Error(`Path escapes workspace root: ${filePath}`);
  }

  return relative.length === 0 ? "." : relative;
}

function toAbsolute(root: string, filePath: string): string {
  return path.resolve(root, filePath);
}

function createProject(root: string, files: Record<string, string>): Project {
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

  for (const [relativePath, content] of stableSortBy(Object.entries(files), ([key]) => key)) {
    project.createSourceFile(toAbsolute(root, relativePath), content, { overwrite: true });
  }

  return project;
}

function getNameIdentifier(node: Node): Node | undefined {
  const nameNode = "getNameNode" in node
    ? (node as unknown as { getNameNode?: () => Node | undefined }).getNameNode?.()
    : undefined;
  if (nameNode) {
    return nameNode;
  }

  return node.getFirstDescendantByKind(SyntaxKind.Identifier) ?? undefined;
}

function findDeclarationByHint(project: Project, root: string, hint: { file: string; name: string }): Node {
  const sourceFile = project.getSourceFile(toAbsolute(root, hint.file));
  if (!sourceFile) {
    throw new Error(`Symbol file not found: ${hint.file}`);
  }

  const topLevelCandidates = sourceFile.getStatements().filter((statement) => {
    if (Node.isFunctionDeclaration(statement) || Node.isClassDeclaration(statement) || Node.isInterfaceDeclaration(statement)
      || Node.isTypeAliasDeclaration(statement) || Node.isEnumDeclaration(statement)) {
      return statement.getName?.() === hint.name;
    }

    if (Node.isVariableStatement(statement)) {
      return statement.getDeclarations().some((declaration) => declaration.getName() === hint.name);
    }

    return false;
  });

  if (topLevelCandidates.length > 0) {
    const first = topLevelCandidates[0];
    if (Node.isVariableStatement(first)) {
      const declaration = first.getDeclarations().find((entry) => entry.getName() === hint.name);
      if (declaration) {
        return declaration;
      }
    }

    return first;
  }

  const identifier = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)
    .find((entry) => entry.getText() === hint.name);

  if (!identifier) {
    throw new Error(`Symbol not found: ${hint.name} in ${hint.file}`);
  }

  const declaration = identifier.getDefinitions()[0]?.getDeclarationNode();
  if (!declaration) {
    throw new Error(`Unable to resolve symbol declaration: ${hint.name}`);
  }

  return declaration;
}

function applyRenameSymbol(project: Project, root: string, mutation: Extract<SemanticMutation, { kind: "RenameSymbol" }>): void {
  const declaration = findDeclarationByHint(project, root, mutation.symbolHint);
  const named = declaration as Node & { rename?: (name: string) => void };
  if (typeof named.rename !== "function") {
    const anchor = getNameIdentifier(declaration);
    const renameable = anchor as Node & { rename?: (name: string) => void };
    if (typeof renameable.rename !== "function") {
      throw new Error(`RenameSymbol unsupported declaration kind: ${declaration.getKindName()}`);
    }

    renameable.rename(mutation.newName);
    return;
  }

  named.rename(mutation.newName);
}

function rewriteModuleSpecifier(baseFile: SourceFile, fromAbsolute: string, toAbsolutePath: string): void {
  const moduleSpecifiers = baseFile.getImportDeclarations();

  for (const importDeclaration of moduleSpecifiers) {
    const specifier = importDeclaration.getModuleSpecifierValue();
    if (!specifier.startsWith(".")) {
      continue;
    }

    const resolved = normalizePath(path.resolve(path.dirname(baseFile.getFilePath()), specifier));
    const resolvedBase = resolved.replace(/\.(ts|tsx|mts|cts|js|jsx)$/i, "");
    const normalizedFrom = normalizePath(fromAbsolute);
    const fromBase = normalizedFrom.replace(/\.(ts|tsx|mts|cts|js|jsx)$/i, "");

    if (resolvedBase !== fromBase && `${resolvedBase}/index` !== fromBase) {
      continue;
    }

    let relative = normalizePath(path.relative(path.dirname(baseFile.getFilePath()), toAbsolutePath));
    if (!relative.startsWith(".")) {
      relative = `./${relative}`;
    }

    if (!relative.endsWith(".js")) {
      relative = `${relative.replace(/\.(ts|tsx|mts|cts|js|jsx)$/i, "")}.js`;
    }

    importDeclaration.setModuleSpecifier(relative);
  }
}

function applyRenameFile(project: Project, root: string, mutation: Extract<SemanticMutation, { kind: "RenameFile" }>): void {
  const fromAbsolute = toAbsolute(root, mutation.from);
  const toAbsolutePath = toAbsolute(root, mutation.to);
  const source = project.getSourceFile(fromAbsolute);

  if (!source) {
    throw new Error(`RenameFile source not found: ${mutation.from}`);
  }

  source.move(toAbsolutePath, { overwrite: true });

  if (!mutation.rewriteImports) {
    return;
  }

  for (const sourceFile of project.getSourceFiles()) {
    rewriteModuleSpecifier(sourceFile, fromAbsolute, toAbsolutePath);

    for (const importDeclaration of sourceFile.getImportDeclarations()) {
      const specifier = importDeclaration.getModuleSpecifierValue();
      if (!specifier.startsWith(".")) {
        continue;
      }

      if (/\.(js|mjs|cjs|json)$/i.test(specifier)) {
        continue;
      }

      importDeclaration.setModuleSpecifier(`${specifier}.js`);
    }
  }
}

function applyInlineSymbol(project: Project, root: string, mutation: Extract<SemanticMutation, { kind: "InlineSymbol" }>): void {
  const declarationNode = findDeclarationByHint(project, root, mutation.symbolHint);
  const declaration = Node.isVariableDeclaration(declarationNode)
    ? declarationNode
    : declarationNode.getFirstDescendantByKind(SyntaxKind.VariableDeclaration);

  if (!declaration) {
    throw new Error("InlineSymbol currently supports variable declarations only");
  }

  const initializer = declaration.getInitializer();
  if (!initializer) {
    throw new Error("InlineSymbol requires initializer");
  }

  const nameNode = declaration.getNameNode();
  if (!Node.isIdentifier(nameNode)) {
    throw new Error("InlineSymbol requires identifier binding");
  }

  const references = nameNode.findReferencesAsNodes()
    .sort((left, right) => right.getStart() - left.getStart());

  for (const reference of references) {
    if (reference.getStart() === nameNode.getStart()
      && reference.getSourceFile().getFilePath() === nameNode.getSourceFile().getFilePath()) {
      continue;
    }

    reference.replaceWithText(initializer.getText());
  }

  const statement = declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  const list = declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclarationList);

  if (statement && list && list.getDeclarations().length === 1) {
    statement.remove();
    return;
  }

  declaration.remove();
}

function applyMoveSymbol(project: Project, root: string, mutation: Extract<SemanticMutation, { kind: "MoveSymbol" }>): void {
  const declaration = findDeclarationByHint(project, root, mutation.symbolHint);
  const sourceFile = declaration.getSourceFile();
  const targetFilePath = toAbsolute(root, mutation.targetFile);
  const targetFile = project.getSourceFile(targetFilePath)
    ?? project.createSourceFile(targetFilePath, "", { overwrite: false });

  const text = declaration.getText();
  const removable = declaration as Node & { remove?: () => void };
  if (typeof removable.remove === "function") {
    removable.remove();
  } else {
    declaration.replaceWithText("");
  }
  targetFile.addStatements(`\n${text}\n`);

  const sourceWithoutExt = normalizePath(sourceFile.getFilePath()).replace(/\.(ts|tsx|mts|cts)$/, "");
  const targetWithoutExt = normalizePath(targetFile.getFilePath()).replace(/\.(ts|tsx|mts|cts)$/, "");

  for (const file of project.getSourceFiles()) {
    for (const importDeclaration of file.getImportDeclarations()) {
      const specifier = importDeclaration.getModuleSpecifierValue();
      if (!specifier.startsWith(".")) {
        continue;
      }

      const resolved = normalizePath(path.resolve(path.dirname(file.getFilePath()), specifier)).replace(/\.(ts|tsx|mts|cts|js|jsx)$/, "");
      if (resolved !== sourceWithoutExt) {
        continue;
      }

      const namedImports = importDeclaration.getNamedImports();
      const hasSymbol = namedImports.some((entry) => entry.getName() === mutation.symbolHint.name);
      if (!hasSymbol) {
        continue;
      }

      const currentFileBase = normalizePath(file.getFilePath()).replace(/\.(ts|tsx|mts|cts)$/i, "");
      if (currentFileBase === targetWithoutExt) {
        for (const namedImport of namedImports.filter((entry) => entry.getName() === mutation.symbolHint.name)) {
          namedImport.remove();
        }

        if (!importDeclaration.getDefaultImport()
          && !importDeclaration.getNamespaceImport()
          && importDeclaration.getNamedImports().length === 0) {
          importDeclaration.remove();
        }
        continue;
      }

      let nextSpecifier = normalizePath(path.relative(path.dirname(file.getFilePath()), targetWithoutExt));
      if (!nextSpecifier.startsWith(".")) {
        nextSpecifier = `./${nextSpecifier}`;
      }

      importDeclaration.setModuleSpecifier(`${nextSpecifier}.js`);
    }
  }
}

function applyAddOrMergeImport(project: Project, root: string, mutation: Extract<SemanticMutation, { kind: "AddImport" | "MergeImport" }>): void {
  const sourceFile = project.getSourceFile(toAbsolute(root, mutation.file));
  if (!sourceFile) {
    throw new Error(`Import target file not found: ${mutation.file}`);
  }

  let declaration = sourceFile.getImportDeclarations().find((entry) =>
    entry.getModuleSpecifierValue() === mutation.moduleSpecifier
  );

  if (!declaration) {
    declaration = sourceFile.addImportDeclaration({
      moduleSpecifier: mutation.moduleSpecifier,
      isTypeOnly: mutation.isTypeOnly ?? false,
      namedImports: [],
    });
  }

  const existing = new Set(declaration.getNamedImports().map((entry) => entry.getName()));
  for (const named of sortedUnique(mutation.namedImports)) {
    if (existing.has(named)) {
      continue;
    }

    declaration.addNamedImport(named);
  }
}

function applyUpdateExports(project: Project, root: string, mutation: Extract<SemanticMutation, { kind: "UpdateExports" }>): void {
  const sourceFile = project.getSourceFile(toAbsolute(root, mutation.file));
  if (!sourceFile) {
    throw new Error(`Export target file not found: ${mutation.file}`);
  }

  const existing = new Set(
    sourceFile.getExportDeclarations()
      .filter((entry) => !entry.isNamespaceExport())
      .flatMap((entry) => entry.getNamedExports().map((named) => named.getName()))
  );

  const toAdd = sortedUnique(mutation.namedExports).filter((name) => !existing.has(name));
  if (toAdd.length === 0) {
    return;
  }

  sourceFile.addExportDeclaration({
    namedExports: toAdd,
  });
}

function applyUpsertFile(project: Project, root: string, mutation: Extract<SemanticMutation, { kind: "UpsertFile" }>): void {
  const absolutePath = toAbsolute(root, mutation.file);
  const existing = project.getSourceFile(absolutePath);
  if (!existing) {
    project.createSourceFile(absolutePath, mutation.content, { overwrite: true });
    return;
  }

  existing.replaceWithText(mutation.content);
}

function applyMutation(project: Project, root: string, mutation: SemanticMutation): void {
  if (mutation.kind === "RenameSymbol") {
    applyRenameSymbol(project, root, mutation);
    return;
  }

  if (mutation.kind === "MoveSymbol") {
    applyMoveSymbol(project, root, mutation);
    return;
  }

  if (mutation.kind === "InlineSymbol") {
    applyInlineSymbol(project, root, mutation);
    return;
  }

  if (mutation.kind === "AddImport" || mutation.kind === "MergeImport") {
    applyAddOrMergeImport(project, root, mutation);
    return;
  }

  if (mutation.kind === "UpdateExports") {
    applyUpdateExports(project, root, mutation);
    return;
  }

  if (mutation.kind === "RenameFile") {
    applyRenameFile(project, root, mutation);
    return;
  }

  if (mutation.kind === "UpsertFile") {
    applyUpsertFile(project, root, mutation);
    return;
  }

  const exhaustive: never = mutation;
  throw new Error(`Unsupported mutation: ${JSON.stringify(exhaustive)}`);
}

function loadWorkspaceFiles(root: string, files?: readonly FileContext[]): Record<string, string> {
  const graphStore = new WorkspaceGraphStore({ root, files });
  const sourceFiles = graphStore.getCompilerWorkspace().getSourceFiles();

  const byRelative: Record<string, string> = {};
  for (const sourceFile of sourceFiles) {
    const filePath = toRelative(root, sourceFile.path);
    const overlayValue = files?.find((entry) => normalizePath(path.resolve(entry.path)) === normalizePath(sourceFile.path));
    if (overlayValue) {
      byRelative[filePath] = overlayValue.content;
      continue;
    }

    try {
      byRelative[filePath] = fs.readFileSync(sourceFile.path, "utf-8");
    } catch {
      byRelative[filePath] = "";
    }
  }

  return byRelative;
}

function compilerEvidence(root: string, files: Record<string, string>): {
  total: number;
  semantic: number;
  syntactic: number;
} {
  const fileContexts: FileContext[] = Object.entries(files).map(([relativePath, content]) => ({
    path: toAbsolute(root, relativePath),
    content,
  }));
  const workspace = new CompilerWorkspace({ root, files: fileContexts });
  const diagnostics = workspace.getDiagnostics();

  return diagnostics.reduce((acc, entry) => ({
    total: acc.total + entry.total,
    semantic: acc.semantic + entry.semantic,
    syntactic: acc.syntactic + entry.syntactic,
  }), { total: 0, semantic: 0, syntactic: 0 });
}

function importExportFingerprint(root: string, files: Record<string, string>): {
  imports: string[];
  exports: string[];
} {
  const contexts: FileContext[] = Object.entries(files).map(([relativePath, content]) => ({
    path: toAbsolute(root, relativePath),
    content,
  }));
  const workspace = new CompilerWorkspace({ root, files: contexts });

  const imports = workspace.getResolvedImports()
    .map((entry) => `${entry.file}->${entry.resolvedFile ?? entry.moduleSpecifier}`)
    .sort((left, right) => left.localeCompare(right));
  const exports = workspace.getExportedSymbols()
    .map((entry) => `${entry.file}:${entry.name}:${entry.symbolId}`)
    .sort((left, right) => left.localeCompare(right));

  return {
    imports,
    exports,
  };
}

export async function executeSemanticMutations(input: ExecuteSemanticMutationsInput): Promise<ExecuteSemanticMutationsResult> {
  const root = path.resolve(input.root);
  const beforeFiles = loadWorkspaceFiles(root, input.files);
  const beforeEvidence = compilerEvidence(root, beforeFiles);
  const beforeFingerprint = importExportFingerprint(root, beforeFiles);
  const beforeWorkspaceHash = deterministicHash(stableSortBy(Object.entries(beforeFiles), ([key]) => key));

  const project = createProject(root, beforeFiles);
  const orderedMutations = stableSortBy([...input.mutations], (mutation) => deterministicHash(mutation));

  for (const mutation of orderedMutations) {
    applyMutation(project, root, mutation);
  }

  const afterFilesEntries = project.getSourceFiles()
    .map((sourceFile) => [toRelative(root, sourceFile.getFilePath()), sourceFile.getFullText()] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const afterFiles = Object.fromEntries(afterFilesEntries);

  const changedFiles: Record<string, string> = {};
  const deletedFiles = sortedUnique(
    Object.keys(beforeFiles).filter((file) => !Object.prototype.hasOwnProperty.call(afterFiles, file))
  );

  for (const [file, content] of afterFilesEntries) {
    if (!Object.prototype.hasOwnProperty.call(beforeFiles, file) || beforeFiles[file] !== content) {
      changedFiles[file] = content;
    }
  }

  const afterEvidence = compilerEvidence(root, afterFiles);
  const afterFingerprint = importExportFingerprint(root, afterFiles);
  const afterWorkspaceHash = deterministicHash(afterFilesEntries);

  const importsAdded = afterFingerprint.imports.filter((entry) => !beforeFingerprint.imports.includes(entry));
  const importsRemoved = beforeFingerprint.imports.filter((entry) => !afterFingerprint.imports.includes(entry));
  const exportsAdded = afterFingerprint.exports.filter((entry) => !beforeFingerprint.exports.includes(entry));
  const exportsRemoved = beforeFingerprint.exports.filter((entry) => !afterFingerprint.exports.includes(entry));

  const fileDeltas = sortedUnique([...Object.keys(changedFiles), ...deletedFiles]).map((file) => ({
    file,
    operation: (!Object.prototype.hasOwnProperty.call(beforeFiles, file)
      ? "create"
      : deletedFiles.includes(file)
        ? "delete"
        : "update") as "create" | "update" | "delete",
    beforeHash: deterministicHash(beforeFiles[file] ?? ""),
    afterHash: deterministicHash(afterFiles[file] ?? ""),
  }));

  const replayPayload = {
    mutations: orderedMutations,
    beforeWorkspaceHash,
    afterWorkspaceHash,
    fileDeltas,
    compilerEvidence: {
      before: beforeEvidence,
      after: afterEvidence,
    },
  };

  const manifest: SemanticMutationManifest = {
    id: deterministicId("semantic-manifest", replayPayload, 16),
    replayHash: deterministicHash(replayPayload),
    mutationHash: deterministicHash(orderedMutations),
    beforeWorkspaceHash,
    afterWorkspaceHash,
    mutationCount: orderedMutations.length,
    compilerEvidence: {
      before: beforeEvidence,
      after: afterEvidence,
    },
    graphDelta: {
      importsAdded: importsAdded.length,
      importsRemoved: importsRemoved.length,
      exportsAdded: exportsAdded.length,
      exportsRemoved: exportsRemoved.length,
    },
    fileDeltas,
  };

  return {
    changedFiles,
    deletedFiles,
    manifest,
  };
}
