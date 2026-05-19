export type CompilationTraceOutputChange = {
  field: string;
  before: unknown;
  after: unknown;
};

export type CompilationTraceOutput = {
  input: string;
  changes: CompilationTraceOutputChange[];
  ast: unknown;
};

export function formatCompilationTraceMarkdown(trace: CompilationTraceOutput): string {
  const astJson = JSON.stringify(trace.ast, null, 2);

  const changeLines = trace.changes.length === 0
    ? ["- changes: none"]
    : [
      "- changes:",
      ...trace.changes.map((change) => {
        const before = JSON.stringify(change.before);
        const after = JSON.stringify(change.after);
        return `  - ${change.field}: ${before} -> ${after}`;
      }),
    ];

  return [
    "",
    "---",
    "Compilation trace:",
    `- input: ${trace.input}`,
    ...changeLines,
    "- ast:",
    "```json",
    astJson,
    "```",
  ].join("\n");
}
