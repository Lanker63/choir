import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { StrategySchema, Strategy } from "./schema";
import * as YAML from "yaml";

function getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return undefined;
    return folders[0].uri.fsPath;
}

export function getChoirPath(): string | undefined {
    const root = getWorkspaceRoot();
    if (!root) return undefined;
    return path.join(root, ".choir");
}

export async function initializeChoir() {
    const choirPath = getChoirPath();
    if (!choirPath) {
        vscode.window.showErrorMessage("No workspace open.");
        return;
    }

    if (!fs.existsSync(choirPath)) {
        fs.mkdirSync(choirPath);
    }

    const strategyFile = path.join(choirPath, "strategy.yaml");

    if (!fs.existsSync(strategyFile)) {
        const initial = {
            project: {
                name: "My Project",
                goals: []
            },
            standards: {},
            constraints: []
        };

        fs.writeFileSync(strategyFile, YAML.stringify(initial));
    }

    vscode.window.showInformationMessage("Choir initialized.");
}

export function readStrategy(): Strategy | null {
    const choirPath = getChoirPath();
    if (!choirPath) return null;

    const file = path.join(choirPath, "strategy.yaml");
    if (!fs.existsSync(file)) return null;

    const raw = fs.readFileSync(file, "utf-8");

    try {
        const parsed = YAML.parse(raw);
        return StrategySchema.parse(parsed); // 🔥 strict validation
    } catch (err: any) {
        vscode.window.showErrorMessage("Invalid strategy.yaml: " + err.message);
        return null;
    }
}

export function writeStrategy(data: Strategy) {
    const choirPath = getChoirPath();
    if (!choirPath) return;

    const file = path.join(choirPath, "strategy.yaml");

    const validated = StrategySchema.parse(data); // enforce shape
    fs.writeFileSync(file, YAML.stringify(validated));
}