const R={architect:["define-intent","approve","audit"],analyst:["audit"],conductor:["define-intent","plan","preview","approve","audit"],enforcer:["execute","audit"]},D={dashboard:"Dashboard",workspace:"Workspace","plan-view":"Plan View","timeline-view":"Time Travel","policy-view":"Policy View","audit-view":"Audit View","macro-library":"Macro/Abstraction"},P=window.vscode;if(!P)throw new Error("VSCode API not available in webview context.");const k=document.getElementById("roleSelect"),x=document.getElementById("dslInput"),M=document.getElementById("runDslBtn"),A=document.getElementById("refreshBtn"),E=document.getElementById("surfaceTabs"),y=document.getElementById("surfaceContainer"),T=document.getElementById("consoleOutput");if(!(k instanceof HTMLSelectElement)||!(x instanceof HTMLInputElement)||!(M instanceof HTMLButtonElement)||!(A instanceof HTMLButtonElement)||!(E instanceof HTMLElement)||!(y instanceof HTMLElement)||!(T instanceof HTMLElement))throw new Error("Choir Control Center webview is missing required elements.");let t=null,f="dashboard",I={},B;function d(){const n=k.value;return n==="architect"||n==="analyst"||n==="conductor"||n==="enforcer"?n:"conductor"}function e(n){return n.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;")}function L(n){const l=new Date().toISOString(),a=T.textContent??"";T.textContent=`[${l}] ${n}
${a}`}function N(){typeof B<"u"&&(window.clearInterval(B),B=void 0)}function F(){if(!t?.timeline.playing){N();return}typeof B<"u"||(B=window.setInterval(()=>{if(!t?.timeline.playing||!t.timeline.canStepForward){p({type:"replay-control",role:d(),control:"pause"});return}p({type:"replay-control",role:d(),control:"step-forward"})},900))}function p(n){P.postMessage({type:"action",payload:n})}function w(n,l){return R[n].includes(l)}function S(n){return n==="stable"||n==="allow"?`<span class="chip success">${e(n)}</span>`:n==="needs-attention"||n==="deny"?`<span class="chip danger">${e(n)}</span>`:`<span class="chip warn">${e(n)}</span>`}function C(){if(!t){E.innerHTML="";return}const n=t.availableSurfaces;n.includes(f)||(f=n[0]??"dashboard"),E.innerHTML=n.map(l=>`<button type="button" class="surface-tab ${l===f?"active":""}" data-surface="${l}">${D[l]}</button>`).join(""),E.querySelectorAll(".surface-tab").forEach(l=>{l.addEventListener("click",()=>{const a=l.dataset.surface;a&&a!==f&&(f=a,C(),j())})})}function V(){if(!t)return"";const n=t.dashboard.recommendations.length>0?t.dashboard.recommendations.map(i=>`<li>${e(i)}</li>`).join(""):"<li>No recommendations. System is aligned.</li>",l=t.dashboard.recentActions.length>0?t.dashboard.recentActions.map(i=>`<li><span class="mono">${e(i.timestamp)}</span> ${e(i.action)} (${e(i.result)})</li>`).join(""):"<li>No audit events yet.</li>",a=t.production?S(t.production.health.healthy?"stable":"needs-attention"):'<span class="chip warn">unavailable</span>',v=t.production&&t.production.alerts.length>0?t.production.alerts.map(i=>`<li><span class="mono">${e(i.severity)}</span> ${e(i.condition)}</li>`).join(""):"<li>No active production alerts.</li>",g=t.production&&t.production.slos.length>0?t.production.slos.map(i=>`<li>${e(i.name)}: ${i.actual.toFixed(2)} / ${i.target.toFixed(2)} (${i.met?"met":"miss"})</li>`).join(""):"<li>No SLO evaluation available.</li>",o=t.runtimeGovernance,$=o?Object.entries(o.effectiveCapabilities).sort(([i],[b])=>i.localeCompare(b)).map(([i,b])=>`<li>${e(i)}: ${b?"enabled":"disabled"}</li>`).join(""):"<li>No runtime governance trace available yet.</li>",u=o&&o.packageDecisions.length>0?o.packageDecisions.map(i=>`<li>${e(i.packageName)}: mode=${e(i.mode)} decision=${e(i.decision)}</li>`).join(""):"<li>No package-level governance decisions recorded.</li>",s=t.strategicSummary,m=s?.global?`
      <p>governanceIntensity=${e(s.global.governanceIntensity)} | riskTolerance=${e(s.global.riskTolerance)}${s.global.mission?` | mission=${e(s.global.mission)}`:""}</p>
      <p>priorities=${e(s.global.priorities.join(", ")||"none")} | optimizationGoals=${e(s.global.optimizationGoals.join(", ")||"none")}</p>
      <p>rolloutPreferences=${e(s.global.rolloutPreferences.join(", ")||"none")}</p>
    `:"<p>No global strategic intent configured.</p>",h=s&&s.domains.length>0?s.domains.map(i=>`<li>${e(i.id)}: governance=${e(i.governanceIntensity??"inherited")} priorities=${e(i.priorities.join(", ")||"none")} rollout=${e(i.rolloutPreferences.join(", ")||"none")}</li>`).join(""):"<li>No domain strategic contexts configured.</li>",c=s&&s.packages.length>0?s.packages.map(i=>`<li>${e(i.id)}: domain=${e(i.domain)} governance=${e(i.governanceIntensity??"inherited")} rollout=${e(i.rolloutPreferences.join(", ")||"none")}</li>`).join(""):"<li>No package strategic posture mappings configured.</li>",r=s?.selectedCandidate?`
      <p>id=${e(s.selectedCandidate.id)} | strategy=${e(s.selectedCandidate.strategyType)} | alignment=${typeof s.selectedCandidate.strategicAlignment=="number"?s.selectedCandidate.strategicAlignment.toFixed(4):"n/a"}</p>
      <p>governanceIntensity=${e(s.selectedCandidate.governanceIntensity??"n/a")} | domains=${e((s.selectedCandidate.strategicDomains??[]).join(", ")||"none")}</p>
      ${s.selectedCandidate.rolloutBias?`<p>rolloutBias=${e(s.selectedCandidate.rolloutBias.preferred)} stageSizing=${e(s.selectedCandidate.rolloutBias.stageSizing)} rollback=${e(s.selectedCandidate.rolloutBias.rollbackAggressiveness)} isolation=${e(s.selectedCandidate.rolloutBias.dependencyIsolation)} reasons=${e(s.selectedCandidate.rolloutBias.reasons.join(" | ")||"none")}</p>`:"<p>No rollout bias reasoning on selected candidate.</p>"}
    `:"<p>No selected strategic candidate in latest orchestration trace.</p>";return`
    <section class="grid">
      <article class="card">
        <div class="muted">System Health</div>
        <div class="kpi">${S(t.dashboard.systemHealth)}</div>
      </article>
      <article class="card">
        <div class="muted">Production Health</div>
        <div class="kpi">${a}</div>
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
        <ul class="list">${n}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Recent Actions</div>
        <ul class="list">${l}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Production Alerts</div>
        <ul class="list">${v}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Production SLOs</div>
        <ul class="list">${g}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Runtime Governance</div>
        ${o?`<p>mode=${e(o.mode)} | capability=${e(o.capability)} | decision=${e(o.decision)} | reason=${e(o.reason)}</p>`:"<p>No runtime governance record yet.</p>"}
        <ul class="list">${$}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Package Governance Decisions</div>
        <ul class="list">${u}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Strategic Intent Overview</div>
        ${m}
      </article>
      <article class="card wide">
        <div class="muted">Domain Strategic Context</div>
        <ul class="list">${h}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Package Strategic Posture</div>
        <ul class="list">${c}</ul>
      </article>
      <article class="card wide">
        <div class="muted">Selected Orchestration Strategic Rationale</div>
        ${r}
      </article>
    </section>
  `}function O(){if(!t)return"";const n=d();return`
    <article class="card full">
      <div class="muted">Guided Workflow</div>
      <div class="workflow">${["define-intent","plan","preview","approve","execute","audit"].map(a=>{const v=a,g=t?.workflow.current===v,o=t?.workflow.completed.includes(v);return`<span class="step ${g?"current":""} ${o?"done":""}">${e(a)}</span>`}).join("")}</div>
      <p class="muted">Current step: ${e(t.workflow.current)}</p>
      <div class="grid">
        <div class="card">
          <label for="intentInput">Define Intent</label>
          <input id="intentInput" type="text" placeholder="create safer service boundaries" />
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button id="runDefineBtn" ${w(n,"define-intent")?"":"disabled"}>Run</button>
          </div>
        </div>
        <div class="card">
          <label for="planGoalInput">Generate Plan</label>
          <input id="planGoalInput" type="text" placeholder="optional goal override" />
          <button id="runPlanBtn" style="margin-top:8px;" ${w(n,"plan")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="previewPlanInput">Preview Plan ID (optional)</label>
          <input id="previewPlanInput" type="text" placeholder="plan-abc123" />
          <button id="runPreviewBtn" style="margin-top:8px;" ${w(n,"preview")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="approveInput">Approve Diff ID or Plan ID</label>
          <input id="approveInput" type="text" placeholder="diff-... or plan-..." />
          <button id="runApproveBtn" style="margin-top:8px;" ${w(n,"approve")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="executePlanInput">Execute Plan ID (optional)</label>
          <input id="executePlanInput" type="text" placeholder="plan-abc123" />
          <button id="runExecuteBtn" style="margin-top:8px;" ${w(n,"execute")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label>Audit</label>
          <p class="muted">Fetch current immutable audit timeline.</p>
          <button id="runAuditBtn" ${w(n,"audit")?"":"disabled"}>Run</button>
        </div>
      </div>
    </article>
  `}function G(){if(!t)return"";const n=t.planView.length>0?t.planView.map(a=>`
      <tr>
        <td class="mono">${e(a.planId)}</td>
        <td>${e(a.tasks.join(", "))}</td>
        <td class="mono">${e(a.affectedFiles.join(", "))}</td>
        <td>${a.estimatedImpact}</td>
      </tr>
    `).join(""):'<tr><td colspan="4" class="muted">No plans yet.</td></tr>',l=t.diffView.length>0?t.diffView.map(a=>`
        <article class="card full">
          <div class="mono">${e(a.file)}</div>
          <div class="diff">
            <pre>${e(a.before)}</pre>
            <pre>${e(a.after)}</pre>
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
          <tbody>${n}</tbody>
        </table>
      </article>
      ${l}
    </section>
  `}function U(){if(!t)return"";const n=t.timeline.states,l=n.length>0?n.map(c=>`
        <button
          type="button"
          class="timeline-node ${c.index===t?.timeline.currentIndex?"current":""}"
          data-timeline-index="${c.index}"
          title="${e(c.action)}">
          <span class="timeline-label">${e(c.label)}</span>
          <span class="timeline-action">${e(c.action)}</span>
        </button>
      `).join(""):'<div class="muted">No transitions recorded yet.</div>',a=t.stateInspector,v=a.why.length>0?a.why.map(c=>`<li>${e(c)}</li>`).join(""):"<li>No transition explanation available.</li>",g=a.dependencyChain.length>0?a.dependencyChain.map(c=>`<li class="mono">${e(c)}</li>`).join(""):"<li>No dependency chain captured.</li>",o=t.stateDiff&&t.stateDiff.patches.length>0?t.stateDiff.patches.map(c=>`
      <tr>
        <td class="mono">${e(c.path)}</td>
        <td>${e(c.op)}</td>
        <td><pre class="mono compact">${e(JSON.stringify(c.before,null,2)??"null")}</pre></td>
        <td><pre class="mono compact">${e(JSON.stringify(c.after,null,2)??"null")}</pre></td>
      </tr>
    `).join(""):'<tr><td colspan="4" class="muted">No diff patches for current state.</td></tr>',$=t.replayTrace?`
      <article class="card full">
        <div class="muted">Replay Trace</div>
        <p class="mono">visited=${t.replayTrace.visitedStates.length} · replayTime=${t.replayTrace.replayTime}ms · consistency=${t.replayTrace.consistencyCheck} · fallback=${t.replayTrace.fallbackUsed}</p>
      </article>
    `:"",u=t.replayTrace?.planning?.candidates.find(c=>c.selected)??t.replayTrace?.planning?.candidates[0],s=u?`
      <article class="card full">
        <div class="muted">Strategic Orchestration Rationale</div>
        <p>candidate=${e(u.id)} | strategy=${e(u.strategyType)} | alignment=${typeof u.strategicAlignment=="number"?u.strategicAlignment.toFixed(4):"n/a"}</p>
        <p>domains=${e((u.strategicDomains??[]).join(", ")||"none")} | governanceIntensity=${e(u.governanceIntensity??"n/a")}</p>
        ${u.rolloutBias?`<p>rollout=${e(u.rolloutBias.preferred)} stageSizing=${e(u.rolloutBias.stageSizing)} rollback=${e(u.rolloutBias.rollbackAggressiveness)} isolation=${e(u.rolloutBias.dependencyIsolation)} reasons=${e(u.rolloutBias.reasons.join(" | ")||"none")}</p>`:"<p>No rollout bias reasoning captured for selected candidate.</p>"}
      </article>
    `:"",m=t.runtimeGovernance,h=m?`
      <article class="card full">
        <div class="muted">Runtime Governance Trace</div>
        <p>mode=${e(m.mode)} | capability=${e(m.capability)} | decision=${e(m.decision)} | reason=${e(m.reason)}</p>
        <p class="mono">governanceHash=${e(m.governanceHash)}</p>
        <p>strategicDomains=${e((m.strategic?.domains??[]).join(", ")||"none")} | governanceIntensity=${e(m.strategic?.governanceIntensity??"n/a")}</p>
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
        <div class="timeline-track">${l}</div>
      </article>

      <article class="card wide">
        <div class="muted">Why Did This Happen?</div>
        <ul class="list">${v}</ul>
      </article>

      <article class="card">
        <div class="muted">Dependency Chain</div>
        <ul class="list">${g}</ul>
      </article>

      <article class="card full">
        <div class="muted">State Inspector (Exact Replay State)</div>
        <pre class="mono">${e(JSON.stringify({intent:a.intent,ast:a.ast,violations:a.violations,plans:a.plans},null,2))}</pre>
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
          <tbody>${o}</tbody>
        </table>
      </article>

      ${$}
      ${s}
      ${h}
    </section>
  `}function W(){if(!t)return"";const n=t.policyView.map(a=>`
    <tr>
      <td>${S(a.decision)}</td>
      <td>${e(a.rulesMatched.join(", "))||"none"}</td>
      <td>${e(a.source)}</td>
    </tr>
  `).join(""),l=t.pendingApprovals.length>0?t.pendingApprovals.map(a=>`<li><span class="mono">${e(a.id)}</span> ${e(a.command)}</li>`).join(""):"<li>No pending approvals.</li>";return`
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
          <tbody>${n}</tbody>
        </table>
      </article>
      <article class="card full">
        <div class="muted">Pending Approvals</div>
        <ul class="list">${l}</ul>
      </article>
    </section>
  `}function z(){if(!t)return"";const n=t.auditView.events.length>0?t.auditView.events.map(l=>`
      <tr>
        <td class="mono">${e(l.timestamp)}</td>
        <td>${e(l.actor.role)}</td>
        <td>${e(l.action)}</td>
        <td>${e(l.result)}</td>
      </tr>
    `).join(""):'<tr><td colspan="4" class="muted">No events for current filters.</td></tr>';return`
    <section class="grid">
      <article class="card full">
        <div style="display:flex;gap:8px;align-items:end;">
          <div>
            <label for="auditRoleFilter">Role Filter</label>
            <input id="auditRoleFilter" type="text" placeholder="architect|analyst|conductor|enforcer" value="${e(I.role??"")}" />
          </div>
          <div>
            <label for="auditEnvFilter">Environment Filter</label>
            <input id="auditEnvFilter" type="text" placeholder="local|ci|staging|production" value="${e(I.environment??"")}" />
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
          <tbody>${n}</tbody>
        </table>
      </article>
    </section>
  `}function q(){if(!t)return"";const n=t.macroUI.libraries.length>0?t.macroUI.libraries.map(o=>`<li>${e(o)}</li>`).join(""):"<li>No libraries installed.</li>",l=t.macroUI.macros.length>0?t.macroUI.macros.map(o=>`<li class="mono">${e(o)}</li>`).join(""):"<li>No macros discovered.</li>",a=(t.macroUI.lockedVersions??[]).length>0?(t.macroUI.lockedVersions??[]).map(o=>`<li class="mono">${e(o)}</li>`).join(""):"<li>No lock entries.</li>",v=(t.macroUI.transitiveDependencies??[]).length>0?(t.macroUI.transitiveDependencies??[]).map(o=>`<li class="mono">${e(o)}</li>`).join(""):"<li>No dependency edges recorded.</li>",g=t.macroUI.abstractions.length>0?t.macroUI.abstractions.map(o=>`<li class="mono">${e(o)}</li>`).join(""):"<li>No abstractions discovered.</li>";return`
    <section class="grid">
      <article class="card">
        <div class="muted">Libraries</div>
        <ul class="list">${n}</ul>
      </article>
      <article class="card">
        <div class="muted">Macros</div>
        <ul class="list">${l}</ul>
      </article>
      <article class="card">
        <div class="muted">Locked Versions</div>
        <ul class="list">${a}</ul>
      </article>
      <article class="card">
        <div class="muted">Abstractions</div>
        <ul class="list">${g}</ul>
      </article>
      <article class="card full">
        <div class="muted">Transitive Dependencies</div>
        <ul class="list">${v}</ul>
      </article>
      <article class="card full">
        <label for="macroCommandInput">Macro/Abstraction Command</label>
        <div class="dsl-row">
          <input id="macroCommandInput" type="text" placeholder="choir macro local.id key='value'" />
          <button id="runMacroCommandBtn" class="secondary">Run</button>
        </div>
      </article>
    </section>
  `}function J(){if(!t)return"";const n=t.traces.slice(0,8).map(l=>`
      <tr>
        <td>${e(l.action)}</td>
        <td class="mono">${e(l.resultingDSL)}</td>
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
        <pre class="mono">${e(JSON.stringify(t.controlPlane,null,2))}</pre>
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
            ${n||'<tr><td colspan="2" class="muted">No UI traces yet.</td></tr>'}
          </tbody>
        </table>
      </article>
    </section>
  `}function _(){const n=document.getElementById("runDefineBtn"),l=document.getElementById("runPlanBtn"),a=document.getElementById("runPreviewBtn"),v=document.getElementById("runApproveBtn"),g=document.getElementById("runExecuteBtn"),o=document.getElementById("runAuditBtn"),$=document.getElementById("applyAuditFilterBtn"),u=document.getElementById("runMacroCommandBtn"),s=document.getElementById("timelinePlayBtn"),m=document.getElementById("timelinePauseBtn"),h=document.getElementById("timelineStepBackBtn"),c=document.getElementById("timelineStepForwardBtn");n instanceof HTMLButtonElement&&n.addEventListener("click",()=>{const r=document.getElementById("intentInput"),i=r instanceof HTMLInputElement?r.value.trim():"";p({type:"run-workflow",role:d(),step:"define-intent",payload:{intent:i}})}),l instanceof HTMLButtonElement&&l.addEventListener("click",()=>{const r=document.getElementById("planGoalInput"),i=r instanceof HTMLInputElement?r.value.trim():"";p({type:"run-workflow",role:d(),step:"plan",payload:i.length>0?{goal:i}:{}})}),a instanceof HTMLButtonElement&&a.addEventListener("click",()=>{const r=document.getElementById("previewPlanInput"),i=r instanceof HTMLInputElement?r.value.trim():"";p({type:"run-workflow",role:d(),step:"preview",payload:i.length>0?{planId:i}:{}})}),v instanceof HTMLButtonElement&&v.addEventListener("click",()=>{const r=document.getElementById("approveInput"),i=r instanceof HTMLInputElement?r.value.trim():"";if(!i){L("Approve requires diff id or plan id.");return}const b=i.startsWith("diff-")?{diffId:i}:{planId:i};p({type:"run-workflow",role:d(),step:"approve",payload:b})}),g instanceof HTMLButtonElement&&g.addEventListener("click",()=>{const r=document.getElementById("executePlanInput"),i=r instanceof HTMLInputElement?r.value.trim():"";p({type:"run-workflow",role:d(),step:"execute",payload:i.length>0?{planId:i}:{}})}),o instanceof HTMLButtonElement&&o.addEventListener("click",()=>{p({type:"run-workflow",role:d(),step:"audit"})}),$ instanceof HTMLButtonElement&&$.addEventListener("click",()=>{const r=document.getElementById("auditRoleFilter"),i=document.getElementById("auditEnvFilter");I={...r instanceof HTMLInputElement&&r.value.trim().length>0?{role:r.value.trim()}:{},...i instanceof HTMLInputElement&&i.value.trim().length>0?{environment:i.value.trim()}:{}},p({type:"refresh",role:d(),filters:I})}),u instanceof HTMLButtonElement&&u.addEventListener("click",()=>{const r=document.getElementById("macroCommandInput");if(!(r instanceof HTMLInputElement))return;const i=r.value.trim();i.length!==0&&p({type:"run-dsl",role:d(),dsl:i})}),s instanceof HTMLButtonElement&&s.addEventListener("click",()=>{p({type:"replay-control",role:d(),control:"play"})}),m instanceof HTMLButtonElement&&m.addEventListener("click",()=>{p({type:"replay-control",role:d(),control:"pause"})}),h instanceof HTMLButtonElement&&h.addEventListener("click",()=>{p({type:"replay-control",role:d(),control:"step-backward"})}),c instanceof HTMLButtonElement&&c.addEventListener("click",()=>{p({type:"replay-control",role:d(),control:"step-forward"})}),document.querySelectorAll(".timeline-node[data-timeline-index]").forEach(r=>{r.addEventListener("click",()=>{const i=r.dataset.timelineIndex;if(!i)return;const b=Number.parseInt(i,10);Number.isFinite(b)&&p({type:"replay-control",role:d(),control:"jump",index:b})})})}function j(){if(!t){y.innerHTML="";return}f==="dashboard"?y.innerHTML=V():f==="workspace"?y.innerHTML=J():f==="plan-view"?y.innerHTML=G():f==="timeline-view"?y.innerHTML=U():f==="policy-view"?y.innerHTML=W():f==="audit-view"?y.innerHTML=z():y.innerHTML=q(),_()}function H(n){t=n,k.value=n.activeRole,C(),j(),F()}function K(n){n.ok?L(n.message):L(n.error?`${n.error.source}: ${n.error.message}`:n.message),H(n.snapshot)}window.addEventListener("message",n=>{const l=n.data;if(l.type==="snapshot"){H(l.payload);return}l.type==="action-result"&&K(l.payload)});M.addEventListener("click",()=>{const n=x.value.trim();n.length!==0&&p({type:"run-dsl",role:d(),dsl:n})});A.addEventListener("click",()=>{p({type:"refresh",role:d(),filters:I})});k.addEventListener("change",()=>{p({type:"refresh",role:d(),filters:I})});P.postMessage({type:"ready"});
