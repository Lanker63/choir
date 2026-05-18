import * as vscode from "vscode";
import {
  getPipelineDiagnosticsLogPath,
  readPipelineDiagnosticsRecords,
  type PipelineDiagnosticsRecord,
} from "../core/pipelineDiagnostics.js";
import { ChoirEventBus, MessageTraceStore, WebviewRegistry, sendToWebview, traceInbound } from "./choirWebviewSync.js";
import type { ChoirEvent } from "./webviewProtocol.js";

type DiagnosticsInboundMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "request-state" };

type DiagnosticsProjection = {
  generatedAt: string;
  logPath: string;
  entries: PipelineDiagnosticsRecord[];
};

type DiagnosticsOutboundMessage =
  | { type: "snapshot"; payload: DiagnosticsProjection }
  | { type: "error"; message: string };

function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeRoot = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri)?.uri.fsPath : undefined;
  const root = activeRoot ?? folders[0]?.uri.fsPath;
  if (!root) {
    throw new Error("No workspace folder found.");
  }

  return root;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fallbackProjection(): DiagnosticsProjection {
  return {
    generatedAt: new Date().toISOString(),
    logPath: "unavailable",
    entries: [],
  };
}

function bootstrapSnapshotJson(snapshot: DiagnosticsProjection): string {
  return JSON.stringify(snapshot).replace(/</g, "\\u003c");
}

function renderStaticList(snapshot: DiagnosticsProjection): string {
  if (snapshot.entries.length === 0) {
    return `<div class="empty">No diagnostics records match the current filter.<br/>Log: ${escapeHtml(snapshot.logPath)}</div>`;
  }

  return snapshot.entries.map((entry, index) => {
    const active = index === 0 ? " active" : "";
    return `<div class="item${active}" data-id="${escapeHtml(entry.id)}">`
      + "<div>"
      + `<span class="badge ${escapeHtml(entry.result)}">${escapeHtml(entry.result)}</span>`
      + `<span class="badge">${escapeHtml(entry.category)}</span>`
      + "</div>"
      + `<div><strong>${escapeHtml(entry.summary)}</strong></div>`
      + `<div class="meta">${escapeHtml(entry.command)} | ${escapeHtml(entry.source)} | ${escapeHtml(entry.timestamp)}</div>`
      + "</div>";
  }).join("");
}

