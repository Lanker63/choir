import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getControlPlanePath } from "../choirManager.js";
import { registerChoir } from "../chat.js";
import { ChoirProductService } from "./ChoirProductService.js";
import { RuleEditorProvider } from "./ruleEditorProvider.js";
import { RuleTreeProvider } from "./ruleTreeProvider.js";
import { GraphViewProvider } from "./GraphViewProvider.js";
import { TimelineViewProvider } from "./TimelineViewProvider.js";
import { PipelineDiagnosticsViewProvider } from "./PipelineDiagnosticsViewProvider.js";
import { StrategicInitWizardViewProvider } from "./StrategicInitWizardViewProvider.js";
import { ChoirEventBus, MessageTraceStore, WebviewRegistry } from "./choirWebviewSync.js";
import { readStatePlane } from "../core/state.js";
import { recoverState, verifyReplayConsistency } from "../core/persistentStateAudit.js";
import { runPipelineForWorkspace } from "../enforcer.js";
import { registerFixCodeActions } from "./diagnostics.js";
import { registerChoirLanguageSupport } from "./choirLanguageSupport.js";

function addSubscription(context: vscode.ExtensionContext, disposable: vscode.Disposable) {
    context.subscriptions.push(disposable);
}

function hasInitializedChoir(root: string): boolean {
    const yamlPath = path.join(root, ".choir", "choir.config.yaml");
    return fs.existsSync(yamlPath);
}

export function activate(context: vscode.ExtensionContext) {
    console.log("Choir extension active");

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root && hasInitializedChoir(root)) {
        try {
            recoverState(root);
            verifyReplayConsistency(root);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Choir state recovery failed: ${message}`);
            throw new Error(`Choir startup halted due to state recovery failure: ${message}`);
        }
    }

    registerFixCodeActions(context);
    registerChoirLanguageSupport(context);

    const eventBus = new ChoirEventBus();
    const traceStore = new MessageTraceStore();
    const webviewRegistry = new WebviewRegistry();
    const webviewSyncTraceOutput = vscode.window.createOutputChannel("Choir Webview Sync Trace");
    addSubscription(context, webviewSyncTraceOutput);
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
        return normalizedPath.endsWith("/.choir/choir.config.yaml");
    };
    
    try {
        const provider = new RuleEditorProvider(context, productService, eventBus, traceStore, webviewRegistry);
        const graphProvider = new GraphViewProvider(context, eventBus, traceStore, webviewRegistry, triggerPipeline);
        const timelineProvider = new TimelineViewProvider(context, productService, eventBus, traceStore, webviewRegistry);
        const diagnosticsProvider = new PipelineDiagnosticsViewProvider(context, eventBus, traceStore, webviewRegistry);
        const strategicInitWizardProvider = new StrategicInitWizardViewProvider();

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
                // Open the Control Center panel for context
                provider.openPanel(vscode.ViewColumn.One);

                // Try to open the canonical control-plane file and reveal the selected rule
                const controlPath = getControlPlanePath();
                const ruleId = rule && typeof rule.id === "string" ? rule.id : undefined;

                async function openAndRevealFile(filePath: string) {
                    try {
                        const doc = await vscode.workspace.openTextDocument(filePath);
                        if (ruleId) {
                            const text = doc.getText();
                            const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&");
                            // look for list entry like `- id: <ruleId>` or `id: <ruleId>`
                            let m = new RegExp("^-\\s*id\\s*:\\s*" + escapeRegExp(ruleId) + "\\b", "m").exec(text);
                            if (!m) {
                                m = new RegExp("^\\s*id\\s*:\\s*" + escapeRegExp(ruleId) + "\\b", "m").exec(text);
                            }
                            if (m) {
                                const pos = doc.positionAt(m.index);
                                await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.Two });
                                return;
                            }
                        }
                        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Two });
                    } catch (err) {
                        console.error("Choir: failed to open control plane document", err);
                        throw err;
                    }
                }

                if (controlPath && fs.existsSync(controlPath)) {
                    try {
                        await openAndRevealFile(controlPath);
                    } catch {
                        // fallback to creating a quick YAML view of the rule
                        const yaml = await import("yaml");
                        const dslText = yaml.stringify([rule]);
                        const doc = await vscode.workspace.openTextDocument({ content: dslText, language: "yaml" });
                        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Two });
                    }
                } else {
                    // No canonical control plane on disk — open a temporary YAML view for the rule
                    const yaml = await import("yaml");
                    const dslText = yaml.stringify([rule]);
                    const doc = await vscode.workspace.openTextDocument({ content: dslText, language: "yaml" });
                    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Two });
                }

                // Emit a NAVIGATE event so the Control Center webview can highlight the rule
                try {
                    eventBus.emit({ type: "NAVIGATE", intent: { type: "focusRule", ruleId } });
                } catch (emitErr) {
                    console.error("Choir: failed to emit NAVIGATE event", emitErr);
                }
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

        addSubscription(context, vscode.commands.registerCommand("choir.openDiagnostics", async () => {
            try {
                diagnosticsProvider.openPanel(vscode.ViewColumn.Two);
                await diagnosticsProvider.refresh();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`Unable to open diagnostics: ${message}`);
            }
        }));

        addSubscription(context, vscode.commands.registerCommand("choir.openStrategicInitWizard", async () => {
            strategicInitWizardProvider.openPanel(vscode.ViewColumn.Two);
        }));

        addSubscription(context, vscode.commands.registerCommand("choir.refreshDiagnostics", async () => {
            await diagnosticsProvider.refresh();
        }));

        addSubscription(context, vscode.commands.registerCommand("choir.graph.setMode", async (mode?: string, nodeId?: string) => {
            const normalizedMode = mode === "focused" || mode === "dependency" || mode === "dependents" ? mode : "full";
            await graphProvider.setMode(normalizedMode, typeof nodeId === "string" ? nodeId : undefined);
            graphProvider.openPanel(vscode.ViewColumn.One);
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
            const entries = traceStore.list();
            const lines = entries
                .map((entry) => `[${new Date(entry.timestamp).toISOString()}] ${entry.direction} (${entry.viewId}) ${entry.type}`)
                .join("\n");

            webviewSyncTraceOutput.clear();
            webviewSyncTraceOutput.appendLine("Choir Webview Sync Trace");
            webviewSyncTraceOutput.appendLine(`entries=${entries.length}`);
            webviewSyncTraceOutput.appendLine("");
            webviewSyncTraceOutput.appendLine(lines.length > 0 ? lines : "No webview sync trace yet.");
            webviewSyncTraceOutput.show(true);
            void vscode.window.showInformationMessage(lines.length > 0
                ? "Choir webview sync trace opened in Output."
                : "No webview sync trace yet. Output channel opened.");
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