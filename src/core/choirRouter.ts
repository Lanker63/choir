export const CHOIR_DSL_GRAMMAR = `<command> ::= "choir" <action> ("then" <action>)*

<action> ::=
    <define>
  | <analyze>
  | <plan>
  | <preview>
  | <execute>
  | <status>
  | <export>
  | <approve>
  | <reject>
  | <policy-status>
  | <import>
  | <library>
  | <audit>
  | <macro>

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

<approve> ::= "approve" <identifier>

<reject> ::= "reject" <identifier>

<policy-status> ::= "policy" "status"

<import> ::= "import" <library-spec>

<library> ::= "library" "list"
            | "library" "install" <library-spec>
            | "library" "update" <identifier>
            | "library" "lock"

<library-spec> ::= <identifier> "@" <version-selector>

<version-selector> ::= MAJOR "." MINOR "." PATCH
                     | MAJOR "." MINOR "." "x"
                     | MAJOR "." "x"

<audit> ::= "audit" "log"
          | "audit" "report"
          | "audit" "query" [<audit-filters>]

<audit-filters> ::= <audit-filter> ("," <audit-filter>)*

<audit-filter> ::= ("role" | "environment" | "action" | "from" | "to") "=" (<identifier> | <string>)

<macro> ::= "macro" "list"
          | "macro" "show" <identifier>
          | "macro" <identifier> [<args>]

<args> ::= <key-value> ("," <key-value>)*

<key-value> ::= <identifier> "=" <string>

<plan-ref> ::= "plan" <identifier>

<string> ::= QUOTED_STRING

<identifier> ::= [a-zA-Z0-9._-]+`;

export type Token =
  | { type: "keyword"; value: string }
  | { type: "string"; value: string }
  | { type: "identifier"; value: string }
  | { type: "symbol"; value: "=" | "," | "@" };

export const CHOIR_ROOT_KEYWORD = "choir" as const;

export const CHOIR_ACTION_KEYWORDS = [
  "define",
  "analyze",
  "plan",
  "preview",
  "execute",
  "status",
  "export",
  "approve",
  "reject",
  "policy",
  "import",
  "library",
  "audit",
  "macro",
] as const;

export const CHOIR_MACRO_META_KEYWORDS = ["list", "show"] as const;
export const CHOIR_LIBRARY_META_KEYWORDS = ["list", "install", "update", "lock"] as const;
export const CHOIR_AUDIT_META_KEYWORDS = ["log", "report", "query"] as const;

export const CHOIR_DEFINE_TYPE_KEYWORDS = ["goal", "constraint", "non-goal"] as const;
export const CHOIR_ANALYZE_TARGET_KEYWORDS = ["workspace", "violations", "hotspots"] as const;
export const CHOIR_EXPORT_SECTION_KEYWORDS = ["all", "intent", "policy", "plans"] as const;
export const CHOIR_SEQUENCE_KEYWORD = "then" as const;
export const CHOIR_PLAN_REF_KEYWORD = "plan" as const;
export const CHOIR_PLAN_FOR_KEYWORD = "for" as const;
export const CHOIR_EXPORT_FORMAT_KEYWORD = "dsl" as const;
export const CHOIR_POLICY_STATUS_KEYWORD = "status" as const;
export const CHOIR_LIBRARY_AT_SYMBOL = "@" as const;
export const CHOIR_VERSION_SELECTOR_PATTERN = /^(?:\d+\.\d+\.\d+|\d+\.\d+\.x|\d+\.x)$/;

const KEYWORDS = new Set<string>([
  CHOIR_ROOT_KEYWORD,
  ...CHOIR_ACTION_KEYWORDS,
  ...CHOIR_LIBRARY_META_KEYWORDS,
  ...CHOIR_AUDIT_META_KEYWORDS,
  ...CHOIR_DEFINE_TYPE_KEYWORDS,
  ...CHOIR_ANALYZE_TARGET_KEYWORDS,
  CHOIR_PLAN_FOR_KEYWORD,
  CHOIR_EXPORT_FORMAT_KEYWORD,
  ...CHOIR_EXPORT_SECTION_KEYWORDS,
  CHOIR_SEQUENCE_KEYWORD,
]);

export const CHOIR_IDENTIFIER_PATTERN = /^[a-zA-Z0-9._-]+$/;

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

export type ApproveNode = {
  type: "approve";
  diffId: string;
};

export type RejectNode = {
  type: "reject";
  diffId: string;
};

