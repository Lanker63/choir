import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerWorkspace } from "../../../core/compilerWorkspace.js";
import { runPipeline } from "../../../core/pipeline.js";
import { ControlPlaneSchema } from "../../../schema.js";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

afterEach(() => {
  for (const root of tempRoots.splice(0, tempRoots.length)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("CompilerWorkspace", () => {
  it("discovers tsconfig projects with deterministic source and export summaries", () => {
    const root = makeTempRoot("choir-compiler-workspace-");
    writeFile(root, "tsconfig.json", JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2020",
        strict: true,
        noEmit: true,
      },
      include: ["src/**/*.ts"],
    }, null, 2));
    writeFile(root, "src/a.ts", "export const alpha = 1;\n");
    writeFile(root, "node_modules/ignored/tsconfig.json", "{}\n");

    const workspace = new CompilerWorkspace({ root });

    expect(workspace.projects.map((project) => project.id)).toEqual(["tsconfig:tsconfig.json"]);
    expect(workspace.getProgram("tsconfig:tsconfig.json")).toBeDefined();
    expect(workspace.getSourceFiles().map((file) => file.relativePath)).toEqual(["src/a.ts"]);
    expect(workspace.snapshot.configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(workspace.snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(workspace.snapshot.workspaceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(workspace.getExportedSymbols().map((symbol) => symbol.name)).toContain("alpha");
  });

  it("creates a virtual project when no tsconfig exists and reports imports and diagnostics", () => {
    const root = makeTempRoot("choir-compiler-virtual-");
    writeFile(root, "src/a.ts", "export const alpha = 1;\n");
    writeFile(root, "src/b.ts", [
      "import { alpha } from \"./a\";",
      "export const beta: string = alpha;",
      "",
    ].join("\n"));

    const workspace = new CompilerWorkspace({ root });
    const diagnostics = workspace.getDiagnostics();

    expect(workspace.projects.map((project) => project.id)).toEqual(["virtual"]);
    expect(workspace.getSourceFiles().map((file) => file.relativePath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(workspace.getResolvedImports()).toContainEqual(expect.objectContaining({
      projectId: "virtual",
      file: "src/b.ts",
      moduleSpecifier: "./a",
      resolvedFile: "src/a.ts",
      isExternal: false,
    }));
    expect(diagnostics[0]?.semantic).toBeGreaterThan(0);
    expect(diagnostics[0]?.total).toBeGreaterThan(0);
  });

  it("uses in-memory workspace files for pipeline semantic diagnostics", async () => {
    const root = makeTempRoot("choir-compiler-pipeline-");
    const filePath = path.join(root, "src", "index.ts");
    const controlPlane = ControlPlaneSchema.parse({
      version: "1.0.0",
      intent: {
        goals: [],
        constraints: [],
        "nonGoals": [],
      },
      policy: {
        rules: [],
      },
      execution: {
        plans: [],
      },
    });

    const result = await runPipeline({
      controlPlane,
      workspace: {
        root,
        files: [{
          path: filePath,
          content: "const value: string = 1;\nexport { value };\n",
        }],
      },
      persistState: false,
    });

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: "semantic-diagnostic",
        category: "semantic",
      }),
    ]));
    expect(result.trace.rulesTriggered).toContain("semantic-diagnostic");
  });
});
