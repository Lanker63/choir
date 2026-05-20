    const vscode = acquireVsCodeApi();
    let model = null;

    const timelineList = document.getElementById('timelineList');
    const inspector = document.getElementById('inspector');
    const diff = document.getElementById('diff');
    const trace = document.getElementById('trace');
    const runtimeGovernance = document.getElementById('runtimeGovernance');
    const strategic = document.getElementById('strategic');
    const statusLine = document.getElementById('statusLine');

    function post(message) { vscode.postMessage(message); }

    function render() {
      if (!model) return;

      statusLine.textContent = 'Generated: ' + model.generatedAt + ' | Current index: ' + model.timeline.currentIndex;

      timelineList.innerHTML = (model.timeline.states ?? []).map((entry) => {
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
      runtimeGovernance.textContent = JSON.stringify(model.runtimeGovernance ?? {}, null, 2);

      const selectedCandidate = model.replayTrace?.planning?.candidates?.find((candidate) => candidate.selected)
        ?? model.replayTrace?.planning?.candidates?.[0];
      const strategicLines = [
        model.strategicSummary?.global
          ? 'global: governance=' + model.strategicSummary.global.governanceIntensity + ', risk=' + model.strategicSummary.global.riskTolerance + ', priorities=' + (model.strategicSummary.global.priorities.join(', ') || 'none')
          : 'global: not configured',
        model.strategicSummary && model.strategicSummary.domains.length > 0
          ? 'domains: ' + model.strategicSummary.domains.map((domain) => domain.id + '(' + (domain.governanceIntensity || 'inherited') + ')').join(', ')
          : 'domains: none',
        model.strategicSummary && model.strategicSummary.packages.length > 0
          ? 'packages: ' + model.strategicSummary.packages.map((pkg) => pkg.id + '->' + pkg.domain).join(', ')
          : 'packages: none',
        selectedCandidate
          ? 'selected: ' + selectedCandidate.id + ' strategy=' + selectedCandidate.strategyType + ' alignment=' + (typeof selectedCandidate.strategicAlignment === 'number' ? selectedCandidate.strategicAlignment.toFixed(4) : 'n/a')
          : 'selected: none',
        selectedCandidate?.rolloutBias
          ? 'rollout: ' + selectedCandidate.rolloutBias.preferred + ', stage=' + selectedCandidate.rolloutBias.stageSizing + ', rollback=' + selectedCandidate.rolloutBias.rollbackAggressiveness + ', isolation=' + selectedCandidate.rolloutBias.dependencyIsolation
          : 'rollout: no rationale captured',
      ];
      strategic.textContent = strategicLines.join('\\n');
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
