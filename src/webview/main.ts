/// <reference path="./global.d.ts" />

import type {
  ProductActionRequest,
  ProductActionResult,
  ProductSnapshot,
  UISurface,
  WorkflowStep,
  WebviewOutboundMessage,
} from "../ui/contracts.js";
import "./styles.css";

type Role = "architect" | "analyst" | "conductor" | "enforcer";

const WORKFLOW_PERMISSIONS: Record<Role, WorkflowStep[]> = {
  architect: ["define-intent", "approve", "audit"],
  analyst: ["audit"],
  conductor: ["define-intent", "plan", "preview", "approve", "audit"],
  enforcer: ["execute", "audit"],
};

const SURFACE_LABELS: Record<UISurface, string> = {
  dashboard: "Dashboard",
  workspace: "Workspace",
  "plan-view": "Plan View",
  "timeline-view": "Time Travel",
  "policy-view": "Policy View",
  "audit-view": "Audit View",
  "macro-library": "Macro/Abstraction",
};

const vscode = (window as { vscode?: { postMessage: (message: unknown) => void } }).vscode;
if (!vscode) {
  throw new Error("VSCode API not available in webview context.");
}

const roleSelect = document.getElementById("roleSelect");
const dslInput = document.getElementById("dslInput");
const runDslBtn = document.getElementById("runDslBtn");
const refreshBtn = document.getElementById("refreshBtn");
const surfaceTabs = document.getElementById("surfaceTabs");
const surfaceContainer = document.getElementById("surfaceContainer");
const consoleOutput = document.getElementById("consoleOutput");

if (!(roleSelect instanceof HTMLSelectElement)
  || !(dslInput instanceof HTMLInputElement)
  || !(runDslBtn instanceof HTMLButtonElement)
  || !(refreshBtn instanceof HTMLButtonElement)
  || !(surfaceTabs instanceof HTMLElement)
  || !(surfaceContainer instanceof HTMLElement)
  || !(consoleOutput instanceof HTMLElement)
) {
  throw new Error("Choir Control Center webview is missing required elements.");
}

let snapshot: ProductSnapshot | null = null;
let activeSurface: UISurface = "dashboard";
let auditFilters: { role?: string; environment?: string } = {};
let playbackTimer: number | undefined;

