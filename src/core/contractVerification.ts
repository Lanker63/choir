import { spawnSync } from "child_process";
import path from "path";

export type ContractVerificationMode = "quick" | "full";

export type ContractCommandResult = {
  id: "build" | "architecture" | "verification" | "property" | "chaos";
  command: string;
  args: string[];
  exitCode: number;
  durationMs: number;
  output: string;
};

export type ContractSectionResult = {
  id: number;
  name: string;
  passed: boolean;
  missingChecks: string[];
};

export type ContractVerificationReport = {
  passed: boolean;
  mode: ContractVerificationMode;
  workspaceRoot: string;
  sections: ContractSectionResult[];
  commands: ContractCommandResult[];
};

type OutputSource = "architecture" | "verification" | "property" | "chaos";

type SectionCheck = {
  description: string;
  source: OutputSource;
  pattern: RegExp;
};

type SectionSpec = {
  id: number;
  name: string;
  checks: SectionCheck[];
};

const SECTION_SPECS: SectionSpec[] = [
  {
    id: 1,
    name: "Three-Plane Contract",
    checks: [
      {
        description: "chat mutates control plane YAML",
        source: "architecture",
        pattern: /PASS 2\.2 chat mutates control plane YAML/,
      },
      {
        description: "state derives from workspace plus control plane",
        source: "architecture",
        pattern: /PASS 3\.4 state derived only from workspace plus control plane/,
      },
      {
        description: "enforcement requires pipeline execution",
        source: "architecture",
        pattern: /PASS 2\.3 enforcement requires pipeline execution/,
      },
    ],
  },
  {
    id: 2,
    name: "Compiler Pipeline",
    checks: [
      {
        description: "structural validation stage",
        source: "architecture",
        pattern: /PASS 2\.90 ast structure validation rejects malformed nodes deterministically/,
      },
      {
        description: "semantic validation stage",
        source: "architecture",
        pattern: /PASS 2\.91 ast semantic validation rejects duplicates and conflicts/,
      },
      {
        description: "cross-node validation stage",
        source: "architecture",
        pattern: /PASS 2\.92 cross-node validation enforces plan and execute preconditions/,
      },
    ],
  },
  {
    id: 3,
    name: "Determinism Contract",
    checks: [
      {
        description: "verification harness passes",
        source: "verification",
        pattern: /PASS verification harness/,
      },
      {
        description: "determinism metric is true",
        source: "verification",
        pattern: /- determinism: true/,
      },
      {
        description: "property harness passes",
        source: "property",
        pattern: /PASS property\+chaos harness/,
      },
      {
        description: "chaos harness passes",
        source: "chaos",
        pattern: /PASS property\+chaos harness/,
      },
    ],
  },
  {
    id: 4,
    name: "State Integrity",
    checks: [
      {
        description: "state hash determinism",
        source: "architecture",
        pattern: /PASS 3\.13 state hash is deterministic for equivalent states/,
      },
      {
        description: "snapshots and rollback",
        source: "architecture",
        pattern: /PASS 3\.14 state snapshots are created and rollback restores exact snapshot/,
      },
      {
        description: "timeline model integrity",
        source: "architecture",
        pattern: /PASS 3\.15 workspace timeline model records global and per-unit events/,
      },
    ],
  },
  {
    id: 5,
    name: "Policy Contract",
    checks: [
      {
        description: "require-approval gate",
        source: "architecture",
        pattern: /PASS 2\.24 policy require-approval blocks until approved for exact diff hash/,
      },
      {
        description: "deny precedence",
        source: "architecture",
        pattern: /PASS 2\.34 policy precedence is deterministic deny over require-approval/,
      },
      {
        description: "org deny precedence over repo",
        source: "architecture",
        pattern: /PASS 2\.41 org deny policy wins over repo allow policy/,
      },
    ],
  },
  {
    id: 6,
    name: "Execution Contract",
    checks: [
      {
        description: "transaction commit path",
        source: "architecture",
        pattern: /PASS 4\.11 transactional execution commits validated batches/,
      },
      {
        description: "transaction rollback path",
        source: "architecture",
        pattern: /PASS 4\.12 transactional execution rolls back on validation failure without writes/,
      },
      {
        description: "transaction reject non-idempotent patch",
        source: "architecture",
        pattern: /PASS 4\.13 transactional execution rejects non-idempotent patch sets/,
      },
    ],
  },
  {
    id: 7,
    name: "Simulation Equivalence",
    checks: [
      {
        description: "simulation blocks execution on failure",
        source: "architecture",
        pattern: /PASS 6\.10d execution is blocked when simulation gate fails/,
      },
      {
        description: "simulation and execution converge",
        source: "architecture",
        pattern: /PASS 6\.10e simulation and execution converge to identical final state/,
      },
    ],
  },
  {
    id: 8,
    name: "Refactor Contract (PASS 1)",
    checks: [
      {
        description: "refactor parser surface",
        source: "architecture",
        pattern: /PASS 2\.8 choir DSL parser supports refactor commands/,
      },
      {
        description: "deterministic refactor preview and rollback",
        source: "architecture",
        pattern: /PASS 2\.59 refactor engine preview is deterministic and rollback restores snapshots/,
      },
    ],
  },
  {
    id: 9,
    name: "Planning Contract",
    checks: [
      {
        description: "deterministic cost model",
        source: "architecture",
        pattern: /PASS 4\.14 cost scoring is deterministic and explainable/,
      },
      {
        description: "deterministic tie-break by plan id",
        source: "architecture",
        pattern: /PASS 4\.15 cost selection uses deterministic plan-id tie-breaker/,
      },
      {
        description: "deterministic lowest-cost selection",
        source: "architecture",
        pattern: /PASS 4\.16 cost-based plan set selection returns lowest-cost plan/,
      },
    ],
  },
  {
    id: 10,
    name: "Global Orchestration",
    checks: [
      {
        description: "global graph cycle detection",
        source: "architecture",
        pattern: /PASS 6\.2 global dependency graph includes inter-repo edges and rejects repo cycles/,
      },
      {
        description: "deterministic dependency-safe ordering",
        source: "architecture",
        pattern: /PASS 6\.3 ordered global execution is deterministic and dependency-safe/,
      },
      {
        description: "rollback isolation scope",
        source: "architecture",
        pattern: /PASS 6\.10p rollback set includes failed unit and executed dependents only/,
      },
    ],
  },
  {
    id: 11,
    name: "Distributed Sync",
    checks: [
      {
        description: "deterministic logical clock operations",
        source: "architecture",
        pattern: /PASS 5\.1 replica model and logical clock operations are deterministic/,
      },
      {
        description: "deterministic merge",
        source: "architecture",
        pattern: /PASS 5\.4 state merge is commutative and deterministic/,
      },
      {
        description: "deterministic convergence",
        source: "architecture",
        pattern: /PASS 5\.5 push pull and bidirectional sync modes converge deterministically/,
      },
    ],
  },
  {
    id: 12,
    name: "Audit Contract",
    checks: [
      {
        description: "immutable audit hash chain",
        source: "architecture",
        pattern: /PASS 2\.48 audit store records compile and policy evaluation with immutable hash chain/,
      },
      {
        description: "deterministic audit query and reports",
        source: "architecture",
        pattern: /PASS 2\.50 audit query and compliance reports are deterministic with multi-format export/,
      },
    ],
  },
  {
    id: 13,
    name: "Webview Contract",
    checks: [
      {
        description: "deterministic graph transform for UI projection",
        source: "architecture",
        pattern: /PASS 6\.15 dependency graph transform to UI graph is deterministic and sorted/,
      },
      {
        description: "deterministic graph snapshot overlays",
        source: "architecture",
        pattern: /PASS 6\.16 graph snapshot is deterministic and projects plan\/violation overlays/,
      },
    ],
  },
  {
    id: 14,
    name: "Non-Negotiable Safeguards",
    checks: [
      {
        description: "simulation gate enforcement",
        source: "architecture",
        pattern: /PASS 6\.10d execution is blocked when simulation gate fails/,
      },
      {
        description: "fail-closed simulation\/execution divergence",
        source: "architecture",
        pattern: /PASS 6\.10g execution fails closed when simulation and execution outcomes diverge/,
      },
      {
        description: "cross-cutting safety contract",
        source: "architecture",
        pattern: /PASS X\.5 priority overrides and dependency safety rejections are honored/,
      },
    ],
  },
];

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runCommand(
  id: ContractCommandResult["id"],
  root: string,
  command: string,
  args: string[],
  env?: Record<string, string>
): ContractCommandResult {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf-8",
    env: {
      ...process.env,
      ...(env ?? {}),
    },
  });

  const exitCode = typeof result.status === "number" ? result.status : 1;
  return {
    id,
    command,
    args,
    exitCode,
    durationMs: Date.now() - started,
    output: [result.stdout ?? "", result.stderr ?? ""].filter((entry) => entry.length > 0).join("\n"),
  };
}

