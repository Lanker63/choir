import * as vscode from "vscode";
import * as YAML from "yaml";
import { readControlPlane, writeControlPlane } from "./choirManager.js";
import { analyzeWorkspace, findHotspots } from "./analyst.js";
import { applyChatToControlPlane } from "./chatCompiler.js";
import { runPipelineForWorkspace } from "./enforcer.js";
import {
    approvePlan,
    executeSelectedPlansWithPreviewGuard,
    generateSelectedPlanPreview,
    summarizePlanStatus,
    upsertDraftPlan,
} from "./conductor.js";
import { parseConductorCommand } from "./conductorCommands.js";
import { createEmptyStatePlane, readStatePlane } from "./core/state.js";

type ChatParticipantHandler = Parameters<NonNullable<typeof vscode.chat.createChatParticipant>>[1];

function registerParticipant(
    context: vscode.ExtensionContext,
    id: string,
    displayName: string,
    handler: ChatParticipantHandler
) {
    const createParticipant = vscode.chat?.createChatParticipant;
    if (!createParticipant) {
        console.warn(`${displayName} chat participant API is unavailable`);
        return;
    }

    const participant = createParticipant(id, handler);
    context.subscriptions.push(participant);
}

function getWorkspaceRoot(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

export function registerArchitect(context: vscode.ExtensionContext) {
    registerParticipant(
        context,
        "choir.architect",
        "Choir Architect",
        async (request, ctx, stream) => {
            const raw = (request as any).prompt ?? "";
            const message = raw.toLowerCase();

            const controlPlane = readControlPlane();
            if (!controlPlane) {
                stream.markdown("No control plane found. Open a workspace folder first.");
                return;
            }

            // Show control plane
            if (message.includes("show") || message.includes("control") || message.includes("strategy")) {
                stream.markdown("```yaml\n" + YAML.stringify(controlPlane) + "\n```");
                return;
            }

            const updated = applyChatToControlPlane(raw, controlPlane);
            const changed = JSON.stringify(updated) !== JSON.stringify(controlPlane);
            if (!changed) {
                stream.markdown(`
### 🧠 Choir Architect

Try:
- "Show control plane"
- "Set mission: Deliver secure and maintainable services"
- "Set vision: Platform-level policy by default"
- "Add non-goal: Build a generic workflow engine"
- "Add non-goals: Distributed app, authentication, authorization"
- "Remove non-goal: Build a generic workflow engine"
- "Add goal: Build auth system"
- "Add goals: Build auth system, create user administration"
- "Add constraints: no database, no user administration"
- "Add constraint: no direct db access"
- "Add layer: service"
- "Remove goal: Build auth system"
- "Remove constraint: no direct db access"
                `);
                return;
            }

            writeControlPlane(updated);

            const pipelineResult = await runPipelineForWorkspace({ controlPlane: updated });
            if (!pipelineResult) {
                stream.markdown("✅ Control plane updated, but no workspace root is open for pipeline execution.");
                return;
            }

            stream.markdown(
                `✅ Control plane updated and pipeline executed. Diagnostics: ${pipelineResult.diagnostics.length}`
            );
        }
    );
}

export function registerEnforcer(context: vscode.ExtensionContext) {
    registerParticipant(context, "choir.enforcer", "Choir Enforcer", async (_request, _context, stream) => {
        const controlPlane = readControlPlane();
        if (!controlPlane) {
            stream.markdown("No control plane found.");
            return;
        }

        const result = await runPipelineForWorkspace({
            controlPlane,
        });
        if (!result) {
            stream.markdown("No workspace folder found.");
            return;
        }

        if (result.diagnostics.length === 0) {
            stream.markdown("✅ Clean");
            return;
        }

        stream.markdown(
            "⛔ Pipeline reported diagnostics:\n\n" +
            result.diagnostics
                .map((diagnostic) => `- [${diagnostic.ruleId}] ${diagnostic.message} (${diagnostic.location.file})`)
                .join("\n")
        );
    });
}

export function registerAnalyst(context: vscode.ExtensionContext) {
    registerParticipant(
        context,
        "choir.analyst",
        "Choir Analyst",
        async (request, ctx, stream) => {
            const message = ((request as any).prompt ?? "").toLowerCase();

            // 📊 Overview
            if (message.includes("overview") || message.includes("summary")) {
                const summary = analyzeWorkspace();

                if (!summary) {
                    stream.markdown("No workspace found.");
                    return;
                }

                stream.markdown(`
## 📊 Workspace Summary

- Files: ${summary.totalFiles}
- Services: ${summary.services}
- Controllers: ${summary.controllers}
- Repositories: ${summary.repositories}
                `);
                return;
            }

            // 🔥 Hotspots
            if (message.includes("hotspot") || message.includes("issues")) {
                const hotspots = findHotspots();

                if (hotspots.length === 0) {
                    stream.markdown("✅ No major hotspots.");
                    return;
                }

                stream.markdown("## 🔥 Code Hotspots\n\n" + hotspots.join("\n"));
                return;
            }

            stream.markdown(`
### 🔍 Choir Analyst

Try:
- "Workspace summary"
- "Find hotspots"
            `);
        }
    );
}

export function registerConductor(context: vscode.ExtensionContext) {
    registerParticipant(
        context,
        "choir.conductor",
        "Choir Conductor",
        async (request, _ctx, stream) => {
            const raw = (request as any).prompt ?? "";
            const prompt = raw.trim();
            const command = parseConductorCommand(prompt);

            const controlPlane = readControlPlane();
            if (!controlPlane) {
                stream.markdown("No control plane found. Open a workspace folder first.");
                return;
            }

            if (command.kind === "plan") {
                const root = getWorkspaceRoot();
                if (!root) {
                    stream.markdown("No workspace folder found.");
                    return;
                }

                const state = readStatePlane(root) ?? createEmptyStatePlane();
                const { updatedControl, plan, replaced } = upsertDraftPlan(controlPlane, state, command.goal);

                writeControlPlane(updatedControl);

                const dependencyCount = plan.tasks.reduce((sum, task) => sum + (task.dependsOn?.length ?? 0), 0);
                stream.markdown([
                    `✅ Draft plan ${replaced ? "updated" : "created"}: ${plan.id}`,
                    "",
                    `- Title: ${plan.title}`,
                    `- Status: ${plan.status}`,
                    `- Tasks: ${plan.tasks.length}`,
                    `- Dependencies: ${dependencyCount}`,
                    "",
                    "Next step: @choir.conductor approve <planId>",
                ].join("\n"));
                return;
            }

            if (command.kind === "approve") {
                if (!command.planId) {
                    stream.markdown("Provide a plan id. Example: approve plan-abc123def456");
                    return;
                }

                const { updatedControl, plan } = approvePlan(controlPlane, command.planId);
                if (!plan) {
                    stream.markdown(`Plan not found: ${command.planId}`);
                    return;
                }

                writeControlPlane(updatedControl);
                stream.markdown(`✅ Plan approved: ${plan.id}`);
                return;
            }

            if (command.kind === "execute") {
                const root = getWorkspaceRoot();
                if (!root) {
                    stream.markdown("No workspace folder found.");
                    return;
                }

                if (!command.previewId) {
                    stream.markdown("Execution requires a preview hash. Run `@choir.conductor preview [planId]`, then `@choir.conductor execute [planId] <previewHash>`." );
                    return;
                }

                try {
                    const result = await executeSelectedPlansWithPreviewGuard(controlPlane, {
                        root,
                        requestedPlanId: command.planId,
                        previewId: command.previewId,
                    });

                    const selected = result.selectedPlans.map((plan) => plan.id).join(", ");
                    const evaluated = result.costTrace.evaluatedPlans
                        .map((score) => {
                            const b = score.breakdown;
                            return `- ${score.planId}: total=${score.totalCost.toFixed(2)} (edit=${b.editCost}, files=${b.fileTouchCost}, risk=${b.riskCost}, dependency=${b.dependencyCost}, reduction=${b.violationReduction})`;
                        })
                        .join("\n");

                    const strategySummary = result.strategyTraces
                        .map((item) => {
                            const evaluatedStrategies = item.trace.evaluated
                                .map((entry) => `  - ${entry.strategyId}: cost=${entry.cost.toFixed(2)}, success=${entry.success}`)
                                .join("\n");

                            return [
                                `- ${item.basePlanId}: selected=${item.selectedStrategyId}`,
                                `  decision: ${item.trace.decision}`,
                                "  evaluated:",
                                evaluatedStrategies,
                            ].join("\n");
                        })
                        .join("\n");

                    const executionSummary = result.executionTraces
                        .map((trace) => [
                            `- ${trace.planId}:`,
                            `  tasks executed=${trace.tasksExecuted.length}, succeeded=${trace.tasksSucceeded.length}, failed=${trace.tasksFailed.length}`,
                        ].join("\n"))
                        .join("\n");

                    stream.markdown([
                        "▶️ Cost-based plan execution complete",
                        "",
                        `- Preview hash verified: ${result.previewHash}`,
                        `- Selected plans: ${selected}`,
                        `- Decision: ${result.costTrace.decision}`,
                        "",
                        "Evaluated plan scores:",
                        evaluated,
                        "",
                        "Strategy selection:",
                        strategySummary,
                        "",
                        "Execution summary:",
                        executionSummary,
                        "",
                        "Use @choir.conductor status for current execution state.",
                    ].join("\n"));
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    stream.markdown(message);
                }
                return;
            }

            if (command.kind === "preview") {
                const root = getWorkspaceRoot();
                if (!root) {
                    stream.markdown("No workspace folder found.");
                    return;
                }

                try {
                    const result = await generateSelectedPlanPreview(controlPlane, {
                        root,
                        requestedPlanId: command.planId,
                    });

                    const preview = result.preview;
                    const changeSummary = preview.fileChanges
                        .map((change) => [
                            `--- ${change.file}`,
                            "```diff",
                            change.diff,
                            "```",
                        ].join("\n"))
                        .join("\n\n");

                    const diagnostics = preview.diagnostics
                        .slice(0, 20)
                        .map((diagnostic) => `- [${diagnostic.ruleId}] ${diagnostic.message} (${diagnostic.location.file})`)
                        .join("\n");

                    stream.markdown([
                        `Plan: ${preview.planId}`,
                        `Strategy: ${preview.strategy?.strategyId ?? "n/a"} (cost: ${(preview.strategy?.cost ?? 0).toFixed(2)})`,
                        `Preview Hash: ${preview.hash}`,
                        "",
                        "Summary:",
                        `- ${preview.summary.totalFilesChanged} files will change`,
                        `- ${preview.summary.totalPatches} patches applied`,
                        `- ${preview.summary.totalDiagnosticsResolved} diagnostics resolved`,
                        "",
                        "Changes:",
                        changeSummary.length > 0 ? changeSummary : "- No file mutations proposed by simulation.",
                        "",
                        "Post-simulation diagnostics:",
                        diagnostics.length > 0 ? diagnostics : "- None",
                        "",
                        "Execute this exact preview:",
                        `- @choir.conductor execute ${command.planId ?? preview.planId} ${preview.hash}`,
                    ].join("\n"));
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    stream.markdown(message);
                }
                return;
            }

            if (command.kind === "status") {
                const root = getWorkspaceRoot();
                if (!root) {
                    stream.markdown("No workspace folder found.");
                    return;
                }

                const state = readStatePlane(root) ?? createEmptyStatePlane();
                const summary = summarizePlanStatus(controlPlane, state);

                if (summary.plans.length === 0) {
                    stream.markdown("No plans available. Create one with @choir.conductor plan");
                    return;
                }

                const lines = [
                    "## Choir Conductor Status",
                    summary.activePlanId ? `- Active plan: ${summary.activePlanId}` : "- Active plan: none",
                    "",
                ];

                for (const plan of summary.plans) {
                    lines.push(`- ${plan.planId} (${plan.status})`);
                    lines.push(`  ${plan.title}`);
                    lines.push(`  tasks=${plan.totalTasks}, pending=${plan.pending}, in-progress=${plan.inProgress}, complete=${plan.complete}, failed=${plan.failed}`);
                }

                stream.markdown(lines.join("\n"));
                return;
            }

            stream.markdown([
                "### Choir Conductor",
                "",
                "Commands:",
                "- plan",
                "- plan for goal: <goal>",
                "- approve <planId>",
                "- preview [planId]",
                "- execute [planId] <previewHash>",
                "- status",
            ].join("\n"));
        }
    );
}