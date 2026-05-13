const j={architect:["define-intent","approve","audit"],analyst:["audit"],conductor:["define-intent","plan","preview","approve","audit"],enforcer:["execute","audit"]},F={dashboard:"Dashboard",workspace:"Workspace","plan-view":"Plan View","timeline-view":"Time Travel","policy-view":"Policy View","audit-view":"Audit View","macro-library":"Macro/Abstraction"},T=window.vscode;if(!T)throw new Error("VSCode API not available in webview context.");const $=document.getElementById("roleSelect"),x=document.getElementById("dslInput"),S=document.getElementById("runDslBtn"),A=document.getElementById("refreshBtn"),g=document.getElementById("surfaceTabs"),m=document.getElementById("surfaceContainer"),B=document.getElementById("consoleOutput");if(!($ instanceof HTMLSelectElement)||!(x instanceof HTMLInputElement)||!(S instanceof HTMLButtonElement)||!(A instanceof HTMLButtonElement)||!(g instanceof HTMLElement)||!(m instanceof HTMLElement)||!(B instanceof HTMLElement))throw new Error("Choir Control Center webview is missing required elements.");let t=null,p="dashboard",y={},h;function o(){const e=$.value;return e==="architect"||e==="analyst"||e==="conductor"||e==="enforcer"?e:"conductor"}function n(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;")}function E(e){const a=new Date().toISOString(),i=B.textContent??"";B.textContent=`[${a}] ${e}
${i}`}function D(){typeof h<"u"&&(window.clearInterval(h),h=void 0)}function N(){if(!t?.timeline.playing){D();return}typeof h<"u"||(h=window.setInterval(()=>{if(!t?.timeline.playing||!t.timeline.canStepForward){c({type:"replay-control",role:o(),control:"pause"});return}c({type:"replay-control",role:o(),control:"step-forward"})},900))}function c(e){T.postMessage({type:"action",payload:e})}function v(e,a){return j[e].includes(a)}function L(e){return e==="stable"||e==="allow"?`<span class="chip success">${n(e)}</span>`:e==="needs-attention"||e==="deny"?`<span class="chip danger">${n(e)}</span>`:`<span class="chip warn">${n(e)}</span>`}function H(){if(!t){g.innerHTML="";return}const e=t.availableSurfaces;e.includes(p)||(p=e[0]??"dashboard"),g.innerHTML=e.map(a=>`<button type="button" class="surface-tab ${a===p?"active":""}" data-surface="${a}">${F[a]}</button>`).join(""),g.querySelectorAll(".surface-tab").forEach(a=>{a.addEventListener("click",()=>{const i=a.dataset.surface;i&&i!==p&&(p=i,H(),R())})})}function V(){if(!t)return"";const e=t.dashboard.recommendations.length>0?t.dashboard.recommendations.map(s=>`<li>${n(s)}</li>`).join(""):"<li>No recommendations. System is aligned.</li>",a=t.dashboard.recentActions.length>0?t.dashboard.recentActions.map(s=>`<li><span class="mono">${n(s.timestamp)}</span> ${n(s.action)} (${n(s.result)})</li>`).join(""):"<li>No audit events yet.</li>",i=t.production?L(t.production.health.healthy?"stable":"needs-attention"):'<span class="chip warn">unavailable</span>',u=t.production&&t.production.alerts.length>0?t.production.alerts.map(s=>`<li><span class="mono">${n(s.severity)}</span> ${n(s.condition)}</li>`).join(""):"<li>No active production alerts.</li>",f=t.production&&t.production.slos.length>0?t.production.slos.map(s=>`<li>${n(s.name)}: ${s.actual.toFixed(2)} / ${s.target.toFixed(2)} (${s.met?"met":"miss"})</li>`).join(""):"<li>No SLO evaluation available.</li>";return`
    <section class="grid">
      <article class="card">
        <div class="muted">System Health</div>
        <div class="kpi">${L(t.dashboard.systemHealth)}</div>
      </article>
      <article class="card">
        <div class="muted">Production Health</div>
        <div class="kpi">${i}</div>
      </article>
      <article class="card">
        <div class="muted">Active Plans</div>
        <div class="kpi">${t.dashboard.activePlans}</div>
      </article>
      <article class="card">
        <div class="muted">Policy Violations</div>
        <div class="kpi">${t.dashboard.policyViolations}</div>
      </article>
      <article class="card wide">
        <div class="muted">Recommended Next Actions</div>
        <ul class="list">${e}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Recent Actions</div>
        <ul class="list">${a}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Production Alerts</div>
        <ul class="list">${u}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Production SLOs</div>
        <ul class="list">${f}</ul>
      </article>
    </section>
  `}function O(){if(!t)return"";const e=o();return`
    <article class="card full">
      <div class="muted">Guided Workflow</div>
      <div class="workflow">${["define-intent","plan","preview","approve","execute","audit"].map(i=>{const u=i,f=t?.workflow.current===u,s=t?.workflow.completed.includes(u);return`<span class="step ${f?"current":""} ${s?"done":""}">${n(i)}</span>`}).join("")}</div>
      <p class="muted">Current step: ${n(t.workflow.current)}</p>
      <div class="grid">
        <div class="card">
          <label for="intentInput">Define Intent</label>
          <input id="intentInput" type="text" placeholder="create safer service boundaries" />
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button id="runDefineBtn" ${v(e,"define-intent")?"":"disabled"}>Run</button>
          </div>
        </div>
        <div class="card">
          <label for="planGoalInput">Generate Plan</label>
          <input id="planGoalInput" type="text" placeholder="optional goal override" />
          <button id="runPlanBtn" style="margin-top:8px;" ${v(e,"plan")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="previewPlanInput">Preview Plan ID (optional)</label>
          <input id="previewPlanInput" type="text" placeholder="plan-abc123" />
          <button id="runPreviewBtn" style="margin-top:8px;" ${v(e,"preview")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="approveInput">Approve Diff ID or Plan ID</label>
          <input id="approveInput" type="text" placeholder="diff-... or plan-..." />
          <button id="runApproveBtn" style="margin-top:8px;" ${v(e,"approve")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="executePlanInput">Execute Plan ID (optional)</label>
          <input id="executePlanInput" type="text" placeholder="plan-abc123" />
          <button id="runExecuteBtn" style="margin-top:8px;" ${v(e,"execute")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label>Audit</label>
          <p class="muted">Fetch current immutable audit timeline.</p>
          <button id="runAuditBtn" ${v(e,"audit")?"":"disabled"}>Run</button>
        </div>
      </div>
    </article>
  `}function U(){if(!t)return"";const e=t.planView.length>0?t.planView.map(i=>`
      <tr>
        <td class="mono">${n(i.planId)}</td>
        <td>${n(i.tasks.join(", "))}</td>
        <td class="mono">${n(i.affectedFiles.join(", "))}</td>
        <td>${i.estimatedImpact}</td>
      </tr>
    `).join(""):'<tr><td colspan="4" class="muted">No plans yet.</td></tr>',a=t.diffView.length>0?t.diffView.map(i=>`
        <article class="card full">
          <div class="mono">${n(i.file)}</div>
          <div class="diff">
            <pre>${n(i.before)}</pre>
            <pre>${n(i.after)}</pre>
          </div>
        </article>
      `).join(""):'<article class="card full"><div class="muted">No preview diff loaded yet. Run Preview.</div></article>';return`
    <section class="grid">
      ${O()}
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
          <tbody>${e}</tbody>
        </table>
      </article>
      ${a}
    </section>
  `}function W(){if(!t)return"";const e=t.timeline.states,a=e.length>0?e.map(d=>`
        <button
          type="button"
          class="timeline-node ${d.index===t?.timeline.currentIndex?"current":""}"
          data-timeline-index="${d.index}"
          title="${n(d.action)}">
          <span class="timeline-label">${n(d.label)}</span>
          <span class="timeline-action">${n(d.action)}</span>
        </button>
      `).join(""):'<div class="muted">No transitions recorded yet.</div>',i=t.stateInspector,u=i.why.length>0?i.why.map(d=>`<li>${n(d)}</li>`).join(""):"<li>No transition explanation available.</li>",f=i.dependencyChain.length>0?i.dependencyChain.map(d=>`<li class="mono">${n(d)}</li>`).join(""):"<li>No dependency chain captured.</li>",s=t.stateDiff&&t.stateDiff.patches.length>0?t.stateDiff.patches.map(d=>`
      <tr>
        <td class="mono">${n(d.path)}</td>
        <td>${n(d.op)}</td>
        <td><pre class="mono compact">${n(JSON.stringify(d.before,null,2)??"null")}</pre></td>
        <td><pre class="mono compact">${n(JSON.stringify(d.after,null,2)??"null")}</pre></td>
      </tr>
    `).join(""):'<tr><td colspan="4" class="muted">No diff patches for current state.</td></tr>',b=t.replayTrace?`
      <article class="card full">
        <div class="muted">Replay Trace</div>
        <p class="mono">visited=${t.replayTrace.visitedStates.length} · replayTime=${t.replayTrace.replayTime}ms · consistency=${t.replayTrace.consistencyCheck} · fallback=${t.replayTrace.fallbackUsed}</p>
      </article>
    `:"";return`
    <section class="grid">
      <article class="card full">
        <div class="muted">Time Navigation</div>
        <div class="timeline-controls">
          <button id="timelinePlayBtn" ${t.timeline.playing?"disabled":""}>Play</button>
          <button id="timelinePauseBtn" class="ghost" ${t.timeline.playing?"":"disabled"}>Pause</button>
          <button id="timelineStepBackBtn" class="secondary" ${t.timeline.canStepBackward?"":"disabled"}>Step Back</button>
          <button id="timelineStepForwardBtn" class="secondary" ${t.timeline.canStepForward?"":"disabled"}>Step Forward</button>
          <span class="mono">Current Index: ${t.timeline.currentIndex}</span>
        </div>
        <div class="timeline-track">${a}</div>
      </article>

      <article class="card wide">
        <div class="muted">Why Did This Happen?</div>
        <ul class="list">${u}</ul>
      </article>

      <article class="card">
        <div class="muted">Dependency Chain</div>
        <ul class="list">${f}</ul>
      </article>

      <article class="card full">
        <div class="muted">State Inspector (Exact Replay State)</div>
        <pre class="mono">${n(JSON.stringify({intent:i.intent,ast:i.ast,violations:i.violations,plans:i.plans},null,2))}</pre>
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
          <tbody>${s}</tbody>
        </table>
      </article>

      ${b}
    </section>
  `}function q(){if(!t)return"";const e=t.policyView.map(i=>`
    <tr>
      <td>${L(i.decision)}</td>
      <td>${n(i.rulesMatched.join(", "))||"none"}</td>
      <td>${n(i.source)}</td>
    </tr>
  `).join(""),a=t.pendingApprovals.length>0?t.pendingApprovals.map(i=>`<li><span class="mono">${n(i.id)}</span> ${n(i.command)}</li>`).join(""):"<li>No pending approvals.</li>";return`
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
          <tbody>${e}</tbody>
        </table>
      </article>
      <article class="card full">
        <div class="muted">Pending Approvals</div>
        <ul class="list">${a}</ul>
      </article>
    </section>
  `}function G(){if(!t)return"";const e=t.auditView.events.length>0?t.auditView.events.map(a=>`
      <tr>
        <td class="mono">${n(a.timestamp)}</td>
        <td>${n(a.actor.role)}</td>
        <td>${n(a.action)}</td>
        <td>${n(a.result)}</td>
      </tr>
    `).join(""):'<tr><td colspan="4" class="muted">No events for current filters.</td></tr>';return`
    <section class="grid">
      <article class="card full">
        <div style="display:flex;gap:8px;align-items:end;">
          <div>
            <label for="auditRoleFilter">Role Filter</label>
            <input id="auditRoleFilter" type="text" placeholder="architect|analyst|conductor|enforcer" value="${n(y.role??"")}" />
          </div>
          <div>
            <label for="auditEnvFilter">Environment Filter</label>
            <input id="auditEnvFilter" type="text" placeholder="local|ci|staging|production" value="${n(y.environment??"")}" />
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
          <tbody>${e}</tbody>
        </table>
      </article>
    </section>
  `}function J(){if(!t)return"";const e=t.macroUI.libraries.length>0?t.macroUI.libraries.map(u=>`<li>${n(u)}</li>`).join(""):"<li>No libraries installed.</li>",a=t.macroUI.macros.length>0?t.macroUI.macros.map(u=>`<li class="mono">${n(u)}</li>`).join(""):"<li>No macros discovered.</li>",i=t.macroUI.abstractions.length>0?t.macroUI.abstractions.map(u=>`<li class="mono">${n(u)}</li>`).join(""):"<li>No abstractions discovered.</li>";return`
    <section class="grid">
      <article class="card">
        <div class="muted">Libraries</div>
        <ul class="list">${e}</ul>
      </article>
      <article class="card">
        <div class="muted">Macros</div>
        <ul class="list">${a}</ul>
      </article>
      <article class="card">
        <div class="muted">Abstractions</div>
        <ul class="list">${i}</ul>
      </article>
      <article class="card full">
        <label for="macroCommandInput">Macro/Abstraction Command</label>
        <div class="dsl-row">
          <input id="macroCommandInput" type="text" placeholder="choir macro local.id key='value'" />
          <button id="runMacroCommandBtn" class="secondary">Run</button>
        </div>
      </article>
    </section>
  `}function _(){if(!t)return"";const e=t.traces.slice(0,8).map(a=>`
      <tr>
        <td>${n(a.action)}</td>
        <td class="mono">${n(a.resultingDSL)}</td>
      </tr>
    `).join("");return`
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
            <tr><td>architect</td><td>${t.roleView.architect.join(", ")}</td></tr>
            <tr><td>analyst</td><td>${t.roleView.analyst.join(", ")}</td></tr>
            <tr><td>conductor</td><td>${t.roleView.conductor.join(", ")}</td></tr>
            <tr><td>enforcer</td><td>${t.roleView.enforcer.join(", ")}</td></tr>
          </tbody>
        </table>
      </article>
      <article class="card full">
        <div class="muted">Current Control Plane (Canonical Projection)</div>
        <pre class="mono">${n(JSON.stringify(t.controlPlane,null,2))}</pre>
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
            ${e||'<tr><td colspan="2" class="muted">No UI traces yet.</td></tr>'}
          </tbody>
        </table>
      </article>
    </section>
  `}function K(){const e=document.getElementById("runDefineBtn"),a=document.getElementById("runPlanBtn"),i=document.getElementById("runPreviewBtn"),u=document.getElementById("runApproveBtn"),f=document.getElementById("runExecuteBtn"),s=document.getElementById("runAuditBtn"),b=document.getElementById("applyAuditFilterBtn"),d=document.getElementById("runMacroCommandBtn"),I=document.getElementById("timelinePlayBtn"),k=document.getElementById("timelinePauseBtn"),M=document.getElementById("timelineStepBackBtn"),P=document.getElementById("timelineStepForwardBtn");e instanceof HTMLButtonElement&&e.addEventListener("click",()=>{const r=document.getElementById("intentInput"),l=r instanceof HTMLInputElement?r.value.trim():"";c({type:"run-workflow",role:o(),step:"define-intent",payload:{intent:l}})}),a instanceof HTMLButtonElement&&a.addEventListener("click",()=>{const r=document.getElementById("planGoalInput"),l=r instanceof HTMLInputElement?r.value.trim():"";c({type:"run-workflow",role:o(),step:"plan",payload:l.length>0?{goal:l}:{}})}),i instanceof HTMLButtonElement&&i.addEventListener("click",()=>{const r=document.getElementById("previewPlanInput"),l=r instanceof HTMLInputElement?r.value.trim():"";c({type:"run-workflow",role:o(),step:"preview",payload:l.length>0?{planId:l}:{}})}),u instanceof HTMLButtonElement&&u.addEventListener("click",()=>{const r=document.getElementById("approveInput"),l=r instanceof HTMLInputElement?r.value.trim():"";if(!l){E("Approve requires diff id or plan id.");return}const w=l.startsWith("diff-")?{diffId:l}:{planId:l};c({type:"run-workflow",role:o(),step:"approve",payload:w})}),f instanceof HTMLButtonElement&&f.addEventListener("click",()=>{const r=document.getElementById("executePlanInput"),l=r instanceof HTMLInputElement?r.value.trim():"";c({type:"run-workflow",role:o(),step:"execute",payload:l.length>0?{planId:l}:{}})}),s instanceof HTMLButtonElement&&s.addEventListener("click",()=>{c({type:"run-workflow",role:o(),step:"audit"})}),b instanceof HTMLButtonElement&&b.addEventListener("click",()=>{const r=document.getElementById("auditRoleFilter"),l=document.getElementById("auditEnvFilter");y={...r instanceof HTMLInputElement&&r.value.trim().length>0?{role:r.value.trim()}:{},...l instanceof HTMLInputElement&&l.value.trim().length>0?{environment:l.value.trim()}:{}},c({type:"refresh",role:o(),filters:y})}),d instanceof HTMLButtonElement&&d.addEventListener("click",()=>{const r=document.getElementById("macroCommandInput");if(!(r instanceof HTMLInputElement))return;const l=r.value.trim();l.length!==0&&c({type:"run-dsl",role:o(),dsl:l})}),I instanceof HTMLButtonElement&&I.addEventListener("click",()=>{c({type:"replay-control",role:o(),control:"play"})}),k instanceof HTMLButtonElement&&k.addEventListener("click",()=>{c({type:"replay-control",role:o(),control:"pause"})}),M instanceof HTMLButtonElement&&M.addEventListener("click",()=>{c({type:"replay-control",role:o(),control:"step-backward"})}),P instanceof HTMLButtonElement&&P.addEventListener("click",()=>{c({type:"replay-control",role:o(),control:"step-forward"})}),document.querySelectorAll(".timeline-node[data-timeline-index]").forEach(r=>{r.addEventListener("click",()=>{const l=r.dataset.timelineIndex;if(!l)return;const w=Number.parseInt(l,10);Number.isFinite(w)&&c({type:"replay-control",role:o(),control:"jump",index:w})})})}function R(){if(!t){m.innerHTML="";return}p==="dashboard"?m.innerHTML=V():p==="workspace"?m.innerHTML=_():p==="plan-view"?m.innerHTML=U():p==="timeline-view"?m.innerHTML=W():p==="policy-view"?m.innerHTML=q():p==="audit-view"?m.innerHTML=G():m.innerHTML=J(),K()}function C(e){t=e,$.value=e.activeRole,H(),R(),N()}function z(e){e.ok?E(e.message):E(e.error?`${e.error.source}: ${e.error.message}`:e.message),C(e.snapshot)}window.addEventListener("message",e=>{const a=e.data;if(a.type==="snapshot"){C(a.payload);return}a.type==="action-result"&&z(a.payload)});S.addEventListener("click",()=>{const e=x.value.trim();e.length!==0&&c({type:"run-dsl",role:o(),dsl:e})});A.addEventListener("click",()=>{c({type:"refresh",role:o(),filters:y})});$.addEventListener("change",()=>{c({type:"refresh",role:o(),filters:y})});T.postMessage({type:"ready"});
