const H={architect:["define-intent","approve","audit"],analyst:["audit"],conductor:["define-intent","plan","preview","approve","audit"],enforcer:["execute","audit"]},x={dashboard:"Dashboard",workspace:"Workspace","plan-view":"Plan View","policy-view":"Policy View","audit-view":"Audit View","macro-library":"Macro/Abstraction"},w=window.vscode;if(!w)throw new Error("VSCode API not available in webview context.");const h=document.getElementById("roleSelect"),$=document.getElementById("dslInput"),B=document.getElementById("runDslBtn"),L=document.getElementById("refreshBtn"),b=document.getElementById("surfaceTabs"),u=document.getElementById("surfaceContainer"),y=document.getElementById("consoleOutput");if(!(h instanceof HTMLSelectElement)||!($ instanceof HTMLInputElement)||!(B instanceof HTMLButtonElement)||!(L instanceof HTMLButtonElement)||!(b instanceof HTMLElement)||!(u instanceof HTMLElement)||!(y instanceof HTMLElement))throw new Error("Choir Control Center webview is missing required elements.");let e=null,d="dashboard",p={};function o(){const t=h.value;return t==="architect"||t==="analyst"||t==="conductor"||t==="enforcer"?t:"conductor"}function i(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;")}function g(t){const n=new Date().toISOString(),a=y.textContent??"";y.textContent=`[${n}] ${t}
${a}`}function s(t){w.postMessage({type:"action",payload:t})}function m(t,n){return H[t].includes(n)}function M(t){return t==="stable"||t==="allow"?`<span class="chip success">${i(t)}</span>`:t==="needs-attention"||t==="deny"?`<span class="chip danger">${i(t)}</span>`:`<span class="chip warn">${i(t)}</span>`}function P(){if(!e){b.innerHTML="";return}const t=e.availableSurfaces;t.includes(d)||(d=t[0]??"dashboard"),b.innerHTML=t.map(n=>`<button type="button" class="surface-tab ${n===d?"active":""}" data-surface="${n}">${x[n]}</button>`).join(""),b.querySelectorAll(".surface-tab").forEach(n=>{n.addEventListener("click",()=>{const a=n.dataset.surface;a&&(d=a,T())})})}function R(){if(!e)return"";const t=e.dashboard.recommendations.length>0?e.dashboard.recommendations.map(a=>`<li>${i(a)}</li>`).join(""):"<li>No recommendations. System is aligned.</li>",n=e.dashboard.recentActions.length>0?e.dashboard.recentActions.map(a=>`<li><span class="mono">${i(a.timestamp)}</span> ${i(a.action)} (${i(a.result)})</li>`).join(""):"<li>No audit events yet.</li>";return`
    <section class="grid">
      <article class="card">
        <div class="muted">System Health</div>
        <div class="kpi">${M(e.dashboard.systemHealth)}</div>
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
        <ul class="list">${n}</ul>
      </article>
    </section>
  `}function S(){if(!e)return"";const t=o();return`
    <article class="card full">
      <div class="muted">Guided Workflow</div>
      <div class="workflow">${["define-intent","plan","preview","approve","execute","audit"].map(a=>{const c=a,f=e?.workflow.current===c,v=e?.workflow.completed.includes(c);return`<span class="step ${f?"current":""} ${v?"done":""}">${i(a)}</span>`}).join("")}</div>
      <p class="muted">Current step: ${i(e.workflow.current)}</p>
      <div class="grid">
        <div class="card">
          <label for="intentInput">Define Intent</label>
          <input id="intentInput" type="text" placeholder="create safer service boundaries" />
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button id="runDefineBtn" ${m(t,"define-intent")?"":"disabled"}>Run</button>
          </div>
        </div>
        <div class="card">
          <label for="planGoalInput">Generate Plan</label>
          <input id="planGoalInput" type="text" placeholder="optional goal override" />
          <button id="runPlanBtn" style="margin-top:8px;" ${m(t,"plan")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="previewPlanInput">Preview Plan ID (optional)</label>
          <input id="previewPlanInput" type="text" placeholder="plan-abc123" />
          <button id="runPreviewBtn" style="margin-top:8px;" ${m(t,"preview")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="approveInput">Approve Diff ID or Plan ID</label>
          <input id="approveInput" type="text" placeholder="diff-... or plan-..." />
          <button id="runApproveBtn" style="margin-top:8px;" ${m(t,"approve")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label for="executePlanInput">Execute Plan ID (optional)</label>
          <input id="executePlanInput" type="text" placeholder="plan-abc123" />
          <button id="runExecuteBtn" style="margin-top:8px;" ${m(t,"execute")?"":"disabled"}>Run</button>
        </div>
        <div class="card">
          <label>Audit</label>
          <p class="muted">Fetch current immutable audit timeline.</p>
          <button id="runAuditBtn" ${m(t,"audit")?"":"disabled"}>Run</button>
        </div>
      </div>
    </article>
  `}function C(){if(!e)return"";const t=e.planView.length>0?e.planView.map(a=>`
      <tr>
        <td class="mono">${i(a.planId)}</td>
        <td>${i(a.tasks.join(", "))}</td>
        <td class="mono">${i(a.affectedFiles.join(", "))}</td>
        <td>${a.estimatedImpact}</td>
      </tr>
    `).join(""):'<tr><td colspan="4" class="muted">No plans yet.</td></tr>',n=e.diffView.length>0?e.diffView.map(a=>`
        <article class="card full">
          <div class="mono">${i(a.file)}</div>
          <div class="diff">
            <pre>${i(a.before)}</pre>
            <pre>${i(a.after)}</pre>
          </div>
        </article>
      `).join(""):'<article class="card full"><div class="muted">No preview diff loaded yet. Run Preview.</div></article>';return`
    <section class="grid">
      ${S()}
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
      ${n}
    </section>
  `}function V(){if(!e)return"";const t=e.policyView.map(a=>`
    <tr>
      <td>${M(a.decision)}</td>
      <td>${i(a.rulesMatched.join(", "))||"none"}</td>
      <td>${i(a.source)}</td>
    </tr>
  `).join(""),n=e.pendingApprovals.length>0?e.pendingApprovals.map(a=>`<li><span class="mono">${i(a.id)}</span> ${i(a.command)}</li>`).join(""):"<li>No pending approvals.</li>";return`
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
        <ul class="list">${n}</ul>
      </article>
    </section>
  `}function j(){if(!e)return"";const t=e.auditView.events.length>0?e.auditView.events.map(n=>`
      <tr>
        <td class="mono">${i(n.timestamp)}</td>
        <td>${i(n.actor.role)}</td>
        <td>${i(n.action)}</td>
        <td>${i(n.result)}</td>
      </tr>
    `).join(""):'<tr><td colspan="4" class="muted">No events for current filters.</td></tr>';return`
    <section class="grid">
      <article class="card full">
        <div style="display:flex;gap:8px;align-items:end;">
          <div>
            <label for="auditRoleFilter">Role Filter</label>
            <input id="auditRoleFilter" type="text" placeholder="architect|analyst|conductor|enforcer" value="${i(p.role??"")}" />
          </div>
          <div>
            <label for="auditEnvFilter">Environment Filter</label>
            <input id="auditEnvFilter" type="text" placeholder="local|ci|staging|production" value="${i(p.environment??"")}" />
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
  `}function D(){if(!e)return"";const t=e.macroUI.libraries.length>0?e.macroUI.libraries.map(c=>`<li>${i(c)}</li>`).join(""):"<li>No libraries installed.</li>",n=e.macroUI.macros.length>0?e.macroUI.macros.map(c=>`<li class="mono">${i(c)}</li>`).join(""):"<li>No macros discovered.</li>",a=e.macroUI.abstractions.length>0?e.macroUI.abstractions.map(c=>`<li class="mono">${i(c)}</li>`).join(""):"<li>No abstractions discovered.</li>";return`
    <section class="grid">
      <article class="card">
        <div class="muted">Libraries</div>
        <ul class="list">${t}</ul>
      </article>
      <article class="card">
        <div class="muted">Macros</div>
        <ul class="list">${n}</ul>
      </article>
      <article class="card">
        <div class="muted">Abstractions</div>
        <ul class="list">${a}</ul>
      </article>
      <article class="card full">
        <label for="macroCommandInput">Macro/Abstraction Command</label>
        <div class="dsl-row">
          <input id="macroCommandInput" type="text" placeholder="choir macro local.id key='value'" />
          <button id="runMacroCommandBtn" class="secondary">Run</button>
        </div>
      </article>
    </section>
  `}function F(){if(!e)return"";const t=e.traces.slice(0,8).map(n=>`
      <tr>
        <td>${i(n.action)}</td>
        <td class="mono">${i(n.resultingDSL)}</td>
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
        <pre class="mono">${i(JSON.stringify(e.controlPlane,null,2))}</pre>
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
  `}function N(){const t=document.getElementById("runDefineBtn"),n=document.getElementById("runPlanBtn"),a=document.getElementById("runPreviewBtn"),c=document.getElementById("runApproveBtn"),f=document.getElementById("runExecuteBtn"),v=document.getElementById("runAuditBtn"),I=document.getElementById("applyAuditFilterBtn"),E=document.getElementById("runMacroCommandBtn");t instanceof HTMLButtonElement&&t.addEventListener("click",()=>{const r=document.getElementById("intentInput"),l=r instanceof HTMLInputElement?r.value.trim():"";s({type:"run-workflow",role:o(),step:"define-intent",payload:{intent:l}})}),n instanceof HTMLButtonElement&&n.addEventListener("click",()=>{const r=document.getElementById("planGoalInput"),l=r instanceof HTMLInputElement?r.value.trim():"";s({type:"run-workflow",role:o(),step:"plan",payload:l.length>0?{goal:l}:{}})}),a instanceof HTMLButtonElement&&a.addEventListener("click",()=>{const r=document.getElementById("previewPlanInput"),l=r instanceof HTMLInputElement?r.value.trim():"";s({type:"run-workflow",role:o(),step:"preview",payload:l.length>0?{planId:l}:{}})}),c instanceof HTMLButtonElement&&c.addEventListener("click",()=>{const r=document.getElementById("approveInput"),l=r instanceof HTMLInputElement?r.value.trim():"";if(!l){g("Approve requires diff id or plan id.");return}const k=l.startsWith("diff-")?{diffId:l}:{planId:l};s({type:"run-workflow",role:o(),step:"approve",payload:k})}),f instanceof HTMLButtonElement&&f.addEventListener("click",()=>{const r=document.getElementById("executePlanInput"),l=r instanceof HTMLInputElement?r.value.trim():"";s({type:"run-workflow",role:o(),step:"execute",payload:l.length>0?{planId:l}:{}})}),v instanceof HTMLButtonElement&&v.addEventListener("click",()=>{s({type:"run-workflow",role:o(),step:"audit"})}),I instanceof HTMLButtonElement&&I.addEventListener("click",()=>{const r=document.getElementById("auditRoleFilter"),l=document.getElementById("auditEnvFilter");p={...r instanceof HTMLInputElement&&r.value.trim().length>0?{role:r.value.trim()}:{},...l instanceof HTMLInputElement&&l.value.trim().length>0?{environment:l.value.trim()}:{}},s({type:"refresh",role:o(),filters:p})}),E instanceof HTMLButtonElement&&E.addEventListener("click",()=>{const r=document.getElementById("macroCommandInput");if(!(r instanceof HTMLInputElement))return;const l=r.value.trim();l.length!==0&&s({type:"run-dsl",role:o(),dsl:l})})}function T(){if(!e){u.innerHTML="";return}d==="dashboard"?u.innerHTML=R():d==="workspace"?u.innerHTML=F():d==="plan-view"?u.innerHTML=C():d==="policy-view"?u.innerHTML=V():d==="audit-view"?u.innerHTML=j():u.innerHTML=D(),N()}function A(t){e=t,h.value=t.activeRole,P(),T()}function U(t){t.ok?g(t.message):g(t.error?`${t.error.source}: ${t.error.message}`:t.message),A(t.snapshot)}window.addEventListener("message",t=>{const n=t.data;if(n.type==="snapshot"){A(n.payload);return}n.type==="action-result"&&U(n.payload)});B.addEventListener("click",()=>{const t=$.value.trim();t.length!==0&&s({type:"run-dsl",role:o(),dsl:t})});L.addEventListener("click",()=>{s({type:"refresh",role:o(),filters:p})});h.addEventListener("change",()=>{s({type:"refresh",role:o(),filters:p})});setInterval(()=>{s({type:"refresh",role:o(),filters:p})},5e3);w.postMessage({type:"ready"});
