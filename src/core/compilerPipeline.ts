import { ControlPlane } from "../schema.js";
import { AST, ActionNode, Token, parse, tokenize, validateAST } from "./choirRouter.js";
import {
  RuleResult,
  ValidationResult,
  ValidationTrace,
  processAST,
  validateCrossNode,
  validateSemantics,
  validateStructure,
} from "./astValidation.js";

export type CompilerStage = "structure" | "semantic" | "cross-node" | "policy";

export type CompilerError = {
  stage: CompilerStage;
  message: string;
  location?: string;
};

export type CompilerSymbolKind = "goal" | "constraint" | "policy" | "reference";

export type CompilerSymbol = {
  key: string;
  kind: CompilerSymbolKind;
  name: string;
  source: "control" | "ast";
  actionIndex?: number;
};

export type SymbolTable = {
  symbols: Map<string, CompilerSymbol>;
};

export type CompilerPipelineResult = {
  tokens: Token[];
  ast: AST;
  normalizedAst: AST;
  symbolTable: SymbolTable;
  validationTrace: ValidationTrace;
  ruleResults: RuleResult[];
};

export class CompilerPipelineError extends Error {
  readonly errors: CompilerError[];

  constructor(errors: CompilerError[]) {
    const normalized = sortCompilerErrors(errors);
    super(formatCompilerErrors(normalized));
    this.name = "CompilerPipelineError";
    this.errors = normalized;
  }
}

function sortCompilerErrors(errors: CompilerError[]): CompilerError[] {
  return [...errors].sort((left, right) => {
    if (left.stage !== right.stage) {
      return left.stage.localeCompare(right.stage);
    }

    const leftLocation = left.location ?? "";
    const rightLocation = right.location ?? "";
    if (leftLocation !== rightLocation) {
      return leftLocation.localeCompare(rightLocation);
    }

    return left.message.localeCompare(right.message);
  });
}

export function formatCompilerErrors(errors: CompilerError[]): string {
  const lines = sortCompilerErrors(errors).map((entry) => {
    const location = entry.location ? ` (${entry.location})` : "";
    return `- [${entry.stage}] ${entry.message}${location}`;
  });

  return [
    "Compilation failed.",
    ...lines,
  ].join("\n");
}

function throwCompilerErrors(errors: CompilerError[]): never {
  throw new CompilerPipelineError(errors);
}

function toValidationErrors(stage: CompilerStage, validation: ValidationResult): CompilerError[] {
  return validation.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => ({
      stage,
      message: `[${issue.code}] ${issue.message}`,
      location: issue.path,
    }));
}

function isSequence(ast: AST): ast is { type: "sequence"; actions: ActionNode[] } {
  return ast.type === "sequence";
}

function asActions(ast: AST): ActionNode[] {
  return isSequence(ast) ? ast.actions : [ast];
}

function addSymbol(table: Map<string, CompilerSymbol>, symbol: CompilerSymbol): void {
  if (table.has(symbol.key)) {
    return;
  }

  table.set(symbol.key, symbol);
}

function symbolKey(kind: CompilerSymbolKind, value: string): string {
  return `${kind}:${value.trim().toLowerCase()}`;
}

export function buildSymbolTable(ast: AST, controlPlane: ControlPlane): SymbolTable {
  const symbols = new Map<string, CompilerSymbol>();

  for (const goal of controlPlane.intent.goals) {
    const key = symbolKey("goal", goal);
    addSymbol(symbols, {
      key,
      kind: "goal",
      name: goal,
      source: "control",
    });
  }

  for (const constraint of controlPlane.intent.constraints) {
    const key = symbolKey("constraint", constraint);
    addSymbol(symbols, {
      key,
      kind: "constraint",
      name: constraint,
      source: "control",
    });
  }

  for (const rule of controlPlane.policy.rules) {
    const rawId = typeof rule.id === "string" && rule.id.trim().length > 0
      ? rule.id
      : JSON.stringify(rule);
    const key = symbolKey("policy", rawId);
    addSymbol(symbols, {
      key,
      kind: "policy",
      name: rawId,
      source: "control",
    });
  }

  const actions = asActions(ast);
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index] as ActionNode;

    if (action.type === "define") {
      if (action.defineType === "goal") {
        const key = symbolKey("goal", action.value);
        addSymbol(symbols, {
          key,
          kind: "goal",
          name: action.value,
          source: "ast",
          actionIndex: index,
        });
      }

      if (action.defineType === "constraint") {
        const key = symbolKey("constraint", action.value);
        addSymbol(symbols, {
          key,
          kind: "constraint",
          name: action.value,
          source: "ast",
          actionIndex: index,
        });
      }

      continue;
    }

    if (action.type === "plan-approve") {
      const key = symbolKey("reference", action.planId);
      addSymbol(symbols, {
        key,
        kind: "reference",
        name: action.planId,
        source: "ast",
        actionIndex: index,
      });
      continue;
    }

    if (action.type === "preview" || action.type === "execute" || action.type === "simulate") {
      if (!action.planRef) {
        continue;
      }

      const key = symbolKey("reference", action.planRef.identifier);
      addSymbol(symbols, {
        key,
        kind: "reference",
        name: action.planRef.identifier,
        source: "ast",
        actionIndex: index,
      });
    }
  }

  const orderedEntries = [...symbols.entries()].sort(([left], [right]) => left.localeCompare(right));
  return {
    symbols: new Map<string, CompilerSymbol>(orderedEntries),
  };
}

function validateStructureGate(ast: AST): void {
  const structure = validateStructure(ast);
  if (!structure.valid) {
    throwCompilerErrors(toValidationErrors("structure", structure));
  }
}

function validateSemanticGate(ast: AST, controlPlane: ControlPlane): void {
  const semantics = validateSemantics(ast, { controlPlane });
  if (!semantics.valid) {
    throwCompilerErrors(toValidationErrors("semantic", semantics));
  }
}

function validateCrossNodeGate(ast: AST, controlPlane: ControlPlane): void {
  const crossNode = validateCrossNode(ast, { controlPlane });
  if (!crossNode.valid) {
    throwCompilerErrors(toValidationErrors("cross-node", crossNode));
  }
}

function normalizePolicyError(error: unknown): CompilerPipelineError {
  const message = error instanceof Error ? error.message : String(error);
  return new CompilerPipelineError([
    {
      stage: "policy",
      message,
    },
  ]);
}

export function compileInput(input: string, controlPlane: ControlPlane): CompilerPipelineResult {
  let tokens: Token[];
  let ast: AST;

  try {
    tokens = tokenize(input);
    ast = parse(tokens);
    validateAST(ast);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CompilerPipelineError([
      {
        stage: "structure",
        message,
        location: "dsl",
      },
    ]);
  }

  const symbolTable = buildSymbolTable(ast, controlPlane);

  validateStructureGate(ast);
  validateSemanticGate(ast, controlPlane);
  validateCrossNodeGate(ast, controlPlane);

  try {
    const processed = processAST(ast, { controlPlane });
    return {
      tokens,
      ast,
      normalizedAst: processed.ast,
      symbolTable,
      validationTrace: processed.trace,
      ruleResults: processed.results,
    };
  } catch (error) {
    throw normalizePolicyError(error);
  }
}
