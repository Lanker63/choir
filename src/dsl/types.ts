export interface DSLRule {
  id: string;
  description?: string;

  appliesTo?: {
    files?: string[];        // glob patterns
    language?: string;
  };

  match: {
    imports?: string[];
    callExpressions?: string[];
    functionNames?: string[];
  };

  constraint: {
    type: "forbid" | "require";
  };

  message: string;
  severity?: "error" | "warn" | "info";
}

/**
 * Compiled AST rule
 */
export interface ASTRule {
  id: string;
  evaluate(file: string, ast: unknown): any[];
}