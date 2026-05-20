import fs from "fs";
import path from "path";
import * as vscode from "vscode";
import { getControlPlanePath, readControlPlane } from "../choirManager.js";
import { buildGraphSnapshot, type GraphMode, type GraphSnapshot } from "../core/dependencyGraphUi.js";
import { createEmptyStatePlane, readStatePlane } from "../core/state.js";
import { ChoirEventBus, MessageTraceStore, WebviewRegistry, sendToWebview, traceInbound } from "./choirWebviewSync.js";
import type { ChoirEvent } from "./webviewProtocol.js";

type GraphInboundMessage =
  | { type: "ready" }
  | { type: "refresh" | "request-state" }
  | { type: "open-node"; id?: string }
  | { type: "set-mode"; mode?: GraphMode; focusNodeId?: string };

type GraphOutboundMessage =
  | { type: "snapshot"; payload: GraphSnapshot }
  | { type: "error"; message: string };

function isGraphMode(value: unknown): value is GraphMode {
  return value === "full" || value === "focused" || value === "dependency" || value === "dependents";
}

function isDisposedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /disposed/i.test(message);
}

export class GraphViewProvider implements vscode.WebviewViewProvider {
  private panel?: vscode.WebviewPanel;
  private readonly webviews = new Set<vscode.Webview>();
  private readonly webviewRegistrations = new Map<vscode.Webview, vscode.Disposable>();
  private readonly eventSubscription: vscode.Disposable;
  private mode: GraphMode = "full";
  private focusNodeId: string | undefined;
  private lastSnapshot: GraphSnapshot | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly eventBus: ChoirEventBus,
    private readonly traceStore: MessageTraceStore,
    private readonly registry: WebviewRegistry,
    private readonly refreshWorkspace?: () => Promise<void>
  ) {
    this.eventSubscription = this.eventBus.subscribe(async (event) => {
      await this.handleEvent(event);
    });
    this.context.subscriptions.push(this.eventSubscription);
  }

  private releaseWebview(webview: vscode.Webview): void {
    this.webviewRegistrations.get(webview)?.dispose();
    this.webviewRegistrations.delete(webview);
    this.webviews.delete(webview);
  }

  async setMode(mode: GraphMode, focusNodeId?: string): Promise<void> {
    this.mode = mode;
    this.focusNodeId = typeof focusNodeId === "string" && focusNodeId.trim().length > 0
      ? focusNodeId.trim()
      : undefined;
    await this.postSnapshot();
    this.eventBus.emit({ type: "GRAPH_UPDATED" });
  }

  openPanel(column: vscode.ViewColumn = vscode.ViewColumn.One): void {
    if (this.panel) {
      try {
        this.panel.reveal(column, false);
        return;
      } catch (error) {
        if (!isDisposedError(error)) {
          throw error;
        }
        this.panel = undefined;
      }
    }

    const panel = vscode.window.createWebviewPanel(
      "choir.dependencyGraph",
      "Choir Dependency Graph",
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this.context.extensionPath, "media")),
          vscode.Uri.file(path.join(this.context.extensionPath, "node_modules")),
        ],
      }
    );

    this.panel = panel;
    const panelWebview = panel.webview;
    this.configureWebview(panelWebview);

    panel.onDidDispose(() => {
      this.releaseWebview(panelWebview);
      this.panel = undefined;
    });

    void this.postSnapshot();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const viewWebview = view.webview;
    this.configureWebview(viewWebview);

    view.onDidDispose(() => {
      this.releaseWebview(viewWebview);
    });

    void this.postSnapshot();
  }

  private configureWebview(webview: vscode.Webview): void {
    this.webviews.add(webview);
    const registration = this.registry.register("graph", webview);
    this.webviewRegistrations.set(webview, registration);
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, "media")),
        vscode.Uri.file(path.join(this.context.extensionPath, "node_modules")),
      ],
    };

    webview.html = this.getHtml(webview);

    webview.onDidReceiveMessage(async (message: GraphInboundMessage) => {
      traceInbound(this.traceStore, "graph", message as { type?: unknown });
      try {
        await this.handleMessage(message);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        console.error("GraphViewProvider: inbound message handling failed", error, message);
        this.postMessage({
          type: "error",
          message: text,
        });
      }
    });
  }

  private async handleEvent(event: ChoirEvent): Promise<void> {
    if (this.webviews.size === 0) {
      return;
    }

    if (event.type === "STATE_UPDATED" || event.type === "GRAPH_UPDATED" || event.type === "PLAN_UPDATED") {
      await this.postSnapshot();
      return;
    }

    if (event.type === "NAVIGATE") {
      if (event.intent.type === "focusUnit") {
        this.mode = "focused";
        this.focusNodeId = event.intent.unitId;
      } else if (event.intent.type === "showDependencies") {
        this.mode = "dependency";
        this.focusNodeId = event.intent.unitId;
      } else if (event.intent.type === "showDependents") {
        this.mode = "dependents";
        this.focusNodeId = event.intent.unitId;
      }

      await this.postSnapshot();
    }
  }

  private async handleMessage(message: GraphInboundMessage): Promise<void> {
    if (message.type === "ready" || message.type === "request-state") {
      await this.postSnapshot();
      return;
    }

    if (message.type === "refresh") {
      if (this.refreshWorkspace) {
        await this.refreshWorkspace();
      } else {
        await this.postSnapshot();
      }
      return;
    }

    if (message.type === "set-mode") {
      if (isGraphMode(message.mode)) {
        this.mode = message.mode;
      }

      this.focusNodeId = typeof message.focusNodeId === "string" && message.focusNodeId.trim().length > 0
        ? message.focusNodeId.trim()
        : undefined;
      await this.postSnapshot();
      if (this.focusNodeId) {
        const intentType = this.mode === "dependency"
          ? "showDependencies"
          : this.mode === "dependents"
            ? "showDependents"
            : "focusUnit";
        this.eventBus.emit({
          type: "NAVIGATE",
          intent: {
            type: intentType,
            unitId: this.focusNodeId,
          },
        });
      }
      this.eventBus.emit({ type: "GRAPH_UPDATED" });
      return;
    }

    if (message.type === "open-node") {
      const nodeId = typeof message.id === "string" ? message.id.trim() : "";
      if (nodeId.length > 0) {
        await this.openNode(nodeId);
        this.eventBus.emit({ type: "NAVIGATE", intent: { type: "showTimeline", unitId: nodeId } });
      }
    }
  }

  private getWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeRoot = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri)?.uri.fsPath : undefined;
    const root = activeRoot ?? folders[0]?.uri.fsPath;
    if (!root) {
      throw new Error("No workspace folder found.");
    }
    return root;
  }

  private buildSnapshot(): GraphSnapshot {
    const root = this.getWorkspaceRoot();
    const controlPath = getControlPlanePath();
    if (!controlPath) {
      throw new Error("Unable to resolve .choir/choir.config.yaml.");
    }

    const control = readControlPlane();
    if (!control) {
      throw new Error("No control plane found. Open a workspace folder first.");
    }

    const state = readStatePlane(root) ?? createEmptyStatePlane();
    return buildGraphSnapshot({
      root,
      control,
      state,
      mode: this.mode,
      ...(this.focusNodeId ? { focusNodeId: this.focusNodeId } : {}),
    });
  }

  private async postSnapshot(): Promise<void> {
    try {
      const snapshot = this.buildSnapshot();
      this.lastSnapshot = snapshot;
      this.postMessage({
        type: "snapshot",
        payload: snapshot,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postMessage({
        type: "error",
        message,
      });
    }
  }

  private postMessage(message: GraphOutboundMessage): void {
    for (const webview of this.webviews) {
      void sendToWebview(this.traceStore, "graph", webview, message);
    }
  }

  private async openNode(nodeId: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    const node = this.lastSnapshot?.graph.nodes.find((entry) => entry.id === nodeId);
    const packageJsonPath = typeof node?.metadata.packageJsonPath === "string"
      ? node.metadata.packageJsonPath
      : undefined;

    if (!packageJsonPath) {
      return;
    }

    const absolutePath = path.resolve(root, packageJsonPath);
    if (!fs.existsSync(absolutePath)) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private getHtml(webview: vscode.Webview): string {
    const d3Path = path.join(this.context.extensionPath, "node_modules", "d3", "dist", "d3.min.js");
    if (!fs.existsSync(d3Path)) {
      throw new Error("Missing d3 runtime. Run npm install to install dependencies.");
    }

    const scriptPath = path.join(this.context.extensionPath, "media", "graphPanel.js");
    if (!fs.existsSync(scriptPath)) {
      throw new Error("Missing media/graphPanel.js. Run npm run build before launching the extension.");
    }

    const d3Uri = webview.asWebviewUri(vscode.Uri.file(d3Path));
    const scriptUri = webview.asWebviewUri(vscode.Uri.file(scriptPath));
    const nonce = Math.random().toString(36).slice(2);

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';" />
  <title>Choir Dependency Graph</title>
  <style>
    :root {
      --bg: #f8fbf4;
      --panel: #fff;
      --ink: #123325;
      --muted: #4b6b60;
      --line: #bfd8cd;
      --sidebar-width: 180px;
      --splitter-width: 10px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at 12% 16%, rgba(113, 180, 151, 0.24), transparent 28%), var(--bg);
      color: var(--ink);
      font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
    }
    .layout {
      height: 100vh;
      display: flex;
      align-items: stretch;
      padding: 8px;
      gap: 0;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      box-shadow: 0 12px 28px rgba(22, 66, 51, 0.08);
    }
    .sidebar {
      width: var(--sidebar-width);
      min-width: 160px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      flex: 0 0 auto;
    }
    .section {
      padding: 8px;
      border-bottom: 1px solid #edf3ef;
    }
    .section:last-child {
      border-bottom: 0;
      flex: 1 1 auto;
      min-height: 0;
    }
    .section h2 {
      margin: 0 0 8px;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin-bottom: 6px;
      min-width: 0;
    }
    label { font-size: 11px; color: var(--muted); }
    select, input, button { font: inherit; }
    select, input {
      width: 100%;
      height: 30px;
      padding: 2px 6px;
      border: 1px solid #c9ddd4;
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      font-size: 12px;
      line-height: 1.2;
      min-width: 0;
    }
    .button-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }
    button {
      border: 1px solid #bad1c8;
      border-radius: 8px;
      padding: 4px 8px;
      background: linear-gradient(180deg, #f8fcfa, #eef7f2);
      color: var(--ink);
      cursor: pointer;
      white-space: nowrap;
      width: auto;
      min-width: 0;
      flex: 0 0 auto;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.52;
      filter: saturate(0.7);
    }
    button.primary {
      background: linear-gradient(180deg, #2f9d7b, #1f7f61);
      border-color: #1b6b52;
      color: #fff;
    }
    .status {
      font-size: 12px;
      color: var(--muted);
    }
    #statusLine {
      padding-top: 4px;
    }
    .inspector {
      overflow: auto;
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      scrollbar-width: thin;
      scrollbar-color: #6f9d8d #e6f0eb;
    }
    .inspector::-webkit-scrollbar,
    .sidebar::-webkit-scrollbar {
      width: 10px;
      height: 10px;
    }
    .inspector::-webkit-scrollbar-track,
    .sidebar::-webkit-scrollbar-track {
      background: #e6f0eb;
      border-radius: 999px;
    }
    .inspector::-webkit-scrollbar-thumb,
    .sidebar::-webkit-scrollbar-thumb {
      background: linear-gradient(180deg, #7eaa9a, #5f8f80);
      border-radius: 999px;
      border: 2px solid #e6f0eb;
    }
    .inspector::-webkit-scrollbar-thumb:hover,
    .sidebar::-webkit-scrollbar-thumb:hover {
      background: linear-gradient(180deg, #6f9d8d, #4f7b6d);
    }
    .canvas {
      position: relative;
      min-width: 0;
      overflow: hidden;
      flex: 1 1 auto;
    }
    .splitter {
      position: relative;
      cursor: col-resize;
      touch-action: none;
      border-radius: 8px;
      background: linear-gradient(180deg, rgba(191, 216, 205, 0.45), rgba(191, 216, 205, 0.2));
      outline: none;
      margin: 0 6px;
      width: var(--splitter-width);
      min-width: var(--splitter-width);
      flex: 0 0 var(--splitter-width);
    }
    .splitter::before {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 2px;
      height: 48px;
      border-radius: 999px;
      background: #7ea99a;
      box-shadow: 0 0 0 3px rgba(126, 169, 154, 0.12);
    }
    .splitter:hover,
    .splitter:focus-visible,
    .splitter.dragging {
      background: linear-gradient(180deg, rgba(47, 157, 123, 0.25), rgba(47, 157, 123, 0.16));
    }
    #graphSvg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .minimap {
      position: absolute;
      right: 12px;
      bottom: 12px;
      width: 220px;
      height: 150px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.9);
    }
    .legend {
      display: grid;
      gap: 6px;
      font-size: 12px;
    }
    .legend .item {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .swatch {
      width: 14px;
      height: 14px;
      border-radius: 4px;
    }
    .swatch.changed { background: #dae5fb; border: 1px solid #2154b8; }
    .swatch.affected { background: #fff3d7; border: 1px solid #d2931f; }
    .swatch.violation { background: #fde3e3; border: 1px solid #bc2d2d; }
    .swatch.hotspot { background: #ffe2c8; border: 1px solid #d16a15; }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="panel sidebar">
      <section class="section">
        <h2>Graph Controls</h2>
        <div class="field">
          <label for="modeSelect">Mode</label>
          <select id="modeSelect">
            <option value="full">full</option>
            <option value="focused">focused</option>
            <option value="dependency">dependency</option>
            <option value="dependents">dependents</option>
          </select>
        </div>
        <div class="field">
          <label for="focusSelect">Focus Node</label>
          <select id="focusSelect"></select>
        </div>
        <div class="field">
          <label for="searchInput">Search</label>
          <input id="searchInput" type="text" placeholder="filter by id or label" />
        </div>
        <div class="button-row">
          <button id="refreshBtn" class="primary">Refresh</button>
          <button id="openNodeBtn">Open Node</button>
          <button id="dependenciesBtn">Dependencies</button>
          <button id="dependentsBtn">Dependents</button>
        </div>
        <div class="status" id="statusLine">Waiting for snapshot...</div>
      </section>

      <section class="section legend">
        <h2>Legend</h2>
        <div class="item"><span class="swatch changed"></span>Changed</div>
        <div class="item"><span class="swatch affected"></span>Affected</div>
        <div class="item"><span class="swatch violation"></span>Violation</div>
        <div class="item"><span class="swatch hotspot"></span>Hotspot</div>
      </section>

      <section class="section">
        <h2>Trace</h2>
        <div id="traceLine" class="status"></div>
      </section>

      <section class="section inspector" id="inspector">Select a node to inspect metadata.</section>
    </aside>

    <div id="splitter" class="splitter" role="separator" aria-orientation="vertical" aria-label="Resize panels" tabindex="0"></div>

    <main class="panel canvas">
      <svg id="graphSvg"></svg>
      <svg id="miniMap" class="minimap"></svg>
    </main>
  </div>

  <script nonce="${nonce}" src="${d3Uri.toString()}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}