export type PolicyStatusNode = {
  type: "policy-status";
};

export type ImportLibraryNode = {
  type: "import-library";
  library: string;
  versionSelector: string;
};

export type LibraryListNode = {
  type: "library-list";
};

export type LibraryInstallNode = {
  type: "library-install";
  library: string;
  versionSelector: string;
};

export type LibraryUpdateNode = {
  type: "library-update";
  library: string;
};

export type LibraryLockNode = {
  type: "library-lock";
};

export type AuditQueryFilters = {
  role?: string;
  environment?: string;
  action?: string;
  from?: string;
  to?: string;
};

export type AuditLogNode = {
  type: "audit-log";
};

export type AuditReportNode = {
  type: "audit-report";
};

export type AuditQueryNode = {
  type: "audit-query";
  filters: AuditQueryFilters;
};

export type MacroListNode = {
  type: "macro-list";
};

export type MacroShowNode = {
  type: "macro-show";
  macroId: string;
};

export type MacroRunNode = {
  type: "macro-run";
  macroId: string;
  args: Record<string, string>;
};

export type ActionNode =
  | DefineNode
  | AnalyzeNode
  | PlanNode
  | PreviewNode
  | ExecuteNode
  | StatusNode
  | ExportNode
  | ApproveNode
  | RejectNode
  | PolicyStatusNode
  | ImportLibraryNode
  | LibraryListNode
  | LibraryInstallNode
  | LibraryUpdateNode
  | LibraryLockNode
  | AuditLogNode
  | AuditReportNode
  | AuditQueryNode
  | MacroListNode
  | MacroShowNode
  | MacroRunNode;

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
  return /[a-zA-Z0-9_.-]/.test(value);
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

    if (char === "=" || char === "," || char === "@") {
      tokens.push({ type: "symbol", value: char });
      cursor += 1;
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
      case "approve":
        return this.parseApprove();
      case "reject":
        return this.parseReject();
      case "policy":
        return this.parsePolicyStatus();
      case "import":
        return this.parseImportLibrary();
      case "library":
        return this.parseLibrary();
      case "audit":
        return this.parseAudit();
      case "macro":
        return this.parseMacro();
      default:
        throw new Error(`Unsupported Choir DSL action: ${next.value}`);
    }
  }

  private parseMacro(): MacroListNode | MacroShowNode | MacroRunNode {
    this.expectKeyword("macro");

    const next = this.peek();
    if (!next || (next.type === "keyword" && next.value === "then")) {
      throw new Error("Expected macro id or 'list'|'show' after 'macro'");
    }

    const nextValue = next.value.toLowerCase();

    if ((next.type === "identifier" || next.type === "keyword") && nextValue === "list") {
      this.take();
      return { type: "macro-list" };
    }

    if ((next.type === "identifier" || next.type === "keyword") && nextValue === "show") {
      this.take();
      return {
        type: "macro-show",
        macroId: this.expectIdentifier(),
      };
    }

    const macroId = this.expectIdentifier();
    const args: Record<string, string> = {};

    while (true) {
      const current = this.peek();
      if (!current || (current.type === "keyword" && current.value === "then")) {
        break;
      }

      const key = this.expectIdentifierLike();
      this.expectSymbol("=");
      const value = this.expectString();

      if (Object.prototype.hasOwnProperty.call(args, key)) {
        throw new Error(`Duplicate macro argument: ${key}`);
      }

      args[key] = value;

      if (!this.consumeSymbol(",")) {
        const afterArg = this.peek();
        if (!afterArg || (afterArg.type === "keyword" && afterArg.value === "then")) {
          break;
        }

        throw new Error("Expected ',' between macro arguments");
      }
    }

    return {
      type: "macro-run",
      macroId,
      args,
    };
  }

  private parseDefine(): DefineNode {
    this.expectKeyword("define");
    const defineType = this.expectOneOfKeywords([...CHOIR_DEFINE_TYPE_KEYWORDS]) as DefineType;
    const value = this.expectString();

    return {
      type: "define",
      defineType,
      value,
    };
  }

  private parseAnalyze(): AnalyzeNode {
    this.expectKeyword("analyze");
    const target = this.expectOneOfKeywords([...CHOIR_ANALYZE_TARGET_KEYWORDS]) as AnalyzeTarget;

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

    const section = this.expectOneOfKeywords([...CHOIR_EXPORT_SECTION_KEYWORDS]) as ExportSection;
    return {
      type: "export",
      format: "dsl",
      section,
    };
  }

  private parseApprove(): ApproveNode {
    this.expectKeyword("approve");
    return {
      type: "approve",
      diffId: this.expectIdentifier(),
    };
  }

  private parseReject(): RejectNode {
    this.expectKeyword("reject");
    return {
      type: "reject",
      diffId: this.expectIdentifier(),
    };
  }

  private parsePolicyStatus(): PolicyStatusNode {
    this.expectKeyword("policy");
    this.expectKeyword("status");
    return { type: "policy-status" };
  }

  private parseLibrarySpec(): { library: string; versionSelector: string } {
    const library = this.expectIdentifierLike();
    this.expectSymbol("@");
    const versionSelector = this.expectIdentifierLike();

    if (!CHOIR_VERSION_SELECTOR_PATTERN.test(versionSelector)) {
      throw new Error(`Invalid library version selector: ${versionSelector}`);
    }

    return {
      library,
      versionSelector,
    };
  }

  private parseImportLibrary(): ImportLibraryNode {
    this.expectKeyword("import");
    const spec = this.parseLibrarySpec();
    return {
      type: "import-library",
      library: spec.library,
      versionSelector: spec.versionSelector,
    };
  }

  private parseLibrary(): LibraryListNode | LibraryInstallNode | LibraryUpdateNode | LibraryLockNode {
    this.expectKeyword("library");
    const mode = this.expectIdentifierLike().toLowerCase();

    if (mode === "list") {
      return { type: "library-list" };
    }

    if (mode === "install") {
      const spec = this.parseLibrarySpec();
      return {
        type: "library-install",
        library: spec.library,
        versionSelector: spec.versionSelector,
      };
    }

    if (mode === "update") {
      return {
        type: "library-update",
        library: this.expectIdentifierLike(),
      };
    }

    if (mode === "lock") {
      return { type: "library-lock" };
    }

    throw new Error("Expected library command: list|install|update|lock");
  }

  private parseAudit(): AuditLogNode | AuditReportNode | AuditQueryNode {
    this.expectKeyword("audit");
    const mode = this.expectIdentifierLike().toLowerCase();

    if (mode === "log") {
      return { type: "audit-log" };
    }

    if (mode === "report") {
      return { type: "audit-report" };
    }

    if (mode !== "query") {
      throw new Error("Expected audit command: log|report|query");
    }

    const filters: AuditQueryFilters = {};

    while (true) {
      const next = this.peek();
      if (!next || (next.type === "keyword" && next.value === "then")) {
        break;
      }

      const key = this.expectIdentifierLike().toLowerCase();
      if (key !== "role" && key !== "environment" && key !== "action" && key !== "from" && key !== "to") {
        throw new Error(`Unsupported audit query filter: ${key}`);
      }

      this.expectSymbol("=");
      const value = this.expectIdentifierLikeOrString();

      if (Object.prototype.hasOwnProperty.call(filters, key)) {
        throw new Error(`Duplicate audit query filter: ${key}`);
      }

      filters[key] = value;

      if (!this.consumeSymbol(",")) {
        const afterFilter = this.peek();
        if (!afterFilter || (afterFilter.type === "keyword" && afterFilter.value === "then")) {
          break;
        }

        throw new Error("Expected ',' between audit query filters");
      }
    }

    return {
      type: "audit-query",
      filters,
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

    if (!CHOIR_IDENTIFIER_PATTERN.test(token.value)) {
      throw new Error(`Invalid identifier: ${token.value}`);
    }

    return token.value;
  }

  private expectIdentifierLike(): string {
    const token = this.take();
    if (!token || (token.type !== "identifier" && token.type !== "keyword")) {
      const found = token ? `${token.type}:${token.value}` : "<end>";
      throw new Error(`Expected identifier, found ${found}`);
    }

    if (!CHOIR_IDENTIFIER_PATTERN.test(token.value)) {
      throw new Error(`Invalid identifier: ${token.value}`);
    }

    return token.value;
  }

  private expectIdentifierLikeOrString(): string {
    const token = this.take();
    if (!token) {
      throw new Error("Expected identifier or quoted string, found <end>");
    }

    if (token.type === "string") {
      return token.value;
    }

    if (token.type === "identifier" || token.type === "keyword") {
      if (!CHOIR_IDENTIFIER_PATTERN.test(token.value)) {
        throw new Error(`Invalid identifier: ${token.value}`);
      }

      return token.value;
    }

    throw new Error(`Expected identifier or quoted string, found ${token.type}:${token.value}`);
  }

  private expectSymbol(expected: "=" | "," | "@"): void {
    const token = this.take();
    if (!token || token.type !== "symbol" || token.value !== expected) {
      const found = token ? `${token.type}:${token.value}` : "<end>";
      throw new Error(`Expected symbol '${expected}', found ${found}`);
    }
  }

  private consumeKeyword(value: string): boolean {
    const token = this.peek();
    if (!token || token.type !== "keyword" || token.value !== value) {
      return false;
    }

    this.index += 1;
    return true;
  }

  private consumeSymbol(value: "=" | "," | "@"): boolean {
    const token = this.peek();
    if (!token || token.type !== "symbol" || token.value !== value) {
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
    return node.planRef === undefined || CHOIR_IDENTIFIER_PATTERN.test(node.planRef.identifier);
  }

  if (node.type === "export") {
    return node.format === "dsl"
      && (node.section === "all" || node.section === "intent" || node.section === "policy" || node.section === "plans");
  }

  if (node.type === "approve" || node.type === "reject") {
    return CHOIR_IDENTIFIER_PATTERN.test(node.diffId);
  }

  if (node.type === "policy-status") {
    return true;
  }

  if (node.type === "import-library") {
    return CHOIR_IDENTIFIER_PATTERN.test(node.library) && CHOIR_VERSION_SELECTOR_PATTERN.test(node.versionSelector);
  }

  if (node.type === "library-list" || node.type === "library-lock") {
    return true;
  }

  if (node.type === "library-install") {
    return CHOIR_IDENTIFIER_PATTERN.test(node.library) && CHOIR_VERSION_SELECTOR_PATTERN.test(node.versionSelector);
  }

  if (node.type === "library-update") {
    return CHOIR_IDENTIFIER_PATTERN.test(node.library);
  }

  if (node.type === "audit-log" || node.type === "audit-report") {
    return true;
  }

  if (node.type === "audit-query") {
    const allowed = new Set(["role", "environment", "action", "from", "to"]);
    for (const [key, value] of Object.entries(node.filters)) {
      if (!allowed.has(key) || typeof value !== "string" || value.length === 0) {
        return false;
      }
    }

    return true;
  }

  if (node.type === "macro-list") {
    return true;
  }

  if (node.type === "macro-show") {
    return CHOIR_IDENTIFIER_PATTERN.test(node.macroId);
  }

  if (node.type === "macro-run") {
    if (!CHOIR_IDENTIFIER_PATTERN.test(node.macroId)) {
      return false;
    }

    const entries = Object.entries(node.args ?? {});
    return entries.every(([key, value]) => CHOIR_IDENTIFIER_PATTERN.test(key) && typeof value === "string");
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

    case "approve":
      trace.steps.push("system.policy.approve");
      trace.compiledActions.push("system.policy.approve");
      return;

    case "reject":
      trace.steps.push("system.policy.reject");
      trace.compiledActions.push("system.policy.reject");
      return;

    case "policy-status":
      trace.steps.push("system.policy.status");
      trace.compiledActions.push("system.policy.status");
      return;

    case "import-library":
      trace.steps.push("system.library.import");
      trace.compiledActions.push("system.library.import");
      return;

    case "library-list":
      trace.steps.push("system.library.list");
      trace.compiledActions.push("system.library.list");
      return;

    case "library-install":
      trace.steps.push("system.library.install");
      trace.compiledActions.push("system.library.install");
      return;

    case "library-update":
      trace.steps.push("system.library.update");
      trace.compiledActions.push("system.library.update");
      return;

    case "library-lock":
      trace.steps.push("system.library.lock");
      trace.compiledActions.push("system.library.lock");
      return;

    case "audit-log":
      trace.steps.push("system.audit.log");
      trace.compiledActions.push("system.audit.log");
      return;

    case "audit-report":
      trace.steps.push("system.audit.report");
      trace.compiledActions.push("system.audit.report");
      return;

    case "audit-query":
      trace.steps.push("system.audit.query");
      trace.compiledActions.push("system.audit.query");
      return;

    case "macro-list":
      trace.steps.push("system.macro.list");
      trace.compiledActions.push("system.macro.list");
      return;

    case "macro-show":
      trace.steps.push("system.macro.show");
      trace.compiledActions.push("system.macro.show");
      return;

    case "macro-run":
      trace.steps.push("system.macro.run");
      trace.compiledActions.push("system.macro.run");
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
