import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { resolveControlPlanePath } from "./rulesPath.js";
import { createDefaultControlPlane, readControlPlane, writeControlPlane } from "../choirManager.js";
import yaml from "yaml";
import { DSLRule } from "../dsl/types.js";


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

  private getDefaultControlPath(): string | null {
    const firstWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!firstWorkspace) {
      return null;
    }

    return path.join(firstWorkspace, ".choir", "choir.config.yaml");
  }

  private async saveDSL(dslText: string) {
    const controlPath = resolveControlPlanePath() ?? this.getDefaultControlPath();
    if (!controlPath) {
      return {
        ok: false,
        error: "No workspace folder is open.",
      };
    }

    const control = readControlPlane() ?? createDefaultControlPlane();
    const existingRules = Array.isArray(control.policy?.rules) ? control.policy.rules : [];
    const previousContent = yaml.stringify(existingRules);

    const tempPath = `${this.context.extensionPath}/.tmp.rules.save.yaml`;
    fs.writeFileSync(tempPath, dslText, "utf-8");

    const { loadDSLRules } = await import("../dsl/loader.js");
    const incomingRules = loadDSLRules(tempPath);

    let mergedRules: DSLRule[] = incomingRules;
    let saveMode: "replace-one" | "append-one" | "replace-all" | "no-op" = "replace-all";
    if (incomingRules.length === 1) {
      const existingTypedRules = [...existingRules];

      const incomingRule = incomingRules[0];
      const incomingId = typeof incomingRule?.id === "string" ? incomingRule.id : undefined;
      const selectedId = this.selectedRuleId;

      // Prefer matching incoming id; fallback to selected id to support id renames.
      const byIncomingIdIndex = incomingId
        ? existingTypedRules.findIndex((rule) => rule?.id === incomingId)
        : -1;
      const bySelectedIdIndex = selectedId
        ? existingTypedRules.findIndex((rule) => rule?.id === selectedId)
        : -1;
      const index = byIncomingIdIndex >= 0 ? byIncomingIdIndex : bySelectedIdIndex;

      if (index >= 0) {
        existingTypedRules[index] = incomingRule;
        mergedRules = existingTypedRules;
        saveMode = "replace-one";
      } else if (existingTypedRules.length > 0) {
        existingTypedRules.push(incomingRule);
        mergedRules = existingTypedRules;
        saveMode = "append-one";
      }

      console.log("RuleEditorProvider: save merge", {
        controlPath,
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

    fs.mkdirSync(path.dirname(controlPath), { recursive: true });
    if (changed) {
      writeControlPlane({
        ...control,
        policy: {
          ...control.policy,
          rules: incomingRules.length === 1 ? mergedRules : incomingRules,
        },
      });
    }

    this.pendingDsl = dslText;
    if (incomingRules.length === 1 && typeof incomingRules[0]?.id === "string") {
      this.selectedRuleId = incomingRules[0].id;
    }
    await vscode.commands.executeCommand("choir.refreshRules");

    return {
      ok: true,
      path: controlPath,
      mode: saveMode,
      changed,
      message: changed
        ? `Rules saved (${saveMode}) to ${controlPath}`
        : `No file changes detected (${saveMode}) for ${controlPath}`,
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

      const [{ loadDSLRules }, { runPipelineForWorkspace }] = await Promise.all([
        import("../dsl/loader.js"),
        import("../enforcer.js"),
      ]);

      const rules = loadDSLRules(tempPath);
      const baseControl = readControlPlane() ?? createDefaultControlPlane();
      const validationControl = {
        ...baseControl,
        policy: {
          ...baseControl.policy,
          rules,
        },
      };

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
      const result = await runPipelineForWorkspace({
        controlPlane: validationControl,
        root: validationRoot,
        publishResultDiagnostics: true,
      });
      console.log("Validation completed.");

      if (!result) {
        return {
          ok: false,
          error: "Unable to execute pipeline validation.",
        };
      }

      return {
        ok: true,
        message: `DSL validated against ${validationRoot}. Diagnostics: ${result.diagnostics.length}. State: ${result.statePath}`,
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
