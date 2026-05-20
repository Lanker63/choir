import fs from "fs";
import path from "path";
import ts from "typescript";
import { deterministicHash } from "./deterministicCore.js";
import type { FileContext } from "./context.js";

export type CompilerSourceFile = {
  projectId: string;
  path: string;
  relativePath: string;
  extension: string;
  contentHash: string;
  isDeclaration: boolean;
};

export type CompilerResolvedImport = {
  projectId: string;
  file: string;
  moduleSpecifier: string;
  resolvedFile?: string;
  isExternal: boolean;
  isTypeOnly: boolean;
};

export type CompilerExportedSymbol = {
  projectId: string;
  file: string;
  name: string;
  escapedName: string;
  declarationKind?: string;
  declarationFile?: string;
  declarationStart?: number;
  symbolId: string;
};

export type CompilerDiagnosticSummary = {
  projectId: string;
  syntactic: number;
  semantic: number;
  options: number;
  global: number;
  total: number;
  diagnostics: readonly ts.Diagnostic[];
};

export type CompilerProject = {
  id: string;
  root: string;
  tsconfigPath?: string;
  tsconfigRelativePath?: string;
  rootNames: readonly string[];
  compilerOptions: ts.CompilerOptions;
  sourceFiles: readonly CompilerSourceFile[];
  configHash: string;
  contentHash: string;
  program: ts.Program;
};

export type CompilerWorkspaceSnapshot = {
  root: string;
  projects: readonly Omit<CompilerProject, "program">[];
  configHash: string;
  contentHash: string;
  workspaceHash: string;
};

type CompilerWorkspaceOptions = {
  root: string;
  files?: readonly FileContext[];
};

const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".git",
  "out",
  "dist",
  "build",
  "coverage",
]);

const ELIGIBLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
]);

function normalizePath(value: string): string {
  return path.resolve(value).split(path.sep).join("/");
}

function normalizeRelativePath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath).split(path.sep).join("/");
  return relative === "" ? "." : relative;
}

function isWithinRoot(root: string, absolutePath: string): boolean {
  const relative = path.relative(root, absolutePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isIgnoredRelative(relativePath: string): boolean {
  const normalized = relativePath.split("\\").join("/");
  return normalized === ".choir/artifacts" || normalized.startsWith(".choir/artifacts/");
}

function isEligibleSourcePath(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return ELIGIBLE_EXTENSIONS.has(extension);
}

function readFileIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

function createOverlay(files?: readonly FileContext[]): Map<string, string> {
  const overlay = new Map<string, string>();
  for (const file of files ?? []) {
    overlay.set(normalizePath(file.path), file.content);
  }

  return overlay;
}

function overlaySourceFiles(root: string, overlay: ReadonlyMap<string, string>): string[] {
  return [...overlay.keys()]
    .filter((filePath) => isWithinRoot(root, filePath) && isEligibleSourcePath(filePath))
    .sort((left, right) => left.localeCompare(right));
}

function fileExistsInOverlayOrDisk(overlay: ReadonlyMap<string, string>, filePath: string): boolean {
  return overlay.has(normalizePath(filePath)) || ts.sys.fileExists(filePath);
}

function readFromOverlayOrDisk(overlay: ReadonlyMap<string, string>, filePath: string): string | undefined {
  return overlay.get(normalizePath(filePath)) ?? ts.sys.readFile(filePath);
}

function discoverFiles(root: string, predicate: (filePath: string) => boolean): string[] {
  const discovered: string[] = [];

  function walk(directory: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(root, absolutePath);
      if (isIgnoredRelative(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
          continue;
        }

        walk(absolutePath);
        continue;
      }

      if (entry.isFile() && predicate(absolutePath)) {
        discovered.push(normalizePath(absolutePath));
      }
    }
  }

  walk(root);
  return discovered.sort((left, right) => left.localeCompare(right));
}

function discoverTsconfigs(root: string): string[] {
  return discoverFiles(root, (filePath) => path.basename(filePath) === "tsconfig.json");
}

function discoverEligibleSourceFiles(root: string): string[] {
  return discoverFiles(root, isEligibleSourcePath);
}

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    allowJs: true,
    noEmit: true,
  };
}

