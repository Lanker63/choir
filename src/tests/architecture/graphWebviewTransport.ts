import assert from "assert";
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const graphProviderPath = path.join(repoRoot, "src", "vscode", "GraphViewProvider.ts");
const source = fs.readFileSync(graphProviderPath, "utf-8");

assert.ok(
  source.includes('const scriptPath = path.join(this.context.extensionPath, "media", "graphPanel.js");')
    && source.includes('<script nonce="${nonce}" src="${scriptUri}"></script>'),
  "Dependency Graph webview must load runtime from external media/graphPanel.js script."
);

assert.ok(
  !source.includes("<script nonce=\"${nonce}\">") && !source.includes("const vscode = acquireVsCodeApi();"),
  "Dependency Graph webview must avoid embedding inline runtime script in provider HTML."
);

process.stdout.write("PASS dependency graph webview transport regression\\n");
