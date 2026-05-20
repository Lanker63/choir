import * as vscode from "vscode";
import { readControlPlane } from "../choirManager.js";
import { readStrategicInitState } from "../core/strategicInit.js";
import { deriveDomainHeatmapRows, derivePackageMappingRows } from "./strategicInitViewModel.js";

function toHeatColor(value: number): string {
  const clamped = Math.max(0, Math.min(1, value));
  const red = Math.round(235 - (90 * clamped));
  const green = Math.round(80 + (120 * clamped));
  const blue = Math.round(90 + (40 * clamped));
  return `rgb(${red}, ${green}, ${blue})`;
}

function governanceScore(value: string | undefined): number {
  if (value === "strict") {
    return 1;
  }

  if (value === "moderate") {
    return 0.6;
  }

  return 0.2;
}

function riskScore(value: string | undefined): number {
  if (value === "low") {
    return 1;
  }

  if (value === "moderate") {
    return 0.55;
  }

  return 0.2;
}

export class StrategicInitWizardViewProvider {
  private panel?: vscode.WebviewPanel;

  openPanel(column: vscode.ViewColumn = vscode.ViewColumn.Two): void {
    if (this.panel) {
      this.panel.reveal(column, false);
      this.refresh();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "choir.strategicInitWizard",
      "Choir Strategic Init Wizard",
      column,
      { enableScripts: false }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.refresh();
  }

  refresh(): void {
    if (!this.panel) {
      return;
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const control = readControlPlane();
    const state = root ? readStrategicInitState(root) : null;

    const domains = deriveDomainHeatmapRows(control, state);
    const packages = derivePackageMappingRows(control, state);

    const domainRows = domains.length > 0
      ? domains.map((domain) => {
        const g = governanceScore(domain.governanceIntensity);
        const r = riskScore(domain.riskTolerance);
        return `<tr>
          <td>${domain.id}</td>
          <td>${domain.governanceIntensity}</td>
          <td>${domain.riskTolerance}</td>
          <td>${domain.rolloutPreferences.join(", ") || "none"}</td>
          <td><span class="swatch" style="background:${toHeatColor(g)}"></span></td>
          <td><span class="swatch" style="background:${toHeatColor(r)}"></span></td>
        </tr>`;
      }).join("\n")
      : `<tr><td colspan="6">No strategic domains modeled yet. Run @choir init and complete strategic domain modeling.</td></tr>`;

    const packageRows = packages.length > 0
      ? packages.map((pkg) => `<tr><td>${pkg.id}</td><td>${pkg.domain}</td><td>${pkg.governanceIntensity}</td></tr>`).join("\n")
      : `<tr><td colspan="3">No package mappings configured.</td></tr>`;

    const stateBlock = state
      ? `<pre>${JSON.stringify(state, null, 2)}</pre>`
      : "<p>No strategic init run artifact found yet (.choir/init-strategic-state.json).</p>";

    this.panel.webview.html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
body { font-family: 'IBM Plex Sans', 'Segoe UI', sans-serif; margin: 0; background: #f4f8f6; color: #14362b; }
.layout { padding: 16px; display: grid; gap: 12px; }
.card { background: #fff; border: 1px solid #c8ddd4; border-radius: 10px; padding: 12px; }
table { width: 100%; border-collapse: collapse; }
th, td { border-bottom: 1px solid #dbe9e3; text-align: left; padding: 8px; font-size: 12px; vertical-align: top; }
.swatch { display: inline-block; width: 16px; height: 16px; border-radius: 999px; border: 1px solid #78998d; }
pre { margin: 0; max-height: 240px; overflow: auto; background: #0f1a16; color: #dcf0e7; padding: 12px; border-radius: 8px; }
</style>
</head>
<body>
<div class="layout">
  <section class="card">
    <h3>Strategic Initialization Overview</h3>
    <p>Mission: ${control?.mission ?? ""}</p>
    <p>Vision: ${control?.vision ?? ""}</p>
  </section>
  <section class="card">
    <h3>Domain Heatmap</h3>
    <table>
      <thead>
        <tr><th>Domain</th><th>Governance</th><th>Risk</th><th>Rollout</th><th>Governance Heat</th><th>Risk Heat</th></tr>
      </thead>
      <tbody>${domainRows}</tbody>
    </table>
  </section>
  <section class="card">
    <h3>Package Mapping</h3>
    <table>
      <thead>
        <tr><th>Package</th><th>Domain</th><th>Governance</th></tr>
      </thead>
      <tbody>${packageRows}</tbody>
    </table>
  </section>
  <section class="card">
    <h3>Latest Strategic Init Replay Artifact</h3>
    ${stateBlock}
  </section>
</div>
</body>
</html>`;
  }
}
