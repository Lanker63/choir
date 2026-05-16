import crypto from "crypto";
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

export type LibraryPolicy = {
  id: string;
  effect: "allow" | "deny" | "require-approval";
  scope?: "org" | "repo" | "workspace" | "library";
  description?: string;
};

export type LibraryCapability = {
  id: string;
  type: "macro" | "policy" | "strategy" | "template" | "dsl-fragment" | "abstraction" | "rollout";
  selector?: string;
};

export type LibraryStrategy = {
  id: string;
  description?: string;
  rollout?: string;
};

export type LibraryTemplate = {
  id: string;
  description?: string;
};

export type ChoirLibrary = {
  id: string;
  version: string;
  selector: string;
  capabilities: LibraryCapability[];
  policies: LibraryPolicy[];
  macros: Macro[];
  strategies: LibraryStrategy[];
  templates: LibraryTemplate[];
  dependencies: string[];
  compatibility?: string;
  integrityHash: string;
};

export type RegistryEntry = {
  id: string;
  version: string;
  selectors: string[];
  capabilities: string[];
  compatibility: string;
};

export type LibraryRegistry = {
  libraries: RegistryEntry[];
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

export type LibraryCatalogEntry = {
  id: string;
  versions: string[];
  selectors: string[];
  capabilities: string[];
  compatibility: string;
};

export type LibraryLockEntry = {
  version: string;
  selector: string;
  integrityHash: string;
  source: string;
  installed: boolean;
};

export type MacroLibraryLock = {
  libraries: Record<string, string>;
};

export type ChoirLibraryLock = {
  libraries: Record<string, LibraryLockEntry>;
};

export type LibraryImportRecord = {
  id: string;
  selector: string;
  resolvedVersion: string;
  source: string;
  importedAt: string;
};

export type CapabilityGraph = {
  libraries: Array<{
    id: string;
    version: string;
    selector: string;
    integrityHash: string;
    installed: boolean;
  }>;
  dependencies: Array<{
    from: string;
    to: string;
    type: "imports" | "depends-on" | "policy-inherits" | "strategy-inherits" | "macro-composes";
  }>;
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

export type LibraryResolutionStage =
  | "registry-resolution"
  | "selector-resolution"
  | "policy-validation"
  | "compatibility-validation"
  | "integrity-validation"
  | "capability-graph"
  | "lock-validation"
  | "replay-validation"
  | "install-materialization";

export class LibraryResolutionError extends Error {
  readonly stage: LibraryResolutionStage;

  constructor(stage: LibraryResolutionStage, message: string) {
    super(message);
    this.name = "LibraryResolutionError";
    this.stage = stage;
  }
}

const MACRO_PARAMETER_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const LIBRARY_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const SELECTOR_PATTERN = /^[a-zA-Z0-9._-]+$/;
const SEMVER_EXACT_PATTERN = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;
const SEMVER_PATCH_SELECTOR_PATTERN = /^([0-9]+)\.([0-9]+)\.x$/;
const SEMVER_MINOR_SELECTOR_PATTERN = /^([0-9]+)\.x$/;
const SHA256_PREFIX = "sha256:";

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

const LibraryPolicySchema = z.object({
  id: z.string().min(1),
  effect: z.enum(["allow", "deny", "require-approval"]),
  scope: z.enum(["org", "repo", "workspace", "library"]).optional(),
  description: z.string().optional(),
}).strict();

const LibraryCapabilitySchema = z.object({
  id: z.string().min(1),
  type: z.enum(["macro", "policy", "strategy", "template", "dsl-fragment", "abstraction", "rollout"]),
  selector: z.string().regex(SELECTOR_PATTERN).optional(),
}).strict();

const LibraryStrategySchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  rollout: z.string().optional(),
}).strict();

const LibraryTemplateSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
}).strict();

const ChoirLibrarySchema = z.object({
  id: z.string().regex(LIBRARY_NAME_PATTERN),
  version: z.string().regex(SEMVER_EXACT_PATTERN),
  selector: z.string().regex(SELECTOR_PATTERN).default("latest"),
  capabilities: z.array(LibraryCapabilitySchema).default([]),
  policies: z.array(LibraryPolicySchema).default([]),
  macros: z.array(MacroSchema).default([]),
  strategies: z.array(LibraryStrategySchema).default([]),
  templates: z.array(LibraryTemplateSchema).default([]),
  dependencies: z.array(z.string().min(1)).default([]),
  compatibility: z.string().optional(),
  integrityHash: z.string().optional(),
}).strict();

const LegacyMacroLibrarySchema = z.object({
  name: z.string().regex(LIBRARY_NAME_PATTERN),
  version: z.string().regex(SEMVER_EXACT_PATTERN),
  macros: z.array(MacroSchema).default([]),
  metadata: z.object({
    description: z.string().optional(),
    owner: z.string().optional(),
  }).default({}),
}).strict();

