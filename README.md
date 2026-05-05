# Choir

**Choir** is a VS Code extension that keeps your codebase honest through a deterministic, policy-driven pipeline. It reads a committed YAML control plane, compiles intent and policy into executable rules, emits diagnostics, and coordinates planning/execution through a unified chat facade (`@choir`) that routes to internal roles (Architect, Enforcer, Analyst, and Conductor).

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
- Deterministic adaptive strategy refinement from prior strategy outcomes
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

### Adaptive Strategy Generation (Deterministic)

After baseline strategy evaluation, Conductor can run bounded adaptive refinement iterations.

Adaptive rules:

- No LLM usage, no randomness, no probabilistic learning
- Failure patterns are extracted deterministically from evaluated outcomes
- Rule-based mutations are applied from a fixed mutation registry
- Adaptive strategy ids are deterministic hashes of mutation inputs
- Strategy pool size and iteration count are capped to avoid unbounded growth

Stop conditions:

- Selected strategy is good enough (`success` and `remainingViolations === 0`)
- No new adaptive strategies are generated
- Maximum adaptive iterations reached

Adaptive trace includes:

- iteration count
- strategies evaluated
- mutations applied
- selected strategy id
- deterministic decision log

### Strategy Memory and Reuse (Deterministic)

Choir can persist successful strategy outcomes and reuse them deterministically in future runs.

Memory behavior:

- Strategy memory is stored in `.choir/memory.json`
- Entries are indexed by deterministic context signature (goals, constraints, violation summary, module hints)
- Exact signature match is used for deterministic lookup
- Reuse candidates must satisfy:
  - `success === true`
  - `remainingViolations === 0`
- Reuse selection is deterministic:
  - lowest patch count
  - then lexicographic memory id tie-break

Safety guardrails:

- Reused plan must pass applicability validation against current workspace/state
- If validation fails, Choir falls back to adaptive simulation-based strategy evaluation
- Memory entries are deduplicated and bounded to prevent uncontrolled growth

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

## Unified Agent Interface

Primary interface from VS Code Chat:

- `@choir`

Choir commands are now a strict DSL (alpha mode, no natural-language command parsing).

Grammar:

```bnf
<command> ::= "choir" <action> ("then" <action>)*

<action> ::= <define> | <analyze> | <plan> | <preview> | <execute> | <status> | <export> | <approve> | <reject> | <policy-status>

<define> ::= "define" ("goal" | "constraint" | "non-goal") <string>
<analyze> ::= "analyze" ("workspace" | "violations" | "hotspots")
<plan> ::= "plan" ["for" <string>]
<preview> ::= "preview" ["plan" <identifier>]
<execute> ::= "execute" ["plan" <identifier>]
<status> ::= "status"
<export> ::= "export" "dsl" ["all" | "intent" | "policy" | "plans"]
<approve> ::= "approve" <identifier>
<reject> ::= "reject" <identifier>
<policy-status> ::= "policy" "status"

<string> ::= QUOTED_STRING
<identifier> ::= [a-zA-Z0-9-_]+
```

`@choir` parses commands into AST and compiles AST into deterministic YAML mutations.

Compilation flow:

`DSL -> AST -> compiler -> choir.config.yaml -> pipeline`

### Internal Architect Role

Defines intent values in `.choir/choir.config.yaml`.

Examples:

- `choir define goal "enforce service boundaries"`
- `choir define constraint "no direct db access"`
- `choir define non-goal "distributed app"`

### Internal Enforcer Role

Not directly user-addressable in DSL.

### YAML Compiler Behavior

The DSL compiler is transactional and deterministic:

- Parses full command input first
- Applies AST mutations in memory
- Validates resulting config against schema
- Writes `.choir/choir.config.yaml` once (or returns no-op)

Supported commands:

- `choir plan`
- `choir plan for "service boundaries"`
- `choir preview`
- `choir preview plan <planId>`
- `choir execute`
- `choir execute plan <planId>`
- `choir status`
- `choir export dsl`
- `choir export dsl intent`
- `choir export dsl policy`
- `choir export dsl plans`
- `choir approve <diffId>`
- `choir reject <diffId>`
- `choir policy status`

Mutation behavior:

- `choir define ...`: mutates intent fields in YAML via deterministic upsert
- `choir plan [for "..."]`: synthesizes a deterministic draft plan and upserts it into YAML
- `choir analyze|preview|execute|status`: accepted by grammar, non-mutating in YAML compiler mode

YAML -> DSL projection behavior:

- `choir export dsl` generates one command per line in deterministic order
- Command ordering is stable: goals, constraints, non-goals, policy, plans
- Export output is written to `.choir/choir.dsl` (or section-specific `.choir/choir.<section>.dsl`)
- Unrepresentable YAML sections are skipped with warnings (no synthetic DSL is invented)

Policy approval gate behavior:

- Every YAML mutation diff is evaluated deterministically against `policy.approvalRules`
- `deny` rules block mutation
- `require-approval` rules create a pending diff id and block mutation until approved
- Approvals are bound to exact diff hash and cannot be reused for different diffs

Example policy gate config:

```yaml
policy:
  rules: []
  approvalRules:
    - id: restrict-db-access
      match:
        path: intent.constraints
        operation: add
      condition:
        contains: db
      effect:
        type: require-approval
        message: DB-related constraints require approval

    - id: prevent-policy-deletion
      match:
        path: policy.rules
        operation: remove
      effect:
        type: deny
```

Idempotency guarantees:

- Same input and same starting YAML produce identical output YAML
- Duplicate intent entries are deduplicated and stably sorted
- Duplicate plan ids are not re-added

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
- strategy history (`strategyHistory`) for deterministic adaptive refinement feedback

Strategy memory is persisted separately in `.choir/memory.json`.

`state.json` is derived and reproducible from workspace + control plane.

---

## Troubleshooting

| Symptom | Resolution |
|---|---|
| No diagnostics appear | Ensure a workspace is open and `.choir/choir.config.yaml` exists (or save once so Choir creates it). |
| `choir.config.yaml` parse error | Check Problems for schema errors; ensure YAML matches documented schema and canonical severity values. |
| Chat participants not responding | Confirm VS Code 1.90+ and extension enabled in the active workspace. |
| Rule Editor appears blank | Open the Choir activity view, then run `Choir: Open Rule Editor` from Command Palette. |
