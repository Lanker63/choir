# Choir

**Choir** is a VS Code extension that keeps your codebase honest through a deterministic, policy-driven pipeline. It reads a committed YAML control plane, compiles intent and policy into executable rules, emits diagnostics, coordinates planning/execution through a unified chat facade (`@choir`) that routes to internal roles (Architect, Enforcer, Analyst, and Conductor), records immutable audit/compliance evidence for significant actions, and supports versioned macro libraries for team-wide standards reuse.

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

The extension activates automatically when VS Code finishes loading and when Choir language features are used in `.choir` files.

---

## Control Plane Configuration

Choir reads one authoritative file: `.choir/choir.config.yaml` at the root of your workspace.

Choir does not auto-create this file on activation.

Create it by either:

- Running `@choir init` (recommended guided flow)
- Creating `.choir/choir.config.yaml` manually

Initial template:

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

Commit this file to version control so the team shares one control-plane source of truth.

Policy governance source:

- Org-level policy gates are authored in `/org/policies.dsl`.
- Repo-level policy gates are authored in `.choir/policies.dsl`.
- Environment policies are runtime-derived (trusted context), applied as the last layer.
- Effective policy set is deterministic: `org -> repo -> environment`.
- Choir creates a default `.choir/policies.dsl` file if missing.
- Commit both `/org/policies.dsl` and `.choir/policies.dsl` alongside `.choir/choir.config.yaml`.

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

### Policy DSL Governance (Org + Repo + Environment)

Mutation governance rules are authored as code in Policy DSL and merged across hierarchy layers.

Hierarchy model:

```text
Org Policies (/org/policies.dsl)
  -> Repo Policies (.choir/policies.dsl)
  -> Environment Policies (runtime layer)
  -> Effective Policy Set (evaluated)
```

- Policy DSL is the only source of truth for policy gating.
- Runtime flow is deterministic: `Policy DSL -> AST -> Compiled Policy Rules -> Merge Engine -> Policy Engine`.
- Policy decisions use context model: `decision = f(yamlDiff, role, environment)`.
- Parent policies always apply; `deny` is never bypassable by child layers.
- Merge is deterministic and stable: `org -> repo -> environment`.

Policy DSL rule model supports:

- diff selectors: `diff.path`, `diff.operation`
- macro selectors: `macro`
- scope selectors: `role`, `environment`
- predicates: `contains`, `count > <number>`
- effects: `allow`, `deny`, `require-approval`
- inheritance operators: `assign`, `append`, `remove`
- controlled overrides: `override child`, `override none`

Policy DSL grammar:

```bnf
<policy> ::= "policy" <identifier> "{" <directive>* <rule>* "}"

<directive> ::= "inherit" ("assign" | "append" | "remove")
          | "override" ("child" | "none")

<rule> ::= "when" <condition> "then" <effect>

<condition> ::= <clause> ("and" <clause>)*

<clause> ::= "diff.path" "=" <string>
           | "diff.operation" "=" ("add" | "remove" | "update")
           | "macro" "=" <string>
           | "role" "=" ("architect" | "analyst" | "conductor" | "enforcer")
           | "environment" "=" ("local" | "ci" | "staging" | "production")
           | "contains" <string>
           | "count" ">" <number>

<effect> ::= "allow" | "deny" | "require-approval"
```

Minimal examples:

```text
/org/policies.dsl
policy org-review-db {
  override child
  when diff.path = "intent.constraints"
    and diff.operation = add
    and contains "db"
  then require-approval
}

.choir/policies.dsl
policy repo-fastlane-db {
  inherit assign
  when diff.path = "intent.constraints"
    and diff.operation = add
    and contains "db"
  then allow
}
```

Environment layer behavior:

- Environment policies are evaluated last.
- Production injects strict runtime policy denies for `execution.plans` mutations.

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

Participant exposure contract:

- Only one chat participant is contributed: `@choir` (`id: choir`).
- Internal role modules (`architect`, `analyst`, `conductor`, `enforcer`) are not directly user-addressable participants.
- Routing from `@choir` to internal role logic is deterministic and implementation-defined.

Control-plane mutation commands are strict DSL (alpha mode, no natural-language command parsing).

