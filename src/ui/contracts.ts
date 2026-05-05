import type { AuditEvent } from "../core/audit.js";
import type { Role } from "../core/policyEngine.js";

export type UISurface =
  | "dashboard"
  | "workspace"
  | "plan-view"
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
  traces: UITrace[];
  controlPlane: object;
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
