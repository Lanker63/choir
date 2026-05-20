    const vscode = acquireVsCodeApi();
    const d3 = window.d3;

    const state = {
      snapshot: null,
      selectedNodeId: undefined,
      searchText: "",
      nodePositions: new Map(),
      zoomTransform: null,
    };

    const layout = document.querySelector(".layout");
    const modeSelect = document.getElementById("modeSelect");
    const focusSelect = document.getElementById("focusSelect");
    const searchInput = document.getElementById("searchInput");
    const refreshBtn = document.getElementById("refreshBtn");
    const openNodeBtn = document.getElementById("openNodeBtn");
    const dependenciesBtn = document.getElementById("dependenciesBtn");
    const dependentsBtn = document.getElementById("dependentsBtn");
    const statusLine = document.getElementById("statusLine");
    const traceLine = document.getElementById("traceLine");
    const inspector = document.getElementById("inspector");
    const splitter = document.getElementById("splitter");
    const graphSvg = document.getElementById("graphSvg");
    const miniMap = document.getElementById("miniMap");

    const SIDEBAR_MIN = 160;
    const SIDEBAR_DEFAULT = 180;
    const RIGHT_MIN = 320;
    const SPLITTER_WIDTH = 10;

    let activePointerId;
    let resizeFrame = 0;

    function parsePixelValue(value, fallback) {
      const parsed = Number.parseFloat(String(value || "").trim());
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    function currentSidebarWidth() {
      const raw = getComputedStyle(layout).getPropertyValue("--sidebar-width");
      return parsePixelValue(raw, 320);
    }

    function clampSidebarWidth(width) {
      const max = Math.max(SIDEBAR_MIN, layout.clientWidth - RIGHT_MIN - SPLITTER_WIDTH);
      return Math.max(SIDEBAR_MIN, Math.min(width, max));
    }

    function persistSidebarWidth(width) {
      const existing = vscode.getState() ?? {};
      vscode.setState({
        ...existing,
        sidebarWidth: width,
      });
    }

    function applySidebarWidth(width, persist) {
      const clamped = clampSidebarWidth(width);
      layout.style.setProperty("--sidebar-width", String(clamped) + "px");
      splitter.setAttribute("aria-valuenow", String(Math.round(clamped)));
      if (persist) {
        persistSidebarWidth(clamped);
      }
      if (state.snapshot) {
        if (resizeFrame) {
          cancelAnimationFrame(resizeFrame);
        }
        resizeFrame = requestAnimationFrame(function() {
          resizeFrame = 0;
          renderGraph();
        });
      }
    }

    function beginResize(pointerId) {
      activePointerId = pointerId;
      splitter.classList.add("dragging");
      document.body.style.userSelect = "none";
    }

    function updateResize(clientX, persist) {
      const layoutRect = layout.getBoundingClientRect();
      applySidebarWidth(clientX - layoutRect.left, persist);
    }

    function endResize() {
      activePointerId = undefined;
      splitter.classList.remove("dragging");
      document.body.style.userSelect = "";
    }

    function sortedUnique(values) {
      return Array.from(new Set(values)).filter(function(value) {
        return typeof value === "string" && value.length > 0;
      }).sort(function(a, b) {
        return a.localeCompare(b);
      });
    }

    function toSet(values) {
      return new Set(Array.isArray(values) ? values : []);
    }

    function edgeAdjacency(edges) {
      const outgoing = new Map();
      const incoming = new Map();
      for (const edge of edges) {
        const out = outgoing.get(edge.source) ?? [];
        out.push(edge.target);
        outgoing.set(edge.source, sortedUnique(out));
        const inc = incoming.get(edge.target) ?? [];
        inc.push(edge.source);
        incoming.set(edge.target, sortedUnique(inc));
      }
      return { outgoing, incoming };
    }

    function traceFrom(start, adjacency) {
      const visited = new Set();
      const queue = [start];
      let queueIndex = 0;
      while (queueIndex < queue.length) {
        const current = queue[queueIndex];
        queueIndex += 1;
        if (visited.has(current)) {
          continue;
        }
        visited.add(current);
        const next = adjacency.get(current) ?? [];
        for (const nodeId of next) {
          if (!visited.has(nodeId)) {
            queue.push(nodeId);
          }
        }
      }
      return visited;
    }

    function computeLayout(graph) {
      const nodeIds = graph.nodes.map(function(node) { return node.id; }).sort(function(a, b) { return a.localeCompare(b); });
      const indegree = new Map(nodeIds.map(function(nodeId) { return [nodeId, 0]; }));
      const outgoing = new Map(nodeIds.map(function(nodeId) { return [nodeId, []]; }));

      for (const edge of graph.edges) {
        if (!indegree.has(edge.target) || !outgoing.has(edge.source)) {
          continue;
        }

        indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
        const existing = outgoing.get(edge.source) ?? [];
        existing.push(edge.target);
        outgoing.set(edge.source, sortedUnique(existing));
      }

      const layer = new Map(nodeIds.map(function(nodeId) { return [nodeId, 0]; }));
      const queue = nodeIds.filter(function(nodeId) { return (indegree.get(nodeId) || 0) === 0; }).sort(function(a, b) { return a.localeCompare(b); });
      const visitedSet = new Set();
      let queueIndex = 0;

      function enqueueSorted(nodeId) {
        let insertAt = queue.length;
        for (let index = queueIndex; index < queue.length; index += 1) {
          if (nodeId.localeCompare(queue[index]) < 0) {
            insertAt = index;
            break;
          }
        }

        queue.splice(insertAt, 0, nodeId);
      }

      while (queueIndex < queue.length) {
        const current = queue[queueIndex];
        queueIndex += 1;
        visitedSet.add(current);
        const nextLayer = layer.get(current) || 0;
        for (const next of outgoing.get(current) ?? []) {
          const currentLayer = layer.get(next) || 0;
          layer.set(next, Math.max(currentLayer, nextLayer + 1));
          indegree.set(next, (indegree.get(next) || 0) - 1);
          if ((indegree.get(next) || 0) === 0) {
            enqueueSorted(next);
          }
        }
      }

      const remaining = nodeIds.filter(function(nodeId) { return !visitedSet.has(nodeId); });
      if (remaining.length > 0) {
        const maxLayer = Math.max(0, ...Array.from(layer.values()));
        remaining.sort(function(a, b) { return a.localeCompare(b); }).forEach(function(nodeId, index) {
          layer.set(nodeId, maxLayer + 1 + Math.floor(index / 8));
        });
      }

      const grouped = new Map();
      for (const nodeId of nodeIds) {
        const nodeLayer = layer.get(nodeId) || 0;
        const existing = grouped.get(nodeLayer) ?? [];
        existing.push(nodeId);
        grouped.set(nodeLayer, existing.sort(function(a, b) { return a.localeCompare(b); }));
      }

      const positions = new Map();
      const layers = Array.from(grouped.keys()).sort(function(a, b) { return a - b; });
      for (const layerId of layers) {
        const list = grouped.get(layerId) ?? [];
        list.forEach(function(nodeId, index) {
          const preserved = state.nodePositions.get(nodeId);
          if (preserved) {
            positions.set(nodeId, preserved);
            return;
          }
          positions.set(nodeId, {
            x: 140 + layerId * 280,
            y: 100 + index * 120,
          });
        });
      }

      return positions;
    }

    function renderInspector() {
      if (!state.snapshot || !state.selectedNodeId) {
        inspector.textContent = "Select a node to inspect metadata.";
        return;
      }

      const node = state.snapshot.graph.nodes.find(function(entry) { return entry.id === state.selectedNodeId; });
      if (!node) {
        inspector.textContent = "Selected node is not visible in this mode.";
        return;
      }

      const overlayStep = state.snapshot.planOverlay && Array.isArray(state.snapshot.planOverlay.steps)
        ? state.snapshot.planOverlay.steps.find(function(step) { return step.nodeId === node.id; })
        : undefined;
      const hotspot = Array.isArray(state.snapshot.hotspots)
        ? state.snapshot.hotspots.find(function(entry) { return entry.nodeId === node.id; })
        : undefined;
      const candidateOrchestration = state.snapshot.candidateOrchestration;
      const candidateSummary = candidateOrchestration && Array.isArray(candidateOrchestration.candidates)
        ? candidateOrchestration.candidates
          .map(function(candidate) {
            const rank = typeof candidate.rank === "number" ? ("#" + candidate.rank + " ") : "";
            const selected = candidate.selected === true ? " [selected]" : "";
            return rank + candidate.strategyType + " (" + candidate.id + ", dag=" + candidate.dagHash + ")" + selected;
          })
          .join("\\n")
        : "none";

      const lines = [
        "id: " + node.id,
        "label: " + node.label,
        "type: " + node.type,
        "",
        "metadata:",
        JSON.stringify(node.metadata || {}, null, 2),
        "",
        "overlay:",
        overlayStep ? ("planOrder=" + overlayStep.order + ", task=" + overlayStep.taskId) : "none",
        "",
        "hotspot:",
        hotspot ? ("score=" + hotspot.score + ", reasons=" + (hotspot.reasons || []).join(",")) : "none",
        "",
        "candidate orchestration:",
        candidateOrchestration
          ? ("selected=" + candidateOrchestration.selectedCandidateId + ", strategy=" + candidateOrchestration.selectedStrategyType + ", dag=" + candidateOrchestration.selectedDagHash)
          : "none",
        "",
        "candidates:",
        candidateSummary,
      ];

      inspector.textContent = lines.join("\\n");
    }

    function applySearchStyling(nodeSelection, edgeSelection, dependencySet, dependentSet) {
      const query = state.searchText.trim().toLowerCase();
      const selected = state.selectedNodeId;

      nodeSelection.attr("opacity", function(d) {
        const match = query.length === 0 || d.id.toLowerCase().includes(query) || d.label.toLowerCase().includes(query);
        if (selected && (d.id === selected || dependencySet.has(d.id) || dependentSet.has(d.id))) {
          return 1;
        }
        return match ? 1 : 0.2;
      });

      edgeSelection.attr("opacity", function(d) {
        if (!selected) {
          return query.length === 0 ? 0.7 : 0.25;
        }
        if (d.source.id === selected || d.target.id === selected) {
          return 0.95;
        }
        if (dependencySet.has(d.target.id) && dependencySet.has(d.source.id)) {
          return 0.7;
        }
        if (dependentSet.has(d.target.id) && dependentSet.has(d.source.id)) {
          return 0.7;
        }
        return 0.18;
      });
    }

    function renderMiniMap(graph, positions) {
      const mini = d3.select(miniMap);
      mini.selectAll("*").remove();

      if (graph.nodes.length === 0) {
        return;
      }

      const width = miniMap.clientWidth || 220;
      const height = miniMap.clientHeight || 150;
      mini.attr("viewBox", "0 0 " + width + " " + height);

      const xs = graph.nodes.map(function(node) { return positions.get(node.id).x; });
      const ys = graph.nodes.map(function(node) { return positions.get(node.id).y; });
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const contentWidth = Math.max(1, maxX - minX + 120);
      const contentHeight = Math.max(1, maxY - minY + 80);
      const scale = Math.min((width - 12) / contentWidth, (height - 12) / contentHeight);

      function sx(x) { return 6 + (x - minX) * scale; }
      function sy(y) { return 6 + (y - minY) * scale; }

      mini.append("rect")
        .attr("x", 0)
        .attr("y", 0)
        .attr("width", width)
        .attr("height", height)
        .attr("fill", "rgba(255,255,255,0.82)");

      mini.selectAll("line.edge")
        .data(graph.edges)
        .enter()
        .append("line")
        .attr("x1", function(d) { return sx(positions.get(d.source).x); })
        .attr("y1", function(d) { return sy(positions.get(d.source).y); })
        .attr("x2", function(d) { return sx(positions.get(d.target).x); })
        .attr("y2", function(d) { return sy(positions.get(d.target).y); })
        .attr("stroke", "#aec9be")
        .attr("stroke-width", 1);

      mini.selectAll("circle.node")
        .data(graph.nodes)
        .enter()
        .append("circle")
        .attr("cx", function(d) { return sx(positions.get(d.id).x); })
        .attr("cy", function(d) { return sy(positions.get(d.id).y); })
        .attr("r", 2.8)
        .attr("fill", function(d) { return d.id === state.selectedNodeId ? "#1e7b5f" : "#4f7a6a"; });
    }

    function renderGraph() {
      if (!state.snapshot) {
        return;
      }

      const graph = state.snapshot.graph;
      const svg = d3.select(graphSvg);
      svg.selectAll("*").remove();

      const width = graphSvg.clientWidth || 800;
      const height = graphSvg.clientHeight || 600;
      svg.attr("viewBox", "0 0 " + width + " " + height);

      const zoomLayer = svg.append("g").attr("class", "zoom-layer");
      const edgeLayer = zoomLayer.append("g").attr("class", "edges");
      const nodeLayer = zoomLayer.append("g").attr("class", "nodes");

      const positions = computeLayout(graph);
      for (const [nodeId, position] of positions.entries()) {
        state.nodePositions.set(nodeId, position);
      }

      const changedSet = toSet(state.snapshot.changedNodeIds);
      const affectedSet = toSet(state.snapshot.affectedNodeIds);
      const violationSet = toSet(state.snapshot.violationNodeIds);
      const hotspotSet = new Set((state.snapshot.hotspots ?? []).map(function(entry) { return entry.nodeId; }));
      const planOrder = new Map();
      if (state.snapshot.planOverlay && Array.isArray(state.snapshot.planOverlay.steps)) {
        for (const step of state.snapshot.planOverlay.steps) {
          const existing = planOrder.get(step.nodeId);
          if (typeof existing !== "number" || step.order < existing) {
            planOrder.set(step.nodeId, step.order);
          }
        }
      }

      const dataEdges = graph.edges.map(function(edge) {
        return {
          ...edge,
          sourceNode: graph.nodes.find(function(node) { return node.id === edge.source; }),
          targetNode: graph.nodes.find(function(node) { return node.id === edge.target; }),
        };
      });

      const edgeSelection = edgeLayer.selectAll("path.edge")
        .data(dataEdges, function(d) { return d.id; })
        .enter()
        .append("path")
        .attr("class", "edge")
        .attr("fill", "none")
        .attr("stroke", "#9bb6ab")
        .attr("stroke-width", 1.4)
        .attr("stroke-linecap", "round");

      function edgePath(d) {
        const source = positions.get(d.source.id);
        const target = positions.get(d.target.id);
        const cx = (source.x + target.x) / 2;
        return "M" + source.x + "," + source.y + " C " + cx + "," + source.y + " " + cx + "," + target.y + " " + target.x + "," + target.y;
      }

      function repaintEdges() {
        edgeSelection.attr("d", function(d) { return edgePath(d); });
      }

      repaintEdges();

      const nodeSelection = nodeLayer.selectAll("g.node")
        .data(graph.nodes, function(d) { return d.id; })
        .enter()
        .append("g")
        .attr("class", "node")
        .attr("transform", function(d) {
          const p = positions.get(d.id);
          return "translate(" + p.x + "," + p.y + ")";
        })
        .style("cursor", "grab")
        .on("click", function(_event, d) {
          state.selectedNodeId = d.id;
          focusSelect.value = d.id;
          updateActionButtons();
          renderInspector();
          renderGraph();
        })
        .on("dblclick", function(_event, d) {
          vscode.postMessage({ type: "open-node", id: d.id });
        });

      nodeSelection.append("rect")
        .attr("x", -78)
        .attr("y", -24)
        .attr("width", 156)
        .attr("height", 48)
        .attr("rx", 10)
        .attr("ry", 10)
        .attr("fill", function(d) {
          if (violationSet.has(d.id)) return "#fde3e3";
          if (changedSet.has(d.id)) return "#dae5fb";
          if (affectedSet.has(d.id)) return "#fff3d7";
          if (hotspotSet.has(d.id)) return "#ffe2c8";
          return "#eef7f2";
        })
        .attr("stroke", function(d) {
          if (state.selectedNodeId === d.id) return "#1e7b5f";
          if (violationSet.has(d.id)) return "#bc2d2d";
          if (changedSet.has(d.id)) return "#2154b8";
          if (affectedSet.has(d.id)) return "#d2931f";
          if (hotspotSet.has(d.id)) return "#d16a15";
          return "#7ea99a";
        })
        .attr("stroke-width", function(d) { return state.selectedNodeId === d.id ? 2.8 : 1.3; });

      nodeSelection.append("text")
        .attr("text-anchor", "middle")
        .attr("dy", "0.34em")
        .attr("font-size", 12)
        .attr("font-weight", 600)
        .attr("fill", "#193c2f")
        .text(function(d) { return d.label; });

      nodeSelection.filter(function(d) { return planOrder.has(d.id); }).append("circle")
        .attr("cx", 65)
        .attr("cy", -16)
        .attr("r", 10)
        .attr("fill", "#1e7b5f");

      nodeSelection.filter(function(d) { return planOrder.has(d.id); }).append("text")
        .attr("x", 65)
        .attr("y", -16)
        .attr("text-anchor", "middle")
        .attr("dy", "0.35em")
        .attr("font-size", 10)
        .attr("font-weight", 700)
        .attr("fill", "#ffffff")
        .text(function(d) { return String(planOrder.get(d.id)); });

      const adjacency = edgeAdjacency(graph.edges);
      const dependencySet = state.selectedNodeId ? traceFrom(state.selectedNodeId, adjacency.outgoing) : new Set();
      const dependentSet = state.selectedNodeId ? traceFrom(state.selectedNodeId, adjacency.incoming) : new Set();
      if (state.selectedNodeId) {
        dependencySet.delete(state.selectedNodeId);
        dependentSet.delete(state.selectedNodeId);
      }

      applySearchStyling(nodeSelection, edgeSelection, dependencySet, dependentSet);

      const dragBehavior = d3.drag()
        .on("start", function() { d3.select(this).style("cursor", "grabbing"); })
        .on("drag", function(event, d) {
          const next = { x: event.x, y: event.y };
          positions.set(d.id, next);
          state.nodePositions.set(d.id, next);
          d3.select(this).attr("transform", "translate(" + next.x + "," + next.y + ")");
          repaintEdges();
          renderMiniMap(graph, positions);
        })
        .on("end", function() { d3.select(this).style("cursor", "grab"); });

      nodeSelection.call(dragBehavior);

      const zoom = d3.zoom()
        .scaleExtent([0.2, 4])
        .on("zoom", function(event) {
          state.zoomTransform = event.transform;
          zoomLayer.attr("transform", event.transform);
        });

      svg.call(zoom);
      if (state.zoomTransform) {
        svg.call(zoom.transform, state.zoomTransform);
      }

      renderMiniMap(graph, positions);
    }

    function populateFocusOptions(snapshot) {
      const nodes = [...snapshot.graph.nodes].sort(function(a, b) { return a.id.localeCompare(b.id); });
      focusSelect.innerHTML = "";

      const none = document.createElement("option");
      none.value = "";
      none.textContent = "(none)";
      focusSelect.appendChild(none);

      for (const node of nodes) {
        const option = document.createElement("option");
        option.value = node.id;
        option.textContent = node.label + " (" + node.id + ")";
        focusSelect.appendChild(option);
      }
    }

    function applySnapshot(snapshot) {
      state.snapshot = snapshot;
      populateFocusOptions(snapshot);

      if (snapshot.focusNodeId && snapshot.graph.nodes.some(function(node) { return node.id === snapshot.focusNodeId; })) {
        state.selectedNodeId = snapshot.focusNodeId;
        focusSelect.value = snapshot.focusNodeId;
      } else if (state.selectedNodeId && snapshot.graph.nodes.some(function(node) { return node.id === state.selectedNodeId; })) {
        focusSelect.value = state.selectedNodeId;
      } else {
        state.selectedNodeId = undefined;
        focusSelect.value = "";
      }

      modeSelect.value = snapshot.mode;
      const refreshedAt = new Date(snapshot.generatedAt);
      const refreshedLabel = Number.isNaN(refreshedAt.getTime())
        ? snapshot.generatedAt
        : refreshedAt.toLocaleTimeString();
      statusLine.textContent = "nodes=" + snapshot.graph.nodes.length
        + ", edges=" + snapshot.graph.edges.length
        + ", changed=" + (snapshot.changedNodeIds ?? []).length
        + ", violations=" + (snapshot.violationNodeIds ?? []).length
        + ", refreshed=" + refreshedLabel;

      traceLine.textContent = "stateHash=" + snapshot.trace.sourceStateHash
        + ", rendered=" + snapshot.trace.nodesRendered + "/" + snapshot.trace.edgesRendered
        + ", generatedAt=" + snapshot.generatedAt;

      updateActionButtons();
      renderInspector();
      renderGraph();
    }

    function sendMode(mode) {
      const focusNodeId = focusSelect.value.trim();
      vscode.postMessage({
        type: "set-mode",
        mode: mode,
        focusNodeId: focusNodeId.length > 0 ? focusNodeId : undefined,
      });
    }

    function isVisibleNodeId(nodeId) {
      if (!state.snapshot || typeof nodeId !== "string" || nodeId.trim().length === 0) {
        return false;
      }

      return state.snapshot.graph.nodes.some(function(node) { return node.id === nodeId; });
    }

    function resolveActionableNodeId() {
      const selectedNodeId = typeof state.selectedNodeId === "string" ? state.selectedNodeId.trim() : "";
      if (selectedNodeId && isVisibleNodeId(selectedNodeId)) {
        return selectedNodeId;
      }

      const focusedNodeId = focusSelect.value.trim();
      if (focusedNodeId && isVisibleNodeId(focusedNodeId)) {
        return focusedNodeId;
      }

      const snapshotFocusNodeId = state.snapshot && typeof state.snapshot.focusNodeId === "string"
        ? state.snapshot.focusNodeId.trim()
        : "";
      if (snapshotFocusNodeId && isVisibleNodeId(snapshotFocusNodeId)) {
        return snapshotFocusNodeId;
      }

      return "";
    }

    function updateActionButtons() {
      const hasNode = resolveActionableNodeId().length > 0;
      openNodeBtn.disabled = !hasNode;
      dependenciesBtn.disabled = !hasNode;
      dependentsBtn.disabled = !hasNode;
    }

    modeSelect.addEventListener("change", function() {
      sendMode(modeSelect.value);
    });

    focusSelect.addEventListener("change", function() {
      state.selectedNodeId = focusSelect.value || undefined;
      updateActionButtons();
      sendMode(modeSelect.value);
    });

    searchInput.addEventListener("input", function() {
      state.searchText = searchInput.value;
      renderGraph();
    });

    refreshBtn.addEventListener("click", function() {
      statusLine.textContent = "Refreshing graph projection...";
      vscode.postMessage({ type: "refresh" });
    });

    openNodeBtn.addEventListener("click", function() {
      const nodeId = resolveActionableNodeId();

      if (!nodeId) {
        statusLine.textContent = "Open Node requires a selected/focused node.";
        updateActionButtons();
        return;
      }

      state.selectedNodeId = nodeId;
      if (focusSelect.value !== nodeId) {
        focusSelect.value = nodeId;
      }

      statusLine.textContent = "Opening node + timeline...";
      vscode.postMessage({ type: "open-node", id: nodeId });
    });

    dependenciesBtn.addEventListener("click", function() {
      const nodeId = resolveActionableNodeId();
      if (!nodeId) {
        updateActionButtons();
        return;
      }

      state.selectedNodeId = nodeId;
      if (focusSelect.value !== nodeId) {
        focusSelect.value = nodeId;
      }
      modeSelect.value = "dependency";
      sendMode("dependency");
    });

    dependentsBtn.addEventListener("click", function() {
      const nodeId = resolveActionableNodeId();
      if (!nodeId) {
        updateActionButtons();
        return;
      }

      state.selectedNodeId = nodeId;
      if (focusSelect.value !== nodeId) {
        focusSelect.value = nodeId;
      }
      modeSelect.value = "dependents";
      sendMode("dependents");
    });

    splitter.addEventListener("pointerdown", function(event) {
      beginResize(event.pointerId);
      splitter.setPointerCapture(event.pointerId);
      updateResize(event.clientX, false);
    });

    splitter.addEventListener("pointermove", function(event) {
      if (activePointerId !== event.pointerId) {
        return;
      }

      updateResize(event.clientX, false);
    });

    splitter.addEventListener("pointerup", function(event) {
      if (activePointerId !== event.pointerId) {
        return;
      }

      updateResize(event.clientX, true);
      endResize();
    });

    splitter.addEventListener("pointercancel", function(event) {
      if (activePointerId !== event.pointerId) {
        return;
      }

      persistSidebarWidth(currentSidebarWidth());
      endResize();
    });

    splitter.addEventListener("keydown", function(event) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }

      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -16 : 16;
      applySidebarWidth(currentSidebarWidth() + delta, true);
    });

    window.addEventListener("resize", function() {
      applySidebarWidth(currentSidebarWidth(), false);
    });

    applySidebarWidth(SIDEBAR_DEFAULT, true);
    updateActionButtons();

    window.addEventListener("message", function(event) {
      const message = event.data;
      if (!message || typeof message !== "object") {
        return;
      }

      if (message.type === "snapshot" && message.payload) {
        applySnapshot(message.payload);
        return;
      }

      if (message.type === "error") {
        statusLine.textContent = "Error: " + String(message.message || "unknown error");
      }
    });

    vscode.postMessage({ type: "ready" });
