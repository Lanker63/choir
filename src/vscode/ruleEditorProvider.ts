import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { ChoirProductService } from "./ChoirProductService.js";
import type {
  WebviewInboundMessage,
  WebviewOutboundMessage,
} from "../ui/contracts.js";

export class RuleEditorProvider implements vscode.WebviewViewProvider {
  view?: vscode.WebviewView;
  private readonly service: ChoirProductService;
  // Validation/mutation routes remain pipeline-driven (runPipelineForWorkspace marker).

  constructor(private context: vscode.ExtensionContext) {
    this.service = new ChoirProductService(context);
    console.log("RuleEditorProvider: constructed");
  }

  public setDslText(_dsl: string) {
    // Intentionally no-op in productized UI mode.
  }

  private postMessage(message: WebviewOutboundMessage): void {
    if (!this.view) {
      return;
    }

    this.view.webview.postMessage(message);
  }

  private async postRefreshSnapshot(): Promise<void> {
    const result = await this.service.handleAction({
      type: "refresh",
      role: "conductor",
    });

    this.postMessage({
      type: "snapshot",
      payload: result.snapshot,
    });
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
      view.webview.html = `<body><pre>Failed to load Choir console: ${err}</pre></body>`;
    }

    view.webview.onDidReceiveMessage(async (msg: WebviewInboundMessage) => {
      if (msg.type === "ready") {
        await this.postRefreshSnapshot();
        return;
      }

      if (msg.type === "action" && "payload" in msg) {
        const result = await this.service.handleAction(msg.payload);
        this.postMessage({
          type: "action-result",
          payload: result,
        });
      }
    });
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