function getActiveRole(): Role {
  const value = roleSelect.value;
  if (value === "architect" || value === "analyst" || value === "conductor" || value === "enforcer") {
    return value;
  }

  return "conductor";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function appendLog(line: string): void {
  const timestamp = new Date().toISOString();
  const existing = consoleOutput.textContent ?? "";
  consoleOutput.textContent = `[${timestamp}] ${line}\n${existing}`;
}

function stopPlaybackTimer(): void {
  if (typeof playbackTimer !== "undefined") {
    window.clearInterval(playbackTimer);
    playbackTimer = undefined;
  }
}

function syncPlaybackTimer(): void {
  if (!snapshot?.timeline.playing) {
    stopPlaybackTimer();
    return;
  }

  if (typeof playbackTimer !== "undefined") {
    return;
  }

  playbackTimer = window.setInterval(() => {
    if (!snapshot?.timeline.playing || !snapshot.timeline.canStepForward) {
      postAction({
        type: "replay-control",
        role: getActiveRole(),
        control: "pause",
      });
      return;
    }

    postAction({
      type: "replay-control",
      role: getActiveRole(),
      control: "step-forward",
    });
  }, 900);
}

function postAction(payload: ProductActionRequest): void {
  vscode.postMessage({
    type: "action",
    payload,
  });
}

function canRunStep(role: Role, step: WorkflowStep): boolean {
  return WORKFLOW_PERMISSIONS[role].includes(step);
}

function statusChip(value: string): string {
  if (value === "stable" || value === "allow") {
    return `<span class="chip success">${escapeHtml(value)}</span>`;
  }

  if (value === "needs-attention" || value === "deny") {
    return `<span class="chip danger">${escapeHtml(value)}</span>`;
  }

  return `<span class="chip warn">${escapeHtml(value)}</span>`;
}

function renderTabs(): void {
  if (!snapshot) {
    surfaceTabs.innerHTML = "";
    return;
  }

  const available = snapshot.availableSurfaces;
  if (!available.includes(activeSurface)) {
    activeSurface = available[0] ?? "dashboard";
  }

  surfaceTabs.innerHTML = available
    .map((surface) => {
      const isActive = surface === activeSurface;
      return `<button type="button" class="surface-tab ${isActive ? "active" : ""}" data-surface="${surface}">${SURFACE_LABELS[surface]}</button>`;
    })
    .join("");

  surfaceTabs.querySelectorAll<HTMLButtonElement>(".surface-tab").forEach((button) => {
    button.addEventListener("click", () => {
      const surface = button.dataset.surface as UISurface | undefined;
      if (!surface) {
        return;
      }

      if (surface === activeSurface) {
        return;
      }

      activeSurface = surface;
      renderTabs();
      renderSurface();
    });
  });
}

function renderDashboard(): string {
  if (!snapshot) {
    return "";
  }

  const recommendations = snapshot.dashboard.recommendations.length > 0
    ? snapshot.dashboard.recommendations.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")
    : "<li>No recommendations. System is aligned.</li>";

  const recent = snapshot.dashboard.recentActions.length > 0
    ? snapshot.dashboard.recentActions.map((entry) => `<li><span class="mono">${escapeHtml(entry.timestamp)}</span> ${escapeHtml(entry.action)} (${escapeHtml(entry.result)})</li>`).join("")
    : "<li>No audit events yet.</li>";

  const productionHealth = snapshot.production
    ? statusChip(snapshot.production.health.healthy ? "stable" : "needs-attention")
    : "<span class=\"chip warn\">unavailable</span>";

  const productionAlerts = snapshot.production && snapshot.production.alerts.length > 0
    ? snapshot.production.alerts.map((alert) => `<li><span class="mono">${escapeHtml(alert.severity)}</span> ${escapeHtml(alert.condition)}</li>`).join("")
    : "<li>No active production alerts.</li>";

  const productionSlos = snapshot.production && snapshot.production.slos.length > 0
    ? snapshot.production.slos.map((slo) => `<li>${escapeHtml(slo.name)}: ${slo.actual.toFixed(2)} / ${slo.target.toFixed(2)} (${slo.met ? "met" : "miss"})</li>`).join("")
    : "<li>No SLO evaluation available.</li>";

  return `
    <section class="grid">
      <article class="card">
        <div class="muted">System Health</div>
        <div class="kpi">${statusChip(snapshot.dashboard.systemHealth)}</div>
      </article>
      <article class="card">
        <div class="muted">Production Health</div>
        <div class="kpi">${productionHealth}</div>
      </article>
      <article class="card">
        <div class="muted">Active Plans</div>
        <div class="kpi">${snapshot.dashboard.activePlans}</div>
      </article>
      <article class="card">
        <div class="muted">Policy Violations</div>
        <div class="kpi">${snapshot.dashboard.policyViolations}</div>
      </article>
      <article class="card wide">
        <div class="muted">Recommended Next Actions</div>
        <ul class="list">${recommendations}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Recent Actions</div>
        <ul class="list">${recent}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Production Alerts</div>
        <ul class="list">${productionAlerts}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Production SLOs</div>
        <ul class="list">${productionSlos}</ul>
      </article>
    </section>
  `;
}

function renderWorkflowControls(): string {
  if (!snapshot) {
    return "";
  }

  const role = getActiveRole();
  const stepMarkup = ["define-intent", "plan", "preview", "approve", "execute", "audit"].map((step) => {
    const workflowStep = step as WorkflowStep;
    const isCurrent = snapshot?.workflow.current === workflowStep;
    const isDone = snapshot?.workflow.completed.includes(workflowStep);
    return `<span class="step ${isCurrent ? "current" : ""} ${isDone ? "done" : ""}">${escapeHtml(step)}</span>`;
  }).join("");

  return `
    <article class="card full">
      <div class="muted">Guided Workflow</div>
      <div class="workflow">${stepMarkup}</div>
      <p class="muted">Current step: ${escapeHtml(snapshot.workflow.current)}</p>
      <div class="grid">
        <div class="card">
          <label for="intentInput">Define Intent</label>
          <input id="intentInput" type="text" placeholder="create safer service boundaries" />
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button id="runDefineBtn" ${canRunStep(role, "define-intent") ? "" : "disabled"}>Run</button>
          </div>
        </div>
        <div class="card">
          <label for="planGoalInput">Generate Plan</label>
          <input id="planGoalInput" type="text" placeholder="optional goal override" />
          <button id="runPlanBtn" style="margin-top:8px;" ${canRunStep(role, "plan") ? "" : "disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="previewPlanInput">Preview Plan ID (optional)</label>
          <input id="previewPlanInput" type="text" placeholder="plan-abc123" />
          <button id="runPreviewBtn" style="margin-top:8px;" ${canRunStep(role, "preview") ? "" : "disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="approveInput">Approve Diff ID or Plan ID</label>
          <input id="approveInput" type="text" placeholder="diff-... or plan-..." />
          <button id="runApproveBtn" style="margin-top:8px;" ${canRunStep(role, "approve") ? "" : "disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="executePlanInput">Execute Plan ID (optional)</label>
          <input id="executePlanInput" type="text" placeholder="plan-abc123" />
          <button id="runExecuteBtn" style="margin-top:8px;" ${canRunStep(role, "execute") ? "" : "disabled"}>Run</button>
        </div>
        <div class="card">
          <label>Audit</label>
          <p class="muted">Fetch current immutable audit timeline.</p>
          <button id="runAuditBtn" ${canRunStep(role, "audit") ? "" : "disabled"}>Run</button>
        </div>
      </div>
    </article>
  `;
}

function renderPlanView(): string {
  if (!snapshot) {
    return "";
  }

  const rows = snapshot.planView.length > 0
    ? snapshot.planView.map((plan) => `
      <tr>
        <td class="mono">${escapeHtml(plan.planId)}</td>
        <td>${escapeHtml(plan.tasks.join(", "))}</td>
        <td class="mono">${escapeHtml(plan.affectedFiles.join(", "))}</td>
        <td>${plan.estimatedImpact}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="4" class="muted">No plans yet.</td></tr>`;

  const diffBlocks = snapshot.diffView.length > 0
    ? snapshot.diffView.map((diff) => `
        <article class="card full">
          <div class="mono">${escapeHtml(diff.file)}</div>
          <div class="diff">
            <pre>${escapeHtml(diff.before)}</pre>
            <pre>${escapeHtml(diff.after)}</pre>
          </div>
        </article>
      `).join("")
    : `<article class="card full"><div class="muted">No preview diff loaded yet. Run Preview.</div></article>`;

  return `
    <section class="grid">
      ${renderWorkflowControls()}
      <article class="card full">
        <div class="muted">Plan Summary</div>
        <table class="table">
          <thead>
            <tr>
              <th>Plan</th>
              <th>Tasks</th>
              <th>Affected Files</th>
              <th>Impact</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </article>
      ${diffBlocks}
    </section>
  `;
}

function renderTimelineView(): string {
  if (!snapshot) {
    return "";
  }

  const entries = snapshot.timeline.states;
  const nodes = entries.length > 0
    ? entries.map((entry) => {
      const isCurrent = entry.index === snapshot?.timeline.currentIndex;
      return `
        <button
          type="button"
          class="timeline-node ${isCurrent ? "current" : ""}"
          data-timeline-index="${entry.index}"
          title="${escapeHtml(entry.action)}">
          <span class="timeline-label">${escapeHtml(entry.label)}</span>
          <span class="timeline-action">${escapeHtml(entry.action)}</span>
        </button>
      `;
    }).join("")
    : `<div class="muted">No transitions recorded yet.</div>`;

  const inspector = snapshot.stateInspector;
  const whyRows = inspector.why.length > 0
    ? inspector.why.map((line) => `<li>${escapeHtml(line)}</li>`).join("")
    : "<li>No transition explanation available.</li>";
  const dependencyRows = inspector.dependencyChain.length > 0
    ? inspector.dependencyChain.map((line) => `<li class=\"mono\">${escapeHtml(line)}</li>`).join("")
    : "<li>No dependency chain captured.</li>";

  const patchRows = snapshot.stateDiff && snapshot.stateDiff.patches.length > 0
    ? snapshot.stateDiff.patches.map((patch) => `
      <tr>
        <td class="mono">${escapeHtml(patch.path)}</td>
        <td>${escapeHtml(patch.op)}</td>
        <td><pre class="mono compact">${escapeHtml(JSON.stringify(patch.before, null, 2) ?? "null")}</pre></td>
        <td><pre class="mono compact">${escapeHtml(JSON.stringify(patch.after, null, 2) ?? "null")}</pre></td>
      </tr>
    `).join("")
    : `<tr><td colspan="4" class="muted">No diff patches for current state.</td></tr>`;

  const replayTrace = snapshot.replayTrace
    ? `
      <article class="card full">
        <div class="muted">Replay Trace</div>
        <p class="mono">visited=${snapshot.replayTrace.visitedStates.length} · replayTime=${snapshot.replayTrace.replayTime}ms · consistency=${snapshot.replayTrace.consistencyCheck} · fallback=${snapshot.replayTrace.fallbackUsed}</p>
      </article>
    `
    : "";

  return `
    <section class="grid">
      <article class="card full">
        <div class="muted">Time Navigation</div>
        <div class="timeline-controls">
          <button id="timelinePlayBtn" ${snapshot.timeline.playing ? "disabled" : ""}>Play</button>
          <button id="timelinePauseBtn" class="ghost" ${snapshot.timeline.playing ? "" : "disabled"}>Pause</button>
          <button id="timelineStepBackBtn" class="secondary" ${snapshot.timeline.canStepBackward ? "" : "disabled"}>Step Back</button>
          <button id="timelineStepForwardBtn" class="secondary" ${snapshot.timeline.canStepForward ? "" : "disabled"}>Step Forward</button>
          <span class="mono">Current Index: ${snapshot.timeline.currentIndex}</span>
        </div>
        <div class="timeline-track">${nodes}</div>
      </article>

      <article class="card wide">
        <div class="muted">Why Did This Happen?</div>
        <ul class="list">${whyRows}</ul>
      </article>

      <article class="card">
        <div class="muted">Dependency Chain</div>
        <ul class="list">${dependencyRows}</ul>
      </article>

      <article class="card full">
        <div class="muted">State Inspector (Exact Replay State)</div>
        <pre class="mono">${escapeHtml(JSON.stringify({
          intent: inspector.intent,
          ast: inspector.ast,
          violations: inspector.violations,
          plans: inspector.plans,
        }, null, 2))}</pre>
      </article>

      <article class="card full">
        <div class="muted">State Diff Patches</div>
        <table class="table">
          <thead>
            <tr>
              <th>Path</th>
              <th>Op</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>${patchRows}</tbody>
        </table>
      </article>

      ${replayTrace}
    </section>
  `;
}

function renderPolicyView(): string {
  if (!snapshot) {
    return "";
  }

  const rows = snapshot.policyView.map((entry) => `
    <tr>
      <td>${statusChip(entry.decision)}</td>
      <td>${escapeHtml(entry.rulesMatched.join(", ")) || "none"}</td>
      <td>${escapeHtml(entry.source)}</td>
    </tr>
  `).join("");

  const pendingRows = snapshot.pendingApprovals.length > 0
    ? snapshot.pendingApprovals.map((entry) => `<li><span class="mono">${escapeHtml(entry.id)}</span> ${escapeHtml(entry.command)}</li>`).join("")
    : "<li>No pending approvals.</li>";

  return `
    <section class="grid">
      <article class="card full">
        <div class="muted">Policy Decision Trace</div>
        <table class="table">
          <thead>
            <tr>
              <th>Decision</th>
              <th>Rules Matched</th>
              <th>Source Layer</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </article>
      <article class="card full">
        <div class="muted">Pending Approvals</div>
        <ul class="list">${pendingRows}</ul>
      </article>
    </section>
  `;
}

function renderAuditView(): string {
  if (!snapshot) {
    return "";
  }

  const rows = snapshot.auditView.events.length > 0
    ? snapshot.auditView.events.map((event) => `
      <tr>
        <td class="mono">${escapeHtml(event.timestamp)}</td>
        <td>${escapeHtml(event.actor.role)}</td>
        <td>${escapeHtml(event.action)}</td>
        <td>${escapeHtml(event.result)}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="4" class="muted">No events for current filters.</td></tr>`;

  return `
    <section class="grid">
      <article class="card full">
        <div style="display:flex;gap:8px;align-items:end;">
          <div>
            <label for="auditRoleFilter">Role Filter</label>
            <input id="auditRoleFilter" type="text" placeholder="architect|analyst|conductor|enforcer" value="${escapeHtml(auditFilters.role ?? "")}" />
          </div>
          <div>
            <label for="auditEnvFilter">Environment Filter</label>
            <input id="auditEnvFilter" type="text" placeholder="local|ci|staging|production" value="${escapeHtml(auditFilters.environment ?? "")}" />
          </div>
          <button id="applyAuditFilterBtn" class="ghost">Apply</button>
        </div>
      </article>
      <article class="card full">
        <div class="muted">Immutable Audit Timeline</div>
        <table class="table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Role</th>
              <th>Action</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </article>
    </section>
  `;
}

function renderMacroLibraryView(): string {
  if (!snapshot) {
    return "";
  }

  const libraries = snapshot.macroUI.libraries.length > 0
    ? snapshot.macroUI.libraries.map((library) => `<li>${escapeHtml(library)}</li>`).join("")
    : "<li>No libraries installed.</li>";

  const macros = snapshot.macroUI.macros.length > 0
    ? snapshot.macroUI.macros.map((macro) => `<li class="mono">${escapeHtml(macro)}</li>`).join("")
    : "<li>No macros discovered.</li>";

  const abstractions = snapshot.macroUI.abstractions.length > 0
    ? snapshot.macroUI.abstractions.map((abstraction) => `<li class="mono">${escapeHtml(abstraction)}</li>`).join("")
    : "<li>No abstractions discovered.</li>";

  return `
    <section class="grid">
      <article class="card">
        <div class="muted">Libraries</div>
        <ul class="list">${libraries}</ul>
      </article>
      <article class="card">
        <div class="muted">Macros</div>
        <ul class="list">${macros}</ul>
      </article>
      <article class="card">
        <div class="muted">Abstractions</div>
        <ul class="list">${abstractions}</ul>
      </article>
      <article class="card full">
        <label for="macroCommandInput">Macro/Abstraction Command</label>
        <div class="dsl-row">
          <input id="macroCommandInput" type="text" placeholder="choir macro local.id key='value'" />
          <button id="runMacroCommandBtn" class="secondary">Run</button>
        </div>
      </article>
    </section>
  `;
}

function renderWorkspaceView(): string {
  if (!snapshot) {
    return "";
  }

  const traceRows = snapshot.traces.slice(0, 8).map((trace) => `
      <tr>
        <td>${escapeHtml(trace.action)}</td>
        <td class="mono">${escapeHtml(trace.resultingDSL)}</td>
      </tr>
    `).join("");

  return `
    <section class="grid">
      <article class="card full">
        <div class="muted">Role View</div>
        <table class="table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Focus</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>architect</td><td>${snapshot.roleView.architect.join(", ")}</td></tr>
            <tr><td>analyst</td><td>${snapshot.roleView.analyst.join(", ")}</td></tr>
            <tr><td>conductor</td><td>${snapshot.roleView.conductor.join(", ")}</td></tr>
            <tr><td>enforcer</td><td>${snapshot.roleView.enforcer.join(", ")}</td></tr>
          </tbody>
        </table>
      </article>
      <article class="card full">
        <div class="muted">Current Control Plane (Canonical Projection)</div>
        <pre class="mono">${escapeHtml(JSON.stringify(snapshot.controlPlane, null, 2))}</pre>
      </article>
      <article class="card full">
        <div class="muted">Recent UI Traceability</div>
        <table class="table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Resulting DSL</th>
            </tr>
          </thead>
          <tbody>
            ${traceRows || `<tr><td colspan="2" class="muted">No UI traces yet.</td></tr>`}
          </tbody>
        </table>
      </article>
    </section>
  `;
}

function wireSurfaceButtons(): void {
  const runDefineBtn = document.getElementById("runDefineBtn");
  const runPlanBtn = document.getElementById("runPlanBtn");
  const runPreviewBtn = document.getElementById("runPreviewBtn");
  const runApproveBtn = document.getElementById("runApproveBtn");
  const runExecuteBtn = document.getElementById("runExecuteBtn");
  const runAuditBtn = document.getElementById("runAuditBtn");
  const applyAuditFilterBtn = document.getElementById("applyAuditFilterBtn");
  const runMacroCommandBtn = document.getElementById("runMacroCommandBtn");
  const timelinePlayBtn = document.getElementById("timelinePlayBtn");
  const timelinePauseBtn = document.getElementById("timelinePauseBtn");
  const timelineStepBackBtn = document.getElementById("timelineStepBackBtn");
  const timelineStepForwardBtn = document.getElementById("timelineStepForwardBtn");

  if (runDefineBtn instanceof HTMLButtonElement) {
    runDefineBtn.addEventListener("click", () => {
      const intentInput = document.getElementById("intentInput");
      const intent = intentInput instanceof HTMLInputElement ? intentInput.value.trim() : "";
      postAction({
        type: "run-workflow",
        role: getActiveRole(),
        step: "define-intent",
        payload: { intent },
      });
    });
  }

  if (runPlanBtn instanceof HTMLButtonElement) {
    runPlanBtn.addEventListener("click", () => {
      const goalInput = document.getElementById("planGoalInput");
      const goal = goalInput instanceof HTMLInputElement ? goalInput.value.trim() : "";
      postAction({
        type: "run-workflow",
        role: getActiveRole(),
        step: "plan",
        payload: goal.length > 0 ? { goal } : {},
      });
    });
  }

  if (runPreviewBtn instanceof HTMLButtonElement) {
    runPreviewBtn.addEventListener("click", () => {
      const planInput = document.getElementById("previewPlanInput");
      const planId = planInput instanceof HTMLInputElement ? planInput.value.trim() : "";
      postAction({
        type: "run-workflow",
        role: getActiveRole(),
        step: "preview",
        payload: planId.length > 0 ? { planId } : {},
      });
    });
  }

  if (runApproveBtn instanceof HTMLButtonElement) {
    runApproveBtn.addEventListener("click", () => {
      const approveInput = document.getElementById("approveInput");
      const value = approveInput instanceof HTMLInputElement ? approveInput.value.trim() : "";
      if (!value) {
        appendLog("Approve requires diff id or plan id.");
        return;
      }

      const payload = value.startsWith("diff-") ? { diffId: value } : { planId: value };
      postAction({
        type: "run-workflow",
        role: getActiveRole(),
        step: "approve",
        payload,
      });
    });
  }

  if (runExecuteBtn instanceof HTMLButtonElement) {
    runExecuteBtn.addEventListener("click", () => {
      const executeInput = document.getElementById("executePlanInput");
      const planId = executeInput instanceof HTMLInputElement ? executeInput.value.trim() : "";
      postAction({
        type: "run-workflow",
        role: getActiveRole(),
        step: "execute",
        payload: planId.length > 0 ? { planId } : {},
      });
    });
  }

  if (runAuditBtn instanceof HTMLButtonElement) {
    runAuditBtn.addEventListener("click", () => {
      postAction({
        type: "run-workflow",
        role: getActiveRole(),
        step: "audit",
      });
    });
  }

  if (applyAuditFilterBtn instanceof HTMLButtonElement) {
    applyAuditFilterBtn.addEventListener("click", () => {
      const roleInput = document.getElementById("auditRoleFilter");
      const envInput = document.getElementById("auditEnvFilter");

      auditFilters = {
        ...(roleInput instanceof HTMLInputElement && roleInput.value.trim().length > 0
          ? { role: roleInput.value.trim() }
          : {}),
        ...(envInput instanceof HTMLInputElement && envInput.value.trim().length > 0
          ? { environment: envInput.value.trim() }
          : {}),
      };

      postAction({
        type: "refresh",
        role: getActiveRole(),
        filters: auditFilters,
      });
    });
  }

  if (runMacroCommandBtn instanceof HTMLButtonElement) {
    runMacroCommandBtn.addEventListener("click", () => {
      const input = document.getElementById("macroCommandInput");
      if (!(input instanceof HTMLInputElement)) {
        return;
      }

      const value = input.value.trim();
      if (value.length === 0) {
        return;
      }

      postAction({
        type: "run-dsl",
        role: getActiveRole(),
        dsl: value,
      });
    });
  }

  if (timelinePlayBtn instanceof HTMLButtonElement) {
    timelinePlayBtn.addEventListener("click", () => {
      postAction({
        type: "replay-control",
        role: getActiveRole(),
        control: "play",
      });
    });
  }

  if (timelinePauseBtn instanceof HTMLButtonElement) {
    timelinePauseBtn.addEventListener("click", () => {
      postAction({
        type: "replay-control",
        role: getActiveRole(),
        control: "pause",
      });
    });
  }

  if (timelineStepBackBtn instanceof HTMLButtonElement) {
    timelineStepBackBtn.addEventListener("click", () => {
      postAction({
        type: "replay-control",
        role: getActiveRole(),
        control: "step-backward",
      });
    });
  }

  if (timelineStepForwardBtn instanceof HTMLButtonElement) {
    timelineStepForwardBtn.addEventListener("click", () => {
      postAction({
        type: "replay-control",
        role: getActiveRole(),
        control: "step-forward",
      });
    });
  }

  document.querySelectorAll<HTMLButtonElement>(".timeline-node[data-timeline-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.timelineIndex;
      if (!value) {
        return;
      }

      const parsedIndex = Number.parseInt(value, 10);
      if (!Number.isFinite(parsedIndex)) {
        return;
      }

      postAction({
        type: "replay-control",
        role: getActiveRole(),
        control: "jump",
        index: parsedIndex,
      });
    });
  });
}