function renderStaticDetails(snapshot: DiagnosticsProjection): string {
  const selected = snapshot.entries[0];
  if (!selected) {
    return `<div class="empty">No diagnostics record selected.<br/>Generated: ${escapeHtml(snapshot.generatedAt)}<br/>Log: ${escapeHtml(snapshot.logPath)}</div>`;
  }

  const stageRows = (selected.stages ?? []).map((stage) => `<tr>`
    + `<td>${escapeHtml(stage.stage)}</td>`
    + `<td><span class="badge ${escapeHtml(stage.status)}">${escapeHtml(stage.status)}</span></td>`
    + `<td>${escapeHtml(stage.detail)}</td>`
    + `</tr>`).join("");

  const candidatePlans = Array.isArray(selected.metadata?.candidatePlans)
    ? selected.metadata?.candidatePlans as Array<Record<string, unknown>>
    : [];
  const comparisons = Array.isArray(selected.metadata?.planComparisons)
    ? selected.metadata?.planComparisons as Array<Record<string, unknown>>
    : [];
  const runtimeGovernance = selected.metadata?.runtimeGovernance as Record<string, unknown> | undefined;
  const runtimeMode = typeof runtimeGovernance?.mode === "string" ? runtimeGovernance.mode : "unknown";
  const runtimeCapability = typeof runtimeGovernance?.capability === "string" ? runtimeGovernance.capability : "unknown";
  const runtimeDecision = typeof runtimeGovernance?.decision === "string" ? runtimeGovernance.decision : "unknown";
  const runtimeReason = typeof runtimeGovernance?.reason === "string" ? runtimeGovernance.reason : "unknown";
  const runtimeCapabilities = runtimeGovernance?.effectiveCapabilities as Record<string, unknown> | undefined;
  const runtimeStrategic = runtimeGovernance?.strategic as Record<string, unknown> | undefined;
  const runtimeStrategicIntensity = typeof runtimeStrategic?.governanceIntensity === "string"
    ? runtimeStrategic.governanceIntensity
    : "unknown";
  const runtimeStrategicDomains = Array.isArray(runtimeStrategic?.domains)
    ? (runtimeStrategic.domains as unknown[]).map((entry) => String(entry)).join(",")
    : "none";
  const runtimeCapabilityRows = runtimeCapabilities
    ? Object.entries(runtimeCapabilities)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([capability, enabled]) => `<tr><td>${escapeHtml(capability)}</td><td>${escapeHtml(String(enabled))}</td></tr>`)
      .join("")
    : "";

  const candidateRows = candidatePlans.map((candidate) => {
    const selectedBadge = candidate.selected === true
      ? " <span class=\"badge success\">selected</span>"
      : "";

    return `<tr>`
      + `<td>${escapeHtml(candidate.id ?? "")}${selectedBadge}</td>`
      + `<td>${escapeHtml(candidate.strategyType ?? "")}</td>`
      + `<td>${escapeHtml(candidate.strategicAlignment ?? "")}</td>`
      + `<td>${escapeHtml(candidate.governanceIntensity ?? "")}</td>`
      + `<td>${escapeHtml(candidate.riskScore ?? "")}</td>`
      + `<td>${escapeHtml(candidate.rollbackComplexity ?? "")}</td>`
      + `<td>${escapeHtml(candidate.blastRadius ?? "")}</td>`
      + `<td>${escapeHtml(candidate.stages ?? "")}</td>`
      + `</tr>`;
  }).join("");

  const comparisonRows = comparisons.map((comparison) => {
    const diff = (comparison.diff ?? {}) as Record<string, unknown>;
    return `<tr>`
      + `<td>${escapeHtml(comparison.from ?? "")}</td>`
      + `<td>${escapeHtml(comparison.to ?? "")}</td>`
      + `<td>${escapeHtml(diff.riskDelta ?? "")}</td>`
      + `<td>${escapeHtml(diff.rollbackDelta ?? "")}</td>`
      + `<td>${escapeHtml(diff.graphDelta ?? "")}</td>`
      + `</tr>`;
  }).join("");

  const metadata = selected.metadata ? JSON.stringify(selected.metadata, null, 2) : "{}";
  const emptyStageRow = "<tr><td colspan=\"3\">No stage data recorded.</td></tr>";
  const emptyCandidateRow = "<tr><td colspan=\"8\">No candidate plans recorded.</td></tr>";
  const emptyComparisonRow = "<tr><td colspan=\"5\">No plan comparisons recorded.</td></tr>";

  return `<div class="header">Generated ${escapeHtml(snapshot.generatedAt)} | Log ${escapeHtml(snapshot.logPath)}</div>`
    + `<div><strong>${escapeHtml(selected.summary)}</strong></div>`
    + `<div>Command: ${escapeHtml(selected.command)}</div>`
    + `<div>Category: ${escapeHtml(selected.category)} | Result: ${escapeHtml(selected.result)} | Source: ${escapeHtml(selected.source)}</div>`
    + `<div>Timestamp: ${escapeHtml(selected.timestamp)}</div>`
    + "<div><strong>Runtime Governance</strong></div>"
    + `<div>mode=${escapeHtml(runtimeMode)} | capability=${escapeHtml(runtimeCapability)} | decision=${escapeHtml(runtimeDecision)} | reason=${escapeHtml(runtimeReason)}</div>`
    + `<div>strategic governanceIntensity=${escapeHtml(runtimeStrategicIntensity)} | domains=${escapeHtml(runtimeStrategicDomains)}</div>`
    + "<table>"
    + "<thead><tr><th>Capability</th><th>Enabled</th></tr></thead>"
    + `<tbody>${runtimeCapabilityRows.length > 0 ? runtimeCapabilityRows : "<tr><td colspan=\"2\">No runtime capability map recorded.</td></tr>"}</tbody>`
    + "</table>"
    + "<table>"
    + "<thead><tr><th>Stage</th><th>Status</th><th>Detail</th></tr></thead>"
    + `<tbody>${stageRows.length > 0 ? stageRows : emptyStageRow}</tbody>`
    + "</table>"
    + "<div><strong>Candidate Plans</strong></div>"
    + "<table>"
    + "<thead><tr><th>Candidate</th><th>Strategy</th><th>Strategic Alignment</th><th>Governance</th><th>Risk</th><th>Rollback</th><th>Blast Radius</th><th>DAG Stages</th></tr></thead>"
    + `<tbody>${candidateRows.length > 0 ? candidateRows : emptyCandidateRow}</tbody>`
    + "</table>"
    + "<div><strong>Compare Plans</strong></div>"
    + "<table>"
    + "<thead><tr><th>From</th><th>To</th><th>Risk delta</th><th>Rollback delta</th><th>Graph delta</th></tr></thead>"
    + `<tbody>${comparisonRows.length > 0 ? comparisonRows : emptyComparisonRow}</tbody>`
    + "</table>"
    + "<div><strong>Metadata</strong></div>"
    + `<pre>${escapeHtml(metadata)}</pre>`;
}

