# Choir

**Choir** is a VS Code extension that keeps your codebase honest. It reads a plain-YAML configuration file that you commit to your repo, compiles your intent and rules into live diagnostics, and gives you three AI chat participants — Architect, Enforcer, and Analyst — that understand your project's actual policies.

---

## Requirements

- VS Code 1.90 or later
- A workspace folder open in VS Code
- TypeScript/JavaScript source files (the enforcement pipeline analyzes `.ts`/`.js`)

---

## Installation

Install from the VS Code Marketplace (search **"Choir"**), or install the `.vsix` package manually:

```
Extensions panel → ··· menu → Install from VSIX…
```

The extension activates automatically when VS Code finishes loading.

---

## Configuration

Choir reads one file: `.choir/choir.config.yaml` at the root of your workspace.

If the file does not exist, Choir creates a blank one the first time it activates:

```yaml
version: "1.0.0"
mission: ""
vision: ""
non-goals: []
intent:
  goals: []
  constraints: []
policy:
  rules: []
```

Commit this file to version control so the whole team shares the same rules.

### Overarching direction

These top-level fields define project-wide direction that should remain stable over time.

| Field | Type | Description |
|---|---|---|
| `mission` | `string` | The enduring mission statement for the solution. |
| `vision` | `string` | The long-term target state this solution is moving toward. |
| `non-goals` | `string[]` | Explicit boundaries describing what this solution is not trying to do. |

### `intent`

High-level goals and constraints written in plain English. Choir uses these to synthesize additional enforcement rules automatically.

| Field | Type | Description |
|---|---|---|
| `goals` | `string[]` | What the project is trying to achieve. |
| `constraints` | `string[]` | Blanket prohibitions that apply everywhere (e.g. `"no direct db access"`). |

### `policy.rules`

Explicit, file-scoped DSL rules evaluated on every save. Each rule has this shape:

| Field | Required | Description |
|---|---|---|
| `id` | ✔ | Unique rule identifier shown in diagnostics. |
| `description` | | Human-readable summary. |
| `priority` | | Integer. Higher numbers run first (default 0). |
| `appliesTo.files` | | Glob patterns that restrict which files are checked. |
| `appliesTo.language` | | Language identifier (e.g. `"typescript"`). |
| `match.imports` | | Module specifiers whose presence triggers the rule. |
| `match.callExpressions` | | Function names whose calls trigger the rule. |
| `match.functionNames` | | Function declaration names that trigger the rule. |
| `constraint.type` | ✔ | `"forbid"` — flag a match as a violation. `"require"` — flag the absence of a match. |
| `message` | ✔ | Diagnostic message shown in the Problems panel. |
| `severity` | | `"error"` (default) · `"warn"` · `"info"` |

### Example configuration

```yaml
version: "1.0.0"
mission: "Deliver secure, maintainable services with predictable behavior"
vision: "A policy-aware engineering workflow where architecture intent stays enforceable"
non-goals:
  - "Not a replacement for human architecture review"
  - "Not a generic low-code orchestration platform"
intent:
  goals:
    - "Build a clean layered service architecture"
  constraints:
    - "no direct db access outside the repository layer"
    - "no console.log in production code"
policy:
  rules:
    - id: no-db-in-controller
      description: Prevent DB usage in controllers
      appliesTo:
        files:
          - "**/controller/**"
      match:
        imports:
          - "db"
      constraint:
        type: forbid
      message: "Controllers must not import DB modules"
      severity: error

    - id: validate-request
      description: Ensure request validation is performed
      appliesTo:
        files:
          - "**"
      match:
        callExpressions:
          - validateRequest
      constraint:
        type: require
      message: "All request handlers must call validateRequest"
      severity: warn
```

---

## Chat Participants

All three participants are accessible from the VS Code Chat panel (`@Choir-Architect`, `@Choir-Enforcer`, `@Choir-Analyst`).

### `@Choir-Architect`

Reads and writes your control plane. Use it to evolve your policy through natural language.

| Example prompt | Effect |
|---|---|
| `Show control plane` | Prints the current `.choir/choir.config.yaml` as YAML. |
| `Set mission: ...` | Updates the top-level mission statement. |
| `Set vision: ...` | Updates the top-level vision statement. |
| `Add non-goal: some non-goal` | Appends a non-goal if it does not already exist. |
| `Add non-goals: one non-goal, another non-goal` | Appends multiple non-goals if they do not already exist |
| `Remove non-goal: some non-goal` | Removes the matching non-goal. |
| `Remove non-goals: one non-goal, another non-goal` | Removes multiple non-goals |
| `Add goal: Build auth system` | Appends an entry to `intent.goals`. |
| `Add goals: Build auth system, create user list` | Appends multiple entries to `intent.goals`. |
| `Add constraint: no direct db access` | Appends an entry to `intent.constraints`. |
| `Add constraints: no direct db access, no caching` | Appends multiple entries to `intent.constraints`. |
| `Remove goal: Build auth system` | Removes the matching goal. |
| `Remove constraint: no direct db access` | Removes the matching constraint. |
| `Remove constraints: no direct db access, no caching` | Removes the matching constraints. |

After every update the Architect re-runs the enforcement pipeline and reports the violation count.

### `@Choir-Enforcer`

Triggers a full pipeline run and lists every current violation.

```
@Choir-Enforcer
```

Output example:

```
⛔ Pipeline reported violations:

- [no-db-in-controller] Controllers must not import DB modules (src/controllers/user.ts)
```

Use this when you want an on-demand audit rather than waiting for a file save.

### `@Choir-Analyst`

Gives you a structural overview of the workspace and surfaces code hotspots.

| Example prompt | Effect |
|---|---|
| `Workspace summary` | Counts files, services, controllers, and repositories. |
| `Find hotspots` | Lists files with structural concerns. |

---

## Rule Editor

The **Choir** activity bar icon opens a sidebar with two panels:

- **Rules** — a tree view listing every rule currently in your control plane. Click a rule to open it in the editor.
- **Rule Editor** — a Monaco-powered YAML editor with schema validation for your DSL rules. Edits are written back to `.choir/choir.config.yaml` on save.

You can also open the editor from the Command Palette:

```
> Choir: Open Rule Editor
```

---

## Diagnostics

Choir runs the enforcement pipeline automatically on every file save. Violations appear in the standard VS Code **Problems** panel (`View → Problems`) with the rule ID, message, and file location.

---

## Workspace State

Choir writes incremental analysis state to `.choir/state.json`. This file is regenerated on each pipeline run — you can add it to `.gitignore` or commit it; either way is fine.

---

## Troubleshooting

| Symptom | Resolution |
|---|---|
| No diagnostics appear | Make sure a workspace folder is open and `.choir/choir.config.yaml` exists (or trigger a save to let Choir create it). |
| `choir.config.yaml` parse error | Check the Problems panel for a Zod validation message. Ensure your YAML matches the schema described above. |
| Chat participants not responding | Confirm VS Code 1.90+ and that the extension is enabled for the current workspace. |
| Rule Editor shows blank | Open the Choir activity bar view, then use `Choir: Open Rule Editor` from the Command Palette to focus it. |
