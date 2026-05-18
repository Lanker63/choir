const C={architect:["define-intent","approve","audit"],analyst:["audit"],conductor:["define-intent","plan","preview","approve","audit"],enforcer:["execute","audit"]},D={dashboard:"Dashboard",workspace:"Workspace","plan-view":"Plan View","timeline-view":"Time Travel","policy-view":"Policy View","audit-view":"Audit View","macro-library":"Macro/Abstraction"},M=window.vscode;if(!M)throw new Error("VSCode API not available in webview context.");const B=document.getElementById("roleSelect"),x=document.getElementById("dslInput"),S=document.getElementById("runDslBtn"),H=document.getElementById("refreshBtn"),I=document.getElementById("surfaceTabs"),y=document.getElementById("surfaceContainer"),k=document.getElementById("consoleOutput");if(!(B instanceof HTMLSelectElement)||!(x instanceof HTMLInputElement)||!(S instanceof HTMLButtonElement)||!(H instanceof HTMLButtonElement)||!(I instanceof HTMLElement)||!(y instanceof HTMLElement)||!(k instanceof HTMLElement))throw new Error("Choir Control Center webview is missing required elements.");let e=null,v="dashboard",g={},$;function d(){const t=B.value;return t==="architect"||t==="analyst"||t==="conductor"||t==="enforcer"?t:"conductor"}function n(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;")}function L(t){const a=new Date().toISOString(),i=k.textContent??"";k.textContent=`[${a}] ${t}
${i}`}function N(){typeof $<"u"&&(window.clearInterval($),$=void 0)}function V(){if(!e?.timeline.playing){N();return}typeof $<"u"||($=window.setInterval(()=>{if(!e?.timeline.playing||!e.timeline.canStepForward){u({type:"replay-control",role:d(),control:"pause"});return}u({type:"replay-control",role:d(),control:"step-forward"})},900))}function u(t){M.postMessage({type:"action",payload:t})}function h(t,a){return C[t].includes(a)}function T(t){return t==="stable"||t==="allow"?`<span class="chip success">${n(t)}</span>`:t==="needs-attention"||t==="deny"?`<span class="chip danger">${n(t)}</span>`:`<span class="chip warn">${n(t)}</span>`}function A(){if(!e){I.innerHTML="";return}const t=e.availableSurfaces;t.includes(v)||(v=t[0]??"dashboard"),I.innerHTML=t.map(a=>`<button type="button" class="surface-tab ${a===v?"active":""}" data-surface="${a}">${D[a]}</button>`).join(""),I.querySelectorAll(".surface-tab").forEach(a=>{a.addEventListener("click",()=>{const i=a.dataset.surface;i&&i!==v&&(v=i,A(),R())})})}function F(){if(!e)return"";const t=e.dashboard.recommendations.length>0?e.dashboard.recommendations.map(s=>`<li>${n(s)}</li>`).join(""):"<li>No recommendations. System is aligned.</li>",a=e.dashboard.recentActions.length>0?e.dashboard.recentActions.map(s=>`<li><span class="mono">${n(s.timestamp)}</span> ${n(s.action)} (${n(s.result)})</li>`).join(""):"<li>No audit events yet.</li>",i=e.production?T(e.production.health.healthy?"stable":"needs-attention"):'<span class="chip warn">unavailable</span>',p=e.production&&e.production.alerts.length>0?e.production.alerts.map(s=>`<li><span class="mono">${n(s.severity)}</span> ${n(s.condition)}</li>`).join(""):"<li>No active production alerts.</li>",f=e.production&&e.production.slos.length>0?e.production.slos.map(s=>`<li>${n(s.name)}: ${s.actual.toFixed(2)} / ${s.target.toFixed(2)} (${s.met?"met":"miss"})</li>`).join(""):"<li>No SLO evaluation available.</li>",l=e.runtimeGovernance,b=l?Object.entries(l.effectiveCapabilities).sort(([s],[o])=>s.localeCompare(o)).map(([s,o])=>`<li>${n(s)}: ${o?"enabled":"disabled"}</li>`).join(""):"<li>No runtime governance trace available yet.</li>",m=l&&l.packageDecisions.length>0?l.packageDecisions.map(s=>`<li>${n(s.packageName)}: mode=${n(s.mode)} decision=${n(s.decision)}</li>`).join(""):"<li>No package-level governance decisions recorded.</li>";return`
    <section class="grid">
      <article class="card">
        <div class="muted">System Health</div>
        <div class="kpi">${T(e.dashboard.systemHealth)}</div>
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
        <ul class="list">${p}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Production SLOs</div>
        <ul class="list">${f}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Runtime Governance</div>
        ${l?`<p>mode=${n(l.mode)} | capability=${n(l.capability)} | decision=${n(l.decision)} | reason=${n(l.reason)}</p>`:"<p>No runtime governance record yet.</p>"}
        <ul class="list">${b}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Package Governance Decisions</div>
        <ul class="list">${m}</ul>
      </article>
    </section>
  `}function O(){if(!e)return"";const t=d();return`
    <article class="card full">
      <div class="muted">Guided Workflow</div>
      <div class="workflow">${["define-intent","plan","preview","approve","execute","audit"].map(i=>{const p=i,f=e?.workflow.current===p,l=e?.workflow.completed.includes(p);return`<span class="step ${f?"current":""} ${l?"done":""}">${n(i)}</span>`}).join("")}</div>
      <p class="muted">Current step: ${n(e.workflow.current)}</p>
      <div class="grid">
        <div class="card">
          <label for="intentInput">Define Intent</label>
          <input id="intentInput" type="text" placeholder="create safer service boundaries" />
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button id="runDefineBtn" ${h(t,"define-intent")?"":"disabled"}>Run</button>
          </div>
        </div>
        <div class="card">
          <label for="planGoalInput">Generate Plan</label>
          <input id="planGoalInput" type="text" placeholder="optional goal override" />
          <button id="runPlanBtn" style="margin-top:8px;" ${h(t,"plan")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="previewPlanInput">Preview Plan ID (optional)</label>
          <input id="previewPlanInput" type="text" placeholder="plan-abc123" />
          <button id="runPreviewBtn" style="margin-top:8px;" ${h(t,"preview")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="approveInput">Approve Diff ID or Plan ID</label>
          <input id="approveInput" type="text" placeholder="diff-... or plan-..." />
          <button id="runApproveBtn" style="margin-top:8px;" ${h(t,"approve")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="executePlanInput">Execute Plan ID (optional)</label>
          <input id="executePlanInput" type="text" placeholder="plan-abc123" />
          <button id="runExecuteBtn" style="margin-top:8px;" ${h(t,"execute")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label>Audit</label>
          <p class="muted">Fetch current immutable audit timeline.</p>
          <button id="runAuditBtn" ${h(t,"audit")?"":"disabled"}>Run</button>
        </div>
      </div>
    </article>
  `}function U(){if(!e)return"";const t=e.planView.length>0?e.planView.map(i=>`
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
          <tbody>${t}</tbody>
        </table>
      </article>
      ${a}
    </section>
  `}function G(){if(!e)return"";const t=e.timeline.states,a=t.length>0?t.map(o=>`
        <button
          type="button"
          class="timeline-node ${o.index===e?.timeline.currentIndex?"current":""}"
          data-timeline-index="${o.index}"
          title="${n(o.action)}">
          <span class="timeline-label">${n(o.label)}</span>
          <span class="timeline-action">${n(o.action)}</span>
        </button>
      `).join(""):'<div class="muted">No transitions recorded yet.</div>',i=e.stateInspector,p=i.why.length>0?i.why.map(o=>`<li>${n(o)}</li>`).join(""):"<li>No transition explanation available.</li>",f=i.dependencyChain.length>0?i.dependencyChain.map(o=>`<li class="mono">${n(o)}</li>`).join(""):"<li>No dependency chain captured.</li>",l=e.stateDiff&&e.stateDiff.patches.length>0?e.stateDiff.patches.map(o=>`
      <tr>
        <td class="mono">${n(o.path)}</td>
        <td>${n(o.op)}</td>
        <td><pre class="mono compact">${n(JSON.stringify(o.before,null,2)??"null")}</pre></td>
        <td><pre class="mono compact">${n(JSON.stringify(o.after,null,2)??"null")}</pre></td>
      </tr>
    `).join(""):'<tr><td colspan="4" class="muted">No diff patches for current state.</td></tr>',b=e.replayTrace?`
      <article class="card full">
        <div class="muted">Replay Trace</div>
        <p class="mono">visited=${e.replayTrace.visitedStates.length} · replayTime=${e.replayTrace.replayTime}ms · consistency=${e.replayTrace.consistencyCheck} · fallback=${e.replayTrace.fallbackUsed}</p>
      </article>
    `:"",m=e.runtimeGovernance,s=m?`
      <article class="card full">
        <div class="muted">Runtime Governance Trace</div>
        <p>mode=${n(m.mode)} | capability=${n(m.capability)} | decision=${n(m.decision)} | reason=${n(m.reason)}</p>
        <p class="mono">governanceHash=${n(m.governanceHash)}</p>
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
        <ul class="list">${p}</ul>
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
          <tbody>${l}</tbody>
        </table>
      </article>

      ${b}
      ${s}
    </section>
  `}function W(){if(!e)return"";const t=e.policyView.map(i=>`
    <tr>
      <td>${T(i.decision)}</td>
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
  `}function q(){if(!e)return"";const t=e.auditView.events.length>0?e.auditView.events.map(a=>`
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
            <input id="auditRoleFilter" type="text" placeholder="architect|analyst|conductor|enforcer" value="${n(g.role??"")}" />
          </div>
          <div>
            <label for="auditEnvFilter">Environment Filter</label>
            <input id="auditEnvFilter" type="text" placeholder="local|ci|staging|production" value="${n(g.environment??"")}" />
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
  `}function J(){if(!e)return"";const t=e.macroUI.libraries.length>0?e.macroUI.libraries.map(l=>`<li>${n(l)}</li>`).join(""):"<li>No libraries installed.</li>",a=e.macroUI.macros.length>0?e.macroUI.macros.map(l=>`<li class="mono">${n(l)}</li>`).join(""):"<li>No macros discovered.</li>",i=(e.macroUI.lockedVersions??[]).length>0?(e.macroUI.lockedVersions??[]).map(l=>`<li class="mono">${n(l)}</li>`).join(""):"<li>No lock entries.</li>",p=(e.macroUI.transitiveDependencies??[]).length>0?(e.macroUI.transitiveDependencies??[]).map(l=>`<li class="mono">${n(l)}</li>`).join(""):"<li>No dependency edges recorded.</li>",f=e.macroUI.abstractions.length>0?e.macroUI.abstractions.map(l=>`<li class="mono">${n(l)}</li>`).join(""):"<li>No abstractions discovered.</li>";return`
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
        <ul class="list">${f}</ul>
      </article>
      <article class="card full">
        <div class="muted">Transitive Dependencies</div>
        <ul class="list">${p}</ul>
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
  `}function K(){const t=document.getElementById("runDefineBtn"),a=document.getElementById("runPlanBtn"),i=document.getElementById("runPreviewBtn"),p=document.getElementById("runApproveBtn"),f=document.getElementById("runExecuteBtn"),l=document.getElementById("runAuditBtn"),b=document.getElementById("applyAuditFilterBtn"),m=document.getElementById("runMacroCommandBtn"),s=document.getElementById("timelinePlayBtn"),o=document.getElementById("timelinePauseBtn"),E=document.getElementById("timelineStepBackBtn"),P=document.getElementById("timelineStepForwardBtn");t instanceof HTMLButtonElement&&t.addEventListener("click",()=>{const c=document.getElementById("intentInput"),r=c instanceof HTMLInputElement?c.value.trim():"";u({type:"run-workflow",role:d(),step:"define-intent",payload:{intent:r}})}),a instanceof HTMLButtonElement&&a.addEventListener("click",()=>{const c=document.getElementById("planGoalInput"),r=c instanceof HTMLInputElement?c.value.trim():"";u({type:"run-workflow",role:d(),step:"plan",payload:r.length>0?{goal:r}:{}})}),i instanceof HTMLButtonElement&&i.addEventListener("click",()=>{const c=document.getElementById("previewPlanInput"),r=c instanceof HTMLInputElement?c.value.trim():"";u({type:"run-workflow",role:d(),step:"preview",payload:r.length>0?{planId:r}:{}})}),p instanceof HTMLButtonElement&&p.addEventListener("click",()=>{const c=document.getElementById("approveInput"),r=c instanceof HTMLInputElement?c.value.trim():"";if(!r){L("Approve requires diff id or plan id.");return}const w=r.startsWith("diff-")?{diffId:r}:{planId:r};u({type:"run-workflow",role:d(),step:"approve",payload:w})}),f instanceof HTMLButtonElement&&f.addEventListener("click",()=>{const c=document.getElementById("executePlanInput"),r=c instanceof HTMLInputElement?c.value.trim():"";u({type:"run-workflow",role:d(),step:"execute",payload:r.length>0?{planId:r}:{}})}),l instanceof HTMLButtonElement&&l.addEventListener("click",()=>{u({type:"run-workflow",role:d(),step:"audit"})}),b instanceof HTMLButtonElement&&b.addEventListener("click",()=>{const c=document.getElementById("auditRoleFilter"),r=document.getElementById("auditEnvFilter");g={...c instanceof HTMLInputElement&&c.value.trim().length>0?{role:c.value.trim()}:{},...r instanceof HTMLInputElement&&r.value.trim().length>0?{environment:r.value.trim()}:{}},u({type:"refresh",role:d(),filters:g})}),m instanceof HTMLButtonElement&&m.addEventListener("click",()=>{const c=document.getElementById("macroCommandInput");if(!(c instanceof HTMLInputElement))return;const r=c.value.trim();r.length!==0&&u({type:"run-dsl",role:d(),dsl:r})}),s instanceof HTMLButtonElement&&s.addEventListener("click",()=>{u({type:"replay-control",role:d(),control:"play"})}),o instanceof HTMLButtonElement&&o.addEventListener("click",()=>{u({type:"replay-control",role:d(),control:"pause"})}),E instanceof HTMLButtonElement&&E.addEventListener("click",()=>{u({type:"replay-control",role:d(),control:"step-backward"})}),P instanceof HTMLButtonElement&&P.addEventListener("click",()=>{u({type:"replay-control",role:d(),control:"step-forward"})}),document.querySelectorAll(".timeline-node[data-timeline-index]").forEach(c=>{c.addEventListener("click",()=>{const r=c.dataset.timelineIndex;if(!r)return;const w=Number.parseInt(r,10);Number.isFinite(w)&&u({type:"replay-control",role:d(),control:"jump",index:w})})})}function R(){if(!e){y.innerHTML="";return}v==="dashboard"?y.innerHTML=F():v==="workspace"?y.innerHTML=_():v==="plan-view"?y.innerHTML=U():v==="timeline-view"?y.innerHTML=G():v==="policy-view"?y.innerHTML=W():v==="audit-view"?y.innerHTML=q():y.innerHTML=J(),K()}function j(t){e=t,B.value=t.activeRole,A(),R(),V()}function z(t){t.ok?L(t.message):L(t.error?`${t.error.source}: ${t.error.message}`:t.message),j(t.snapshot)}window.addEventListener("message",t=>{const a=t.data;if(a.type==="snapshot"){j(a.payload);return}a.type==="action-result"&&z(a.payload)});S.addEventListener("click",()=>{const t=x.value.trim();t.length!==0&&u({type:"run-dsl",role:d(),dsl:t})});H.addEventListener("click",()=>{u({type:"refresh",role:d(),filters:g})});B.addEventListener("change",()=>{u({type:"refresh",role:d(),filters:g})});M.postMessage({type:"ready"});
