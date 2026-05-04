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

export type LegacySeverity = "error" | "warn" | "warning" | "info" | "information" | "hint";

export function normalizeDiagnosticSeverity(severity: LegacySeverity): DiagnosticSeverity {
  if (severity === "warn") {
    return "warning";
  }

  if (severity === "information") {
    return "info";
  }

  return severity;
}

export interface EnforcementResult {
  verdict: "pass" | "fail" | "warn";
  diagnostics: Diagnostic[];
}

// Backward-compatible alias while consumers migrate from legacy terminology.
export type Violation = Diagnostic;