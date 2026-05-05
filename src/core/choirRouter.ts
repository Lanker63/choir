export const CHOIR_DSL_GRAMMAR = `<command> ::= "choir" <action> ("then" <action>)*

<action> ::=
    <define>
  | <analyze>
  | <plan>
  | <preview>
  | <execute>
  | <status>
  | <export>

<define> ::= "define" <define-type> <string>

<define-type> ::= "goal" | "constraint" | "non-goal"

<analyze> ::= "analyze" <analyze-target>

<analyze-target> ::= "workspace" | "violations" | "hotspots"

<plan> ::= "plan" ["for" <string>]

<preview> ::= "preview" [<plan-ref>]

<execute> ::= "execute" [<plan-ref>]

<status> ::= "status"

<export> ::= "export" "dsl" [<export-section>]

<export-section> ::= "all" | "intent" | "policy" | "plans"

<plan-ref> ::= "plan" <identifier>

<string> ::= QUOTED_STRING

<identifier> ::= [a-zA-Z0-9-_]+`;

export type Token =
  | { type: "keyword"; value: string }
  | { type: "string"; value: string }
  | { type: "identifier"; value: string };

const KEYWORDS = new Set([
  "choir",
  "define",
  "goal",
  "constraint",
  "non-goal",
  "analyze",
  "workspace",
  "violations",
  "hotspots",
  "plan",
  "for",
  "preview",
  "execute",
  "status",
  "export",
  "dsl",
  "all",
  "intent",
  "policy",
  "plans",
  "then",
]);

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9-_]+$/;

export type DefineType = "goal" | "constraint" | "non-goal";
export type AnalyzeTarget = "workspace" | "violations" | "hotspots";

export type PlanRef = {
  type: "plan-ref";
  identifier: string;
};

export type DefineNode = {
  type: "define";
  defineType: DefineType;
  value: string;
};

export type AnalyzeNode = {
  type: "analyze";
  target: AnalyzeTarget;
};

export type PlanNode = {
  type: "plan";
  target?: string;
};

export type PreviewNode = {
  type: "preview";
  planRef?: PlanRef;
};

export type ExecuteNode = {
  type: "execute";
  planRef?: PlanRef;
};

export type StatusNode = {
  type: "status";
};

export type ExportSection = "all" | "intent" | "policy" | "plans";

export type ExportNode = {
  type: "export";
  format: "dsl";
  section: ExportSection;
};

export type ActionNode =
  | DefineNode
  | AnalyzeNode
  | PlanNode
  | PreviewNode
  | ExecuteNode
  | StatusNode
  | ExportNode;

export type SequenceNode = {
  type: "sequence";
  actions: ActionNode[];
};

export type AST = ActionNode | SequenceNode;

export type RoleName = "architect" | "analyst" | "conductor";

export type CapabilityAction = "modify-yaml" | "read-state" | "plan" | "schedule";

export type Intent = AST["type"];

export type DSLTrace = {
  input: string;
  tokens: Token[];
  ast: AST;
  compiledAction: string;
};

export type RouterTrace = {
  intent: Intent;
  rolesInvoked: string[];
  steps: string[];
  decisions: string[];
  dslTrace: DSLTrace;
};

export type RouterRoleHandlers<TContext> = {
  architect: {
    define: (node: DefineNode, context: TContext) => Promise<void>;
  };
  analyst: {
    analyze: (node: AnalyzeNode, context: TContext) => Promise<void>;
    status: (context: TContext) => Promise<void>;
  };
  conductor: {
    plan: (node: PlanNode, context: TContext) => Promise<void>;
    preview: (node: PreviewNode, context: TContext) => Promise<void>;
    execute: (node: ExecuteNode, context: TContext) => Promise<void>;
  };
};

const CAPABILITY_RULES: Record<RoleName, CapabilityAction[]> = {
  architect: ["modify-yaml"],
  analyst: ["read-state"],
  conductor: ["plan", "schedule"],
};

