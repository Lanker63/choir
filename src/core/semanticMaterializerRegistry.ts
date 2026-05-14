import { createHash } from "crypto";
import ts from "typescript";
import { Fix, Patch } from "../fix/types.js";
import { ControlPlane, Task } from "../schema.js";
import { WorkUnit } from "./scheduler.js";
import { Diagnostic } from "./types.js";

export type SemanticGenerationScenario = "sample-api-service";

export type ArtifactGeneratorContext = {
  root: string;
  controlPlane: ControlPlane;
  workUnit: WorkUnit;
  task: Task;
  files: Record<string, string>;
};

export type ArtifactGenerator = (context: ArtifactGeneratorContext) => Fix[];

export type WorkUnitGenerator = {
  taskType: Task["type"];
  generate: ArtifactGenerator;
};

export interface ASTPatchSynthesizer {
  synthesize(file: string, current: string | undefined): Patch[];
}

const semanticGenerationTaskTypes = new Set<Task["type"]>([
  "create-project-structure",
  "create-directory",
  "generate-config",
  "generate-model",
  "generate-controller",
  "generate-api-route",
  "generate-typescript-module",
  "generate-tests",
  "apply-ast-patch",
]);

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildFix(input: {
  task: Task;
  workUnitId: string;
  title: string;
  patches: Patch[];
}): Fix {
  const normalizedPatches = [...input.patches];
  const digest = stableHash({
    taskId: input.task.id,
    taskType: input.task.type,
    workUnitId: input.workUnitId,
    patches: normalizedPatches,
  }).slice(0, 16);

  return {
    id: `semantic-${input.task.id}-${digest}`,
    ruleId: `semantic-generation:${input.task.type}`,
    title: input.title,
    diagnosticIds: [`semantic-diagnostic:${input.task.id}`],
    patches: normalizedPatches,
    isPreferred: true,
    isSafe: true,
    traceId: `semantic:${input.task.id}`,
  };
}

function createFilePatch(file: string, content: string): Patch {
  return {
    type: "create-file",
    file: normalizePath(file),
    content,
  };
}

export function inferSemanticGenerationScenario(controlPlane: ControlPlane): SemanticGenerationScenario | undefined {
  const goals = sortedUnique(controlPlane.intent.goals.map((goal) => goal.trim().toLowerCase()));
  if (goals.length === 0) {
    return undefined;
  }

  const apiSignals = [
    /\bapi service\b/i,
    /\bapi\b/i,
    /\broutes?\b/i,
    /\bcontrollers?\b/i,
    /\bmodels?\b/i,
    /\btests?\b/i,
  ];
  const actionSignals = [
    /\bcreate\b/i,
    /\bgenerate\b/i,
    /\bbuild\b/i,
    /\bscaffold\b/i,
    /\bsample\b/i,
  ];

  const hasApiIntent = goals.some((goal) =>
    apiSignals.some((signal) => signal.test(goal))
    && actionSignals.some((signal) => signal.test(goal))
  );

  return hasApiIntent ? "sample-api-service" : undefined;
}

const sampleApiFiles = {
  structure: [
    "src/README.generated.md",
    "src/api/README.generated.md",
    "src/routes/README.generated.md",
    "src/models/README.generated.md",
    "src/controllers/README.generated.md",
    "tests/README.generated.md",
  ],
  config: "src/api/config.ts",
  model: "src/models/sample.model.ts",
  controller: "src/controllers/sample.controller.ts",
  route: "src/routes/sample.routes.ts",
  module: "src/api/index.ts",
  tests: "tests/sample-api.test.ts",
} as const;

