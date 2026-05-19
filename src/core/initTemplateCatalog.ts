import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

export type WizardTemplateDefaults = {
  goals: string[];
  constraints: string[];
  nonGoals: string[];
};

export type StrategicTemplateDefaults = {
  priorities: string[];
  optimizationGoals: string[];
  riskTolerance: string;
  rolloutPreferences: string[];
  stabilityProfile: string;
  governanceIntensity: string;
  runtimeMode: string;
  capabilities: {
    preview: boolean;
    simulate: boolean;
    execute: boolean;
    optimize: boolean;
    import: boolean;
    install: boolean;
    update: boolean;
  };
};

type TemplateDefinition = {
  id: string;
  wizardDefaults?: WizardTemplateDefaults;
  strategicDefaults?: StrategicTemplateDefaults;
};

type TemplateCatalogFile = {
  templates: TemplateDefinition[];
};

let cachedCatalog: TemplateDefinition[] | null = null;

const TrimmedNonEmpty = z.string().transform((value) => value.trim()).pipe(z.string().min(1));
const TrimmedStringArray = z.array(TrimmedNonEmpty);

const WizardDefaultsSchema = z.object({
  goals: TrimmedStringArray,
  constraints: TrimmedStringArray,
  nonGoals: TrimmedStringArray,
}).strict();

const StrategicDefaultsSchema = z.object({
  priorities: TrimmedStringArray,
  optimizationGoals: TrimmedStringArray,
  riskTolerance: z.enum(["low", "moderate", "high"]),
  rolloutPreferences: TrimmedStringArray,
  stabilityProfile: z.enum(["stable", "adaptive", "experimental"]),
  governanceIntensity: z.enum(["strict", "moderate", "relaxed"]),
  runtimeMode: z.enum([
    "observe-only",
    "simulation-only",
    "approval-required",
    "execution-enabled",
    "distributed-control",
  ]),
  capabilities: z.object({
    preview: z.boolean(),
    simulate: z.boolean(),
    execute: z.boolean(),
    optimize: z.boolean(),
    import: z.boolean(),
    install: z.boolean(),
    update: z.boolean(),
  }).strict(),
}).strict();

const TemplateSchema = z.object({
  id: TrimmedNonEmpty.transform((value) => value.toLowerCase()),
  wizardDefaults: WizardDefaultsSchema.optional(),
  strategicDefaults: StrategicDefaultsSchema.optional(),
}).strict().refine((entry) => Boolean(entry.wizardDefaults || entry.strategicDefaults), {
  message: "template must define wizardDefaults or strategicDefaults",
});

const TemplateCatalogSchema = z.object({
  templates: z.array(TemplateSchema).min(1),
}).strict();

function cloneWizardDefaults(value: WizardTemplateDefaults): WizardTemplateDefaults {
  return {
    goals: [...value.goals],
    constraints: [...value.constraints],
    nonGoals: [...value.nonGoals],
  };
}

function cloneStrategicDefaults(value: StrategicTemplateDefaults): StrategicTemplateDefaults {
  return {
    priorities: [...value.priorities],
    optimizationGoals: [...value.optimizationGoals],
    riskTolerance: value.riskTolerance,
    rolloutPreferences: [...value.rolloutPreferences],
    stabilityProfile: value.stabilityProfile,
    governanceIntensity: value.governanceIntensity,
    runtimeMode: value.runtimeMode,
    capabilities: { ...value.capabilities },
  };
}

function resolveRepoRoot(startPath: string): string {
  let cursor = startPath;
  while (true) {
    if (fs.existsSync(path.join(cursor, "package.json"))) {
      return cursor;
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return startPath;
    }

    cursor = parent;
  }
}

function loadTemplateCatalogFile(): TemplateCatalogFile {
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = resolveRepoRoot(path.dirname(thisFile));
  const configPath = path.join(repoRoot, "config", "init-templates.json");

  if (!fs.existsSync(configPath)) {
    throw new Error(`Template catalog not found at ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Invalid template catalog JSON at ${configPath}: ${reason}`);
  }

  const validation = TemplateCatalogSchema.safeParse(parsed);
  if (!validation.success) {
    const issue = validation.error.issues[0];
    const issuePath = issue?.path?.join(".") ?? "templates";
    const issueMessage = issue?.message ?? "schema validation failed";
    throw new Error(`Invalid template catalog at ${configPath}: ${issuePath} ${issueMessage}`.trim());
  }

  const duplicates = new Set<string>();
  const seen = new Set<string>();
  for (const template of validation.data.templates) {
    if (seen.has(template.id)) {
      duplicates.add(template.id);
      continue;
    }

    seen.add(template.id);
  }

  if (duplicates.size > 0) {
    throw new Error(`Invalid template catalog at ${configPath}: duplicate template ids: ${[...duplicates].sort((a, b) => a.localeCompare(b)).join(", ")}`);
  }

  const templates = validation.data.templates.map((template): TemplateDefinition => ({
    id: template.id,
    ...(template.wizardDefaults
      ? {
        wizardDefaults: {
          goals: [...template.wizardDefaults.goals],
          constraints: [...template.wizardDefaults.constraints],
          nonGoals: [...template.wizardDefaults.nonGoals],
        },
      }
      : {}),
    ...(template.strategicDefaults
      ? {
        strategicDefaults: {
          priorities: [...template.strategicDefaults.priorities],
          optimizationGoals: [...template.strategicDefaults.optimizationGoals],
          riskTolerance: template.strategicDefaults.riskTolerance,
          rolloutPreferences: [...template.strategicDefaults.rolloutPreferences],
          stabilityProfile: template.strategicDefaults.stabilityProfile,
          governanceIntensity: template.strategicDefaults.governanceIntensity,
          runtimeMode: template.strategicDefaults.runtimeMode,
          capabilities: { ...template.strategicDefaults.capabilities },
        },
      }
      : {}),
  }));

  return {
    templates: [...templates].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function catalog(): TemplateDefinition[] {
  if (!cachedCatalog) {
    cachedCatalog = loadTemplateCatalogFile().templates;
  }

  return cachedCatalog;
}

export function listInitTemplateNames(): string[] {
  return catalog().map((entry) => entry.id);
}

export function listInitTemplateNamesDisplay(): string {
  return listInitTemplateNames().join(", ");
}

export function isInitTemplateName(template: string): boolean {
  return catalog().some((entry) => entry.id === template);
}

export function wizardTemplateDefaults(template: string | undefined): WizardTemplateDefaults | undefined {
  if (!template) {
    return undefined;
  }

  const entry = catalog().find((candidate) => candidate.id === template);
  if (!entry?.wizardDefaults) {
    return undefined;
  }

  return cloneWizardDefaults(entry.wizardDefaults);
}

export function strategicTemplateDefaultsFromCatalog(template: string | undefined): StrategicTemplateDefaults | undefined {
  if (!template) {
    return undefined;
  }

  const entry = catalog().find((candidate) => candidate.id === template);
  if (!entry?.strategicDefaults) {
    return undefined;
  }

  return cloneStrategicDefaults(entry.strategicDefaults);
}