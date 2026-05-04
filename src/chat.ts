import * as vscode from "vscode";
import * as YAML from "yaml";
import { readControlPlane, writeControlPlane } from "./choirManager.js";
import { analyzeWorkspace, findHotspots } from "./analyst.js";
import { applyChatToControlPlane } from "./chatCompiler.js";
import { runPipelineForWorkspace } from "./enforcer.js";

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
- "Add goal: Build auth system"
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
                `✅ Control plane updated and pipeline executed. Violations: ${pipelineResult.violations.length}`
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

        if (result.violations.length === 0) {
            stream.markdown("✅ Clean");
            return;
        }

        stream.markdown(
            "⛔ Pipeline reported violations:\n\n" +
            result.violations.map((violation) => `- [${violation.ruleId}] ${violation.message} (${violation.file})`).join("\n")
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