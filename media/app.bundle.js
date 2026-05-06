const C={architect:["define-intent","approve","audit"],analyst:["audit"],conductor:["define-intent","plan","preview","approve","audit"],enforcer:["execute","audit"]},j={dashboard:"Dashboard",workspace:"Workspace","plan-view":"Plan View","timeline-view":"Time Travel","policy-view":"Policy View","audit-view":"Audit View","macro-library":"Macro/Abstraction"},L=window.vscode;if(!L)throw new Error("VSCode API not available in webview context.");const I=document.getElementById("roleSelect"),x=document.getElementById("dslInput"),P=document.getElementById("runDslBtn"),S=document.getElementById("refreshBtn"),g=document.getElementById("surfaceTabs"),p=document.getElementById("surfaceContainer"),B=document.getElementById("consoleOutput");if(!(I instanceof HTMLSelectElement)||!(x instanceof HTMLInputElement)||!(P instanceof HTMLButtonElement)||!(S instanceof HTMLButtonElement)||!(g instanceof HTMLElement)||!(p instanceof HTMLElement)||!(B instanceof HTMLElement))throw new Error("Choir Control Center webview is missing required elements.");let t=null,u="dashboard",m={},b;function s(){const e=I.value;return e==="architect"||e==="analyst"||e==="conductor"||e==="enforcer"?e:"conductor"}function i(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;")}function E(e){const a=new Date().toISOString(),n=B.textContent??"";B.textContent=`[${a}] ${e}
${n}`}function D(){typeof b<"u"&&(window.clearInterval(b),b=void 0)}function F(){if(!t?.timeline.playing){D();return}typeof b<"u"||(b=window.setInterval(()=>{if(!t?.timeline.playing||!t.timeline.canStepForward){o({type:"replay-control",role:s(),control:"pause"});return}o({type:"replay-control",role:s(),control:"step-forward"})},900))}function o(e){L.postMessage({type:"action",payload:e})}function y(e,a){return C[e].includes(a)}function A(e){return e==="stable"||e==="allow"?`<span class="chip success">${i(e)}</span>`:e==="needs-attention"||e==="deny"?`<span class="chip danger">${i(e)}</span>`:`<span class="chip warn">${i(e)}</span>`}function V(){if(!t){g.innerHTML="";return}const e=t.availableSurfaces;e.includes(u)||(u=e[0]??"dashboard"),g.innerHTML=e.map(a=>`<button type="button" class="surface-tab ${a===u?"active":""}" data-surface="${a}">${j[a]}</button>`).join(""),g.querySelectorAll(".surface-tab").forEach(a=>{a.addEventListener("click",()=>{const n=a.dataset.surface;n&&(u=n,H())})})}function N(){if(!t)return"";const e=t.dashboard.recommendations.length>0?t.dashboard.recommendations.map(n=>`<li>${i(n)}</li>`).join(""):"<li>No recommendations. System is aligned.</li>",a=t.dashboard.recentActions.length>0?t.dashboard.recentActions.map(n=>`<li><span class="mono">${i(n.timestamp)}</span> ${i(n.action)} (${i(n.result)})</li>`).join(""):"<li>No audit events yet.</li>";return`
    <section class="grid">
      <article class="card">
        <div class="muted">System Health</div>
        <div class="kpi">${A(t.dashboard.systemHealth)}</div>
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
    </section>
  `}function O(){if(!t)return"";const e=s();return`
    <article class="card full">
      <div class="muted">Guided Workflow</div>
      <div class="workflow">${["define-intent","plan","preview","approve","execute","audit"].map(n=>{const d=n,f=t?.workflow.current===d,v=t?.workflow.completed.includes(d);return`<span class="step ${f?"current":""} ${v?"done":""}">${i(n)}</span>`}).join("")}</div>
      <p class="muted">Current step: ${i(t.workflow.current)}</p>
      <div class="grid">
        <div class="card">
          <label for="intentInput">Define Intent</label>
          <input id="intentInput" type="text" placeholder="create safer service boundaries" />
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button id="runDefineBtn" ${y(e,"define-intent")?"":"disabled"}>Run</button>
          </div>
        </div>
        <div class="card">
          <label for="planGoalInput">Generate Plan</label>
          <input id="planGoalInput" type="text" placeholder="optional goal override" />
          <button id="runPlanBtn" style="margin-top:8px;" ${y(e,"plan")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="previewPlanInput">Preview Plan ID (optional)</label>
          <input id="previewPlanInput" type="text" placeholder="plan-abc123" />
          <button id="runPreviewBtn" style="margin-top:8px;" ${y(e,"preview")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="approveInput">Approve Diff ID or Plan ID</label>
          <input id="approveInput" type="text" placeholder="diff-... or plan-..." />
          <button id="runApproveBtn" style="margin-top:8px;" ${y(e,"approve")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="executePlanInput">Execute Plan ID (optional)</label>
          <input id="executePlanInput" type="text" placeholder="plan-abc123" />
          <button id="runExecuteBtn" style="margin-top:8px;" ${y(e,"execute")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label>Audit</label>
          <p class="muted">Fetch current immutable audit timeline.</p>
          <button id="runAuditBtn" ${y(e,"audit")?"":"disabled"}>Run</button>
        </div>
      </div>
    </article>
  `}function U(){if(!t)return"";const e=t.planView.length>0?t.planView.map(n=>`
      <tr>
        <td class="mono">${i(n.planId)}</td>
        <td>${i(n.tasks.join(", "))}</td>
        <td class="mono">${i(n.affectedFiles.join(", "))}</td>
        <td>${n.estimatedImpact}</td>
      </tr>
    `).join(""):'<tr><td colspan="4" class="muted">No plans yet.</td></tr>',a=t.diffView.length>0?t.diffView.map(n=>`
        <article class="card full">
          <div class="mono">${i(n.file)}</div>
          <div class="diff">
            <pre>${i(n.before)}</pre>
            <pre>${i(n.after)}</pre>
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
  `}function W(){if(!t)return"";const e=t.timeline.states,a=e.length>0?e.map(c=>`
        <button
          type="button"
          class="timeline-node ${c.index===t?.timeline.currentIndex?"current":""}"
          data-timeline-index="${c.index}"
          title="${i(c.action)}">
          <span class="timeline-label">${i(c.label)}</span>
          <span class="timeline-action">${i(c.action)}</span>
        </button>
      `).join(""):'<div class="muted">No transitions recorded yet.</div>',n=t.stateInspector,d=n.why.length>0?n.why.map(c=>`<li>${i(c)}</li>`).join(""):"<li>No transition explanation available.</li>",f=n.dependencyChain.length>0?n.dependencyChain.map(c=>`<li class="mono">${i(c)}</li>`).join(""):"<li>No dependency chain captured.</li>",v=t.stateDiff&&t.stateDiff.patches.length>0?t.stateDiff.patches.map(c=>`
      <tr>
        <td class="mono">${i(c.path)}</td>
        <td>${i(c.op)}</td>
        <td><pre class="mono compact">${i(JSON.stringify(c.before,null,2)??"null")}</pre></td>
        <td><pre class="mono compact">${i(JSON.stringify(c.after,null,2)??"null")}</pre></td>
      </tr>
    `).join(""):'<tr><td colspan="4" class="muted">No diff patches for current state.</td></tr>',h=t.replayTrace?`
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
        <ul class="list">${d}</ul>
      </article>

      <article class="card">
        <div class="muted">Dependency Chain</div>
        <ul class="list">${f}</ul>
      </article>

      <article class="card full">
        <div class="muted">State Inspector (Exact Replay State)</div>
        <pre class="mono">${i(JSON.stringify({intent:n.intent,ast:n.ast,violations:n.violations,plans:n.plans},null,2))}</pre>
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
          <tbody>${v}</tbody>
        </table>
      </article>

      ${h}
    </section>
  `}function q(){if(!t)return"";const e=t.policyView.map(n=>`
    <tr>
      <td>${A(n.decision)}</td>
      <td>${i(n.rulesMatched.join(", "))||"none"}</td>
      <td>${i(n.source)}</td>
    </tr>
  `).join(""),a=t.pendingApprovals.length>0?t.pendingApprovals.map(n=>`<li><span class="mono">${i(n.id)}</span> ${i(n.command)}</li>`).join(""):"<li>No pending approvals.</li>";return`
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
        <td class="mono">${i(a.timestamp)}</td>
        <td>${i(a.actor.role)}</td>
        <td>${i(a.action)}</td>
        <td>${i(a.result)}</td>
      </tr>
    `).join(""):'<tr><td colspan="4" class="muted">No events for current filters.</td></tr>';return`
    <section class="grid">
      <article class="card full">
        <div style="display:flex;gap:8px;align-items:end;">
          <div>
            <label for="auditRoleFilter">Role Filter</label>
            <input id="auditRoleFilter" type="text" placeholder="architect|analyst|conductor|enforcer" value="${i(m.role??"")}" />
          </div>
          <div>
            <label for="auditEnvFilter">Environment Filter</label>
            <input id="auditEnvFilter" type="text" placeholder="local|ci|staging|production" value="${i(m.environment??"")}" />
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
  `}function J(){if(!t)return"";const e=t.macroUI.libraries.length>0?t.macroUI.libraries.map(d=>`<li>${i(d)}</li>`).join(""):"<li>No libraries installed.</li>",a=t.macroUI.macros.length>0?t.macroUI.macros.map(d=>`<li class="mono">${i(d)}</li>`).join(""):"<li>No macros discovered.</li>",n=t.macroUI.abstractions.length>0?t.macroUI.abstractions.map(d=>`<li class="mono">${i(d)}</li>`).join(""):"<li>No abstractions discovered.</li>";return`
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
        <ul class="list">${n}</ul>
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
        <td>${i(a.action)}</td>
        <td class="mono">${i(a.resultingDSL)}</td>
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
        <pre class="mono">${i(JSON.stringify(t.controlPlane,null,2))}</pre>
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
  `}function K(){const e=document.getElementById("runDefineBtn"),a=document.getElementById("runPlanBtn"),n=document.getElementById("runPreviewBtn"),d=document.getElementById("runApproveBtn"),f=document.getElementById("runExecuteBtn"),v=document.getElementById("runAuditBtn"),h=document.getElementById("applyAuditFilterBtn"),c=document.getElementById("runMacroCommandBtn"),$=document.getElementById("timelinePlayBtn"),T=document.getElementById("timelinePauseBtn"),k=document.getElementById("timelineStepBackBtn"),M=document.getElementById("timelineStepForwardBtn");e instanceof HTMLButtonElement&&e.addEventListener("click",()=>{const r=document.getElementById("intentInput"),l=r instanceof HTMLInputElement?r.value.trim():"";o({type:"run-workflow",role:s(),step:"define-intent",payload:{intent:l}})}),a instanceof HTMLButtonElement&&a.addEventListener("click",()=>{const r=document.getElementById("planGoalInput"),l=r instanceof HTMLInputElement?r.value.trim():"";o({type:"run-workflow",role:s(),step:"plan",payload:l.length>0?{goal:l}:{}})}),n instanceof HTMLButtonElement&&n.addEventListener("click",()=>{const r=document.getElementById("previewPlanInput"),l=r instanceof HTMLInputElement?r.value.trim():"";o({type:"run-workflow",role:s(),step:"preview",payload:l.length>0?{planId:l}:{}})}),d instanceof HTMLButtonElement&&d.addEventListener("click",()=>{const r=document.getElementById("approveInput"),l=r instanceof HTMLInputElement?r.value.trim():"";if(!l){E("Approve requires diff id or plan id.");return}const w=l.startsWith("diff-")?{diffId:l}:{planId:l};o({type:"run-workflow",role:s(),step:"approve",payload:w})}),f instanceof HTMLButtonElement&&f.addEventListener("click",()=>{const r=document.getElementById("executePlanInput"),l=r instanceof HTMLInputElement?r.value.trim():"";o({type:"run-workflow",role:s(),step:"execute",payload:l.length>0?{planId:l}:{}})}),v instanceof HTMLButtonElement&&v.addEventListener("click",()=>{o({type:"run-workflow",role:s(),step:"audit"})}),h instanceof HTMLButtonElement&&h.addEventListener("click",()=>{const r=document.getElementById("auditRoleFilter"),l=document.getElementById("auditEnvFilter");m={...r instanceof HTMLInputElement&&r.value.trim().length>0?{role:r.value.trim()}:{},...l instanceof HTMLInputElement&&l.value.trim().length>0?{environment:l.value.trim()}:{}},o({type:"refresh",role:s(),filters:m})}),c instanceof HTMLButtonElement&&c.addEventListener("click",()=>{const r=document.getElementById("macroCommandInput");if(!(r instanceof HTMLInputElement))return;const l=r.value.trim();l.length!==0&&o({type:"run-dsl",role:s(),dsl:l})}),$ instanceof HTMLButtonElement&&$.addEventListener("click",()=>{o({type:"replay-control",role:s(),control:"play"})}),T instanceof HTMLButtonElement&&T.addEventListener("click",()=>{o({type:"replay-control",role:s(),control:"pause"})}),k instanceof HTMLButtonElement&&k.addEventListener("click",()=>{o({type:"replay-control",role:s(),control:"step-backward"})}),M instanceof HTMLButtonElement&&M.addEventListener("click",()=>{o({type:"replay-control",role:s(),control:"step-forward"})}),document.querySelectorAll(".timeline-node[data-timeline-index]").forEach(r=>{r.addEventListener("click",()=>{const l=r.dataset.timelineIndex;if(!l)return;const w=Number.parseInt(l,10);Number.isFinite(w)&&o({type:"replay-control",role:s(),control:"jump",index:w})})})}function H(){if(!t){p.innerHTML="";return}u==="dashboard"?p.innerHTML=N():u==="workspace"?p.innerHTML=_():u==="plan-view"?p.innerHTML=U():u==="timeline-view"?p.innerHTML=W():u==="policy-view"?p.innerHTML=q():u==="audit-view"?p.innerHTML=G():p.innerHTML=J(),K()}function R(e){t=e,I.value=e.activeRole,V(),H(),F()}function z(e){e.ok?E(e.message):E(e.error?`${e.error.source}: ${e.error.message}`:e.message),R(e.snapshot)}window.addEventListener("message",e=>{const a=e.data;if(a.type==="snapshot"){R(a.payload);return}a.type==="action-result"&&z(a.payload)});P.addEventListener("click",()=>{const e=x.value.trim();e.length!==0&&o({type:"run-dsl",role:s(),dsl:e})});S.addEventListener("click",()=>{o({type:"refresh",role:s(),filters:m})});I.addEventListener("change",()=>{o({type:"refresh",role:s(),filters:m})});setInterval(()=>{o({type:"refresh",role:s(),filters:m})},5e3);L.postMessage({type:"ready"});
