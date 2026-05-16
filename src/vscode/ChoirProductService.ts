import fs from "fs";
import path from "path";
import * as vscode from "vscode";
import {
  exportReport,
  generateReport,
  queryAudit,
} from "../core/audit.js";
import {
  parseCommand,
} from "../core/choirRouter.js";
import {
  formatAbstractionRunResult,
  listAbstractions,
  runAbstraction,
} from "../core/abstractions.js";
import {
  formatCIRunResult,
  runCI,
} from "../core/ci.js";
import {
  runOrchestrationPipeline,
} from "../core/orchestrationRuntime.js";
import {
  compileDSLAndWrite,
  controlPlaneToChoirConfig,
  policyStatus,
  approveDiff,
  rejectDiff,
} from "../core/dslYamlCompiler.js";
import {
  importLibrary,
  installLibrary,
  listLibraryCatalog,
  loadMacroLibrary,
  lockChoirLibraries,
  parseLibraryFailure,
  readLibraryLock,
  readMacroLock,
  updateLibrary,
} from "../core/macroLibraries.js";
import {
  getMacro,
  listMacros,
  runMacro,
} from "../core/macros.js";
import {
  buildStateTimeline,
  createEmptyStatePlane,
  jumpTo,
  readStatePlane,
  stepBackward,
  stepForward,
} from "../core/state.js";
import {
  detectEnvironment,
} from "../core/policyEngine.js";
import { getProductionSnapshot } from "../core/productionReadiness.js";
import { readLatestOrchestrationTrace } from "../core/orchestrationRuntimeTrace.js";
import type { Role } from "../core/policyEngine.js";
import {
  formatDSL,
  generateDSL,
  validateRoundTrip,
  writeDSL,
} from "../core/yamlDslGenerator.js";
import {
  getControlPlanePath,
  readControlPlane,
} from "../choirManager.js";
import type {
  AuditView,
  Dashboard,
  DiffView,
  MacroUI,
  PlanView,
  PolicyView,
  ProductActionRequest,
  ProductActionResult,
  ProductSnapshot,
  RoleView,
  StateDiff,
  StateInspector,
  UIError,
  TimelineReplayTrace,
  UITrace,
  UISurface,
  WorkflowState,
  WorkflowStep,
} from "../ui/contracts.js";

const WORKFLOW_ORDER: WorkflowStep[] = [
  "define-intent",
  "plan",
  "preview",
  "approve",
  "execute",
  "audit",
];

const ROLE_VIEW: RoleView = {
  architect: ["intent", "policy"],
  analyst: ["analysis", "audit"],
  conductor: ["plan", "workflow"],
  enforcer: ["execution"],
};

const SURFACES_BY_ROLE: Record<Role, UISurface[]> = {
  architect: ["dashboard", "workspace", "timeline-view", "policy-view", "audit-view", "macro-library"],
  analyst: ["dashboard", "workspace", "timeline-view", "audit-view", "plan-view"],
  conductor: ["dashboard", "workspace", "plan-view", "timeline-view", "policy-view", "audit-view", "macro-library"],
  enforcer: ["dashboard", "workspace", "plan-view", "timeline-view", "audit-view"],
};

const WORKFLOW_PERMISSIONS: Record<Role, WorkflowStep[]> = {
  architect: ["define-intent", "approve", "audit"],
  analyst: ["audit"],
  conductor: ["define-intent", "plan", "preview", "approve", "audit"],
  enforcer: ["execute", "audit"],
};

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0))).sort((left, right) => left.localeCompare(right));
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function escapeDSLString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function parseRole(value: string | undefined): Role | undefined {
  if (value === "architect" || value === "analyst" || value === "conductor" || value === "enforcer") {
    return value;
  }

  return undefined;
}

function parseEnvironment(value: string | undefined): "local" | "ci" | "staging" | "production" | undefined {
  if (value === "local" || value === "ci" || value === "staging" || value === "production") {
    return value;
  }

  return undefined;
}

function capabilityGraphFile(root: string): string {
  return path.join(root, ".choir", "capability-graph.json");
}

function toPlanView(plan: { id: string; tasks: Array<{ title: string; scope?: { files?: string[] } }> }): PlanView {
  const affectedFiles = sortedUnique(
    plan.tasks.flatMap((task) => task.scope?.files ?? [])
  );

  return {
    planId: plan.id,
    tasks: plan.tasks.map((task) => task.title),
    affectedFiles,
    estimatedImpact: plan.tasks.length + affectedFiles.length,
  };
}

function toUIError(message: string): UIError {
  const normalized = message.toLowerCase();

  if (normalized.includes("policy") || normalized.includes("approval")) {
    return {
      message,
      source: "policy",
    };
  }

  if (normalized.includes("execute") || normalized.includes("preview") || normalized.includes("pipeline")) {
    return {
      message,
      source: "execution",
    };
  }

  return {
    message,
    source: "validation",
  };
}

