import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";

export class RuleEditorProvider implements vscode.WebviewViewProvider {
  constructor(private context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = {
      enableScripts: true,
    };

    view.webview.html = this.getHtml(view.webview);

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
        import("../core/pipeline"),
        import("../dsl/loader"),
        import("../dsl/compiler"),
        import("../rules/registry"),
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

    const nonce = getNonce();

    html = html
      .replace(/__SCRIPT_URI__/g, scriptUri.toString())
      .replace(/__STYLE_URI__/g, styleUri.toString())
      .replace(/__NONCE__/g, nonce);

    return html;
  }
}

function getNonce() {
  return Math.random().toString(36).substring(2);
}
