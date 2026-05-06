import fs from "fs";
import path from "path";
import { globSync } from "glob";
import * as YAML from "yaml";

export type WorkspaceConfig = {
  type: "pnpm" | "yarn" | "npm" | "nx" | "turbo";
  root: string;
  packages: string[];
};

const DEFAULT_PACKAGE_PATTERNS = ["apps/*", "packages/*", "libs/*"];
const GLOB_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/out/**",
];

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function exists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function readJSONFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as unknown;
}

function readRootPackageJson(root: string): Record<string, unknown> | null {
  const packageJsonPath = path.join(root, "package.json");
  if (!exists(packageJsonPath)) {
    return null;
  }

  const parsed = readJSONFile(packageJsonPath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid package.json at ${packageJsonPath}`);
  }

  return parsed as Record<string, unknown>;
}

function workspacePatternsFromPackageJson(pkg: Record<string, unknown> | null): string[] {
  if (!pkg) {
    return [];
  }

  const workspaces = pkg.workspaces;
  if (Array.isArray(workspaces)) {
    return sortedUnique(
      workspaces
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => normalizePattern(entry))
        .filter((entry) => entry.length > 0)
    );
  }

  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) {
    return [];
  }

  const record = workspaces as Record<string, unknown>;
  if (!Array.isArray(record.packages)) {
    return [];
  }

  return sortedUnique(
    record.packages
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => normalizePattern(entry))
      .filter((entry) => entry.length > 0)
  );
}

function workspacePatternsFromPnpmFile(root: string): string[] {
  const workspacePath = path.join(root, "pnpm-workspace.yaml");
  if (!exists(workspacePath)) {
    return [];
  }

  const raw = fs.readFileSync(workspacePath, "utf-8");
  const parsed = YAML.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.packages)) {
    return [];
  }

  return sortedUnique(
    record.packages
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => normalizePattern(entry))
      .filter((entry) => entry.length > 0)
  );
}

function discoverPackages(root: string, patterns: string[]): string[] {
  const fileMatches = new Set<string>();

  for (const pattern of sortedUnique(patterns.map((entry) => normalizePattern(entry)).filter((entry) => entry.length > 0))) {
    const filePattern = pattern.endsWith("package.json")
      ? pattern
      : `${pattern.replace(/\/+$/g, "")}/package.json`;

    const matches = globSync(filePattern, {
      cwd: root,
      nodir: true,
      ignore: GLOB_IGNORE,
      dot: false,
    }).sort((left, right) => left.localeCompare(right));

    for (const match of matches) {
      fileMatches.add(match.replace(/\\/g, "/"));
    }
  }

  return sortedUnique(
    [...fileMatches]
      .map((filePath) => path.posix.dirname(filePath))
      .filter((dirPath) => dirPath.length > 0 && dirPath !== ".")
  );
}

function detectPackageManagerType(root: string, pkg: Record<string, unknown> | null): "pnpm" | "yarn" | "npm" {
  const packageManager = typeof pkg?.packageManager === "string"
    ? pkg.packageManager.toLowerCase()
    : "";

  if (packageManager.startsWith("pnpm@") || exists(path.join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  if (packageManager.startsWith("yarn@") || exists(path.join(root, "yarn.lock"))) {
    return "yarn";
  }

  return "npm";
}

function fallbackPackages(root: string): string[] {
  const discovered = discoverPackages(root, DEFAULT_PACKAGE_PATTERNS);
  if (discovered.length > 0) {
    return discovered;
  }

  return exists(path.join(root, "package.json")) ? ["."] : [];
}

export function detectWorkspace(rootPath: string): WorkspaceConfig {
  const root = path.resolve(rootPath);
  const pkg = readRootPackageJson(root);
  const packageWorkspacePatterns = workspacePatternsFromPackageJson(pkg);

  if (exists(path.join(root, "nx.json"))) {
    const patterns = packageWorkspacePatterns.length > 0
      ? packageWorkspacePatterns
      : DEFAULT_PACKAGE_PATTERNS;

    return {
      type: "nx",
      root,
      packages: discoverPackages(root, patterns),
    };
  }

  if (exists(path.join(root, "turbo.json"))) {
    const patterns = packageWorkspacePatterns.length > 0
      ? packageWorkspacePatterns
      : DEFAULT_PACKAGE_PATTERNS;

    return {
      type: "turbo",
      root,
      packages: discoverPackages(root, patterns),
    };
  }

  if (exists(path.join(root, "pnpm-workspace.yaml"))) {
    const pnpmPatterns = workspacePatternsFromPnpmFile(root);
    const patterns = pnpmPatterns.length > 0
      ? pnpmPatterns
      : (packageWorkspacePatterns.length > 0 ? packageWorkspacePatterns : DEFAULT_PACKAGE_PATTERNS);

    return {
      type: "pnpm",
      root,
      packages: discoverPackages(root, patterns),
    };
  }

  if (packageWorkspacePatterns.length > 0) {
    return {
      type: detectPackageManagerType(root, pkg),
      root,
      packages: discoverPackages(root, packageWorkspacePatterns),
    };
  }

  return {
    type: detectPackageManagerType(root, pkg),
    root,
    packages: fallbackPackages(root),
  };
}