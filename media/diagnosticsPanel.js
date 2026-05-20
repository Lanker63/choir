(() => {
  const vscode = acquireVsCodeApi();
  const listNode = document.getElementById("list");
  const detailsNode = document.getElementById("details");
  const statusFilter = document.getElementById("statusFilter");
  const categoryFilter = document.getElementById("categoryFilter");
  const searchInput = document.getElementById("searchInput");
  const refreshBtn = document.getElementById("refreshBtn");

  let model = null;
  let selectedId = null;

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
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
      return '<div class="item' + active + '" data-id="' + escapeHtml(entry.id) + '">'
        + '<div>'
        + '<span class="badge ' + escapeHtml(entry.result) + '">' + escapeHtml(entry.result) + '</span>'
        + '<span class="badge">' + escapeHtml(entry.category) + '</span>'
        + '</div>'
        + '<div><strong>' + escapeHtml(entry.summary) + '</strong></div>'
        + '<div class="meta">' + escapeHtml(entry.command) + ' | ' + escapeHtml(entry.source) + ' | ' + escapeHtml(entry.timestamp) + '</div>'
        + '</div>';
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
      return '<tr>'
        + '<td>' + escapeHtml(stage.stage) + '</td>'
        + '<td><span class="badge ' + escapeHtml(stage.status) + '">' + escapeHtml(stage.status) + '</span></td>'
        + '<td>' + escapeHtml(stage.detail) + '</td>'
        + '</tr>';
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

      return '<tr>'
        + '<td>' + escapeHtml(candidate.id || '') + selectedBadge + '</td>'
        + '<td>' + escapeHtml(candidate.strategyType || '') + '</td>'
        + '<td>' + escapeHtml(candidate.strategicAlignment || '') + '</td>'
        + '<td>' + escapeHtml(candidate.governanceIntensity || '') + '</td>'
        + '<td>' + escapeHtml(candidate.riskScore || '') + '</td>'
        + '<td>' + escapeHtml(candidate.rollbackComplexity || '') + '</td>'
        + '<td>' + escapeHtml(candidate.blastRadius || '') + '</td>'
        + '<td>' + escapeHtml(candidate.stages || '') + '</td>'
        + '</tr>';
    }).join('');

    const comparisonRows = comparisons.map((comparison) => {
      const diff = comparison.diff ?? {};
      return '<tr>'
        + '<td>' + escapeHtml(comparison.from || '') + '</td>'
        + '<td>' + escapeHtml(comparison.to || '') + '</td>'
        + '<td>' + escapeHtml(diff.riskDelta || '') + '</td>'
        + '<td>' + escapeHtml(diff.rollbackDelta || '') + '</td>'
        + '<td>' + escapeHtml(diff.graphDelta || '') + '</td>'
        + '</tr>';
    }).join('');

    const metadata = selected.metadata ? JSON.stringify(selected.metadata, null, 2) : "{}";
    const emptyStageRow = '<tr><td colspan="3">No stage data recorded.</td></tr>';
    const emptyCandidateRow = '<tr><td colspan="8">No candidate plans recorded.</td></tr>';
    const emptyComparisonRow = '<tr><td colspan="5">No plan comparisons recorded.</td></tr>';

    detailsNode.innerHTML =
      '<div class="header">Generated ' + escapeHtml(model.generatedAt) + ' | Log ' + escapeHtml(model.logPath) + '</div>'
      + '<div><strong>' + escapeHtml(selected.summary) + '</strong></div>'
      + '<div>Command: ' + escapeHtml(selected.command) + '</div>'
      + '<div>Category: ' + escapeHtml(selected.category) + ' | Result: ' + escapeHtml(selected.result) + ' | Source: ' + escapeHtml(selected.source) + '</div>'
      + '<div>Timestamp: ' + escapeHtml(selected.timestamp) + '</div>'
      + '<table>'
      + '<thead><tr><th>Stage</th><th>Status</th><th>Detail</th></tr></thead>'
      + '<tbody>' + (stageRows.length > 0 ? stageRows : emptyStageRow) + '</tbody>'
      + '</table>'
      + '<div><strong>Candidate Plans</strong></div>'
      + '<table>'
      + '<thead><tr><th>Candidate</th><th>Strategy</th><th>Strategic Alignment</th><th>Governance</th><th>Risk</th><th>Rollback</th><th>Blast Radius</th><th>DAG Stages</th></tr></thead>'
      + '<tbody>' + (candidateRows.length > 0 ? candidateRows : emptyCandidateRow) + '</tbody>'
      + '</table>'
      + '<div><strong>Compare Plans</strong></div>'
      + '<table>'
      + '<thead><tr><th>From</th><th>To</th><th>Risk delta</th><th>Rollback delta</th><th>Graph delta</th></tr></thead>'
      + '<tbody>' + (comparisonRows.length > 0 ? comparisonRows : emptyComparisonRow) + '</tbody>'
      + '</table>'
      + '<div><strong>Metadata</strong></div>'
      + '<pre>' + escapeHtml(metadata) + '</pre>';
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

  vscode.postMessage({ type: "ready" });
})();
