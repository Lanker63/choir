# Choir

**Choir** is a VS Code extension that keeps your codebase honest through a deterministic, policy-driven pipeline. It reads a committed YAML control plane, compiles intent and policy into executable rules, emits diagnostics, and coordinates planning/execution through four chat participants: Architect, Enforcer, Analyst, and Conductor.

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

## Control Plane Configuration

Choir reads one authoritative file: `.choir/choir.config.yaml` at the root of your workspace.

If the file does not exist, Choir creates a blank one on first activation:

```yaml
version: "1.0.0"
mission: ""
vision: ""
intent:
  goals: []
  constraints: []
  non-goals: []
policy:
  rules: []
execution:
  plans: []
```

Commit this file to version control so the team shares one policy source of truth.

### Top-level direction

| Field | Type | Description |
|---|---|---|
| `mission` | `string` | Enduring mission statement for the solution. |
| `vision` | `string` | Long-term target state for the solution. |

### `intent`

High-level goals and constraints written in plain English. Choir compiles these into executable policy behavior.

| Field | Type | Description |
|---|---|---|
| `goals` | `string[]` | What the project is trying to achieve. |
| `constraints` | `string[]` | Global constraints (for example: `"no direct db access"`). |
| `non-goals` | `string[]` | Explicit boundaries for what should not be optimized or enforced. |

### `policy.rules`

Explicit DSL rules evaluated across the workspace.

| Field | Required | Description |
|---|---|---|
| `id` | ✔ | Unique rule identifier shown in diagnostics. |
| `description` | | Human-readable summary. |
| `priority` | | Integer priority for conflict resolution/ordering. |
| `appliesTo.files` | | Glob patterns that scope rule execution. |
| `appliesTo.language` | | Language id scope (for example `"typescript"`). |
| `match.imports` | | Module specifiers that trigger the rule. |
| `match.callExpressions` | | Function call names that trigger the rule. |
| `match.functionNames` | | Function declaration names that trigger the rule. |
| `constraint.type` | ✔ | `"forbid"` flags a match. `"require"` flags absence of a required match. |
| `message` | ✔ | Diagnostic message shown in Problems. |
| `severity` | | `"error"` (default) · `"warning"` · `"info"` · `"hint"` |

### `execution.plans`

Conductor-managed plans live in the control plane.

| Field | Type | Description |
|---|---|---|
| `execution.plans[].id` | `string` | Deterministic plan id. |
| `execution.plans[].status` | `"draft" \| "approved"` | Plan lifecycle status. |
| `execution.plans[].derivedFrom` | `"goal" \| "constraint" \| "manual"` | Plan origin. |
| `execution.plans[].tasks[]` | `Task[]` | Ordered dependency-aware work graph. |
| `tasks[].dependsOn` | `string[]` | In-plan task dependency list (cycle-checked). |

---

## Orchestration and Execution

Choir includes a deterministic orchestration layer that supports:

- State → plan synthesis with stable ordering and deterministic ids
- Cost-based plan scoring and pre-execution selection
- Deterministic multi-strategy plan shaping before task execution
- User-visible execution previews derived from simulation
- Multi-plan optimization through global DAG merge and conflict-aware batching
- Parallel-safe scheduling by dependency layer
- Speculative transactional batch execution (`simulate → validate → commit/rollback`)
- Atomic commit and rollback boundaries to avoid partial writes

All code mutations still flow through the Enforcer path.

### Cost-Based Plan Selection

Before execution, Conductor evaluates approved candidate plans using a deterministic cost model. Scoring is static and execution-free.

Cost dimensions:

- `editCost` (estimated patch count)
- `fileTouchCost` (unique touched files)
- `riskCost` (refactor/risk heuristic)
- `dependencyCost` (longest in-plan dependency chain)
- `violationReduction` (benefit estimate)

Total score:

```text
totalCost =
  editCost * 1.0 +
  fileTouchCost * 2.0 +
  riskCost * 5.0 +
  dependencyCost * 1.5 -
  violationReduction * 3.0
```

Selection rules:

- Lower total cost wins
- Ties are broken by `planId` lexicographic order
- Same inputs always produce the same selected plan set
- Scoring performs no mutations and does not execute tasks

Conductor execution output includes a cost trace with evaluated plans and the selection decision.

