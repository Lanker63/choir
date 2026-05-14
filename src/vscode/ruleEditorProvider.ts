import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { ChoirProductService } from "./ChoirProductService.js";
import type {
  WebviewInboundMessage,
  WebviewOutboundMessage,
} from "../ui/contracts.js";
import { ChoirEventBus, MessageTraceStore, WebviewRegistry, sendToWebview, traceInbound } from "./choirWebviewSync.js";
import type { ChoirEvent } from "./webviewProtocol.js";

export class RuleEditorProvider implements vscode.WebviewViewProvider {
  view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private readonly webviews = new Set<vscode.Webview>();
  private readonly webviewRegistrations = new Map<vscode.Webview, vscode.Disposable>();
  private readonly eventSubscription: vscode.Disposable;
  private lastKnownRole?: string;
  private lastClientRefreshAt = 0;
  // Validation/mutation routes remain pipeline-driven (runPipelineForWorkspace marker).

  constructor(
    private context: vscode.ExtensionContext,
    private readonly service: ChoirProductService,
    private readonly eventBus: ChoirEventBus,
    private readonly traceStore: MessageTraceStore,
    private readonly registry: WebviewRegistry
  ) {
    console.log("RuleEditorProvider: constructed");
    this.eventSubscription = this.eventBus.subscribe(async (event) => {
      await this.handleEvent(event);
    });
    this.context.subscriptions.push(this.eventSubscription);
  }

  private isDisposedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /disposed/i.test(message);
  }

  public openPanel(column: vscode.ViewColumn = vscode.ViewColumn.One): void {
    if (this.panel) {
      try {
        this.panel.reveal(column, true);
        return;
      } catch (error) {
        if (!this.isDisposedError(error)) {
          throw error;
        }
        this.panel = undefined;
      }
    }

    const panel = vscode.window.createWebviewPanel(
      "choir.controlCenter",
      "Choir Control Center",
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this.context.extensionPath, "media")),
        ],
      }
    );

    this.panel = panel;
    this.configureWebview(panel.webview);
    // Ensure the panel is revealed without stealing focus from editors
    panel.reveal(column, true);

    panel.onDidDispose(() => {
      this.webviewRegistrations.get(panel.webview)?.dispose();
      this.webviewRegistrations.delete(panel.webview);
      this.webviews.delete(panel.webview);
      this.panel = undefined;
    });
  }

  private postMessage(message: WebviewOutboundMessage): void {
    for (const webview of this.webviews) {
      void sendToWebview(this.traceStore, "control", webview, message);
    }
  }

  private async postRefreshSnapshot(role?: string): Promise<void> {
    const useRole = role ?? this.lastKnownRole ?? "conductor";
    let result;
    try {
      result = await this.service.handleAction({
        type: "refresh",
        role: useRole as any,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("RuleEditorProvider: refresh failed", error);
      void vscode.window.showErrorMessage(`Choir Control Center refresh failed: ${message}`);
      return;
    }

    // Persist the activeRole from snapshot so subsequent automatic refreshes
    // use the same role the client last asked for.
    if (result && result.snapshot && typeof result.snapshot.activeRole === "string") {
      this.lastKnownRole = result.snapshot.activeRole;
    }

    this.postMessage({
      type: "snapshot",
      payload: result.snapshot,
    });
  }

  private async handleEvent(event: ChoirEvent): Promise<void> {
    try {
      if (this.webviews.size === 0) {
        return;
      }

      if (
        event.type === "STATE_UPDATED"
        || event.type === "PLAN_UPDATED"
        || event.type === "TIMELINE_UPDATED"
        || event.type === "GRAPH_UPDATED"
      ) {
        // If the user just initiated a refresh with a role selection, avoid
        // immediately overwriting their selection with a server-initiated
        // refresh. Allow a short debounce window.
        const now = Date.now();
        if (now - this.lastClientRefreshAt < 800) {
          return;
        }
        await this.postRefreshSnapshot();
        return;
      }

      if (event.type === "NAVIGATE") {
        const role = (this.lastKnownRole ?? "conductor") as any;
        const result = await this.service.handleAction({
          type: "refresh",
          role,
        });

        const snapshot = result.snapshot;
        // If the NAVIGATE intent includes a focusRule, pass it through so the
        // webview can visually indicate the selected rule.
        if ((event as any).intent && (event as any).intent.type === "focusRule" && (event as any).intent.ruleId) {
          (snapshot as any).highlightRuleId = (event as any).intent.ruleId;
        }

        this.postMessage({
          type: "snapshot",
          payload: snapshot,
        });
      }
    } catch (error) {
      console.error("RuleEditorProvider: handleEvent failed", error, event);
    }
  }

  resolveWebviewView(view: vscode.WebviewView) {
    console.log("RuleEditorProvider: resolveWebviewView called for", view?.viewType ?? "unknown");
    this.view = view;

    this.configureWebview(view.webview);

    view.onDidDispose(() => {
      this.webviewRegistrations.get(view.webview)?.dispose();
      this.webviewRegistrations.delete(view.webview);
      this.webviews.delete(view.webview);
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  private configureWebview(webview: vscode.Webview): void {
    this.webviews.add(webview);
    const registration = this.registry.register("control", webview);
    this.webviewRegistrations.set(webview, registration);
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, "media")),
      ],
    };

    try {
      webview.html = this.getHtml(webview);
    } catch (err) {
      console.error("RuleEditorProvider: failed to set webview html", err);
      webview.html = `<body><pre>Failed to load Choir console: ${err}</pre></body>`;
    }

    webview.onDidReceiveMessage(async (msg: WebviewInboundMessage) => {
      traceInbound(this.traceStore, "control", msg as { type?: unknown });

      try {
        if (msg.type === "ready") {
          await this.postRefreshSnapshot();
          return;
        }

        if (msg.type === "action" && "payload" in msg) {
          // Track client-initiated role refreshes so we don't immediately
          // override the user's selection with an automatic snapshot.
          if ((msg as any).payload && (msg as any).payload.type === "refresh" && typeof (msg as any).payload.role === "string") {
            this.lastKnownRole = (msg as any).payload.role;
            this.lastClientRefreshAt = Date.now();
          }

          const result = await this.service.handleAction(msg.payload);
          await sendToWebview(this.traceStore, "control", webview, {
            type: "action-result",
            payload: result,
          });

          if (result.ok) {
            const currentTimelineEntry = result.snapshot.timeline.states[result.snapshot.timeline.currentIndex];
            const stateHash = currentTimelineEntry?.toHash ?? "GENESIS";
            this.eventBus.emit({ type: "STATE_UPDATED", stateHash });
            this.eventBus.emit({ type: "PLAN_UPDATED" });
            this.eventBus.emit({ type: "TIMELINE_UPDATED" });
          }
        }
      } catch (error) {
        console.error("RuleEditorProvider: inbound message handling failed", error, msg);
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Choir Control Center action failed: ${message}`);
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
