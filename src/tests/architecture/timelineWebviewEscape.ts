import assert from "assert";
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const timelineProviderPath = path.join(repoRoot, "src", "vscode", "TimelineViewProvider.ts");
const source = fs.readFileSync(timelineProviderPath, "utf-8");

assert.ok(
  source.includes('const scriptPath = path.join(this.context.extensionPath, "media", "timelinePanel.js");')
    && source.includes('<script nonce="${nonce}" src="${scriptUri}"></script>'),
  "Timeline webview must load runtime from external media/timelinePanel.js script."
);

assert.ok(
  !source.includes("<script nonce=\"${nonce}\">") && !source.includes("const vscode = acquireVsCodeApi();"),
  "Timeline webview must avoid embedding inline runtime script in provider HTML."
);

process.stdout.write("PASS timeline webview transport regression\n");