### Interactive Init Wizard (`@choir init`)

Choir includes a stateful guided initialization shortcut in chat:

- `@choir init`
- `@choir init --template backend`
- `@choir init --template frontend`

Wizard behavior:

- Step-driven flow: mission -> vision -> goals -> constraints -> non-goals -> review -> confirm
- Per-step progress is shown (for example: `Step 2/6 - Vision`)
- `back` is supported to edit previous steps
- `cancel` exits the wizard
- Input dismiss (escape/close) pauses the wizard and keeps resumable state
- Resume support uses `.choir/init-state.json`
- Inputs are normalized and duplicate list entries are prevented

Apply model:

- Wizard does not write YAML directly
- Wizard generates deterministic DSL commands at confirmation
- Commands are applied sequentially through existing DSL compile + policy gate flow (`compileDSLAndWrite`)

Grammar:

```bnf
<command> ::= "choir" <action> ("then" <action>)*

<action> ::= <define> | <analyze> | <plan> | <preview> | <execute> | <status> | <export> | <approve> | <reject> | <policy-status> | <import> | <library> | <ci> | <audit> | <macro> | <abstraction>

<define> ::= "define" ("mission" | "vision" | "goal" | "constraint" | "non-goal") <string>
<analyze> ::= "analyze" ("workspace" | "hotspots" | "summary")
<plan> ::= "plan" ["for" <string>]
         | "plan" "approve" <identifier>
<preview> ::= "preview" ["plan" <identifier>]
<execute> ::= "execute" ["plan" <identifier>]
<status> ::= "status"
<export> ::= "export" "dsl" ["all" | "intent" | "policy" | "plans"]
<approve> ::= "approve" <identifier>
<reject> ::= "reject" <identifier>
<policy-status> ::= "policy" "status"
<import> ::= "import" <library-spec>

<library> ::= "library" "list"
            | "library" "install" <library-spec>
            | "library" "update" <identifier>
            | "library" "lock"

<library-spec> ::= <identifier> "@" <version-selector>

<version-selector> ::= MAJOR "." MINOR "." PATCH
                     | MAJOR "." MINOR "." "x"
                     | MAJOR "." "x"
<ci> ::= "ci" "run"
<audit> ::= "audit" "log"
          | "audit" "report"
          | "audit" "query" [<audit-filters>]

<audit-filters> ::= <audit-filter> ("," <audit-filter>)*

<audit-filter> ::= ("role" | "environment" | "action" | "from" | "to") "=" (<identifier> | <string>)
<macro> ::= "macro" "list"
          | "macro" "show" <identifier>
          | "macro" <identifier> [<args>]

<abstraction> ::= <identifier> [<args>]

<args> ::= <key-value> ("," <key-value>)*

<key-value> ::= <identifier> "=" <string>

<string> ::= QUOTED_STRING
<identifier> ::= [a-zA-Z0-9._-]+
```

`@choir` parses commands into AST and compiles AST into deterministic YAML mutations.

Compilation flow:

`DSL -> AST -> compiler -> choir.config.yaml -> pipeline`

### Choir DSL Editor Language Support (`.choir`)

Choir ships first-class VS Code language support for the DSL.

- File recognition:
  - `*.choir` is associated to language id `choir`.
- Syntax highlighting:
  - TextMate grammar (`source.choir`) highlights comments, strings, keywords, and identifiers.
  - Keyword list is aligned to the strict DSL command surface (`choir`, `define`, `analyze`, `plan`, `preview`, `execute`, `status`, `export`, `approve`, `reject`, `policy`, `import`, `library`, `install`, `update`, `lock`, `ci`, `run`, `audit`, `log`, `report`, `query`, `macro`, `then`, and related terminals).
- Language configuration:
  - Line comments use `#`.
  - Bracket pairs: `{}`, `()`.
  - Auto-closing and surrounding pairs for `"`.
- IntelliSense (deterministic):
  - Completion suggestions are grammar-state driven (no LLM, no heuristics).
  - Suggestions are context-aware and only include syntactically valid next tokens.
  - Hover text is provided for DSL keywords.
- Validation (parser-backed):
  - Diagnostics reuse the same strict parser behavior (`parseCommand`) used by compile/runtime.
  - Validation runs per non-empty, non-comment command line and surfaces parse errors directly in the editor.
