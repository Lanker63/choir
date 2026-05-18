import type { AuditEvent } from "../core/audit.js";
import type { Role } from "../core/policyEngine.js";

export type UISurface =
  | "dashboard"
  | "workspace"
  | "plan-view"
  | "timeline-view"
  | "policy-view"
  | "audit-view"
  | "macro-library";

export type Dashboard = {
  systemHealth: string;
  activePlans: number;
  policyViolations: number;
  recentActions: AuditEvent[];
  recommendations: string[];
};

export type ProductionView = {
  health: {
    healthy: boolean;
    checks: {
      determinismIntact: boolean;
      replayConsistency: boolean;
      auditChainValid: boolean;
      policyEnforcementActive: boolean;
    };
    failures: string[];
  };
  metrics: Array<{
    name: string;
    value: number;
    tags: Record<string, string>;
  }>;
  alerts: Array<{
    id: string;
    severity: "low" | "medium" | "high" | "critical";
    condition: string;
  }>;
  incidents: Array<{
    id: string;
    cause: string;
    affectedUnits: string[];
    resolution: string;
  }>;
  slos: Array<{
    name: string;
    target: number;
    actual: number;
    met: boolean;
  }>;
  failureHotspots: string[];
};

export type WorkflowStep =
  | "define-intent"
  | "plan"
  | "preview"
  | "approve"
  | "execute"
  | "audit";

export type PlanView = {
  planId: string;
  tasks: string[];
  affectedFiles: string[];
  estimatedImpact: number;
};

export type DiffView = {
  file: string;
  before: string;
  after: string;
};

export type PolicyView = {
  decision: "allow" | "deny" | "require-approval";
  rulesMatched: string[];
  source: "org" | "repo" | "environment";
};

export type AuditView = {
  events: AuditEvent[];
  filters: {
    role?: string;
    environment?: string;
  };
};

export type MacroUI = {
  libraries: string[];
  lockedVersions?: string[];
  transitiveDependencies?: string[];
  macros: string[];
  abstractions: string[];
};

export type RoleView = {
  architect: ["intent", "policy"];
  analyst: ["analysis", "audit"];
  conductor: ["plan", "workflow"];
  enforcer: ["execution"];
};

export type UIError = {
  message: string;
  source: "policy" | "execution" | "validation";
};

export type UITrace = {
  action: string;
  resultingDSL: string;
  resultingYAML: object;
};

export type StateTimelineEntry = {
  index: number;
  transitionId: string;
  label: string;
  action: string;
  timestamp: string;
  fromHash: string;
  toHash: string;
  metadata?: {
    command: string;
    policyDecision: string;
    auditId: string;
    ruleTriggers?: string[];
    dependencyChain?: string[];
  };
};

export type TimelineUI = {
  currentIndex: number;
  canStepForward: boolean;
  canStepBackward: boolean;
  playing: boolean;
  states: StateTimelineEntry[];
};

export type StateInspector = {
  intent: object;
  ast: object[];
  violations: object[];
  plans: object[];
  why: string[];
  dependencyChain: string[];
};

export type StateDiff = {
  before: object;
  after: object;
  patches: Array<{
    path: string;
    op: "set" | "delete";
    before: unknown;
    after?: unknown;
  }>;
};

export type TimelineReplayTrace = {
  visitedStates: string[];
  replayTime: number;
  consistencyCheck: boolean;
  fallbackUsed: boolean;
  planning?: {
    traceId: string;
    selectedPlanId: string;
    selectedStrategyType: string;
    selectedDagHash: string;
    rankingOrder: string[];
    candidates: Array<{
      id: string;
      strategyType: string;
      orchestrationDagHash: string;
      rank?: number;
      selected?: boolean;
    }>;
  };
};

export type RuntimeGovernanceView = {
  mode: string;
  capability: string;
  decision: "allow" | "deny" | "require-approval";
  reason: string;
  governanceHash: string;
  effectiveCapabilities: Record<string, boolean>;
  packageDecisions: Array<{
    packageName: string;
    mode: string;
    decision: "allow" | "deny" | "require-approval";
    reason: string;
  }>;
};

export type WorkflowState = {
  current: WorkflowStep;
  completed: WorkflowStep[];
  pending: WorkflowStep[];
  lastAction?: string;
};

export type ProductSnapshot = {
  generatedAt: string;
  activeRole: Role;
  availableSurfaces: UISurface[];
  dashboard: Dashboard;
  workflow: WorkflowState;
  planView: PlanView[];
  diffView: DiffView[];
  policyView: PolicyView[];
  auditView: AuditView;
  macroUI: MacroUI;
  roleView: RoleView;
  pendingApprovals: Array<{ id: string; command: string; diffHash: string; createdAt: string }>;
  production?: ProductionView;
  traces: UITrace[];
  controlPlane: object;
  timeline: TimelineUI;
  stateInspector: StateInspector;
  stateDiff?: StateDiff;
  replayTrace?: TimelineReplayTrace;
  runtimeGovernance?: RuntimeGovernanceView;
};

export type ProductActionRequest =
  | {
    type: "refresh";
    role?: Role;
    filters?: {
      role?: string;
      environment?: string;
    };
  }
  | {
    type: "run-dsl";
    role?: Role;
    dsl: string;
  }
  | {
    type: "run-workflow";
    role?: Role;
    step: WorkflowStep;
    payload?: Record<string, string>;
  }
  | {
    type: "replay-control";
    role?: Role;
    control: "play" | "pause" | "step-forward" | "step-backward" | "jump";
    index?: number;
  };

export type ProductActionResult = {
  ok: boolean;
  message: string;
  trace?: UITrace;
  error?: UIError;
  snapshot: ProductSnapshot;
};

export type WebviewInboundMessage =
  | {
    type: "ready";
  }
  | {
    type: "action";
    payload: ProductActionRequest;
  };

export type WebviewOutboundMessage =
  | {
    type: "snapshot";
    payload: ProductSnapshot;
  }
  | {
    type: "action-result";
    payload: ProductActionResult;
  };