const ChoirLockSchema = z.object({
  libraries: z.record(z.string().regex(LIBRARY_NAME_PATTERN), z.object({
    version: z.string().regex(SEMVER_EXACT_PATTERN),
    selector: z.string().regex(SELECTOR_PATTERN),
    integrityHash: z.string().min(1),
    source: z.string().min(1),
    installed: z.boolean().default(false),
  }).strict()).default({}),
}).strict();

function choirRoot(root: string): string {
  return path.join(root, ".choir");
}

function registriesRoot(root: string): string {
  return path.join(choirRoot(root), "registry");
}

function librariesRoot(root: string): string {
  return path.join(choirRoot(root), "libraries");
}

function importsPath(root: string): string {
  return path.join(choirRoot(root), "library-imports.yaml");
}

function lockfilePath(root: string): string {
  return path.join(root, "choir.lock");
}

function capabilityGraphPath(root: string): string {
  return path.join(choirRoot(root), "capability-graph.json");
}

function controlPlanePath(root: string): string {
  return path.join(choirRoot(root), "choir.config.yaml");
}

type ExactSemver = {
  major: number;
  minor: number;
  patch: number;
};

type RegistrySource = {
  id: string;
  root: string;
};

type ResolvedLibrary = {
  library: ChoirLibrary;
  source: string;
  manifestPath: string;
};

type LibraryImportsState = {
  imports: LibraryImportRecord[];
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);

  return `{${entries.join(",")}}`;
}

function sha256(content: string): string {
  const digest = crypto.createHash("sha256").update(content).digest("hex");
  return `${SHA256_PREFIX}${digest}`;
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

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0))).sort((left, right) => left.localeCompare(right));
}

