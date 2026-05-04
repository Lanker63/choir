import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";

export class RuleEditorProvider implements vscode.WebviewViewProvider {
  constructor(private context: vscode.ExtensionContext) {
    console.log("RuleEditorProvider: constructed");
  }

  resolveWebviewView(view: vscode.WebviewView) {
    console.log("RuleEditorProvider: resolveWebviewView called for", view?.viewType ?? "unknown");
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, "media")),
      ],
    };

    try {
      view.webview.html = this.getHtml(view.webview);
    } catch (err) {
      console.error("RuleEditorProvider: failed to set webview html", err);
      view.webview.html = `<body><pre>Failed to load rule editor: ${err}</pre></body>`;
    }

    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "validate") {
        const result = await this.validateDSL(msg.dsl);
        view.webview.postMessage({
          type: "result",
          payload: result,
        });
      }
    });
  }

  async validateDSL(dslText: string) {
    try {
      const tempPath = `${this.context.extensionPath}/.tmp.rules.yaml`;

      fs.writeFileSync(tempPath, dslText);

      const [{ runEnforcer }, { loadDSLRules }, { compileAndRegister }, { RuleRegistry }] = await Promise.all([
        import("../core/pipeline.js"),
        import("../dsl/loader.js"),
        import("../dsl/compiler.js"),
        import("../rules/registry.js"),
      ]);

      const registry = new RuleRegistry();
      const rules = loadDSLRules(tempPath);

      compileAndRegister(rules, registry);

      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      console.log("Starting validation...");
      const result = await runEnforcer(path.join(workspace!, "examples"));
      console.log("Validation completed.");

      return result;
    } catch (err: any) {
      return {
        error: err.message,
      };
    }
  }

  getHtml(webview: vscode.Webview) {
    const mediaPath = path.join(this.context.extensionPath, "media");

    const htmlPath = path.join(mediaPath, "ruleEditor.html");
    let html = fs.readFileSync(htmlPath, "utf-8");

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(mediaPath, "ruleEditor.js"))
    );

    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(mediaPath, "ruleEditor.css"))
    );

    const monacoUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(mediaPath, "monaco"))
    );

    const monacoYamlEntryPath = path.join(mediaPath, "monaco-yaml", "index.js");
    const hasMonacoYaml = fs.existsSync(monacoYamlEntryPath);

    const nonce = getNonce();

    html = html
      .replace(/__SCRIPT_URI__/g, scriptUri.toString())
      .replace(/__STYLE_URI__/g, styleUri.toString())
      .replace("__MONACO_BASE__", monacoUri.toString())
      .replace("__HAS_MONACO_YAML__", hasMonacoYaml ? "true" : "false")
      .replace(/__NONCE__/g, nonce)
      .replace(/__CSP_SOURCE__/g, webview.cspSource);

    return html;
  }
}

function getNonce() {
  return Math.random().toString(36).substring(2);
}
