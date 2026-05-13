import * as vscode from "vscode";
import { ChoirProductService } from "./ChoirProductService.js";
import { ChoirEventBus, MessageTraceStore, WebviewRegistry, sendToWebview, traceInbound } from "./choirWebviewSync.js";
import { createEmptyStatePlane } from "../core/state.js";
import type { ProductActionRequest, ProductSnapshot } from "../ui/contracts.js";
import type { ChoirEvent, HostToWebview, NavigationIntent, WebviewToHost } from "./webviewProtocol.js";

type TimelineProjection = {
  generatedAt: string;
  timeline: ProductSnapshot["timeline"];
  stateInspector: ProductSnapshot["stateInspector"];
  stateDiff?: ProductSnapshot["stateDiff"];
  replayTrace?: ProductSnapshot["replayTrace"];
};

type TimelineOutboundMessage =
  | HostToWebview<TimelineProjection>
  | { type: "NAVIGATE"; intent: NavigationIntent }
  | { type: "ERROR"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReplayControlCommand(value: unknown): value is ProductActionRequest {
  if (!isRecord(value) || value.type !== "replay-control") {
    return false;
  }

  const control = value.control;
  return control === "play" || control === "pause" || control === "step-forward" || control === "step-backward" || control === "jump";
}

function isRequestStateMessage(value: unknown): value is Extract<WebviewToHost, { type: "REQUEST_STATE" }> {
  return isRecord(value) && value.type === "REQUEST_STATE";
}

function isNavigateMessage(value: unknown): value is Extract<WebviewToHost, { type: "NAVIGATE" }> {
  if (!isRecord(value) || value.type !== "NAVIGATE" || !isRecord(value.intent)) {
    return false;
  }

  const intentType = value.intent.type;
  return intentType === "focusUnit" || intentType === "showDependencies" || intentType === "showTimeline";
}

function isExecuteCommandMessage(value: unknown): value is Extract<WebviewToHost, { type: "EXECUTE_COMMAND" }> {
  return isRecord(value) && value.type === "EXECUTE_COMMAND" && isReplayControlCommand(value.command);
}

function isDisposedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /disposed/i.test(message);
}

