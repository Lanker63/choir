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
import {
    ChoirAgent,
    RouterRoleHandlers,
    RouterTrace,
    enforceCapabilities,
} from "./core/choirRouter.js";

type ChatParticipantHandler = Parameters<NonNullable<typeof vscode.chat.createChatParticipant>>[1];
type ChoirRoleContext = { stream: vscode.ChatResponseStream };

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

function emitRouterTrace(stream: vscode.ChatResponseStream, trace: RouterTrace): void {
    stream.markdown([
        "",
        "---",
        "Router trace:",
        `- intent: ${trace.intent}`,
        `- roles: ${trace.rolesInvoked.join(", ")}`,
        `- steps: ${trace.steps.join(" -> ")}`,
        `- decisions: ${trace.decisions.join(" | ")}`,
    ].join("\n"));
}

async function handleArchitectMessage(raw: string, stream: vscode.ChatResponseStream): Promise<void> {
    const message = raw.toLowerCase();

    const controlPlane = readControlPlane();
    if (!controlPlane) {
        stream.markdown("No control plane found. Open a workspace folder first.");
        return;
    }

    if (message.includes("show") || message.includes("control") || message.includes("strategy")) {
        stream.markdown("```yaml\n" + YAML.stringify(controlPlane) + "\n```");
        return;
    }

    const updated = applyChatToControlPlane(raw, controlPlane);
    const changed = JSON.stringify(updated) !== JSON.stringify(controlPlane);
    if (!changed) {
        stream.markdown([
            "### Choir Architect",
            "",
            "Try:",
            "- Show control plane",
            "- Set mission: Deliver secure and maintainable services",
            "- Set vision: Platform-level policy by default",
            "- Add non-goal: Build a generic workflow engine",
            "- Add non-goals: Distributed app, authentication, authorization",
            "- Remove non-goal: Build a generic workflow engine",
            "- Add goal: Build auth system",
            "- Add goals: Build auth system, create user administration",
            "- Add constraints: no database, no user administration",
            "- Add constraint: no direct db access",
            "- Remove goal: Build auth system",
            "- Remove constraint: no direct db access",
        ].join("\n"));
        return;
    }

    writeControlPlane(updated);

    const pipelineResult = await runPipelineForWorkspace({ controlPlane: updated });
    if (!pipelineResult) {
        stream.markdown("Control plane updated, but no workspace root is open for pipeline execution.");
        return;
    }

    stream.markdown(`Control plane updated and pipeline executed. Diagnostics: ${pipelineResult.diagnostics.length}`);
}

async function handleEnforcerMessage(stream: vscode.ChatResponseStream): Promise<void> {
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
        stream.markdown("Clean");
        return;
    }

    stream.markdown(
        "Pipeline reported diagnostics:\n\n" +
        result.diagnostics
            .map((diagnostic) => `- [${diagnostic.ruleId}] ${diagnostic.message} (${diagnostic.location.file})`)
            .join("\n")
    );
}

async function handleAnalystMessage(raw: string, stream: vscode.ChatResponseStream): Promise<void> {
    const message = raw.toLowerCase();

    if (message.includes("overview") || message.includes("summary")) {
        const summary = analyzeWorkspace();

        if (!summary) {
            stream.markdown("No workspace found.");
            return;
        }

        stream.markdown([
            "## Workspace Summary",
            "",
            `- Files: ${summary.totalFiles}`,
            `- Services: ${summary.services}`,
            `- Controllers: ${summary.controllers}`,
            `- Repositories: ${summary.repositories}`,
        ].join("\n"));
        return;
    }

    if (message.includes("hotspot") || message.includes("issues") || message.includes("violations")) {
        const hotspots = findHotspots();

        if (hotspots.length === 0) {
            stream.markdown("No major hotspots.");
            return;
        }

        stream.markdown("## Code Hotspots\n\n" + hotspots.join("\n"));
        return;
    }

    stream.markdown([
        "### Choir Analyst",
        "",
        "Try:",
        "- Workspace summary",
        "- Find hotspots",
    ].join("\n"));
}

