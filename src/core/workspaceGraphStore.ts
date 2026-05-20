import fs from "fs";
import path from "path";
import { detectWorkspace } from "./workspaceDetection.js";
import { deterministicHash, stableSortBy } from "./deterministicCore.js";
import { CompilerWorkspace } from "./compilerWorkspace.js";
import type { FileContext } from "./context.js";

export type WorkspaceGraphNode = {
  id: string;
  type: "project" | "file" | "symbol" | "unit";
  label: string;
  metadata: Record<string, unknown>;
};

export type WorkspaceGraphEdge = {
  from: string;
  to: string;
  type: "imports" | "exports" | "depends-on" | "contains";
};

export type WorkspaceGraphInvalidation = {
  sourceHash: string;
  tsconfigHash: string;
  packageHash: string;
  workspaceHash: string;
};

export type WorkspaceGraphSnapshot = {
  root: string;
  invalidation: WorkspaceGraphInvalidation;
  nodes: WorkspaceGraphNode[];
  edges: WorkspaceGraphEdge[];
};

export type PackageGraph = {
  nodes: Array<{ id: string; label: string; relPath: string; packageName?: string }>;
  edges: Array<{ from: string; to: string; type: "depends-on" }>;
};

export type ImportGraph = {
  edges: Array<{ from: string; to: string; type: "imports"; projectId: string; external: boolean; moduleSpecifier: string }>;
};

export type WorkspaceGraphStoreOptions = {
  root: string;
  files?: readonly FileContext[];
};

