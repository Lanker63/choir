import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { resolveRulesPath } from "./rulesPath.js";
import yaml from "yaml";


export class RuleEditorProvider implements vscode.WebviewViewProvider {

  view?: vscode.WebviewView;
  private pendingDsl?: string;
  private selectedRuleId?: string;

  constructor(private context: vscode.ExtensionContext) {
    console.log("RuleEditorProvider: constructed");
  }

  private postDslToView(dsl: string) {
    if (!this.view) return;

    this.view.webview.postMessage({
      type: "setDSL",
      payload: { dsl },
    });
  }

  public setDslText(dsl: string) {
    this.pendingDsl = dsl;

    try {
      const parsed = yaml.parse(dsl);
      if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0]?.id === "string") {
        this.selectedRuleId = parsed[0].id;
      } else {
        this.selectedRuleId = undefined;
      }
    } catch {
      this.selectedRuleId = undefined;
    }

    if (this.view) {
      this.postDslToView(dsl);
    }
  }

  private async sendCurrentRules() {
    if (!this.view) return;

    if (this.pendingDsl) {
      console.log("Sending pending DSL to webview");
      this.postDslToView(this.pendingDsl);
    } else {
      console.log("RuleEditorProvider: no selected rule to preload");
    }
  }

  private getDefaultRulesPath(): string | null {
    const firstWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!firstWorkspace) {
      return null;
    }

    return path.join(firstWorkspace, ".choir", "rules.yaml");
  }

  private async saveDSL(dslText: string) {
    const rulesPath = resolveRulesPath() ?? this.getDefaultRulesPath();
    if (!rulesPath) {
      return {
        ok: false,
        error: "No workspace folder is open.",
      };
    }

    const previousContent = fs.existsSync(rulesPath)
      ? fs.readFileSync(rulesPath, "utf-8")
      : "";

    const tempPath = `${this.context.extensionPath}/.tmp.rules.save.yaml`;
    fs.writeFileSync(tempPath, dslText, "utf-8");

    const { loadDSLRules } = await import("../dsl/loader.js");
    const incomingRules = loadDSLRules(tempPath);

    const incomingRawParsed = yaml.parse(dslText);
    const incomingRawRules = Array.isArray(incomingRawParsed) ? incomingRawParsed : incomingRules;

    let mergedRules: any[] = incomingRawRules;
    let saveMode: "replace-one" | "append-one" | "replace-all" | "no-op" = "replace-all";
    if (incomingRules.length === 1) {
      let existingRules: any[] = [];
      if (fs.existsSync(rulesPath)) {
        try {
          const existingRawParsed = yaml.parse(previousContent);
          existingRules = Array.isArray(existingRawParsed) ? existingRawParsed : [];
        } catch {
          try {
            const fallbackParsed = yaml.parse(previousContent);
            existingRules = Array.isArray(fallbackParsed) ? fallbackParsed : [];
          } catch {
            existingRules = [];
          }
        }
      }

      const incomingRule = incomingRules[0];
      const incomingRawRule = Array.isArray(incomingRawRules) ? incomingRawRules[0] : incomingRule;
      const incomingId = typeof incomingRule?.id === "string" ? incomingRule.id : undefined;
      const selectedId = this.selectedRuleId;

      // Prefer matching incoming id; fallback to selected id to support id renames.
      const byIncomingIdIndex = incomingId
        ? existingRules.findIndex((rule: any) => rule?.id === incomingId)
        : -1;
      const bySelectedIdIndex = selectedId
        ? existingRules.findIndex((rule: any) => rule?.id === selectedId)
        : -1;
      const index = byIncomingIdIndex >= 0 ? byIncomingIdIndex : bySelectedIdIndex;

      if (index >= 0) {
        existingRules[index] = incomingRawRule;
        mergedRules = existingRules;
        saveMode = "replace-one";
      } else if (existingRules.length > 0) {
        existingRules.push(incomingRawRule);
        mergedRules = existingRules;
        saveMode = "append-one";
      }

      console.log("RuleEditorProvider: save merge", {
        rulesPath,
        incomingId,
        selectedId,
        byIncomingIdIndex,
        bySelectedIdIndex,
        finalIndex: index,
        mode: saveMode,
      });
    }

    const nextContent = yaml.stringify(mergedRules);
    const changed = previousContent !== nextContent;
    if (!changed) {
      saveMode = "no-op";
    }

    fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
    if (changed) {
      fs.writeFileSync(rulesPath, nextContent, "utf-8");
    }

    this.pendingDsl = dslText;
    if (incomingRules.length === 1 && typeof incomingRules[0]?.id === "string") {
      this.selectedRuleId = incomingRules[0].id;
    }
    await vscode.commands.executeCommand("choir.refreshRules");

    return {
      ok: true,
      path: rulesPath,
      mode: saveMode,
      changed,
      message: changed
        ? `Rules saved (${saveMode}) to ${rulesPath}`
        : `No file changes detected (${saveMode}) for ${rulesPath}`,
    };
  }

  resolveWebviewView(view: vscode.WebviewView) {
    console.log("RuleEditorProvider: resolveWebviewView called for", view?.viewType ?? "unknown");
    this.view = view;

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
      if (msg.type === "save") {
        try {
          const result = await this.saveDSL(msg.dsl);
          if (!result.ok) {
            view.webview.postMessage({
              type: "result",
              error: result.error,
            });
            return;
          }

          view.webview.postMessage({
            type: "saved",
            payload: result,
          });
        } catch (err: any) {
          view.webview.postMessage({
            type: "result",
            error: err?.message ?? String(err),
          });
        }
      }
      if (msg.type === "ready") {
        this.sendCurrentRules();
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
      if (!workspace) {
        return {
          ok: false,
          error: "No workspace folder is open.",
        };
      }

      const candidateRoots = [
        path.join(workspace, "examples"),
        path.join(workspace, "src"),
        workspace,
      ];

      const validationRoot = candidateRoots.find((candidate) => {
        try {
          return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      });

      if (!validationRoot) {
        return {
          ok: true,
          message: "DSL compiled successfully. No validation folder found.",
        };
      }

      console.log("Starting validation...", validationRoot);
      await runEnforcer(validationRoot);
      console.log("Validation completed.");

      return {
        ok: true,
        message: `DSL validated successfully against ${validationRoot}`,
      };
    } catch (err: any) {
      return {
        error: err.message,
      };
    }
  }

  getHtml(webview: vscode.Webview) {
    const mediaPath = path.join(this.context.extensionPath, "media");

    const htmlPath = path.join(mediaPath, "index.html");
    let html = fs.readFileSync(htmlPath, "utf-8");

    const scriptPath = path.join(mediaPath, "app.bundle.js");
    if (!fs.existsSync(scriptPath)) {
      throw new Error("Missing media/app.bundle.js. Run `npm run build:webview` before launching the extension.");
    }

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(scriptPath)
    );

    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(mediaPath, "app.css"))
    );

    const nonce = getNonce();
    const scriptUriWithVersion = `${scriptUri.toString()}?v=${nonce}`;
    const styleUriWithVersion = `${styleUri.toString()}?v=${nonce}`;

    html = html
      .replace(/__SCRIPT_URI__/g, scriptUriWithVersion)
      .replace(/__STYLE_URI__/g, styleUriWithVersion)
      .replace(/__NONCE__/g, nonce)
      .replace(/__CSP_SOURCE__/g, webview.cspSource);

    return html;
  }
}

function getNonce() {
  return Math.random().toString(36).substring(2);
}
