import fs from "fs";
import path from "path";
import assert from "assert";
import ts from "typescript";
import { fileURLToPath } from "url";
import { compileControlPlaneToRules } from "../../dsl/compiler.js";
import { ControlPlane, CONTROL_PLANE_VERSION } from "../../schema.js";
import {
  createReadonlyNormalizedAST,
  normalizeAST,
  validateNormalizedAST,
} from "../../ast/model.js";
import { buildSemanticGraph, createReadonlySemanticGraph } from "../../semantic/graph.js";
import { applyPatchesWithRoundTrip, compareASTStructure } from "../../fix/engine.js";
import { RuleContext } from "../../dsl/types.js";
import { deepFreeze } from "../../utils/deepFreeze.js";
import { RuleGoldenExpectations, RuleTest } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const goldenRoot = path.join(repoRoot, "src", "tests", "rules", "golden");

function makeControlPlaneFixture(): ControlPlane {
  return {
    version: CONTROL_PLANE_VERSION,
    mission: "Harden architecture policy checks",
    vision: "Intent and policy remain explicit and enforceable",
    intent: {
      goals: ["secure"],
      constraints: ["no direct db access", "no eval"],
      "non-goals": ["Automate all architecture decisions"],
    },
    policy: {
      rules: [
        {
          id: "explicit-no-fs-import",
          description: "Disallow fs imports",
          priority: 10,
          match: {
            imports: ["fs"],
          },
          constraint: {
            type: "forbid",
          },
          message: "Do not import fs directly",
          severity: "error",
        },
      ],
    },
    execution: {
      plans: [],
    },
  };
}

function parseTypeScript(filePath: string, code: string): ts.SourceFile {
  return ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
}

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, "\n").trim();
}

function buildAstSnapshot(filePath: string, code: string): string {
  const sourceFile = parseTypeScript(filePath, code);
  const normalized = normalizeAST(sourceFile, filePath);
  const validation = validateNormalizedAST(normalized);

  assert.strictEqual(
    validation.ok,
    true,
    `Snapshot AST validation failed for ${filePath}: ${validation.issues.map((issue) => issue.message).join(" | ")}`
  );

  const snapshot = normalized.traversalOrder.map((nodeId) => {
    const node = normalized.nodes.get(nodeId)!;
    return {
      id: node.id,
      kind: node.kindName,
      parentId: node.parentId,
      childIds: node.childIds,
    };
  });

  return JSON.stringify(snapshot, null, 2);
}

function loadGoldenCase(ruleId: string): {
  inputPath: string;
  expectedPath: string;
  expectationsPath: string;
  test: RuleTest;
  expectations: RuleGoldenExpectations;
} {
  const caseDir = path.join(goldenRoot, ruleId);
  const inputPath = path.join(caseDir, "input.ts");
  const expectedPath = path.join(caseDir, "expected.ts");
  const expectationsPath = path.join(caseDir, "expected.json");

  if (!fs.existsSync(inputPath) || !fs.existsSync(expectedPath) || !fs.existsSync(expectationsPath)) {
    throw new Error(`Missing golden files for rule ${ruleId} under ${caseDir}`);
  }

  const input = fs.readFileSync(inputPath, "utf-8");
  const expectedOutput = fs.readFileSync(expectedPath, "utf-8");
  const expectations = JSON.parse(fs.readFileSync(expectationsPath, "utf-8")) as RuleGoldenExpectations;

  return {
    inputPath,
    expectedPath,
    expectationsPath,
    test: {
      input,
      expectedViolations: expectations.expectedViolations,
      expectedOutput,
    },
    expectations,
  };
}

