import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { z } from "zod";
import { parseCommand } from "./choirRouter.js";

export type MacroParameter = {
  name: string;
  required: boolean;
  default?: string;
};

export type Macro = {
  id: string;
  version?: string;
  description?: string;
  parameters?: MacroParameter[];
  body: string[];
};

export type MacroLibrary = {
  name: string;
  version: string;
  macros: Macro[];
  metadata: {
    description?: string;
    owner?: string;
  };
};

export type MacroLibraryCatalogEntry = {
  name: string;
  versions: string[];
};

export type MacroLibraryLock = {
  libraries: Record<string, string>;
};

export type MacroLibraryTrace = {
  library: string;
  version: string;
  macroId: string;
  resolvedVersion: string;
};

export type BreakingChangeResult = {
  breaking: boolean;
  reasons: string[];
};

const MACRO_PARAMETER_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const LIBRARY_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const SEMVER_EXACT_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const SEMVER_PATCH_SELECTOR_PATTERN = /^(\d+)\.(\d+)\.x$/;
const SEMVER_MINOR_SELECTOR_PATTERN = /^(\d+)\.x$/;

const MacroParameterSchema = z.object({
  name: z.string().regex(MACRO_PARAMETER_NAME_PATTERN),
  required: z.boolean(),
  default: z.string().optional(),
}).strict();

const MacroSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1).optional(),
  description: z.string().optional(),
  parameters: z.array(MacroParameterSchema).default([]),
  body: z.array(z.string().min(1)).min(1),
}).strict();

const MacroLibrarySchema = z.object({
  name: z.string().regex(LIBRARY_NAME_PATTERN),
  version: z.string().regex(SEMVER_EXACT_PATTERN),
  macros: z.array(MacroSchema).default([]),
  metadata: z.object({
    description: z.string().optional(),
    owner: z.string().optional(),
  }).default({}),
}).strict();

const MacroLockSchema = z.object({
  libraries: z.record(z.string().regex(LIBRARY_NAME_PATTERN), z.string().regex(SEMVER_EXACT_PATTERN)).default({}),
}).strict();

type ExactSemver = {
  major: number;
  minor: number;
  patch: number;
};

function choirRoot(root: string): string {
  return path.join(root, ".choir");
}

function librariesRoot(root: string): string {
  return path.join(choirRoot(root), "libraries");
}

function lockfilePath(root: string): string {
  return path.join(choirRoot(root), "lock.yaml");
}

function libraryVersionPath(root: string, name: string, version: string): string {
  return path.join(librariesRoot(root), name, version);
}

function libraryManifestPath(root: string, name: string, version: string): string {
  return path.join(libraryVersionPath(root, name, version), "macros.yaml");
}

