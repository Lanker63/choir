import {
  CHOIR_ACTION_KEYWORDS,
  CHOIR_ANALYZE_TARGET_KEYWORDS,
  CHOIR_DEFINE_TYPE_KEYWORDS,
  CHOIR_EXPORT_FORMAT_KEYWORD,
  CHOIR_EXPORT_SECTION_KEYWORDS,
  CHOIR_IDENTIFIER_PATTERN,
  CHOIR_PLAN_FOR_KEYWORD,
  CHOIR_PLAN_REF_KEYWORD,
  CHOIR_POLICY_STATUS_KEYWORD,
  CHOIR_ROOT_KEYWORD,
  CHOIR_SEQUENCE_KEYWORD,
  Token,
  parseCommand,
} from "./choirRouter.js";

export type ChoirCompletionKind = "keyword" | "string" | "identifier";

export type ChoirCompletion = {
  kind: ChoirCompletionKind;
  label: string;
  insertText: string;
  detail: string;
};

export type ChoirLineValidation = {
  line: number;
  startCharacter: number;
  endCharacter: number;
  message: string;
};

type ParserState =
  | "expect-root"
  | "expect-action"
  | "define-type"
  | "define-string"
  | "analyze-target"
  | "plan-tail"
  | "plan-target-string"
  | "preview-tail"
  | "preview-id"
  | "execute-tail"
  | "execute-id"
  | "export-format"
  | "export-section-or-end"
  | "approve-id"
  | "reject-id"
  | "policy-status"
  | "expect-then-or-end";

type ExpectedTerminal =
  | { type: "keyword"; value: string }
  | { type: "string" }
  | { type: "identifier" };

type CompletionLexResult = {
  tokens: Token[];
  partial?: {
    kind: "word" | "string";
    value: string;
  };
  invalid: boolean;
};

const DSL_KEYWORDS = new Set<string>([
  CHOIR_ROOT_KEYWORD,
  ...CHOIR_ACTION_KEYWORDS,
  ...CHOIR_DEFINE_TYPE_KEYWORDS,
  ...CHOIR_ANALYZE_TARGET_KEYWORDS,
  CHOIR_PLAN_FOR_KEYWORD,
  CHOIR_PLAN_REF_KEYWORD,
  CHOIR_EXPORT_FORMAT_KEYWORD,
  ...CHOIR_EXPORT_SECTION_KEYWORDS,
  CHOIR_SEQUENCE_KEYWORD,
  CHOIR_POLICY_STATUS_KEYWORD,
]);

const KEYWORD_HOVER: Record<string, string> = {
  choir: "Command root token.",
  define: "Define intent (goal, constraint, non-goal).",
  goal: "Intent target: desired outcome.",
  constraint: "Intent guardrail: required rule.",
  "non-goal": "Intent exclusion: explicitly out of scope.",
  analyze: "Request deterministic analysis output.",
  workspace: "Analyze overall workspace structure.",
  violations: "Analyze policy or architecture violations.",
  hotspots: "Analyze high-risk change hotspots.",
  plan: "Create or reference an execution plan.",
  for: "Attach a quoted target to plan creation.",
  preview: "Preview pending plan execution.",
  execute: "Execute approved plan actions.",
  status: "Show runtime or policy status.",
  export: "Export DSL projection from YAML state.",
  dsl: "Export format selector.",
  all: "Export all representable DSL sections.",
  intent: "Export only intent section.",
  policy: "Export policy section or query policy status.",
  plans: "Export plan section.",
  approve: "Approve a pending policy-gated diff id.",
  reject: "Reject a pending policy-gated diff id.",
  then: "Deterministic sequence operator for action chaining.",
};

function isWordCharacter(char: string): boolean {
  return /[a-zA-Z0-9_-]/.test(char);
}

function stripCommentOutsideQuotes(input: string): string {
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (char === "#" && !inString) {
      return input.slice(0, i);
    }
  }

  return input;
}

function tokenizeForCompletion(input: string): CompletionLexResult {
  const source = stripCommentOutsideQuotes(input);
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const char = source[cursor];

    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }

    if (char === '"') {
      let ptr = cursor + 1;
      let value = "";
      let escaped = false;

      while (ptr < source.length) {
        const current = source[ptr];

        if (escaped) {
          value += current;
          escaped = false;
          ptr += 1;
          continue;
        }

        if (current === "\\") {
          escaped = true;
          ptr += 1;
          continue;
        }

        if (current === '"') {
          tokens.push({ type: "string", value });
          cursor = ptr + 1;
          value = "";
          break;
        }

        value += current;
        ptr += 1;
      }

      if (cursor < source.length && source[cursor] === '"') {
        return {
          tokens,
          partial: {
            kind: "string",
            value,
          },
          invalid: false,
        };
      }

      continue;
    }

    if (isWordCharacter(char)) {
      let end = cursor + 1;
      while (end < source.length && isWordCharacter(source[end])) {
        end += 1;
      }

      const raw = source.slice(cursor, end);
      const isTrailingToken = end === source.length;
      if (isTrailingToken) {
        return {
          tokens,
          partial: {
            kind: "word",
            value: raw,
          },
          invalid: false,
        };
      }

      const normalized = raw.toLowerCase();
      if (DSL_KEYWORDS.has(normalized)) {
        tokens.push({ type: "keyword", value: normalized });
      } else {
        tokens.push({ type: "identifier", value: raw });
      }

      cursor = end;
      continue;
    }

    return {
      tokens,
      invalid: true,
    };
  }

  return {
    tokens,
    invalid: false,
  };
}