function runRuleTest(ruleId: string): void {
  const fixture = makeControlPlaneFixture();
  const rules = compileControlPlaneToRules(fixture);
  const rule = rules.find((candidate) => candidate.id === ruleId);

  assert.ok(rule, `Rule ${ruleId} was not compiled from control plane fixture`);

  const golden = loadGoldenCase(ruleId);
  const sourceFile = parseTypeScript(golden.inputPath, golden.test.input);
  const normalized = normalizeAST(sourceFile, golden.inputPath);
  const validation = validateNormalizedAST(normalized);

  assert.strictEqual(
    validation.ok,
    true,
    `Input AST validation failed for rule ${ruleId}: ${validation.issues.map((issue) => issue.message).join(" | ")}`
  );

  const context = {
    root: repoRoot,
    files: [
      {
        path: golden.inputPath,
        content: golden.test.input,
      },
    ],
    astMap: new Map<string, ts.SourceFile>([[golden.inputPath, sourceFile]]),
  };

  const semanticBuild = buildSemanticGraph(context, {
    [golden.inputPath]: normalized,
  });

  const ruleContext: RuleContext = {
    filePath: golden.inputPath,
    sourceFile,
    normalizedAst: createReadonlyNormalizedAST(normalized),
    semanticGraph: createReadonlySemanticGraph(semanticBuild.graph),
    traceId: `rule-harness:${ruleId}`,
    resolveNodeId(node) {
      return normalized.nodeIdByNode.get(node);
    },
  };

  const firstResult = rule!.evaluate(deepFreeze({ ...ruleContext }));
  const secondResult = rule!.evaluate(deepFreeze({ ...ruleContext }));

  assert.deepStrictEqual(
    firstResult,
    secondResult,
    `Rule ${ruleId} produced nondeterministic output across repeated evaluation`
  );

  assert.strictEqual(
    firstResult.diagnostics.length,
    golden.test.expectedViolations,
    `Rule ${ruleId} expected ${golden.test.expectedViolations} violations but got ${firstResult.diagnostics.length}`
  );

  let emittedCode = golden.test.input;
  let normalizedAfter = normalized;
  const patches = (firstResult.fixes ?? []).flatMap((fix) => fix.patches);

  if (patches.length > 0) {
    const applyResult = applyPatchesWithRoundTrip(sourceFile, normalized, patches);

    assert.strictEqual(
      applyResult.patchValidation.ok,
      true,
      `Rule ${ruleId} produced invalid patches: ${applyResult.patchValidation.issues.map((issue) => issue.message).join(" | ")}`
    );

    assert.strictEqual(
      applyResult.roundTripSafe,
      true,
      `Rule ${ruleId} patch round-trip failed: ${applyResult.validation.issues.map((issue) => issue.message).join(" | ")}`
    );

    emittedCode = applyResult.code;
    normalizedAfter = normalizeAST(applyResult.ast, golden.inputPath);
  }

  if (golden.test.expectedOutput) {
    assert.strictEqual(
      normalizeLineEndings(emittedCode),
      normalizeLineEndings(golden.test.expectedOutput),
      `Rule ${ruleId} generated code does not match expected.ts`
    );
  }

  const beforeSnapshot = buildAstSnapshot(golden.inputPath, golden.test.input);
  const expectedAfterSnapshot = buildAstSnapshot(golden.expectedPath, golden.test.expectedOutput ?? golden.test.input);
  const actualAfterSnapshot = JSON.stringify(
    normalizedAfter.traversalOrder.map((nodeId) => {
      const node = normalizedAfter.nodes.get(nodeId)!;
      return {
        id: node.id,
        kind: node.kindName,
        parentId: node.parentId,
        childIds: node.childIds,
      };
    }),
    null,
    2
  );

  assert.ok(beforeSnapshot.length > 0, `Rule ${ruleId} before snapshot is empty`);
  assert.strictEqual(
    actualAfterSnapshot,
    expectedAfterSnapshot,
    `Rule ${ruleId} AST snapshot mismatch after evaluation`
  );

  const structureDiff = compareASTStructure(normalized, normalizedAfter);
  const expectedDiff = golden.expectations.expectedStructureDiff ?? {
    removedNodeIds: [],
    addedNodeIds: [],
  };

  assert.deepStrictEqual(
    structureDiff,
    expectedDiff,
    `Rule ${ruleId} structure diff does not match expected diff`
  );
}

function ensureRuleCoverage(compiledRuleIds: string[]): void {
  const missing = compiledRuleIds.filter((ruleId) => !fs.existsSync(path.join(goldenRoot, ruleId, "expected.json")));
  assert.strictEqual(
    missing.length,
    0,
    `Missing golden coverage for compiled rules: ${missing.join(", ")}`
  );
}

function main(): void {
  const fixture = makeControlPlaneFixture();
  const rules = compileControlPlaneToRules(fixture);
  const ruleIds = rules.map((rule) => rule.id).sort((a, b) => a.localeCompare(b));

  ensureRuleCoverage(ruleIds);

  for (const ruleId of ruleIds) {
    runRuleTest(ruleId);
    process.stdout.write(`PASS ${ruleId}\n`);
  }

  process.stdout.write(`PASS rule harness (${ruleIds.length} rules)\n`);
}

main();
