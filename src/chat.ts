import * as vscode from "vscode";
import * as YAML from "yaml";
import { readStrategy, writeStrategy } from "./choirManager.js";
import { enforceStrategy, enforceCode } from "./enforcer.js";
import { analyzeWorkspace, findHotspots } from "./analyst.js";

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

            const strategy = readStrategy();
            if (!strategy) {
                stream.markdown("No strategy found. Run `Choir: Initialize Strategy`.");
                return;
            }

            // 📘 Show strategy
            if (message.includes("show") || message.includes("strategy")) {
                stream.markdown("```yaml\n" + YAML.stringify(strategy) + "\n```");
                return;
            }

            // 🎯 Add goal
            if (message.includes("add goal")) {
                const goal = raw.replace(/add goal/i, "").trim();
                strategy.project.goals.push(goal);
                writeStrategy(strategy);

                stream.markdown(`✅ Added goal: ${goal}`);
                return;
            }

            // 🚧 Add constraint
            if (message.includes("add constraint")) {
                const constraint = raw.replace(/add constraint/i, "").trim();
                strategy.constraints.push(constraint);
                writeStrategy(strategy);

                stream.markdown(`⚠️ Added constraint: ${constraint}`);
                return;
            }

            // 🏗 Add architecture layer
            if (message.includes("add layer")) {
                const layer = raw.replace(/add layer/i, "").trim();
                strategy.architecture.layers.push(layer);
                writeStrategy(strategy);

                stream.markdown(`🏗 Added layer: ${layer}`);
                return;
            }

            stream.markdown(`
### 🧠 Choir Architect

Try:
- "Show strategy"
- "Add goal: Build auth system"
- "Add constraint: no direct db access"
- "Add layer: service"
            `);
        }
    );
}

export function registerEnforcer(context: vscode.ExtensionContext) {
    registerParticipant(context, "choir.enforcer", "Choir Enforcer", async (request, context, stream) => {
        const userMessage = request.prompt;
        
        const result = enforceCode(userMessage);
        if (!result.ok) {
            stream.markdown(`⛔ Code blocked by enforcer:\n\n` + result.violations.map(v => `- ${v}`).join("\n"));
            return;
        }
        stream.markdown("✅ Code passed enforcement");

        const strategy = readStrategy();
        if (!strategy) {
            stream.markdown("No strategy found.");
            return;
        }

        const results = await enforceStrategy(strategy);
        stream.markdown(results.length ? results.join("\n") : "✅ Clean");
        
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