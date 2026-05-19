import * as vscode from "vscode";
import fs from "fs";
import path from "path";
import { createDefaultControlPlane, getControlPlanePath, readControlPlane, writeControlPlane } from "./choirManager.js";
import {
    exportReport,
    generateReport,
    queryAudit,
} from "./core/audit.js";
import {
    importLibrary,
    installLibrary,
    listLibraryCatalog,
    loadMacroLibrary,
    lockChoirLibraries,
    parseLibraryFailure,
    readMacroLock,
    updateLibrary,
} from "./core/macroLibraries.js";
import {
    evaluateAdaptivePlanSelection,
} from "./conductor.js";
import { analyzeWorkspace, findHotspots } from "./analyst.js";
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
import { AST, AnalyzeTarget, CHOIR_DSL_GRAMMAR, parseCommand } from "./core/choirRouter.js";
import { getMacro, listMacros, runMacro } from "./core/macros.js";
import { detectEnvironment } from "./core/policyEngine.js";
import {
    buildRollbackDependencyGraph,
    buildStages,
    computeRollbackSet,
    GlobalPlan,
    orderRollback,
    RollbackTrace,
    RolloutStrategy,
    validateIsolation,
} from "./core/globalOrchestration.js";
import { formatSimulationChatResult } from "./core/simulationChat.js";
import { persistSelectedOptimizedPlan } from "./core/planPersistence.js";
import { formatAnalyzeMarkdown } from "./core/analyzeOutput.js";
import { resolveRollbackStageSelection, resolveRollbackUnitSelection } from "./core/rollbackSelectors.js";
import { runRefactorIntent } from "./core/refactorEngine.js";
import { formatRuntimeVerificationReport, runRuntimeVerification } from "./core/runtimeVerification.js";
import { CompilerPipelineError, compileInput, formatCompilerErrors } from "./core/compilerPipeline.js";
import {
    formatDSL,
    generateDSL,
    validateRoundTrip,
    writeDSL,
} from "./core/yamlDslGenerator.js";
import {
    parseAbstractionChatCommand,
    parseExportChatCommand,
    parseGraphChatCommand,
    parseGoalMutationChatCommand,
    parseCliInstallChatCommand,
    parseInitChatCommand,
    normalizeChatDSLInput,
    parsePanelChatCommand,
    parseVerifyChatCommand,
} from "./core/chatCommands.js";
import {
    OrchestrationPipelineError,
    runOrchestrationPipeline,
} from "./core/orchestrationRuntime.js";
import { evaluateRuntimeGovernance, type Capability } from "./core/runtimeGovernance.js";
import { listInitTemplateNames, listInitTemplateNamesDisplay } from "./core/initTemplateCatalog.js";
import { withSingleSelectDefault } from "./core/quickPickDefaults.js";
import { buildExecutionPlan } from "./core/scheduler.js";
import { readLatestOrchestrationTrace } from "./core/orchestrationRuntimeTrace.js";
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
import {
    calibrateStrategicOrchestration,
    discoverStrategicDomains,
    readStrategicInitState,
    selectExpandDomainModelingDiscovery,
    seedStrategicDomainPromptDefaults,
    synthesizeStrategicControlPlane,
    type GovernanceIntensity,
    type OptimizationGoal,
    type RiskTolerance,
    type RolloutPreference,
    type RuntimeMode,
    type StabilityProfile,
    type StrategicDomainModel,
    type StrategicInitMode,
    type StrategicPriority,
    writeStrategicInitState,
} from "./core/strategicInit.js";
import { appendPipelineDiagnosticsRecordIfPossible } from "./core/pipelineDiagnostics.js";
import {
    buildCliInstallCommand,
    normalizeCliPackageSpec,
    validateCliPackageSpec,
} from "./core/cliInstall.js";
import { ControlPlane, Plan, Task } from "./schema.js";
import {
    createEmptyStatePlane,
    persistStatePlane,
    readStatePlane,
    resolveDeterministicRollbackTarget,
} from "./core/state.js";

type ChatParticipantHandler = Parameters<NonNullable<typeof vscode.chat.createChatParticipant>>[1];

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

function missingControlPlaneMessage(): string {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return "No workspace folder found. Open a workspace folder first.";
    }

    return "No control plane found in this workspace. This folder is not initialized for Choir yet. Run `@choir init` to initialize Choir for this repository.";
}

