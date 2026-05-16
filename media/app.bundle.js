const C={architect:["define-intent","approve","audit"],analyst:["audit"],conductor:["define-intent","plan","preview","approve","audit"],enforcer:["execute","audit"]},D={dashboard:"Dashboard",workspace:"Workspace","plan-view":"Plan View","timeline-view":"Time Travel","policy-view":"Policy View","audit-view":"Audit View","macro-library":"Macro/Abstraction"},T=window.vscode;if(!T)throw new Error("VSCode API not available in webview context.");const $=document.getElementById("roleSelect"),x=document.getElementById("dslInput"),S=document.getElementById("runDslBtn"),A=document.getElementById("refreshBtn"),g=document.getElementById("surfaceTabs"),f=document.getElementById("surfaceContainer"),B=document.getElementById("consoleOutput");if(!($ instanceof HTMLSelectElement)||!(x instanceof HTMLInputElement)||!(S instanceof HTMLButtonElement)||!(A instanceof HTMLButtonElement)||!(g instanceof HTMLElement)||!(f instanceof HTMLElement)||!(B instanceof HTMLElement))throw new Error("Choir Control Center webview is missing required elements.");let e=null,p="dashboard",y={},h;function o(){const t=$.value;return t==="architect"||t==="analyst"||t==="conductor"||t==="enforcer"?t:"conductor"}function n(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;")}function E(t){const a=new Date().toISOString(),i=B.textContent??"";B.textContent=`[${a}] ${t}
${i}`}function V(){typeof h<"u"&&(window.clearInterval(h),h=void 0)}function F(){if(!e?.timeline.playing){V();return}typeof h<"u"||(h=window.setInterval(()=>{if(!e?.timeline.playing||!e.timeline.canStepForward){c({type:"replay-control",role:o(),control:"pause"});return}c({type:"replay-control",role:o(),control:"step-forward"})},900))}function c(t){T.postMessage({type:"action",payload:t})}function v(t,a){return C[t].includes(a)}function L(t){return t==="stable"||t==="allow"?`<span class="chip success">${n(t)}</span>`:t==="needs-attention"||t==="deny"?`<span class="chip danger">${n(t)}</span>`:`<span class="chip warn">${n(t)}</span>`}function H(){if(!e){g.innerHTML="";return}const t=e.availableSurfaces;t.includes(p)||(p=t[0]??"dashboard"),g.innerHTML=t.map(a=>`<button type="button" class="surface-tab ${a===p?"active":""}" data-surface="${a}">${D[a]}</button>`).join(""),g.querySelectorAll(".surface-tab").forEach(a=>{a.addEventListener("click",()=>{const i=a.dataset.surface;i&&i!==p&&(p=i,H(),R())})})}function N(){if(!e)return"";const t=e.dashboard.recommendations.length>0?e.dashboard.recommendations.map(l=>`<li>${n(l)}</li>`).join(""):"<li>No recommendations. System is aligned.</li>",a=e.dashboard.recentActions.length>0?e.dashboard.recentActions.map(l=>`<li><span class="mono">${n(l.timestamp)}</span> ${n(l.action)} (${n(l.result)})</li>`).join(""):"<li>No audit events yet.</li>",i=e.production?L(e.production.health.healthy?"stable":"needs-attention"):'<span class="chip warn">unavailable</span>',u=e.production&&e.production.alerts.length>0?e.production.alerts.map(l=>`<li><span class="mono">${n(l.severity)}</span> ${n(l.condition)}</li>`).join(""):"<li>No active production alerts.</li>",m=e.production&&e.production.slos.length>0?e.production.slos.map(l=>`<li>${n(l.name)}: ${l.actual.toFixed(2)} / ${l.target.toFixed(2)} (${l.met?"met":"miss"})</li>`).join(""):"<li>No SLO evaluation available.</li>";return`
    <section class="grid">
      <article class="card">
        <div class="muted">System Health</div>
        <div class="kpi">${L(e.dashboard.systemHealth)}</div>
      </article>
      <article class="card">
        <div class="muted">Production Health</div>
        <div class="kpi">${i}</div>
      </article>
      <article class="card">
        <div class="muted">Active Plans</div>
        <div class="kpi">${e.dashboard.activePlans}</div>
      </article>
      <article class="card">
        <div class="muted">Policy Violations</div>
        <div class="kpi">${e.dashboard.policyViolations}</div>
      </article>
      <article class="card wide">
        <div class="muted">Recommended Next Actions</div>
        <ul class="list">${t}</ul>
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
        <ul class="list">${m}</ul>
      </article>
    </section>
  `}function U(){if(!e)return"";const t=o();return`
    <article class="card full">
      <div class="muted">Guided Workflow</div>
      <div class="workflow">${["define-intent","plan","preview","approve","execute","audit"].map(i=>{const u=i,m=e?.workflow.current===u,l=e?.workflow.completed.includes(u);return`<span class="step ${m?"current":""} ${l?"done":""}">${n(i)}</span>`}).join("")}</div>
      <p class="muted">Current step: ${n(e.workflow.current)}</p>
      <div class="grid">
        <div class="card">
          <label for="intentInput">Define Intent</label>
          <input id="intentInput" type="text" placeholder="create safer service boundaries" />
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button id="runDefineBtn" ${v(t,"define-intent")?"":"disabled"}>Run</button>
          </div>
        </div>
        <div class="card">
          <label for="planGoalInput">Generate Plan</label>
          <input id="planGoalInput" type="text" placeholder="optional goal override" />
          <button id="runPlanBtn" style="margin-top:8px;" ${v(t,"plan")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="previewPlanInput">Preview Plan ID (optional)</label>
          <input id="previewPlanInput" type="text" placeholder="plan-abc123" />
          <button id="runPreviewBtn" style="margin-top:8px;" ${v(t,"preview")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="approveInput">Approve Diff ID or Plan ID</label>
          <input id="approveInput" type="text" placeholder="diff-... or plan-..." />
          <button id="runApproveBtn" style="margin-top:8px;" ${v(t,"approve")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="executePlanInput">Execute Plan ID (optional)</label>
          <input id="executePlanInput" type="text" placeholder="plan-abc123" />
          <button id="runExecuteBtn" style="margin-top:8px;" ${v(t,"execute")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label>Audit</label>
          <p class="muted">Fetch current immutable audit timeline.</p>
          <button id="runAuditBtn" ${v(t,"audit")?"":"disabled"}>Run</button>
        </div>
      </div>
    </article>
  `}function O(){if(!e)return"";const t=e.planView.length>0?e.planView.map(i=>`
      <tr>
        <td class="mono">${n(i.planId)}</td>
        <td>${n(i.tasks.join(", "))}</td>
        <td class="mono">${n(i.affectedFiles.join(", "))}</td>
        <td>${i.estimatedImpact}</td>
      </tr>
    `).join(""):'<tr><td colspan="4" class="muted">No plans yet.</td></tr>',a=e.diffView.length>0?e.diffView.map(i=>`
        <article class="card full">
          <div class="mono">${n(i.file)}</div>
          <div class="diff">
            <pre>${n(i.before)}</pre>
            <pre>${n(i.after)}</pre>
          </div>
        </article>
      `).join(""):'<article class="card full"><div class="muted">No preview diff loaded yet. Run Preview.</div></article>';return`
    <section class="grid">
      ${U()}
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
          <tbody>${t}</tbody>
        </table>
      </article>
      ${a}
    </section>
  `}function W(){if(!e)return"";const t=e.timeline.states,a=t.length>0?t.map(d=>`
        <button
          type="button"
          class="timeline-node ${d.index===e?.timeline.currentIndex?"current":""}"
          data-timeline-index="${d.index}"
          title="${n(d.action)}">
          <span class="timeline-label">${n(d.label)}</span>
          <span class="timeline-action">${n(d.action)}</span>
        </button>
      `).join(""):'<div class="muted">No transitions recorded yet.</div>',i=e.stateInspector,u=i.why.length>0?i.why.map(d=>`<li>${n(d)}</li>`).join(""):"<li>No transition explanation available.</li>",m=i.dependencyChain.length>0?i.dependencyChain.map(d=>`<li class="mono">${n(d)}</li>`).join(""):"<li>No dependency chain captured.</li>",l=e.stateDiff&&e.stateDiff.patches.length>0?e.stateDiff.patches.map(d=>`
      <tr>
        <td class="mono">${n(d.path)}</td>
        <td>${n(d.op)}</td>
        <td><pre class="mono compact">${n(JSON.stringify(d.before,null,2)??"null")}</pre></td>
        <td><pre class="mono compact">${n(JSON.stringify(d.after,null,2)??"null")}</pre></td>
      </tr>
    `).join(""):'<tr><td colspan="4" class="muted">No diff patches for current state.</td></tr>',b=e.replayTrace?`
      <article class="card full">
        <div class="muted">Replay Trace</div>
        <p class="mono">visited=${e.replayTrace.visitedStates.length} · replayTime=${e.replayTrace.replayTime}ms · consistency=${e.replayTrace.consistencyCheck} · fallback=${e.replayTrace.fallbackUsed}</p>
      </article>
    `:"";return`
    <section class="grid">
      <article class="card full">
        <div class="muted">Time Navigation</div>
        <div class="timeline-controls">
          <button id="timelinePlayBtn" ${e.timeline.playing?"disabled":""}>Play</button>
          <button id="timelinePauseBtn" class="ghost" ${e.timeline.playing?"":"disabled"}>Pause</button>
          <button id="timelineStepBackBtn" class="secondary" ${e.timeline.canStepBackward?"":"disabled"}>Step Back</button>
          <button id="timelineStepForwardBtn" class="secondary" ${e.timeline.canStepForward?"":"disabled"}>Step Forward</button>
          <span class="mono">Current Index: ${e.timeline.currentIndex}</span>
        </div>
        <div class="timeline-track">${a}</div>
      </article>

      <article class="card wide">
        <div class="muted">Why Did This Happen?</div>
        <ul class="list">${u}</ul>
      </article>

      <article class="card">
        <div class="muted">Dependency Chain</div>
        <ul class="list">${m}</ul>
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
          <tbody>${l}</tbody>
        </table>
      </article>

      ${b}
    </section>
  `}function q(){if(!e)return"";const t=e.policyView.map(i=>`
    <tr>
      <td>${L(i.decision)}</td>
      <td>${n(i.rulesMatched.join(", "))||"none"}</td>
      <td>${n(i.source)}</td>
    </tr>
  `).join(""),a=e.pendingApprovals.length>0?e.pendingApprovals.map(i=>`<li><span class="mono">${n(i.id)}</span> ${n(i.command)}</li>`).join(""):"<li>No pending approvals.</li>";return`
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
          <tbody>${t}</tbody>
        </table>
      </article>
      <article class="card full">
        <div class="muted">Pending Approvals</div>
        <ul class="list">${a}</ul>
      </article>
    </section>
  `}function G(){if(!e)return"";const t=e.auditView.events.length>0?e.auditView.events.map(a=>`
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
          <tbody>${t}</tbody>
        </table>
      </article>
    </section>
  `}function J(){if(!e)return"";const t=e.macroUI.libraries.length>0?e.macroUI.libraries.map(l=>`<li>${n(l)}</li>`).join(""):"<li>No libraries installed.</li>",a=e.macroUI.macros.length>0?e.macroUI.macros.map(l=>`<li class="mono">${n(l)}</li>`).join(""):"<li>No macros discovered.</li>",i=(e.macroUI.lockedVersions??[]).length>0?(e.macroUI.lockedVersions??[]).map(l=>`<li class="mono">${n(l)}</li>`).join(""):"<li>No lock entries.</li>",u=(e.macroUI.transitiveDependencies??[]).length>0?(e.macroUI.transitiveDependencies??[]).map(l=>`<li class="mono">${n(l)}</li>`).join(""):"<li>No dependency edges recorded.</li>",m=e.macroUI.abstractions.length>0?e.macroUI.abstractions.map(l=>`<li class="mono">${n(l)}</li>`).join(""):"<li>No abstractions discovered.</li>";return`
    <section class="grid">
      <article class="card">
        <div class="muted">Libraries</div>
        <ul class="list">${t}</ul>
      </article>
      <article class="card">
        <div class="muted">Macros</div>
        <ul class="list">${a}</ul>
      </article>
      <article class="card">
        <div class="muted">Locked Versions</div>
        <ul class="list">${i}</ul>
      </article>
      <article class="card">
        <div class="muted">Abstractions</div>
        <ul class="list">${m}</ul>
      </article>
      <article class="card full">
        <div class="muted">Transitive Dependencies</div>
        <ul class="list">${u}</ul>
      </article>
      <article class="card full">
        <label for="macroCommandInput">Macro/Abstraction Command</label>
        <div class="dsl-row">
          <input id="macroCommandInput" type="text" placeholder="choir macro local.id key='value'" />
          <button id="runMacroCommandBtn" class="secondary">Run</button>
        </div>
      </article>
    </section>
  `}function _(){if(!e)return"";const t=e.traces.slice(0,8).map(a=>`
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
            <tr><td>architect</td><td>${e.roleView.architect.join(", ")}</td></tr>
            <tr><td>analyst</td><td>${e.roleView.analyst.join(", ")}</td></tr>
            <tr><td>conductor</td><td>${e.roleView.conductor.join(", ")}</td></tr>
            <tr><td>enforcer</td><td>${e.roleView.enforcer.join(", ")}</td></tr>
          </tbody>
        </table>
      </article>
      <article class="card full">
        <div class="muted">Current Control Plane (Canonical Projection)</div>
        <pre class="mono">${n(JSON.stringify(e.controlPlane,null,2))}</pre>
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
            ${t||'<tr><td colspan="2" class="muted">No UI traces yet.</td></tr>'}
          </tbody>
        </table>
      </article>
    </section>
  `}function K(){const t=document.getElementById("runDefineBtn"),a=document.getElementById("runPlanBtn"),i=document.getElementById("runPreviewBtn"),u=document.getElementById("runApproveBtn"),m=document.getElementById("runExecuteBtn"),l=document.getElementById("runAuditBtn"),b=document.getElementById("applyAuditFilterBtn"),d=document.getElementById("runMacroCommandBtn"),I=document.getElementById("timelinePlayBtn"),k=document.getElementById("timelinePauseBtn"),M=document.getElementById("timelineStepBackBtn"),P=document.getElementById("timelineStepForwardBtn");t instanceof HTMLButtonElement&&t.addEventListener("click",()=>{const s=document.getElementById("intentInput"),r=s instanceof HTMLInputElement?s.value.trim():"";c({type:"run-workflow",role:o(),step:"define-intent",payload:{intent:r}})}),a instanceof HTMLButtonElement&&a.addEventListener("click",()=>{const s=document.getElementById("planGoalInput"),r=s instanceof HTMLInputElement?s.value.trim():"";c({type:"run-workflow",role:o(),step:"plan",payload:r.length>0?{goal:r}:{}})}),i instanceof HTMLButtonElement&&i.addEventListener("click",()=>{const s=document.getElementById("previewPlanInput"),r=s instanceof HTMLInputElement?s.value.trim():"";c({type:"run-workflow",role:o(),step:"preview",payload:r.length>0?{planId:r}:{}})}),u instanceof HTMLButtonElement&&u.addEventListener("click",()=>{const s=document.getElementById("approveInput"),r=s instanceof HTMLInputElement?s.value.trim():"";if(!r){E("Approve requires diff id or plan id.");return}const w=r.startsWith("diff-")?{diffId:r}:{planId:r};c({type:"run-workflow",role:o(),step:"approve",payload:w})}),m instanceof HTMLButtonElement&&m.addEventListener("click",()=>{const s=document.getElementById("executePlanInput"),r=s instanceof HTMLInputElement?s.value.trim():"";c({type:"run-workflow",role:o(),step:"execute",payload:r.length>0?{planId:r}:{}})}),l instanceof HTMLButtonElement&&l.addEventListener("click",()=>{c({type:"run-workflow",role:o(),step:"audit"})}),b instanceof HTMLButtonElement&&b.addEventListener("click",()=>{const s=document.getElementById("auditRoleFilter"),r=document.getElementById("auditEnvFilter");y={...s instanceof HTMLInputElement&&s.value.trim().length>0?{role:s.value.trim()}:{},...r instanceof HTMLInputElement&&r.value.trim().length>0?{environment:r.value.trim()}:{}},c({type:"refresh",role:o(),filters:y})}),d instanceof HTMLButtonElement&&d.addEventListener("click",()=>{const s=document.getElementById("macroCommandInput");if(!(s instanceof HTMLInputElement))return;const r=s.value.trim();r.length!==0&&c({type:"run-dsl",role:o(),dsl:r})}),I instanceof HTMLButtonElement&&I.addEventListener("click",()=>{c({type:"replay-control",role:o(),control:"play"})}),k instanceof HTMLButtonElement&&k.addEventListener("click",()=>{c({type:"replay-control",role:o(),control:"pause"})}),M instanceof HTMLButtonElement&&M.addEventListener("click",()=>{c({type:"replay-control",role:o(),control:"step-backward"})}),P instanceof HTMLButtonElement&&P.addEventListener("click",()=>{c({type:"replay-control",role:o(),control:"step-forward"})}),document.querySelectorAll(".timeline-node[data-timeline-index]").forEach(s=>{s.addEventListener("click",()=>{const r=s.dataset.timelineIndex;if(!r)return;const w=Number.parseInt(r,10);Number.isFinite(w)&&c({type:"replay-control",role:o(),control:"jump",index:w})})})}function R(){if(!e){f.innerHTML="";return}p==="dashboard"?f.innerHTML=N():p==="workspace"?f.innerHTML=_():p==="plan-view"?f.innerHTML=O():p==="timeline-view"?f.innerHTML=W():p==="policy-view"?f.innerHTML=q():p==="audit-view"?f.innerHTML=G():f.innerHTML=J(),K()}function j(t){e=t,$.value=t.activeRole,H(),R(),F()}function z(t){t.ok?E(t.message):E(t.error?`${t.error.source}: ${t.error.message}`:t.message),j(t.snapshot)}window.addEventListener("message",t=>{const a=t.data;if(a.type==="snapshot"){j(a.payload);return}a.type==="action-result"&&z(a.payload)});S.addEventListener("click",()=>{const t=x.value.trim();t.length!==0&&c({type:"run-dsl",role:o(),dsl:t})});A.addEventListener("click",()=>{c({type:"refresh",role:o(),filters:y})});$.addEventListener("change",()=>{c({type:"refresh",role:o(),filters:y})});T.postMessage({type:"ready"});