function isWordCharacter(value: string): boolean {
  return /[a-zA-Z0-9_-]/.test(value);
}

function parseQuotedString(input: string, start: number): { value: string; end: number } {
  let cursor = start + 1;
  let value = "";

  while (cursor < input.length) {
    const char = input[cursor];
    if (char === "\\") {
      const next = input[cursor + 1];
      if (next === undefined) {
        throw new Error("Unterminated string escape sequence");
      }

      if (next === "\\" || next === "\"") {
        value += next;
      } else if (next === "n") {
        value += "\n";
      } else if (next === "t") {
        value += "\t";
      } else {
        throw new Error(`Unsupported escape sequence: \\${next}`);
      }

      cursor += 2;
      continue;
    }

    if (char === "\"") {
      return { value, end: cursor + 1 };
    }

    value += char;
    cursor += 1;
  }

  throw new Error("Unterminated quoted string");
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const char = input[cursor];

    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }

    if (char === "\"") {
      const parsed = parseQuotedString(input, cursor);
      tokens.push({ type: "string", value: parsed.value });
      cursor = parsed.end;
      continue;
    }

    if (isWordCharacter(char)) {
      let end = cursor + 1;
      while (end < input.length && isWordCharacter(input[end])) {
        end += 1;
      }

      const raw = input.slice(cursor, end);
      const normalized = raw.toLowerCase();
      if (KEYWORDS.has(normalized)) {
        tokens.push({ type: "keyword", value: normalized });
      } else {
        tokens.push({ type: "identifier", value: raw });
      }

      cursor = end;
      continue;
    }

    throw new Error(`Invalid character in Choir DSL: ${char}`);
  }

  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): AST {
    this.expectKeyword("choir");

    const actions: ActionNode[] = [this.parseAction()];
    while (this.consumeKeyword("then")) {
      actions.push(this.parseAction());
    }

    this.expectEnd();
    if (actions.length === 1) {
      return actions[0];
    }

    return {
      type: "sequence",
      actions,
    };
  }

  private parseAction(): ActionNode {
    const next = this.peek();
    if (!next || next.type !== "keyword") {
      throw new Error("Expected Choir DSL action keyword");
    }

    switch (next.value) {
      case "define":
        return this.parseDefine();
      case "analyze":
        return this.parseAnalyze();
      case "plan":
        return this.parsePlan();
      case "preview":
        return this.parsePreview();
      case "execute":
        return this.parseExecute();
      case "status":
        return this.parseStatus();
      case "export":
        return this.parseExport();
      default:
        throw new Error(`Unsupported Choir DSL action: ${next.value}`);
    }
  }

  private parseDefine(): DefineNode {
    this.expectKeyword("define");
    const defineType = this.expectOneOfKeywords(["goal", "constraint", "non-goal"]) as DefineType;
    const value = this.expectString();

    return {
      type: "define",
      defineType,
      value,
    };
  }

  private parseAnalyze(): AnalyzeNode {
    this.expectKeyword("analyze");
    const target = this.expectOneOfKeywords(["workspace", "violations", "hotspots"]) as AnalyzeTarget;

    return {
      type: "analyze",
      target,
    };
  }

  private parsePlan(): PlanNode {
    this.expectKeyword("plan");
    if (this.consumeKeyword("for")) {
      return {
        type: "plan",
        target: this.expectString(),
      };
    }

    return {
      type: "plan",
    };
  }

  private parsePlanRef(): PlanRef {
    this.expectKeyword("plan");
    const identifier = this.expectIdentifier();
    return {
      type: "plan-ref",
      identifier,
    };
  }

  private parsePreview(): PreviewNode {
    this.expectKeyword("preview");
    const next = this.peek();
    if (!next || (next.type === "keyword" && next.value === "then")) {
      return { type: "preview" };
    }

    if (next.type !== "keyword" || next.value !== "plan") {
      throw new Error("Expected optional plan reference: 'plan <identifier>'");
    }

    return {
      type: "preview",
      planRef: this.parsePlanRef(),
    };
  }

  private parseExecute(): ExecuteNode {
    this.expectKeyword("execute");
    const next = this.peek();
    if (!next || (next.type === "keyword" && next.value === "then")) {
      return { type: "execute" };
    }

    if (next.type !== "keyword" || next.value !== "plan") {
      throw new Error("Expected optional plan reference: 'plan <identifier>'");
    }

    return {
      type: "execute",
      planRef: this.parsePlanRef(),
    };
  }

  private parseStatus(): StatusNode {
    this.expectKeyword("status");
    return { type: "status" };
  }

  private parseExport(): ExportNode {
    this.expectKeyword("export");
    this.expectKeyword("dsl");

    const next = this.peek();
    if (!next || (next.type === "keyword" && next.value === "then")) {
      return {
        type: "export",
        format: "dsl",
        section: "all",
      };
    }

    const section = this.expectOneOfKeywords(["all", "intent", "policy", "plans"]) as ExportSection;
    return {
      type: "export",
      format: "dsl",
      section,
    };
  }

  private expectKeyword(expected: string): void {
    const token = this.take();
    if (!token || token.type !== "keyword" || token.value !== expected) {
      const found = token ? `${token.type}:${token.value}` : "<end>";
      throw new Error(`Expected keyword '${expected}', found ${found}`);
    }
  }

  private expectOneOfKeywords(expected: string[]): string {
    const token = this.take();
    if (!token || token.type !== "keyword" || !expected.includes(token.value)) {
      const found = token ? `${token.type}:${token.value}` : "<end>";
      throw new Error(`Expected one of [${expected.join(", ")}], found ${found}`);
    }

    return token.value;
  }

  private expectString(): string {
    const token = this.take();
    if (!token || token.type !== "string") {
      const found = token ? `${token.type}:${token.value}` : "<end>";
      throw new Error(`Expected quoted string, found ${found}`);
    }

    return token.value;
  }

  private expectIdentifier(): string {
    const token = this.take();
    if (!token || token.type !== "identifier") {
      const found = token ? `${token.type}:${token.value}` : "<end>";
      throw new Error(`Expected identifier, found ${found}`);
    }

    if (!IDENTIFIER_PATTERN.test(token.value)) {
      throw new Error(`Invalid identifier: ${token.value}`);
    }

    return token.value;
  }

  private consumeKeyword(value: string): boolean {
    const token = this.peek();
    if (!token || token.type !== "keyword" || token.value !== value) {
      return false;
    }

    this.index += 1;
    return true;
  }

  private expectEnd(): void {
    if (this.peek()) {
      const token = this.peek() as Token;
      throw new Error(`Unexpected token after command: ${token.type}:${token.value}`);
    }
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private take(): Token | undefined {
    const token = this.tokens[this.index];
    if (token) {
      this.index += 1;
    }
    return token;
  }
}