export class TimelineViewProvider {
  private panel?: vscode.WebviewPanel;
  private readonly webviews = new Set<vscode.Webview>();
  private readonly webviewRegistrations = new Map<vscode.Webview, vscode.Disposable>();
  private readonly eventSubscription: vscode.Disposable;
  private lastProjectionError = "";
  private lastProjectionErrorAt = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: ChoirProductService,
    private readonly eventBus: ChoirEventBus,
    private readonly traceStore: MessageTraceStore,
    private readonly registry: WebviewRegistry
  ) {
    this.eventSubscription = this.eventBus.subscribe(async (event) => {
      await this.handleEvent(event);
    });
    this.context.subscriptions.push(this.eventSubscription);
  }

  openPanel(column: vscode.ViewColumn = vscode.ViewColumn.Two): void {
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
      "choir.timeline",
      "Choir Timeline",
      column,
      {
        enableScripts: true,
      }
    );

    this.panel = panel;
    this.configureWebview(panel.webview);

    panel.onDidDispose(() => {
      this.webviewRegistrations.get(panel.webview)?.dispose();
      this.webviewRegistrations.delete(panel.webview);
      this.webviews.delete(panel.webview);
      this.panel = undefined;
    });

    void this.pushInit(panel.webview);
  }

  private async handleEvent(event: ChoirEvent): Promise<void> {
    if (this.webviews.size === 0) {
      return;
    }

    if (
      event.type === "STATE_UPDATED"
      || event.type === "TIMELINE_UPDATED"
      || event.type === "PLAN_UPDATED"
    ) {
      await this.pushUpdate();
      return;
    }

    if (event.type === "NAVIGATE" && event.intent.type === "showTimeline") {
      this.openPanel(vscode.ViewColumn.Two);
      await this.broadcast({ type: "NAVIGATE", intent: event.intent });
      await this.pushUpdate();
    }
  }

  private async getProjection(): Promise<TimelineProjection> {
    const snapshot = await this.service.buildSnapshot("conductor");
    return {
      generatedAt: snapshot.generatedAt,
      timeline: snapshot.timeline,
      stateInspector: snapshot.stateInspector,
      ...(snapshot.stateDiff ? { stateDiff: snapshot.stateDiff } : {}),
      ...(snapshot.replayTrace ? { replayTrace: snapshot.replayTrace } : {}),
    };
  }

  private buildFallbackProjection(reason: string): TimelineProjection {
    const state = createEmptyStatePlane();
    return {
      generatedAt: new Date().toISOString(),
      timeline: {
        currentIndex: -1,
        canStepForward: false,
        canStepBackward: false,
        playing: false,
        states: [],
      },
      stateInspector: {
        intent: state.intent,
        ast: state.ast,
        violations: state.ruleViolations,
        plans: state.plans,
        why: [reason],
        dependencyChain: [],
      },
    };
  }

  private async getProjectionSafe(): Promise<TimelineProjection> {
    try {
      return await this.getProjection();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const signature = `TimelineViewProvider: failed to build projection ${message}`;
      const now = Date.now();
      if (signature !== this.lastProjectionError || now - this.lastProjectionErrorAt > 5000) {
        console.error("TimelineViewProvider: failed to build projection", error);
        this.lastProjectionError = signature;
        this.lastProjectionErrorAt = now;
      }
      return this.buildFallbackProjection(`Timeline fallback mode: ${message}`);
    }
  }

  private async pushInit(webview: vscode.Webview): Promise<void> {
    const payload = await this.getProjectionSafe();
    await sendToWebview(this.traceStore, "timeline", webview, {
      type: "INIT",
      payload,
    } satisfies HostToWebview<TimelineProjection>);
  }

  private async pushUpdate(): Promise<void> {
    if (this.webviews.size === 0) {
      return;
    }

    const payload = await this.getProjectionSafe();
    await this.broadcast({
      type: "UPDATE",
      payload,
    } satisfies HostToWebview<TimelineProjection>);
  }

  private async broadcast(message: TimelineOutboundMessage): Promise<void> {
    for (const webview of this.webviews) {
      await sendToWebview(this.traceStore, "timeline", webview, message as { type: string; [key: string]: unknown });
    }
  }

  private configureWebview(webview: vscode.Webview): void {
    this.webviews.add(webview);
    const registration = this.registry.register("timeline", webview);
    this.webviewRegistrations.set(webview, registration);
    webview.options = {
      enableScripts: true,
    };

    webview.html = this.getHtml();

    webview.onDidReceiveMessage(async (message: unknown) => {
      traceInbound(this.traceStore, "timeline", message as { type?: unknown });
      try {
        await this.handleMessage(message, webview);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        console.error("TimelineViewProvider: inbound message handling failed", error, message);
        await this.broadcast({ type: "ERROR", message: text });
      }
    });
  }

  private async handleMessage(message: unknown, webview: vscode.Webview): Promise<void> {
    if (isRequestStateMessage(message)) {
      await this.pushInit(webview);
      return;
    }

    if (isNavigateMessage(message)) {
      this.eventBus.emit({
        type: "NAVIGATE",
        intent: message.intent as NavigationIntent,
      });
      return;
    }

    if (isExecuteCommandMessage(message)) {
      const result = await this.service.handleAction(message.command as ProductActionRequest);
      if (result.ok) {
        const current = result.snapshot.timeline.states[result.snapshot.timeline.currentIndex];
        this.eventBus.emit({ type: "STATE_UPDATED", stateHash: current?.toHash ?? "GENESIS" });
        this.eventBus.emit({ type: "TIMELINE_UPDATED" });
      }
      await this.pushUpdate();
    }
  }

  private getHtml(): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>Choir Timeline</title>
  <style>
    body { margin: 0; font-family: "IBM Plex Sans", "Segoe UI", sans-serif; background: #f7fbf8; color: #173128; }
    .layout { display: grid; grid-template-columns: 320px 1fr; gap: 12px; height: 100vh; padding: 12px; }
    .panel { background: #fff; border: 1px solid #c9ddd4; border-radius: 12px; padding: 12px; overflow: auto; }
    .controls { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
    button { padding: 8px; border: 1px solid #bad1c8; border-radius: 8px; background: #f5faf7; cursor: pointer; }
    button.primary { background: #1f7f61; color: #fff; border-color: #19624b; }
    .timeline-item { width: 100%; text-align: left; margin-bottom: 6px; }
    .timeline-item.current { border-color: #1f7f61; background: #e8f6ef; }
    pre { background: #0f1a16; color: #d8efe4; padding: 10px; border-radius: 8px; overflow: auto; }
    .muted { color: #4a6c60; font-size: 12px; }
  </style>
</head>
<body>
  <div class="layout">
    <section class="panel">
      <div class="controls">
        <button id="refreshBtn" class="primary">Refresh</button>
        <button id="playBtn">Play</button>
        <button id="pauseBtn">Pause</button>
        <button id="backBtn">Step Back</button>
        <button id="forwardBtn">Step Forward</button>
      </div>
      <div id="timelineList"></div>
    </section>
    <section class="panel">
      <div class="muted" id="statusLine">Waiting for state...</div>
      <h3>Inspector</h3>
      <pre id="inspector"></pre>
      <h3>Diff</h3>
      <pre id="diff"></pre>
      <h3>Replay Trace</h3>
      <pre id="trace"></pre>
    </section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let model = null;

    const timelineList = document.getElementById('timelineList');
    const inspector = document.getElementById('inspector');
    const diff = document.getElementById('diff');
    const trace = document.getElementById('trace');
    const statusLine = document.getElementById('statusLine');

    function post(message) { vscode.postMessage(message); }

    function render() {
      if (!model) return;

      statusLine.textContent = 'Generated: ' + model.generatedAt + ' | Current index: ' + model.timeline.currentIndex;

      timelineList.innerHTML = (model.timeline.states || []).map((entry) => {
        const isCurrent = entry.index === model.timeline.currentIndex;
        return '<button class="timeline-item ' + (isCurrent ? 'current' : '') + '" data-index="' + entry.index + '">' + entry.label + ' - ' + entry.action + '</button>';
      }).join('');

      timelineList.querySelectorAll('[data-index]').forEach((button) => {
        button.addEventListener('click', () => {
          const index = Number.parseInt(button.getAttribute('data-index') || '', 10);
          if (!Number.isFinite(index)) return;
          post({
            type: 'EXECUTE_COMMAND',
            command: { type: 'replay-control', role: 'conductor', control: 'jump', index }
          });
        });
      });

      inspector.textContent = JSON.stringify(model.stateInspector, null, 2);
      diff.textContent = JSON.stringify(model.stateDiff ?? { patches: [] }, null, 2);
      trace.textContent = JSON.stringify(model.replayTrace ?? {}, null, 2);
    }

    document.getElementById('refreshBtn').addEventListener('click', () => post({ type: 'REQUEST_STATE' }));
    document.getElementById('playBtn').addEventListener('click', () => post({ type: 'EXECUTE_COMMAND', command: { type: 'replay-control', role: 'conductor', control: 'play' } }));
    document.getElementById('pauseBtn').addEventListener('click', () => post({ type: 'EXECUTE_COMMAND', command: { type: 'replay-control', role: 'conductor', control: 'pause' } }));
    document.getElementById('backBtn').addEventListener('click', () => post({ type: 'EXECUTE_COMMAND', command: { type: 'replay-control', role: 'conductor', control: 'step-backward' } }));
    document.getElementById('forwardBtn').addEventListener('click', () => post({ type: 'EXECUTE_COMMAND', command: { type: 'replay-control', role: 'conductor', control: 'step-forward' } }));

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'INIT' || message.type === 'UPDATE') {
        model = message.payload;
        render();
        return;
      }

      if (message.type === 'ERROR') {
        statusLine.textContent = 'Error: ' + String(message.message || 'unknown error');
        return;
      }

      if (message.type === 'NAVIGATE') {
        statusLine.textContent = 'Navigation intent: ' + message.intent.type + ' ' + (message.intent.unitId || '');
      }
    });

    post({ type: 'REQUEST_STATE' });
  </script>
</body>
</html>`;
  }
}
