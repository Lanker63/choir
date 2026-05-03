import * as vscode from "vscode";
import { globSync } from "glob";
import * as fs from "fs";

export function analyzeWorkspace() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;

    const files = globSync("**/*.{ts,js}", {
        cwd: root,
        ignore: ["node_modules/**"]
    });

    const summary = {
        totalFiles: files.length,
        services: 0,
        controllers: 0,
        repositories: 0
    };

    for (const file of files) {
        if (file.includes("service")) summary.services++;
        if (file.includes("controller")) summary.controllers++;
        if (file.includes("repository")) summary.repositories++;
    }

    return summary;
}

export function findHotspots() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return [];

    const files = globSync("**/*.ts", {
        cwd: root,
        ignore: ["node_modules/**"]
    });

    const hotspots: string[] = [];

    for (const file of files) {
        const content = fs.readFileSync(root + "/" + file, "utf-8");

        if (content.length > 5000) {
            hotspots.push(`🔥 Large file: ${file}`);
        }

        if (content.split("\n").length > 300) {
            hotspots.push(`📏 Long file: ${file}`);
        }
    }

    return hotspots;
}