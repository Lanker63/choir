import * as vscode from "vscode";
import { initializeChoir } from "./choirManager";
import { registerEnforcer } from "./chat";
import { registerArchitect } from "./chat";
import { registerAnalyst } from "./chat";

export function activate(context: vscode.ExtensionContext) {
    console.log("Choir Strategy extension active");

    const initCommand = vscode.commands.registerCommand("choir.init", async () => {
        await initializeChoir();
    });
    context.subscriptions.push(initCommand);

    registerArchitect(context);
    registerAnalyst(context);
    registerEnforcer(context);
}

export function deactivate() {}