function configHashFor(tsconfigPath: string | undefined, options: ts.CompilerOptions, rootNames: readonly string[]): string {
  const configText = tsconfigPath ? readFileIfExists(tsconfigPath) ?? "" : "";
  return deterministicHash({
    tsconfigPath: tsconfigPath ? normalizePath(tsconfigPath) : "virtual",
    configText,
    options,
    rootNames: [...rootNames].sort((left, right) => left.localeCompare(right)),
  });
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js") return ts.ScriptKind.JS;
  if (extension === ".mts") return ts.ScriptKind.TS;
  if (extension === ".cts") return ts.ScriptKind.TS;
  return ts.ScriptKind.TS;
}

function createCompilerHost(options: ts.CompilerOptions, overlay: ReadonlyMap<string, string>): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const baseReadFile = host.readFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  const baseGetSourceFile = host.getSourceFile.bind(host);

  host.readFile = (fileName) => overlay.get(normalizePath(fileName)) ?? baseReadFile(fileName);
  host.fileExists = (fileName) => overlay.has(normalizePath(fileName)) || baseFileExists(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const overlaid = overlay.get(normalizePath(fileName));
    if (overlaid !== undefined) {
      return ts.createSourceFile(fileName, overlaid, languageVersion, true, scriptKindFor(fileName));
    }

    return baseGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };

  return host;
}

function parseTsconfig(root: string, tsconfigPath: string, overlay: ReadonlyMap<string, string>): {
  rootNames: string[];
  compilerOptions: ts.CompilerOptions;
} {
  const config = ts.readConfigFile(tsconfigPath, (filePath) => readFromOverlayOrDisk(overlay, filePath));
  if (config.error) {
    return {
      rootNames: [],
      compilerOptions: defaultCompilerOptions(),
    };
  }

  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: (filePath) => fileExistsInOverlayOrDisk(overlay, filePath),
    readFile: (filePath) => readFromOverlayOrDisk(overlay, filePath),
    readDirectory: ts.sys.readDirectory,
  };

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    host,
    path.dirname(tsconfigPath),
    undefined,
    tsconfigPath
  );

  return {
    rootNames: parsed.fileNames
      .map((fileName) => normalizePath(fileName))
      .filter((fileName) => isWithinRoot(root, fileName))
      .sort((left, right) => left.localeCompare(right)),
    compilerOptions: {
      ...parsed.options,
      noEmit: true,
    },
  };
}

function sourceFileSummary(
  projectId: string,
  root: string,
  sourceFile: ts.SourceFile,
  overlay: ReadonlyMap<string, string>
): CompilerSourceFile | null {
  const absolutePath = normalizePath(sourceFile.fileName);
  if (!isWithinRoot(root, absolutePath) || !isEligibleSourcePath(absolutePath)) {
    return null;
  }

  const relativePath = normalizeRelativePath(root, absolutePath);
  if (isIgnoredRelative(relativePath)) {
    return null;
  }

  const content = overlay.get(absolutePath) ?? sourceFile.text;
  return {
    projectId,
    path: absolutePath,
    relativePath,
    extension: path.extname(absolutePath).toLowerCase(),
    contentHash: deterministicHash(content),
    isDeclaration: sourceFile.isDeclarationFile,
  };
}

function makeProjectId(root: string, tsconfigPath: string | undefined): string {
  if (!tsconfigPath) {
    return "virtual";
  }

  return `tsconfig:${normalizeRelativePath(root, tsconfigPath)}`;
}

function buildProject(input: {
  root: string;
  tsconfigPath?: string;
  rootNames: readonly string[];
  compilerOptions: ts.CompilerOptions;
  overlay: ReadonlyMap<string, string>;
}): CompilerProject {
  const id = makeProjectId(input.root, input.tsconfigPath);
  const program = ts.createProgram(
    [...input.rootNames].sort((left, right) => left.localeCompare(right)),
    input.compilerOptions,
    createCompilerHost(input.compilerOptions, input.overlay)
  );

  const sourceFiles = program
    .getSourceFiles()
    .map((sourceFile) => sourceFileSummary(id, input.root, sourceFile, input.overlay))
    .filter((sourceFile): sourceFile is CompilerSourceFile => sourceFile !== null)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return {
    id,
    root: input.root,
    ...(input.tsconfigPath
      ? {
        tsconfigPath: input.tsconfigPath,
        tsconfigRelativePath: normalizeRelativePath(input.root, input.tsconfigPath),
      }
      : {}),
    rootNames: [...input.rootNames].sort((left, right) => left.localeCompare(right)),
    compilerOptions: input.compilerOptions,
    sourceFiles,
    configHash: configHashFor(input.tsconfigPath, input.compilerOptions, input.rootNames),
    contentHash: deterministicHash(sourceFiles.map((file) => ({
      path: file.relativePath,
      contentHash: file.contentHash,
    }))),
    program,
  };
}