export function parse(tokens: Token[]): AST {
  return new Parser(tokens).parse();
}

function validateActionNode(node: ActionNode): boolean {
  if (node.type === "define") {
    return (node.defineType === "goal" || node.defineType === "constraint" || node.defineType === "non-goal")
      && typeof node.value === "string"
      && node.value.length > 0;
  }

  if (node.type === "analyze") {
    return node.target === "workspace" || node.target === "violations" || node.target === "hotspots";
  }

  if (node.type === "plan") {
    return node.target === undefined || (typeof node.target === "string" && node.target.length > 0);
  }

  if (node.type === "preview" || node.type === "execute") {
    return node.planRef === undefined || IDENTIFIER_PATTERN.test(node.planRef.identifier);
  }

  if (node.type === "export") {
    return node.format === "dsl"
      && (node.section === "all" || node.section === "intent" || node.section === "policy" || node.section === "plans");
  }

  return node.type === "status";
}

export function validGrammar(ast: AST): boolean {
  if (ast.type === "sequence") {
    return ast.actions.length > 0 && ast.actions.every((action) => validateActionNode(action));
  }

  return validateActionNode(ast);
}

export function enforceCapabilities(role: RoleName, action: CapabilityAction): void {
  const allowed = CAPABILITY_RULES[role] ?? [];
  if (!allowed.includes(action)) {
    throw new Error(`Capability violation: ${role} cannot ${action}`);
  }
}

