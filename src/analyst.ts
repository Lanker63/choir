import * as vscode from "vscode";
import { readControlPlane } from "./choirManager.js";
import { analyzeWorkspaceAtRoot, findHotspotsAtRoot } from "./core/workspaceAnalysis.js";

function safeReadControlPlaneForAnalyze() {
    try {
        return readControlPlane();
    } catch {
        return null;
    }
}

export function analyzeWorkspace() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;

    return analyzeWorkspaceAtRoot(root);
}

export function findHotspots() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return [];

    const controlPlane = safeReadControlPlaneForAnalyze();

    return findHotspotsAtRoot(root, controlPlane);
}