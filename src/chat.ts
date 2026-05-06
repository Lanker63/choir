import * as vscode from "vscode";
import fs from "fs";
import path from "path";
import { createDefaultControlPlane, getControlPlanePath, readControlPlane } from "./choirManager.js";
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
    GlobalPlan,
    Repo,
    compareStrategies,
    selectBestStrategy,
    simulatePlan as simulateGlobalPlan,
    simulateUnits as simulateGlobalUnits,
} from "./core/globalOrchestration.js";
import { formatSimulationChatResult } from "./core/simulationChat.js";
import { runRefactorIntent } from "./core/refactorEngine.js";
import {
    formatDSL,
    generateDSL,
    validateRoundTrip,
    writeDSL,
} from "./core/yamlDslGenerator.js";
import {
    parseAbstractionChatCommand,
    parseGraphChatCommand,
    parseInitChatCommand,
    parsePanelChatCommand,
} from "./core/chatCommands.js";
import {
    InitApplyMode,
    InitWizard,
    InitWizardSession,
    buildDSL,
    clearInitSession,
    createWizardState,
    getInitStatePath,
    loadInitSession,
    renderProgress,
    renderPrompt,
    renderReview,
    saveInitSession,
} from "./core/initWizard.js";
import { Plan, Task } from "./schema.js";

type ChatParticipantHandler = Parameters<NonNullable<typeof vscode.chat.createChatParticipant>>[1];

type AbstractionChatCommand =
    | { type: "list" }
    | { type: "describe"; id: string }
    | { type: "run"; id: string };

type InitTrace = {
    stepsCompleted: number;
    commandsGenerated: string[];
    result: "success" | "cancelled" | "paused";
    resumed: boolean;
    currentStep?: string;
    statePath?: string;
};

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

function sortedUnique(values: string[]): string[] {
    return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function deriveSimulationUnit(task: Task): string {
    const files = [...(task.scope?.files ?? [])]
        .map((file) => file.replace(/\\/g, "/"))
        .sort((left, right) => left.localeCompare(right));

    const first = files[0];
    if (!first) {
        return "workspace:root";
    }

    const segments = first.split("/").filter((entry) => entry.length > 0);
    if (segments.length >= 2 && ["packages", "apps", "services", "libs"].includes(segments[0])) {
        return `${segments[0]}:${segments[1]}`;
    }

    return "workspace:root";
}

function toGlobalPlanFromPlan(plan: Plan): GlobalPlan {
    const knownTaskIds = new Set(plan.tasks.map((task) => task.id));
    const tasks = [...plan.tasks]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((task) => ({
            id: `${plan.id}:${task.id}`,
            repoId: deriveSimulationUnit(task),
            action: `${task.type}:${task.id}`,
            dependsOn: sortedUnique((task.dependsOn ?? [])
                .filter((dependencyId) => knownTaskIds.has(dependencyId))
                .map((dependencyId) => `${plan.id}:${dependencyId}`)),
        }));

    return {
        id: `global-${plan.id}`,
        tasks,
    };
}

function buildSimulationRepos(plans: GlobalPlan[]): Repo[] {
    const taskById = new Map(plans.flatMap((plan) => plan.tasks.map((task) => [task.id, task] as const)));
    const repoDependencies = new Map<string, Set<string>>();

    for (const plan of plans) {
        for (const task of plan.tasks) {
            if (!repoDependencies.has(task.repoId)) {
                repoDependencies.set(task.repoId, new Set<string>());
            }

            for (const dependencyId of task.dependsOn) {
                const dependency = taskById.get(dependencyId);
                if (!dependency) {
                    continue;
                }

                if (dependency.repoId !== task.repoId) {
                    repoDependencies.get(task.repoId)?.add(dependency.repoId);
                }
            }
        }
    }

    return [...repoDependencies.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([repoId, dependencies]) => ({
            id: repoId,
            dependencies: sortedUnique([...dependencies]),
            state: {},
        }));
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
        "- choir define mission \"build deterministic delivery\"",
        "- choir define vision \"policy-native engineering platform\"",
        "- choir define goal \"enforce service boundaries\"",
        "- choir define goal \"A\" then define constraint \"B\"",
        "- choir plan for \"service boundaries\"",
        "- choir plan --optimize",
        "- choir plan approve <planId>",
        "- choir simulate",
        "- choir simulate plan <planId>",
        "- choir simulate units <unitId>,<unitId>",
        "- choir refactor rename <symbol> <newName>",
        "- choir refactor move <symbol> <targetUnit>",
        "- choir refactor extract <symbol> <targetUnit>",
        "- choir refactor inline <symbol>",
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
        "- choir graph",
        "- choir graph focus <node>",
        "- choir graph dependencies <node>",
        "- choir graph dependents <node>",
        "- choir bootstrap-service name=\"user-service\"",
        "- choir approve <diffId>",
        "- choir reject <diffId>",
        "- choir policy status",
        "- choir audit log",
        "- choir audit report",
        "- choir audit query role=architect",
        "",
        "Abstraction shortcuts:",
        "- @choir init",
        "- @choir init --template backend",
        "- @choir init --template frontend",
        "- @choir control",
        "- @choir timeline",
        "- @choir list abstractions",
        "- @choir describe <abstraction>",
        "- @choir run <abstraction>",
    ].join("\n"));
}