type CompilationTrace = {
  rolesInvoked: string[];
  steps: string[];
  compiledActions: string[];
};

async function compileAction<TContext>(
  handlers: RouterRoleHandlers<TContext>,
  action: ActionNode,
  context: TContext,
  trace: CompilationTrace
): Promise<void> {
  switch (action.type) {
    case "define":
      await handlers.architect.define(action, context);
      trace.rolesInvoked.push("architect");
      trace.steps.push("architect.define");
      trace.compiledActions.push("architect.define");
      return;

    case "analyze":
      await handlers.analyst.analyze(action, context);
      trace.rolesInvoked.push("analyst");
      trace.steps.push("analyst.analyze");
      trace.compiledActions.push("analyst.analyze");
      return;

    case "plan":
      await handlers.conductor.plan(action, context);
      trace.rolesInvoked.push("conductor");
      trace.steps.push("conductor.plan");
      trace.compiledActions.push("conductor.plan");
      return;

    case "preview":
      await handlers.conductor.preview(action, context);
      trace.rolesInvoked.push("conductor");
      trace.steps.push("conductor.preview");
      trace.compiledActions.push("conductor.preview");
      return;

    case "execute":
      await handlers.conductor.execute(action, context);
      trace.rolesInvoked.push("conductor");
      trace.steps.push("conductor.execute");
      trace.compiledActions.push("conductor.execute");
      return;

    case "status":
      await handlers.analyst.status(context);
      trace.rolesInvoked.push("analyst");
      trace.steps.push("analyst.status");
      trace.compiledActions.push("analyst.status");
      return;

    case "export":
      trace.steps.push("system.export");
      trace.compiledActions.push("system.export.dsl");
      return;
  }
}

export async function compile<TContext>(
  ast: AST,
  handlers: RouterRoleHandlers<TContext>,
  context: TContext
): Promise<CompilationTrace> {
  const trace: CompilationTrace = {
    rolesInvoked: [],
    steps: [],
    compiledActions: [],
  };

  if (ast.type === "sequence") {
    for (const action of ast.actions) {
      await compileAction(handlers, action, context, trace);
    }
    return trace;
  }

  await compileAction(handlers, ast, context, trace);
  return trace;
}

export function parseCommand(input: string): { tokens: Token[]; ast: AST } {
  const tokens = tokenize(input);
  const ast = parse(tokens);
  if (!validGrammar(ast)) {
    throw new Error("Invalid Choir DSL command");
  }

  return { tokens, ast };
}

export class ChoirAgent<TContext> {
  constructor(private readonly handlers: RouterRoleHandlers<TContext>) {}

  async handle(input: string, context: TContext): Promise<RouterTrace> {
    const trimmed = input.trim();
    const parsed = parseCommand(trimmed);
    const compiled = await compile(parsed.ast, this.handlers, context);

    return {
      intent: parsed.ast.type,
      rolesInvoked: compiled.rolesInvoked,
      steps: compiled.steps,
      decisions: [
        "Parsed using strict Choir DSL grammar",
        "Compiled DSL AST into deterministic role actions",
      ],
      dslTrace: {
        input: trimmed,
        tokens: parsed.tokens,
        ast: parsed.ast,
        compiledAction: compiled.compiledActions.join(" -> "),
      },
    };
  }
}
