import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ControlPlane, ControlPlaneSchema, CONTROL_PLANE_VERSION } from "./schema.js";
import * as YAML from "yaml";

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
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
    const choirPath = getChoirPath();
    if (!choirPath) {
        return null;
    }

    return path.join(choirPath, "choir.config.yaml");
}

export function readControlPlane(): ControlPlane | null {
    const controlPath = getControlPlanePath();
    if (!controlPath) return null;

    ensurePoliciesDSLFile();

    if (!fs.existsSync(controlPath)) {
        const initial = createDefaultControlPlane();
        writeControlPlane(initial);
        return initial;
    }

    try {
        const raw = fs.readFileSync(controlPath, "utf-8");
        return normalizeControlPlane(YAML.parse(raw));
    } catch (error) {
        throw new Error(describeControlPlaneLoadError(error, controlPath));
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
    const clone = JSON.parse(JSON.stringify(current)) as ControlPlane;
    const updated = updater(clone);
    writeControlPlane(updated);
    return updated;
}

export function createDefaultControlPlane(): ControlPlane {
    return {
        version: CONTROL_PLANE_VERSION,
        mission: "",
        vision: "",
        intent: {
            goals: [],
            constraints: [],
            "non-goals": []
        },
        policy: {
            rules: [],
            approvalRules: [],
        },
        execution: {
            plans: []
        }
    };
}