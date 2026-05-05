import * as vscode from "vscode";
import path from "path";
import { getControlPlanePath, readControlPlane } from "./choirManager.js";
import {
    approveDiff,
    CompilationTrace,
    compileDSLAndWrite,
    controlPlaneToChoirConfig,
    policyStatus,
    rejectDiff,
} from "./core/dslYamlCompiler.js";
import { CHOIR_DSL_GRAMMAR, parseCommand } from "./core/choirRouter.js";
import {
    formatDSL,
    generateDSL,
    validateRoundTrip,
    writeDSL,
} from "./core/yamlDslGenerator.js";

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

function renderTrace(stream: vscode.ChatResponseStream, trace: CompilationTrace): void {
    const astJson = JSON.stringify(trace.ast, null, 2);

    const changeLines = trace.changes.length === 0
        ? ["- none"]
        : trace.changes.map((change) => {
            const before = JSON.stringify(change.before);
            const after = JSON.stringify(change.after);
            return `- ${change.field}: ${before} -> ${after}`;
        });

    stream.markdown([
        "",
        "---",
        "Compilation trace:",
        `- input: ${trace.input}`,
        "- changes:",
        ...changeLines,
        "- ast:",
        "```json",
        astJson,
        "```",
    ].join("\n"));
}

function renderGrammarHelp(stream: vscode.ChatResponseStream): void {
    stream.markdown([
        "Choir DSL required.",
        "",
        "Grammar:",
        "```bnf",
        CHOIR_DSL_GRAMMAR,
        "```",
        "Examples:",
        "- choir define goal \"enforce service boundaries\"",
        "- choir define goal \"A\" then define constraint \"B\"",
        "- choir plan for \"service boundaries\"",
        "- choir export dsl",
        "- choir export dsl intent",
        "- choir approve <diffId>",
        "- choir reject <diffId>",
        "- choir policy status",
    ].join("\n"));
}

export function registerChoir(context: vscode.ExtensionContext) {
    registerParticipant(
        context,
        "choir",
        "Choir",
        async (request, _ctx, stream) => {
            const raw = String((request as { prompt?: string }).prompt ?? "").trim();
            if (raw.length === 0) {
                renderGrammarHelp(stream);
                return;
            }

            let parsed;
            try {
                parsed = parseCommand(raw);
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
                return;
            }

            if (
                parsed.ast.type === "sequence"
                && parsed.ast.actions.some((action) =>
                    action.type === "export"
                    || action.type === "approve"
                    || action.type === "reject"
                    || action.type === "policy-status"
                )
            ) {
                stream.markdown("Invalid Choir DSL command. `export|approve|reject|policy status` cannot be chained with `then`.");
                return;
            }

            const control = readControlPlane();
            if (!control) {
                stream.markdown("No control plane found. Open a workspace folder first.");
                return;
            }

            const controlPath = getControlPlanePath();
            if (!controlPath) {
                stream.markdown("Unable to resolve .choir/choir.config.yaml.");
                return;
            }

            const workspaceRoot = getWorkspaceRoot();
            if (!workspaceRoot) {
                stream.markdown("No workspace folder found.");
                return;
            }

            try {
                if (parsed.ast.type === "export") {
                    const section = parsed.ast.section;
                    const config = controlPlaneToChoirConfig(control);
                    const generated = generateDSL(config, { section });
                    const dslText = formatDSL(generated.script);
                    const roundTrip = validateRoundTrip(config, { section });

                    const root = path.dirname(controlPath);
                    const fileName = section === "all" ? "choir.dsl" : `choir.${section}.dsl`;
                    const outputPath = path.join(root, fileName);
                    writeDSL(generated.script, outputPath);

                    const warningLines = generated.trace.warnings.length === 0
                        ? ["- none"]
                        : generated.trace.warnings.map((warning) => `- ${warning}`);

                    stream.markdown([
                        `DSL exported to .choir/${fileName}`,
                        "",
                        "```text",
                        dslText.length > 0 ? dslText : "",
                        "```",
                        "",
                        "Export trace:",
                        `- generatedCommands: ${generated.trace.generatedCommands}`,
                        `- sections: ${generated.trace.sections.join(", ")}`,
                        `- roundTripStable: ${roundTrip.stable}`,
                        "- warnings:",
                        ...warningLines,
                    ].join("\n"));

                    return;
                }

                if (parsed.ast.type === "approve") {
                    const approved = approveDiff(workspaceRoot, parsed.ast.diffId, "chat-user");
                    if (!approved.approved) {
                        stream.markdown(`Pending diff not found: ${parsed.ast.diffId}`);
                        return;
                    }

                    stream.markdown([
                        `Approved diff: ${parsed.ast.diffId}`,
                        approved.diffHash ? `- diffHash: ${approved.diffHash}` : "",
                        "Re-run the original DSL command to apply the now-approved YAML diff.",
                    ].filter((line) => line.length > 0).join("\n"));
                    return;
                }

                if (parsed.ast.type === "reject") {
                    const rejected = rejectDiff(workspaceRoot, parsed.ast.diffId);
                    stream.markdown(rejected.removed
                        ? `Rejected pending diff: ${parsed.ast.diffId}`
                        : `Pending diff not found: ${parsed.ast.diffId}`);
                    return;
                }

                if (parsed.ast.type === "policy-status") {
                    const status = policyStatus(workspaceRoot);
                    if (status.pending.length === 0) {
                        stream.markdown("Policy status: no pending approvals.");
                        return;
                    }

                    const pendingLines = status.pending
                        .map((entry) => `- ${entry.id}: ${entry.command}`)
                        .join("\n");

                    stream.markdown([
                        "Policy status:",
                        `- pendingApprovals: ${status.pending.length}`,
                        "",
                        pendingLines,
                    ].join("\n"));
                    return;
                }

                const compiled = compileDSLAndWrite(raw, control, controlPath, {
                    workspaceRoot,
                });

                if (compiled.decision === "deny") {
                    const violations = compiled.policyResult?.violations ?? [];
                    const details = violations.map((item) => `- [${item.ruleId}] ${item.message}`).join("\n");
                    stream.markdown([
                        "Policy violation. YAML mutation denied.",
                        "",
                        details.length > 0 ? details : "- denied by policy",
                    ].join("\n"));
                    return;
                }

                if (compiled.decision === "require-approval") {
                    stream.markdown([
                        "Policy approval required. YAML was not mutated.",
                        compiled.pendingApprovalId ? `- diffId: ${compiled.pendingApprovalId}` : "",
                        compiled.diffHash ? `- diffHash: ${compiled.diffHash}` : "",
                        "Approve with: choir approve <diffId>",
                        "Reject with: choir reject <diffId>",
                    ].filter((line) => line.length > 0).join("\n"));
                    renderTrace(stream, compiled.trace);
                    return;
                }

                if (!compiled.changed || compiled.decision === "no-change") {
                    stream.markdown("No changes. YAML already reflects this DSL command.");
                } else {
                    stream.markdown("YAML updated successfully: .choir/choir.config.yaml");
                }

                renderTrace(stream, compiled.trace);
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
