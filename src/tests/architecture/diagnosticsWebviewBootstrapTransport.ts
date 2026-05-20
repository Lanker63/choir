import assert from "assert";
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const diagnosticsProviderPath = path.join(repoRoot, "src", "vscode", "PipelineDiagnosticsViewProvider.ts");
const source = fs.readFileSync(diagnosticsProviderPath, "utf-8");

assert.ok(
  source.includes('const scriptPath = path.join(this.context.extensionPath, "media", "diagnosticsPanel.js");')
    && source.includes('<script nonce="${nonce}" src="${scriptUri}"></script>'),
  "Diagnostics webview must use an external script asset for runtime rendering."
);

assert.ok(
  !source.includes("bootstrapSnapshotEncoded") && !source.includes("JSON.parse(atob("),
  "Diagnostics webview should not inject bootstrap payload into inline script context."
);

process.stdout.write("PASS diagnostics webview bootstrap transport regression\\n");