export function semanticTasksForScenario(scenario: SemanticGenerationScenario): Task[] {
  if (scenario !== "sample-api-service") {
    return [];
  }

  return [
    {
      id: "t-structure",
      title: "Create project structure",
      description: "Create deterministic source/test directory layout for generated API service.",
      type: "create-project-structure",
      scope: {
        files: [...sampleApiFiles.structure],
      },
      dependsOn: ["t-analysis"],
      successCriteria: ["project structure created"],
    },
    {
      id: "t-config",
      title: "Generate API config",
      description: "Generate deterministic API runtime configuration module.",
      type: "generate-config",
      scope: {
        files: [sampleApiFiles.config],
      },
      dependsOn: ["t-structure"],
      successCriteria: ["api config generated"],
    },
    {
      id: "t-model",
      title: "Generate model",
      description: "Generate deterministic model type and validation helpers.",
      type: "generate-model",
      scope: {
        files: [sampleApiFiles.model],
      },
      dependsOn: ["t-structure"],
      successCriteria: ["model generated"],
    },
    {
      id: "t-controller",
      title: "Generate controller",
      description: "Generate deterministic API controller implementation.",
      type: "generate-controller",
      scope: {
        files: [sampleApiFiles.controller],
      },
      dependsOn: ["t-model", "t-config"],
      successCriteria: ["controller generated"],
    },
    {
      id: "t-route",
      title: "Generate API route",
      description: "Generate deterministic route binding for sample API endpoint.",
      type: "generate-api-route",
      scope: {
        files: [sampleApiFiles.route],
      },
      dependsOn: ["t-controller"],
      successCriteria: ["routes generated"],
    },
    {
      id: "t-module",
      title: "Generate TypeScript module",
      description: "Generate deterministic API module entrypoint.",
      type: "generate-typescript-module",
      scope: {
        files: [sampleApiFiles.module],
      },
      dependsOn: ["t-route"],
      successCriteria: ["api module generated"],
    },
    {
      id: "t-ast-patch",
      title: "Apply AST patch",
      description: "Apply deterministic AST patch to normalize exports and surface API type alias.",
      type: "apply-ast-patch",
      scope: {
        files: [sampleApiFiles.module],
      },
      dependsOn: ["t-module"],
      successCriteria: ["ast patch applied"],
    },
    {
      id: "t-tests",
      title: "Generate tests",
      description: "Generate deterministic tests for route/controller/model integration.",
      type: "generate-tests",
      scope: {
        files: [sampleApiFiles.tests],
      },
      dependsOn: ["t-ast-patch"],
      successCriteria: ["tests generated"],
    },
  ];
}

class ApiIndexAstPatchSynthesizer implements ASTPatchSynthesizer {
  synthesize(file: string, current: string | undefined): Patch[] {
    const normalizedFile = normalizePath(file);
    const fallback = [
      "import { createSampleRouter } from \"../routes/sample.routes\";",
      "",
      "export function buildApiService() {",
      "  return {",
      "    router: createSampleRouter(),",
      "  };",
      "}",
      "",
      "export type ApiService = ReturnType<typeof buildApiService>;",
      "",
    ].join("\n");

    const source = current ?? fallback;
    const sourceFile = ts.createSourceFile(normalizedFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (parseDiagnostics.length > 0) {
      return [createFilePatch(normalizedFile, fallback)];
    }

    const hasTypeAlias = sourceFile.statements.some((statement) =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === "ApiService"
    );

    if (hasTypeAlias) {
      return [];
    }

    const next = source.endsWith("\n")
      ? `${source}export type ApiService = ReturnType<typeof buildApiService>;\n`
      : `${source}\nexport type ApiService = ReturnType<typeof buildApiService>;\n`;

    return [createFilePatch(normalizedFile, next)];
  }
}

export class SemanticMaterializerRegistry {
  private readonly generators = new Map<Task["type"], ArtifactGenerator>();

  register(generator: WorkUnitGenerator): void {
    this.generators.set(generator.taskType, generator.generate);
  }

  resolve(taskType: Task["type"]): ArtifactGenerator | undefined {
    return this.generators.get(taskType);
  }

  isSemanticTaskType(taskType: Task["type"]): boolean {
    return semanticGenerationTaskTypes.has(taskType);
  }

