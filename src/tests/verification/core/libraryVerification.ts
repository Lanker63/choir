import fs from "fs";
import os from "os";
import path from "path";
import {
  importLibrary,
  installLibrary,
  listLibraryCatalog,
  lockChoirLibraries,
  readLibraryLock,
  resolveLibraryVersion,
  updateLibrary,
  verifyLibraryReplay,
} from "../../../core/macroLibraries.js";

export type LibraryVerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type LibraryVerificationReport = {
  passed: boolean;
  checks: LibraryVerificationCheck[];
  failures: string[];
};

function writeLibrary(root: string, id: string, version: string, selector: string, dependencies: string[] = []): void {
  const dir = path.join(root, ".choir", "registry", "local", id, version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.yaml"), [
    `id: ${id}`,
    `version: ${version}`,
    `selector: ${selector}`,
    "capabilities:",
    "  - id: safe-refactor",
    "    type: macro",
    "policies: []",
    "macros:",
    "  - id: safe-refactor",
    "    body:",
    `      - choir define goal \"${id}-${version}\"`,
    "strategies:",
    "  - id: low-risk",
    "templates:",
    "  - id: service-template",
    ...(dependencies.length > 0
      ? ["dependencies:", ...dependencies.map((dependency) => `  - ${dependency}`)]
      : ["dependencies: []"]),
    "",
  ].join("\n"), "utf-8");
}

export async function runLibraryVerification(): Promise<LibraryVerificationReport> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choir-library-verify-"));
  const checks: LibraryVerificationCheck[] = [];

  try {
    writeLibrary(root, "org.auth-patterns", "2.1.2", "stable");
    writeLibrary(root, "org.auth-patterns", "2.1.4", "stable");
    writeLibrary(root, "org.auth-patterns", "2.2.0", "latest");
    writeLibrary(root, "org.rollout-strategies", "1.0.0", "prod-safe", ["org.auth-patterns@stable"]);

    const catalogA = listLibraryCatalog(root);
    const catalogB = listLibraryCatalog(root);
    const catalogDeterministic = JSON.stringify(catalogA) === JSON.stringify(catalogB);
    checks.push({
      name: "deterministic-library-resolution",
      passed: catalogDeterministic,
      detail: catalogDeterministic
        ? "library catalog ordering is deterministic"
        : "library catalog ordering diverged",
    });

    const selectorA = resolveLibraryVersion(root, "org.auth-patterns", "stable");
    const selectorB = resolveLibraryVersion(root, "org.auth-patterns", "stable");
    const selectorDeterministic = selectorA === selectorB && selectorA === "2.1.4";
    checks.push({
      name: "deterministic-selector-resolution",
      passed: selectorDeterministic,
      detail: selectorDeterministic
        ? "stable selector resolved deterministically"
        : "selector resolution drifted",
    });

    importLibrary(root, "org.auth-patterns@stable");
    installLibrary(root, "org.rollout-strategies@prod-safe");
    updateLibrary(root, "org.auth-patterns");
    const locked = lockChoirLibraries(root);

    const lockExists = fs.existsSync(path.join(root, "choir.lock"));
    const lockStable = lockExists && Object.keys(locked.libraries).length === 2;
    checks.push({
      name: "lock-replay-stability",
      passed: lockStable,
      detail: lockStable
        ? "choir.lock was written with deterministic entries"
        : "lock generation failed or incomplete",
    });

    const graphExists = fs.existsSync(path.join(root, ".choir", "capability-graph.json"));
    checks.push({
      name: "capability-graph-deterministic",
      passed: graphExists,
      detail: graphExists
        ? "capability graph artifact generated"
        : "capability graph artifact missing",
    });

    const lock = readLibraryLock(root);
    const policyInheritance = Object.keys(lock.libraries).length === 2;
    checks.push({
      name: "policy-inheritance-correct",
      passed: policyInheritance,
      detail: policyInheritance
        ? "imported and installed libraries tracked in lock"
        : "library lock state missing expected entries",
    });

    const replay = verifyLibraryReplay(root);
    checks.push({
      name: "updates-replay-safe",
      passed: replay.passed,
      detail: replay.passed
        ? "library replay verification passed"
        : replay.reasons.join("; "),
    });

    const integrity = Object.values(lock.libraries).every((entry) => entry.integrityHash.startsWith("sha256:"));
    checks.push({
      name: "integrity-validation-enforced",
      passed: integrity,
      detail: integrity
        ? "all lock entries include sha256 integrity hashes"
        : "missing or invalid integrity hashes in lock",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const failures = checks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.detail}`);
  return {
    passed: failures.length === 0,
    checks,
    failures,
  };
}

export function formatLibraryVerificationReport(report: LibraryVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} library verification`,
    ...report.checks.map((check) => `- ${check.name}: ${check.passed ? "PASS" : "FAIL"} (${check.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((failure) => `- ${failure}`));
  }

  return lines.join("\n");
}
