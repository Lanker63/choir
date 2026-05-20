import assert from "assert";
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const timelineProviderPath = path.join(repoRoot, "src", "vscode", "TimelineViewProvider.ts");
const source = fs.readFileSync(timelineProviderPath, "utf-8");

assert.ok(
  source.includes("strategic.textContent = strategicLines.join('\\\\n');"),
  "Timeline webview script must use escaped newline \\n so generated HTML stays syntactically valid."
);

process.stdout.write("PASS timeline webview newline escaping regression\n");