  synthesize(input: {
    root: string;
    controlPlane: ControlPlane;
    workUnits: WorkUnit[];
    files: Record<string, string>;
  }): Fix[] {
    const fixes: Fix[] = [];
    const orderedUnits = [...input.workUnits].sort((left, right) => left.id.localeCompare(right.id));

    for (const unit of orderedUnits) {
      const orderedTasks = [...unit.tasks].sort((left, right) => left.id.localeCompare(right.id));
      for (const task of orderedTasks) {
        const generator = this.resolve(task.type);
        if (!generator) {
          continue;
        }

        fixes.push(...generator({
          root: input.root,
          controlPlane: input.controlPlane,
          workUnit: unit,
          task,
          files: input.files,
        }));
      }
    }

    return fixes.sort((left, right) => left.id.localeCompare(right.id));
  }
}

const astPatchSynthesizer = new ApiIndexAstPatchSynthesizer();

function createDefaultRegistry(): SemanticMaterializerRegistry {
  const registry = new SemanticMaterializerRegistry();

  registry.register({
    taskType: "create-project-structure",
    generate(context) {
      const patches = sampleApiFiles.structure.map((file) => createFilePatch(file, "generated by choir semantic runtime\n"));
      return [buildFix({
        task: context.task,
        workUnitId: context.workUnit.id,
        title: "Create semantic project structure",
        patches,
      })];
    },
  });

  registry.register({
    taskType: "create-directory",
    generate(context) {
      const patches = (context.task.scope?.files ?? [])
        .map((file) => createFilePatch(file, ""));
      if (patches.length === 0) {
        return [];
      }

      return [buildFix({
        task: context.task,
        workUnitId: context.workUnit.id,
        title: "Create deterministic directory placeholders",
        patches,
      })];
    },
  });

  registry.register({
    taskType: "generate-config",
    generate(context) {
      const content = [
        "export const apiConfig = {",
        "  basePath: \"/api\",",
        "  serviceName: \"sample-api-service\",",
        "} as const;",
        "",
      ].join("\n");

      return [buildFix({
        task: context.task,
        workUnitId: context.workUnit.id,
        title: "Generate deterministic API config",
        patches: [createFilePatch(sampleApiFiles.config, content)],
      })];
    },
  });

  registry.register({
    taskType: "generate-model",
    generate(context) {
      const content = [
        "export interface SampleModel {",
        "  id: string;",
        "  name: string;",
        "}",
        "",
        "export function createSampleModel(input: { id: string; name: string }): SampleModel {",
        "  return {",
        "    id: input.id.trim(),",
        "    name: input.name.trim(),",
        "  };",
        "}",
        "",
      ].join("\n");

      return [buildFix({
        task: context.task,
        workUnitId: context.workUnit.id,
        title: "Generate deterministic model",
        patches: [createFilePatch(sampleApiFiles.model, content)],
      })];
    },
  });

  registry.register({
    taskType: "generate-controller",
    generate(context) {
      const content = [
        "import { apiConfig } from \"../api/config\";",
        "import { createSampleModel, type SampleModel } from \"../models/sample.model\";",
        "",
        "export function buildSampleModelResponse(id: string, name: string): { service: string; model: SampleModel } {",
        "  return {",
        "    service: apiConfig.serviceName,",
        "    model: createSampleModel({ id, name }),",
        "  };",
        "}",
        "",
      ].join("\n");

      return [buildFix({
        task: context.task,
        workUnitId: context.workUnit.id,
        title: "Generate deterministic controller",
        patches: [createFilePatch(sampleApiFiles.controller, content)],
      })];
    },
  });

  registry.register({
    taskType: "generate-api-route",
    generate(context) {
      const content = [
        "import { buildSampleModelResponse } from \"../controllers/sample.controller\";",
        "",
        "export type RouteResult = {",
        "  status: number;",
        "  body: ReturnType<typeof buildSampleModelResponse>;",
        "};",
        "",
        "export function createSampleRouter() {",
        "  return {",
        "    getSample(id: string): RouteResult {",
        "      return {",
        "        status: 200,",
        "        body: buildSampleModelResponse(id, \"sample\"),",
        "      };",
        "    },",
        "  };",
        "}",
        "",
      ].join("\n");

      return [buildFix({
        task: context.task,
        workUnitId: context.workUnit.id,
        title: "Generate deterministic API route",
        patches: [createFilePatch(sampleApiFiles.route, content)],
      })];
    },
  });

  registry.register({
    taskType: "generate-typescript-module",
    generate(context) {
      const content = [
        "import { createSampleRouter } from \"../routes/sample.routes\";",
        "",
        "export function buildApiService() {",
        "  return {",
        "    router: createSampleRouter(),",
        "  };",
        "}",
        "",
      ].join("\n");

      return [buildFix({
        task: context.task,
        workUnitId: context.workUnit.id,
        title: "Generate deterministic TypeScript module",
        patches: [createFilePatch(sampleApiFiles.module, content)],
      })];
    },
  });

  registry.register({
    taskType: "apply-ast-patch",
    generate(context) {
      const current = context.files[normalizePath(sampleApiFiles.module)];
      const patches = astPatchSynthesizer.synthesize(sampleApiFiles.module, current);
      if (patches.length === 0) {
        return [];
      }

      return [buildFix({
        task: context.task,
        workUnitId: context.workUnit.id,
        title: "Apply deterministic AST patch",
        patches,
      })];
    },
  });

  registry.register({
    taskType: "generate-tests",
    generate(context) {
      const content = [
        "import { strict as assert } from \"assert\";",
        "import { buildApiService } from \"../src/api/index\";",
        "",
        "const service = buildApiService();",
        "const result = service.router.getSample(\"sample-id\");",
        "",
        "assert.strictEqual(result.status, 200);",
        "assert.strictEqual(result.body.model.id, \"sample-id\");",
        "assert.strictEqual(result.body.service, \"sample-api-service\");",
        "",
      ].join("\n");

      return [buildFix({
        task: context.task,
        workUnitId: context.workUnit.id,
        title: "Generate deterministic tests",
        patches: [createFilePatch(sampleApiFiles.tests, content)],
      })];
    },
  });

  return registry;
}

export const semanticMaterializerRegistry = createDefaultRegistry();

export function synthesizeSemanticFixesForWorkUnits(input: {
  root: string;
  controlPlane: ControlPlane;
  workUnits: WorkUnit[];
  files: Record<string, string>;
}): Fix[] {
  return semanticMaterializerRegistry.synthesize(input);
}

function patchPrimaryFile(patch: Patch): string {
  if (patch.type === "create-file" || patch.type === "delete-file") {
    return normalizePath(patch.file);
  }

  if (patch.type === "rename-file") {
    return normalizePath(patch.to);
  }

  return normalizePath(patch.location.file);
}

function patchPrimaryLocation(patch: Patch): Diagnostic["location"] {
  if (patch.type === "replace" || patch.type === "insert" || patch.type === "delete") {
    return {
      file: normalizePath(patch.location.file),
      start: {
        line: patch.location.start.line,
        character: patch.location.start.character,
      },
      end: {
        line: patch.location.end.line,
        character: patch.location.end.character,
      },
    };
  }

  const file = patchPrimaryFile(patch);
  return {
    file,
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  };
}

export function semanticDiagnosticsForFixes(fixes: Fix[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const fix of [...fixes].sort((left, right) => left.id.localeCompare(right.id))) {
    const diagnosticId = fix.diagnosticIds[0];
    if (!diagnosticId) {
      continue;
    }

    const firstPatch = fix.patches[0];
    if (!firstPatch) {
      continue;
    }

    diagnostics.push({
      id: diagnosticId,
      ruleId: fix.ruleId,
      message: `Semantic generator emitted ${fix.title}`,
      severity: "info",
      location: patchPrimaryLocation(firstPatch),
      category: "strategy",
      traceId: fix.traceId,
      fixIds: [fix.id],
    });
  }

  return diagnostics;
}