function renderSurface(): void {
  if (!snapshot) {
    surfaceContainer.innerHTML = "";
    return;
  }

  if (activeSurface === "dashboard") {
    surfaceContainer.innerHTML = renderDashboard();
  } else if (activeSurface === "workspace") {
    surfaceContainer.innerHTML = renderWorkspaceView();
  } else if (activeSurface === "plan-view") {
    surfaceContainer.innerHTML = renderPlanView();
  } else if (activeSurface === "timeline-view") {
    surfaceContainer.innerHTML = renderTimelineView();
  } else if (activeSurface === "policy-view") {
    surfaceContainer.innerHTML = renderPolicyView();
  } else if (activeSurface === "audit-view") {
    surfaceContainer.innerHTML = renderAuditView();
  } else {
    surfaceContainer.innerHTML = renderMacroLibraryView();
  }

  wireSurfaceButtons();
}

function renderSnapshot(newSnapshot: ProductSnapshot): void {
  snapshot = newSnapshot;
  roleSelect.value = newSnapshot.activeRole;
  renderTabs();
  renderSurface();
  syncPlaybackTimer();
}

function handleActionResult(result: ProductActionResult): void {
  if (result.ok) {
    appendLog(result.message);
  } else {
    appendLog(result.error ? `${result.error.source}: ${result.error.message}` : result.message);
  }

  renderSnapshot(result.snapshot);
}

window.addEventListener("message", (event: MessageEvent<WebviewOutboundMessage>) => {
  const message = event.data;

  if (message.type === "snapshot") {
    renderSnapshot(message.payload);
    return;
  }

  if (message.type === "action-result") {
    handleActionResult(message.payload);
  }
});

runDslBtn.addEventListener("click", () => {
  const dsl = dslInput.value.trim();
  if (dsl.length === 0) {
    return;
  }

  postAction({
    type: "run-dsl",
    role: getActiveRole(),
    dsl,
  });
});

refreshBtn.addEventListener("click", () => {
  postAction({
    type: "refresh",
    role: getActiveRole(),
    filters: auditFilters,
  });
});

roleSelect.addEventListener("change", () => {
  postAction({
    type: "refresh",
    role: getActiveRole(),
    filters: auditFilters,
  });
});

vscode.postMessage({ type: "ready" });
