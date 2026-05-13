import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { CONTROL_PLANE_VERSION, ControlPlane } from "../../../schema.js";
import { compileDSLAndWrite, compile as compileToYAML } from "../../../core/dslYamlCompiler.js";
import { CompilerPipelineError, CompilerStage, compileInput } from "../../../core/compilerPipeline.js";

export type CompilerVerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type CompilerVerificationReport = {
  passed: boolean;
  checks: CompilerVerificationCheck[];
  failures: string[];
};

function baseControlPlane(): ControlPlane {
  return {
    version: CONTROL_PLANE_VERSION,
    mission: "",
    vision: "",
    intent: {
      goals: [],
      constraints: [],
      "non-goals": [],
    },
    policy: {
      rules: [],
    },
    execution: {
      plans: [],
    },
  };
}

function writePoliciesDSL(root: string, content: string): void {
  const choirRoot = path.join(root, ".choir");
  fs.mkdirSync(choirRoot, { recursive: true });
  fs.writeFileSync(path.join(choirRoot, "policies.dsl"), content, "utf-8");
}

function hasStage(error: unknown, stage: CompilerStage): boolean {
  return error instanceof CompilerPipelineError
    && error.errors.some((entry) => entry.stage === stage);
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

export async function runCompilerVerification(): Promise<CompilerVerificationReport> {
  const checks: CompilerVerificationCheck[] = [];

  const structuralControl = baseControlPlane();
  let structuralRejected = false;
  try {
    compileInput("choir define goal enforce boundaries", structuralControl);
  } catch (error) {
    structuralRejected = hasStage(error, "structure");
  }
  checks.push({
    name: "structural-invalid-dsl-rejected",
    passed: structuralRejected,
    detail: structuralRejected
      ? "invalid DSL failed at structure gate"
      : "invalid DSL was not rejected by structure gate",
  });

  const semanticControl = baseControlPlane();
  semanticControl.intent["non-goals"] = ["no direct db access"];
  let semanticRejected = false;
  try {
    compileInput('choir define constraint "no direct db access"', semanticControl);
  } catch (error) {
    semanticRejected = hasStage(error, "semantic");
  }
  checks.push({
    name: "semantic-invalid-meaning-rejected",
    passed: semanticRejected,
    detail: semanticRejected
      ? "semantic conflict failed at semantic gate"
      : "semantic conflict was not rejected by semantic gate",
  });

  const crossNodeControl = baseControlPlane();
  let crossNodeAllowsSynthesis = false;
  try {
    const compiled = compileInput("choir execute", crossNodeControl);
    crossNodeAllowsSynthesis = compiled.ruleResults.some((result) => result.ruleId === "warn-execute-without-plan-ref");
  } catch (error) {
    crossNodeAllowsSynthesis = !hasStage(error, "cross-node");
  }
  checks.push({
    name: "cross-node-implicit-execute-synthesis-allowed",
    passed: crossNodeAllowsSynthesis,
    detail: crossNodeAllowsSynthesis
      ? "execute without explicit plan is allowed with warning-level diagnostics"
      : "cross-node gate unexpectedly rejected implicit execute synthesis",
  });

  const determinismControl = baseControlPlane();
  const yamlA = compileToYAML('choir define goal "enforce service boundaries"', determinismControl);
  const yamlB = compileToYAML('choir define goal "enforce service boundaries"', determinismControl);
  const deterministic = yamlA === yamlB && hashText(yamlA) === hashText(yamlB);
  checks.push({
    name: "same-dsl-produces-identical-yaml",
    passed: deterministic,
    detail: deterministic
      ? "compile output hash remained stable across runs"
      : "compile output hash changed for identical input",
  });

  const policyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "choir-compiler-policy-"));
  try {
    const control = baseControlPlane();
    const controlPath = path.join(policyRoot, ".choir", "choir.config.yaml");
    writePoliciesDSL(policyRoot, [
      "policy deny-db-constraint {",
      "  when diff.path = \"intent.constraints\" and diff.operation = add and contains \"db\" then deny",
      "}",
      "",
    ].join("\n"));

    const denied = compileDSLAndWrite(
      'choir define constraint "db connection"',
      control,
      controlPath,
      { workspaceRoot: policyRoot }
    );

    const policyBlocked = denied.decision === "deny" && !fs.existsSync(controlPath);
    checks.push({
      name: "policy-violation-blocks-execution",
      passed: policyBlocked,
      detail: policyBlocked
        ? "policy deny prevented YAML mutation and downstream execution"
        : "policy violation did not fail closed",
    });
  } finally {
    fs.rmSync(policyRoot, { recursive: true, force: true });
  }

  const failures = checks
    .filter((entry) => !entry.passed)
    .map((entry) => `${entry.name}: ${entry.detail}`);

  return {
    passed: failures.length === 0,
    checks,
    failures,
  };
}

export function formatCompilerVerificationReport(report: CompilerVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} compiler verification`,
    ...report.checks.map((entry) => `- ${entry.name}: ${entry.passed ? "PASS" : "FAIL"} (${entry.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((entry) => `- ${entry}`));
  }

  return lines.join("\n");
}