function countCompletedInitSteps(step: string): number {
    switch (step) {
        case "mission":
            return 0;
        case "vision":
            return 1;
        case "goals":
            return 2;
        case "constraints":
            return 3;
        case "non-goals":
            return 4;
        case "review":
            return 5;
        case "confirm":
            return 6;
        default:
            return 0;
    }
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
            const initChatCommand = parseInitChatCommand(raw);
            const graphChatCommand = parseGraphChatCommand(raw);
            const panelChatCommand = parsePanelChatCommand(raw);
            if (initChatCommand) {
                if (initChatCommand.invalidTemplate) {
                    stream.markdown(`Unsupported template: ${initChatCommand.invalidTemplate}. Supported templates: backend, frontend.`);
                    return;
                }

                const workspaceRoot = getWorkspaceRoot();
                if (!workspaceRoot) {
                    stream.markdown("No workspace folder found.");
                    return;
                }

                const controlPath = getControlPlanePath();
                if (!controlPath) {
                    stream.markdown("Unable to resolve .choir/choir.config.yaml.");
                    return;
                }

                const statePath = getInitStatePath(workspaceRoot);
                const existingSession = loadInitSession(workspaceRoot);
                let resumed = false;
                let session: InitWizardSession | null = null;

                if (existingSession) {
                    const resumeChoice = await vscode.window.showQuickPick([
                        {
                            label: "Resume",
                            description: `Continue from ${renderProgress(existingSession.state.currentStep)}`,
                            value: "resume" as const,
                        },
                        {
                            label: "Start Over",
                            description: "Discard saved wizard state and begin from mission",
                            value: "restart" as const,
                        },
                        {
                            label: "Cancel",
                            description: "Exit without changing the saved state",
                            value: "cancel" as const,
                        },
                    ], {
                        title: "Saved Choir init wizard found",
                        placeHolder: "Choose resume or restart",
                        ignoreFocusOut: true,
                    });

                    if (!resumeChoice || resumeChoice.value === "cancel") {
                        const trace: InitTrace = {
                            stepsCompleted: countCompletedInitSteps(existingSession.state.currentStep),
                            commandsGenerated: [],
                            result: "cancelled",
                            resumed: true,
                            currentStep: existingSession.state.currentStep,
                            statePath,
                        };
                        stream.markdown(`Choir init cancelled.\n\nTrace: ${JSON.stringify(trace, null, 2)}`);
                        return;
                    }

                    if (resumeChoice.value === "resume") {
                        session = existingSession;
                        resumed = true;
                    } else {
                        clearInitSession(workspaceRoot);
                    }
                }

                if (!session) {
                    const configExists = fs.existsSync(controlPath);
                    let mode: InitApplyMode = "overwrite";

                    if (configExists) {
                        const selected = await vscode.window.showQuickPick([
                            {
                                label: "Merge",
                                description: "Upsert wizard values into existing control plane",
                                mode: "merge" as const,
                            },
                            {
                                label: "Overwrite",
                                description: "Start from empty control plane and apply wizard DSL",
                                mode: "overwrite" as const,
                            },
                        ], {
                            title: "choir.config.yaml exists",
                            placeHolder: "Choose merge or overwrite",
                            ignoreFocusOut: true,
                        });

                        if (!selected) {
                            const trace: InitTrace = {
                                stepsCompleted: 0,
                                commandsGenerated: [],
                                result: "cancelled",
                                resumed: false,
                                currentStep: "mission",
                                statePath,
                            };
                            stream.markdown(`Choir init cancelled.\n\nTrace: ${JSON.stringify(trace, null, 2)}`);
                            return;
                        }

                        mode = selected.mode;
                    }

                    session = {
                        version: 1,
                        mode,
                        state: createWizardState(initChatCommand.template),
                    };
                    saveInitSession(workspaceRoot, session);
                }

                const wizard = new InitWizard(session.state);

                while (true) {
                    const step = wizard.state.currentStep;
                    const progress = renderProgress(step);

                    if (step === "review") {
                        stream.markdown([
                            progress,
                            "",
                            "```text",
                            renderReview(wizard.state.data),
                            "```",
                        ].join("\n"));
                    }

                    let input: string | undefined;

                    if (step === "confirm") {
                        const confirmSelection = await vscode.window.showQuickPick([
                            { label: "yes", description: "Apply this configuration" },
                            { label: "no", description: "Cancel and clear wizard state" },
                            { label: "back", description: "Return to review" },
                            { label: "cancel", description: "Cancel and clear wizard state" },
                        ], {
                            title: progress,
                            placeHolder: renderPrompt(wizard.state),
                            ignoreFocusOut: true,
                        });

                        if (!confirmSelection) {
                            session.state = wizard.state;
                            saveInitSession(workspaceRoot, session);
                            const trace: InitTrace = {
                                stepsCompleted: countCompletedInitSteps(wizard.state.currentStep),
                                commandsGenerated: [],
                                result: "paused",
                                resumed,
                                currentStep: wizard.state.currentStep,
                                statePath,
                            };
                            stream.markdown(`Choir init paused.\n\nTrace: ${JSON.stringify(trace, null, 2)}`);
                            return;
                        }

                        input = confirmSelection.label;
                    } else {
                        const stepInput = await vscode.window.showInputBox({
                            title: progress,
                            prompt: `${renderPrompt(wizard.state)} Type back to edit previous step or cancel to exit.`,
                            placeHolder: step === "review" ? "continue | back | cancel" : "enter value",
                            ignoreFocusOut: true,
                        });

                        if (stepInput === undefined) {
                            session.state = wizard.state;
                            saveInitSession(workspaceRoot, session);
                            const trace: InitTrace = {
                                stepsCompleted: countCompletedInitSteps(wizard.state.currentStep),
                                commandsGenerated: [],
                                result: "paused",
                                resumed,
                                currentStep: wizard.state.currentStep,
                                statePath,
                            };
                            stream.markdown(`Choir init paused.\n\nTrace: ${JSON.stringify(trace, null, 2)}`);
                            return;
                        }

                        input = stepInput;
                    }

                    const transition = wizard.next(input);
                    session.state = transition.state;
                    saveInitSession(workspaceRoot, session);

                    if (transition.message) {
                        stream.markdown(`Init wizard: ${transition.message}`);
                    }

                    if (transition.status === "active") {
                        continue;
                    }

                    if (transition.status === "cancelled") {
                        clearInitSession(workspaceRoot);
                        const trace: InitTrace = {
                            stepsCompleted: countCompletedInitSteps(transition.state.currentStep),
                            commandsGenerated: [],
                            result: "cancelled",
                            resumed,
                            currentStep: transition.state.currentStep,
                            statePath,
                        };
                        stream.markdown(`Choir init cancelled.\n\nTrace: ${JSON.stringify(trace, null, 2)}`);
                        return;
                    }

                    break;
                }

                const commands = buildDSL(wizard.state.data);
                stream.markdown([
                    "Preview configuration:",
                    `- Mission: ${wizard.state.data.mission && wizard.state.data.mission.length > 0 ? wizard.state.data.mission : "(empty)"}`,
                    `- Vision: ${wizard.state.data.vision && wizard.state.data.vision.length > 0 ? wizard.state.data.vision : "(empty)"}`,
                    `- Goals: ${wizard.state.data.goals.length}`,
                    `- Constraints: ${wizard.state.data.constraints.length}`,
                    `- Non-goals: ${wizard.state.data.nonGoals.length}`,
                    "",
                    "Generated DSL:",
                    "```text",
                    ...(commands.length > 0 ? commands : ["# no commands generated"]),
                    "```",
                ].join("\n"));

                if (commands.length === 0) {
                    clearInitSession(workspaceRoot);
                    const trace: InitTrace = {
                        stepsCompleted: countCompletedInitSteps(wizard.state.currentStep),
                        commandsGenerated: [],
                        result: "cancelled",
                        resumed,
                        currentStep: wizard.state.currentStep,
                        statePath,
                    };
                    stream.markdown(`Choir init cancelled: no DSL commands generated.\n\nTrace: ${JSON.stringify(trace, null, 2)}`);
                    return;
                }

                let currentControl = session.mode === "merge"
                    ? readControlPlane()
                    : createDefaultControlPlane();

                if (!currentControl) {
                    currentControl = createDefaultControlPlane();
                }

                for (const command of commands) {
                    const compiled = compileDSLAndWrite(command, currentControl, controlPath, {
                        workspaceRoot,
                        actorId: "chat-user",
                    });

                    if (compiled.decision === "deny") {
                        session.state = wizard.state;
                        saveInitSession(workspaceRoot, session);
                        const trace: InitTrace = {
                            stepsCompleted: countCompletedInitSteps(wizard.state.currentStep),
                            commandsGenerated: commands,
                            result: "paused",
                            resumed,
                            currentStep: wizard.state.currentStep,
                            statePath,
                        };
                        stream.markdown(`Choir init stopped by policy deny on: ${command}\n\nTrace: ${JSON.stringify(trace, null, 2)}`);
                        return;
                    }

                    if (compiled.decision === "require-approval") {
                        session.state = wizard.state;
                        saveInitSession(workspaceRoot, session);
                        const trace: InitTrace = {
                            stepsCompleted: countCompletedInitSteps(wizard.state.currentStep),
                            commandsGenerated: commands,
                            result: "paused",
                            resumed,
                            currentStep: wizard.state.currentStep,
                            statePath,
                        };
                        stream.markdown([
                            `Choir init paused: approval required for command: ${command}`,
                            compiled.pendingApprovalId ? `- diffId: ${compiled.pendingApprovalId}` : "",
                            compiled.diffHash ? `- diffHash: ${compiled.diffHash}` : "",
                            "",
                            `Trace: ${JSON.stringify(trace, null, 2)}`,
                        ].filter((line) => line.length > 0).join("\n"));
                        return;
                    }

                    currentControl = compiled.updatedControlPlane;
                }

                clearInitSession(workspaceRoot);
                const trace: InitTrace = {
                    stepsCompleted: countCompletedInitSteps(wizard.state.currentStep),
                    commandsGenerated: commands,
                    result: "success",
                    resumed,
                    currentStep: wizard.state.currentStep,
                    statePath,
                };

                stream.markdown([
                    "Choir init completed.",
                    `- mode: ${session.mode}`,
                    `- commandsApplied: ${commands.length}`,
                    "",
                    `Trace: ${JSON.stringify(trace, null, 2)}`,
                ].join("\n"));
                return;
            }

            if (graphChatCommand) {
                await vscode.commands.executeCommand("choir.graph.setMode", graphChatCommand.mode, graphChatCommand.nodeId);
                stream.markdown(graphChatCommand.nodeId
                    ? `Graph opened in mode: ${graphChatCommand.mode} ${graphChatCommand.nodeId}`
                    : `Graph opened in mode: ${graphChatCommand.mode}`);
                return;
            }

            if (panelChatCommand) {
                if (panelChatCommand.target === "control") {
                    await vscode.commands.executeCommand("choir.openRuleEditor");
                    stream.markdown("Control Center opened.");
                    return;
                }

                await vscode.commands.executeCommand("choir.openTimeline");
                stream.markdown("Timeline opened.");
                return;
            }

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
                    || action.type === "simulate"
                    || action.type === "refactor-rename"
                    || action.type === "refactor-move"
                    || action.type === "refactor-extract"
                    || action.type === "refactor-inline"
                    || action.type === "graph"
                    || (action.type === "plan" && action.optimize === true)
                )
            ) {
                stream.markdown("Invalid Choir DSL command. `export|approve|reject|policy status|import|library|ci|abstraction|audit|macro|graph|simulate|refactor|plan --optimize` cannot be chained with `then`.");
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

                if (parsed.ast.type === "graph") {
                    await vscode.commands.executeCommand("choir.graph.setMode", parsed.ast.mode, parsed.ast.nodeId);

                    const suffix = parsed.ast.nodeId ? ` ${parsed.ast.nodeId}` : "";
                    stream.markdown(`Graph opened in mode: ${parsed.ast.mode}${suffix}`);
                    return;
                }

                if (parsed.ast.type === "plan" && parsed.ast.optimize) {
                    const planNode = parsed.ast;
                    const configuredPlans = [...control.execution.plans]
                        .sort((left, right) => left.id.localeCompare(right.id));

                    if (configuredPlans.length === 0) {
                        stream.markdown("Plan optimization unavailable: no execution plans defined in control plane.");
                        return;
                    }

                    const target = planNode.target;
                    const targetedPlans = target
                        ? configuredPlans.filter((plan) => (plan.goalRefs ?? []).includes(target))
                        : configuredPlans;

                    if (targetedPlans.length === 0) {
                        stream.markdown(`Plan optimization found no matching strategies for target: ${target}`);
                        return;
                    }

                    const strategies = targetedPlans.map((plan) => ({
                        id: plan.id,
                        plan: toGlobalPlanFromPlan(plan),
                    }));
                    const repos = buildSimulationRepos(strategies.map((entry) => entry.plan));
                    const selection = await selectBestStrategy(strategies, {
                        repos,
                        policies: [],
                    });

                    const rankingLines = selection.ranking.map((entry, index) =>
                        `- ${index + 1}. ${entry.strategyId} (violations=${entry.metrics.violations}, risk=${entry.metrics.risk}, changes=${entry.metrics.changes}, executionCost=${entry.metrics.executionCost})`
                    );

                    stream.markdown([
                        "Plan optimization complete.",
                        `- selected: ${selection.selected.strategyId}`,
                        `- strategiesEvaluated: ${selection.trace.strategiesEvaluated}`,
                        `- strategiesRejected: ${selection.trace.strategiesRejected}`,
                        `- selectionTimeMs: ${selection.trace.selectionTime}`,
                        "",
                        "Reason:",
                        ...selection.decision.reason.split("\n"),
                        "",
                        "Ranking:",
                        ...rankingLines,
                    ].join("\n"));
                    return;
                }

                if (
                    parsed.ast.type === "simulate"
                ) {
                    const simulateNode = parsed.ast;
                    const configuredPlans = [...control.execution.plans]
                        .sort((left, right) => left.id.localeCompare(right.id));

                    if (configuredPlans.length === 0) {
                        stream.markdown("Simulation unavailable: no execution plans defined in control plane.");
                        return;
                    }

                    const selectedPlans = simulateNode.planRef
                        ? configuredPlans.filter((plan) => plan.id === simulateNode.planRef?.identifier)
                        : configuredPlans;

                    if (selectedPlans.length === 0) {
                        stream.markdown(`Simulation plan not found: ${simulateNode.planRef?.identifier}`);
                        return;
                    }

                    const strategyPlans = selectedPlans.map((plan) => toGlobalPlanFromPlan(plan));
                    const repos = buildSimulationRepos(strategyPlans);
                    const simulationOptions = {
                        repos,
                        policies: [],
                    };

                    let chosenPlan = strategyPlans[0] as GlobalPlan;
                    let comparisonMetrics: { risk: number; changes: number; violations: number } | null = null;

                    if (!simulateNode.planRef && strategyPlans.length > 1) {
                        const comparison = await compareStrategies(strategyPlans, simulationOptions);
                        chosenPlan = strategyPlans.find((plan) => plan.id === comparison.bestStrategy) ?? chosenPlan;
                        comparisonMetrics = comparison.metrics;
                    }

                    const simulated = simulateNode.units && simulateNode.units.length > 0
                        ? await simulateGlobalUnits(simulateNode.units, chosenPlan, simulationOptions)
                        : await simulateGlobalPlan(chosenPlan, simulationOptions);

                    const fallbackChanges = simulated.changes.reduce((sum, entry) => sum + entry.operations.length, 0);
                    const fallbackRisk = (simulated.violations.length * 5) + fallbackChanges;
                    const metrics = comparisonMetrics ?? {
                        risk: fallbackRisk,
                        changes: fallbackChanges,
                        violations: simulated.violations.length,
                    };

                    stream.markdown(formatSimulationChatResult({
                        success: simulated.success,
                        strategyId: chosenPlan.id,
                        units: simulateNode.units,
                        changes: simulated.changes,
                        violations: simulated.violations,
                        metrics,
                    }));
                    return;
                }

                if (
                    parsed.ast.type === "refactor-rename"
                    || parsed.ast.type === "refactor-move"
                    || parsed.ast.type === "refactor-extract"
                    || parsed.ast.type === "refactor-inline"
                ) {
                    const intent = parsed.ast.type === "refactor-rename"
                        ? {
                            type: "rename" as const,
                            symbol: parsed.ast.symbol,
                            newName: parsed.ast.newName,
                        }
                        : parsed.ast.type === "refactor-move"
                            ? {
                                type: "move" as const,
                                symbol: parsed.ast.symbol,
                                from: "*",
                                to: parsed.ast.targetUnit,
                            }
                            : parsed.ast.type === "refactor-extract"
                                ? {
                                    type: "extract" as const,
                                    symbol: parsed.ast.symbol,
                                    targetUnit: parsed.ast.targetUnit,
                                }
                                : {
                                    type: "inline" as const,
                                    symbol: parsed.ast.symbol,
                                };

                    const refactorResult = await runRefactorIntent(intent, {
                        root: workspaceRoot,
                        controlPlane: control,
                        execute: true,
                    });

                    const validation = refactorResult.simulation.validation;
                    const execution = refactorResult.execution;
                    const details = [
                        `Refactor intent: ${intent.type}`,
                        `- affectedUnits: ${refactorResult.impact.affectedUnits.length}`,
                        `- affectedFiles: ${refactorResult.impact.affectedFiles.length}`,
                        `- previewHash: ${refactorResult.preview.hash}`,
                        `- validation: ${validation.passed ? "passed" : "failed"}`,
                        `- execution: ${execution?.committed ? "committed" : (execution?.rolledBack ? "rolled-back" : "not-committed")}`,
                        execution?.snapshotId ? `- snapshotId: ${execution.snapshotId}` : "",
                    ].filter((line) => line.length > 0);

                    const failureDetails = !validation.passed
                        ? [
                            ...(validation.policy.violations.map((violation) => `- policy: ${violation}`)),
                            ...(validation.missingReferenceErrors.map((violation) => `- references: ${violation}`)),
                            ...(validation.consistencyErrors.map((violation) => `- consistency: ${violation}`)),
                        ]
                        : [];

                    const diffBlocks = refactorResult.preview.changes.length === 0
                        ? ["No file changes generated."]
                        : refactorResult.preview.changes.slice(0, 5).flatMap((change) => [
                            `File: ${change.file}`,
                            "```diff",
                            change.diff,
                            "```",
                        ]);

                    stream.markdown([
                        ...details,
                        ...(failureDetails.length > 0 ? ["", "Validation details:", ...failureDetails] : []),
                        "",
                        ...diffBlocks,
                    ].join("\n"));
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
