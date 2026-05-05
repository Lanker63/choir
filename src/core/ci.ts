import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { z } from "zod";
import { DecisionTrace, readAuditStore, recordAudit } from "./audit.js";
import { buildWorkspaceSnapshot, WorkspaceSnapshot } from "./context.js";
import { controlPlaneToChoirConfig, hashConfig } from "./dslYamlCompiler.js";
import { ExecutionPreview, generateExecutionPreview } from "./executionPreview.js";
import { Fix, Patch, isTextPatch } from "../fix/types.js";
import { runMacro } from "./macros.js";
import { generatePlan } from "./orchestration.js";
import {
  computeDiff,
  detectEnvironment,
  Environment,
  evaluatePolicies,
  ExecutionContext,
  hashDiff,
} from "./policyEngine.js";
import { runPipeline } from "./pipeline.js";
import { loadPolicies } from "./policyDsl.js";
import {
  buildExecutionPlan,
  runExecutionPlanTransactionally,
  TransactionEnforcer,
  TransactionPipeline,
} from "./scheduler.js";
import { hasApprovalForDiff, listPendingApprovals, readStatePlane } from "./state.js";
import { Diagnostic } from "./types.js";
import { ControlPlane, ControlPlaneSchema, Plan } from "../schema.js";

export type PipelineStage =
  | "source"
  | "compile"
  | "plan"
  | "policy"
  | "preview"
  | "execute"
  | "audit";

export type Pipeline = {
  stages: PipelineStage[];
};

export const PIPELINE: PipelineStage[] = [
  "source",
  "compile",
  "plan",
  "policy",
  "preview",
  "execute",
  "audit",
];

export type CIEnvironmentPolicy = {
  enforcePolicy: boolean;
  requireApproval: boolean;
};

export type ChoirCIConfig = {
  pipeline: Pipeline;
  environments: Partial<Record<Environment, CIEnvironmentPolicy>>;
  macros: string[];
};

export type CIPipelineTrace = {
  commitId: string;
  stagesExecuted: PipelineStage[];
  policyDecision: string;
  macrosRun: string[];
  result: "success" | "failure";
};

export type CIStageResult = {
  stage: PipelineStage;
  status: "success" | "failure" | "skipped";
  detail: string;
};

export type CIRunResult = {
  trace: CIPipelineTrace;
  stageResults: CIStageResult[];
  artifacts: string[];
  policy: {
    decision: "allow" | "require-approval" | "deny";
    requiresApproval: boolean;
    allowed: boolean;
  };
};

export type RunCIOptions = {
  root: string;
  controlPlane: ControlPlane;
  controlPath: string;
  context: ExecutionContext;
  actorId?: string;
};

const PIPELINE_STAGE_SCHEMA = z.enum(["source", "compile", "plan", "policy", "preview", "execute", "audit"]);
const MACRO_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

const CI_ENV_POLICY_SCHEMA = z.object({
  enforcePolicy: z.boolean().default(true),
  requireApproval: z.boolean().default(true),
}).strict();

const CI_CONFIG_SCHEMA = z.object({
  pipeline: z.object({
    stages: z.array(PIPELINE_STAGE_SCHEMA).default(PIPELINE),
  }).default({ stages: PIPELINE }),
  environments: z.object({
    local: CI_ENV_POLICY_SCHEMA.optional(),
    ci: CI_ENV_POLICY_SCHEMA.optional(),
    staging: CI_ENV_POLICY_SCHEMA.optional(),
    production: CI_ENV_POLICY_SCHEMA.optional(),
  }).default({}),
  macros: z.array(z.string().regex(MACRO_ID_PATTERN)).default([]),
}).strict();

const DEFAULT_ENVIRONMENT_POLICY: Record<Environment, CIEnvironmentPolicy> = {
  local: {
    enforcePolicy: true,
    requireApproval: false,
  },
  ci: {
    enforcePolicy: true,
    requireApproval: true,
  },
  staging: {
    enforcePolicy: true,
    requireApproval: true,
  },
  production: {
    enforcePolicy: true,
    requireApproval: true,
  },
};

function ciConfigPath(root: string): string {
  return path.join(root, ".choir", "ci.yaml");
}