function executeContractCommands(workspaceRoot: string, mode: ContractVerificationMode): ContractCommandResult[] {
  const verifyMode = mode === "full" ? "full" : "quick";
  const propertyIterations = mode === "full" ? "200" : "16";
  const chaosIterations = mode === "full" ? "120" : "10";

  const build = runCommand("build", workspaceRoot, npmExecutable(), ["run", "build:extension"]);

  const architecture = runCommand(
    "architecture",
    workspaceRoot,
    process.execPath,
    [path.join("out", "tests", "architecture", "suite.js")]
  );

  const verification = runCommand(
    "verification",
    workspaceRoot,
    process.execPath,
    [path.join("out", "tests", "verification", "harness.js")],
    { CHOIR_VERIFY_MODE: verifyMode }
  );

  const property = runCommand(
    "property",
    workspaceRoot,
    process.execPath,
    [path.join("out", "tests", "verification", "propertyChaosHarness.js"), "property"],
    { CHOIR_PROPERTY_ITERATIONS: propertyIterations }
  );

  const chaos = runCommand(
    "chaos",
    workspaceRoot,
    process.execPath,
    [path.join("out", "tests", "verification", "propertyChaosHarness.js"), "chaos", "moderate"],
    { CHOIR_CHAOS_ITERATIONS: chaosIterations }
  );

  return [build, architecture, verification, property, chaos];
}

