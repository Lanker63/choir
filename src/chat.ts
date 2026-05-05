import * as vscode from "vscode";
import { getControlPlanePath, readControlPlane } from "./choirManager.js";
import {
    CompilationTrace,
    compileDSLAndWrite,
} from "./core/dslYamlCompiler.js";
import { CHOIR_DSL_GRAMMAR } from "./core/choirRouter.js";

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

            try {
                const compiled = compileDSLAndWrite(raw, control, controlPath, {
                    workspaceRoot: getWorkspaceRoot() ?? undefined,
                });

                if (!compiled.changed) {
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