function epsilonClosure(initial: Set<ParserState>): Set<ParserState> {
  const closure = new Set<ParserState>(initial);
  const queue: ParserState[] = [...initial];

  while (queue.length > 0) {
    const state = queue.shift() as ParserState;

    if (state === "plan-tail" || state === "preview-tail" || state === "execute-tail" || state === "export-section-or-end") {
      if (!closure.has("expect-then-or-end")) {
        closure.add("expect-then-or-end");
        queue.push("expect-then-or-end");
      }
    }
  }

  return closure;
}

function transition(state: ParserState, token: Token): ParserState[] {
  if (token.type === "string") {
    if (state === "define-string" || state === "plan-target-string") {
      return ["expect-then-or-end"];
    }
    return [];
  }

  if (token.type === "identifier") {
    if (state === "preview-id" || state === "execute-id" || state === "approve-id" || state === "reject-id") {
      return ["expect-then-or-end"];
    }
    return [];
  }

  if (state === "expect-root") {
    return token.value === CHOIR_ROOT_KEYWORD ? ["expect-action"] : [];
  }

  if (state === "expect-action") {
    if (!CHOIR_ACTION_KEYWORDS.includes(token.value as (typeof CHOIR_ACTION_KEYWORDS)[number])) {
      return [];
    }

    if (token.value === "define") {
      return ["define-type"];
    }
    if (token.value === "analyze") {
      return ["analyze-target"];
    }
    if (token.value === "plan") {
      return ["plan-tail"];
    }
    if (token.value === "preview") {
      return ["preview-tail"];
    }
    if (token.value === "execute") {
      return ["execute-tail"];
    }
    if (token.value === "status") {
      return ["expect-then-or-end"];
    }
    if (token.value === "export") {
      return ["export-format"];
    }
    if (token.value === "approve") {
      return ["approve-id"];
    }
    if (token.value === "reject") {
      return ["reject-id"];
    }

    return ["policy-status"];
  }

  if (state === "define-type") {
    return CHOIR_DEFINE_TYPE_KEYWORDS.includes(token.value as (typeof CHOIR_DEFINE_TYPE_KEYWORDS)[number])
      ? ["define-string"]
      : [];
  }

  if (state === "analyze-target") {
    return CHOIR_ANALYZE_TARGET_KEYWORDS.includes(token.value as (typeof CHOIR_ANALYZE_TARGET_KEYWORDS)[number])
      ? ["expect-then-or-end"]
      : [];
  }

  if (state === "plan-tail") {
    return token.value === CHOIR_PLAN_FOR_KEYWORD ? ["plan-target-string"] : [];
  }

  if (state === "preview-tail") {
    return token.value === CHOIR_PLAN_REF_KEYWORD ? ["preview-id"] : [];
  }

  if (state === "execute-tail") {
    return token.value === CHOIR_PLAN_REF_KEYWORD ? ["execute-id"] : [];
  }

  if (state === "export-format") {
    return token.value === CHOIR_EXPORT_FORMAT_KEYWORD ? ["export-section-or-end"] : [];
  }

  if (state === "export-section-or-end") {
    return CHOIR_EXPORT_SECTION_KEYWORDS.includes(token.value as (typeof CHOIR_EXPORT_SECTION_KEYWORDS)[number])
      ? ["expect-then-or-end"]
      : [];
  }

  if (state === "policy-status") {
    return token.value === CHOIR_POLICY_STATUS_KEYWORD ? ["expect-then-or-end"] : [];
  }

  if (state === "expect-then-or-end") {
    return token.value === CHOIR_SEQUENCE_KEYWORD ? ["expect-action"] : [];
  }

  return [];
}

