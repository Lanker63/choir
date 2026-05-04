import * as vscode from "vscode";
import { registerAnalyst, registerArchitect, registerEnforcer } from "../chat.js";
import { RuleEditorProvider } from "./ruleEditorProvider.js";
import { RuleTreeProvider } from "./ruleTreeProvider.js";

export function activate(context: vscode.ExtensionContext) {
    console.log("Choir Strategy extension active");
    
    try {
        const provider = new RuleEditorProvider(context);

        // Register tree provider for the activity view that lists rules
        const tree = new RuleTreeProvider(context);
        context.subscriptions.push(vscode.window.registerTreeDataProvider("choir.ruleList", tree));
        // expose refresh command for the Rules view
        context.subscriptions.push(
            vscode.commands.registerCommand("choir.refreshRules", () => tree.refresh())
        );

        // Auto-refresh rules when workspace folders change
        context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh())
        );

        // Command to open a selected rule in the webview panel
        context.subscriptions.push(
            vscode.commands.registerCommand("choir.openRuleEditorForRule", async (rule) => {
                try {
                    const panel = vscode.window.createWebviewPanel(
                        "choir.ruleEditor.panel",
                        `Rule Editor - ${rule.id}`,
                        vscode.ViewColumn.One,
                        { enableScripts: true }
                    );

                    panel.webview.html = provider.getHtml(panel.webview);

                    // Send the rule content to the webview after a short delay so the script is ready
                    const yaml = await import("yaml");
                    const dslText = yaml.stringify([rule]);
                    setTimeout(() => {
                        panel.webview.postMessage({ type: "setDSL", dsl: dslText });
                    }, 150);
                } catch (err) {
                    console.error("Choir: openRuleEditorForRule failed", err);
                }
            })
        );
        context.subscriptions.push(
            vscode.commands.registerCommand("choir.openRuleEditor", () => {
                vscode.commands.executeCommand("workbench.view.extension.choir");
            })
        );
        context.subscriptions.push(
            vscode.commands.registerCommand("choir.openRuleEditorPanel", () => {
                try {
                    const panel = vscode.window.createWebviewPanel(
                        "choir.ruleEditor.panel",
                        "Rule Editor (Panel)",
                        vscode.ViewColumn.One,
                        { enableScripts: true }
                    );

                    // reuse provider HTML generation
                    panel.webview.html = provider.getHtml(panel.webview);

                    panel.webview.onDidReceiveMessage((msg) => {
                        console.log("RuleEditorPanel: received message", msg);
                    });
                } catch (err) {
                    console.error("Choir: openRuleEditorPanel failed", err);
                }
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand("choir.openRuleEditorPanelResolve", () => {
                try {
                    const panel = vscode.window.createWebviewPanel(
                        "choir.ruleEditor.panel.resolve",
                        "Rule Editor (Panel Resolve)",
                        vscode.ViewColumn.One,
                        { enableScripts: true }
                    );

                    const fakeView: any = {
                        viewType: "choir.ruleEditor",
                        title: "Rule Editor",
                        webview: panel.webview,
                        show: (preserveFocus?: boolean) => {},
                    };

                    // call the provider's resolve directly to reproduce the lifecycle
                    // and capture logs/errors
                    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                    // @ts-ignore
                    provider.resolveWebviewView(fakeView as vscode.WebviewView);
                    console.log("Choir: invoked provider.resolveWebviewView on panel webview");
                } catch (err) {
                    console.error("Choir: openRuleEditorPanelResolve failed", err);
                }
            })
        );
        context.subscriptions.push(
            vscode.commands.registerCommand("choir.revealRuleEditorDebug", async () => {
                try {
                    await vscode.commands.executeCommand("workbench.view.extension.choir");
                    await vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
                    await new Promise((r) => setTimeout(r, 120));
                    await vscode.commands.executeCommand("workbench.view.extension.choir");
                    console.log("Choir: reveal debug attempted");
                } catch (err) {
                    console.error("Choir: reveal debug failed", err);
                }
            })
        );
        // provider instance created; panel-based editor will use it
    } catch (error) {
        console.error("Choir: failed to register rule editor provider", error);
    }

    try {
        registerArchitect(context);
        registerAnalyst(context);
        registerEnforcer(context);
        console.log("Choir chat participants registered successfully");
    } catch (error) {
        console.error("Choir chat participants failed to register", error);
    }
}

export function deactivate() {}