function evaluateSections(outputs: Record<OutputSource, string>): ContractSectionResult[] {
  return SECTION_SPECS.map((section) => {
    const missingChecks = section.checks
      .filter((check) => !check.pattern.test(outputs[check.source]))
      .map((check) => check.description);

    return {
      id: section.id,
      name: section.name,
      passed: missingChecks.length === 0,
      missingChecks,
    };
  });
}

export type RunContractVerificationOptions = {
  workspaceRoot?: string;
  mode?: ContractVerificationMode;
  throwOnFailure?: boolean;
};

export async function runContractVerification(options: RunContractVerificationOptions = {}): Promise<ContractVerificationReport> {
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : process.cwd();
  const mode = options.mode ?? "quick";

  const commands = executeContractCommands(workspaceRoot, mode);
  const outputs: Record<OutputSource, string> = {
    architecture: commands.find((entry) => entry.id === "architecture")?.output ?? "",
    verification: commands.find((entry) => entry.id === "verification")?.output ?? "",
    property: commands.find((entry) => entry.id === "property")?.output ?? "",
    chaos: commands.find((entry) => entry.id === "chaos")?.output ?? "",
  };

  const sections = evaluateSections(outputs);
  const commandsPassed = commands.every((entry) => entry.exitCode === 0);
  const sectionsPassed = sections.every((entry) => entry.passed);
  const passed = commandsPassed && sectionsPassed;

  const report: ContractVerificationReport = {
    passed,
    mode,
    workspaceRoot,
    sections,
    commands,
  };

  if (!passed && options.throwOnFailure !== false) {
    throw new Error(formatContractVerificationReport(report));
  }

  return report;
}

export function formatContractVerificationReport(report: ContractVerificationReport): string {
  const status = report.passed ? "PASS" : "FAIL";
  const sectionsPassed = report.sections.filter((entry) => entry.passed).length;

  const lines = [
    `${status} contract verification`,
    `- mode: ${report.mode}`,
    `- workspace: ${report.workspaceRoot}`,
    `- sectionsPassed: ${sectionsPassed}/${report.sections.length}`,
    `- commandsPassed: ${report.commands.filter((entry) => entry.exitCode === 0).length}/${report.commands.length}`,
    "",
    "Sections:",
  ];

  for (const section of report.sections) {
    lines.push(`${section.passed ? "PASS" : "FAIL"} ${section.id}. ${section.name}`);
    if (!section.passed) {
      for (const missing of section.missingChecks) {
        lines.push(`- missing: ${missing}`);
      }
    }
  }

  lines.push("", "Command results:");
  for (const command of report.commands) {
    const commandLine = `${command.command} ${command.args.join(" ")}`.trim();
    lines.push(`- ${command.id}: exit=${command.exitCode}, durationMs=${command.durationMs}, cmd=${commandLine}`);
  }

  return lines.join("\n");
}
