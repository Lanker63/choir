import assert from "assert";
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const files = [
  path.join(repoRoot, "src", "vscode", "ruleEditorProvider.ts"),
  path.join(repoRoot, "src", "vscode", "TimelineViewProvider.ts"),
  path.join(repoRoot, "src", "vscode", "GraphViewProvider.ts"),
  path.join(repoRoot, "src", "vscode", "PipelineDiagnosticsViewProvider.ts"),
];

for (const filePath of files) {
  const source = fs.readFileSync(filePath, "utf-8");

  assert.ok(
    !source.includes("onDidDispose(() => {\n      this.webviewRegistrations.get(panel.webview)")
      && !source.includes("onDidDispose(() => {\n      this.webviewRegistrations.get(view.webview)"),
    `Dispose handlers must not dereference panel/view webview properties during teardown: ${path.basename(filePath)}`
  );
}

process.stdout.write("PASS webview dispose lifecycle safety regression\\n");
