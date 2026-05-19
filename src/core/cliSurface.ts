import {
  CHOIR_ACTION_KEYWORDS,
  CHOIR_ROOT_KEYWORD,
} from "./choirRouter.js";

export const CLI_IN_SCOPE_CHAT_PIPELINE_OPERATIONS = [
  "init",
  "define",
  "analyze",
  "plan",
  "simulate",
  "preview",
  "execute",
  "rollback",
  "status",
  "export-dsl",
  "export-json",
  "approve",
  "reject",
  "policy-status",
  "refactor-rename",
  "refactor-move",
  "refactor-extract",
  "refactor-inline",
  "import-library",
  "library-list",
  "library-install",
  "library-update",
  "library-lock",
  "macro-list",
  "macro-show",
  "macro-run",
  "abstraction-list",
  "abstraction-describe",
  "abstraction-run",
  "audit-log",
  "audit-query",
  "audit-report",
  "ci-run",
  "verify",
  "remove-goal",
] as const;

export const CLI_EXCLUDED_VSCODE_CHAT_SHORTCUTS = [
  "panel-control",
  "panel-timeline",
  "cli-install-helper",
] as const;

export type CliInScopeOperationId = typeof CLI_IN_SCOPE_CHAT_PIPELINE_OPERATIONS[number];
export type CliExcludedOperationId = typeof CLI_EXCLUDED_VSCODE_CHAT_SHORTCUTS[number];

const EXCLUDED_SHORTCUTS = new Set<string>([
  "control",
  "timeline",
  "diagnostics",
]);

function stripRootKeyword(args: string[]): string[] {
  if (args.length === 0) {
    return [];
  }

  if (args[0]?.toLowerCase() === CHOIR_ROOT_KEYWORD) {
    return args.slice(1);
  }

  return args;
}

export function isCLIExcludedVSCodeShortcut(args: string[]): boolean {
  const normalized = stripRootKeyword(args).map((token) => token.toLowerCase());
  if (normalized.length === 0) {
    return false;
  }

  return EXCLUDED_SHORTCUTS.has(normalized[0] as string);
}

export function isChoirActionKeyword(token: string): boolean {
  return CHOIR_ACTION_KEYWORDS.includes(token as typeof CHOIR_ACTION_KEYWORDS[number]);
}
