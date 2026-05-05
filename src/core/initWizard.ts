import fs from "fs";
import path from "path";

export type InitTemplateName = "backend" | "frontend";

export type WizardStep =
  | "mission"
  | "vision"
  | "goals"
  | "constraints"
  | "non-goals"
  | "review"
  | "confirm";

export type WizardState = {
  currentStep: WizardStep;
  data: {
    mission?: string;
    vision?: string;
    goals: string[];
    constraints: string[];
    nonGoals: string[];
  };
};

export type InitApplyMode = "overwrite" | "merge";

export type InitWizardSession = {
  version: 1;
  mode: InitApplyMode;
  state: WizardState;
};

export type WizardTransition = {
  state: WizardState;
  status: "active" | "confirmed" | "cancelled";
  message?: string;
};

const PROGRESS_STEPS: WizardStep[] = [
  "mission",
  "vision",
  "goals",
  "constraints",
  "non-goals",
  "review",
];

const ALL_STEPS: WizardStep[] = [
  ...PROGRESS_STEPS,
  "confirm",
];

const INIT_TEMPLATES: Record<InitTemplateName, Pick<WizardState["data"], "goals" | "constraints" | "nonGoals">> = {
  backend: {
    goals: ["scalable service architecture"],
    constraints: ["no direct db access"],
    nonGoals: [],
  },
  frontend: {
    goals: ["accessible and responsive user experience"],
    constraints: ["consistent component architecture"],
    nonGoals: [],
  },
};

function normalizeText(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

function cloneState(state: WizardState): WizardState {
  return JSON.parse(JSON.stringify(state)) as WizardState;
}

function listIncludesNormalized(list: string[], candidate: string): boolean {
  const key = candidate.toLowerCase();
  return list.some((item) => item.toLowerCase() === key);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizeText(entry))
    .filter((entry) => entry.length > 0)
    .filter((entry, index, list) => !listIncludesNormalized(list.slice(0, index), entry));
}

function sanitizeState(value: unknown): WizardState | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const currentStep = typeof record.currentStep === "string" && ALL_STEPS.includes(record.currentStep as WizardStep)
    ? record.currentStep as WizardStep
    : "mission";

  const dataRecord = asRecord(record.data) ?? {};
  const mission = typeof dataRecord.mission === "string" ? normalizeText(dataRecord.mission) : "";
  const vision = typeof dataRecord.vision === "string" ? normalizeText(dataRecord.vision) : "";

  return {
    currentStep,
    data: {
      mission,
      vision,
      goals: readStringArray(dataRecord.goals),
      constraints: readStringArray(dataRecord.constraints),
      nonGoals: readStringArray(dataRecord.nonGoals),
    },
  };
}

function nextStep(step: WizardStep): WizardStep {
  const index = ALL_STEPS.indexOf(step);
  if (index < 0 || index === ALL_STEPS.length - 1) {
    return "confirm";
  }

  return ALL_STEPS[index + 1] as WizardStep;
}

function previousStep(step: WizardStep): WizardStep {
  const index = ALL_STEPS.indexOf(step);
  if (index <= 0) {
    return "mission";
  }

  return ALL_STEPS[index - 1] as WizardStep;
}

export function createWizardState(template?: InitTemplateName): WizardState {
  const defaults = template ? INIT_TEMPLATES[template] : { goals: [], constraints: [], nonGoals: [] };
  return {
    currentStep: "mission",
    data: {
      mission: "",
      vision: "",
      goals: [...defaults.goals],
      constraints: [...defaults.constraints],
      nonGoals: [...defaults.nonGoals],
    },
  };
}

export class InitWizard {
  state: WizardState;

  constructor(initialState?: WizardState) {
    this.state = cloneState(initialState ?? createWizardState());
  }

