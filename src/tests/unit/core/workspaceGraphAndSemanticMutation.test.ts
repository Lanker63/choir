import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceGraphStore } from "../../../core/workspaceGraphStore.js";
import {
  executeSemanticMutations,
  type SemanticMutation,
} from "../../../core/semanticMutationExecutor.js";
import { projectSemanticManifestToPatches } from "../../../core/semanticMutationPatchAdapter.js";
import { compileDSLRule } from "../../../dsl/compiler.js";
import { DSLRuleSchema } from "../../../dsl/types.js";
import { buildContext } from "../../../core/context.js";
import { parseAST } from "../../../ast/parser.js";
import { buildSemanticGraph, createReadonlySemanticGraph } from "../../../semantic/graph.js";
import { createReadonlyNormalizedAST } from "../../../ast/model.js";
import ts from "typescript";

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

describe("WorkspaceGraphStore", () => {
  it("builds deterministic package and import graphs with invalidation hashes", () => {
    const root = makeTempRoot("choir-graph-store-");
    writeFile(root, "package.json", JSON.stringify({
      name: "workspace-root",
      private: true,
      workspaces: ["packages/*"],
    }, null, 2));
    writeFile(root, "packages/a/package.json", JSON.stringify({
      name: "@repo/a",
      version: "1.0.0",
      dependencies: {
        "@repo/b": "1.0.0",
      },
    }, null, 2));
    writeFile(root, "packages/b/package.json", JSON.stringify({
      name: "@repo/b",
      version: "1.0.0",
    }, null, 2));
    writeFile(root, "tsconfig.json", JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2020",
        strict: true,
        noEmit: true,
      },
      include: ["packages/**/*.ts"],
    }, null, 2));
    writeFile(root, "packages/a/src/index.ts", "import { b } from \"../../b/src/index.js\"; export const a = b + 1;\n");
    writeFile(root, "packages/b/src/index.ts", "export const b = 1;\n");

    const storeA = new WorkspaceGraphStore({ root });
    const storeB = new WorkspaceGraphStore({ root });

    expect(storeA.snapshot.invalidation.workspaceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storeA.snapshot.invalidation.workspaceHash).toBe(storeB.snapshot.invalidation.workspaceHash);
    expect(storeA.getPackageGraph().edges).toContainEqual(expect.objectContaining({
      from: "unit:packages/a",
      to: "unit:packages/b",
      type: "depends-on",
    }));
    expect(storeA.getImportGraph().edges).toContainEqual(expect.objectContaining({
      from: "packages/a/src/index.ts",
      to: "packages/b/src/index.ts",
      type: "imports",
    }));
  });
});

describe("semantic mutation executor", () => {
  it("renames symbols and rewrites imports/callsites with deterministic manifest evidence", async () => {
    const root = makeTempRoot("choir-semantic-mutation-");
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
    writeFile(root, "src/a.ts", "export const foo = 1;\n");
    writeFile(root, "src/b.ts", "import { foo } from \"./a.js\"; export const value = foo + 1;\n");

    const first = await executeSemanticMutations({
      root,
      mutations: [{
        kind: "RenameSymbol",
        symbolHint: {
          file: "src/a.ts",
          name: "foo",
        },
        newName: "bar",
      }],
    });

    const second = await executeSemanticMutations({
      root,
      mutations: [{
        kind: "RenameSymbol",
        symbolHint: {
          file: "src/a.ts",
          name: "foo",
        },
        newName: "bar",
      }],
    });

    expect(first.manifest.replayHash).toBe(second.manifest.replayHash);
    expect(first.manifest.compilerEvidence.after.total).toBeLessThanOrEqual(first.manifest.compilerEvidence.before.total);
    expect(first.changedFiles["src/a.ts"]).toContain("bar");
    expect(first.changedFiles["src/b.ts"]).toContain("bar");

    const projected = projectSemanticManifestToPatches(first.manifest);
    expect(projected.length).toBeGreaterThan(0);
    expect(projected.every((patch) => patch.type === "create-file")).toBe(true);
  });

  it("supports file rename with import graph rewrite", async () => {
    const root = makeTempRoot("choir-semantic-rename-file-");
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
    writeFile(root, "src/util.ts", "export const token = \"ok\";\n");
    writeFile(root, "src/index.ts", "import { token } from \"./util.js\"; export const value = token;\n");

    const mutations: SemanticMutation[] = [{
      kind: "RenameFile",
      from: "src/util.ts",
      to: "src/helpers/util.ts",
      rewriteImports: true,
    }];

    const result = await executeSemanticMutations({ root, mutations });
    expect(result.changedFiles["src/index.ts"]).toContain("./helpers/util.js");
    expect(result.changedFiles["src/helpers/util.ts"]).toContain("token");
  });
});

describe("DSL selectors and semantic predicates", () => {
  it("evaluates ast selectors with semantic import predicates", () => {
    const parsed = DSLRuleSchema.parse({
      id: "forbid-external-lodash",
      match: {
        astSelectors: {
          importModules: ["lodash"],
        },
        semanticPredicates: {
          externalImportsOnly: true,
        },
      },
      constraint: {
        type: "forbid",
      },
      message: "External lodash import is forbidden",
      severity: "error",
    });

    const rule = compileDSLRule(parsed);
    const source = ts.createSourceFile("src/rule.ts", "import _ from \"lodash\";\n", ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const context = buildContext({
      root: process.cwd(),
      files: [{
        path: path.join(process.cwd(), "src", "rule.ts"),
        content: source.text,
      }],
    });
    const parsedAst = parseAST(context);
    const normalized = parsedAst.normalizedAsts[path.join(process.cwd(), "src", "rule.ts")];
    if (!normalized) {
      throw new Error("Missing normalized AST for test source");
    }

    const semanticBuild = buildSemanticGraph(context, parsedAst.normalizedAsts);
    const result = rule.evaluate({
      filePath: "src/rule.ts",
      sourceFile: source,
      normalizedAst: createReadonlyNormalizedAST(normalized),
      semanticGraph: createReadonlySemanticGraph(semanticBuild.graph),
      traceId: "trace-test",
      resolveNodeId(node) {
        return normalized.nodeIdByNode.get(node);
      },
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain("forbidden");
  });
});