function normalizeMacro(macro: Macro): Macro {
  return {
    id: macro.id,
    ...(macro.version ? { version: macro.version } : {}),
    ...(macro.description ? { description: macro.description } : {}),
    parameters: [...(macro.parameters ?? [])]
      .map((parameter) => ({
        name: parameter.name,
        required: parameter.required,
        ...(parameter.default ? { default: parameter.default } : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    body: [...macro.body],
  };
}

function normalizeLibrary(library: ChoirLibrary): ChoirLibrary {
  const normalized: ChoirLibrary = {
    id: library.id,
    version: library.version,
    selector: library.selector,
    capabilities: [...library.capabilities].sort((left, right) => left.id.localeCompare(right.id)),
    policies: [...library.policies].sort((left, right) => left.id.localeCompare(right.id)),
    macros: [...library.macros].map((macro) => normalizeMacro(macro)).sort((left, right) => left.id.localeCompare(right.id)),
    strategies: [...library.strategies].sort((left, right) => left.id.localeCompare(right.id)),
    templates: [...library.templates].sort((left, right) => left.id.localeCompare(right.id)),
    dependencies: uniqueSorted(library.dependencies),
    ...(library.compatibility ? { compatibility: library.compatibility } : {}),
    integrityHash: library.integrityHash,
  };

  return normalized;
}

function computeLibraryIntegrityHash(library: Omit<ChoirLibrary, "integrityHash">): string {
  const normalized = normalizeLibrary({
    ...library,
    integrityHash: `${SHA256_PREFIX}pending`,
  });

  const canonical: Omit<ChoirLibrary, "integrityHash"> = {
    id: normalized.id,
    version: normalized.version,
    selector: normalized.selector,
    capabilities: normalized.capabilities,
    policies: normalized.policies,
    macros: normalized.macros,
    strategies: normalized.strategies,
    templates: normalized.templates,
    dependencies: normalized.dependencies,
    ...(normalized.compatibility ? { compatibility: normalized.compatibility } : {}),
  };

  return sha256(stableStringify(canonical));
}

function parseLibrarySelector(selector: string):
  | { type: "exact"; major: number; minor: number; patch: number }
  | { type: "patch"; major: number; minor: number }
  | { type: "minor"; major: number }
  | { type: "tag"; value: string } {
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

  if (!SELECTOR_PATTERN.test(selector)) {
    throw new LibraryResolutionError("selector-resolution", `Unsupported library selector: ${selector}`);
  }

  return {
    type: "tag",
    value: selector,
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

function parseLibrarySpecifier(specifier: string): { name: string; selector: string } {
  const index = specifier.lastIndexOf("@");
  if (index <= 0 || index >= specifier.length - 1) {
    throw new LibraryResolutionError("selector-resolution", `Invalid library specifier: ${specifier}. Expected <library>@<selector>.`);
  }

  const name = specifier.slice(0, index).trim();
  const selector = specifier.slice(index + 1).trim();

  if (!LIBRARY_NAME_PATTERN.test(name)) {
    throw new LibraryResolutionError("selector-resolution", `Invalid library name: ${name}`);
  }

  parseLibrarySelector(selector);

  return {
    name,
    selector,
  };
}

function readControlPlaneRegistries(root: string): string[] {
  const filePath = controlPlanePath(root);
  if (!fs.existsSync(filePath)) {
    return ["local"];
  }

  const parsed = YAML.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown> | null;
  const registries = parsed && Array.isArray(parsed.registries)
    ? parsed.registries.filter((entry): entry is string => typeof entry === "string")
    : [];

  const defaults = registries.length > 0 ? registries : ["local"];
  return uniqueSorted(defaults);
}

function registrySources(root: string): RegistrySource[] {
  const configured = readControlPlaneRegistries(root);
  const sources: RegistrySource[] = [];

  for (const entry of configured) {
    if (entry === "local" || entry === "org") {
      sources.push({
        id: entry,
        root: path.join(registriesRoot(root), entry),
      });
      continue;
    }

    if (entry.startsWith("file:")) {
      const sourcePath = entry.slice("file:".length);
      const absolute = path.isAbsolute(sourcePath) ? sourcePath : path.join(root, sourcePath);
      sources.push({
        id: entry,
        root: absolute,
      });
      continue;
    }

    const absolute = path.isAbsolute(entry) ? entry : path.join(root, entry);
    sources.push({
      id: entry,
      root: absolute,
    });
  }

  return sources.sort((left, right) => left.id.localeCompare(right.id));
}

function listVersionDirectories(basePath: string): string[] {
  if (!fs.existsSync(basePath)) {
    return [];
  }

  return fs.readdirSync(basePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SEMVER_EXACT_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => compareSemver(left, right));
}

function loadChoirLibraryManifest(manifestPath: string): ChoirLibrary {
  const raw = fs.readFileSync(manifestPath, "utf-8");
  const parsed = YAML.parse(raw) ?? {};
  const loaded = ChoirLibrarySchema.parse(parsed);

  const provisional: Omit<ChoirLibrary, "integrityHash"> = {
    id: loaded.id,
    version: loaded.version,
    selector: loaded.selector,
    capabilities: loaded.capabilities,
    policies: loaded.policies,
    macros: loaded.macros,
    strategies: loaded.strategies,
    templates: loaded.templates,
    dependencies: loaded.dependencies,
    ...(loaded.compatibility ? { compatibility: loaded.compatibility } : {}),
  };

  const withComputedIntegrity: ChoirLibrary = {
    ...provisional,
    integrityHash: loaded.integrityHash ?? computeLibraryIntegrityHash(provisional),
  };

  const normalized = normalizeLibrary(withComputedIntegrity);
  validateLibrary(normalized);
  return normalized;
}

function loadLegacyLibraryManifest(manifestPath: string): ChoirLibrary {
  const raw = fs.readFileSync(manifestPath, "utf-8");
  const parsed = YAML.parse(raw) ?? {};
  const legacy = LegacyMacroLibrarySchema.parse(parsed);

  const provisional: Omit<ChoirLibrary, "integrityHash"> = {
    id: legacy.name,
    version: legacy.version,
    selector: "latest",
    capabilities: legacy.macros.map((macro) => ({
      id: macro.id,
      type: "macro",
    })),
    policies: [],
    macros: legacy.macros,
    strategies: [],
    templates: [],
    dependencies: [],
    compatibility: "legacy-macro-library",
  };

  const normalized = normalizeLibrary({
    ...provisional,
    integrityHash: computeLibraryIntegrityHash(provisional),
  });

  validateLibrary(normalized);
  return normalized;
}

function resolveFromMaterialized(root: string, id: string, version: string): ResolvedLibrary | null {
  const manifestPath = path.join(librariesRoot(root), id, "manifest.yaml");
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  const loaded = loadChoirLibraryManifest(manifestPath);
  if (loaded.id !== id || loaded.version !== version) {
    return null;
  }

  return {
    library: loaded,
    source: "materialized",
    manifestPath,
  };
}

function resolveFromLegacyLibraries(root: string, id: string, version: string): ResolvedLibrary | null {
  const manifestPath = path.join(librariesRoot(root), id, version, "macros.yaml");
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  const loaded = loadLegacyLibraryManifest(manifestPath);
  if (loaded.id !== id || loaded.version !== version) {
    return null;
  }

  return {
    library: loaded,
    source: "legacy-local",
    manifestPath,
  };
}

function listRegistryLibraries(rootPath: string): ResolvedLibrary[] {
  if (!fs.existsSync(rootPath)) {
    return [];
  }

  const libraries: ResolvedLibrary[] = [];
  const libraryDirs = fs.readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && LIBRARY_NAME_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const id of libraryDirs) {
    const idRoot = path.join(rootPath, id);
    const versions = listVersionDirectories(idRoot);
    for (const version of versions) {
      const versionRoot = path.join(idRoot, version);
      const manifestYaml = path.join(versionRoot, "manifest.yaml");
      const libraryYaml = path.join(versionRoot, "library.yaml");
      const manifestPath = fs.existsSync(manifestYaml) ? manifestYaml : libraryYaml;
      if (!fs.existsSync(manifestPath)) {
        continue;
      }

      const library = loadChoirLibraryManifest(manifestPath);
      libraries.push({
        library,
        source: rootPath,
        manifestPath,
      });
    }
  }

  return libraries;
}

function allAvailableLibraries(root: string): ResolvedLibrary[] {
  const resolved: ResolvedLibrary[] = [];

  const sources = registrySources(root);
  for (const source of sources) {
    const entries = listRegistryLibraries(source.root).map((entry) => ({
      ...entry,
      source: source.id,
    }));
    resolved.push(...entries);
  }

  const localLibrariesRoot = librariesRoot(root);
  if (fs.existsSync(localLibrariesRoot)) {
    const libraryDirs = fs.readdirSync(localLibrariesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && LIBRARY_NAME_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    for (const id of libraryDirs) {
      const materialized = path.join(localLibrariesRoot, id, "manifest.yaml");
      if (fs.existsSync(materialized)) {
        const loaded = loadChoirLibraryManifest(materialized);
        resolved.push({
          library: loaded,
          source: "materialized",
          manifestPath: materialized,
        });
      }

      const versions = listVersionDirectories(path.join(localLibrariesRoot, id));
      for (const version of versions) {
        const legacy = resolveFromLegacyLibraries(root, id, version);
        if (legacy) {
          resolved.push(legacy);
        }
      }
    }
  }

  return resolved.sort((left, right) => {
    const byId = left.library.id.localeCompare(right.library.id);
    if (byId !== 0) {
      return byId;
    }

    const byVersion = compareSemver(left.library.version, right.library.version);
    if (byVersion !== 0) {
      return byVersion;
    }

    return left.source.localeCompare(right.source);
  });
}

function resolveLibraryCandidates(root: string, id: string): ResolvedLibrary[] {
  const candidates = allAvailableLibraries(root)
    .filter((entry) => entry.library.id === id)
    .sort((left, right) => compareSemver(left.library.version, right.library.version));

  if (candidates.length === 0) {
    throw new LibraryResolutionError("registry-resolution", `Library not found: ${id}`);
  }

  return candidates;
}

function resolveSelectorVersion(candidates: ResolvedLibrary[], selector: string): ResolvedLibrary {
  const spec = parseLibrarySelector(selector);
  const byVersion = new Map(candidates.map((entry) => [entry.library.version, entry] as const));

  if (spec.type === "exact") {
    const exact = `${spec.major}.${spec.minor}.${spec.patch}`;
    const resolved = byVersion.get(exact);
    if (!resolved) {
      throw new LibraryResolutionError("selector-resolution", `Library version not found: ${candidates[0]?.library.id}@${exact}`);
    }

    return resolved;
  }

  if (spec.type === "patch") {
    const matches = candidates.filter((candidate) => {
      const parsed = parseExactSemver(candidate.library.version);
      return parsed !== null && parsed.major === spec.major && parsed.minor === spec.minor;
    });

    if (matches.length === 0) {
      throw new LibraryResolutionError("selector-resolution", `No versions match selector ${spec.major}.${spec.minor}.x`);
    }

    return matches[matches.length - 1] as ResolvedLibrary;
  }

  if (spec.type === "minor") {
    const matches = candidates.filter((candidate) => {
      const parsed = parseExactSemver(candidate.library.version);
      return parsed !== null && parsed.major === spec.major;
    });

    if (matches.length === 0) {
      throw new LibraryResolutionError("selector-resolution", `No versions match selector ${spec.major}.x`);
    }

    return matches[matches.length - 1] as ResolvedLibrary;
  }

  if (spec.value === "latest") {
    return candidates[candidates.length - 1] as ResolvedLibrary;
  }

  const tagged = candidates.filter((candidate) => candidate.library.selector === spec.value);
  if (tagged.length === 0) {
    throw new LibraryResolutionError("selector-resolution", `No versions match selector tag: ${spec.value}`);
  }

  return tagged[tagged.length - 1] as ResolvedLibrary;
}

function ensureLibraryPolicyPasses(library: ChoirLibrary): void {
  const deny = library.policies
    .filter((policy) => policy.effect === "deny")
    .sort((left, right) => left.id.localeCompare(right.id));

  if (deny.length > 0) {
    throw new LibraryResolutionError(
      "policy-validation",
      `Library ${library.id}@${library.version} denied by library policy: ${deny.map((entry) => entry.id).join(", ")}`
    );
  }
}

function validateIntegrity(library: ChoirLibrary): void {
  const computed = computeLibraryIntegrityHash({
    id: library.id,
    version: library.version,
    selector: library.selector,
    capabilities: library.capabilities,
    policies: library.policies,
    macros: library.macros,
    strategies: library.strategies,
    templates: library.templates,
    dependencies: library.dependencies,
    ...(library.compatibility ? { compatibility: library.compatibility } : {}),
  });

  if (computed !== library.integrityHash) {
    throw new LibraryResolutionError(
      "integrity-validation",
      `Integrity hash mismatch for ${library.id}@${library.version}. expected=${library.integrityHash} computed=${computed}`
    );
  }
}

function validateCompatibilityOnUpdate(currentVersion: string, nextVersion: string): void {
  const current = parseExactSemver(currentVersion);
  const next = parseExactSemver(nextVersion);
  if (!current || !next) {
    throw new LibraryResolutionError("compatibility-validation", `Invalid semver during update: ${currentVersion} -> ${nextVersion}`);
  }

  if (current.major !== next.major) {
    throw new LibraryResolutionError(
      "compatibility-validation",
      `Update must stay within MAJOR compatibility boundary: ${currentVersion} -> ${nextVersion}`
    );
  }
}

function readImports(root: string): LibraryImportsState {
  const filePath = importsPath(root);
  if (!fs.existsSync(filePath)) {
    return {
      imports: [],
    };
  }

  const parsed = YAML.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown> | null;
  const imports = parsed && Array.isArray(parsed.imports)
    ? parsed.imports.filter((entry): entry is LibraryImportRecord => {
      if (!entry || typeof entry !== "object") {
        return false;
      }

      const record = entry as Partial<LibraryImportRecord>;
      return typeof record.id === "string"
        && typeof record.selector === "string"
        && typeof record.resolvedVersion === "string"
        && typeof record.source === "string"
        && typeof record.importedAt === "string";
    })
    : [];

  return {
    imports: [...imports].sort((left, right) => left.id.localeCompare(right.id) || left.resolvedVersion.localeCompare(right.resolvedVersion)),
  };
}

function writeImports(root: string, state: LibraryImportsState): void {
  const normalized = {
    imports: [...state.imports]
      .sort((left, right) => left.id.localeCompare(right.id) || left.resolvedVersion.localeCompare(right.resolvedVersion))
      .map((entry) => ({
        id: entry.id,
        selector: entry.selector,
        resolvedVersion: entry.resolvedVersion,
        source: entry.source,
        importedAt: entry.importedAt,
      })),
  };

  const filePath = importsPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(normalized), "utf-8");
}

function normalizeLock(lock: ChoirLibraryLock): ChoirLibraryLock {
  const sorted = Object.entries(lock.libraries)
    .sort(([left], [right]) => left.localeCompare(right));

  return {
    libraries: Object.fromEntries(sorted),
  };
}

export function readLibraryLock(root: string): ChoirLibraryLock {
  const filePath = lockfilePath(root);
  if (!fs.existsSync(filePath)) {
    return {
      libraries: {},
    };
  }

  const parsed = YAML.parse(fs.readFileSync(filePath, "utf-8")) ?? {};
  const lock = ChoirLockSchema.parse(parsed);
  return normalizeLock(lock);
}

function writeLibraryLock(root: string, lock: ChoirLibraryLock): void {
  const normalized = normalizeLock(lock);
  fs.writeFileSync(lockfilePath(root), YAML.stringify(normalized), "utf-8");
}

function toMacroLock(lock: ChoirLibraryLock): MacroLibraryLock {
  const libraries: Record<string, string> = {};
  for (const [library, entry] of Object.entries(lock.libraries)) {
    libraries[library] = entry.version;
  }

  return {
    libraries,
  };
}

function buildCapabilityGraph(root: string, lock: ChoirLibraryLock): CapabilityGraph {
  const nodes: CapabilityGraph["libraries"] = [];
  const edges: CapabilityGraph["dependencies"] = [];

  const ordered = Object.entries(lock.libraries).sort(([left], [right]) => left.localeCompare(right));
  for (const [id, locked] of ordered) {
    const resolved = resolveLibraryByVersion(root, id, locked.version);
    nodes.push({
      id,
      version: locked.version,
      selector: locked.selector,
      integrityHash: locked.integrityHash,
      installed: locked.installed,
    });

    for (const dependency of resolved.library.dependencies) {
      const target = dependency.includes("@") ? dependency.slice(0, dependency.indexOf("@")) : dependency;
      if (!LIBRARY_NAME_PATTERN.test(target)) {
        continue;
      }

      edges.push({
        from: id,
        to: target,
        type: "depends-on",
      });
    }

    if (resolved.library.policies.length > 0) {
      edges.push({
        from: id,
        to: "workspace",
        type: "policy-inherits",
      });
    }

    if (resolved.library.strategies.length > 0) {
      edges.push({
        from: id,
        to: "workspace",
        type: "strategy-inherits",
      });
    }

    if (resolved.library.macros.length > 0) {
      edges.push({
        from: id,
        to: "workspace",
        type: "macro-composes",
      });
    }
  }

  const graph: CapabilityGraph = {
    libraries: nodes.sort((left, right) => left.id.localeCompare(right.id)),
    dependencies: edges.sort((left, right) => {
      const byFrom = left.from.localeCompare(right.from);
      if (byFrom !== 0) {
        return byFrom;
      }

      const byTo = left.to.localeCompare(right.to);
      if (byTo !== 0) {
        return byTo;
      }

      return left.type.localeCompare(right.type);
    }),
  };

  fs.mkdirSync(path.dirname(capabilityGraphPath(root)), { recursive: true });
  fs.writeFileSync(capabilityGraphPath(root), `${JSON.stringify(graph, null, 2)}\n`, "utf-8");
  return graph;
}

function ensureReplayConsistency(root: string, lock: ChoirLibraryLock, graph: CapabilityGraph): void {
  for (const [id, entry] of Object.entries(lock.libraries)) {
    const resolved = resolveLibraryByVersion(root, id, entry.version);
    validateIntegrity(resolved.library);
    if (entry.integrityHash !== resolved.library.integrityHash) {
      throw new LibraryResolutionError(
        "replay-validation",
        `Replay consistency failed for ${id}: lock hash ${entry.integrityHash} does not match resolved hash ${resolved.library.integrityHash}`
      );
    }
  }

  const graphHash = sha256(stableStringify(graph));
  if (!graphHash.startsWith(SHA256_PREFIX)) {
    throw new LibraryResolutionError("replay-validation", "Capability graph hash generation failed.");
  }
}

function ensureCapabilityFolders(root: string, id: string): {
  basePath: string;
  macrosPath: string;
  policiesPath: string;
  templatesPath: string;
  strategiesPath: string;
} {
  const basePath = path.join(librariesRoot(root), id);
  const macrosPath = path.join(basePath, "macros");
  const policiesPath = path.join(basePath, "policies");
  const templatesPath = path.join(basePath, "templates");
  const strategiesPath = path.join(basePath, "strategies");

  fs.mkdirSync(macrosPath, { recursive: true });
  fs.mkdirSync(policiesPath, { recursive: true });
  fs.mkdirSync(templatesPath, { recursive: true });
  fs.mkdirSync(strategiesPath, { recursive: true });

  return {
    basePath,
    macrosPath,
    policiesPath,
    templatesPath,
    strategiesPath,
  };
}

function materializeLibrary(root: string, library: ChoirLibrary): void {
  const paths = ensureCapabilityFolders(root, library.id);

  const manifestPath = path.join(paths.basePath, "manifest.yaml");
  fs.writeFileSync(manifestPath, YAML.stringify(library), "utf-8");

  const macros = { macros: library.macros };
  const policies = { policies: library.policies };
  const strategies = { strategies: library.strategies };
  const templates = { templates: library.templates };

  fs.writeFileSync(path.join(paths.macrosPath, "index.yaml"), YAML.stringify(macros), "utf-8");
  fs.writeFileSync(path.join(paths.policiesPath, "index.yaml"), YAML.stringify(policies), "utf-8");
  fs.writeFileSync(path.join(paths.strategiesPath, "index.yaml"), YAML.stringify(strategies), "utf-8");
  fs.writeFileSync(path.join(paths.templatesPath, "index.yaml"), YAML.stringify(templates), "utf-8");
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

export function validateLibrary(library: ChoirLibrary): void {
  if (!LIBRARY_NAME_PATTERN.test(library.id)) {
    throw new Error(`Invalid library name: ${library.id}`);
  }

  if (!SEMVER_EXACT_PATTERN.test(library.version)) {
    throw new Error(`Invalid library version (expected MAJOR.MINOR.PATCH): ${library.version}`);
  }

  const seenMacroIds = new Set<string>();
  for (const macro of library.macros) {
    if (seenMacroIds.has(macro.id)) {
      throw new Error(`Duplicate macro id in library ${library.id}@${library.version}: ${macro.id}`);
    }

    seenMacroIds.add(macro.id);
    ensureUniqueParameterNames(macro);

    for (const line of macro.body) {
      parseCommand(line);
    }
  }

  const seenPolicyIds = new Set<string>();
  for (const policy of library.policies) {
    if (seenPolicyIds.has(policy.id)) {
      throw new Error(`Duplicate policy id in library ${library.id}@${library.version}: ${policy.id}`);
    }

    seenPolicyIds.add(policy.id);
  }
}

export function detectBreakingChanges(oldLib: MacroLibrary, newLib: MacroLibrary): BreakingChangeResult {
  const reasons: string[] = [];

  const oldById = new Map(oldLib.macros.map((macro) => [macro.id, macro] as const));
  const newById = new Map(newLib.macros.map((macro) => [macro.id, macro] as const));

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
  if (!LIBRARY_NAME_PATTERN.test(name)) {
    throw new LibraryResolutionError("registry-resolution", `Invalid library name: ${name}`);
  }

  const candidates = resolveLibraryCandidates(root, name);
  return uniqueSorted(candidates.map((entry) => entry.library.version)).sort((left, right) => compareSemver(left, right));
}

function selectorListForLibrary(entries: ResolvedLibrary[]): string[] {
  const selectors = ["latest", "stable"];
  for (const entry of entries) {
    selectors.push(entry.library.selector);
  }

  return uniqueSorted(selectors);
}

export function listLibraryCatalog(root: string): LibraryCatalogEntry[] {
  const all = allAvailableLibraries(root);
  const grouped = new Map<string, ResolvedLibrary[]>();

  for (const entry of all) {
    const list = grouped.get(entry.library.id) ?? [];
    list.push(entry);
    grouped.set(entry.library.id, list);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, entries]) => {
      const versions = uniqueSorted(entries.map((entry) => entry.library.version)).sort((left, right) => compareSemver(left, right));
      const selectors = selectorListForLibrary(entries);
      const capabilities = uniqueSorted(entries.flatMap((entry) => entry.library.capabilities.map((capability) => capability.id)));
      const compatibility = uniqueSorted(entries.map((entry) => entry.library.compatibility ?? "unspecified")).join(", ");

      return {
        id,
        versions,
        selectors,
        capabilities,
        compatibility,
      };
    });
}

export function listMacroLibraryCatalog(root: string): MacroLibraryCatalogEntry[] {
  return listLibraryCatalog(root).map((entry) => ({
    name: entry.id,
    versions: entry.versions,
  }));
}

function resolveLibraryBySelector(root: string, id: string, selector: string): ResolvedLibrary {
  const candidates = resolveLibraryCandidates(root, id);
  const resolved = resolveSelectorVersion(candidates, selector);
  ensureLibraryPolicyPasses(resolved.library);
  validateIntegrity(resolved.library);
  return resolved;
}

function resolveLibraryByVersion(root: string, id: string, version: string): ResolvedLibrary {
  const materialized = resolveFromMaterialized(root, id, version);
  if (materialized) {
    return materialized;
  }

  const candidates = resolveLibraryCandidates(root, id).filter((entry) => entry.library.version === version);
  if (candidates.length === 0) {
    throw new LibraryResolutionError("registry-resolution", `Library version not found: ${id}@${version}`);
  }

  return candidates[candidates.length - 1] as ResolvedLibrary;
}

export function loadMacroLibrary(root: string, name: string, version: string): MacroLibrary {
  const resolved = resolveLibraryByVersion(root, name, version);
  return {
    name: resolved.library.id,
    version: resolved.library.version,
    macros: resolved.library.macros,
    metadata: {
      description: resolved.library.compatibility,
    },
  };
}

export function resolveLibraryVersion(root: string, name: string, selector: string): string {
  return resolveLibraryBySelector(root, name, selector).library.version;
}

export function readMacroLock(root: string): MacroLibraryLock {
  return toMacroLock(readLibraryLock(root));
}

export function writeMacroLock(root: string, lock: MacroLibraryLock): void {
  const normalized: ChoirLibraryLock = {
    libraries: Object.fromEntries(Object.entries(lock.libraries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, version]) => {
        const resolved = resolveLibraryByVersion(root, id, version);
        return [id, {
          version: resolved.library.version,
          selector: "exact",
          integrityHash: resolved.library.integrityHash,
          source: resolved.source,
          installed: false,
        } satisfies LibraryLockEntry];
      })),
  };

  writeLibraryLock(root, normalized);
}

function updateLockAndGraph(root: string, lock: ChoirLibraryLock): ChoirLibraryLock {
  writeLibraryLock(root, lock);
  const graph = buildCapabilityGraph(root, lock);
  ensureReplayConsistency(root, lock, graph);
  return normalizeLock(lock);
}

export function lockLibraries(root: string): MacroLibraryLock {
  const current = readLibraryLock(root);
  for (const [id, entry] of Object.entries(current.libraries)) {
    const resolved = resolveLibraryByVersion(root, id, entry.version);
    validateIntegrity(resolved.library);
  }

  return toMacroLock(updateLockAndGraph(root, current));
}

export function lockChoirLibraries(root: string): ChoirLibraryLock {
  const current = readLibraryLock(root);
  return updateLockAndGraph(root, current);
}

export function importLibrary(root: string, specifier: string): {
  library: string;
  selector: string;
  resolvedVersion: string;
  status: "success";
} {
  const parsed = parseLibrarySpecifier(specifier);
  const resolved = resolveLibraryBySelector(root, parsed.name, parsed.selector);

  const imports = readImports(root);
  const withoutCurrent = imports.imports.filter((entry) => entry.id !== parsed.name);
  withoutCurrent.push({
    id: parsed.name,
    selector: parsed.selector,
    resolvedVersion: resolved.library.version,
    source: resolved.source,
    importedAt: new Date().toISOString(),
  });
  writeImports(root, {
    imports: withoutCurrent,
  });

  const lock = readLibraryLock(root);
  lock.libraries[parsed.name] = {
    version: resolved.library.version,
    selector: parsed.selector,
    integrityHash: resolved.library.integrityHash,
    source: resolved.source,
    installed: lock.libraries[parsed.name]?.installed === true,
  };
  updateLockAndGraph(root, lock);

  return {
    library: parsed.name,
    selector: parsed.selector,
    resolvedVersion: resolved.library.version,
    status: "success",
  };
}

export function installLibrary(root: string, specifier: string): {
  library: string;
  requested: string;
  resolvedVersion: string;
} {
  const parsed = parseLibrarySpecifier(specifier);
  const resolved = resolveLibraryBySelector(root, parsed.name, parsed.selector);

  try {
    materializeLibrary(root, resolved.library);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new LibraryResolutionError("install-materialization", message);
  }

  const lock = readLibraryLock(root);
  lock.libraries[parsed.name] = {
    version: resolved.library.version,
    selector: parsed.selector,
    integrityHash: resolved.library.integrityHash,
    source: resolved.source,
    installed: true,
  };
  updateLockAndGraph(root, lock);

  const imports = readImports(root);
  const nextImports = imports.imports.filter((entry) => entry.id !== parsed.name);
  nextImports.push({
    id: parsed.name,
    selector: parsed.selector,
    resolvedVersion: resolved.library.version,
    source: resolved.source,
    importedAt: new Date().toISOString(),
  });
  writeImports(root, {
    imports: nextImports,
  });

  return {
    library: parsed.name,
    requested: parsed.selector,
    resolvedVersion: resolved.library.version,
  };
}

export function updateLibrary(root: string, name: string): {
  library: string;
  resolvedVersion: string;
} {
  if (!LIBRARY_NAME_PATTERN.test(name)) {
    throw new LibraryResolutionError("selector-resolution", `Invalid library name: ${name}`);
  }

  const lock = readLibraryLock(root);
  const locked = lock.libraries[name];
  if (!locked) {
    throw new LibraryResolutionError("lock-validation", `Library is not locked: ${name}. Run 'choir import ${name}@<selector>' first.`);
  }

  const candidates = resolveLibraryCandidates(root, name);
  const latest = candidates[candidates.length - 1] as ResolvedLibrary;
  validateCompatibilityOnUpdate(locked.version, latest.library.version);
  ensureLibraryPolicyPasses(latest.library);
  validateIntegrity(latest.library);

  lock.libraries[name] = {
    version: latest.library.version,
    selector: locked.selector,
    integrityHash: latest.library.integrityHash,
    source: latest.source,
    installed: locked.installed,
  };

  if (locked.installed) {
    materializeLibrary(root, latest.library);
  }

  updateLockAndGraph(root, lock);

  const imports = readImports(root);
  const existing = imports.imports.filter((entry) => entry.id !== name);
  existing.push({
    id: name,
    selector: locked.selector,
    resolvedVersion: latest.library.version,
    source: latest.source,
    importedAt: new Date().toISOString(),
  });
  writeImports(root, {
    imports: existing,
  });

  return {
    library: name,
    resolvedVersion: latest.library.version,
  };
}

export function resolveLockedLibraryVersion(root: string, name: string): string {
  const lock = readLibraryLock(root);
  const resolved = lock.libraries[name];
  if (!resolved) {
    throw new LibraryResolutionError("lock-validation", `Library is not locked: ${name}. Run 'choir import ${name}@<selector>' or 'choir library install ${name}@<selector>'.`);
  }

  return resolved.version;
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

export function libraryRegistry(root: string): LibraryRegistry {
  const catalog = listLibraryCatalog(root);
  return {
    libraries: catalog.map((entry) => ({
      id: entry.id,
      version: entry.versions[entry.versions.length - 1] ?? "0.0.0",
      selectors: entry.selectors,
      capabilities: entry.capabilities,
      compatibility: entry.compatibility,
    })),
  };
}

export function verifyLibraryReplay(root: string): {
  passed: boolean;
  reasons: string[];
} {
  try {
    const lock = readLibraryLock(root);
    const graph = buildCapabilityGraph(root, lock);
    ensureReplayConsistency(root, lock, graph);
    return {
      passed: true,
      reasons: [],
    };
  } catch (error) {
    return {
      passed: false,
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function parseLibraryFailure(error: unknown): {
  status: "failed";
  stage: LibraryResolutionStage;
  message: string;
} | null {
  if (!(error instanceof LibraryResolutionError)) {
    return null;
  }

  return {
    status: "failed",
    stage: error.stage,
    message: error.message,
  };
}