  next(input: string): WizardTransition {
    const normalized = normalizeText(input);
    const keyword = normalized.toLowerCase();

    if (keyword === "cancel") {
      return {
        state: cloneState(this.state),
        status: "cancelled",
      };
    }

    if (keyword === "back") {
      this.state.currentStep = previousStep(this.state.currentStep);
      return {
        state: cloneState(this.state),
        status: "active",
      };
    }

    if (this.state.currentStep === "mission") {
      if (normalized.length === 0) {
        return {
          state: cloneState(this.state),
          status: "active",
          message: "Mission is required.",
        };
      }

      this.state.data.mission = normalized;
      this.state.currentStep = "vision";
      return {
        state: cloneState(this.state),
        status: "active",
      };
    }

    if (this.state.currentStep === "vision") {
      if (normalized.length === 0) {
        return {
          state: cloneState(this.state),
          status: "active",
          message: "Vision is required.",
        };
      }

      this.state.data.vision = normalized;
      this.state.currentStep = "goals";
      return {
        state: cloneState(this.state),
        status: "active",
      };
    }

    if (this.state.currentStep === "goals") {
      if (keyword === "done") {
        this.state.currentStep = "constraints";
        return {
          state: cloneState(this.state),
          status: "active",
        };
      }

      if (normalized.length === 0) {
        return {
          state: cloneState(this.state),
          status: "active",
          message: "Enter a goal or type done.",
        };
      }

      if (!listIncludesNormalized(this.state.data.goals, normalized)) {
        this.state.data.goals.push(normalized);
      }

      return {
        state: cloneState(this.state),
        status: "active",
      };
    }

    if (this.state.currentStep === "constraints") {
      if (keyword === "done") {
        this.state.currentStep = "non-goals";
        return {
          state: cloneState(this.state),
          status: "active",
        };
      }

      if (normalized.length === 0) {
        return {
          state: cloneState(this.state),
          status: "active",
          message: "Enter a constraint or type done.",
        };
      }

      if (!listIncludesNormalized(this.state.data.constraints, normalized)) {
        this.state.data.constraints.push(normalized);
      }

      return {
        state: cloneState(this.state),
        status: "active",
      };
    }

    if (this.state.currentStep === "non-goals") {
      if (keyword === "done") {
        this.state.currentStep = "review";
        return {
          state: cloneState(this.state),
          status: "active",
        };
      }

      if (normalized.length === 0) {
        return {
          state: cloneState(this.state),
          status: "active",
          message: "Enter a non-goal or type done.",
        };
      }

      if (!listIncludesNormalized(this.state.data.nonGoals, normalized)) {
        this.state.data.nonGoals.push(normalized);
      }

      return {
        state: cloneState(this.state),
        status: "active",
      };
    }

    if (this.state.currentStep === "review") {
      if (keyword === "continue") {
        this.state.currentStep = "confirm";
        return {
          state: cloneState(this.state),
          status: "active",
        };
      }

      return {
        state: cloneState(this.state),
        status: "active",
        message: "Type continue to move to confirmation, back to edit, or cancel.",
      };
    }

    if (this.state.currentStep === "confirm") {
      if (keyword === "yes") {
        return {
          state: cloneState(this.state),
          status: "confirmed",
        };
      }

      if (keyword === "no") {
        return {
          state: cloneState(this.state),
          status: "cancelled",
        };
      }

      return {
        state: cloneState(this.state),
        status: "active",
        message: "Type yes or no.",
      };
    }

    this.state.currentStep = nextStep(this.state.currentStep);
    return {
      state: cloneState(this.state),
      status: "active",
    };
  }
}

function escapeDSLString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

export function buildDSL(data: WizardState["data"]): string[] {
  const commands: string[] = [];

  if (data.mission && data.mission.trim().length > 0) {
    commands.push(`choir define mission "${escapeDSLString(data.mission.trim())}"`);
  }

  if (data.vision && data.vision.trim().length > 0) {
    commands.push(`choir define vision "${escapeDSLString(data.vision.trim())}"`);
  }

  for (const goal of data.goals) {
    commands.push(`choir define goal "${escapeDSLString(goal)}"`);
  }

  for (const constraint of data.constraints) {
    commands.push(`choir define constraint "${escapeDSLString(constraint)}"`);
  }

  for (const nonGoal of data.nonGoals) {
    commands.push(`choir define non-goal "${escapeDSLString(nonGoal)}"`);
  }

  return commands;
}

function renderList(values: string[]): string {
  if (values.length === 0) {
    return "- (none)";
  }

  return values.map((value) => `- ${value}`).join("\n");
}

export function renderReview(data: WizardState["data"]): string {
  return [
    `Mission: ${data.mission && data.mission.length > 0 ? data.mission : "(empty)"}`,
    `Vision: ${data.vision && data.vision.length > 0 ? data.vision : "(empty)"}`,
    "",
    "Goals:",
    renderList(data.goals),
    "",
    "Constraints:",
    renderList(data.constraints),
    "",
    "Non-Goals:",
    renderList(data.nonGoals),
  ].join("\n");
}

export function renderPrompt(state: WizardState): string {
  switch (state.currentStep) {
    case "mission":
      return "What is the mission of this system?";
    case "vision":
      return "What is the long-term vision?";
    case "goals":
      return "Enter a goal (type done to continue):";
    case "constraints":
      return "Enter a constraint (type done to continue):";
    case "non-goals":
      return "Enter a non-goal (type done to continue):";
    case "review":
      return "Review complete. Type continue to confirm, or back to edit.";
    case "confirm":
      return "Apply this configuration? (yes/no)";
  }
}

export function renderProgress(step: WizardStep): string {
  const index = PROGRESS_STEPS.indexOf(step);
  const total = PROGRESS_STEPS.length;

  if (index >= 0) {
    const label = PROGRESS_STEPS[index] === "non-goals"
      ? "Non-Goals"
      : PROGRESS_STEPS[index].charAt(0).toUpperCase() + PROGRESS_STEPS[index].slice(1);

    return `Step ${index + 1}/${total} - ${label}`;
  }

  return `Step ${total}/${total} - Confirm`;
}

export function getInitStatePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".choir", "init-state.json");
}

export function loadInitSession(workspaceRoot: string): InitWizardSession | null {
  const statePath = getInitStatePath(workspaceRoot);
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      return null;
    }

    const version = record.version === 1 ? 1 : null;
    if (!version) {
      return null;
    }

    const mode = record.mode === "merge" || record.mode === "overwrite"
      ? record.mode
      : null;
    if (!mode) {
      return null;
    }

    const state = sanitizeState(record.state);
    if (!state) {
      return null;
    }

    return {
      version,
      mode,
      state,
    };
  } catch {
    return null;
  }
}

export function saveInitSession(workspaceRoot: string, session: InitWizardSession): void {
  const statePath = getInitStatePath(workspaceRoot);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(session, null, 2), "utf-8");
}

export function clearInitSession(workspaceRoot: string): void {
  const statePath = getInitStatePath(workspaceRoot);
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
  }
}