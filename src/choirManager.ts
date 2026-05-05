import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ControlPlane, ControlPlaneSchema, CONTROL_PLANE_VERSION } from "./schema.js";
import * as YAML from "yaml";

type UnknownRecord = Record<string, unknown>;

function getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function getChoirPath(): string | undefined {
    const root = getWorkspaceRoot();
    if (!root) return undefined;
    return path.join(root, ".choir");
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

    const legacyNonGoals = Array.isArray(base["non-goals"])
        ? (base["non-goals"] as unknown[]).filter((item): item is string => typeof item === "string")
        : [];

    const intent = isRecord(base.intent) ? { ...base.intent } : {};
    const intentNonGoals = Array.isArray(intent["non-goals"])
        ? (intent["non-goals"] as unknown[]).filter((item): item is string => typeof item === "string")
        : [];

    normalizedBase.intent = {
        ...intent,
        "non-goals": intentNonGoals.length > 0 ? intentNonGoals : legacyNonGoals,
    };

    delete normalizedBase["non-goals"];

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

    if (!fs.existsSync(controlPath)) {
        const initial = createDefaultControlPlane();
        writeControlPlane(initial);
        return initial;
    }

    const raw = fs.readFileSync(controlPath, "utf-8");
    return normalizeControlPlane(YAML.parse(raw));
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
            rules: []
        },
        execution: {
            plans: []
        }
    };
}