### Multi-Strategy Plan Selection

After cost-based plan-set selection, Conductor evaluates each selected plan across a fixed deterministic strategy set:

- `minimal`
- `grouped`
- `layered`
- `aggressive`

Evaluation rules:

- Strategy transforms are deterministic and side-effect free
- Each strategy variant is evaluated via transaction simulation (no commit, no state persistence)
- Validated strategies are preferred over failed strategies
- Best real simulation outcome wins among candidates using deterministic metric priority:
  - lowest remaining violations
  - then lowest introduced errors
  - then lowest patch count
  - then lowest files changed
- Ties are broken by lexicographic `strategyId`

Execution rules:

- Only the selected strategy plan is executed
- Conductor emits a strategy trace per base plan:
  - evaluated strategies
  - per-strategy outcome metrics/success
  - selected strategy id
  - deterministic decision reason

### Execution Preview and Approval Gate

Conductor supports deterministic execution previews so you can inspect exact file diffs before execution.

Preview guarantees:

- Preview runs through simulation logic and does not write real files
- Preview simulation also does not persist `.choir/state.json`
- Preview diffs are derived from proposed patches + virtual FS after-state
- Preview output is deterministic for identical inputs
- Preview hash binds approval to exact selected-strategy `fileChanges`

Preview surface:

- Includes all evaluated strategies with per-strategy summaries and diffs
- Includes the deterministically selected strategy id
- Uses selected strategy file changes for approval hash binding

Approval gate:

- Execution requires a preview hash (`previewId`)
- Choir stores the last approved preview metadata in state (`execution.lastPreview`)
- On execute, Choir recomputes preview and rejects if hash differs

Deterministic hash:

```text
hash = sha256(JSON.stringify(preview.fileChanges))
```

---

## Chat Participants

Participants are available from VS Code Chat:

- `@Choir-Architect`
- `@Choir-Enforcer`
- `@Choir-Analyst`
- `@Choir-Conductor`

### `@Choir-Architect`

Reads and writes `.choir/choir.config.yaml` using natural language updates.

Examples:

- `Show control plane`
- `Set mission: ...`
- `Set vision: ...`
- `Add goal: ...`
- `Add constraint: ...`
- `Add non-goal: ...`
- `Remove goal: ...`
- `Remove constraint: ...`
- `Remove non-goal: ...`

### `@Choir-Enforcer`

Runs the enforcement pipeline and reports current diagnostics.

### `@Choir-Analyst`

Provides workspace summaries and hotspots.

### `@Choir-Conductor`

Builds, approves, executes, and reports plan status.

Supported commands:

- `plan`
- `plan for goal: <goal>`
- `approve <planId>`
- `preview [planId]`
- `execute <previewHash>`
- `execute <planId> <previewHash>`
- `status`

Execution behavior:

- `preview [planId]`: score/select plans, evaluate strategies, and render exact simulation-derived file diffs + preview hash
- `execute <previewHash>`: execute selected plan(s) only if recomputed preview hash matches
- `execute <planId> <previewHash>`: execute that approved plan only if recomputed preview hash matches

---

## Rule Editor

The **Choir** activity bar icon opens two views:

- **Rules**: tree of current control-plane rules
- **Rule Editor**: Monaco YAML editor with schema validation, writing back to `.choir/choir.config.yaml`

Command palette:

```
> Choir: Open Rule Editor
```

---

## Diagnostics and State

Choir runs the pipeline on save and publishes diagnostics to **Problems** (`View → Problems`).

Derived system state is written to `.choir/state.json`, including:

- AST and symbol/dependency metadata
- diagnostics and metrics
- execution runtime state (task status, task results, history, preview approvals)

`state.json` is derived and reproducible from workspace + control plane.

---

## Troubleshooting

| Symptom | Resolution |
|---|---|
| No diagnostics appear | Ensure a workspace is open and `.choir/choir.config.yaml` exists (or save once so Choir creates it). |
| `choir.config.yaml` parse error | Check Problems for schema errors; ensure YAML matches documented schema and canonical severity values. |
| Chat participants not responding | Confirm VS Code 1.90+ and extension enabled in the active workspace. |
| Rule Editor appears blank | Open the Choir activity view, then run `Choir: Open Rule Editor` from Command Palette. |
