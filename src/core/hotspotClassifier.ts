import type { ControlPlane } from "../schema.js";

const LARGE_FILE_LINE_THRESHOLD = 500;
const GOD_FILE_LINE_THRESHOLD = 1000;

export const DEFAULT_HOTSPOT_IGNORE_GLOBS = ["**/node_modules/**"] as const;
const HOTSPOT_ROOT_SCOPE_KEYS = new Set(["", ".", "workspaceRoot"]);

function normalizeGlobPattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function scopePackageExcludeGlob(packagePath: string, pattern: string): string {
  const normalizedPattern = normalizeGlobPattern(pattern);
  if (normalizedPattern.length === 0) {
    return "";
  }

  const normalizedPackagePath = normalizeGlobPattern(packagePath);
  if (HOTSPOT_ROOT_SCOPE_KEYS.has(normalizedPackagePath)) {
    return normalizedPattern;
  }

  if (normalizedPattern.startsWith(`${normalizedPackagePath}/`)) {
    return normalizedPattern;
  }

  if (normalizedPattern.startsWith("/")) {
    return `${normalizedPackagePath}/${normalizedPattern.slice(1)}`;
  }

  return `${normalizedPackagePath}/${normalizedPattern}`;
}

export function resolveHotspotIgnoreGlobs(controlPlane?: ControlPlane | null): string[] {
  const configuredExcludeGlobs = controlPlane?.analysis?.hotspots?.excludeGlobs ?? {};
  const scopedConfiguredGlobs = Object.entries(configuredExcludeGlobs)
    .flatMap(([packagePath, globs]) => globs.map((glob) => scopePackageExcludeGlob(packagePath, glob)))
    .filter((glob) => glob.length > 0);

  return [...new Set([...DEFAULT_HOTSPOT_IGNORE_GLOBS, ...scopedConfiguredGlobs])]
    .sort((left, right) => left.localeCompare(right));
}

export function classifyHotspotEntries(file: string, content: string): string[] {
  const lineCount = content.split(/\r?\n/).length;

  if (lineCount > GOD_FILE_LINE_THRESHOLD) {
    return [`🧠 God file (${lineCount} LOC): ${file}`];
  }

  if (lineCount > LARGE_FILE_LINE_THRESHOLD) {
    return [`🔥 Large file (${lineCount} LOC): ${file}`];
  }

  return [];
}
