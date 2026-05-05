import * as vscode from "vscode";
import * as path from "path";
import { registerAnalyst, registerArchitect, registerChoir, registerConductor, registerEnforcer } from "../chat.js";
import { RuleEditorProvider } from "./RuleEditorProvider.js";
import { RuleTreeProvider } from "./RuleTreeProvider.js";
import { runPipelineForWorkspace } from "../enforcer.js";
import { registerFixCodeActions } from "./diagnostics.js";

function addSubscription(context: vscode.ExtensionContext, disposable: vscode.Disposable) {
    context.subscriptions.push(disposable);
}

export function activate(context: vscode.ExtensionContext) {
    console.log("Choir extension active");
    registerFixCodeActions(context);

    const triggerPipeline = async () => {
        try {
            await runPipelineForWorkspace();
        } catch (error) {
            console.error("Choir: pipeline execution failed", error);
        }
    };

    const isControlPlaneSave = (document: vscode.TextDocument): boolean => {
        const normalizedPath = document.uri.fsPath.split(path.sep).join("/").toLowerCase();
        return normalizedPath.endsWith("/.choir/choir.config.yaml")
            || normalizedPath.endsWith("/.choir/choir.config.yml");
    };
    
    try {
        const provider = new RuleEditorProvider(context);

        // Register the sidebar webview view so resolveWebviewView is invoked.
        addSubscription(context, vscode.window.registerWebviewViewProvider("choir.ruleEditor", provider));

        // Register tree provider for the activity view that lists rules
        const tree = new RuleTreeProvider();
        addSubscription(context, vscode.window.registerTreeDataProvider("choir.ruleList", tree));
        // expose refresh command for the Rules view
        addSubscription(context, vscode.commands.registerCommand("choir.refreshRules", () => tree.refresh()));

        // Auto-refresh rules when workspace folders change
        addSubscription(context, vscode.workspace.onDidChangeWorkspaceFolders(() => {
            tree.refresh();
            void triggerPipeline();
        }));

        // Keep diagnostics in sync with edits through the unified pipeline.
        addSubscription(context, vscode.workspace.onDidSaveTextDocument((document) => {
            if (isControlPlaneSave(document)) {
                tree.refresh();
            }

            void triggerPipeline();
        }));

        // Command to open a selected rule in the webview panel
        addSubscription(context, vscode.commands.registerCommand("choir.openRuleEditorForRule", async (rule) => {
            try {
                const yaml = await import("yaml");
                const dslText = yaml.stringify([rule]);

                // Reuse the sidebar rule editor instead of opening a second panel.
                provider.setDslText(dslText);
                await vscode.commands.executeCommand("workbench.view.extension.choir");
                await vscode.commands.executeCommand("choir.ruleEditor.focus");
            } catch (err) {
                console.error("Choir: openRuleEditorForRule failed", err);
            }
        }));

        addSubscription(context, vscode.commands.registerCommand("choir.openRuleEditor", () => {
            vscode.commands.executeCommand("workbench.view.extension.choir");
            vscode.commands.executeCommand("choir.ruleEditor.focus");
        }));

        addSubscription(context, vscode.commands.registerCommand("choir.openRuleEditorPanel", () => {
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
        }));

        addSubscription(context, vscode.commands.registerCommand("choir.openRuleEditorPanelResolve", () => {
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
                    show: (_preserveFocus?: boolean) => {},
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
        }));

        addSubscription(context, vscode.commands.registerCommand("choir.revealRuleEditorDebug", async () => {
            try {
                await vscode.commands.executeCommand("workbench.view.extension.choir");
                await vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
                await new Promise((r) => setTimeout(r, 120));
                await vscode.commands.executeCommand("workbench.view.extension.choir");
                console.log("Choir: reveal debug attempted");
            } catch (err) {
                console.error("Choir: reveal debug failed", err);
            }
        }));
        // provider instance created; panel-based editor will use it
    } catch (error) {
        console.error("Choir: failed to register rule editor provider", error);
    }

    try {
        registerChoir(context);
        registerArchitect(context);
        registerAnalyst(context);
        registerEnforcer(context);
        registerConductor(context);
        console.log("Choir chat participants registered successfully (@choir + legacy aliases)");
    } catch (error) {
        console.error("Choir chat participants failed to register", error);
    }

    void triggerPipeline();
}

export function deactivate() {}