export class PipelineDiagnosticsViewProvider {
  private panel?: vscode.WebviewPanel;
  private readonly webviews = new Set<vscode.Webview>();
  private readonly webviewRegistrations = new Map<vscode.Webview, vscode.Disposable>();
  private readonly eventSubscription: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly eventBus: ChoirEventBus,
    private readonly traceStore: MessageTraceStore,
    private readonly registry: WebviewRegistry
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

  private resetPanel(panel: vscode.WebviewPanel): void {
    this.releaseWebview(panel.webview);
    if (this.panel === panel) {
      this.panel = undefined;
    }
  }

  private isDisposedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /disposed/i.test(message);
  }

  openPanel(column: vscode.ViewColumn = vscode.ViewColumn.Two): void {
    if (this.panel) {
      try {
        this.panel.reveal(column, false);
        void this.postSnapshot();
        return;
      } catch (error) {
        if (!this.isDisposedError(error)) {
          throw error;
        }

        this.resetPanel(this.panel);
      }
    }

    const panel = vscode.window.createWebviewPanel(
      "choir.pipelineDiagnostics",
      "Choir Diagnostics",
      column,
      {
        enableScripts: true,
      }
    );

    this.panel = panel;
    let initialSnapshot: DiagnosticsProjection;
    try {
      initialSnapshot = this.buildProjection();
    } catch {
      initialSnapshot = fallbackProjection();
    }

    this.configureWebview(panel.webview, initialSnapshot);

    panel.onDidDispose(() => {
      this.resetPanel(panel);
    });

    void this.postSnapshot();
  }

  async refresh(): Promise<void> {
    await this.postSnapshot();
  }

  private async handleEvent(event: ChoirEvent): Promise<void> {
    if (this.webviews.size === 0) {
      return;
    }

    if (
      event.type === "STATE_UPDATED"
      || event.type === "PLAN_UPDATED"
      || event.type === "TIMELINE_UPDATED"
    ) {
      await this.postSnapshot();
    }
  }

  private configureWebview(webview: vscode.Webview, initialSnapshot: DiagnosticsProjection): void {
    this.webviews.add(webview);
    const registration = this.registry.register("diagnostics", webview);
    this.webviewRegistrations.set(webview, registration);

    webview.options = {
      enableScripts: true,
    };

    webview.html = this.getHtml(initialSnapshot);

    webview.onDidReceiveMessage(async (message: DiagnosticsInboundMessage) => {
      traceInbound(this.traceStore, "diagnostics", message as { type?: unknown });
      await this.handleMessage(message);
    });
  }

  private async handleMessage(message: DiagnosticsInboundMessage): Promise<void> {
    if (message.type === "ready" || message.type === "refresh" || message.type === "request-state") {
      await this.postSnapshot();
    }
  }

  private buildProjection(): DiagnosticsProjection {
    const root = getWorkspaceRoot();
    return {
      generatedAt: new Date().toISOString(),
      logPath: getPipelineDiagnosticsLogPath(root),
      entries: readPipelineDiagnosticsRecords(root, { limit: 400 }),
    };
  }

  private async postSnapshot(): Promise<void> {
    try {
      const snapshot = this.buildProjection();
      await this.postMessage({
        type: "snapshot",
        payload: snapshot,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.postMessage({
        type: "error",
        message,
      });
    }
  }

  private async postMessage(message: DiagnosticsOutboundMessage): Promise<void> {
    for (const webview of [...this.webviews]) {
      try {
        await sendToWebview(this.traceStore, "diagnostics", webview, message);
      } catch (error) {
        if (this.isDisposedError(error)) {
          this.releaseWebview(webview);
          continue;
        }

        throw error;
      }
    }
  }

  private getHtml(initialSnapshot: DiagnosticsProjection): string {
    const nonce = Math.random().toString(36).slice(2);
    const initialListMarkup = renderStaticList(initialSnapshot);
    const initialDetailsMarkup = renderStaticDetails(initialSnapshot);
    const bootstrapJson = bootstrapSnapshotJson(initialSnapshot);

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>Choir Diagnostics</title>
  <style>
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      background: linear-gradient(150deg, #eef8f2, #f9fbff);
      color: #163227;
    }
    .layout {
      display: grid;
      grid-template-columns: 360px 1fr;
      gap: 12px;
      height: 100vh;
      padding: 12px;
    }
    .panel {
      background: #ffffff;
      border: 1px solid #c6dcd0;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(20, 52, 40, 0.08);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .controls {
      padding: 12px;
      border-bottom: 1px solid #e4eee8;
      display: grid;
      gap: 8px;
    }
    .controls label {
      font-size: 12px;
      color: #4a6f61;
    }
    .controls select,
    .controls input,
    .controls button {
      width: 100%;
      font: inherit;
      border-radius: 8px;
      border: 1px solid #bad1c4;
      padding: 8px;
      box-sizing: border-box;
    }
    .controls button {
      background: linear-gradient(180deg, #2f9d7b, #1f7f61);
      color: #ffffff;
      border-color: #1a664d;
      cursor: pointer;
    }
    .list {
      overflow: auto;
      padding: 8px;
      display: grid;
      gap: 6px;
    }
    .item {
      border: 1px solid #d3e3da;
      border-radius: 8px;
      padding: 10px;
      cursor: pointer;
      background: #fbfefd;
    }
    .item.active {
      border-color: #2f9d7b;
      background: #e8f6ef;
    }
    .item .meta {
      font-size: 12px;
      color: #4d6e61;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      border: 1px solid transparent;
      margin-right: 4px;
    }
    .badge.success {
      background: #e4f5eb;
      color: #175d3d;
      border-color: #8ac4a6;
    }
    .badge.failure {
      background: #fdeceb;
      color: #7a1f1d;
      border-color: #e8a7a1;
    }
    .details {
      min-height: 0;
      overflow: auto;
      padding: 14px;
      display: grid;
      gap: 10px;
    }
    .header {
      font-size: 12px;
      color: #4f7163;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid #e8efeb;
      vertical-align: top;
    }
    pre {
      margin: 0;
      padding: 12px;
      border-radius: 8px;
      background: #101a15;
      color: #d8f0e3;
      overflow: auto;
      font-size: 12px;
    }
    .empty {
      color: #4f7163;
      font-size: 13px;
      padding: 12px;
    }
  </style>
</head>
<body>
  <div class="layout">
    <section class="panel">
      <div class="controls">
        <button id="refreshBtn">Refresh Diagnostics</button>
        <label for="statusFilter">Result</label>
        <select id="statusFilter">
          <option value="all">all</option>
          <option value="success">success</option>
          <option value="failure">failure</option>
        </select>
        <label for="categoryFilter">Category</label>
        <select id="categoryFilter">
          <option value="all">all</option>
          <option value="compiler">compiler</option>
          <option value="pipeline">pipeline</option>
          <option value="planning">planning</option>
          <option value="preview">preview</option>
          <option value="simulation">simulation</option>
          <option value="execution">execution</option>
          <option value="rollback">rollback</option>
          <option value="general">general</option>
        </select>
        <label for="searchInput">Search Command</label>
        <input id="searchInput" placeholder="filter command text" />
      </div>
      <div id="list" class="list">${initialListMarkup}</div>
    </section>

    <section class="panel">
      <div id="details" class="details">${initialDetailsMarkup}</div>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const listNode = document.getElementById("list");
    const detailsNode = document.getElementById("details");
    const statusFilter = document.getElementById("statusFilter");
    const categoryFilter = document.getElementById("categoryFilter");
    const searchInput = document.getElementById("searchInput");
    const refreshBtn = document.getElementById("refreshBtn");

    let model = null;
    let selectedId = null;
  const bootstrapSnapshot = ${bootstrapJson};

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#039;");
    }

    function filteredEntries() {
      if (!model) {
        return [];
      }

      const status = statusFilter.value;
      const category = categoryFilter.value;
      const query = searchInput.value.trim().toLowerCase();

      return (model.entries ?? []).filter((entry) => {
        if (status !== "all" && entry.result !== status) {
          return false;
        }

        if (category !== "all" && entry.category !== category) {
          return false;
        }

        if (query.length > 0 && !String(entry.command || "").toLowerCase().includes(query)) {
          return false;
        }

        return true;
      });
    }

    function renderList() {
      const entries = filteredEntries();
      if (entries.length === 0) {
        const generatedAt = model ? escapeHtml(model.generatedAt) : "unknown";
        const logPath = model ? escapeHtml(model.logPath) : "unavailable";
        listNode.innerHTML = '<div class="empty">No diagnostics records match the current filter.<br/>Log: ' + logPath + '</div>';
        detailsNode.innerHTML = '<div class="empty">No diagnostics record selected.<br/>Generated: ' + generatedAt + '<br/>Log: ' + logPath + '</div>';
        return;
      }

      if (!selectedId || !entries.some((entry) => entry.id === selectedId)) {
        selectedId = entries[0].id;
      }

      listNode.innerHTML = entries.map((entry) => {
        const active = entry.id === selectedId ? " active" : "";
        return '<div class="item' + active + '" data-id="' + escapeHtml(entry.id) + '">' +
          '<div>' +
            '<span class="badge ' + escapeHtml(entry.result) + '">' + escapeHtml(entry.result) + '</span>' +
            '<span class="badge">' + escapeHtml(entry.category) + '</span>' +
          '</div>' +
          '<div><strong>' + escapeHtml(entry.summary) + '</strong></div>' +
          '<div class="meta">' + escapeHtml(entry.command) + ' | ' + escapeHtml(entry.source) + ' | ' + escapeHtml(entry.timestamp) + '</div>' +
        '</div>';
      }).join("");

      listNode.querySelectorAll("[data-id]").forEach((element) => {
        element.addEventListener("click", () => {
          selectedId = element.getAttribute("data-id");
          renderList();
          renderDetails();
        });
      });

      renderDetails();
    }

    function renderDetails() {
      const entries = filteredEntries();
      const selected = entries.find((entry) => entry.id === selectedId);
      if (!selected) {
        detailsNode.innerHTML = '<div class="empty">No diagnostics record selected.</div>';
        return;
      }

      const stageRows = (selected.stages ?? []).map((stage) => {
        return '<tr>' +
          '<td>' + escapeHtml(stage.stage) + '</td>' +
          '<td><span class="badge ' + escapeHtml(stage.status) + '">' + escapeHtml(stage.status) + '</span></td>' +
          '<td>' + escapeHtml(stage.detail) + '</td>' +
        '</tr>';
      }).join("");

      const candidatePlans = selected.metadata && Array.isArray(selected.metadata.candidatePlans)
        ? selected.metadata.candidatePlans
        : [];
      const comparisons = selected.metadata && Array.isArray(selected.metadata.planComparisons)
        ? selected.metadata.planComparisons
        : [];

      const candidateRows = candidatePlans.map((candidate) => {
        const selectedBadge = candidate.selected === true
          ? ' <span class="badge success">selected</span>'
          : '';

        return '<tr>' +
          '<td>' + escapeHtml(candidate.id || '') + selectedBadge + '</td>' +
          '<td>' + escapeHtml(candidate.strategyType || '') + '</td>' +
          '<td>' + escapeHtml(candidate.strategicAlignment || '') + '</td>' +
          '<td>' + escapeHtml(candidate.governanceIntensity || '') + '</td>' +
          '<td>' + escapeHtml(candidate.riskScore || '') + '</td>' +
          '<td>' + escapeHtml(candidate.rollbackComplexity || '') + '</td>' +
          '<td>' + escapeHtml(candidate.blastRadius || '') + '</td>' +
          '<td>' + escapeHtml(candidate.stages || '') + '</td>' +
        '</tr>';
      }).join('');

      const comparisonRows = comparisons.map((comparison) => {
        const diff = comparison.diff ?? {};
        return '<tr>' +
          '<td>' + escapeHtml(comparison.from || '') + '</td>' +
          '<td>' + escapeHtml(comparison.to || '') + '</td>' +
          '<td>' + escapeHtml(diff.riskDelta || '') + '</td>' +
          '<td>' + escapeHtml(diff.rollbackDelta || '') + '</td>' +
          '<td>' + escapeHtml(diff.graphDelta || '') + '</td>' +
        '</tr>';
      }).join('');

      const metadata = selected.metadata ? JSON.stringify(selected.metadata, null, 2) : "{}";
      const emptyStageRow = '<tr><td colspan="3">No stage data recorded.</td></tr>';
      const emptyCandidateRow = '<tr><td colspan="8">No candidate plans recorded.</td></tr>';
      const emptyComparisonRow = '<tr><td colspan="5">No plan comparisons recorded.</td></tr>';

      detailsNode.innerHTML =
        '<div class="header">Generated ' + escapeHtml(model.generatedAt) + ' | Log ' + escapeHtml(model.logPath) + '</div>' +
        '<div><strong>' + escapeHtml(selected.summary) + '</strong></div>' +
        '<div>Command: ' + escapeHtml(selected.command) + '</div>' +
        '<div>Category: ' + escapeHtml(selected.category) + ' | Result: ' + escapeHtml(selected.result) + ' | Source: ' + escapeHtml(selected.source) + '</div>' +
        '<div>Timestamp: ' + escapeHtml(selected.timestamp) + '</div>' +
        '<table>' +
          '<thead><tr><th>Stage</th><th>Status</th><th>Detail</th></tr></thead>' +
          '<tbody>' + (stageRows.length > 0 ? stageRows : emptyStageRow) + '</tbody>' +
        '</table>' +
        '<div><strong>Candidate Plans</strong></div>' +
        '<table>' +
          '<thead><tr><th>Candidate</th><th>Strategy</th><th>Strategic Alignment</th><th>Governance</th><th>Risk</th><th>Rollback</th><th>Blast Radius</th><th>DAG Stages</th></tr></thead>' +
          '<tbody>' + (candidateRows.length > 0 ? candidateRows : emptyCandidateRow) + '</tbody>' +
        '</table>' +
        '<div><strong>Compare Plans</strong></div>' +
        '<table>' +
          '<thead><tr><th>From</th><th>To</th><th>Risk delta</th><th>Rollback delta</th><th>Graph delta</th></tr></thead>' +
          '<tbody>' + (comparisonRows.length > 0 ? comparisonRows : emptyComparisonRow) + '</tbody>' +
        '</table>' +
        '<div><strong>Metadata</strong></div>' +
        '<pre>' + escapeHtml(metadata) + '</pre>';
    }

    function renderSnapshot(snapshot) {
      model = snapshot;
      renderList();
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "snapshot") {
        renderSnapshot(message.payload);
        return;
      }

      if (message.type === "error") {
        detailsNode.innerHTML = '<pre>' + escapeHtml(message.message || "Unknown diagnostics error") + '</pre>';
      }
    });

    refreshBtn.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    statusFilter.addEventListener("change", renderList);
    categoryFilter.addEventListener("change", renderList);
    searchInput.addEventListener("input", renderList);

    if (bootstrapSnapshot && Array.isArray(bootstrapSnapshot.entries)) {
      renderSnapshot(bootstrapSnapshot);
    }

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}