function diagnosticSortKey(diagnostic: ts.Diagnostic): string {
  return [
    diagnostic.file?.fileName ?? "",
    String(diagnostic.start ?? 0).padStart(12, "0"),
    String(diagnostic.length ?? 0).padStart(12, "0"),
    String(diagnostic.code),
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  ].join(":");
}

function sortDiagnostics(diagnostics: readonly ts.Diagnostic[]): ts.Diagnostic[] {
  return [...diagnostics].sort((left, right) => diagnosticSortKey(left).localeCompare(diagnosticSortKey(right)));
}

function importIsTypeOnly(statement: ts.ImportDeclaration): boolean {
  return statement.importClause?.isTypeOnly === true;
}

function symbolDeclarationId(root: string, projectId: string, symbol: ts.Symbol): {
  symbolId: string;
  declarationKind?: string;
  declarationFile?: string;
  declarationStart?: number;
} {
  const declarations = [...(symbol.declarations ?? [])].sort((left, right) => {
    const leftFile = normalizePath(left.getSourceFile().fileName);
    const rightFile = normalizePath(right.getSourceFile().fileName);
    if (leftFile !== rightFile) {
      return leftFile.localeCompare(rightFile);
    }

    return left.getStart() - right.getStart();
  });
  const declaration = declarations[0];
  if (!declaration) {
    return {
      symbolId: deterministicHash({ projectId, name: symbol.getEscapedName().toString() }),
    };
  }

  const declarationFile = normalizeRelativePath(root, normalizePath(declaration.getSourceFile().fileName));
  const declarationStart = declaration.getStart();
  return {
    symbolId: `${projectId}:${declarationFile}:${declarationStart}:${symbol.getEscapedName().toString()}`,
    declarationKind: ts.SyntaxKind[declaration.kind] ?? "Unknown",
    declarationFile,
    declarationStart,
  };
}

export class CompilerWorkspace {
  readonly root: string;
  readonly projects: readonly CompilerProject[];
  readonly snapshot: CompilerWorkspaceSnapshot;
  private readonly overlay: ReadonlyMap<string, string>;

  constructor(options: CompilerWorkspaceOptions) {
    this.root = normalizePath(options.root);
    const overlay = createOverlay(options.files);
    this.overlay = overlay;
    const discoveredTsconfigs = discoverTsconfigs(this.root);
    const snapshotSourceFiles = overlaySourceFiles(this.root, overlay);

    const projects = discoveredTsconfigs.flatMap((tsconfigPath) => {
      const parsed = parseTsconfig(this.root, tsconfigPath, overlay);
      const parsedRootNameSet = new Set(parsed.rootNames);
      const projectRootNames = overlay.size > 0 && parsed.rootNames.length > 0
        ? snapshotSourceFiles.filter((filePath) => parsedRootNameSet.has(filePath))
        : parsed.rootNames;
      if (projectRootNames.length === 0) {
        return [];
      }

      return buildProject({
        root: this.root,
        tsconfigPath,
        rootNames: projectRootNames,
        compilerOptions: parsed.compilerOptions,
        overlay,
      });
    });

    const sourceFiles = overlay.size > 0
      ? snapshotSourceFiles
      : discoverEligibleSourceFiles(this.root);

    this.projects = projects.length > 0
      ? projects.sort((left, right) => left.id.localeCompare(right.id))
      : [buildProject({
        root: this.root,
        rootNames: sourceFiles,
        compilerOptions: defaultCompilerOptions(),
        overlay,
      })];

    const projectSnapshots = this.projects.map(({ program: _program, ...project }) => project);
    const configHash = deterministicHash(projectSnapshots.map((project) => ({
      id: project.id,
      configHash: project.configHash,
    })));
    const contentHash = deterministicHash(projectSnapshots.map((project) => ({
      id: project.id,
      contentHash: project.contentHash,
    })));

    this.snapshot = {
      root: this.root,
      projects: projectSnapshots,
      configHash,
      contentHash,
      workspaceHash: deterministicHash({ configHash, contentHash }),
    };
  }

  getProgram(projectId: string): ts.Program | undefined {
    return this.projects.find((project) => project.id === projectId)?.program;
  }

  getSourceFiles(projectId?: string): CompilerSourceFile[] {
    const projects = projectId
      ? this.projects.filter((project) => project.id === projectId)
      : this.projects;

    return projects
      .flatMap((project) => project.sourceFiles)
      .sort((left, right) =>
        left.projectId.localeCompare(right.projectId)
        || left.relativePath.localeCompare(right.relativePath)
      );
  }

