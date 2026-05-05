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
    installLibrary,
    listMacroLibraryCatalog,
    loadMacroLibrary,
    lockLibraries,
    readMacroLock,
    updateLibrary,
} from "./core/macroLibraries.js";
import {
    approveDiff,
    CompilationTrace,
    compileDSLAndWrite,
    controlPlaneToChoirConfig,
    policyStatus,
    rejectDiff,
} from "./core/dslYamlCompiler.js";
import {
    formatAbstractionRunResult,
    getAbstraction,
    listAbstractions,
    runAbstraction,
} from "./core/abstractions.js";
import { formatCIRunResult, runCI } from "./core/ci.js";
import { CHOIR_DSL_GRAMMAR, parseCommand } from "./core/choirRouter.js";
import { getMacro, listMacros, runMacro } from "./core/macros.js";
import { detectEnvironment } from "./core/policyEngine.js";
import {
    formatDSL,
    generateDSL,
    validateRoundTrip,
    writeDSL,
} from "./core/yamlDslGenerator.js";

type ChatParticipantHandler = Parameters<NonNullable<typeof vscode.chat.createChatParticipant>>[1];

type AbstractionChatCommand =
    | { type: "list" }
    | { type: "describe"; id: string }
    | { type: "run"; id: string };

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
        "- choir import core@1.0.x",
        "- choir library list",
        "- choir library install core@1.0.0",
        "- choir library update core",
        "- choir library lock",
        "- choir ci run",
        "- choir bootstrap-service name=\"user-service\"",
        "- choir approve <diffId>",
        "- choir reject <diffId>",
        "- choir policy status",
        "- choir audit log",
        "- choir audit report",
        "- choir audit query role=architect",
        "",
        "Abstraction shortcuts:",
        "- @choir list abstractions",
        "- @choir describe <abstraction>",
        "- @choir run <abstraction>",
    ].join("\n"));
}