- Snippets:
  - Built-in snippets for `define`, `plan`, `preview`, `execute`, `export`, `approve`, `reject`, `policy status`, `ci run`, `abstraction run`, `audit log`, `audit report`, `audit query`, and `macro` commands.
- Editor trace:
  - Command Palette: `Choir: Show DSL Editor Trace`
  - Displays deterministic counters: completions triggered, diagnostics count, parse error count.

### Internal Architect Role

Defines intent values in `.choir/choir.config.yaml`.

Examples:

- `choir define mission "deterministic engineering workflow"`
- `choir define vision "policy-native delivery platform"`
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
- `choir plan approve <planId>`
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
- `choir import <library>@<version-selector>`
- `choir library list`
- `choir library install <library>@<version-selector>`
- `choir library update <library>`
- `choir library lock`
- `choir ci run`
- `choir <abstraction-id> [key="value", ...]`
- `choir audit log`
- `choir audit report`
- `choir audit query [role=<id>, environment=<id>, action=<id>, from="...", to="..."]`
- `choir macro list`
- `choir macro show <macroId>`
- `choir macro <macroId> [key="value", ...]`

Macro storage and model:

- Local macro registry file: `.choir/macros.yaml`
- Library manifests: `.choir/libraries/<library>/<version>/macros.yaml`
- Resolved library versions: `.choir/lock.yaml`
- Each macro contains:
  - `id`
  - required `version` (semver)
  - optional `description`
  - optional `parameters[]` (`name`, `required`, optional `default`)
  - `body[]` (templated DSL command lines)
- Expansion pipeline is strict and deterministic:
  - `Macro -> DSL -> AST -> YAML -> Pipeline`
- Macros never write YAML directly.
- Macro body commands are validated with the same DSL parser used by runtime.
- Macro steps execute sequentially through `compileDSLAndWrite`, so each step passes policy gates and diff/approval checks.
- Macro composition is supported (`choir macro ...` inside macro bodies) with deterministic recursion detection and depth limit.
- Library macros are namespaced as `<library>.<macroId>`.
- Library selectors resolve deterministically to exact versions: `1.0.0`, `1.0.x`, `1.x`.
- Resolution is local-only and lockfile-pinned (no network lookups).
- Breaking changes between library versions require MAJOR version bumps.

Mutation behavior:

- `choir define mission|vision ...`: mutates top-level mission/vision in YAML via deterministic set
- `choir define goal|constraint|non-goal ...`: mutates intent fields in YAML via deterministic upsert
- `choir plan [for "..."]`: synthesizes a deterministic draft plan and upserts it into YAML
- `choir plan approve <planId>`: marks an existing plan as approved in YAML via deterministic update
- `choir analyze|preview|execute|status|ci|audit|import|library|<abstraction-id> ...`: accepted by grammar, non-mutating in YAML compiler mode

YAML -> DSL projection behavior:

- `choir export dsl` generates one command per line in deterministic order
- Command ordering is stable: goals, constraints, non-goals, policy, plans
- Export output is written to `.choir/choir.dsl` (or section-specific `.choir/choir.<section>.dsl`)
- Unrepresentable YAML sections are skipped with warnings (no synthetic DSL is invented)

Policy approval gate behavior:

- Decision model: `decision = f(yamlDiff, role, environment)`
- Macro-aware decision model: `decision = f(yamlDiff, role, environment, macroId)`
- Every YAML mutation diff is evaluated deterministically against an effective merged policy set from org/repo/environment Policy DSL layers
- Source merge order is deterministic and fixed: `org -> repo -> environment`
- Role is trusted system context (derived from command/action role mapping), not user-provided DSL input
- Environment is trusted runtime context (`CI`, `NODE_ENV`, optional `CHOIR_ENVIRONMENT`), not DSL input
- Macro context is trusted runtime resolution from lockfile-pinned macro library execution, not free-form user input during policy evaluation
- Deterministic precedence is enforced: `deny > require-approval > allow`
- No policy source is mutated during evaluation
- No hidden overrides are allowed
- Duplicate policy IDs across layers are rejected
- `deny` rules block mutation
- `require-approval` rules create a pending diff id and block mutation until approved
- Approvals are bound to exact diff hash and cannot be reused for different diffs
- Child layers cannot override parent `deny`
- Policy traces include role, environment, source-aware matched rules, policy DSL traces, inheritance traces, and final decision for auditability

