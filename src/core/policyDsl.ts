import fs from "fs";
import path from "path";
import { Environment, PolicyRule, PolicySet, Role } from "./policyEngine.js";

type PolicyEffect = "allow" | "deny" | "require-approval";
type DiffOperation = "add" | "remove" | "update";

type PolicyClause =
  | { kind: "diff.path"; value: string }
  | { kind: "diff.operation"; value: DiffOperation }
  | { kind: "role"; value: Role }
  | { kind: "environment"; value: Environment }
  | { kind: "contains"; value: string }
  | { kind: "countGreaterThan"; value: number };

type PolicyRuleAST = {
  match: {
    path?: string;
    operation?: DiffOperation;
  };
  scope?: {
    role?: Role;
    environment?: Environment;
  };
  condition?: {
    contains?: string;
    countGreaterThan?: number;
  };
  effect: PolicyEffect;
};

export type PolicyAST = {
  id: string;
  rules: PolicyRuleAST[];
};

type Token =
  | { type: "word"; value: string; line: number; column: number }
  | { type: "string"; value: string; line: number; column: number }
  | { type: "number"; value: number; line: number; column: number }
  | { type: "symbol"; value: "{" | "}" | "=" | ">"; line: number; column: number }
  | { type: "eof"; line: number; column: number };

const ROLE_VALUES: Role[] = ["architect", "analyst", "conductor", "enforcer"];
const ENV_VALUES: Environment[] = ["local", "ci", "staging", "production"];
const EFFECT_VALUES: PolicyEffect[] = ["allow", "deny", "require-approval"];
const OPERATION_VALUES: DiffOperation[] = ["add", "remove", "update"];
const POLICY_ID_PATTERN = /^[a-zA-Z0-9-_]+$/;

function policyFilePath(root: string): string {
  return path.join(root, ".choir", "policies.dsl");
}