function parseAbstractionChatCommand(input: string): AbstractionChatCommand | null {
    const normalized = input.trim();

    if (/^@choir\s+list\s+abstractions\s*$/i.test(normalized)) {
        return { type: "list" };
    }

    const describe = normalized.match(/^@choir\s+describe\s+([a-zA-Z0-9._-]+)\s*$/i);
    if (describe) {
        return { type: "describe", id: describe[1] as string };
    }

    const run = normalized.match(/^@choir\s+run\s+([a-zA-Z0-9._-]+)\s*$/i);
    if (run) {
        return { type: "run", id: run[1] as string };
    }

    return null;
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

            const abstractionChatCommand = parseAbstractionChatCommand(raw);
            if (abstractionChatCommand) {
                const workspaceRoot = getWorkspaceRoot();
                if (!workspaceRoot) {
                    stream.markdown("No workspace folder found.");
                    return;
                }
                try {
                    if (abstractionChatCommand.type === "list") {
                        const abstractions = listAbstractions(workspaceRoot);
                        if (abstractions.length === 0) {
                            stream.markdown("No abstractions found in `.choir/abstractions.yaml`.");
                            return;
                        }

                        const lines = abstractions.map((abstraction) => `- ${abstraction.id}@${abstraction.version}: ${abstraction.description}`);
                        stream.markdown([
                            `Abstractions (${abstractions.length}):`,
                            ...lines,
                        ].join("\n"));
                        return;
                    }

                    if (abstractionChatCommand.type === "describe") {
                        const abstraction = getAbstraction(workspaceRoot, abstractionChatCommand.id);
                        const parameterLines = (abstraction.parameters ?? []).length === 0
                            ? ["- none"]
                            : (abstraction.parameters ?? []).map((parameter) => {
                                const defaultValue = typeof parameter.default === "string" ? ` default=\"${parameter.default}\"` : "";
                                return `- ${parameter.name} (required=${parameter.required})${defaultValue}`;
                            });

                        const stepLines = abstraction.expandsTo.map((command, index) => `${index + 1}. ${command}`);

                        stream.markdown([
                            `Abstraction: ${abstraction.id}`,
                            `- version: ${abstraction.version}`,
                            `- description: ${abstraction.description}`,
                            "",
                            "Parameters:",
                            ...parameterLines,
                            "",
                            "Steps:",
                            ...stepLines,
                        ].join("\n"));
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

                    const executed = runAbstraction(
                        workspaceRoot,
                        abstractionChatCommand.id,
                        {},
                        control,
                        controlPath,
                        {
                            workspaceRoot,
                            actorId: "chat-user",
                            executionMode: "interactive",
                        }
                    );

                    stream.markdown(formatAbstractionRunResult(executed));
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    stream.markdown(`Abstraction command failed: ${message}`);
                }
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
                    || action.type === "import-library"
                    || action.type === "library-list"
                    || action.type === "library-install"
                    || action.type === "library-update"
                    || action.type === "library-lock"
                    || action.type === "ci-run"
                    || action.type === "abstraction-run"
                    || action.type === "audit-log"
                    || action.type === "audit-report"
                    || action.type === "audit-query"
                    || action.type === "macro-list"
                    || action.type === "macro-show"
                    || action.type === "macro-run"
                )
            ) {
                stream.markdown("Invalid Choir DSL command. `export|approve|reject|policy status|import|library|ci|abstraction|audit|macro` cannot be chained with `then`.");
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
                    const localMacros = listMacros(workspaceRoot);
                    const lock = readMacroLock(workspaceRoot);
                    const lockedLibraryEntries = Object.entries(lock.libraries)
                        .sort(([left], [right]) => left.localeCompare(right));

                    const libraryMacroLines = lockedLibraryEntries.flatMap(([library, version]) => {
                        const loaded = loadMacroLibrary(workspaceRoot, library, version);
                        return loaded.macros.map((macro) => {
                            const details = [
                                `v${version}`,
                                macro.description,
                            ].filter((value) => typeof value === "string" && value.length > 0).join(" - ");

                            return details.length > 0
                                ? `- ${library}.${macro.id}: ${details}`
                                : `- ${library}.${macro.id}`;
                        });
                    });

                    const localMacroLines = localMacros.map((macro) => {
                        const details = [
                            macro.version ? `v${macro.version}` : undefined,
                            macro.description,
                        ].filter((value) => typeof value === "string" && value.length > 0).join(" - ");

                        return details.length > 0
                            ? `- local.${macro.id}: ${details}`
                            : `- local.${macro.id}`;
                    });

                    const lines = [
                        ...libraryMacroLines,
                        ...localMacroLines,
                    ];

                    if (lines.length === 0) {
                        stream.markdown("No macros found. Install a library or create `.choir/macros.yaml`.");
                        return;
                    }

                    stream.markdown([
                        `Macros (${lines.length}):`,
                        ...lines,
                    ].join("\n"));
                    return;
                }

                if (parsed.ast.type === "import-library") {
                    const spec = `${parsed.ast.library}@${parsed.ast.versionSelector}`;
                    const installed = installLibrary(workspaceRoot, spec);
                    stream.markdown([
                        `Library imported: ${installed.library}`,
                        `- requested: ${installed.requested}`,
                        `- resolved: ${installed.resolvedVersion}`,
                        "- lockfile: .choir/lock.yaml",
                    ].join("\n"));
                    return;
                }

                if (parsed.ast.type === "library-install") {
                    const spec = `${parsed.ast.library}@${parsed.ast.versionSelector}`;
                    const installed = installLibrary(workspaceRoot, spec);
                    stream.markdown([
                        `Library installed: ${installed.library}`,
                        `- requested: ${installed.requested}`,
                        `- resolved: ${installed.resolvedVersion}`,
                        "- lockfile: .choir/lock.yaml",
                    ].join("\n"));
                    return;
                }

                if (parsed.ast.type === "library-update") {
                    const updated = updateLibrary(workspaceRoot, parsed.ast.library);
                    stream.markdown([
                        `Library updated: ${updated.library}`,
                        `- resolved: ${updated.resolvedVersion}`,
                        "- lockfile: .choir/lock.yaml",
                    ].join("\n"));
                    return;
                }

                if (parsed.ast.type === "library-lock") {
                    const locked = lockLibraries(workspaceRoot);
                    const lines = Object.entries(locked.libraries)
                        .sort(([left], [right]) => left.localeCompare(right))
                        .map(([library, version]) => `- ${library}: ${version}`);

                    stream.markdown([
                        "Library lock refreshed.",
                        ...(lines.length > 0 ? lines : ["- no locked libraries"]),
                    ].join("\n"));
                    return;
                }

                if (parsed.ast.type === "library-list") {
                    const catalog = listMacroLibraryCatalog(workspaceRoot);
                    const lock = readMacroLock(workspaceRoot);

                    if (catalog.length === 0) {
                        stream.markdown("No local macro libraries found under `.choir/libraries`.");
                        return;
                    }

                    const lines = catalog.map((entry) => {
                        const locked = lock.libraries[entry.name];
                        const versionList = entry.versions.join(", ");
                        return locked
                            ? `- ${entry.name}: [${versionList}] (locked=${locked})`
                            : `- ${entry.name}: [${versionList}]`;
                    });

                    stream.markdown([
                        `Libraries (${catalog.length}):`,
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
                        { workspaceRoot, executionMode: "interactive" }
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

                if (parsed.ast.type === "ci-run") {
                    const ciResult = await runCI({
                        root: workspaceRoot,
                        controlPlane: control,
                        controlPath,
                        context: {
                            role: "conductor",
                            environment: detectEnvironment(),
                        },
                        actorId: "chat-user",
                    });

                    stream.markdown(formatCIRunResult(ciResult));
                    return;
                }

                if (parsed.ast.type === "abstraction-run") {
                    const executed = runAbstraction(
                        workspaceRoot,
                        parsed.ast.identifier,
                        parsed.ast.args,
                        control,
                        controlPath,
                        {
                            workspaceRoot,
                            actorId: "chat-user",
                            executionMode: "interactive",
                        }
                    );

                    stream.markdown(formatAbstractionRunResult(executed));
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
