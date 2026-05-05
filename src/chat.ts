import * as vscode from "vscode";
import { readControlPlane, writeControlPlane } from "./choirManager.js";
import { analyzeWorkspace, findHotspots } from "./analyst.js";
import { runPipelineForWorkspace } from "./enforcer.js";
import {
    approvePlan,
    executeSelectedPlansWithPreviewGuard,
    generateSelectedPlanPreview,
    upsertDraftPlan,
} from "./conductor.js";
import { createEmptyStatePlane, readStatePlane } from "./core/state.js";
import {
    AnalyzeNode,
    CHOIR_DSL_GRAMMAR,
    ChoirAgent,
    DefineNode,
    ExecuteNode,
    PlanNode,
    PreviewNode,
    RouterRoleHandlers,
    RouterTrace,
    enforceCapabilities,
} from "./core/choirRouter.js";
import { ControlPlane } from "./schema.js";

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
    const astJson = JSON.stringify(trace.dslTrace.ast, null, 2);
    const tokenSummary = trace.dslTrace.tokens.map((token) => `${token.type}:${token.value}`).join(", ");

    stream.markdown([
        "",
        "---",
        "DSL trace:",
        `- input: ${trace.dslTrace.input}`,
        `- tokens: ${tokenSummary.length > 0 ? tokenSummary : "(none)"}`,
        `- compiledAction: ${trace.dslTrace.compiledAction}`,
        `- intent: ${trace.intent}`,
        `- roles: ${trace.rolesInvoked.join(", ")}`,
        `- steps: ${trace.steps.join(" -> ")}`,
        `- decisions: ${trace.decisions.join(" | ")}`,
        "- ast:",
        "```json",
        astJson,
        "```",
    ].join("\n"));
}

function appendUnique(items: string[], value: string): string[] {
    if (items.includes(value)) {
        return items;
    }

    return [...items, value];
}

function applyDefine(control: ControlPlane, node: DefineNode): ControlPlane {
    if (node.defineType === "goal") {
        return {
            ...control,
            intent: {
                ...control.intent,
                goals: appendUnique(control.intent.goals, node.value),
            },
        };
    }

    if (node.defineType === "constraint") {
        return {
            ...control,
            intent: {
                ...control.intent,
                constraints: appendUnique(control.intent.constraints, node.value),
            },
        };
    }

    return {
        ...control,
        intent: {
            ...control.intent,
            "non-goals": appendUnique(control.intent["non-goals"], node.value),
        },
    };
}

async function handleArchitectDefine(node: DefineNode, stream: vscode.ChatResponseStream): Promise<void> {
    const controlPlane = readControlPlane();
    if (!controlPlane) {
        stream.markdown("No control plane found. Open a workspace folder first.");
        return;
    }

    const updatedControl = applyDefine(controlPlane, node);
    const changed = JSON.stringify(updatedControl) !== JSON.stringify(controlPlane);

    if (!changed) {
        stream.markdown(`No changes. ${node.defineType} already contains: \"${node.value}\"`);
        return;
    }

    writeControlPlane(updatedControl);

    const pipelineResult = await runPipelineForWorkspace({ controlPlane: updatedControl });
    if (!pipelineResult) {
        stream.markdown("Control plane updated, but no workspace root is open for pipeline execution.");
        return;
    }

    stream.markdown([
        `Defined ${node.defineType}: \"${node.value}\"`,
        `Diagnostics: ${pipelineResult.diagnostics.length}`,
    ].join("\n"));
}

async function renderWorkspaceSummary(stream: vscode.ChatResponseStream): Promise<void> {
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
}

async function renderViolations(stream: vscode.ChatResponseStream): Promise<void> {
    const controlPlane = readControlPlane();
    if (!controlPlane) {
        stream.markdown("No control plane found.");
        return;
    }

    const result = await runPipelineForWorkspace({ controlPlane });
    if (!result) {
        stream.markdown("No workspace folder found.");
        return;
    }

    if (result.diagnostics.length === 0) {
        stream.markdown("No violations.");
        return;
    }

    stream.markdown(
        "## Violations\n\n" +
        result.diagnostics
            .map((diagnostic) => `- [${diagnostic.ruleId}] ${diagnostic.message} (${diagnostic.location.file})`)
            .join("\n")
    );
}

async function renderHotspots(stream: vscode.ChatResponseStream): Promise<void> {
    const hotspots = findHotspots();
    if (hotspots.length === 0) {
        stream.markdown("No major hotspots.");
        return;
    }

    stream.markdown("## Code Hotspots\n\n" + hotspots.join("\n"));
}