function parseExactSemver(version: string): ExactSemver | null {
  const match = version.match(SEMVER_EXACT_PATTERN);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(left: string, right: string): number {
  const leftParsed = parseExactSemver(left);
  const rightParsed = parseExactSemver(right);
  if (!leftParsed || !rightParsed) {
    throw new Error(`Invalid semver comparison: ${left} vs ${right}`);
  }

  if (leftParsed.major !== rightParsed.major) {
    return leftParsed.major - rightParsed.major;
  }

  if (leftParsed.minor !== rightParsed.minor) {
    return leftParsed.minor - rightParsed.minor;
  }

  return leftParsed.patch - rightParsed.patch;
}

function sortMacros(macros: Macro[]): Macro[] {
  return [...macros]
    .map((macro) => ({
      ...macro,
      parameters: [...(macro.parameters ?? [])].sort((left, right) => left.name.localeCompare(right.name)),
      body: [...macro.body],
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function sortLibrary(library: MacroLibrary): MacroLibrary {
  return {
    name: library.name,
    version: library.version,
    metadata: {
      ...(library.metadata.description ? { description: library.metadata.description } : {}),
      ...(library.metadata.owner ? { owner: library.metadata.owner } : {}),
    },
    macros: sortMacros(library.macros),
  };
}

function ensureUniqueParameterNames(macro: Macro): void {
  const seen = new Set<string>();

  for (const parameter of macro.parameters ?? []) {
    if (seen.has(parameter.name)) {
      throw new Error(`Duplicate parameter in macro ${macro.id}: ${parameter.name}`);
    }

    seen.add(parameter.name);
  }
}

function parseLibraryVersionSelector(selector: string):
  | { type: "exact"; major: number; minor: number; patch: number }
  | { type: "patch"; major: number; minor: number }
  | { type: "minor"; major: number } {
  const exact = parseExactSemver(selector);
  if (exact) {
    return {
      type: "exact",
      ...exact,
    };
  }

  const patch = selector.match(SEMVER_PATCH_SELECTOR_PATTERN);
  if (patch) {
    return {
      type: "patch",
      major: Number(patch[1]),
      minor: Number(patch[2]),
    };
  }

  const minor = selector.match(SEMVER_MINOR_SELECTOR_PATTERN);
  if (minor) {
    return {
      type: "minor",
      major: Number(minor[1]),
    };
  }

  throw new Error(`Unsupported library version selector: ${selector}. Use exact (1.0.0), patch (1.0.x), or major (1.x).`);
}

function normalizeLock(lock: MacroLibraryLock): MacroLibraryLock {
  const sortedEntries = Object.entries(lock.libraries)
    .sort(([left], [right]) => left.localeCompare(right));

  return {
    libraries: Object.fromEntries(sortedEntries),
  };
}

function parseMacroSignature(macro: Macro): string {
  const normalizedParameters = [...(macro.parameters ?? [])]
    .map((parameter) => ({
      name: parameter.name,
      required: parameter.required,
      default: parameter.default ?? null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return JSON.stringify({
    id: macro.id,
    parameters: normalizedParameters,
  });
}

function validateLibraryEvolution(root: string, name: string, versions: string[]): void {
  const ordered = [...versions].sort((left, right) => compareSemver(left, right));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = loadMacroLibrary(root, name, ordered[index - 1]);
    const next = loadMacroLibrary(root, name, ordered[index]);

    const breaking = detectBreakingChanges(previous, next);
    if (!breaking.breaking) {
      continue;
    }

    const previousMajor = parseExactSemver(previous.version)?.major ?? -1;
    const nextMajor = parseExactSemver(next.version)?.major ?? -1;
    if (previousMajor === nextMajor) {
      throw new Error(
        `Breaking change detected in ${name} ${previous.version} -> ${next.version} without MAJOR bump: ${breaking.reasons.join("; ")}`
      );
    }
  }
}

export function validateLibrary(library: MacroLibrary): void {
  if (!LIBRARY_NAME_PATTERN.test(library.name)) {
    throw new Error(`Invalid library name: ${library.name}`);
  }

  if (!SEMVER_EXACT_PATTERN.test(library.version)) {
    throw new Error(`Invalid library version (expected MAJOR.MINOR.PATCH): ${library.version}`);
  }

  const seenMacroIds = new Set<string>();
  for (const macro of library.macros) {
    if (seenMacroIds.has(macro.id)) {
      throw new Error(`Duplicate macro id in library ${library.name}@${library.version}: ${macro.id}`);
    }

    seenMacroIds.add(macro.id);
    ensureUniqueParameterNames(macro);

    for (const line of macro.body) {
      parseCommand(line);
    }
  }
}

export function detectBreakingChanges(oldLib: MacroLibrary, newLib: MacroLibrary): BreakingChangeResult {
  const reasons: string[] = [];

  const oldById = new Map(oldLib.macros.map((macro) => [macro.id, macro]));
  const newById = new Map(newLib.macros.map((macro) => [macro.id, macro]));

  for (const oldMacroId of oldById.keys()) {
    if (!newById.has(oldMacroId)) {
      reasons.push(`macro removed: ${oldMacroId}`);
    }
  }

  for (const [macroId, oldMacro] of oldById.entries()) {
    const next = newById.get(macroId);
    if (!next) {
      continue;
    }

    if (parseMacroSignature(oldMacro) !== parseMacroSignature(next)) {
      reasons.push(`macro parameter signature changed: ${macroId}`);
    }
  }

  return {
    breaking: reasons.length > 0,
    reasons,
  };
}

export function listLibraryVersions(root: string, name: string): string[] {
  const base = path.join(librariesRoot(root), name);
  if (!fs.existsSync(base)) {
    return [];
  }

  return fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((entry) => SEMVER_EXACT_PATTERN.test(entry))
    .sort((left, right) => compareSemver(left, right));
}

export function listMacroLibraryCatalog(root: string): MacroLibraryCatalogEntry[] {
  const base = librariesRoot(root);
  if (!fs.existsSync(base)) {
    return [];
  }

  return fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => LIBRARY_NAME_PATTERN.test(name))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      versions: listLibraryVersions(root, name),
    }));
}

export function loadMacroLibrary(root: string, name: string, version: string): MacroLibrary {
  if (!LIBRARY_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid library name: ${name}`);
  }

  if (!SEMVER_EXACT_PATTERN.test(version)) {
    throw new Error(`Invalid library version: ${version}`);
  }

  const manifestPath = libraryManifestPath(root, name, version);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Macro library not found: ${name}@${version}`);
  }

  const raw = fs.readFileSync(manifestPath, "utf-8");
  const parsed = YAML.parse(raw) ?? {};
  const library = MacroLibrarySchema.parse(parsed);

  if (library.name !== name) {
    throw new Error(`Library name mismatch at ${manifestPath}: expected ${name}, found ${library.name}`);
  }

  if (library.version !== version) {
    throw new Error(`Library version mismatch at ${manifestPath}: expected ${version}, found ${library.version}`);
  }

  const normalized = sortLibrary(library);
  validateLibrary(normalized);
  return normalized;
}

export function resolveLibraryVersion(root: string, name: string, selector: string): string {
  if (!LIBRARY_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid library name: ${name}`);
  }

  const selectorSpec = parseLibraryVersionSelector(selector);
  const available = listLibraryVersions(root, name);
  if (available.length === 0) {
    throw new Error(`Library not found: ${name}`);
  }

  validateLibraryEvolution(root, name, available);

  if (selectorSpec.type === "exact") {
    const exact = `${selectorSpec.major}.${selectorSpec.minor}.${selectorSpec.patch}`;
    if (!available.includes(exact)) {
      throw new Error(`Library version not found: ${name}@${exact}`);
    }

    return exact;
  }

  const matches = available.filter((candidate) => {
    const parsed = parseExactSemver(candidate);
    if (!parsed) {
      return false;
    }

    if (selectorSpec.type === "patch") {
      return parsed.major === selectorSpec.major && parsed.minor === selectorSpec.minor;
    }

    return parsed.major === selectorSpec.major;
  });

  if (matches.length === 0) {
    throw new Error(`No versions match selector: ${name}@${selector}`);
  }

  const sortedMatches = [...matches].sort((left, right) => compareSemver(left, right));
  return sortedMatches[sortedMatches.length - 1] as string;
}

function resolveLibrary(root: string, name: string, selector: string): MacroLibrary {
  const resolved = resolveLibraryVersion(root, name, selector);
  return loadMacroLibrary(root, name, resolved);
}

export function parseLibrarySpecifier(specifier: string): { name: string; selector: string } {
  const parts = specifier.split("@");
  if (parts.length !== 2) {
    throw new Error(`Invalid library specifier: ${specifier}. Expected <library>@<version-selector>.`);
  }

  const name = parts[0].trim();
  const selector = parts[1].trim();

  if (!LIBRARY_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid library name: ${name}`);
  }

  parseLibraryVersionSelector(selector);

  return {
    name,
    selector,
  };
}

export function readMacroLock(root: string): MacroLibraryLock {
  const filePath = lockfilePath(root);
  if (!fs.existsSync(filePath)) {
    return {
      libraries: {},
    };
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = YAML.parse(raw) ?? {};
  const lock = MacroLockSchema.parse(parsed);
  return normalizeLock(lock);
}

export function writeMacroLock(root: string, lock: MacroLibraryLock): void {
  const normalized = normalizeLock(lock);
  const filePath = lockfilePath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(normalized), "utf-8");
}

export function lockLibraries(root: string): MacroLibraryLock {
  const current = readMacroLock(root);

  for (const [library, version] of Object.entries(current.libraries)) {
    loadMacroLibrary(root, library, version);
  }

  writeMacroLock(root, current);
  return current;
}

export function installLibrary(root: string, specifier: string): {
  library: string;
  requested: string;
  resolvedVersion: string;
} {
  const parsed = parseLibrarySpecifier(specifier);
  const resolvedVersion = resolveLibraryVersion(root, parsed.name, parsed.selector);

  // Validate manifest and evolution before writing lock.
  loadMacroLibrary(root, parsed.name, resolvedVersion);

  const lock = readMacroLock(root);
  lock.libraries[parsed.name] = resolvedVersion;
  writeMacroLock(root, lock);

  return {
    library: parsed.name,
    requested: parsed.selector,
    resolvedVersion,
  };
}

export function updateLibrary(root: string, name: string): {
  library: string;
  resolvedVersion: string;
} {
  if (!LIBRARY_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid library name: ${name}`);
  }

  const versions = listLibraryVersions(root, name);
  if (versions.length === 0) {
    throw new Error(`Library not found: ${name}`);
  }

  validateLibraryEvolution(root, name, versions);

  const sortedVersions = [...versions].sort((left, right) => compareSemver(left, right));
  const resolvedVersion = sortedVersions[sortedVersions.length - 1] as string;
  loadMacroLibrary(root, name, resolvedVersion);

  const lock = readMacroLock(root);
  lock.libraries[name] = resolvedVersion;
  writeMacroLock(root, lock);

  return {
    library: name,
    resolvedVersion,
  };
}

export function resolveLockedLibraryVersion(root: string, name: string): string {
  const lock = readMacroLock(root);
  const resolved = lock.libraries[name];
  if (!resolved) {
    throw new Error(`Library is not locked: ${name}. Run 'choir import ${name}@<version>' or 'choir library install ${name}@<version>'.`);
  }

  return resolved;
}

export function resolveLibraryMacro(root: string, qualifiedMacroId: string): {
  trace: MacroLibraryTrace;
  macro: Macro;
} {
  const dot = qualifiedMacroId.indexOf(".");
  if (dot <= 0 || dot >= qualifiedMacroId.length - 1) {
    throw new Error(`Expected namespaced macro id '<library>.<macroId>', found: ${qualifiedMacroId}`);
  }

  const library = qualifiedMacroId.slice(0, dot);
  const macroId = qualifiedMacroId.slice(dot + 1);

  if (!LIBRARY_NAME_PATTERN.test(library)) {
    throw new Error(`Invalid library name in macro id: ${library}`);
  }

  const version = resolveLockedLibraryVersion(root, library);
  const lib = loadMacroLibrary(root, library, version);
  const macro = lib.macros.find((entry) => entry.id === macroId);

  if (!macro) {
    throw new Error(`Macro not found in locked library ${library}@${version}: ${macroId}`);
  }

  return {
    trace: {
      library,
      version,
      macroId,
      resolvedVersion: version,
    },
    macro,
  };
}
