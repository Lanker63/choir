import * as vscode from "vscode";
import * as YAML from "yaml";
import { readControlPlane, writeControlPlane } from "./choirManager.js";
import { analyzeWorkspace, findHotspots } from "./analyst.js";
import { applyChatToControlPlane } from "./chatCompiler.js";
import { runPipelineForWorkspace } from "./enforcer.js";
import { approvePlan, executePlan, summarizePlanStatus, upsertDraftPlan } from "./conductor.js";
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
            const normalized = prompt.toLowerCase();

            const controlPlane = readControlPlane();
            if (!controlPlane) {
                stream.markdown("No control plane found. Open a workspace folder first.");
                return;
            }

            if (normalized.startsWith("plan")) {
                const root = getWorkspaceRoot();
                if (!root) {
                    stream.markdown("No workspace folder found.");
                    return;
                }

                const goalMatch = prompt.match(/plan\s+for\s+goal\s*:\s*(.+)$/i);
                const goal = goalMatch?.[1]?.trim();
                const state = readStatePlane(root) ?? createEmptyStatePlane();
                const { updatedControl, plan, replaced } = upsertDraftPlan(controlPlane, state, goal);

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

            if (normalized.startsWith("approve ")) {
                const planId = prompt.split(/\s+/)[1] ?? "";
                if (planId.length === 0) {
                    stream.markdown("Provide a plan id. Example: approve plan-abc123def456");
                    return;
                }

                const { updatedControl, plan } = approvePlan(controlPlane, planId);
                if (!plan) {
                    stream.markdown(`Plan not found: ${planId}`);
                    return;
                }

                writeControlPlane(updatedControl);
                stream.markdown(`✅ Plan approved: ${plan.id}`);
                return;
            }

            if (normalized.startsWith("execute ")) {
                const root = getWorkspaceRoot();
                if (!root) {
                    stream.markdown("No workspace folder found.");
                    return;
                }

                const planId = prompt.split(/\s+/)[1] ?? "";
                if (planId.length === 0) {
                    stream.markdown("Provide a plan id. Example: execute plan-abc123def456");
                    return;
                }

                const plan = controlPlane.execution.plans.find((candidate) => candidate.id === planId);
                if (!plan) {
                    stream.markdown(`Plan not found: ${planId}`);
                    return;
                }

                if (plan.status !== "approved") {
                    stream.markdown(`Plan ${plan.id} is ${plan.status}. Approve it before execution.`);
                    return;
                }

                const execution = await executePlan(plan, {
                    controlPlane,
                    root,
                });

                stream.markdown([
                    `▶️ Plan executed: ${plan.id}`,
                    "",
                    `- Tasks executed: ${execution.trace.tasksExecuted.length}`,
                    `- Tasks succeeded: ${execution.trace.tasksSucceeded.length}`,
                    `- Tasks failed: ${execution.trace.tasksFailed.length}`,
                    "",
                    "Use @choir.conductor status for current execution state.",
                ].join("\n"));
                return;
            }

            if (normalized === "status") {
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
                "- execute <planId>",
                "- status",
            ].join("\n"));
        }
    );
}