function sortedUnique(values: string[]): string[] {
    return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function renderRuntimeGovernanceBlocked(input: {
    mode: string;
    capability: Capability;
    decision: "deny" | "require-approval";
    reason: string;
}): string {
    return [
        "runtime-governance:",
        "  status: blocked",
        `  mode: ${input.mode}`,
        `  capability: ${input.capability}`,
        `  decision: ${input.decision}`,
        `  reason: ${input.reason}`,
    ].join("\n");
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

function buildWorkUnitBindingsForPlan(plan: Plan): Record<string, string[]> {
    const executionPlan = buildExecutionPlan([plan]);
    const entries = executionPlan.executionPlan.batches
        .flatMap((batch) => batch.workUnits)
        .map((workUnit) => [workUnit.id, sortedUnique(workUnit.tasks.map((task) => deriveSimulationUnit(task)))] as const)
        .sort(([left], [right]) => left.localeCompare(right));

    return Object.fromEntries(entries);
}

function readTraceWorkUnitBindings(root: string): Record<string, string[]> {
    const trace = readLatestOrchestrationTrace(root);
    if (!trace || trace.mode !== "execute" || trace.status !== "success") {
        return {};
    }

    const modeMetadata = trace.modeMetadata;
    if (!modeMetadata || typeof modeMetadata !== "object" || Array.isArray(modeMetadata)) {
        return {};
    }

    const execution = (modeMetadata as Record<string, unknown>).execution;
    if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
        return {};
    }

    const rawBindings = (execution as Record<string, unknown>).workUnitBindings;
    if (!rawBindings || typeof rawBindings !== "object" || Array.isArray(rawBindings)) {
        return {};
    }

    const normalized: Record<string, string[]> = {};
    for (const [workUnitId, units] of Object.entries(rawBindings as Record<string, unknown>)) {
        if (typeof workUnitId !== "string" || workUnitId.trim().length === 0 || !Array.isArray(units)) {
            continue;
        }

        const mappedUnits = sortedUnique(units.filter((unit): unit is string => typeof unit === "string" && unit.trim().length > 0));
        if (mappedUnits.length > 0) {
            normalized[workUnitId] = mappedUnits;
        }
    }

    return normalized;
}

function mergeWorkUnitBindings(
    base: Record<string, string[]>,
    incoming: Record<string, string[]>
): Record<string, string[]> {
    const merged: Record<string, string[]> = { ...base };
    for (const [workUnitId, units] of Object.entries(incoming)) {
        merged[workUnitId] = sortedUnique([...(merged[workUnitId] ?? []), ...units]);
    }

    return merged;
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

function extractAnalyzeTarget(ast: AST): AnalyzeTarget | null {
    if (ast.type === "analyze") {
        return ast.target;
    }

    if (ast.type === "sequence" && ast.actions.length === 1 && ast.actions[0].type === "analyze") {
        return ast.actions[0].target;
    }

    return null;
}

function renderAnalyzeResult(stream: vscode.ChatResponseStream, target: AnalyzeTarget): void {
    const summary = analyzeWorkspace();
    const hotspots = findHotspots();
    stream.markdown(formatAnalyzeMarkdown(target, summary, hotspots));
}

function renderGrammarHelp(stream: vscode.ChatResponseStream): void {
    const templateExamples = listInitTemplateNames().map((template) => `- @choir init --template ${template}`);
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
        "- choir plan --adaptive",
        "- choir plan approve <planId>",
        "- choir simulate",
        "- choir simulate plan <planId>",
        "- choir simulate units <unitId>,<unitId>",
        "- choir execute --strategy canary --steps 1,10,25,100",
        "- choir execute --strategy phased",
        "- choir execute --strategy batched --batch-size 2",
        "- choir rollback",
        "- choir rollback <unitId>",
        "- choir rollback --stage <stageId>",
        "- choir refactor rename <symbol> <newName>",
        "- choir refactor rename <symbol> <newName> --declaration \"src/file.ts:line:character\"",
        "- choir refactor move <symbol> <targetUnit>",
        "- choir refactor move <symbol> --file \"src/file.ts\"",
        "- choir refactor extract <symbol> <targetUnit>",
        "- choir refactor extract <symbol> --file \"src/file.ts\"",
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
        ...templateExamples,
        "- @choir init --reclassify",
        "- @choir init --expand-domain",
        "- @choir init --recalibrate",
        "- @choir verify",
        "- @choir verify --quick",
        "- @choir verify --property",
        "- @choir verify --chaos",
        "- @choir verify --chaos extreme",
        "- @choir verify --contracts",
        "- @choir verify --policy",
        "- @choir verify --orchestration",
        "- @choir verify --production",
        "- @choir verify --compiler",
        "- @choir verify --full",
        "- @choir cli install",
        "- @choir export --format json",
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

const STRATEGIC_PRIORITIES: StrategicPriority[] = [
    "correctness",
    "auditability",
    "rollback-safety",
    "minimal-blast-radius",
    "deterministic-replay",
    "iteration-speed",
    "developer-autonomy",
    "dependency-safety",
    "stability",
];

const OPTIMIZATION_GOALS: OptimizationGoal[] = [
    "minimal-blast-radius",
    "deterministic-replay",
    "rapid-delivery",
    "low-governance-friction",
    "dependency-isolation",
    "rollback-minimized",
    "parallel-throughput",
];

const ROLLOUT_PREFERENCES: RolloutPreference[] = [
    "canary-required",
    "phased-required",
    "phased-optional",
    "all-at-once-allowed",
    "parallel-optimized",
];

async function modelStrategicDomainsInteractively(
    discovery: ReturnType<typeof discoverStrategicDomains>
): Promise<StrategicDomainModel[] | null> {
    const models: StrategicDomainModel[] = [];

    for (const domain of discovery.domains) {
        const model = await modelSingleStrategicDomain(domain);
        if (!model) {
            return null;
        }
        models.push(model);
    }

    return models.sort((left, right) => left.id.localeCompare(right.id));
}

async function modelSingleStrategicDomain(
    domain: ReturnType<typeof discoverStrategicDomains>["domains"][number],
    currentControl?: ControlPlane
): Promise<StrategicDomainModel | null> {
    const defaults = seedStrategicDomainPromptDefaults(domain, currentControl);
    const packageSummary = domain.packages.join(", ");
    const reasonSummary = domain.reasons.join("; ");
    const mission = await vscode.window.showInputBox({
        title: `Strategic Domain: ${domain.id}`,
        prompt: [
            `Detected package(s): ${packageSummary}`,
            `Domain derivation: ${reasonSummary}`,
            `Confirm or edit what this topology-derived domain is responsible for (${domain.packages.length} package(s)).`,
        ].join("\n"),
        value: defaults.mission,
        ignoreFocusOut: true,
    });

    if (mission === undefined) {
        return null;
    }

    const prioritiesPick = await vscode.window.showQuickPick(
        STRATEGIC_PRIORITIES.map((priority) => ({
            label: priority,
            picked: defaults.priorities.includes(priority),
        })),
        {
            title: `Strategic Priorities: ${domain.id}`,
            placeHolder: "Select one or more priorities",
            canPickMany: true,
            ignoreFocusOut: true,
        }
    );

    if (!prioritiesPick) {
        return null;
    }

    const goalsPick = await vscode.window.showQuickPick(
        OPTIMIZATION_GOALS.map((goal) => ({
            label: goal,
            picked: defaults.optimizationGoals.includes(goal),
        })),
        {
            title: `Optimization Goals: ${domain.id}`,
            placeHolder: "Select one or more optimization goals",
            canPickMany: true,
            ignoreFocusOut: true,
        }
    );

    if (!goalsPick) {
        return null;
    }

    const riskPick = await vscode.window.showQuickPick([
        ...withSingleSelectDefault<RiskTolerance>(["low", "moderate", "high"], defaults.riskTolerance),
    ], {
        title: `Risk Tolerance: ${domain.id}`,
        placeHolder: `Suggested: ${defaults.riskTolerance}`,
        ignoreFocusOut: true,
    });
    if (!riskPick) {
        return null;
    }
    const risk = riskPick.label;

    const rollout = await vscode.window.showQuickPick(
        ROLLOUT_PREFERENCES.map((entry) => ({
            label: entry,
            picked: defaults.rolloutPreferences.includes(entry),
        })),
        {
            title: `Rollout Posture: ${domain.id}`,
            placeHolder: "Select one or more rollout preferences",
            canPickMany: true,
            ignoreFocusOut: true,
        }
    );
    if (!rollout) {
        return null;
    }

    const stabilityPick = await vscode.window.showQuickPick([
        ...withSingleSelectDefault<StabilityProfile>(["stable", "adaptive", "experimental"], defaults.stabilityProfile),
    ], {
        title: `Stability Profile: ${domain.id}`,
        placeHolder: `Suggested: ${defaults.stabilityProfile}`,
        ignoreFocusOut: true,
    });
    if (!stabilityPick) {
        return null;
    }
    const stability = stabilityPick.label;

    const governancePick = await vscode.window.showQuickPick([
        ...withSingleSelectDefault<GovernanceIntensity>(["strict", "moderate", "relaxed"], defaults.governanceIntensity),
    ], {
        title: `Governance Intensity: ${domain.id}`,
        placeHolder: `Suggested: ${defaults.governanceIntensity}`,
        ignoreFocusOut: true,
    });
    if (!governancePick) {
        return null;
    }
    const governance = governancePick.label;

    const domainRuntimeModePick = await vscode.window.showQuickPick([
        ...withSingleSelectDefault<RuntimeMode>([
            "observe-only",
            "simulation-only",
            "approval-required",
            "execution-enabled",
            "distributed-control",
        ], defaults.runtimeMode),
    ], {
        title: `Domain Runtime Governance Mode: ${domain.id}`,
        placeHolder: `Suggested: ${defaults.runtimeMode} | applies to packages in this domain`,
        ignoreFocusOut: true,
    });

    if (!domainRuntimeModePick) {
        return null;
    }
    const runtimeMode = domainRuntimeModePick.label;

    return {
        id: domain.id,
        mission: mission.trim(),
        priorities: prioritiesPick.map((entry) => entry.label as StrategicPriority).sort((left, right) => left.localeCompare(right)),
        optimizationGoals: goalsPick.map((entry) => entry.label as OptimizationGoal).sort((left, right) => left.localeCompare(right)),
        riskTolerance: risk,
        rolloutPreferences: rollout.map((entry) => entry.label as RolloutPreference).sort((left, right) => left.localeCompare(right)),
        stabilityProfile: stability,
        governanceIntensity: governance,
        runtimeMode,
        ...(domain.inferred.runtimeCapabilities
            ? {
                runtimeCapabilities: { ...domain.inferred.runtimeCapabilities },
            }
            : {}),
    };
}

type MergeDomainSelectionResult = {
    models: StrategicDomainModel[];
    selectedDomainIds: string[];
    selectedPackagePaths: string[];
};

async function modelStrategicDomainsForMerge(
    discovery: ReturnType<typeof discoverStrategicDomains>,
    currentControl: ControlPlane
): Promise<MergeDomainSelectionResult | null> {
    const modelsById = new Map<string, StrategicDomainModel>();
    const selectedPackagePaths = new Set<string>();

    while (true) {
        const picks: Array<(vscode.QuickPickItem & { domainId?: string; finish?: boolean })> = [
            ...discovery.domains.map((domain) => ({
                label: domain.id,
                description: `${domain.packages.length} package(s)`,
                detail: `packages: ${domain.packages.join(", ")}`,
                domainId: domain.id,
            })),
            {
                label: "Finish merge re-init",
                description: "Stop strategic domain re-initialization and complete now",
                finish: true,
            },
        ];

        const pick = await vscode.window.showQuickPick(picks, {
            title: "Merge Strategic Domains",
            placeHolder: "Select a domain to re-initialize, or finish merge re-init",
            ignoreFocusOut: true,
        });

        if (!pick) {
            return null;
        }

        if (pick.finish) {
            break;
        }

        const selectedDomain = discovery.domains.find((domain) => domain.id === pick.domainId);
        if (!selectedDomain) {
            continue;
        }

        const model = await modelSingleStrategicDomain(selectedDomain, currentControl);
        if (!model) {
            return null;
        }

        modelsById.set(selectedDomain.id, model);
        for (const packagePath of selectedDomain.packages) {
            selectedPackagePaths.add(packagePath);
        }
    }

    return {
        models: [...modelsById.values()].sort((left, right) => left.id.localeCompare(right.id)),
        selectedDomainIds: [...modelsById.keys()].sort((left, right) => left.localeCompare(right)),
        selectedPackagePaths: [...selectedPackagePaths].sort((left, right) => left.localeCompare(right)),
    };
}

function selectDiscoveryForDomains(
    discovery: ReturnType<typeof discoverStrategicDomains>,
    selectedDomainIds: string[]
): ReturnType<typeof discoverStrategicDomains> {
    const selectedDomainIdSet = new Set(selectedDomainIds);
    const selectedDomains = discovery.domains.filter((domain) => selectedDomainIdSet.has(domain.id));
    const selectedPackageSet = new Set(selectedDomains.flatMap((domain) => domain.packages));

    return {
        workspace: discovery.workspace,
        packages: discovery.packages.filter((pkg) => selectedPackageSet.has(pkg.packagePath)),
        domains: selectedDomains,
    };
}

function mergeSelectedStrategicDomainsIntoControl(
    currentControl: ControlPlane,
    synthesizedControl: ControlPlane,
    selectedPackagePaths: string[],
    allDiscoveredPackagePaths: string[],
    hasRootPackage: boolean
): ControlPlane {
    const nextPackages = {
        ...(currentControl.packages ?? {}),
        ...(Object.fromEntries(
            selectedPackagePaths
                .map((packagePath) => [packagePath, synthesizedControl.packages?.[packagePath]] as const)
                .filter((entry): entry is [string, NonNullable<ControlPlane["packages"]>[string]] => entry[1] !== undefined)
        )),
    };

    const nextPackageModes = hasRootPackage
        ? undefined
        : {
            ...(currentControl.packageModes ?? {}),
            ...(Object.fromEntries(
                selectedPackagePaths
                    .map((packagePath) => [packagePath, synthesizedControl.packageModes?.[packagePath]] as const)
                    .filter((entry): entry is [string, NonNullable<ControlPlane["packageModes"]>[string]] => entry[1] !== undefined)
            )),
        };

    const existingWorkspacePackages = currentControl.contexts?.["workspace:root"]?.packages ?? [];
    const mergedWorkspacePackages = sortedUnique([...existingWorkspacePackages, ...allDiscoveredPackagePaths]);

    const { domains: _domains, packageModes: _packageModes, ...rest } = currentControl;

    return {
        ...rest,
        packages: nextPackages,
        contexts: {
            ...(currentControl.contexts ?? {}),
            "workspace:root": {
                ...(currentControl.contexts?.["workspace:root"] ?? {}),
                packages: mergedWorkspacePackages,
            },
        },
        ...(hasRootPackage
            ? {
                runtime: synthesizedControl.runtime,
                capabilities: synthesizedControl.capabilities,
            }
            : {
                packageModes: nextPackageModes,
            }),
    };
}

async function chooseRuntimeMode(
    suggested: RuntimeMode,
    calibrationSummary: string
): Promise<RuntimeMode | null> {
    const picked = await vscode.window.showQuickPick([
        ...withSingleSelectDefault<RuntimeMode>([
            "observe-only",
            "simulation-only",
            "approval-required",
            "execution-enabled",
            "distributed-control",
        ], suggested),
    ], {
        title: "Global Runtime Governance Mode",
        placeHolder: `Suggested global mode: ${suggested} | ${calibrationSummary} | domain/package-level governance is applied separately via packageModes`,
        ignoreFocusOut: true,
    });

    return picked?.label ?? null;
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
            const verifyChatCommand = parseVerifyChatCommand(raw);
            const cliInstallChatCommand = parseCliInstallChatCommand(raw);
            const exportChatCommand = parseExportChatCommand(raw);
            if (initChatCommand) {
                if (initChatCommand.invalidTemplate) {
                    stream.markdown(`Unsupported template. Supported templates: ${listInitTemplateNamesDisplay()}.`);
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

                const strategicMode: StrategicInitMode = initChatCommand.mode ?? "full";
                const strategicTemplate = initChatCommand.template;
                const diagnosticsStages: Array<{ stage: string; status: "success" | "failure"; detail: string }> = [];

                let currentControl = readControlPlane() ?? createDefaultControlPlane();
                let commandsApplied = 0;
                let initApplyMode: InitApplyMode = "merge";
                let missionForSynthesis = currentControl.mission;
                let visionForSynthesis = currentControl.vision;
                const hasRootPackage = fs.existsSync(path.join(workspaceRoot, "package.json"));

                if (strategicMode === "full") {
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

                        const legacyTemplate = strategicTemplate === "backend" || strategicTemplate === "frontend"
                            ? strategicTemplate
                            : undefined;

                        const seededWizardState = mode === "merge"
                            ? createWizardState(legacyTemplate, {
                                mission: currentControl.mission,
                                vision: currentControl.vision,
                                goals: currentControl.intent.goals,
                                constraints: currentControl.intent.constraints,
                                nonGoals: currentControl.intent["non-goals"],
                            })
                            : createWizardState(legacyTemplate);

                        session = {
                            version: 1,
                            mode,
                            state: seededWizardState,
                        };
                        saveInitSession(workspaceRoot, session);
                    }

                    initApplyMode = session.mode;
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

                        if (step === "review" || step === "confirm") {
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
                                placeHolder: "enter value",
                                value: step === "mission"
                                    ? (wizard.state.data.mission ?? "")
                                    : (step === "vision" ? (wizard.state.data.vision ?? "") : undefined),
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
                    if (commands.length === 0) {
                        clearInitSession(workspaceRoot);
                        stream.markdown("Choir init cancelled: no DSL commands generated.");
                        return;
                    }

                    currentControl = session.mode === "merge"
                        ? (readControlPlane() ?? createDefaultControlPlane())
                        : createDefaultControlPlane();

                    for (const command of commands) {
                        const compiled = compileDSLAndWrite(command, currentControl, controlPath, {
                            workspaceRoot,
                            actorId: "chat-user",
                        });

                        if (compiled.decision === "deny") {
                            session.state = wizard.state;
                            saveInitSession(workspaceRoot, session);
                            stream.markdown(`Choir init stopped by policy deny on: ${command}`);
                            return;
                        }

                        if (compiled.decision === "require-approval") {
                            session.state = wizard.state;
                            saveInitSession(workspaceRoot, session);
                            stream.markdown([
                                `Choir init paused: approval required for command: ${command}`,
                                compiled.pendingApprovalId ? `- diffId: ${compiled.pendingApprovalId}` : "",
                                compiled.diffHash ? `- diffHash: ${compiled.diffHash}` : "",
                            ].filter((line) => line.length > 0).join("\n"));
                            return;
                        }

                        commandsApplied += 1;
                        currentControl = compiled.updatedControlPlane;
                    }

                    missionForSynthesis = wizard.state.data.mission ?? currentControl.mission;
                    visionForSynthesis = wizard.state.data.vision ?? currentControl.vision;

                    if (!hasRootPackage) {
                        writeControlPlane(currentControl);
                    }

                    clearInitSession(workspaceRoot);
                }

                try {
                    diagnosticsStages.push({
                        stage: "workspace-discovery",
                        status: "success",
                        detail: "detected workspace and package topology",
                    });

                    const discovery = discoverStrategicDomains(
                        workspaceRoot,
                        (strategicTemplate as Parameters<typeof discoverStrategicDomains>[1])
                    );

                    if (discovery.domains.length === 0) {
                        stream.markdown("Strategic init failed: no packages were discovered for domain modeling.");
                        appendPipelineDiagnosticsRecordIfPossible(workspaceRoot, {
                            command: `choir init${strategicMode !== "full" ? ` --${strategicMode}` : ""}`,
                            source: "chat",
                            category: "pipeline",
                            result: "failure",
                            summary: "Strategic init failed at domain classification: no discoverable packages.",
                            stages: [
                                ...diagnosticsStages,
                                {
                                    stage: "domain-classification",
                                    status: "failure",
                                    detail: "no packages discovered",
                                },
                            ],
                        });
                        return;
                    }

                    diagnosticsStages.push({
                        stage: "domain-classification",
                        status: "success",
                        detail: `inferred ${discovery.domains.length} domains from ${discovery.packages.length} packages`,
                    });

                    const isMergeDomainLoop = strategicMode === "full" && initApplyMode === "merge";
                    const mergeSelection = isMergeDomainLoop
                        ? await modelStrategicDomainsForMerge(discovery, currentControl)
                        : null;

                    if (isMergeDomainLoop && !mergeSelection) {
                        stream.markdown("Choir init cancelled during strategic domain modeling.");
                        return;
                    }

                    const expandDomainModelingDiscovery = strategicMode === "expand-domain"
                        ? selectExpandDomainModelingDiscovery(discovery, currentControl)
                        : null;

                    const modelingDiscovery = mergeSelection
                        ? selectDiscoveryForDomains(discovery, mergeSelection.selectedDomainIds)
                        : (expandDomainModelingDiscovery ?? discovery);

                    const models = mergeSelection
                        ? mergeSelection.models
                        : await modelStrategicDomainsInteractively(modelingDiscovery);

                    if (!models) {
                        stream.markdown("Choir init cancelled during strategic domain modeling.");
                        return;
                    }

                    diagnosticsStages.push({
                        stage: "strategic-modeling",
                        status: "success",
                        detail: mergeSelection
                            ? `confirmed strategic posture for ${models.length} selected domains`
                            : `confirmed strategic posture for ${models.length} domains`,
                    });

                    if (mergeSelection && models.length === 0) {
                        if (!hasRootPackage) {
                            writeControlPlane(currentControl);
                        }

                        appendPipelineDiagnosticsRecordIfPossible(workspaceRoot, {
                            command: `choir init${strategicMode !== "full" ? ` --${strategicMode}` : ""}`,
                            source: "chat",
                            category: "pipeline",
                            result: "success",
                            summary: "Merge init completed with root-level updates only (no strategic domains selected).",
                            stages: diagnosticsStages,
                            metadata: {
                                strategicInit: {
                                    mode: strategicMode,
                                    template: strategicTemplate ?? "none",
                                    workspaceType: discovery.workspace.type,
                                    packageCount: discovery.packages.length,
                                    domainCount: 0,
                                    initApplyMode,
                                    commandsApplied,
                                },
                            },
                        });

                        stream.markdown([
                            "Choir merge init completed.",
                            "- root-level mission/vision/intent updates applied",
                            "- no strategic domains selected",
                        ].join("\n"));
                        return;
                    }

                    const calibration = calibrateStrategicOrchestration(modelingDiscovery, models);
                    diagnosticsStages.push({
                        stage: "orchestration-calibration",
                        status: "success",
                        detail: `strategy=${calibration.selectedStrategyType} rollout=${calibration.rolloutDefault} blastRadius=${calibration.estimatedBlastRadius}`,
                    });

                    const singlePackageRooted = hasRootPackage && modelingDiscovery.packages.length === 1 && models.length === 1;
                    const requiresGlobalRuntimePrompt = strategicMode === "full"
                        && modelingDiscovery.domains.length <= 1
                        && !singlePackageRooted;
                    const runtimeMode = strategicMode === "full"
                        ? (requiresGlobalRuntimePrompt
                            ? await chooseRuntimeMode(
                                calibration.governanceModeRecommendation,
                                `strategy=${calibration.selectedStrategyType}, rollout=${calibration.rolloutDefault}, blastRadius=${calibration.estimatedBlastRadius}`
                            )
                            : (singlePackageRooted
                                ? (models[0]?.runtimeMode ?? calibration.governanceModeRecommendation)
                                : calibration.governanceModeRecommendation))
                        : (currentControl.runtime?.mode ?? calibration.governanceModeRecommendation);

                    if (!runtimeMode) {
                        stream.markdown("Choir init cancelled during runtime governance modeling.");
                        return;
                    }

                    diagnosticsStages.push({
                        stage: "governance-modeling",
                        status: "success",
                        detail: strategicMode !== "full"
                            ? `runtime mode retained for ${strategicMode}: ${runtimeMode}`
                            : (requiresGlobalRuntimePrompt
                                ? `global runtime mode selected: ${runtimeMode}`
                                : (singlePackageRooted
                                    ? `single-package rooted runtime derived from domain modeling: ${runtimeMode}`
                                    : `global runtime mode baseline (auto): ${runtimeMode}; domain runtime modes captured per domain`)),
                    });

                    const runtimeModeForSynthesis = mergeSelection
                        ? (currentControl.runtime?.mode ?? calibration.governanceModeRecommendation)
                        : runtimeMode;

                    const synthesisDiscovery = strategicMode === "expand-domain"
                        ? discovery
                        : modelingDiscovery;

                    const synthesis = synthesizeStrategicControlPlane(currentControl, {
                        mode: strategicMode,
                        mission: missionForSynthesis,
                        vision: visionForSynthesis,
                        runtimeMode: runtimeModeForSynthesis,
                        discovery: synthesisDiscovery,
                        models,
                        calibration,
                    });

                    const nextControl = mergeSelection
                        ? mergeSelectedStrategicDomainsIntoControl(
                            currentControl,
                            synthesis.controlPlane,
                            mergeSelection.selectedPackagePaths,
                            discovery.packages.map((pkg) => pkg.packagePath),
                            hasRootPackage
                        )
                        : synthesis.controlPlane;

                    writeControlPlane(nextControl);
                    writeStrategicInitState(workspaceRoot, {
                        discovery: synthesisDiscovery,
                        models,
                        synthesis: synthesis.report,
                        previous: readStrategicInitState(workspaceRoot),
                    });

                    diagnosticsStages.push({
                        stage: "control-plane-generation",
                        status: "success",
                        detail: `generated runId=${synthesis.report.runId}`,
                    });

                    appendPipelineDiagnosticsRecordIfPossible(workspaceRoot, {
                        command: `choir init${strategicMode !== "full" ? ` --${strategicMode}` : ""}`,
                        source: "chat",
                        category: "pipeline",
                        result: "success",
                        summary: `Strategic init completed: ${modelingDiscovery.domains.length} domains, mode=${strategicMode}, runtime=${runtimeModeForSynthesis}`,
                        stages: diagnosticsStages,
                        metadata: {
                            strategicInit: {
                                mode: strategicMode,
                                template: strategicTemplate ?? "none",
                                workspaceType: discovery.workspace.type,
                                packageCount: discovery.packages.length,
                                domainCount: modelingDiscovery.domains.length,
                                runtimeMode: runtimeModeForSynthesis,
                                calibration,
                                report: synthesis.report,
                                initApplyMode,
                                commandsApplied,
                            },
                        },
                    });

                    stream.markdown([
                        "Choir strategic init completed.",
                        `- mode: ${strategicMode}`,
                        `- template: ${strategicTemplate ?? "none"}`,
                        `- workspace: ${discovery.workspace.type}`,
                        `- packages: ${discovery.packages.length}`,
                        `- domains: ${modelingDiscovery.domains.length}`,
                        `- selectedStrategy: ${calibration.selectedStrategyType}`,
                        `- rolloutDefault: ${calibration.rolloutDefault}`,
                        `- runtimeMode: ${runtimeModeForSynthesis}`,
                        `- blastRadiusEstimate: ${calibration.estimatedBlastRadius}`,
                        `- topologyHash: ${synthesis.report.topologyHash}`,
                        `- strategicHash: ${synthesis.report.strategicHash}`,
                        `- calibrationHash: ${synthesis.report.calibrationHash}`,
                    ].join("\n"));
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    appendPipelineDiagnosticsRecordIfPossible(workspaceRoot, {
                        command: `choir init${strategicMode !== "full" ? ` --${strategicMode}` : ""}`,
                        source: "chat",
                        category: "pipeline",
                        result: "failure",
                        summary: `Strategic init failed: ${message}`,
                        stages: [...diagnosticsStages, {
                            stage: "strategic-modeling",
                            status: "failure",
                            detail: message,
                        }],
                    });
                    stream.markdown(`Strategic init failed: ${message}`);
                }

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

            if (verifyChatCommand) {
                const workspaceRoot = getWorkspaceRoot() ?? undefined;

                try {
                    const report = await runRuntimeVerification({
                        mode: verifyChatCommand.mode,
                        workspaceRoot,
                        chaosMode: verifyChatCommand.chaosMode,
                    });
                    stream.markdown(formatRuntimeVerificationReport(report));
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    stream.markdown(`Verification failed: ${message}`);
                }

                return;
            }

            if (cliInstallChatCommand) {
                const scopeChoice = await vscode.window.showQuickPick([
                    {
                        label: "Install locally (recommended)",
                        description: "npm install --save-dev <package-source>",
                        scope: "local" as const,
                    },
                    {
                        label: "Install globally",
                        description: "npm install -g <package-source>",
                        scope: "global" as const,
                    },
                    {
                        label: "Cancel",
                        description: "Do not run any install command",
                        scope: "cancel" as const,
                    },
                ], {
                    title: "Install Choir CLI",
                    placeHolder: "Choose install scope",
                    ignoreFocusOut: true,
                });

                if (!scopeChoice || scopeChoice.scope === "cancel") {
                    stream.markdown("Choir CLI install cancelled.");
                    return;
                }

                const packageInput = await vscode.window.showInputBox({
                    title: "Choir CLI package source",
                    prompt: "Enter explicit package source (for example @your-org/choir-cli or github:owner/repo#tag)",
                    placeHolder: "@your-org/choir-cli",
                    ignoreFocusOut: true,
                });

                if (typeof packageInput !== "string") {
                    stream.markdown("Choir CLI install cancelled.");
                    return;
                }

                const packageSpec = normalizeCliPackageSpec(packageInput);
                const validation = validateCliPackageSpec(packageSpec);
                if (!validation.ok) {
                    stream.markdown(`Choir CLI install blocked: ${validation.reason}`);
                    return;
                }

                const workspaceRoot = getWorkspaceRoot();
                if (!workspaceRoot) {
                    stream.markdown("No workspace folder found.");
                    return;
                }

                const command = buildCliInstallCommand(scopeChoice.scope, packageSpec);

                const terminal = vscode.window.createTerminal({
                    name: "Choir CLI Install",
                    cwd: workspaceRoot,
                });
                terminal.show(true);
                terminal.sendText(command, true);

                stream.markdown([
                    "Choir CLI install command started in terminal.",
                    `- scope: ${scopeChoice.scope}`,
                    `- package: ${packageSpec}`,
                    `- command: ${command}`,
                    "- verify after install: choir --help",
                ].join("\n"));
                return;
            }

            if (exportChatCommand) {
                if (exportChatCommand.type === "export-error") {
                    stream.markdown(`Unsupported export format: ${exportChatCommand.format}. Supported formats: json.`);
                    return;
                }

                const control = readControlPlane();
                if (!control) {
                    stream.markdown(missingControlPlaneMessage());
                    return;
                }

                const controlPath = getControlPlanePath();
                if (!controlPath) {
                    stream.markdown("Unable to resolve .choir/choir.config.yaml.");
                    return;
                }

                const root = path.dirname(controlPath);
                const fileName = "choir.config.json";
                const outputPath = path.join(root, fileName);
                const json = `${JSON.stringify(control, null, 2)}\n`;
                fs.writeFileSync(outputPath, json, "utf-8");

                stream.markdown([
                    "JSON exported successfully.",
                    `- path: .choir/${fileName}`,
                    "",
                    "```json",
                    json.trimEnd(),
                    "```",
                ].join("\n"));
                return;
            }

            const goalMutationChatCommand = parseGoalMutationChatCommand(raw);
            if (goalMutationChatCommand) {
                if (goalMutationChatCommand.type === "remove-goal-error") {
                    stream.markdown("Invalid goal removal command. Provide a non-empty goal after `remove goal`.");
                    return;
                }

                const control = readControlPlane();
                if (!control) {
                    stream.markdown(missingControlPlaneMessage());
                    return;
                }

                const controlPath = getControlPlanePath();
                if (!controlPath) {
                    stream.markdown("Unable to resolve .choir/choir.config.yaml.");
                    return;
                }

                const currentGoals = control.intent.goals;
                const nextGoals = currentGoals.filter((goal) => goal !== goalMutationChatCommand.goal);
                if (nextGoals.length === currentGoals.length) {
                    stream.markdown(`No changes. Goal not found: ${goalMutationChatCommand.goal}`);
                    return;
                }

                const updatedControl = {
                    ...control,
                    intent: {
                        ...control.intent,
                        goals: nextGoals,
                    },
                };

                writeControlPlane(updatedControl);
                stream.markdown("YAML updated successfully: .choir/choir.config.yaml");
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
                        stream.markdown(missingControlPlaneMessage());
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
            const normalizedDSLInput = normalizeChatDSLInput(raw);
            try {
                parsed = parseCommand(normalizedDSLInput);
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
                    || action.type === "rollback"
                    || (action.type === "plan" && action.optimize === true)
                    || (action.type === "plan" && action.adaptive === true)
                    || (action.type === "execute" && action.rolloutStrategy !== undefined)
                )
            ) {
                stream.markdown("Invalid Choir DSL command. `export|approve|reject|policy status|import|library|ci|abstraction|audit|macro|graph|simulate|refactor|rollback|plan --optimize|plan --adaptive|execute --strategy` cannot be chained with `then`.");
                return;
            }

            const control = readControlPlane();
            if (!control) {
                stream.markdown(missingControlPlaneMessage());
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
                // Enforce fail-closed compilation gates before any command-specific behavior.
                compileInput(normalizedDSLInput, control);

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
                    const governance = evaluateRuntimeGovernance({
                        controlPlane: control,
                        capability: "import",
                    });
                    if (governance.decision !== "allow") {
                        stream.markdown(renderRuntimeGovernanceBlocked({
                            mode: governance.mode,
                            capability: "import",
                            decision: governance.decision,
                            reason: governance.reason,
                        }));
                        return;
                    }

                    const spec = `${parsed.ast.library}@${parsed.ast.versionSelector}`;
                    const imported = importLibrary(workspaceRoot, spec);
                    stream.markdown([
                        `import:`,
                        `  library: ${imported.library}`,
                        `  selector: ${imported.selector}`,
                        `  resolvedVersion: ${imported.resolvedVersion}`,
                        `  status: ${imported.status}`,
                    ].join("\n"));
                    return;
                }

                if (parsed.ast.type === "library-install") {
                    const governance = evaluateRuntimeGovernance({
                        controlPlane: control,
                        capability: "install",
                    });
                    if (governance.decision !== "allow") {
                        stream.markdown(renderRuntimeGovernanceBlocked({
                            mode: governance.mode,
                            capability: "install",
                            decision: governance.decision,
                            reason: governance.reason,
                        }));
                        return;
                    }

                    const spec = `${parsed.ast.library}@${parsed.ast.versionSelector}`;
                    const installed = installLibrary(workspaceRoot, spec);
                    stream.markdown([
                        `Library installed: ${installed.library}`,
                        `- requested: ${installed.requested}`,
                        `- resolved: ${installed.resolvedVersion}`,
                        "- lockfile: choir.lock",
                        `- materialized: .choir/libraries/${installed.library}/manifest.yaml`,
                    ].join("\n"));
                    return;
                }

                if (parsed.ast.type === "library-update") {
                    const governance = evaluateRuntimeGovernance({
                        controlPlane: control,
                        capability: "update",
                    });
                    if (governance.decision !== "allow") {
                        stream.markdown(renderRuntimeGovernanceBlocked({
                            mode: governance.mode,
                            capability: "update",
                            decision: governance.decision,
                            reason: governance.reason,
                        }));
                        return;
                    }

                    const updated = updateLibrary(workspaceRoot, parsed.ast.library);
                    stream.markdown([
                        `Library updated: ${updated.library}`,
                        `- resolved: ${updated.resolvedVersion}`,
                        "- lockfile: choir.lock",
                    ].join("\n"));
                    return;
                }

                if (parsed.ast.type === "library-lock") {
                    const locked = lockChoirLibraries(workspaceRoot);
                    const lines = Object.entries(locked.libraries)
                        .sort(([left], [right]) => left.localeCompare(right))
                        .map(([library, entry]) => `- ${library}: ${entry.version} (${entry.selector}, ${entry.integrityHash})`);

                    stream.markdown([
                        "Library lock refreshed.",
                        ...(lines.length > 0 ? lines : ["- no locked libraries"]),
                    ].join("\n"));
                    return;
                }

                if (parsed.ast.type === "library-list") {
                    const catalog = listLibraryCatalog(workspaceRoot);
                    const lock = readMacroLock(workspaceRoot);

                    if (catalog.length === 0) {
                        stream.markdown("No local macro libraries found under `.choir/libraries`.");
                        return;
                    }

                    const lines = catalog.map((entry) => {
                        const locked = lock.libraries[entry.id];
                        const versionList = entry.versions.join(", ");
                        const selectorList = entry.selectors.join(", ");
                        const capabilityCount = entry.capabilities.length;
                        return locked
                            ? `- ${entry.id}: versions=[${versionList}] selectors=[${selectorList}] capabilities=${capabilityCount} compatibility=${entry.compatibility} (locked=${locked})`
                            : `- ${entry.id}: versions=[${versionList}] selectors=[${selectorList}] capabilities=${capabilityCount} compatibility=${entry.compatibility}`;
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
                    try {
                        const runtime = await runOrchestrationPipeline("optimize", {
                            root: workspaceRoot,
                            controlPlane: control,
                            command: normalizedDSLInput,
                            ...(planNode.target ? { targetGoal: planNode.target } : {}),
                        });
                        const optimized = runtime.optimized;
                        const persistedControl = persistSelectedOptimizedPlan(control, optimized.selectedExecutionPlan);
                        writeControlPlane(persistedControl);

                        const rankingLines = optimized.rankedPlans.map((entry) =>
                            `- ${entry.rank}. ${entry.strategyId} (policy=${entry.policyDecision}, risk=${entry.riskScore}, dependencyRisk=${entry.dependencyRisk}, blastRadius=${entry.blastRadius}, rollbackComplexity=${entry.rollbackComplexity}, executionCost=${entry.executionCost}, changes=${entry.changeCount})`
                        );

                        const stageLines = optimized.stageResults
                            .map((stage) => {
                                const status = stage.status === "success" ? "ok" : "fail";
                                return `- [${status}] ${stage.stage}: ${stage.detail}`;
                            });

                        const executionLines = optimized.executionStages.length === 0
                            ? ["- none"]
                            : optimized.executionStages.map((stage) =>
                                `- ${stage.order}. ${stage.id} (parallel=${stage.parallelizable}, units=[${stage.units.join(", ")}])`
                            );

                        stream.markdown([
                            "Plan optimization complete.",
                            `- selectedPlan: ${optimized.selectedPlan.id}`,
                            `- persistedPlan: ${optimized.selectedExecutionPlan.id}`,
                            `- strategy: ${optimized.selectedPlan.strategyId}`,
                            `- synthesized: ${optimized.selectedPlan.synthesized}`,
                            `- policyDecision: ${optimized.policyDecision}`,
                            `- planHash: ${optimized.planHash}`,
                            `- simulationHash: ${optimized.simulationHash}`,
                            `- rollbackScopeComplexity: ${optimized.rollbackScope.complexity}`,
                            `- candidates: ${optimized.rankedPlans.length}`,
                            "",
                            "Pipeline stages:",
                            ...stageLines,
                            "",
                            "Execution stages:",
                            ...executionLines,
                            "",
                            "Ranking:",
                            ...rankingLines,
                        ].join("\n"));
                    } catch (error) {
                        if (error instanceof OrchestrationPipelineError) {
                            const stageLines = error.stageResults.map((stage) => {
                                const status = stage.status === "success" ? "ok" : "fail";
                                return `- [${status}] ${stage.stage}: ${stage.detail}`;
                            });

                            stream.markdown([
                                "Plan optimization failed.",
                                `- stage: ${error.failedStage}`,
                                "",
                                ...stageLines,
                            ].join("\n"));
                            return;
                        }

                        throw error;
                    }
                    return;
                }

                if (parsed.ast.type === "plan" && parsed.ast.adaptive) {
                    const planNode = parsed.ast;
                    const adaptive = await evaluateAdaptivePlanSelection(control, {
                        root: workspaceRoot,
                        ...(planNode.target ? { targetGoal: planNode.target } : {}),
                    });

                    const adaptiveTrace = adaptive.strategyTrace.adaptive;
                    const evaluatedCount = adaptive.outcomes.length;
                    const iterations = adaptiveTrace?.iterations ?? 1;
                    const evaluatedTotal = adaptiveTrace?.strategiesEvaluated ?? evaluatedCount;
                    const mutationCount = adaptiveTrace?.mutationsApplied ?? 0;
                    const memoryMode = adaptive.memoryTrace.reused ? "memory" : "adaptive-generation";
                    const decisionLines = (adaptiveTrace?.decisions ?? [adaptive.strategyTrace.decision])
                        .slice(-8)
                        .map((decision) => `- ${decision}`);

                    stream.markdown([
                        "Adaptive strategy planning complete.",
                        `- plan: ${adaptive.basePlan.id}`,
                        `- selectedStrategy: ${adaptive.selected.strategyId}`,
                        `- source: ${memoryMode}`,
                        `- iterations: ${iterations}`,
                        `- evaluatedStrategies: ${evaluatedTotal}`,
                        `- uniqueOutcomes: ${evaluatedCount}`,
                        `- mutationsApplied: ${mutationCount}`,
                        "",
                        "Decision trace:",
                        ...decisionLines,
                    ].join("\n"));
                    return;
                }

                if (parsed.ast.type === "execute") {
                    const executeNode = parsed.ast;
                    try {
                        const runtime = await runOrchestrationPipeline("execute", {
                            root: workspaceRoot,
                            controlPlane: control,
                            command: normalizedDSLInput,
                            ...(executeNode.planRef ? { requestedPlanId: executeNode.planRef.identifier } : {}),
                            ...(executeNode.previewRef ? { requestedPreviewRef: executeNode.previewRef } : {}),
                            ...(executeNode.rolloutStrategy ? { rolloutStrategy: executeNode.rolloutStrategy } : {}),
                        });

                        if (!runtime.execute) {
                            stream.markdown("Execution unavailable: unified orchestration runtime did not return execution output.");
                            return;
                        }

                        const stageLines = runtime.stageResults
                            .map((stage) => {
                                const status = stage.status === "success" ? "ok" : "fail";
                                return `- [${status}] ${stage.stage}: ${stage.detail}`;
                            });

                        const executionStageLines = runtime.execute.executionStages.length === 0
                            ? ["- none"]
                            : runtime.execute.executionStages.map((stage) =>
                                `- ${stage.order}. ${stage.id} (units=[${stage.units.join(", ")}])`
                            );

                        stream.markdown([
                            runtime.execute.success ? "Execution successful." : "Execution failed.",
                            `- mode: execute`,
                            `- plan: ${runtime.execute.planId} (${runtime.execute.planSource})`,
                            `- selectionStrategy: ${runtime.execute.strategyId}`,
                            `- rolloutStrategy: ${runtime.execute.rolloutStrategy}`,
                            `- transactionId: ${runtime.execute.transactionId}`,
                            `- executionHash: ${runtime.execute.executionHash}`,
                            `- finalStateHash: ${runtime.execute.finalStateHash}`,
                            `- replayHash: ${runtime.execute.replayHash}`,
                            `- simulationFutureStateHash: ${runtime.execute.simulationFutureStateHash}`,
                            `- policyDecision: ${runtime.policy.decision}`,
                            `- approvalRequired: ${runtime.approval.required}`,
                            `- approvalSatisfied: ${runtime.approval.approved}`,
                            "",
                            "Pipeline stages:",
                            ...stageLines,
                            "",
                            "Execution stages:",
                            ...executionStageLines,
                        ].join("\n"));
                    } catch (error) {
                        if (error instanceof OrchestrationPipelineError) {
                            const stageLines = error.stageResults.map((stage) => {
                                const status = stage.status === "success" ? "ok" : "fail";
                                return `- [${status}] ${stage.stage}: ${stage.detail}`;
                            });

                            stream.markdown([
                                "Execution failed.",
                                `- stage: ${error.failedStage}`,
                                "",
                                ...stageLines,
                            ].join("\n"));
                            return;
                        }

                        throw error;
                    }
                    return;
                }

                if (parsed.ast.type === "rollback") {
                    const rollbackNode = parsed.ast;
                    const configuredPlans = [...control.execution.plans]
                        .sort((left, right) => left.id.localeCompare(right.id));

                    if (configuredPlans.length === 0) {
                        stream.markdown("Rollback unavailable: no execution plans defined in control plane.");
                        return;
                    }

                    const targetPlan = configuredPlans.find((plan) => plan.status === "approved") ?? configuredPlans[0];
                    if (!targetPlan) {
                        stream.markdown("Rollback unavailable: unable to resolve a deterministic target plan.");
                        return;
                    }

                    const globalPlan = toGlobalPlanFromPlan(targetPlan);
                    const dependencyGraph = buildRollbackDependencyGraph(globalPlan);
                    const allUnits = sortedUnique(globalPlan.tasks.map((task) => task.repoId));
                    if (allUnits.length === 0) {
                        stream.markdown("Rollback unavailable: selected plan has no workspace units.");
                        return;
                    }

                    const executionState = {
                        units: Object.fromEntries(allUnits.map((unit) => [unit, "executed" as const])),
                    };

                    let workUnitBindings = buildWorkUnitBindingsForPlan(targetPlan);
                    workUnitBindings = mergeWorkUnitBindings(workUnitBindings, readTraceWorkUnitBindings(workspaceRoot));

                    if (rollbackNode.unitId?.startsWith("wu-") && !workUnitBindings[rollbackNode.unitId]) {
                        try {
                            const fallback = await runOrchestrationPipeline("optimize", {
                                root: workspaceRoot,
                                controlPlane: control,
                                command: "choir plan --optimize",
                            });

                            if (fallback.optimized) {
                                workUnitBindings = mergeWorkUnitBindings(
                                    workUnitBindings,
                                    buildWorkUnitBindingsForPlan(fallback.optimized.selectedExecutionPlan)
                                );
                            }
                        } catch {
                            // Best-effort fallback only; selector resolution will fail closed below if no mapping is found.
                        }
                    }

                    let failedUnit = rollbackNode.unitId ?? allUnits[allUnits.length - 1] as string;
                    let rollbackSet: string[];
                    let resolvedStageId: string | undefined;
                    let resolvedUnitId: string | undefined;

                    if (rollbackNode.stageId) {
                        const stageStrategy: RolloutStrategy = { type: "batched", batchSize: 1 };
                        const stages = buildStages(globalPlan, stageStrategy);
                        const stageSelection = resolveRollbackStageSelection(rollbackNode.stageId, stages);
                        if (!stageSelection.stage) {
                            const available = stages.slice(0, 5).map((stage) => `- ${stage.id}`).join("\n");
                            stream.markdown([
                                `Rollback stage not found: ${rollbackNode.stageId}`,
                                ...(stageSelection.error ? [stageSelection.error, ""] : []),
                                "",
                                "Available deterministic stage ids (batched=1):",
                                ...(available.length > 0 ? [available] : ["- none"]),
                            ].join("\n"));
                            return;
                        }

                        const selectedStage = stageSelection.stage;
                        resolvedStageId = selectedStage.id;

                        failedUnit = selectedStage.units[0] ?? failedUnit;
                        resolvedUnitId = failedUnit;
                        rollbackSet = sortedUnique(selectedStage.units);
                    } else {
                        if (rollbackNode.unitId) {
                            const unitSelection = resolveRollbackUnitSelection(rollbackNode.unitId, allUnits, {
                                workUnitBindings,
                            });
                            if (!unitSelection.unit) {
                                const availableUnits = allUnits.slice(0, 8).map((unit) => `- ${unit}`).join("\n");
                                const availableWorkUnits = Object.keys(workUnitBindings)
                                    .sort((left, right) => left.localeCompare(right))
                                    .slice(0, 8)
                                    .map((unit) => `- ${unit}`)
                                    .join("\n");
                                stream.markdown([
                                    `Rollback unit not found in selected plan: ${rollbackNode.unitId}`,
                                    ...(unitSelection.error ? [unitSelection.error, ""] : []),
                                    "Available deterministic unit ids:",
                                    ...(availableUnits.length > 0 ? [availableUnits] : ["- none"]),
                                    "",
                                    "Available deterministic work unit ids:",
                                    ...(availableWorkUnits.length > 0 ? [availableWorkUnits] : ["- none"]),
                                ].join("\n"));
                                return;
                            }

                            failedUnit = unitSelection.unit;
                            resolvedUnitId = unitSelection.unit;
                        }

                        rollbackSet = computeRollbackSet(failedUnit, dependencyGraph, executionState);
                    }

                    if (rollbackSet.length === 0) {
                        rollbackSet = [failedUnit];
                    }

                    const isolation = validateIsolation(rollbackSet, dependencyGraph, failedUnit);
                    const rollbackStart = Date.now();
                    const rollbackOrder = orderRollback(rollbackSet, dependencyGraph);
                    const rollbackTrace: RollbackTrace = {
                        failedUnit,
                        rollbackSet,
                        rollbackOrder,
                        duration: Date.now() - rollbackStart,
                    };

                    let rollbackStateTarget: {
                        state: ReturnType<typeof createEmptyStatePlane>;
                        fromHash: string;
                        toHash: string;
                        sourceTransitionId?: string;
                    };

                    try {
                        rollbackStateTarget = resolveDeterministicRollbackTarget(workspaceRoot);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        stream.markdown(`Rollback unavailable: ${message}`);
                        return;
                    }

                    if (rollbackStateTarget.fromHash === rollbackStateTarget.toHash) {
                        stream.markdown("Rollback skipped: no prior state transition available to restore.");
                        return;
                    }

                    persistStatePlane(workspaceRoot, rollbackStateTarget.state, {
                        action: rollbackNode.stageId ? "rollback:stage" : rollbackNode.unitId ? "rollback:unit" : "rollback",
                        metadata: {
                            unitId: failedUnit,
                            command: raw,
                            policyDecision: isolation.valid ? "allow" : "deny",
                            auditId: `rollback-${targetPlan.id}-${failedUnit}-${Date.now()}`,
                            dependencyChain: rollbackOrder,
                        },
                    });

                    stream.markdown([
                        "Rollback isolation trace generated.",
                        `- plan: ${targetPlan.id}`,
                        `- selector: ${rollbackNode.stageId ? `stage=${rollbackNode.stageId}` : rollbackNode.unitId ? `unit=${rollbackNode.unitId}` : "auto"}`,
                        ...(resolvedStageId ? [`- resolvedStageId: ${resolvedStageId}`] : []),
                        ...(resolvedUnitId ? [`- resolvedUnitId: ${resolvedUnitId}`] : []),
                        `- failedUnit: ${rollbackTrace.failedUnit}`,
                        `- rollbackSet: [${rollbackTrace.rollbackSet.join(", ")}]`,
                        `- rollbackOrder: [${rollbackTrace.rollbackOrder.join(", ")}]`,
                        `- durationMs: ${rollbackTrace.duration}`,
                        `- stateHashBefore: ${rollbackStateTarget.fromHash}`,
                        `- stateHashAfter: ${rollbackStateTarget.toHash}`,
                        `- isolationValid: ${isolation.valid}`,
                        ...(isolation.errors.length > 0 ? ["", "Isolation Errors:", ...isolation.errors.map((entry) => `- ${entry}`)] : []),
                    ].join("\n"));
                    return;
                }

                if (
                    parsed.ast.type === "simulate"
                ) {
                    const simulateNode = parsed.ast;
                    try {
                        const runtime = await runOrchestrationPipeline("simulate", {
                            root: workspaceRoot,
                            controlPlane: control,
                            command: normalizedDSLInput,
                            ...(simulateNode.planRef ? { requestedPlanId: simulateNode.planRef.identifier } : {}),
                            ...(simulateNode.units ? { requestedUnits: simulateNode.units } : {}),
                        });

                        if (!runtime.simulate) {
                            stream.markdown("Simulation unavailable: unified orchestration runtime did not return simulation output.");
                            return;
                        }

                        stream.markdown(formatSimulationChatResult({
                            success: runtime.simulate.success,
                            strategyId: runtime.simulate.strategyId,
                            planId: runtime.simulate.planId,
                            planSource: runtime.simulate.planSource,
                            units: runtime.simulate.units,
                            changes: runtime.simulate.changes,
                            violations: runtime.simulate.violations,
                            metrics: runtime.simulate.metrics,
                            policyDecision: runtime.simulate.policy.decision,
                            policyViolations: runtime.simulate.policy.violations,
                            replay: runtime.simulate.replay,
                            hashes: runtime.simulate.hashes,
                            rollbackScope: runtime.simulate.rollbackScope,
                            stageResults: runtime.stageResults,
                        }));
                    } catch (error) {
                        if (error instanceof OrchestrationPipelineError) {
                            const stageLines = error.stageResults
                                .map((stage) => {
                                    const status = stage.status === "success" ? "ok" : "fail";
                                    return `- [${status}] ${stage.stage}: ${stage.detail}`;
                                });

                            stream.markdown([
                                "Simulation failed.",
                                `- stage: ${error.failedStage}`,
                                "",
                                ...stageLines,
                            ].join("\n"));
                            return;
                        }

                        throw error;
                    }
                    return;
                }

                if (parsed.ast.type === "preview") {
                    const previewNode = parsed.ast;
                    try {
                        const runtime = await runOrchestrationPipeline("preview", {
                            root: workspaceRoot,
                            controlPlane: control,
                            command: normalizedDSLInput,
                            ...(previewNode.planRef ? { requestedPlanId: previewNode.planRef.identifier } : {}),
                            persistPreviewState: true,
                            recordPendingApproval: true,
                        });

                        if (!runtime.preview) {
                            stream.markdown("Preview synthesis failed: unified orchestration runtime did not return preview payload.");
                            return;
                        }

                        const stageLines = runtime.stageResults
                            .map((stage) => {
                                const statusLabel = stage.status === "success" ? "ok" : "fail";
                                return `- [${statusLabel}] ${stage.stage}: ${stage.detail}`;
                            });

                        const executionStageLines = runtime.optimized.executionStages.length === 0
                            ? ["- none"]
                            : runtime.optimized.executionStages.map((stage, index) => {
                                return `- ${index + 1}. ${stage.id} (parallel=${stage.parallelizable}, units=${stage.units.length})${stage.units.length > 0 ? ` [${stage.units.join(", ")}]` : ""}`;
                            });

                        const diffLines = runtime.preview.fileChanges.length === 0
                            ? ["No file deltas were produced during simulation."]
                            : runtime.preview.fileChanges.slice(0, 5).flatMap((change) => [
                                `File: ${change.file}`,
                                "```diff",
                                change.diff,
                                "```",
                            ]);

                        const approvalLine = runtime.approval.required
                            ? runtime.approval.approved
                                ? "required and satisfied"
                                : `required and pending${runtime.approval.pendingId ? ` (${runtime.approval.pendingId})` : ""}`
                            : control.runtime?.mode === "approval-required"
                                ? "not required for preview (execute requires approval)"
                                : "not required";

                        const violationLines = runtime.policy.violations.length === 0
                            ? ["- none"]
                            : runtime.policy.violations.map((entry) => `- [${entry.ruleId}] ${entry.message}`);

                        stream.markdown([
                            "Preview synthesized (read-only execution contract).",
                            `- plan: ${runtime.selectedPlanId} (${runtime.planSource})`,
                            `- basePlan: ${runtime.selectedPlanId}`,
                            `- strategy: ${runtime.selectedStrategyType}`,
                            `- previewHash: ${runtime.preview.previewHash}`,
                            `- simulationHash: ${runtime.preview.simulationHash}`,
                            `- stateHash: ${runtime.preview.stateHash}`,
                            `- filesChanged: ${runtime.preview.summary.filesChanged}`,
                            `- patches: ${runtime.preview.summary.patchesCount}`,
                            `- remainingViolations: ${runtime.preview.summary.remainingViolations}`,
                            `- introducedErrors: ${runtime.preview.summary.introducedErrors}`,
                            `- policyDecision: ${runtime.policy.decision}`,
                            `- approval: ${approvalLine}`,
                            "",
                            "Pipeline stages:",
                            ...stageLines,
                            "",
                            "Execution stages:",
                            ...executionStageLines,
                            "",
                            "Policy violations:",
                            ...violationLines,
                            "",
                            ...diffLines,
                        ].join("\n"));
                    } catch (error) {
                        if (error instanceof OrchestrationPipelineError) {
                            const stageLines = error.stageResults.map((stage) => {
                                const statusLabel = stage.status === "success" ? "ok" : "fail";
                                return `- [${statusLabel}] ${stage.stage}: ${stage.detail}`;
                            });

                            stream.markdown([
                                "Preview synthesis failed.",
                                `- failedStage: ${error.failedStage}`,
                                "",
                                ...stageLines,
                            ].join("\n"));
                            return;
                        }

                        throw error;
                    }
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
                            ...(parsed.ast.declarationSelector !== undefined
                                ? { declarationSelector: parsed.ast.declarationSelector }
                                : {}),
                        }
                        : parsed.ast.type === "refactor-move"
                            ? {
                                type: "move" as const,
                                symbol: parsed.ast.symbol,
                                from: "*",
                                ...(parsed.ast.targetUnit !== undefined
                                    ? { to: parsed.ast.targetUnit }
                                    : {}),
                                ...(parsed.ast.targetFile !== undefined
                                    ? { targetFile: parsed.ast.targetFile }
                                    : {}),
                            }
                            : parsed.ast.type === "refactor-extract"
                                ? {
                                    type: "extract" as const,
                                    symbol: parsed.ast.symbol,
                                    ...(parsed.ast.targetUnit !== undefined
                                        ? { targetUnit: parsed.ast.targetUnit }
                                        : {}),
                                    ...(parsed.ast.targetFile !== undefined
                                        ? { targetFile: parsed.ast.targetFile }
                                        : {}),
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

                if (parsed.ast.type === "status") {
                    const mission = control.mission.trim();
                    const vision = control.vision.trim();
                    const plans = control.execution.plans;
                    const approvedPlans = plans.filter((plan) => plan.status === "approved").length;
                    const draftPlans = plans.length - approvedPlans;
                    const pending = policyStatus(workspaceRoot).pending;

                    let state = null;
                    let stateReadError: string | undefined;
                    try {
                        state = readStatePlane(workspaceRoot);
                    } catch (error) {
                        stateReadError = error instanceof Error ? error.message : String(error);
                    }

                    const executionStatuses = state
                        ? Object.values(state.execution.taskStatus)
                        : [];

                    const pendingTasks = executionStatuses.filter((status) => status === "pending").length;
                    const inProgressTasks = executionStatuses.filter((status) => status === "in-progress").length;
                    const completedTasks = executionStatuses.filter((status) => status === "complete").length;
                    const failedTasks = executionStatuses.filter((status) => status === "failed").length;

                    stream.markdown([
                        "Choir status",
                        "",
                        "Control plane:",
                        `- mission: ${mission.length > 0 ? mission : "(empty)"}`,
                        `- vision: ${vision.length > 0 ? vision : "(empty)"}`,
                        `- goals: ${control.intent.goals.length}`,
                        `- constraints: ${control.intent.constraints.length}`,
                        `- non-goals: ${control.intent["non-goals"].length}`,
                        `- policyRules: ${control.policy.rules.length}`,
                        `- plans: ${plans.length} (approved=${approvedPlans}, draft=${draftPlans})`,
                        "",
                        "Approvals:",
                        `- pendingPolicyApprovals: ${pending.length}`,
                        "",
                        "State plane:",
                        stateReadError
                            ? `- state: invalid (${stateReadError})`
                            : state
                                ? "- state: present"
                                : "- state: missing",
                        state ? `- stateHash: ${state.stateHash}` : "- stateHash: n/a",
                        state ? `- violations: ${state.violations.length}` : "- violations: n/a",
                        state ? `- executionActivePlan: ${state.execution.activePlanId ?? "none"}` : "- executionActivePlan: n/a",
                        state
                            ? `- taskStatus: pending=${pendingTasks}, in-progress=${inProgressTasks}, complete=${completedTasks}, failed=${failedTasks}`
                            : "- taskStatus: n/a",
                    ].join("\n"));
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

                const compiled = compileDSLAndWrite(normalizedDSLInput, control, controlPath, {
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
                    const analyzeTarget = extractAnalyzeTarget(compiled.trace.ast);
                    if (analyzeTarget) {
                        renderAnalyzeResult(stream, analyzeTarget);
                    } else {
                        stream.markdown("No changes. YAML already reflects this DSL command.");
                    }
                } else {
                    stream.markdown("YAML updated successfully: .choir/choir.config.yaml");
                }

                renderTrace(stream, compiled.trace);
            } catch (error) {
                if (error instanceof CompilerPipelineError) {
                    stream.markdown([
                        "Invalid Choir DSL command.",
                        "",
                        formatCompilerErrors(error.errors),
                        "",
                        "Grammar:",
                        "```bnf",
                        CHOIR_DSL_GRAMMAR,
                        "```",
                    ].join("\n"));
                    return;
                }

                const libraryFailure = parseLibraryFailure(error);
                if (libraryFailure) {
                    stream.markdown([
                        "library:",
                        `  status: ${libraryFailure.status}`,
                        `  stage: ${libraryFailure.stage}`,
                        `  message: ${libraryFailure.message}`,
                    ].join("\n"));
                    return;
                }

                const message = error instanceof Error ? error.message : String(error);
                stream.markdown([
                    "Choir command failed.",
                    "",
                    `Error: ${message}`,
                ].join("\n"));
            }
        }
    );
}