  getDiagnostics(projectId?: string): CompilerDiagnosticSummary[] {
    const projects = projectId
      ? this.projects.filter((project) => project.id === projectId)
      : this.projects;

    return projects
      .map((project) => {
        const syntactic = sortDiagnostics(project.program.getSyntacticDiagnostics());
        const semantic = sortDiagnostics(project.program.getSemanticDiagnostics());
        const options = sortDiagnostics(project.program.getOptionsDiagnostics());
        const global = sortDiagnostics(project.program.getGlobalDiagnostics());
        const diagnostics = sortDiagnostics([...syntactic, ...semantic, ...options, ...global]);
        return {
          projectId: project.id,
          syntactic: syntactic.length,
          semantic: semantic.length,
          options: options.length,
          global: global.length,
          total: diagnostics.length,
          diagnostics,
        };
      })
      .sort((left, right) => left.projectId.localeCompare(right.projectId));
  }

  getResolvedImports(projectId?: string): CompilerResolvedImport[] {
    const projects = projectId
      ? this.projects.filter((project) => project.id === projectId)
      : this.projects;
    const imports: CompilerResolvedImport[] = [];

    for (const project of projects) {
      const projectFiles = new Set(project.sourceFiles.map((file) => file.path));
      for (const sourceFile of project.program.getSourceFiles()) {
        const sourceAbsolute = normalizePath(sourceFile.fileName);
        if (!projectFiles.has(sourceAbsolute)) {
          continue;
        }

        const file = normalizeRelativePath(this.root, sourceAbsolute);
        for (const statement of sourceFile.statements) {
          if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
            continue;
          }

          const moduleSpecifier = statement.moduleSpecifier.text;
          const resolved = ts.resolveModuleName(
            moduleSpecifier,
            sourceFile.fileName,
            project.compilerOptions,
            createCompilerHost(project.compilerOptions, this.overlay)
          ).resolvedModule;
          const resolvedFile = resolved?.resolvedFileName && isWithinRoot(this.root, normalizePath(resolved.resolvedFileName))
            ? normalizeRelativePath(this.root, normalizePath(resolved.resolvedFileName))
            : undefined;

          imports.push({
            projectId: project.id,
            file,
            moduleSpecifier,
            ...(resolvedFile ? { resolvedFile } : {}),
            isExternal: !moduleSpecifier.startsWith("."),
            isTypeOnly: importIsTypeOnly(statement),
          });
        }
      }
    }

    return imports.sort((left, right) =>
      left.projectId.localeCompare(right.projectId)
      || left.file.localeCompare(right.file)
      || left.moduleSpecifier.localeCompare(right.moduleSpecifier)
      || (left.resolvedFile ?? "").localeCompare(right.resolvedFile ?? "")
    );
  }

  getExportedSymbols(projectId?: string): CompilerExportedSymbol[] {
    const projects = projectId
      ? this.projects.filter((project) => project.id === projectId)
      : this.projects;
    const exported: CompilerExportedSymbol[] = [];

    for (const project of projects) {
      const checker = project.program.getTypeChecker();
      const projectFiles = new Set(project.sourceFiles.map((file) => file.path));
      for (const sourceFile of project.program.getSourceFiles()) {
        const sourceAbsolute = normalizePath(sourceFile.fileName);
        if (!projectFiles.has(sourceAbsolute)) {
          continue;
        }

        const moduleSymbol = (sourceFile as ts.SourceFile & { symbol?: ts.Symbol }).symbol;
        if (!moduleSymbol) {
          continue;
        }

        const file = normalizeRelativePath(this.root, sourceAbsolute);
        const symbols = checker.getExportsOfModule(moduleSymbol)
          .sort((left, right) => left.getEscapedName().toString().localeCompare(right.getEscapedName().toString()));
        for (const symbol of symbols) {
          const declaration = symbolDeclarationId(this.root, project.id, symbol);
          exported.push({
            projectId: project.id,
            file,
            name: symbol.getName(),
            escapedName: symbol.getEscapedName().toString(),
            ...declaration,
          });
        }
      }
    }

    return exported.sort((left, right) =>
      left.projectId.localeCompare(right.projectId)
      || left.file.localeCompare(right.file)
      || left.name.localeCompare(right.name)
      || left.symbolId.localeCompare(right.symbolId)
    );
  }
}