type WorkspaceUnit = {
  id: string;
  relPath: string;
  packageName?: string;
  dependencyNames: string[];
};

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function readPackageJson(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function packageDependencyNames(pkg: Record<string, unknown> | null): string[] {
  if (!pkg) {
    return [];
  }

  const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const names: string[] = [];

  for (const field of fields) {
    const value = pkg[field];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    names.push(...Object.keys(value));
  }

  return sortedUnique(names);
}

function loadWorkspaceUnits(root: string): WorkspaceUnit[] {
  const workspace = detectWorkspace(root);
  const paths = workspace.packages.length > 0 ? workspace.packages : ["."];

  return stableSortBy(paths.map((relPath) => {
    const packageJsonPath = path.join(root, relPath, "package.json");
    const pkg = readPackageJson(packageJsonPath);
    const packageName = typeof pkg?.name === "string" && pkg.name.trim().length > 0
      ? pkg.name.trim()
      : undefined;

    return {
      id: `unit:${normalizePath(relPath)}`,
      relPath: normalizePath(relPath),
      packageName,
      dependencyNames: packageDependencyNames(pkg),
    } satisfies WorkspaceUnit;
  }), (unit) => unit.id);
}

function packageManifestHash(root: string, units: WorkspaceUnit[]): string {
  const payload = units.map((unit) => {
    const packageJsonPath = unit.relPath === "."
      ? path.join(root, "package.json")
      : path.join(root, unit.relPath, "package.json");
    return {
      relPath: unit.relPath,
      packageJsonPath: normalizePath(path.relative(root, packageJsonPath)),
      packageJson: readPackageJson(packageJsonPath),
    };
  });

  return deterministicHash(payload);
}

function buildPackageGraph(units: WorkspaceUnit[]): PackageGraph {
  const nodes = units.map((unit) => ({
    id: unit.id,
    label: unit.packageName ?? (unit.relPath === "." ? "workspace-root" : unit.relPath.split("/").slice(-1)[0] ?? unit.relPath),
    relPath: unit.relPath,
    ...(unit.packageName ? { packageName: unit.packageName } : {}),
  }));

  const byPackageName = new Map(
    units
      .filter((unit) => typeof unit.packageName === "string")
      .map((unit) => [unit.packageName as string, unit] as const)
  );

  const edges = sortedUnique(
    units.flatMap((unit) =>
      unit.dependencyNames
        .map((name) => {
          const dependency = byPackageName.get(name);
          if (!dependency || dependency.id === unit.id) {
            return undefined;
          }

          return `${unit.id}->${dependency.id}`;
        })
        .filter((value): value is string => typeof value === "string")
    )
  ).map((edge) => {
    const [from, to] = edge.split("->");
    return {
      from: from as string,
      to: to as string,
      type: "depends-on" as const,
    };
  });

  return {
    nodes,
    edges,
  };
}

function workspaceSummaryFromFiles(sourceFiles: readonly { relativePath: string }[]): {
  totalFiles: number;
  services: number;
  controllers: number;
  repositories: number;
} {
  const names = sourceFiles.map((file) => file.relativePath.toLowerCase());

  return {
    totalFiles: names.length,
    services: names.filter((entry) => entry.includes("service")).length,
    controllers: names.filter((entry) => entry.includes("controller")).length,
    repositories: names.filter((entry) => entry.includes("repository")).length,
  };
}

export class WorkspaceGraphStore {
  readonly root: string;
  readonly snapshot: WorkspaceGraphSnapshot;
  private readonly compilerWorkspace: CompilerWorkspace;
  private readonly packageGraph: PackageGraph;

  constructor(options: WorkspaceGraphStoreOptions) {
    this.root = path.resolve(options.root);
    this.compilerWorkspace = new CompilerWorkspace({
      root: this.root,
      files: options.files,
    });

    const units = loadWorkspaceUnits(this.root);
    this.packageGraph = buildPackageGraph(units);

    const importEdges = this.compilerWorkspace.getResolvedImports()
      .filter((entry) => typeof entry.resolvedFile === "string")
      .map((entry) => ({
        from: entry.file,
        to: entry.resolvedFile as string,
        type: "imports" as const,
      }));

    const exportEdges = this.compilerWorkspace.getExportedSymbols().map((entry) => ({
      from: entry.file,
      to: `symbol:${entry.symbolId}`,
      type: "exports" as const,
    }));

    const nodes: WorkspaceGraphNode[] = [
      ...this.compilerWorkspace.snapshot.projects.map((project) => ({
        id: `project:${project.id}`,
        type: "project" as const,
        label: project.id,
        metadata: {
          root: project.root,
          tsconfig: project.tsconfigRelativePath ?? "virtual",
        },
      })),
      ...this.compilerWorkspace.getSourceFiles().map((file) => ({
        id: `file:${file.relativePath}`,
        type: "file" as const,
        label: file.relativePath,
        metadata: {
          projectId: file.projectId,
          extension: file.extension,
          declaration: file.isDeclaration,
        },
      })),
      ...this.compilerWorkspace.getExportedSymbols().map((symbol) => ({
        id: `symbol:${symbol.symbolId}`,
        type: "symbol" as const,
        label: symbol.name,
        metadata: {
          file: symbol.file,
          escapedName: symbol.escapedName,
          declarationKind: symbol.declarationKind ?? "Unknown",
        },
      })),
      ...this.packageGraph.nodes.map((unit) => ({
        id: unit.id,
        type: "unit" as const,
        label: unit.label,
        metadata: {
          relPath: unit.relPath,
          ...(unit.packageName ? { packageName: unit.packageName } : {}),
        },
      })),
    ];

    const unitContainsEdges: WorkspaceGraphEdge[] = this.packageGraph.nodes.flatMap((unit) =>
      this.compilerWorkspace.getSourceFiles()
        .filter((sourceFile) => {
          if (unit.relPath === ".") {
            return true;
          }

          return sourceFile.relativePath === unit.relPath
            || sourceFile.relativePath.startsWith(`${unit.relPath}/`);
        })
        .map((sourceFile) => ({
          from: unit.id,
          to: `file:${sourceFile.relativePath}`,
          type: "contains" as const,
        }))
    );

    const edges: WorkspaceGraphEdge[] = [
      ...this.packageGraph.edges,
      ...importEdges,
      ...exportEdges,
      ...unitContainsEdges,
    ].sort((left, right) =>
      left.type.localeCompare(right.type)
      || left.from.localeCompare(right.from)
      || left.to.localeCompare(right.to)
    );

    const invalidation = {
      sourceHash: this.compilerWorkspace.snapshot.contentHash,
      tsconfigHash: this.compilerWorkspace.snapshot.configHash,
      packageHash: packageManifestHash(this.root, units),
      workspaceHash: "",
    } satisfies WorkspaceGraphInvalidation;
    invalidation.workspaceHash = deterministicHash(invalidation);

    this.snapshot = {
      root: this.root,
      invalidation,
      nodes: stableSortBy(nodes, (node) => node.id),
      edges,
    };
  }

  getPackageGraph(): PackageGraph {
    return {
      nodes: [...this.packageGraph.nodes],
      edges: [...this.packageGraph.edges],
    };
  }

  getImportGraph(): ImportGraph {
    return {
      edges: this.compilerWorkspace.getResolvedImports()
        .map((entry) => ({
          from: entry.file,
          to: entry.resolvedFile ?? entry.moduleSpecifier,
          type: "imports" as const,
          projectId: entry.projectId,
          external: entry.isExternal,
          moduleSpecifier: entry.moduleSpecifier,
        }))
        .sort((left, right) =>
          left.from.localeCompare(right.from)
          || left.to.localeCompare(right.to)
          || left.moduleSpecifier.localeCompare(right.moduleSpecifier)
        ),
    };
  }

  getCompilerWorkspace(): CompilerWorkspace {
    return this.compilerWorkspace;
  }

  getWorkspaceSummary(): {
    totalFiles: number;
    services: number;
    controllers: number;
    repositories: number;
  } {
    return workspaceSummaryFromFiles(this.compilerWorkspace.getSourceFiles());
  }
}