async function handleAnalystAnalyze(node: AnalyzeNode, stream: vscode.ChatResponseStream): Promise<void> {
    if (node.target === "workspace") {
        await renderWorkspaceSummary(stream);
        return;
    }

    if (node.target === "violations") {
        await renderViolations(stream);
        return;
    }

    await renderHotspots(stream);
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

async function handleConductorPlan(node: PlanNode, stream: vscode.ChatResponseStream): Promise<void> {
    const controlPlane = readControlPlane();
    if (!controlPlane) {
        stream.markdown("No control plane found. Open a workspace folder first.");
        return;
    }

    const root = getWorkspaceRoot();
    if (!root) {
        stream.markdown("No workspace folder found.");
        return;
    }

    const state = readStatePlane(root) ?? createEmptyStatePlane();
    const { updatedControl, plan, replaced } = upsertDraftPlan(controlPlane, state, node.target);
    const approved = approvePlan(updatedControl, plan.id);
    if (!approved.plan) {
        stream.markdown(`Plan not found after synthesis: ${plan.id}`);
        return;
    }

    writeControlPlane(approved.updatedControl);

    const dependencyCount = approved.plan.tasks.reduce((sum, task) => sum + (task.dependsOn?.length ?? 0), 0);
    stream.markdown([
        `Plan ${replaced ? "updated" : "created"} and approved: ${approved.plan.id}`,
        "",
        `- Title: ${approved.plan.title}`,
        `- Status: ${approved.plan.status}`,
        `- Tasks: ${approved.plan.tasks.length}`,
        `- Dependencies: ${dependencyCount}`,
        "",
        "Next step: choir preview",
    ].join("\n"));
}

async function handleConductorPreview(node: PreviewNode, stream: vscode.ChatResponseStream): Promise<void> {
    const controlPlane = readControlPlane();
    if (!controlPlane) {
        stream.markdown("No control plane found. Open a workspace folder first.");
        return;
    }

    const root = getWorkspaceRoot();
    if (!root) {
        stream.markdown("No workspace folder found.");
        return;
    }

    try {
        const result = await generateSelectedPlanPreview(controlPlane, {
            root,
            requestedPlanId: node.planRef?.identifier,
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

        const executeCommand = node.planRef
            ? `choir execute plan ${node.planRef.identifier}`
            : "choir execute";

        stream.markdown([
            `Plan: ${preview.planId}`,
            `Selected Strategy: ${preview.selectedStrategyId}`,
            `Preview Hash: ${preview.hash}`,
            "",
            "Evaluated strategies:",
            strategyBlocks,
            "",
            "Execute this approved preview:",
            `- ${executeCommand}`,
        ].join("\n"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stream.markdown(message);
    }
}

async function handleConductorExecute(node: ExecuteNode, stream: vscode.ChatResponseStream): Promise<void> {
    const controlPlane = readControlPlane();
    if (!controlPlane) {
        stream.markdown("No control plane found. Open a workspace folder first.");
        return;
    }

    const root = getWorkspaceRoot();
    if (!root) {
        stream.markdown("No workspace folder found.");
        return;
    }

    const state = readStatePlane(root) ?? createEmptyStatePlane();
    const approvedPreview = state.execution.lastPreview;
    if (!approvedPreview?.hash) {
        stream.markdown("Execution requires an approved preview. Run: choir preview [plan <id>] first.");
        return;
    }

    const requestedPlanId = node.planRef?.identifier;
    if (requestedPlanId && requestedPlanId !== approvedPreview.planId) {
        stream.markdown(
            `Preview hash was generated for ${approvedPreview.planId}. Run choir preview plan ${requestedPlanId} before execute.`
        );
        return;
    }

    try {
        const result = await executeSelectedPlansWithPreviewGuard(controlPlane, {
            root,
            requestedPlanId,
            previewId: approvedPreview.hash,
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
            "Use choir status for current execution state.",
        ].join("\n"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stream.markdown(message);
    }
}

function createRoleHandlers(): RouterRoleHandlers<ChoirRoleContext> {
    return {
        architect: {
            define: async (node, context) => {
                enforceCapabilities("architect", "modify-yaml");
                await handleArchitectDefine(node, context.stream);
            },
        },
        analyst: {
            analyze: async (node, context) => {
                enforceCapabilities("analyst", "read-state");
                await handleAnalystAnalyze(node, context.stream);
            },
            status: async (context) => {
                enforceCapabilities("analyst", "read-state");
                await handleAnalystStatus(context.stream);
            },
        },
        conductor: {
            plan: async (node, context) => {
                enforceCapabilities("conductor", "plan");
                await handleConductorPlan(node, context.stream);
            },
            preview: async (node, context) => {
                enforceCapabilities("conductor", "schedule");
                await handleConductorPreview(node, context.stream);
            },
            execute: async (node, context) => {
                enforceCapabilities("conductor", "schedule");
                await handleConductorExecute(node, context.stream);
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
            const raw = String((request as { prompt?: string }).prompt ?? "").trim();
            if (raw.length === 0) {
                stream.markdown([
                    "Choir DSL required.",
                    "",
                    "Grammar:",
                    "```bnf",
                    CHOIR_DSL_GRAMMAR,
                    "```",
                    "Examples:",
                    "- choir define goal \"enforce service boundaries\"",
                    "- choir analyze workspace",
                    "- choir plan for \"service boundaries\" then preview then execute",
                ].join("\n"));
                return;
            }

            try {
                const trace = await agent.handle(raw, { stream });
                emitRouterTrace(stream, trace);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                stream.markdown([
                    "Invalid Choir DSL command.",
                    "",
                    `Error: ${message}`,
                    "",
                    "Grammar:",
                    "```bnf",
                    CHOIR_DSL_GRAMMAR,
                    "```",
                ].join("\n"));
            }
        }
    );
}