function ciCachePath(root: string): string {
  return path.join(root, ".choir", "ci.cache.json");
}

function readTextIfExists(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return "";
  }

  return fs.readFileSync(filePath, "utf-8");
}

function normalizeStages(stages: PipelineStage[]): PipelineStage[] {
  const deduped: PipelineStage[] = [];
  const seen = new Set<PipelineStage>();

  for (const stage of stages) {
    if (seen.has(stage)) {
      continue;
    }

    deduped.push(stage);
    seen.add(stage);
  }

  if (deduped.length === 0) {
    return [...PIPELINE];
  }

  let previousOrder = -1;
  for (const stage of deduped) {
    const currentOrder = PIPELINE.indexOf(stage);
    if (currentOrder < 0) {
      throw new Error(`Unsupported pipeline stage: ${stage}`);
    }

    if (currentOrder < previousOrder) {
      throw new Error("Pipeline stages must follow canonical order: source -> compile -> plan -> policy -> preview -> execute -> audit");
    }

    previousOrder = currentOrder;
  }

  return deduped;
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function normalizeCIConfig(raw: ChoirCIConfig): ChoirCIConfig {
  const parsed = CI_CONFIG_SCHEMA.parse(raw);

  return {
    pipeline: {
      stages: normalizeStages(parsed.pipeline.stages),
    },
    environments: parsed.environments,
    macros: sortedUnique(parsed.macros),
  };
}

function parseCIConfigDocument(raw: string): ChoirCIConfig {
  const parsed = YAML.parse(raw);
  return normalizeCIConfig(parsed ?? {});
}

export function loadCIConfig(root: string): ChoirCIConfig {
  const configPath = ciConfigPath(root);
  if (!fs.existsSync(configPath)) {
    return normalizeCIConfig({
      pipeline: {
        stages: [...PIPELINE],
      },
      environments: {},
      macros: [],
    });
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  return parseCIConfigDocument(raw);
}

function resolveEnvironmentPolicy(config: ChoirCIConfig, environment: Environment): CIEnvironmentPolicy {
  const configured = config.environments[environment];
  const fallback = DEFAULT_ENVIRONMENT_POLICY[environment];

  return {
    enforcePolicy: configured?.enforcePolicy ?? fallback.enforcePolicy,
    requireApproval: configured?.requireApproval ?? fallback.requireApproval,
  };
}

function loadControlPlaneFromDisk(controlPath: string): ControlPlane {
  if (!fs.existsSync(controlPath)) {
    throw new Error(`Control plane not found: ${controlPath}`);
  }

  const raw = fs.readFileSync(controlPath, "utf-8");
  const parsed = YAML.parse(raw);
  return ControlPlaneSchema.parse(parsed);
}

function toDecisionTrace(
  policyTrace: {
    policyDslTrace: Array<{
      policyId: string;
      source: "org" | "repo" | "environment";
      matched: boolean;
      effect: "allow" | "require-approval" | "deny";
    }>;
    decision: "allow" | "require-approval" | "deny";
  },
  reasoning: string
): DecisionTrace {
  return {
    policiesEvaluated: [...policyTrace.policyDslTrace]
      .map((entry) => ({
        policyId: entry.policyId,
        source: entry.source,
        matched: entry.matched,
        effect: entry.effect,
      }))
      .sort((left, right) =>
        left.source.localeCompare(right.source)
        || left.policyId.localeCompare(right.policyId)
      ),
    finalDecision: policyTrace.decision,
    reasoning,
  };
}

function detectCommitId(root: string): string {
  const environmentCandidates = [
    process.env.GITHUB_SHA,
    process.env.CI_COMMIT_SHA,
    process.env.BUILD_SOURCEVERSION,
    process.env.SOURCE_VERSION,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);

  if (environmentCandidates.length > 0) {
    return environmentCandidates[0] as string;
  }

  const payload = [
    [".choir/choir.config.yaml", readTextIfExists(path.join(root, ".choir", "choir.config.yaml"))],
    [".choir/policies.dsl", readTextIfExists(path.join(root, ".choir", "policies.dsl"))],
    [".choir/lock.yaml", readTextIfExists(path.join(root, ".choir", "lock.yaml"))],
    [".choir/ci.yaml", readTextIfExists(path.join(root, ".choir", "ci.yaml"))],
  ]
    .map(([file, content]) => `${file}\n${content}`)
    .join("\n---\n");

  return createHash("sha256").update(payload).digest("hex");
}

function artifactRoot(root: string, commitId: string): string {
  const key = createHash("sha256").update(commitId).digest("hex").slice(0, 16);
  return path.join(root, ".choir", "artifacts", "ci", key);
}

function writeArtifact(root: string, relativePath: string, content: string): string {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
  return relativePath.split(path.sep).join("/");
}

function writeJSONArtifact(root: string, relativePath: string, value: unknown): string {
  return writeArtifact(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function mergeExecutionPlan(control: ControlPlane, plan: Plan): ControlPlane {
  const approvedPlan: Plan = {
    ...plan,
    status: "approved",
  };

  const nextPlans = [
    ...control.execution.plans.filter((entry) => entry.id !== approvedPlan.id),
    approvedPlan,
  ].sort((left, right) => left.id.localeCompare(right.id));

  return {
    ...control,
    execution: {
      ...control.execution,
      plans: nextPlans,
    },
  };
}

function selectedPreviewDiff(preview: ExecutionPreview): string {
  if (preview.fileChanges.length === 0) {
    return "# No file changes in preview\n";
  }

  return `${preview.fileChanges.map((change) => change.diff).join("\n\n")}\n`;
}

function readCICache(root: string): { inputHash: string } | null {
  const cachePath = ciCachePath(root);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as { inputHash?: unknown };
    if (typeof parsed.inputHash !== "string" || parsed.inputHash.trim().length === 0) {
      return null;
    }

    return { inputHash: parsed.inputHash };
  } catch {
    return null;
  }
}

function writeCICache(root: string, inputHash: string): void {
  const cachePath = ciCachePath(root);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify({ inputHash }, null, 2)}\n`, "utf-8");
}

function computeCIInputHash(root: string, control: ControlPlane, macros: string[]): string {
  const payload = JSON.stringify({
    controlHash: hashConfig(controlPlaneToChoirConfig(control)),
    policies: readTextIfExists(path.join(root, ".choir", "policies.dsl")),
    lockfile: readTextIfExists(path.join(root, ".choir", "lock.yaml")),
    macros,
  });

  return createHash("sha256").update(payload).digest("hex");
}

function validateEnvironmentContext(context: ExecutionContext): void {
  const detected = detectEnvironment();
  if (detected !== context.environment) {
    throw new Error(`Environment spoofing blocked: context=${context.environment}, detected=${detected}`);
  }
}

function stageIncluded(config: ChoirCIConfig, stage: PipelineStage): boolean {
  return config.pipeline.stages.includes(stage);
}

function emptyDecisionTrace(reasoning: string, decision: "allow" | "require-approval" | "deny"): DecisionTrace {
  return {
    policiesEvaluated: [],
    finalDecision: decision,
    reasoning,
  };
}

function expectValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }

  return value;
}

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function toRelativePath(root: string, value: string): string {
  const normalized = normalizePath(value);
  if (!path.isAbsolute(value)) {
    return normalized;
  }

  const relative = normalizePath(path.relative(root, value));
  if (relative.startsWith("../") || relative === "..") {
    throw new Error(`CI transaction cannot include paths outside workspace root: ${value}`);
  }

  return relative;
}

function clonePatch(root: string, patch: Patch): Patch {
  if (isTextPatch(patch)) {
    return {
      ...patch,
      location: {
        ...patch.location,
        file: toRelativePath(root, patch.location.file),
      },
    };
  }

  if (patch.type === "create-file" || patch.type === "delete-file") {
    return {
      ...patch,
      file: toRelativePath(root, patch.file),
    };
  }

  return {
    ...patch,
    from: toRelativePath(root, patch.from),
    to: toRelativePath(root, patch.to),
  };
}

function cloneFix(root: string, fix: Fix): Fix {
  return {
    ...fix,
    patches: fix.patches.map((patch) => clonePatch(root, patch)),
  };
}

function normalizeDiagnostic(root: string, diagnostic: Diagnostic): Diagnostic {
  return {
    ...diagnostic,
    location: {
      ...diagnostic.location,
      file: toRelativePath(root, diagnostic.location.file),
    },
    ...(diagnostic.related
      ? {
        related: diagnostic.related.map((entry) => ({
          ...entry,
          location: {
            ...entry.location,
            file: toRelativePath(root, entry.location.file),
          },
        })),
      }
      : {}),
  };
}

function patchFiles(patch: Patch): string[] {
  if (isTextPatch(patch)) {
    return [normalizePath(patch.location.file)];
  }

  if (patch.type === "create-file" || patch.type === "delete-file") {
    return [normalizePath(patch.file)];
  }

  return [normalizePath(patch.from), normalizePath(patch.to)];
}

function overlapsWithBatchFiles(fix: Fix, batchFiles: Set<string>): boolean {
  const files = fix.patches.flatMap((patch) => patchFiles(patch));
  return files.some((file) => batchFiles.has(file));
}

function includeFixDependencies(fixes: Fix[]): Fix[] {
  const byId = new Map(fixes.map((fix) => [fix.id, fix] as const));
  const selected = new Map<string, Fix>();

  const visit = (fix: Fix): void => {
    if (selected.has(fix.id)) {
      return;
    }

    selected.set(fix.id, fix);
    for (const dependencyId of fix.dependsOn ?? []) {
      const dependency = byId.get(dependencyId);
      if (dependency) {
        visit(dependency);
      }
    }
  };

  fixes.forEach((fix) => visit(fix));
  return [...selected.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function toRelativeFilesMap(root: string, snapshot: WorkspaceSnapshot): Record<string, string> {
  const entries: Array<[string, string]> = snapshot.files.map((file) => [
    toRelativePath(root, file.path),
    file.content,
  ]);

  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function buildSnapshotFromFiles(root: string, files: Record<string, string>): WorkspaceSnapshot {
  const tsFiles = Object.keys(files)
    .filter((file) => file.endsWith(".ts"))
    .sort((left, right) => left.localeCompare(right))
    .map((file) => ({
      path: path.resolve(root, file),
      content: files[file] as string,
    }));

  return {
    root,
    files: tsFiles,
  };
}

function createCIEnforcer(root: string, controlPlane: ControlPlane): TransactionEnforcer {
  return {
    async proposeFixes(workUnits) {
      const workspace = buildWorkspaceSnapshot(root);
      const pipelineResult = await runPipeline({
        controlPlane,
        workspace,
        persistState: false,
      });

      const allFixes = pipelineResult.fixes
        .map((fix) => cloneFix(root, fix))
        .sort((left, right) => left.id.localeCompare(right.id));
      const allDiagnostics = pipelineResult.diagnostics
        .map((diagnostic) => normalizeDiagnostic(root, diagnostic))
        .sort((left, right) => left.id.localeCompare(right.id));

      const batchFiles = new Set(sortedUnique(workUnits.flatMap((unit) => unit.files.map((file) => normalizePath(file)))));
      if (batchFiles.size === 0) {
        return {
          fixes: [],
          diagnostics: [],
        };
      }

      const candidateFixes = allFixes.filter((fix) => overlapsWithBatchFiles(fix, batchFiles));
      const fixes = includeFixDependencies(candidateFixes);
      const diagnosticIds = new Set(fixes.flatMap((fix) => fix.diagnosticIds));
      const diagnostics = allDiagnostics.filter((diagnostic) => diagnosticIds.has(diagnostic.id));

      return {
        fixes,
        diagnostics,
      };
    },
  };
}

function createCIPipeline(root: string, controlPlane: ControlPlane): TransactionPipeline {
  return {
    async run(input) {
      const diskSnapshot = buildWorkspaceSnapshot(root);
      const diskFiles = toRelativeFilesMap(root, diskSnapshot);

      const mergedFiles = {
        ...diskFiles,
        ...input.fs.files,
      };

      for (const file of input.transaction.touchedFiles) {
        if (!Object.prototype.hasOwnProperty.call(input.fs.files, file)) {
          delete mergedFiles[file];
        }
      }

      const workspace = buildSnapshotFromFiles(root, mergedFiles);
      const pipelineResult = await runPipeline({
        controlPlane,
        workspace,
        persistState: false,
      });

      return {
        diagnostics: pipelineResult.diagnostics
          .map((diagnostic) => normalizeDiagnostic(root, diagnostic))
          .sort((left, right) => left.id.localeCompare(right.id)),
        conflicts: pipelineResult.conflicts,
      };
    },
  };
}

function summarizeTransactionFailures(
  transactions: Array<{ id: string; batchId: string; status: string; validation: { errors?: string[] } }>
): string | null {
  const failed = transactions.filter((transaction) => transaction.status !== "committed");
  if (failed.length === 0) {
    return null;
  }

  const details = failed.map((transaction) => {
    const errors = transaction.validation.errors ?? [];
    const suffix = errors.length > 0 ? ` (${errors.join(" | ")})` : "";
    return `${transaction.batchId}:${transaction.status}${suffix}`;
  });

  return `Transactional execution failed: ${details.join(", ")}`;
}

export async function runCI(options: RunCIOptions): Promise<CIRunResult> {
  validateEnvironmentContext(options.context);

  const config = loadCIConfig(options.root);
  const commitId = detectCommitId(options.root);
  const artifactBase = artifactRoot(options.root, commitId);
  const environmentPolicy = resolveEnvironmentPolicy(config, options.context.environment);

  const stageResults: CIStageResult[] = [];
  const stagesExecuted: PipelineStage[] = [];
  const artifacts: string[] = [];
  const macrosRun: string[] = [];

  let result: "success" | "failure" = "success";
  let policyDecision: "allow" | "require-approval" | "deny" = "allow";
  let policyRequiresApproval = false;
  let policyAllowed = true;

  let workingControl = options.controlPlane;
  let planned: Plan | null = null;
  let executionControl: ControlPlane | null = null;
  let preview: ExecutionPreview | null = null;

  const inputHash = computeCIInputHash(options.root, options.controlPlane, config.macros);
  const ciCache = readCICache(options.root);
  const cacheHit = ciCache?.inputHash === inputHash;

  const markStage = (stage: PipelineStage, status: CIStageResult["status"], detail: string): void => {
    stageResults.push({ stage, status, detail });
    stagesExecuted.push(stage);

    if (status === "failure") {
      result = "failure";
    }
  };

  const failStage = (stage: PipelineStage, detail: string): never => {
    markStage(stage, "failure", detail);
    throw new Error(detail);
  };

  try {
    if (stageIncluded(config, "source")) {
      markStage("source", "success", `Resolved commit identity: ${commitId}`);
    }

    if (stageIncluded(config, "compile")) {
      workingControl = loadControlPlaneFromDisk(options.controlPath);
      markStage("compile", "success", `Control plane validated (hash=${hashConfig(controlPlaneToChoirConfig(workingControl)).slice(0, 12)})`);
    }

    if (stageIncluded(config, "plan")) {
      if (config.macros.length > 0 && cacheHit) {
        markStage("plan", "skipped", "Skipped macro expansion (no relevant control-plane changes)");
      } else {
        for (const macroId of config.macros) {
          const macroResult = runMacro(
            options.root,
            macroId,
            {},
            workingControl,
            options.controlPath,
            {
              workspaceRoot: options.root,
              executionMode: "ci-pipeline",
            }
          );

          macrosRun.push(macroId);

          if (macroResult.decision === "deny") {
            failStage("plan", `Macro denied by policy: ${macroId}`);
          }

          if (macroResult.decision === "require-approval") {
            policyDecision = "require-approval";
            policyRequiresApproval = true;
            failStage("plan", `Macro requires approval: ${macroId}`);
          }

          workingControl = macroResult.updatedControlPlane;
        }
      }

      const workspace = buildWorkspaceSnapshot(options.root);
      await runPipeline({
        controlPlane: workingControl,
        workspace,
      });

      const state = expectValue(
        readStatePlane(options.root),
        "State plane not materialized after pipeline run"
      );

      planned = generatePlan(workingControl, state);
      executionControl = mergeExecutionPlan(workingControl, planned);

      const planArtifact = path.join(path.relative(options.root, artifactBase), "plan.json");
      artifacts.push(writeJSONArtifact(options.root, planArtifact, planned));

      if (!cacheHit || config.macros.length === 0) {
        markStage("plan", "success", `Generated deterministic plan ${planned.id} (${planned.tasks.length} tasks)`);
      }
    }

    if (stageIncluded(config, "policy")) {
      const currentExecutionControl = expectValue(executionControl, "Policy stage requires plan stage output");
      expectValue(planned, "Policy stage requires plan stage output");

      if (!environmentPolicy.enforcePolicy) {
        markStage("policy", "skipped", `Policy checks disabled for environment ${options.context.environment}`);
      } else {
        const policySet = loadPolicies(options.root, options.context.environment);
        const diffs = computeDiff(
          controlPlaneToChoirConfig(workingControl),
          controlPlaneToChoirConfig(currentExecutionControl)
        );

        const policyEvaluation = evaluatePolicies(diffs, policySet, options.context);
        policyDecision = policyEvaluation.trace.decision;
        policyRequiresApproval = policyEvaluation.result.requiresApproval;
        policyAllowed = policyEvaluation.result.allowed;

        const diffSignature = hashDiff(diffs);
        const approved = hasApprovalForDiff(options.root, diffSignature);
        const pendingApprovals = listPendingApprovals(options.root);

        if (!policyEvaluation.result.allowed) {
          failStage("policy", `Policy denied CI plan execution (diffHash=${diffSignature})`);
        }

        if (policyEvaluation.result.requiresApproval && !approved) {
          failStage("policy", `Approval missing for CI execution diff (diffHash=${diffSignature})`);
        }

        if (environmentPolicy.requireApproval && pendingApprovals.length > 0) {
          failStage("policy", `Pending approvals block pipeline (${pendingApprovals.length} pending)`);
        }

        recordAudit(options.root, {
          auditEvent: {
            id: "",
            timestamp: "",
            actor: {
              role: options.context.role,
              ...(options.actorId ? { id: options.actorId } : {}),
            },
            environment: options.context.environment,
            action: "ci-policy-gate",
            resource: ".choir/policies.dsl",
            diff: diffs,
            result: "success",
            metadata: {
              commitId,
              diffHash: diffSignature,
            },
          },
          decisionTrace: toDecisionTrace(
            policyEvaluation.trace,
            `CI policy gate decision=${policyEvaluation.trace.decision} matched=${policyEvaluation.trace.rulesMatched.length}`
          ),
        });

        markStage("policy", "success", `Policy decision=${policyEvaluation.trace.decision} (diffHash=${diffSignature.slice(0, 12)})`);
      }
    }

    if (stageIncluded(config, "preview")) {
      const currentExecutionControl = expectValue(executionControl, "Preview stage requires plan stage output");
      const currentPlan = expectValue(planned, "Preview stage requires plan stage output");

      preview = await generateExecutionPreview(currentPlan, {
        root: options.root,
        controlPlane: currentExecutionControl,
        state: readStatePlane(options.root) ?? undefined,
      });

      const previewJsonArtifact = path.join(path.relative(options.root, artifactBase), "preview.json");
      const previewDiffArtifact = path.join(path.relative(options.root, artifactBase), "preview.diff");
      artifacts.push(writeJSONArtifact(options.root, previewJsonArtifact, preview));
      artifacts.push(writeArtifact(options.root, previewDiffArtifact, selectedPreviewDiff(preview)));

      markStage("preview", "success", `Preview generated (hash=${preview.hash.slice(0, 12)})`);
    }

    if (stageIncluded(config, "execute")) {
      const currentExecutionControl = expectValue(executionControl, "Execute stage requires plan stage output");
      const currentPlan = expectValue(planned, "Execute stage requires plan stage output");

      if (!preview) {
        preview = await generateExecutionPreview(currentPlan, {
          root: options.root,
          controlPlane: currentExecutionControl,
          state: readStatePlane(options.root) ?? undefined,
        });
      }

      const recomputedPreview = await generateExecutionPreview(currentPlan, {
        root: options.root,
        controlPlane: currentExecutionControl,
        state: readStatePlane(options.root) ?? undefined,
      });

      if (recomputedPreview.hash !== preview.hash) {
        failStage("execute", "Preview hash mismatch. Workspace or control plane changed; rerun preview before execute.");
      }

      const built = buildExecutionPlan([currentPlan]);
      const executed = await runExecutionPlanTransactionally(built.executionPlan, {
        root: options.root,
        controlPlane: currentExecutionControl,
        enforcer: createCIEnforcer(options.root, currentExecutionControl),
        pipeline: createCIPipeline(options.root, currentExecutionControl),
        executeLayersInParallel: false,
      });

      const failure = summarizeTransactionFailures(executed.transactions);
      if (failure) {
        failStage("execute", failure);
      }

      const executionArtifact = path.join(path.relative(options.root, artifactBase), "execution.json");
      artifacts.push(writeJSONArtifact(options.root, executionArtifact, {
        previewHash: preview.hash,
        transactions: executed.transactions.map((transaction) => ({
          id: transaction.id,
          batchId: transaction.batchId,
          status: transaction.status,
          validationPassed: transaction.validation.passed,
        })),
      }));

      markStage("execute", "success", `Transactional execution committed (${executed.transactions.length} transaction(s))`);
    }

    if (stageIncluded(config, "audit")) {
      const store = readAuditStore(options.root);
      const auditLog = readTextIfExists(path.join(options.root, ".choir", "audit.log.jsonl"));

      const auditLogArtifact = path.join(path.relative(options.root, artifactBase), "audit.log");
      const auditSummaryArtifact = path.join(path.relative(options.root, artifactBase), "audit-summary.json");
      artifacts.push(writeArtifact(options.root, auditLogArtifact, auditLog));
      artifacts.push(writeJSONArtifact(options.root, auditSummaryArtifact, {
        totalRecords: store.records.length,
      }));

      markStage("audit", "success", `Captured ${store.records.length} audit record(s)`);
    }
  } catch {
    result = "failure";
  }

  const trace: CIPipelineTrace = {
    commitId,
    stagesExecuted,
    policyDecision,
    macrosRun,
    result,
  };

  const traceArtifact = path.join(path.relative(options.root, artifactBase), "trace.json");
  artifacts.push(writeJSONArtifact(options.root, traceArtifact, trace));

  if (result === "success") {
    writeCICache(options.root, inputHash);
  }

  const finalDecision = result === "success"
    ? "allow"
    : (policyDecision === "require-approval" ? "require-approval" : "deny");

  recordAudit(options.root, {
    auditEvent: {
      id: "",
      timestamp: "",
      actor: {
        role: options.context.role,
        ...(options.actorId ? { id: options.actorId } : {}),
      },
      environment: options.context.environment,
      action: "ci-pipeline",
      resource: ".choir/ci.yaml",
      result: result === "success" ? "success" : "failure",
      metadata: {
        commitId,
        stagesExecuted,
        artifacts,
        macrosRun,
      },
    },
    decisionTrace: result === "success"
      ? emptyDecisionTrace("CI pipeline completed successfully", "allow")
      : emptyDecisionTrace(`CI pipeline failed with policy decision ${policyDecision}`, finalDecision),
  });

  return {
    trace,
    stageResults,
    artifacts,
    policy: {
      decision: policyDecision,
      requiresApproval: policyRequiresApproval,
      allowed: policyAllowed,
    },
  };
}

export function formatCIRunResult(result: CIRunResult): string {
  const stageLines = result.stageResults.map((stage) => {
    if (stage.status === "success") {
      return `[ok] ${stage.stage}`;
    }

    if (stage.status === "skipped") {
      return `[skip] ${stage.stage}`;
    }

    return `[fail] ${stage.stage}`;
  });

  return [
    "Choir CI Result:",
    "",
    ...stageLines,
    "",
    `Policy: ${result.policy.decision}`,
    `Result: ${result.trace.result}`,
    "",
    "Artifacts:",
    ...(result.artifacts.length > 0
      ? result.artifacts.map((artifact) => `- ${artifact}`)
      : ["- none"]),
  ].join("\n");
}