function expectedForState(state: ParserState): ExpectedTerminal[] {
  if (state === "expect-root") {
    return [{ type: "keyword", value: CHOIR_ROOT_KEYWORD }];
  }

  if (state === "expect-action") {
    return CHOIR_ACTION_KEYWORDS.map((keyword) => ({ type: "keyword", value: keyword }));
  }

  if (state === "define-type") {
    return CHOIR_DEFINE_TYPE_KEYWORDS.map((keyword) => ({ type: "keyword", value: keyword }));
  }

  if (state === "define-string" || state === "plan-target-string") {
    return [{ type: "string" }];
  }

  if (state === "analyze-target") {
    return CHOIR_ANALYZE_TARGET_KEYWORDS.map((keyword) => ({ type: "keyword", value: keyword }));
  }

  if (state === "plan-tail") {
    return [{ type: "keyword", value: CHOIR_PLAN_FOR_KEYWORD }];
  }

  if (state === "preview-tail" || state === "execute-tail") {
    return [{ type: "keyword", value: CHOIR_PLAN_REF_KEYWORD }];
  }

  if (state === "preview-id" || state === "execute-id" || state === "approve-id" || state === "reject-id") {
    return [{ type: "identifier" }];
  }

  if (state === "export-format") {
    return [{ type: "keyword", value: CHOIR_EXPORT_FORMAT_KEYWORD }];
  }

  if (state === "export-section-or-end") {
    return CHOIR_EXPORT_SECTION_KEYWORDS.map((keyword) => ({ type: "keyword", value: keyword }));
  }

  if (state === "policy-status") {
    return [{ type: "keyword", value: CHOIR_POLICY_STATUS_KEYWORD }];
  }

  if (state === "expect-then-or-end") {
    return [{ type: "keyword", value: CHOIR_SEQUENCE_KEYWORD }];
  }

  return [];
}

function expectedTerminals(tokens: Token[]): ExpectedTerminal[] {
  let states = epsilonClosure(new Set<ParserState>(["expect-root"]));

  for (const token of tokens) {
    const nextStates = new Set<ParserState>();
    const closure = epsilonClosure(states);

    for (const state of closure) {
      for (const candidate of transition(state, token)) {
        nextStates.add(candidate);
      }
    }

    states = epsilonClosure(nextStates);
    if (states.size === 0) {
      return [];
    }
  }

  const closure = epsilonClosure(states);
  const seen = new Set<string>();
  const expected: ExpectedTerminal[] = [];

  for (const state of closure) {
    for (const terminal of expectedForState(state)) {
      const key = terminal.type === "keyword" ? `keyword:${terminal.value}` : terminal.type;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      expected.push(terminal);
    }
  }

  return expected;
}

function buildCompletionItems(expected: ExpectedTerminal[]): ChoirCompletion[] {
  const items: ChoirCompletion[] = [];

  for (const token of expected) {
    if (token.type === "keyword") {
      items.push({
        kind: "keyword",
        label: token.value,
        insertText: token.value,
        detail: "Choir DSL keyword",
      });
      continue;
    }

    if (token.type === "string") {
      items.push({
        kind: "string",
        label: '"value"',
        insertText: '"${1:value}"',
        detail: "Quoted string literal",
      });
      continue;
    }

    items.push({
      kind: "identifier",
      label: "identifier",
      insertText: "${1:identifier}",
      detail: "Identifier: [a-zA-Z0-9-_]+",
    });
  }

  return items;
}

function dedupeCompletions(items: ChoirCompletion[]): ChoirCompletion[] {
  const seen = new Set<string>();
  const output: ChoirCompletion[] = [];

  for (const item of items) {
    const key = `${item.kind}:${item.label}:${item.insertText}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }

  return output;
}

export function getDeterministicCompletions(linePrefix: string): ChoirCompletion[] {
  const lexed = tokenizeForCompletion(linePrefix);
  if (lexed.invalid) {
    return [];
  }

  const expected = expectedTerminals(lexed.tokens);
  if (expected.length === 0) {
    return [];
  }

  if (!lexed.partial) {
    return dedupeCompletions(buildCompletionItems(expected));
  }

  if (lexed.partial.kind === "string") {
    return expected.some((entry) => entry.type === "string")
      ? [{
        kind: "string",
        label: '"value"',
        insertText: '"${1:value}"',
        detail: "Quoted string literal",
      }]
      : [];
  }

  const prefix = lexed.partial.value.toLowerCase();
  const completions: ChoirCompletion[] = [];

  for (const token of expected) {
    if (token.type === "keyword" && token.value.startsWith(prefix)) {
      completions.push({
        kind: "keyword",
        label: token.value,
        insertText: token.value,
        detail: "Choir DSL keyword",
      });
      continue;
    }

    if (token.type === "identifier" && CHOIR_IDENTIFIER_PATTERN.test(lexed.partial.value)) {
      completions.push({
        kind: "identifier",
        label: "identifier",
        insertText: "${1:identifier}",
        detail: "Identifier: [a-zA-Z0-9-_]+",
      });
    }
  }

  return dedupeCompletions(completions);
}

export function validateChoirDocument(text: string): ChoirLineValidation[] {
  const diagnostics: ChoirLineValidation[] = [];
  const lines = text.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const withoutComment = stripCommentOutsideQuotes(line);
    const trimmed = withoutComment.trim();

    if (trimmed.length === 0) {
      continue;
    }

    const firstNonWhitespace = withoutComment.search(/\S/);
    const startCharacter = firstNonWhitespace >= 0 ? firstNonWhitespace : 0;

    try {
      parseCommand(trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        line: lineIndex,
        startCharacter,
        endCharacter: line.length,
        message,
      });
    }
  }

  return diagnostics;
}

export function getHoverTextForKeyword(keyword: string): string | undefined {
  return KEYWORD_HOVER[keyword.toLowerCase()];
}
