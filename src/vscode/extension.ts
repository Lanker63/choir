import * as vscode from "vscode";
import { RuleEditorProvider } from "./ruleEditorProvider";

export function activate(context: vscode.ExtensionContext) {
    console.log("Choir Strategy extension active");

    // const initCommand = vscode.commands.registerCommand("choir.init", async () => {
    //     await initializeChoir();
    // });
    // context.subscriptions.push(initCommand);
    
    const provider = new RuleEditorProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("choir.ruleEditor", provider)
    );

    void import("../chat")
        .then(({ registerEnforcer, registerArchitect, registerAnalyst }) => {
            try {
                registerArchitect(context);
                registerAnalyst(context);
                registerEnforcer(context);
            } catch (error) {
                console.error("Choir chat participants failed to register", error);
            }
        })
        .catch((error) => {
            console.error("Choir chat module failed to load", error);
        });
    
    context.subscriptions.push(
        vscode.commands.registerCommand("choir.openRuleEditor", () => {
            vscode.commands.executeCommand("workbench.view.extension.choir");
        })
    );
}

export function deactivate() {}