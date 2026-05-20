import assert from "assert";
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const diagnosticsProviderPath = path.join(repoRoot, "src", "vscode", "PipelineDiagnosticsViewProvider.ts");
const source = fs.readFileSync(diagnosticsProviderPath, "utf-8");

assert.ok(
  source.includes("const bootstrapSnapshotEncoded = \"") && source.includes("JSON.parse(atob(bootstrapSnapshotEncoded))"),
  "Diagnostics webview must transport bootstrap payload as encoded data and parse via JSON.parse(atob(...))."
);

assert.ok(
  !source.includes("const bootstrapSnapshot = ${bootstrapJson};"),
  "Diagnostics webview must not inject raw JSON directly into executable script context."
);

process.stdout.write("PASS diagnostics webview bootstrap transport regression\\n");