function parseError(message: string, token: Token): Error {
  return new Error(`Policy DSL parse error at ${token.line}:${token.column}: ${message}`);
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const advance = (count = 1): void => {
    for (let i = 0; i < count; i += 1) {
      const current = input[index];
      index += 1;
      if (current === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
  };

  while (index < input.length) {
    const char = input[index];

    if (char === "#") {
      while (index < input.length && input[index] !== "\n") {
        advance();
      }
      continue;
    }

    if (/\s/.test(char)) {
      advance();
      continue;
    }

    if (char === "{" || char === "}" || char === "=" || char === ">") {
      tokens.push({ type: "symbol", value: char, line, column });
      advance();
      continue;
    }

    if (char === '"') {
      const startLine = line;
      const startCol = column;
      advance();

      let value = "";
      let escaped = false;
      let terminated = false;

      while (index < input.length) {
        const current = input[index];
        if (escaped) {
          if (current === "n") {
            value += "\n";
          } else if (current === "t") {
            value += "\t";
          } else if (current === '"' || current === "\\") {
            value += current;
          } else {
            value += current;
          }

          escaped = false;
          advance();
          continue;
        }

        if (current === "\\") {
          escaped = true;
          advance();
          continue;
        }

        if (current === '"') {
          advance();
          terminated = true;
          break;
        }

        value += current;
        advance();
      }

      if (!terminated) {
        throw new Error(`Policy DSL parse error at ${startLine}:${startCol}: Unterminated string literal`);
      }

      tokens.push({ type: "string", value, line: startLine, column: startCol });
      continue;
    }

    if (/[0-9]/.test(char)) {
      const startLine = line;
      const startCol = column;
      let raw = "";
      while (index < input.length && /[0-9]/.test(input[index])) {
        raw += input[index];
        advance();
      }

      tokens.push({ type: "number", value: Number(raw), line: startLine, column: startCol });
      continue;
    }

    if (/[a-zA-Z_.-]/.test(char)) {
      const startLine = line;
      const startCol = column;
      let value = "";
      while (index < input.length && /[a-zA-Z0-9_.-]/.test(input[index])) {
        value += input[index];
        advance();
      }

      tokens.push({ type: "word", value, line: startLine, column: startCol });
      continue;
    }

    throw new Error(`Policy DSL parse error at ${line}:${column}: Unexpected character '${char}'`);
  }

  tokens.push({ type: "eof", line, column });
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parsePolicies(): PolicyAST[] {
    const policies: PolicyAST[] = [];

    while (!this.isEOF()) {
      policies.push(this.parsePolicy());
    }

    const ids = new Set<string>();
    for (const policy of policies) {
      if (ids.has(policy.id)) {
        const token = this.current();
        throw parseError(`Duplicate policy id: ${policy.id}`, token);
      }
      ids.add(policy.id);
    }

    return policies;
  }

  private parsePolicy(): PolicyAST {
    this.expectWord("policy");
    const id = this.expectIdentifier("Expected policy identifier after 'policy'");
    if (!POLICY_ID_PATTERN.test(id)) {
      throw parseError(`Invalid policy id: ${id}`, this.previous());
    }

    this.expectSymbol("{");
    const rules: PolicyRuleAST[] = [];

    while (!this.consumeSymbol("}")) {
      if (this.isEOF()) {
        throw parseError(`Unterminated policy block for ${id}`, this.current());
      }

      rules.push(this.parseRule());
    }

    return { id, rules };
  }

  private parseRule(): PolicyRuleAST {
    this.expectWord("when");

    const clauses: PolicyClause[] = [this.parseClause()];
    while (this.consumeWord("and")) {
      clauses.push(this.parseClause());
    }

    this.expectWord("then");
    const effectWord = this.expectIdentifier("Expected rule effect after 'then'");
    if (!EFFECT_VALUES.includes(effectWord as PolicyEffect)) {
      throw parseError(`Invalid effect: ${effectWord}`, this.previous());
    }

    const rule: PolicyRuleAST = {
      match: {},
      effect: effectWord as PolicyEffect,
    };

    let hasDiffClause = false;

    for (const clause of clauses) {
      if (clause.kind === "diff.path") {
        hasDiffClause = true;
        if (rule.match.path) {
          throw parseError("Duplicate diff.path clause", this.previous());
        }
        rule.match.path = clause.value;
        continue;
      }

      if (clause.kind === "diff.operation") {
        hasDiffClause = true;
        if (rule.match.operation) {
          throw parseError("Duplicate diff.operation clause", this.previous());
        }
        rule.match.operation = clause.value;
        continue;
      }

      if (clause.kind === "role") {
        rule.scope = {
          ...(rule.scope ?? {}),
          role: clause.value,
        };
        continue;
      }

      if (clause.kind === "environment") {
        rule.scope = {
          ...(rule.scope ?? {}),
          environment: clause.value,
        };
        continue;
      }

      if (clause.kind === "contains") {
        rule.condition = {
          ...(rule.condition ?? {}),
          contains: clause.value,
        };
        continue;
      }

      rule.condition = {
        ...(rule.condition ?? {}),
        countGreaterThan: clause.value,
      };
    }

    if (!hasDiffClause) {
      throw parseError("Each rule must include at least one diff matcher (diff.path or diff.operation)", this.current());
    }

    return rule;
  }

  private parseClause(): PolicyClause {
    const token = this.current();
    if (token.type !== "word") {
      throw parseError("Expected condition clause", token);
    }

    if (token.value === "diff.path") {
      this.take();
      this.expectSymbol("=");
      const value = this.expectString("Expected quoted string after diff.path =");
      return { kind: "diff.path", value };
    }

    if (token.value === "diff.operation") {
      this.take();
      this.expectSymbol("=");
      const value = this.expectIdentifier("Expected add|remove|update after diff.operation =");
      if (!OPERATION_VALUES.includes(value as DiffOperation)) {
        throw parseError(`Invalid diff.operation: ${value}`, this.previous());
      }
      return { kind: "diff.operation", value: value as DiffOperation };
    }

    if (token.value === "role") {
      this.take();
      this.expectSymbol("=");
      const value = this.expectIdentifier("Expected role after role =");
      if (!ROLE_VALUES.includes(value as Role)) {
        throw parseError(`Invalid role: ${value}`, this.previous());
      }
      return { kind: "role", value: value as Role };
    }

    if (token.value === "environment") {
      this.take();
      this.expectSymbol("=");
      const value = this.expectIdentifier("Expected environment after environment =");
      if (!ENV_VALUES.includes(value as Environment)) {
        throw parseError(`Invalid environment: ${value}`, this.previous());
      }
      return { kind: "environment", value: value as Environment };
    }

    if (token.value === "contains") {
      this.take();
      const value = this.expectString("Expected quoted string after contains");
      return { kind: "contains", value };
    }

    if (token.value === "count") {
      this.take();
      this.expectSymbol(">");
      const value = this.expectNumber("Expected number after count >");
      return { kind: "countGreaterThan", value };
    }

    throw parseError(`Unknown condition clause: ${token.value}`, token);
  }

  private expectWord(expected: string): void {
    const token = this.take();
    if (!token || token.type !== "word" || token.value !== expected) {
      const found = token ? `${token.type}:${token.type === "word" ? token.value : ""}` : "<end>";
      throw parseError(`Expected '${expected}', found ${found}`, token ?? this.current());
    }
  }

  private consumeWord(expected: string): boolean {
    const token = this.current();
    if (token.type !== "word" || token.value !== expected) {
      return false;
    }

    this.index += 1;
    return true;
  }

  private expectSymbol(expected: "{" | "}" | "=" | ">"): void {
    const token = this.take();
    if (!token || token.type !== "symbol" || token.value !== expected) {
      const found = token ? `${token.type}:${token.type === "symbol" ? token.value : ""}` : "<end>";
      throw parseError(`Expected symbol '${expected}', found ${found}`, token ?? this.current());
    }
  }

  private consumeSymbol(expected: "{" | "}" | "=" | ">"): boolean {
    const token = this.current();
    if (token.type !== "symbol" || token.value !== expected) {
      return false;
    }

    this.index += 1;
    return true;
  }

  private expectIdentifier(message: string): string {
    const token = this.take();
    if (!token || token.type !== "word") {
      throw parseError(message, token ?? this.current());
    }

    return token.value;
  }

  private expectString(message: string): string {
    const token = this.take();
    if (!token || token.type !== "string") {
      throw parseError(message, token ?? this.current());
    }

    return token.value;
  }

  private expectNumber(message: string): number {
    const token = this.take();
    if (!token || token.type !== "number") {
      throw parseError(message, token ?? this.current());
    }

    return token.value;
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.index - 1)] ?? this.tokens[0];
  }

  private current(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1];
  }

  private take(): Token {
    const token = this.current();
    this.index += 1;
    return token;
  }

  private isEOF(): boolean {
    return this.current().type === "eof";
  }
}