async function handleAnalystStatus(stream: vscode.ChatResponseStream): Promise<void> {
    const summary = analyzeWorkspace();
    const hotspots = findHotspots();

    if (!summary) {
        stream.markdown("No workspace found.");
        return;
    }

    stream.markdown([
        "## Choir Status",
        "",
        `- Files: ${summary.totalFiles}`,
        `- Services: ${summary.services}`,
        `- Controllers: ${summary.controllers}`,
        `- Repositories: ${summary.repositories}`,
        `- Hotspots: ${hotspots.length}`,
    ].join("\n"));
}

async function handleConductorMessage(raw: string, stream: vscode.ChatResponseStream): Promise<void> {
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
            `Draft plan ${replaced ? "updated" : "created"}: ${plan.id}`,
            "",
            `- Title: ${plan.title}`,
            `- Status: ${plan.status}`,
            `- Tasks: ${plan.tasks.length}`,
            `- Dependencies: ${dependencyCount}`,
            "",
            "Next step: @choir approve <planId>",
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
        stream.markdown(`Plan approved: ${plan.id}`);
        return;
    }

    if (command.kind === "execute") {
        const root = getWorkspaceRoot();
        if (!root) {
            stream.markdown("No workspace folder found.");
            return;
        }

        if (!command.previewId) {
            stream.markdown("Execution requires a preview hash. Run `@choir preview [planId]`, then `@choir execute [planId] <previewHash>`.");
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
                        .map((entry) => `  - ${entry.strategyId}: remaining=${entry.metrics.remainingViolations}, introducedErrors=${entry.metrics.introducedErrors}, patches=${entry.metrics.patchesCount}, files=${entry.metrics.filesChanged}, success=${entry.success}`)
                        .join("\n");

                    return [
                        `- ${item.basePlanId}: selected=${item.selectedStrategyId}`,
                        `  decision: ${item.trace.decision}`,
                        "  evaluated:",
                        evaluatedStrategies,
                    ].join("\n");
                })
                .join("\n");

            const memorySummary = result.strategyTraces
                .map((item) => `- ${item.basePlanId}: matched=${item.memoryTrace.matchedEntries}, reused=${item.memoryTrace.reused}, fallback=${item.memoryTrace.fallbackToEvaluation}`)
                .join("\n");

            const executionSummary = result.executionTraces
                .map((trace) => [
                    `- ${trace.planId}:`,
                    `  tasks executed=${trace.tasksExecuted.length}, succeeded=${trace.tasksSucceeded.length}, failed=${trace.tasksFailed.length}`,
                ].join("\n"))
                .join("\n");

            stream.markdown([
                "Cost-based plan execution complete",
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
                "Strategy memory:",
                memorySummary,
                "",
                "Execution summary:",
                executionSummary,
                "",
                "Use @choir status for current execution state.",
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

            const strategyBlocks = preview.strategies
                .map((strategy) => {
                    const diffBlock = strategy.diff
                        .map((change) => [
                            `--- ${change.file}`,
                            "```diff",
                            change.diff,
                            "```",
                        ].join("\n"))
                        .join("\n\n");

                    return [
                        `### Strategy ${strategy.strategyId}`,
                        `- filesChanged=${strategy.summary.filesChanged}`,
                        `- patches=${strategy.summary.patches}`,
                        `- violationsRemaining=${strategy.summary.violationsRemaining}`,
                        "",
                        diffBlock.length > 0 ? diffBlock : "- No file mutations proposed.",
                    ].join("\n");
                })
                .join("\n\n");

            stream.markdown([
                `Plan: ${preview.planId}`,
                `Selected Strategy: ${preview.selectedStrategyId}`,
                `Preview Hash: ${preview.hash}`,
                "",
                `Strategy memory: matched=${result.strategyTrace.adaptive ? "0+fallback" : "reused"}`,
                "",
                "Evaluated strategies:",
                strategyBlocks,
                "",
                "Execute this exact preview:",
                `- @choir execute ${command.planId ?? preview.planId} ${preview.hash}`,
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
            stream.markdown("No plans available. Create one with @choir plan");
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
        "### Choir",
        "",
        "Commands:",
        "- plan",
        "- plan for goal: <goal>",
        "- approve <planId>",
        "- preview [planId]",
        "- execute [planId] <previewHash>",
        "- status",
        "",
        "Legacy aliases:",
        "- @choir.architect",
        "- @choir.analyst",
        "- @choir.enforcer",
        "- @choir.conductor",
    ].join("\n"));
}

function createRoleHandlers(): RouterRoleHandlers<ChoirRoleContext> {
    return {
        architect: {
            handle: async (input, context) => {
                enforceCapabilities("architect", "modify-yaml");
                await handleArchitectMessage(input, context.stream);
            },
        },
        analyst: {
            handle: async (input, context) => {
                enforceCapabilities("analyst", "read-state");
                await handleAnalystMessage(input, context.stream);
            },
            status: async (context) => {
                enforceCapabilities("analyst", "read-state");
                await handleAnalystStatus(context.stream);
            },
        },
        enforcer: {
            handle: async (_input, context) => {
                enforceCapabilities("enforcer", "modify-code");
                await handleEnforcerMessage(context.stream);
            },
        },
        conductor: {
            handle: async (input, context) => {
                enforceCapabilities("conductor", "schedule");
                await handleConductorMessage(input, context.stream);
            },
            plan: async (input, context) => {
                enforceCapabilities("conductor", "plan");
                await handleConductorMessage(input.toLowerCase().includes("plan") ? input : "plan", context.stream);
            },
            preview: async (input, context) => {
                enforceCapabilities("conductor", "schedule");
                await handleConductorMessage(input.toLowerCase().includes("preview") ? input : "preview", context.stream);
            },
            execute: async (input, context) => {
                enforceCapabilities("conductor", "schedule");
                await handleConductorMessage(input.toLowerCase().includes("execute") ? input : "execute", context.stream);
            },
        },
    };
}

export function registerChoir(context: vscode.ExtensionContext) {
    const handlers = createRoleHandlers();
    const agent = new ChoirAgent<ChoirRoleContext>(handlers);

    registerParticipant(
        context,
        "choir",
        "Choir",
        async (request, _ctx, stream) => {
            const raw = (request as any).prompt ?? "";
            const trace = await agent.handle(raw, { stream });
            emitRouterTrace(stream, trace);
        }
    );
}

export function registerArchitect(context: vscode.ExtensionContext) {
    const handlers = createRoleHandlers();
    registerParticipant(
        context,
        "choir.architect",
        "Choir Architect",
        async (request, _ctx, stream) => {
            const raw = (request as any).prompt ?? "";
            await handlers.architect.handle(raw, { stream });
        }
    );
}

export function registerEnforcer(context: vscode.ExtensionContext) {
    const handlers = createRoleHandlers();
    registerParticipant(context, "choir.enforcer", "Choir Enforcer", async (_request, _context, stream) => {
        await handlers.enforcer.handle("enforce", { stream });
    });
}

export function registerAnalyst(context: vscode.ExtensionContext) {
    const handlers = createRoleHandlers();
    registerParticipant(
        context,
        "choir.analyst",
        "Choir Analyst",
        async (request, _ctx, stream) => {
            const raw = (request as any).prompt ?? "";
            await handlers.analyst.handle(raw, { stream });
        }
    );
}

export function registerConductor(context: vscode.ExtensionContext) {
    const handlers = createRoleHandlers();
    registerParticipant(
        context,
        "choir.conductor",
        "Choir Conductor",
        async (request, _ctx, stream) => {
            const raw = (request as any).prompt ?? "";
            await handlers.conductor.handle(raw, { stream });
        }
    );
}
