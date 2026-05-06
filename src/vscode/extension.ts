import * as vscode from "vscode";
import * as path from "path";
import { registerChoir } from "../chat.js";
import { ChoirProductService } from "./ChoirProductService.js";
import { RuleEditorProvider } from "./RuleEditorProvider.js";
import { RuleTreeProvider } from "./RuleTreeProvider.js";
import { GraphViewProvider } from "./GraphViewProvider.js";
import { TimelineViewProvider } from "./TimelineViewProvider.js";
import { ChoirEventBus, MessageTraceStore, WebviewRegistry } from "./choirWebviewSync.js";
import { readStatePlane } from "../core/state.js";
import { runPipelineForWorkspace } from "../enforcer.js";
import { registerFixCodeActions } from "./diagnostics.js";
import { registerChoirLanguageSupport } from "./choirLanguageSupport.js";

function addSubscription(context: vscode.ExtensionContext, disposable: vscode.Disposable) {
    context.subscriptions.push(disposable);
}

export function activate(context: vscode.ExtensionContext) {
    console.log("Choir extension active");
    registerFixCodeActions(context);
    registerChoirLanguageSupport(context);

    const eventBus = new ChoirEventBus();
    const traceStore = new MessageTraceStore();
    const webviewRegistry = new WebviewRegistry();
    const productService = new ChoirProductService(context);

    const emitStateUpdated = () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const stateHash = root ? (readStatePlane(root)?.stateHash ?? "GENESIS") : "GENESIS";
        eventBus.emit({ type: "STATE_UPDATED", stateHash });
    };

    const triggerPipeline = async () => {
        try {
            await runPipelineForWorkspace();
            emitStateUpdated();
            eventBus.emit({ type: "PLAN_UPDATED" });
            eventBus.emit({ type: "GRAPH_UPDATED" });
            eventBus.emit({ type: "TIMELINE_UPDATED" });
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
        const provider = new RuleEditorProvider(context, productService, eventBus, traceStore, webviewRegistry);
        const graphProvider = new GraphViewProvider(context, eventBus, traceStore, webviewRegistry);
        const timelineProvider = new TimelineViewProvider(context, productService, eventBus, traceStore, webviewRegistry);

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

        // Command to focus the Control Center webview.
        addSubscription(context, vscode.commands.registerCommand("choir.openRuleEditorForRule", async (rule) => {
            try {
                const yaml = await import("yaml");
                const dslText = yaml.stringify([rule]);

                // Preserve existing API shape; control center is panel-based for full layout.
                provider.setDslText(dslText);
                provider.openPanel(vscode.ViewColumn.One);
            } catch (err) {
                console.error("Choir: openRuleEditorForRule failed", err);
            }
        }));

        addSubscription(context, vscode.commands.registerCommand("choir.openRuleEditor", () => {
            provider.openPanel(vscode.ViewColumn.One);
        }));

        addSubscription(context, vscode.commands.registerCommand("choir.openDependencyGraph", async () => {
            graphProvider.openPanel(vscode.ViewColumn.One);
        }));

        addSubscription(context, vscode.commands.registerCommand("choir.openTimeline", async () => {
            timelineProvider.openPanel(vscode.ViewColumn.Two);
            eventBus.emit({ type: "TIMELINE_UPDATED" });
        }));

        addSubscription(context, vscode.commands.registerCommand("choir.graph.setMode", async (mode?: string, nodeId?: string) => {
            const normalizedMode = mode === "focused" || mode === "dependency" || mode === "dependents" ? mode : "full";
            await graphProvider.setMode(normalizedMode, typeof nodeId === "string" ? nodeId : undefined);
            graphProvider.openPanel(vscode.ViewColumn.One);
        }));

        addSubscription(context, vscode.commands.registerCommand("choir.openRuleEditorPanel", () => {
            try {
                provider.openPanel(vscode.ViewColumn.One);
            } catch (err) {
                console.error("Choir: openRuleEditorPanel failed", err);
            }
        }));

        addSubscription(context, vscode.commands.registerCommand("choir.openRuleEditorPanelResolve", () => {
            try {
                provider.openPanel(vscode.ViewColumn.One);
            } catch (err) {
                console.error("Choir: openRuleEditorPanelResolve failed", err);
            }
        }));

        addSubscription(context, vscode.commands.registerCommand("choir.revealRuleEditorDebug", async () => {
            try {
                provider.openPanel(vscode.ViewColumn.One);
                console.log("Choir: reveal debug attempted");
            } catch (err) {
                console.error("Choir: reveal debug failed", err);
            }
        }));

        addSubscription(context, vscode.commands.registerCommand("choir.showWebviewSyncTrace", () => {
            const lines = traceStore.list()
                .map((entry) => `[${new Date(entry.timestamp).toISOString()}] ${entry.direction} (${entry.viewId}) ${entry.type}`)
                .join("\n");

            void vscode.window.showInformationMessage(lines.length > 0 ? "Choir webview sync trace copied to output." : "No webview sync trace yet.");
            console.log(lines.length > 0 ? lines : "No webview sync trace yet.");
        }));
        // provider instance created; panel-based editor will use it
    } catch (error) {
        console.error("Choir: failed to register rule editor provider", error);
    }

    try {
        registerChoir(context);
        console.log("Choir chat participant registered successfully (@choir DSL)");
    } catch (error) {
        console.error("Choir chat participants failed to register", error);
    }

    void triggerPipeline();
}

export function deactivate() {}