export class ChoirProductService {
  private traces: UITrace[] = [];
  private lastPreviewDiffs: DiffView[] = [];
  private lastWorkflowAction = "";
  private replayIndex = -1;
  private replayPlaying = false;
  private replayTrace: TimelineReplayTrace | undefined;

  constructor(_context: vscode.ExtensionContext) {}

  private fallbackSnapshot(role: Role, reason?: string): ProductSnapshot {
    const fallbackState = createEmptyStatePlane();
    const recommendation = reason && reason.trim().length > 0
      ? `Control Center fallback mode: ${reason}`
      : "Control Center fallback mode: snapshot generation failed.";

    let controlPlane: object = {};
    try {
      const control = readControlPlane();
      if (control) {
        controlPlane = controlPlaneToChoirConfig(control);
      }
    } catch (_error) {
      // Keep fallback resilient even when control plane parsing fails.
    }

    return {
      generatedAt: new Date().toISOString(),
      activeRole: role,
      availableSurfaces: SURFACES_BY_ROLE[role],
      dashboard: {
        systemHealth: "needs-attention",
        activePlans: 0,
        policyViolations: 0,
        recentActions: [],
        recommendations: [recommendation],
      },
      workflow: {
        current: "define-intent",
        completed: [],
        pending: ["plan", "preview", "approve", "execute", "audit"],
      },
      planView: [],
      diffView: [],
      policyView: [{
        decision: "allow",
        rulesMatched: [],
        source: "repo",
      }],
      auditView: {
        events: [],
        filters: {},
      },
      macroUI: {
        libraries: [],
        macros: [],
        abstractions: [],
      },
      roleView: ROLE_VIEW,
      pendingApprovals: [],
      traces: [...this.traces].reverse(),
      controlPlane,
      timeline: {
        currentIndex: -1,
        canStepForward: false,
        canStepBackward: false,
        playing: false,
        states: [],
      },
      stateInspector: this.buildStateInspector(
        fallbackState,
        [recommendation],
        []
      ),
    };
  }

  private async buildSnapshotOrFallback(
    role: Role,
    filters?: { role?: string; environment?: string },
    reason?: string
  ): Promise<ProductSnapshot> {
    try {
      return await this.buildSnapshot(role, filters);
    } catch (error) {
      const message = reason
        ?? (error instanceof Error ? error.message : String(error));
      return this.fallbackSnapshot(role, message);
    }
  }