export function parsePolicyDSL(input: string): PolicyAST[] {
  return new Parser(tokenize(input)).parsePolicies();
}

export function compilePolicy(ast: PolicyAST): PolicyRule[] {
  return ast.rules.map((rule, index) => {
    if (!rule.match.path && !rule.match.operation) {
      throw new Error(`Policy ${ast.id} rule ${index + 1} must include diff.path or diff.operation`);
    }

    return {
      id: `${ast.id}.rule.${index + 1}`,
      policyId: ast.id,
      match: {
        ...(rule.match.path ? { path: rule.match.path } : {}),
        ...(rule.match.operation ? { operation: rule.match.operation } : {}),
      },
      ...(rule.scope
        ? {
          scope: {
            ...(rule.scope.role ? { roles: [rule.scope.role] } : {}),
            ...(rule.scope.environment ? { environments: [rule.scope.environment] } : {}),
          },
        }
        : {}),
      ...(rule.condition
        ? {
          condition: {
            ...(typeof rule.condition.contains === "string" ? { contains: rule.condition.contains } : {}),
            ...(typeof rule.condition.countGreaterThan === "number"
              ? { countGreaterThan: rule.condition.countGreaterThan }
              : {}),
          },
        }
        : {}),
      effect: {
        type: rule.effect,
      },
    };
  });
}

function normalizedConflictSignature(rule: PolicyRule): string {
  return JSON.stringify({
    match: {
      path: rule.match.path ?? null,
      operation: rule.match.operation ?? null,
    },
    scope: {
      roles: [...(rule.scope?.roles ?? [])].sort((a, b) => a.localeCompare(b)),
      environments: [...(rule.scope?.environments ?? [])].sort((a, b) => a.localeCompare(b)),
    },
    condition: {
      contains: rule.condition?.contains ?? null,
      countGreaterThan: rule.condition?.countGreaterThan ?? null,
    },
  });
}

export function compilePolicies(asts: PolicyAST[]): PolicySet {
  const compiled = [...asts]
    .sort((left, right) => left.id.localeCompare(right.id))
    .flatMap((ast) => compilePolicy(ast));

  const signatureToEffect = new Map<string, PolicyEffect>();
  for (const rule of compiled) {
    const signature = normalizedConflictSignature(rule);
    const existing = signatureToEffect.get(signature);
    if (existing && existing !== rule.effect.type) {
      throw new Error(`Conflicting policy rules detected for selector signature: ${signature}`);
    }

    signatureToEffect.set(signature, rule.effect.type);
  }

  return {
    rules: compiled.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function loadPolicies(root: string): PolicySet {
  const filePath = policyFilePath(root);
  if (!fs.existsSync(filePath)) {
    return { rules: [] };
  }

  const text = fs.readFileSync(filePath, "utf-8");
  const ast = parsePolicyDSL(text);
  return compilePolicies(ast);
}