Example policy gate config:

```text
/org/policies.dsl
policy org-block-prod-plan-changes {
  when diff.path = "execution.plans"
    and environment = production
  then deny
}

policy org-ci-requires-approval {
  when diff.path = "intent.constraints"
    and diff.operation = add
    and environment = ci
  then require-approval
}

.choir/policies.dsl
policy repo-analyst-readonly {
  when diff.operation = add
    and role = analyst
  then deny
}

policy repo-restrict-db-access {
  when diff.path = "intent.constraints"
    and diff.operation = add
    and contains "db"
  then require-approval
}

# runtime environment layer (implicit)
# production denies execution.plans add/update/remove
```

Idempotency guarantees:

- Same input and same starting YAML produce identical output YAML
- Duplicate intent entries are deduplicated and stably sorted
- Duplicate plan ids are not re-added
- Macro expansion with identical inputs produces identical expanded commands
- Lockfile-pinned macro library execution produces identical version resolution for identical `.choir/lock.yaml`
- Identical `(yamlDiff, role, environment, org+repo policies, runtime environment)` inputs always produce identical policy decisions

---

## CI/CD Integration

Choir supports deterministic pipeline execution through:

- `choir ci run`

Pipeline model:

- `source -> compile -> plan -> policy -> preview -> execute -> audit`
- Stages may be omitted in `.choir/ci.yaml`, but stage ordering must remain canonical and deterministic.

CI config file:

- Path: `.choir/ci.yaml`
- Schema highlights:
  - `pipeline.stages`: ordered list of stage ids
  - `environments.<local|ci|staging|production>.enforcePolicy`
  - `environments.<local|ci|staging|production>.requireApproval`
  - `macros`: list of macro ids executed during `plan`

Example:

```yaml
pipeline:
  stages:
    - source
    - compile
    - plan
    - policy
    - preview
    - execute
    - audit

environments:
  ci:
    enforcePolicy: true
    requireApproval: true

macros:
  - core.enforce-service-boundaries
```

Execution constraints in CI mode:

- Macro execution is blocked outside `choir ci run`.
- Plan execution is blocked outside `choir ci run`.
- Environment context is runtime-derived and validated (`detectEnvironment`), not caller-provided.

Artifacts written by CI runs:

- `.choir/artifacts/ci/<run-key>/plan.json`
- `.choir/artifacts/ci/<run-key>/preview.json`
- `.choir/artifacts/ci/<run-key>/preview.diff`
- `.choir/artifacts/ci/<run-key>/execution.json` (if execute stage runs)
- `.choir/artifacts/ci/<run-key>/audit.log`
- `.choir/artifacts/ci/<run-key>/trace.json`

GitHub Actions sample:

```yaml
name: Choir CI

on:
  push:
  pull_request:

jobs:
  choir:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build:extension
      - run: npm link
      - run: choir ci run
```

---

## Higher-Level Abstractions

Choir supports intent-level abstractions that compile into deterministic macro + DSL steps while preserving governance:

- `Abstraction -> Macro Composition -> DSL -> YAML -> Policy -> Execution -> Audit`

Storage:

- `.choir/abstractions.yaml`

Model:

- `id`
- `version` (semver)
- `description`
- optional `parameters[]`
- `expandsTo[]` (ordered commands)

Example:

```yaml
abstractions:
  - id: bootstrap-service
    version: 1.0.0
    description: "Initialize a service architecture"
    parameters:
      - name: name
        required: true
    expandsTo:
      - choir macro architecture.create-service name="{{name}}"
      - choir macro core.enforce-service-boundaries
      - choir plan
      - choir preview
```

Execution guarantees:

- Expanded commands are executed in order.
- Every expanded command goes through existing DSL compile and policy gates.
- Abstractions can call macros and other abstractions with recursion depth limits.
- Non-execution system commands are rejected inside abstractions.
- Same abstraction id + args + input state produce deterministic output.

