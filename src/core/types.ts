export type Position = {
  line: number;
  character: number;
};

export type SourceLocation = {
  file: string;
  start: Position;
  end: Position;
};

export type DiagnosticSeverity =
  | "error"
  | "warning"
  | "info"
  | "hint";

export type DiagnosticCategory = "AST" | "semantic" | "pattern" | "strategy";

export type DiagnosticRelated = {
  message: string;
  location: SourceLocation;
};

export type Diagnostic = {
  id: string;
  ruleId: string;
  message: string;
  severity: DiagnosticSeverity;
  location: SourceLocation;
  category: DiagnosticCategory;
  tags?: string[];
  related?: DiagnosticRelated[];
  fixIds?: string[];
  traceId: string;
};

export type Trace = {
  runId: string;
  phases: Array<"AST" | "SEMANTIC" | "CODE" | "STRATEGY">;
  rulesEvaluated: string[];
  rulesTriggered: string[];
  diagnosticsEmitted: string[];
  fixesGenerated: string[];
  conflictsDetected: import("../fix/types.js").FixConflict[];
  decisions: string[];
  durationMs: number;
};

export type ExecutionTrace = {
  planId: string;
  tasksExecuted: string[];
  tasksSucceeded: string[];
  tasksFailed: string[];
  decisions: string[];
};

export type SchedulerTrace = {
  totalPlans: number;
  totalTasks: number;
  totalBatches: number;
  parallelBatches: number;
  conflictsAvoided: number;
  decisions: string[];
};

export type TransactionTrace = {
  transactionId: string;
  batchId: string;
  patchesProposed: number;
  patchesApplied: number;
  validationPassed: boolean;
  rollbackReason?: string;
  durationMs: number;
};

interface EnforcementResult {
  verdict: "pass" | "fail" | "warn";
  diagnostics: Diagnostic[];
}