import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ControlPlane, ControlPlaneSchema, CONTROL_PLANE_VERSION } from "./schema.js";
import * as YAML from "yaml";
import { isRecord } from "./utils/guards.js";
import { cloneJson } from "./utils/clone.js";

type UnknownRecord = Record<string, unknown>;

type IssueLike = {
    message?: unknown;
    path?: unknown;
};

function firstIssueErrorDetails(error: unknown): string | null {
    if (typeof error !== "object" || error === null) {
        return null;
    }

    const record = error as { issues?: unknown };
    if (!Array.isArray(record.issues) || record.issues.length === 0) {
        return null;
    }

    const firstIssue = record.issues[0] as IssueLike;
    const issueMessage = typeof firstIssue?.message === "string" ? firstIssue.message : "Invalid value";

    if (!Array.isArray(firstIssue?.path) || firstIssue.path.length === 0) {
        return issueMessage;
    }

    const issuePath = firstIssue.path.map((segment) => String(segment)).join(".");
    return `${issueMessage} at ${issuePath}`;
}

export function describeControlPlaneLoadError(error: unknown, controlPath: string): string {
    const message = error instanceof Error ? error.message : String(error);

    // Keep previously formatted control-plane errors stable when rethrown.
    if (message.startsWith("Invalid control plane schema in ") || message.startsWith("Unable to parse ")) {
        return message;
    }

    const zodIssue = firstIssueErrorDetails(error);
    if (zodIssue) {
        return `Invalid control plane schema in ${controlPath}: ${zodIssue}`;
    }

    return `Unable to parse ${controlPath}: ${message}`;
}

function getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        return undefined;
    }

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
        const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
        if (activeFolder) {
            return activeFolder.uri.fsPath;
        }
    }

    return folders[0]?.uri.fsPath;
}

function getWorkspaceRootsByPreference(): string[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        return [];
    }

    const roots: string[] = [];
    const seen = new Set<string>();
    const pushRoot = (root: string | undefined) => {
        if (!root || seen.has(root)) {
            return;
        }
        seen.add(root);
        roots.push(root);
    };

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
        const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
        pushRoot(activeFolder?.uri.fsPath);
    }

    for (const folder of folders) {
        pushRoot(folder.uri.fsPath);
    }

    return roots;
}

const DEFAULT_POLICIES_DSL = [
    "# Choir Policy DSL",
    "# Define policies using:",
    "# policy <id> { when ... then allow|deny|require-approval }",
    "",
].join("\n");

export function getChoirPath(): string | undefined {
    const root = getWorkspaceRoot();
    if (!root) return undefined;
    return path.join(root, ".choir");
}

export function getPoliciesDSLPath(): string | null {
    const choirPath = getChoirPath();
    if (!choirPath) {
        return null;
    }

    return path.join(choirPath, "policies.dsl");
}

function ensurePoliciesDSLFile(): void {
    const policiesPath = getPoliciesDSLPath();
    if (!policiesPath) {
        return;
    }

    if (fs.existsSync(policiesPath)) {
        return;
    }

    fs.mkdirSync(path.dirname(policiesPath), { recursive: true });
    fs.writeFileSync(policiesPath, DEFAULT_POLICIES_DSL, "utf-8");
}

function normalizedVersion(input: UnknownRecord): string {
    const version = input.version;
    return typeof version === "string" && version.trim().length > 0
        ? version
        : CONTROL_PLANE_VERSION;
}

function normalizeControlPlane(input: unknown): ControlPlane {
    const base = isRecord(input) ? input : {};
    const normalizedBase: UnknownRecord = { ...base };

    const intent = isRecord(base.intent) ? { ...base.intent } : {};
    const intentNonGoals = Array.isArray(intent["non-goals"])
        ? (intent["non-goals"] as unknown[]).filter((item): item is string => typeof item === "string")
        : [];

    normalizedBase.intent = {
        ...intent,
        "non-goals": intentNonGoals,
    };

    return ControlPlaneSchema.parse({
        ...normalizedBase,
        version: normalizedVersion(base),
    });
}

export function getControlPlanePath(): string | null {
    const roots = getWorkspaceRootsByPreference();
    if (roots.length === 0) {
        return null;
    }

    for (const root of roots) {
        const choirPath = path.join(root, ".choir");
        const yamlPath = path.join(choirPath, "choir.config.yaml");
        if (fs.existsSync(yamlPath)) {
            return yamlPath;
        }

        const ymlPath = path.join(choirPath, "choir.config.yml");
        if (fs.existsSync(ymlPath)) {
            return ymlPath;
        }
    }

    const preferredRoot = roots[0];
    if (!preferredRoot) {
        return null;
    }

    return path.join(preferredRoot, ".choir", "choir.config.yaml");
}

export function readControlPlane(): ControlPlane | null {
    const controlPath = getControlPlanePath();
    if (!controlPath) return null;

    ensurePoliciesDSLFile();

    if (!fs.existsSync(controlPath)) {
        return null;
    }

    try {
        const raw = fs.readFileSync(controlPath, "utf-8");
        return normalizeControlPlane(YAML.parse(raw));
    } catch (error) {
        const wrapped = new Error(describeControlPlaneLoadError(error, controlPath));
        (wrapped as Error & { cause?: unknown }).cause = error;
        throw wrapped;
    }
}

export function writeControlPlane(data: ControlPlane) {
    const controlPath = getControlPlanePath();
    if (!controlPath) {
        return;
    }

    const validated = normalizeControlPlane(data);

    fs.mkdirSync(path.dirname(controlPath), { recursive: true });
    fs.writeFileSync(controlPath, YAML.stringify(validated), "utf-8");
}

export function updateControlPlane(updater: (current: ControlPlane) => ControlPlane): ControlPlane | null {
    const current = readControlPlane();
    if (!current) {
        return null;
    }

    // Serialize + parse to ensure immutable update input and deterministic writes.
    const clone = cloneJson(current);
    const updated = updater(clone);
    writeControlPlane(updated);
    return updated;
}

export function createDefaultControlPlane(): ControlPlane {
    return {
        version: CONTROL_PLANE_VERSION,
        registries: ["local", "org"],
        mission: "",
        vision: "",
        intent: {
            goals: [],
            constraints: [],
            "non-goals": []
        },
        policy: {
            rules: [],
        },
        execution: {
            plans: []
        }
    };
}