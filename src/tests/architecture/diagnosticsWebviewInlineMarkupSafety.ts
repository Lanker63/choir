import assert from "assert";
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const diagnosticsProviderPath = path.join(repoRoot, "src", "vscode", "PipelineDiagnosticsViewProvider.ts");
const source = fs.readFileSync(diagnosticsProviderPath, "utf-8");

assert.ok(
  source.includes('<div id="list" class="list"></div>'),
  "Diagnostics webview should not inline dynamic list markup into raw HTML."
);

assert.ok(
  source.includes('<div id="details" class="details"></div>'),
  "Diagnostics webview should not inline dynamic details markup into raw HTML."
);

assert.ok(
  !source.includes('${initialListMarkup}') && !source.includes('${initialDetailsMarkup}'),
  "Diagnostics webview must avoid inline dynamic state markup in the HTML template."
);

process.stdout.write("PASS diagnostics webview inline markup safety regression\\n");
