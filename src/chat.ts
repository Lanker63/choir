import * as vscode from "vscode";
import fs from "fs";
import path from "path";
import { getControlPlanePath, readControlPlane } from "./choirManager.js";
import {
    exportReport,
    generateReport,
    queryAudit,
} from "./core/audit.js";
import {
    approveDiff,
    CompilationTrace,
    compileDSLAndWrite,
    controlPlaneToChoirConfig,
    policyStatus,
    rejectDiff,
} from "./core/dslYamlCompiler.js";
import { CHOIR_DSL_GRAMMAR, parseCommand } from "./core/choirRouter.js";
import { getMacro, listMacros, runMacro } from "./core/macros.js";
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
        "- choir macro list",
        "- choir macro show <macroId>",
        "- choir macro <macroId> entity=\"service\"",
        "- choir approve <diffId>",
        "- choir reject <diffId>",
        "- choir policy status",
        "- choir audit log",
        "- choir audit report",
        "- choir audit query role=architect",
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
                    || action.type === "audit-log"
                    || action.type === "audit-report"
                    || action.type === "audit-query"
                    || action.type === "macro-list"
                    || action.type === "macro-show"
                    || action.type === "macro-run"
                )
            ) {
                stream.markdown("Invalid Choir DSL command. `export|approve|reject|policy status|audit|macro` cannot be chained with `then`.");
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
                if (parsed.ast.type === "macro-list") {
                    const macros = listMacros(workspaceRoot);
                    if (macros.length === 0) {
                        stream.markdown("No macros found. Create `.choir/macros.yaml` with a `macros:` list.");
                        return;
                    }

                    const lines = macros.map((macro) => {
                        const details = [
                            macro.version ? `v${macro.version}` : undefined,
                            macro.description,
                        ].filter((value) => typeof value === "string" && value.length > 0).join(" - ");

                        return details.length > 0
                            ? `- ${macro.id}: ${details}`
                            : `- ${macro.id}`;
                    });

                    stream.markdown([
                        `Macros (${macros.length}):`,
                        ...lines,
                    ].join("\n"));
                    return;
                }

                if (parsed.ast.type === "macro-show") {
                    const macro = getMacro(workspaceRoot, parsed.ast.macroId);
                    const parameterLines = (macro.parameters ?? []).length === 0
                        ? ["- none"]
                        : (macro.parameters ?? []).map((parameter) => {
                            const defaultValue = parameter.default ? ` default=\"${parameter.default}\"` : "";
                            return `- ${parameter.name} (required=${parameter.required})${defaultValue}`;
                        });

                    const bodyLines = macro.body.map((line) => `- ${line}`);

                    stream.markdown([
                        `Macro: ${macro.id}`,
                        macro.version ? `- version: ${macro.version}` : "",
                        macro.description ? `- description: ${macro.description}` : "",
                        "",
                        "Parameters:",
                        ...parameterLines,
                        "",
                        "Body:",
                        ...bodyLines,
                    ].filter((line) => line.length > 0).join("\n"));
                    return;
                }

                if (parsed.ast.type === "macro-run") {
                    const executed = runMacro(
                        workspaceRoot,
                        parsed.ast.macroId,
                        parsed.ast.args,
                        control,
                        controlPath,
                        { workspaceRoot }
                    );

                    const stepLines = executed.steps.length === 0
                        ? ["- none"]
                        : executed.steps.map((step, index) => {
                            const detail = [
                                `decision=${step.decision}`,
                                `changed=${step.changed}`,
                                step.diffHash ? `diffHash=${step.diffHash}` : "",
                                step.pendingApprovalId ? `pending=${step.pendingApprovalId}` : "",
                            ].filter((part) => part.length > 0).join(", ");

                            return `- ${index + 1}. ${step.command} (${detail})`;
                        });

                    stream.markdown([
                        `Macro executed: ${parsed.ast.macroId}`,
                        `- decision: ${executed.decision}`,
                        `- expandedCommands: ${executed.trace.expandedCommands.length}`,
                        `- executedSteps: ${executed.trace.executedSteps}`,
                        "",
                        "Step results:",
                        ...stepLines,
                    ].join("\n"));
                    return;
                }

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

                if (parsed.ast.type === "audit-log") {
                    const records = queryAudit(workspaceRoot, {});
                    if (records.length === 0) {
                        stream.markdown("Audit log is empty.");
                        return;
                    }

                    const recent = records.slice(-20);
                    const lines = recent.map((record) => {
                        const event = record.auditEvent;
                        return `- ${event.timestamp} | ${event.actor.role} | ${event.action} | ${event.result}`;
                    });

                    stream.markdown([
                        `Audit log (${records.length} total events):`,
                        ...lines,
                    ].join("\n"));
                    return;
                }

                if (parsed.ast.type === "audit-query") {
                    const role = parsed.ast.filters.role;
                    const environment = parsed.ast.filters.environment;
                    const action = parsed.ast.filters.action;
                    const from = parsed.ast.filters.from;
                    const to = parsed.ast.filters.to;

                    if (role && role !== "architect" && role !== "analyst" && role !== "conductor" && role !== "enforcer") {
                        stream.markdown(`Invalid audit query role: ${role}`);
                        return;
                    }

                    if (environment && environment !== "local" && environment !== "ci" && environment !== "staging" && environment !== "production") {
                        stream.markdown(`Invalid audit query environment: ${environment}`);
                        return;
                    }

                    if ((from && !to) || (!from && to)) {
                        stream.markdown("Audit query requires both `from` and `to` when filtering by time range.");
                        return;
                    }

                    const roleFilter = role === "architect" || role === "analyst" || role === "conductor" || role === "enforcer"
                        ? role
                        : undefined;

                    const environmentFilter = environment === "local"
                        || environment === "ci"
                        || environment === "staging"
                        || environment === "production"
                        ? environment
                        : undefined;

                    const records = queryAudit(workspaceRoot, {
                        ...(roleFilter ? { role: roleFilter } : {}),
                        ...(environmentFilter ? { environment: environmentFilter } : {}),
                        ...(action ? { action } : {}),
                        ...(from && to ? { timeRange: [from, to] as [string, string] } : {}),
                    });

                    if (records.length === 0) {
                        stream.markdown("Audit query matched 0 records.");
                        return;
                    }

                    const lines = records.slice(-20).map((record) => {
                        const event = record.auditEvent;
                        return `- ${event.timestamp} | ${event.actor.role} | ${event.action} | ${record.decisionTrace.finalDecision}`;
                    });

                    stream.markdown([
                        `Audit query matched ${records.length} record(s):`,
                        ...lines,
                    ].join("\n"));
                    return;
                }

                if (parsed.ast.type === "audit-report") {
                    const report = generateReport(workspaceRoot, {});
                    const reportsDir = path.join(workspaceRoot, ".choir", "reports");
                    fs.mkdirSync(reportsDir, { recursive: true });

                    const jsonPath = path.join(reportsDir, "compliance-report.json");
                    const yamlPath = path.join(reportsDir, "compliance-report.yaml");
                    const pdfPath = path.join(reportsDir, "compliance-report.pdf");

                    fs.writeFileSync(jsonPath, exportReport(report, "json"), "utf-8");
                    fs.writeFileSync(yamlPath, exportReport(report, "yaml"), "utf-8");
                    fs.writeFileSync(pdfPath, exportReport(report, "pdf"), "binary");

                    const recent = report.records.slice(-3).map((record) => {
                        const event = record.auditEvent;
                        return `- ${event.actor.role} ${event.action} -> ${record.decisionTrace.finalDecision}`;
                    });

                    stream.markdown([
                        "Audit Report:",
                        "",
                        `Total Events: ${report.summary.totalEvents}`,
                        `Approvals Required: ${report.summary.approvalsRequired}`,
                        `Denied: ${report.summary.denials}`,
                        `Violations: ${report.findings.violations}`,
                        `Anomalies: ${report.findings.anomalies}`,
                        "",
                        "Recent Activity:",
                        ...(recent.length > 0 ? recent : ["- none"]),
                        "",
                        "Exported:",
                        "- .choir/reports/compliance-report.json",
                        "- .choir/reports/compliance-report.yaml",
                        "- .choir/reports/compliance-report.pdf",
                    ].join("\n"));
                    return;
                }

                const compiled = compileDSLAndWrite(raw, control, controlPath, {
                    workspaceRoot,
                    actorId: "chat-user",
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