  private getWorkspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return null;
    }

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
      const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
      if (activeFolder) {
        return activeFolder.uri.fsPath;
      }
    }

    return folders[0]?.uri.fsPath ?? null;
  }

  private requireControlContext(): { root: string; controlPath: string; control: NonNullable<ReturnType<typeof readControlPlane>> } {
    const root = this.getWorkspaceRoot();
    if (!root) {
      throw new Error("No workspace folder found.");
    }

    const control = readControlPlane();
    if (!control) {
      throw new Error("No control plane found. Open a workspace folder first.");
    }

    const controlPath = getControlPlanePath();
    if (!controlPath) {
      throw new Error("Unable to resolve .choir/choir.config.yaml.");
    }

    return {
      root,
      control,
      controlPath,
    };
  }

  private createTrace(action: string, resultingDSL: string, resultingYAML: object): UITrace {
    return {
      action,
      resultingDSL,
      resultingYAML,
    };
  }

  private pushTrace(trace: UITrace): void {
    this.traces.push(trace);
    if (this.traces.length > 50) {
      this.traces = this.traces.slice(this.traces.length - 50);
    }
  }

  private inferWorkflowState(snapshot: {
    hasIntent: boolean;
    hasPlans: boolean;
    hasPreview: boolean;
    hasApprovedPlan: boolean;
    hasExecutionEvents: boolean;
  }): WorkflowState {
    let current: WorkflowStep = "audit";

    if (!snapshot.hasIntent) {
      current = "define-intent";
    } else if (!snapshot.hasPlans) {
      current = "plan";
    } else if (!snapshot.hasPreview) {
      current = "preview";
    } else if (!snapshot.hasApprovedPlan) {
      current = "approve";
    } else if (!snapshot.hasExecutionEvents) {
      current = "execute";
    }

    const currentIndex = WORKFLOW_ORDER.indexOf(current);
    return {
      current,
      completed: WORKFLOW_ORDER.slice(0, currentIndex),
      pending: WORKFLOW_ORDER.slice(currentIndex + 1),
      ...(this.lastWorkflowAction ? { lastAction: this.lastWorkflowAction } : {}),
    };
  }

  private buildDashboard(data: {
    activePlans: number;
    policyViolations: number;
    recentActions: Dashboard["recentActions"];
    pendingApprovals: number;
    hasApprovedPlan: boolean;
  }): Dashboard {
    const recommendations: string[] = [];

    if (data.policyViolations > 0) {
      recommendations.push(`${data.policyViolations} policy denials need review.`);
    }

    if (data.pendingApprovals > 0) {
      recommendations.push(`${data.pendingApprovals} pending approvals require explicit decision.`);
    }

    if (!data.hasApprovedPlan && data.activePlans > 0) {
      recommendations.push("Preview the current draft plan, then approve it before execution.");
    }

    if (data.activePlans === 0) {
      recommendations.push("Define intent and generate a plan to start the workflow.");
    }

    if (data.recentActions.length === 0) {
      recommendations.push("No audit events yet. Run a workflow step to initialize traceability.");
    }

    const systemHealth = data.policyViolations > 0
      ? "needs-attention"
      : (data.pendingApprovals > 0 ? "approval-pending" : "stable");

    return {
      systemHealth,
      activePlans: data.activePlans,
      policyViolations: data.policyViolations,
      recentActions: data.recentActions,
      recommendations: recommendations.slice(0, 5),
    };
  }

  private buildPolicyView(root: string): PolicyView[] {
    const records = queryAudit(root, { action: "policy-evaluation" });
    if (records.length === 0) {
      return [
        {
          decision: "allow",
          rulesMatched: [],
          source: "repo",
        },
      ];
    }

    const views = records.slice(-8).map((record) => {
      const matched = record.decisionTrace.policiesEvaluated.filter((entry) => entry.matched);
      const source = matched[0]?.source ?? record.decisionTrace.policiesEvaluated[0]?.source ?? "repo";
      return {
        decision: record.decisionTrace.finalDecision,
        rulesMatched: sortedUnique(matched.map((entry) => entry.policyId)),
        source,
      } satisfies PolicyView;
    });

    return views.reverse();
  }

  private buildMacroUI(root: string): MacroUI {
    const catalog = listLibraryCatalog(root);
    const lock = readMacroLock(root);
    const choirLock = readLibraryLock(root);

    const libraryMacros = Object.entries(lock.libraries)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([library, version]) => {
        const loaded = loadMacroLibrary(root, library, version);
        return loaded.macros.map((macro) => `${library}.${macro.id}`);
      });

    const localMacros = listMacros(root).map((macro) => `local.${macro.id}`);
    const lockedVersions = Object.entries(choirLock.libraries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([library, entry]) => `${library}@${entry.version}`);

    const graphPath = capabilityGraphFile(root);
    const transitiveDependencies = fs.existsSync(graphPath)
      ? (() => {
        const parsed = JSON.parse(fs.readFileSync(graphPath, "utf-8")) as { dependencies?: Array<{ from: string; to: string; type: string }> };
        return sortedUnique((parsed.dependencies ?? [])
          .filter((edge) => edge.type === "depends-on")
          .map((edge) => `${edge.from} -> ${edge.to}`));
      })()
      : [];

    return {
      libraries: sortedUnique(catalog.map((entry) => entry.id)),
      ...(lockedVersions.length > 0 ? { lockedVersions } : {}),
      ...(transitiveDependencies.length > 0 ? { transitiveDependencies } : {}),
      macros: sortedUnique([...libraryMacros, ...localMacros]),
      abstractions: sortedUnique(listAbstractions(root).map((entry) => entry.id)),
    };
  }

  private buildStateInspector(
    state: ReturnType<typeof createEmptyStatePlane>,
    why: string[],
    dependencyChain: string[]
  ): StateInspector {
    return {
      intent: state.intent,
      ast: state.ast,
      violations: state.ruleViolations,
      plans: state.plans,
      why,
      dependencyChain,
    };
  }

  private snapshotForHash(root: string, hash: string): ReturnType<typeof createEmptyStatePlane> | null {
    if (!hash || hash === "GENESIS") {
      return createEmptyStatePlane();
    }

    const timeline = buildStateTimeline(root);
    const snapshot = timeline.snapshots.find((entry) => entry.hash === hash);
    return snapshot ? snapshot.state : null;
  }

  private buildReplayView(root: string, fallbackState: ReturnType<typeof createEmptyStatePlane>): {
    timeline: ProductSnapshot["timeline"];
    stateInspector: StateInspector;
    stateDiff?: StateDiff;
    replayTrace?: TimelineReplayTrace;
  } {
    const timeline = buildStateTimeline(root);
    const timelineEntries = timeline.transitions.map((transition, index) => ({
      index,
      transitionId: transition.id,
      label: `State ${index + 1}`,
      action: transition.action,
      timestamp: transition.timestamp,
      fromHash: transition.fromHash,
      toHash: transition.toHash,
      ...(transition.metadata ? { metadata: transition.metadata } : {}),
    }));

    if (timelineEntries.length === 0) {
      this.replayIndex = -1;
      this.replayTrace = undefined;
      return {
        timeline: {
          currentIndex: -1,
          canStepForward: false,
          canStepBackward: false,
          playing: false,
          states: [],
        },
        stateInspector: this.buildStateInspector(
          fallbackState,
          ["No transitions recorded yet."],
          []
        ),
      };
    }

    this.replayIndex = Math.max(0, Math.min(this.replayIndex < 0 ? timelineEntries.length - 1 : this.replayIndex, timelineEntries.length - 1));
    const replayed = jumpTo(root, this.replayIndex);
    const orchestrationTrace = readLatestOrchestrationTrace(root);
    this.replayTrace = {
      ...replayed.trace,
      ...(orchestrationTrace
        ? {
          planning: {
            traceId: orchestrationTrace.id,
            selectedPlanId: orchestrationTrace.selectedPlanId,
            selectedStrategyType: orchestrationTrace.selectedStrategyType,
            selectedDagHash: orchestrationTrace.orchestrationDagHash,
            rankingOrder: orchestrationTrace.rankingOrder,
            candidates: orchestrationTrace.candidates.map((candidate) => ({
              id: candidate.id,
              strategyType: candidate.strategyType,
              orchestrationDagHash: candidate.orchestrationDagHash,
              ...(typeof candidate.rank === "number" ? { rank: candidate.rank } : {}),
              ...(candidate.selected === true ? { selected: true } : {}),
            })),
          },
        }
        : {}),
    };
    const currentTransition = timeline.transitions[this.replayIndex];
    const metadata = currentTransition?.metadata;

    const why = [
      `Applied transition ${currentTransition.id}`,
      `Action: ${currentTransition.action}`,
      `From ${currentTransition.fromHash} to ${currentTransition.toHash}`,
      ...(metadata?.command ? [`Command: ${metadata.command}`] : []),
      ...(metadata?.policyDecision ? [`Policy decision: ${metadata.policyDecision}`] : []),
      ...(metadata?.auditId ? [`Audit link: ${metadata.auditId}`] : []),
      ...(metadata?.ruleTriggers && metadata.ruleTriggers.length > 0
        ? [`Rule triggers: ${metadata.ruleTriggers.join(", ")}`]
        : []),
    ];

    const dependencyChain = metadata?.dependencyChain ?? [];
    const currentState = replayed.state;

    let stateDiff: StateDiff | undefined;
    if (currentTransition) {
      const beforeState = this.replayIndex > 0
        ? jumpTo(root, this.replayIndex - 1).state
        : this.snapshotForHash(root, currentTransition.fromHash) ?? createEmptyStatePlane();
      stateDiff = {
        before: beforeState,
        after: currentState,
        patches: currentTransition.diff.patches,
      };
    }

    return {
      timeline: {
        currentIndex: this.replayIndex,
        canStepForward: this.replayIndex < timelineEntries.length - 1,
        canStepBackward: this.replayIndex > 0,
        playing: this.replayPlaying,
        states: timelineEntries,
      },
      stateInspector: this.buildStateInspector(currentState, why, dependencyChain),
      ...(stateDiff ? { stateDiff } : {}),
      replayTrace: this.replayTrace,
    };
  }

  async buildSnapshot(
    role: Role,
    filters?: {
      role?: string;
      environment?: string;
    }
  ): Promise<ProductSnapshot> {
    const { root, control } = this.requireControlContext();
    const state = readStatePlane(root) ?? createEmptyStatePlane();

    const roleFilter = parseRole(filters?.role);
    const environmentFilter = parseEnvironment(filters?.environment);

    const auditRecords = queryAudit(root, {
      ...(roleFilter ? { role: roleFilter } : {}),
      ...(environmentFilter ? { environment: environmentFilter } : {}),
    });

    const pending = policyStatus(root).pending;
    const plans = [...control.execution.plans].sort((left, right) => left.id.localeCompare(right.id));

    const hasIntent = control.intent.goals.length > 0 || control.intent.constraints.length > 0 || control.intent["non-goals"].length > 0;
    const hasPlans = plans.length > 0;
    const hasApprovedPlan = plans.some((plan) => plan.status === "approved");
    const hasPreview = typeof state.execution.lastPreview?.hash === "string" && state.execution.lastPreview.hash.length > 0;
    const hasExecutionEvents = state.execution.history.some((entry) => entry.status === "complete" || entry.status === "failed");

    const recentActions = auditRecords.slice(-10).map((record) => record.auditEvent);
    const policyViolations = auditRecords.filter((record) => record.decisionTrace.finalDecision === "deny").length;

    const dashboard = this.buildDashboard({
      activePlans: plans.length,
      policyViolations,
      recentActions,
      pendingApprovals: pending.length,
      hasApprovedPlan,
    });
    const production = getProductionSnapshot(root);

    const auditView: AuditView = {
      events: recentActions,
      filters: {
        ...(roleFilter ? { role: roleFilter } : {}),
        ...(environmentFilter ? { environment: environmentFilter } : {}),
      },
    };
    const replayView = this.buildReplayView(root, state);

    return {
      generatedAt: new Date().toISOString(),
      activeRole: role,
      availableSurfaces: SURFACES_BY_ROLE[role],
      dashboard,
      workflow: this.inferWorkflowState({
        hasIntent,
        hasPlans,
        hasPreview,
        hasApprovedPlan,
        hasExecutionEvents,
      }),
      planView: plans.map((plan) => toPlanView(plan)),
      diffView: this.lastPreviewDiffs,
      policyView: this.buildPolicyView(root),
      auditView,
      macroUI: this.buildMacroUI(root),
      roleView: ROLE_VIEW,
      pendingApprovals: pending,
      production: {
        health: production.health,
        metrics: production.metrics,
        alerts: production.alerts,
        incidents: production.incidents.map((incident) => ({
          id: incident.id,
          cause: incident.cause,
          affectedUnits: incident.affectedUnits,
          resolution: incident.resolution,
        })),
        slos: production.slos,
        failureHotspots: production.failureHotspots,
      },
      traces: [...this.traces].reverse(),
      controlPlane: controlPlaneToChoirConfig(control),
      timeline: replayView.timeline,
      stateInspector: replayView.stateInspector,
      ...(replayView.stateDiff ? { stateDiff: replayView.stateDiff } : {}),
      ...(replayView.replayTrace ? { replayTrace: replayView.replayTrace } : {}),
    };
  }

  private ensureWorkflowPermission(role: Role, step: WorkflowStep): void {
    if (!WORKFLOW_PERMISSIONS[role].includes(step)) {
      throw new Error(`Role ${role} cannot run workflow step ${step}.`);
    }
  }

  private toWorkflowDSL(step: WorkflowStep, payload?: Record<string, string>): string {
    if (step === "define-intent") {
      const intent = clean(payload?.intent);
      if (!intent) {
        throw new Error("Define-intent requires payload.intent.");
      }

      const defineType = payload?.intentType === "constraint" || payload?.intentType === "non-goal"
        ? payload.intentType
        : "goal";

      return `choir define ${defineType} \"${escapeDSLString(intent)}\"`;
    }

    if (step === "plan") {
      const goal = clean(payload?.goal);
      if (goal) {
        return `choir plan for \"${escapeDSLString(goal)}\"`;
      }

      return "choir plan";
    }

    if (step === "preview") {
      const planId = clean(payload?.planId);
      return planId ? `choir preview plan ${planId}` : "choir preview";
    }

    if (step === "approve") {
      const diffId = clean(payload?.diffId);
      if (diffId) {
        return `choir approve ${diffId}`;
      }

      const planId = clean(payload?.planId);
      if (!planId) {
        throw new Error("Approve step requires payload.diffId or payload.planId.");
      }

      return `choir plan approve ${planId}`;
    }

    if (step === "execute") {
      const planId = clean(payload?.planId);
      return planId ? `choir execute plan ${planId}` : "choir execute";
    }

    return "choir audit log";
  }

  private async runDSLCommand(_role: Role, dsl: string): Promise<{ message: string; trace: UITrace }> {
    const { root, control, controlPath } = this.requireControlContext();
    const parsed = parseCommand(dsl);

    if (parsed.ast.type === "preview") {
      const requestedPlanId = parsed.ast.planRef?.identifier;
      const preview = await runOrchestrationPipeline("preview", {
        root,
        controlPlane: control,
        command: dsl,
        ...(requestedPlanId ? { requestedPlanId } : {}),
        persistPreviewState: true,
        recordPendingApproval: true,
      });

      this.lastPreviewDiffs = (preview.preview?.fileChanges ?? []).map((change) => ({
        file: change.file,
        before: change.before,
        after: change.after,
      }));

      const freshControl = readControlPlane() ?? control;
      return {
        message: preview.preview
          ? `Preview generated for ${preview.selectedPlanId} (hash=${preview.preview.previewHash}).`
          : `Preview generated for ${preview.selectedPlanId}.`,
        trace: this.createTrace("workflow.preview", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "execute") {
      const requestedPlanId = parsed.ast.planRef?.identifier;
      const executed = await runOrchestrationPipeline("execute", {
        root,
        controlPlane: control,
        command: dsl,
        ...(requestedPlanId ? { requestedPlanId } : {}),
      });

      const freshControl = readControlPlane() ?? control;
      return {
        message: executed.execute
          ? `Execution completed for ${executed.execute.planId} using transaction ${executed.execute.transactionId}.`
          : `Execution completed for ${executed.selectedPlanId}.`,
        trace: this.createTrace("workflow.execute", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "approve") {
      const approved = approveDiff(root, parsed.ast.diffId, "ui-user");
      const freshControl = readControlPlane() ?? control;
      if (!approved.approved) {
        return {
          message: `Pending diff not found: ${parsed.ast.diffId}`,
          trace: this.createTrace("policy.approve", dsl, controlPlaneToChoirConfig(freshControl)),
        };
      }

      return {
        message: `Approved pending diff ${parsed.ast.diffId}.`,
        trace: this.createTrace("policy.approve", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "reject") {
      const rejected = rejectDiff(root, parsed.ast.diffId);
      const freshControl = readControlPlane() ?? control;
      return {
        message: rejected.removed
          ? `Rejected pending diff ${parsed.ast.diffId}.`
          : `Pending diff not found: ${parsed.ast.diffId}`,
        trace: this.createTrace("policy.reject", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "macro-run") {
      const executed = runMacro(root, parsed.ast.macroId, parsed.ast.args, control, controlPath, {
        workspaceRoot: root,
        executionMode: "interactive",
      });

      const freshControl = readControlPlane() ?? executed.updatedControlPlane;
      return {
        message: `Macro ${parsed.ast.macroId} executed with decision=${executed.decision}.`,
        trace: this.createTrace("macro.run", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "abstraction-run") {
      const executed = runAbstraction(root, parsed.ast.identifier, parsed.ast.args, control, controlPath, {
        workspaceRoot: root,
        actorId: "ui-user",
        executionMode: "interactive",
      });

      const freshControl = readControlPlane() ?? executed.updatedControlPlane;
      return {
        message: formatAbstractionRunResult(executed),
        trace: this.createTrace("abstraction.run", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "graph") {
      const nodeId = clean(parsed.ast.nodeId);
      await vscode.commands.executeCommand("choir.graph.setMode", parsed.ast.mode, nodeId);
      const freshControl = readControlPlane() ?? control;
      return {
        message: nodeId
          ? `Graph view updated (${parsed.ast.mode}) for ${nodeId}.`
          : `Graph view updated (${parsed.ast.mode}).`,
        trace: this.createTrace("graph.view", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "macro-show") {
      const macro = getMacro(root, parsed.ast.macroId);
      const freshControl = readControlPlane() ?? control;
      return {
        message: `Macro ${macro.id} loaded (${macro.body.length} command steps).`,
        trace: this.createTrace("macro.show", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "macro-list") {
      const macros = this.buildMacroUI(root).macros;
      const freshControl = readControlPlane() ?? control;
      return {
        message: `Found ${macros.length} macros.`,
        trace: this.createTrace("macro.list", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "library-list") {
      const libraries = listLibraryCatalog(root);
      const freshControl = readControlPlane() ?? control;
      return {
        message: `Found ${libraries.length} libraries.`,
        trace: this.createTrace("library.list", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "import-library") {
      const spec = `${parsed.ast.library}@${parsed.ast.versionSelector}`;
      const imported = importLibrary(root, spec);
      const freshControl = readControlPlane() ?? control;
      return {
        message: `Library ${imported.library} imported at selector ${imported.selector} (${imported.resolvedVersion}).`,
        trace: this.createTrace("library.import", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "library-install") {
      const spec = `${parsed.ast.library}@${parsed.ast.versionSelector}`;
      const installed = installLibrary(root, spec);
      const freshControl = readControlPlane() ?? control;
      return {
        message: `Library ${installed.library} locked to ${installed.resolvedVersion}.`,
        trace: this.createTrace("library.install", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "library-update") {
      const updated = updateLibrary(root, parsed.ast.library);
      const freshControl = readControlPlane() ?? control;
      return {
        message: `Library ${updated.library} updated to ${updated.resolvedVersion}.`,
        trace: this.createTrace("library.update", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "library-lock") {
      const locked = lockChoirLibraries(root);
      const freshControl = readControlPlane() ?? control;
      return {
        message: `Library lock refreshed (${Object.keys(locked.libraries).length} entries).`,
        trace: this.createTrace("library.lock", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "ci-run") {
      const ciResult = await runCI({
        root,
        controlPlane: control,
        controlPath,
        context: {
          role: "conductor",
          environment: detectEnvironment(),
        },
        actorId: "ui-user",
      });

      const freshControl = readControlPlane() ?? control;
      return {
        message: formatCIRunResult(ciResult),
        trace: this.createTrace("ci.run", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "audit-report") {
      const report = generateReport(root, {});
      const reportsDir = path.join(root, ".choir", "reports");
      fs.mkdirSync(reportsDir, { recursive: true });
      fs.writeFileSync(path.join(reportsDir, "compliance-report.json"), exportReport(report, "json"), "utf-8");
      fs.writeFileSync(path.join(reportsDir, "compliance-report.yaml"), exportReport(report, "yaml"), "utf-8");
      fs.writeFileSync(path.join(reportsDir, "compliance-report.pdf"), exportReport(report, "pdf"), "binary");

      const freshControl = readControlPlane() ?? control;
      return {
        message: `Compliance report exported with ${report.summary.totalEvents} events.`,
        trace: this.createTrace("audit.report", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "audit-log") {
      const records = queryAudit(root, {});
      const freshControl = readControlPlane() ?? control;
      return {
        message: `Audit log contains ${records.length} records.`,
        trace: this.createTrace("audit.log", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "audit-query") {
      const roleFilter = parseRole(parsed.ast.filters.role);
      const environmentFilter = parseEnvironment(parsed.ast.filters.environment);
      const records = queryAudit(root, {
        ...(roleFilter ? { role: roleFilter } : {}),
        ...(environmentFilter ? { environment: environmentFilter } : {}),
        ...(parsed.ast.filters.action ? { action: parsed.ast.filters.action } : {}),
        ...(parsed.ast.filters.from && parsed.ast.filters.to
          ? { timeRange: [parsed.ast.filters.from, parsed.ast.filters.to] as [string, string] }
          : {}),
      });

      const freshControl = readControlPlane() ?? control;
      return {
        message: `Audit query matched ${records.length} record(s).`,
        trace: this.createTrace("audit.query", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "status") {
      const mission = control.mission.trim();
      const vision = control.vision.trim();
      const plans = control.execution.plans;
      const approvedPlans = plans.filter((plan) => plan.status === "approved").length;
      const draftPlans = plans.length - approvedPlans;
      const pending = policyStatus(root).pending;

      let state = null;
      let stateReadError: string | undefined;
      try {
        state = readStatePlane(root);
      } catch (error) {
        stateReadError = error instanceof Error ? error.message : String(error);
      }

      const executionStatuses = state ? Object.values(state.execution.taskStatus) : [];
      const pendingTasks = executionStatuses.filter((status) => status === "pending").length;
      const inProgressTasks = executionStatuses.filter((status) => status === "in-progress").length;
      const completedTasks = executionStatuses.filter((status) => status === "complete").length;
      const failedTasks = executionStatuses.filter((status) => status === "failed").length;

      const freshControl = readControlPlane() ?? control;
      return {
        message: [
          "Choir status",
          "",
          "Control plane:",
          `- mission: ${mission.length > 0 ? mission : "(empty)"}`,
          `- vision: ${vision.length > 0 ? vision : "(empty)"}`,
          `- goals: ${control.intent.goals.length}`,
          `- constraints: ${control.intent.constraints.length}`,
          `- non-goals: ${control.intent["non-goals"].length}`,
          `- policyRules: ${control.policy.rules.length}`,
          `- plans: ${plans.length} (approved=${approvedPlans}, draft=${draftPlans})`,
          "",
          "Approvals:",
          `- pendingPolicyApprovals: ${pending.length}`,
          "",
          "State plane:",
          stateReadError
            ? `- state: invalid (${stateReadError})`
            : state
              ? "- state: present"
              : "- state: missing",
          state ? `- stateHash: ${state.stateHash}` : "- stateHash: n/a",
          state ? `- violations: ${state.violations.length}` : "- violations: n/a",
          state ? `- executionActivePlan: ${state.execution.activePlanId ?? "none"}` : "- executionActivePlan: n/a",
          state
            ? `- taskStatus: pending=${pendingTasks}, in-progress=${inProgressTasks}, complete=${completedTasks}, failed=${failedTasks}`
            : "- taskStatus: n/a",
        ].join("\n"),
        trace: this.createTrace("status", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "policy-status") {
      const pending = policyStatus(root).pending;
      const freshControl = readControlPlane() ?? control;
      return {
        message: pending.length === 0
          ? "Policy status: no pending approvals."
          : `Policy status: ${pending.length} pending approval(s).`,
        trace: this.createTrace("policy.status", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (parsed.ast.type === "export") {
      const section = parsed.ast.section;
      const generated = generateDSL(controlPlaneToChoirConfig(control), { section });
      const outputPath = path.join(root, ".choir", section === "all" ? "choir.dsl" : `choir.${section}.dsl`);
      writeDSL(generated.script, outputPath);
      const roundTrip = validateRoundTrip(controlPlaneToChoirConfig(control), { section });

      const freshControl = readControlPlane() ?? control;
      return {
        message: `Exported ${section} DSL (roundTripStable=${roundTrip.stable}).\n${formatDSL(generated.script)}`,
        trace: this.createTrace("dsl.export", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    const compiled = compileDSLAndWrite(dsl, control, controlPath, {
      workspaceRoot: root,
      actorId: "ui-user",
    });

    const freshControl = readControlPlane() ?? compiled.updatedControlPlane;

    if (compiled.decision === "deny") {
      const violations = compiled.policyResult?.violations ?? [];
      const lines = violations.map((entry) => `[${entry.ruleId}] ${entry.message}`);
      return {
        message: lines.length > 0 ? lines.join("\n") : "Policy denied this mutation.",
        trace: this.createTrace("dsl.compile", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (compiled.decision === "require-approval") {
      return {
        message: `Approval required: ${compiled.pendingApprovalId ?? "unknown"}`,
        trace: this.createTrace("dsl.compile", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    if (!compiled.changed || compiled.decision === "no-change") {
      return {
        message: "No YAML change needed.",
        trace: this.createTrace("dsl.compile", dsl, controlPlaneToChoirConfig(freshControl)),
      };
    }

    return {
      message: "YAML updated successfully.",
      trace: this.createTrace("dsl.compile", dsl, controlPlaneToChoirConfig(freshControl)),
    };
  }

  async handleAction(action: ProductActionRequest): Promise<ProductActionResult> {
    const role = action.role ?? "conductor";

    try {
      if (action.type === "refresh") {
        return {
          ok: true,
          message: "State synchronized.",
          snapshot: await this.buildSnapshotOrFallback(role, action.filters),
        };
      }

      if (action.type === "run-workflow") {
        this.ensureWorkflowPermission(role, action.step);
        const dsl = this.toWorkflowDSL(action.step, action.payload);
        const executed = await this.runDSLCommand(role, dsl);
        this.lastWorkflowAction = `${action.step}: ${dsl}`;
        this.pushTrace(executed.trace);

        return {
          ok: true,
          message: executed.message,
          trace: executed.trace,
          snapshot: await this.buildSnapshotOrFallback(role),
        };
      }

      if (action.type === "replay-control") {
        const { root } = this.requireControlContext();

        if (action.control === "play") {
          this.replayPlaying = true;
          return {
            ok: true,
            message: "Replay playback started.",
            snapshot: await this.buildSnapshotOrFallback(role),
          };
        }

        if (action.control === "pause") {
          this.replayPlaying = false;
          return {
            ok: true,
            message: "Replay playback paused.",
            snapshot: await this.buildSnapshotOrFallback(role),
          };
        }

        if (action.control === "step-forward") {
          const replayed = stepForward(root, this.replayIndex);
          this.replayIndex = replayed.index;
          this.replayTrace = replayed.trace;
          return {
            ok: true,
            message: replayed.index >= 0 ? `Stepped forward to state ${replayed.index + 1}.` : "No replay states available.",
            snapshot: await this.buildSnapshotOrFallback(role),
          };
        }

        if (action.control === "step-backward") {
          const replayed = stepBackward(root, this.replayIndex);
          this.replayIndex = replayed.index;
          this.replayTrace = replayed.trace;
          return {
            ok: true,
            message: replayed.index >= 0 ? `Stepped backward to state ${replayed.index + 1}.` : "No replay states available.",
            snapshot: await this.buildSnapshotOrFallback(role),
          };
        }

        if (action.control === "jump") {
          const target = typeof action.index === "number" && Number.isFinite(action.index) ? action.index : this.replayIndex;
          const replayed = jumpTo(root, target);
          this.replayIndex = replayed.index;
          this.replayTrace = replayed.trace;
          return {
            ok: true,
            message: replayed.index >= 0 ? `Jumped to state ${replayed.index + 1}.` : "No replay states available.",
            snapshot: await this.buildSnapshotOrFallback(role),
          };
        }

        return {
          ok: false,
          message: "Unknown replay control action.",
          error: toUIError("Unknown replay control action."),
          snapshot: await this.buildSnapshotOrFallback(role),
        };
      }

      const executed = await this.runDSLCommand(role, action.dsl.trim());
      this.lastWorkflowAction = `manual: ${action.dsl.trim()}`;
      this.pushTrace(executed.trace);

      return {
        ok: true,
        message: executed.message,
        trace: executed.trace,
        snapshot: await this.buildSnapshotOrFallback(role),
      };
    } catch (error) {
      const libraryFailure = parseLibraryFailure(error);
      if (libraryFailure) {
        return {
          ok: false,
          message: `Library command failed at ${libraryFailure.stage}.`,
          error: toUIError(libraryFailure.message),
          snapshot: await this.buildSnapshotOrFallback(role, undefined, libraryFailure.message),
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        message: "Action failed.",
        error: toUIError(message),
        snapshot: await this.buildSnapshotOrFallback(role, undefined, message),
      };
    }
  }
}
