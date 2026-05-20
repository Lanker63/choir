import assert from "assert";
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const diagnosticsProviderPath = path.join(repoRoot, "src", "vscode", "PipelineDiagnosticsViewProvider.ts");
const source = fs.readFileSync(diagnosticsProviderPath, "utf-8");

assert.ok(
  source.includes('.replace(/</g, "\\\\u003c")'),
  "Diagnostics bootstrap JSON must escape '<' to avoid script tag parsing issues."
);

assert.ok(
  source.includes('.replace(/\\u2028/g, "\\\\u2028")'),
  "Diagnostics bootstrap JSON must escape U+2028 line separators for inline script safety."
);

assert.ok(
  source.includes('.replace(/\\u2029/g, "\\\\u2029")'),
  "Diagnostics bootstrap JSON must escape U+2029 paragraph separators for inline script safety."
);

process.stdout.write("PASS diagnostics webview bootstrap escaping regression\\n");
