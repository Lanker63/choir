export type Severity = "error" | "warn" | "info";

export interface Violation {
  ruleId: string;
  message: string;
  file: string;
  start: number;
  end: number;
  severity: Severity;
}

export interface EnforcementResult {
  verdict: "pass" | "fail" | "warn";
  violations: Violation[];
}