Chat commands:

- `@choir list abstractions`
- `@choir describe <abstraction-id>`
- `@choir run <abstraction-id>`

DSL command example:

- `choir bootstrap-service name="user-service"`

Built-in abstractions:

- `enforce-hexagonal-architecture`
- `migrate-to-service-layer`

---

## Macro Libraries

Choir supports local, versioned macro libraries for cross-repository reuse.

Storage model:

- `.choir/libraries/<library>/<version>/macros.yaml`
- Versions are immutable; publish a new version directory instead of editing in place
- Library manifests include: `name`, `version`, `metadata`, `macros[]`

Lockfile model:

- `.choir/lock.yaml` stores resolved exact versions
- Example:

```yaml
libraries:
  core: 1.0.0
  architecture: 2.1.0
```

Library commands:

- `choir import core@1.0.x`
- `choir library list`
- `choir library install core@1.0.0`
- `choir library update core`
- `choir library lock`

Determinism guarantees:

- No unversioned macros
- No nondeterministic library resolution
- Same locked version produces the same macro behavior
- No direct macro execution path bypasses DSL compilation/policy gate

---

## Audit and Compliance Reporting

Choir records immutable, explainable audit evidence for significant control-plane and execution actions.

Audit storage and integrity:

- Append-only audit log file: `.choir/audit.log.jsonl`
- Each record is hash-chained with deterministic fields: `chainIndex`, `previousHash`, and `hash`
- First record uses `GENESIS` as `previousHash`
- Chain integrity is validated when reading audit data

Audited action types include:

- `policy-evaluation`
- `compile-dsl`
- `approval-granted`
- `approval-rejected`
- `execute-plan`
- `macro-execution`
- `ci-policy-gate`
- `ci-pipeline`
- `abstraction-execution`

Audit query/report command surface:

- `choir audit log`
  - Shows recent audit events with role, action, and result
- `choir audit query role=architect, environment=ci, action=compile-dsl`
  - Filters are deterministic and support: `role`, `environment`, `action`, `from`, `to`
  - Time-range filters require both `from` and `to`
- `choir audit report`
  - Generates deterministic compliance summaries
  - Exports report artifacts to:
    - `.choir/reports/compliance-report.json`
    - `.choir/reports/compliance-report.yaml`
    - `.choir/reports/compliance-report.pdf`

Report model highlights:

- Summary fields: `totalEvents`, `approvalsRequired`, `denials`
- Findings fields: `violations`, `anomalies`
- Anomalies are derived from failed audit events
- Macro-driven compile records include library provenance metadata (`macroLibrary`, `version`, `macroId`, `resolvedVersion`)

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

Audit evidence is persisted in `.choir/audit.log.jsonl`.

Macro library manifests are stored under `.choir/libraries/`.

Macro library lock resolution is stored in `.choir/lock.yaml`.

CI pipeline configuration is stored in `.choir/ci.yaml`.

Abstraction registry is stored in `.choir/abstractions.yaml`.

CI run artifacts are stored in `.choir/artifacts/ci/`.

Compliance reports are exported to `.choir/reports/` when `choir audit report` is invoked.

Strategy memory is persisted separately in `.choir/memory.json`.

Interactive init wizard session state (resumable) is persisted in `.choir/init-state.json`.

`state.json` is derived and reproducible from workspace + control plane.

---

## Troubleshooting

| Symptom | Resolution |
|---|---|
| No diagnostics appear | Ensure a workspace is open and `.choir/choir.config.yaml` exists. If missing, run `@choir init` or create it manually. |
| `choir.config.yaml` parse error | Check Problems for schema errors; ensure YAML matches documented schema and canonical severity values. |
| Chat participants not responding | Confirm VS Code 1.90+ and extension enabled in the active workspace; only `@choir` should be visible. |
| Rule Editor appears blank | Open the Choir activity view, then run `Choir: Open Rule Editor` from Command Palette. |
| No DSL completion/hover in `.choir` files | Confirm the file extension is `.choir`, language mode is `Choir DSL`, and the extension is enabled in the workspace. |
| `@choir init` exits unexpectedly | Re-run `@choir init`; if state was paused, choose Resume from the saved wizard prompt. |
