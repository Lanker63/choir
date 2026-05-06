# Choir

**Choir** is a VS Code extension for deterministic, policy-driven workspace governance. It reads a committed YAML control plane, compiles intent and policy into executable rules, emits diagnostics, coordinates planning and execution through `@choir` (routing to internal roles: Architect, Enforcer, Analyst, Conductor), records immutable audit evidence, supports versioned macro libraries, includes a time-travel replay debugger, distributed sync core, global orchestration core, and monorepo/workspace-aware multi-package orchestration.

---

## Requirements

- VS Code 1.90+
- A workspace folder open
- TypeScript/JavaScript source files (`.ts`/`.js`)

---

## Installation

Search **"Choir"** on the VS Code Marketplace, or install a `.vsix` manually:

```
Extensions panel → ··· menu → Install from VSIX…
```

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

Commit this file. Policy sources:

- `/org/policies.dsl` — org-level gates
- `.choir/policies.dsl` — repo-level gates (auto-created if missing)
- Environment policies — runtime-derived, applied last
- Effective policy: `org → repo → environment` (deterministic; org policies propagate to all repos in global orchestration scope; no opt-out)

Commit `/org/policies.dsl` and `.choir/policies.dsl` alongside `.choir/choir.config.yaml`.

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

Policy rules are authored in DSL and merged across hierarchy layers. Runtime flow: `Policy DSL → AST → Compiled Rules → Merge Engine → Policy Engine`. Decision model: `f(yamlDiff, role, environment)`. Parent `deny` is never bypassable by child layers. Merge order: `org → repo → environment`.

Selectors: `diff.path`, `diff.operation`, `macro`, `role`, `environment`, `contains`, `count > N`  
Effects: `allow`, `deny`, `require-approval`  
Inheritance: `inherit assign|append|remove`, `override child|none`

Grammar:

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

Examples:

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

Environment policies are evaluated last; production injects strict deny rules for `execution.plans` mutations.

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

Deterministic orchestration layer:

- State → plan synthesis (deterministic ids, stable ordering)
- Cost-based plan scoring and selection
- Multi-strategy plan shaping (simulation-based, no LLM)
- Adaptive strategy refinement from prior outcomes
- Execution previews derived from simulation
- Multi-plan DAG merge with conflict-aware batching
- Transactional batch execution (`simulate → validate → commit/rollback`)
- Global orchestration across repos with org policy propagation and rollback-all semantics

All code mutations flow through the Enforcer.

### Global Orchestration + Org-Wide Policy Propagation (Alpha Core)

Deterministic multi-repo execution with org policy enforcement.

Key types: `Repo`, `GlobalContext`, `GlobalDependencyGraph`, `GlobalPlan`, `ExecutionOrder`, `TaskBatch`, `OrgPolicy`, `PolicyPropagation`, `GlobalAudit`, `GlobalTrace`

**Plan synthesis:** `buildGlobalDependencyGraph` (inter-repo edges; fails on cycles) → `synthesizeGlobalPlan` (one deterministic DAG, `repoId:taskId` ids) → `validateGlobalPlan` (no missing deps, no cycles, no conflicting actions) → `orderPlan`/`batchTasks` (topological; parallel-safe)

**Policy enforcement:** `propagatePolicies` distributes org policies to all repos (no opt-out); `evaluateGlobalPolicies` detects cross-repo violations (e.g., upstream API break with no downstream adaptation); any deny/required-approval blocks the entire plan.

**Execution:** `executeGlobalPlan` runs dependency-ordered, validates each step, rolls back all repos on failure. `createGlobalPlanningCache` provides deterministic incremental planning keyed by input hash.

**Workspace detection (`detectWorkspace`):** Before building the global DAG, Choir automatically discovers the workspace topology. Supported workspace tools: `pnpm`, `yarn`, `npm`, `nx`, `turbo`. Detection precedence: `nx.json` → `turbo.json` → `pnpm-workspace.yaml` → `package.json#workspaces` → root fallback. Each discovered package path resolves to a `Repo` instance in the global orchestration engine. Detection is deterministic: identical root path → identical sorted, de-duplicated `WorkspaceConfig.packages` list. Type:

```ts
type WorkspaceConfig = {
  type: "pnpm" | "yarn" | "npm" | "nx" | "turbo";
  root: string;
  packages: string[]; // sorted, unique, node_modules/.git/dist/out excluded
};
```

Pass 6 of the architecture harness covers: determinism, inter-repo edges, cycle rejection, ordering, batching, policy propagation, cross-repo gating, rollback-all, drift detection, cache reuse. Passes 6.11–6.14 cover workspace detection: pnpm workspace parsing, turbo/nx precedence, determinism across multiple calls, and de-duplication of overlapping glob patterns. Current scope: core engine + tests; UI integration is a separate layer.

### Distributed State Synchronization (Alpha Core)

Deterministic multi-repo state replication.

Key types: `Replica`, `LogicalClock`, `VersionVector`, `ChangeSet`, `StateOperation`

- `computeDelta`/`applyDelta`: delta sync with explicit conflict records; no silent drops
- `mergeStates`/`mergeReplicaStates`: commutative; last-write-wins default (logical clock) with tie-break
- Clock: increment `+= 1`; merge `= max + 1`; modes: `push`, `pull`, `bidirectional`
- Security: trusted source + signed changeset verification; tamper → manual-resolution conflict
- Transport abstraction with in-memory implementation; optional `onStateChange` pub/sub

Architecture harness covers: clocks, deltas, merge commutativity, sync modes, version vectors, security/tamper, transport, batching, compression, manual conflict paths.

### Cost-Based Plan Selection

Static, execution-free scoring:

```text
totalCost = editCost×1.0 + fileTouchCost×2.0 + riskCost×5.0 + dependencyCost×1.5 − violationReduction×3.0
```

Lowest cost wins; `planId` lexicographic tie-break. Output: cost trace with scores and decision.

### Multi-Strategy Plan Selection

Each selected plan is evaluated across `minimal`, `grouped`, `layered`, `aggressive`.

- Simulation-only (`prepare → simulate → validate`; no commit or state persistence)
- Selection: validated > failed; rank by violations → errors → patches → files; `strategyId` tie-break
- Output: strategy trace with per-strategy metrics, selected id, decision reason

### Adaptive Strategy Generation (Deterministic)

Bounded refinement iterations after baseline (no LLM, no randomness):

- Extract failure patterns → apply rule-based mutations from fixed registry → re-evaluate pool
- Stop on: success + `remainingViolations === 0`, no new strategies, or max iterations
- Adaptive ids: deterministic hash of strategy + pattern + mutation + plan shape; pool size capped
- Trace: iteration count, strategies evaluated, mutations applied, selected id, decision log

### Strategy Memory and Reuse (Deterministic)

- `.choir/memory.json`; keyed by deterministic context signature (goals, constraints, violation summary, module hints)
- Reuse if `success === true` and `remainingViolations === 0`; select by lowest `patchesCount`
- Applicability check before reuse; fallback to adaptive evaluation on failure; bounded and deduplicated

### Execution Preview and Approval Gate

- Simulation-derived; never writes real files; deterministic for identical inputs
- Hash: `sha256(JSON.stringify(preview.fileChanges))` — binds approval to exact file-change content
- Execution requires matching preview hash; hash mismatch rejects execution and requires a fresh preview

---

## Unified Agent Interface

Entry point: `@choir`. Only `@choir` is a contributed chat participant — internal roles (`architect`, `analyst`, `conductor`, `enforcer`) are not directly addressable.

Commands are strict DSL; no natural-language command parsing.

### Time-Travel Replay Debugger UI

Surface: `timeline-view` tab in the Control Center webview.

- Controls (action messages, not DSL): `play`, `pause`, `step-forward`, `step-backward`, `jump`
- Inspector: why summary, dependency chain, replayed state (`intent`, `ast`, `violations`, `plans`), patch diff table (`path`, `op`, `before`, `after`), replay trace
- Playback advances on a fixed timer; auto-pauses at end; verifies hash continuity; snapshot fallback on mismatch

### Interactive Init Wizard (`@choir init`)

```
@choir init [--template backend|frontend]
```

Step-driven: `mission → vision → goals → constraints → non-goals → review → confirm`

- `back` navigates; `cancel` exits; dismiss pauses and saves state to `.choir/init-state.json` for resume
- Generates DSL commands at confirmation; applied through DSL compiler + policy gate; no direct YAML writes

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

`DSL -> Tokens -> AST -> Validation -> Incremental Rule Engine -> compiler -> choir.config.yaml -> pipeline`

### Choir DSL Editor Language Support (`.choir`)

- Language id: `choir`; file extension: `.choir`
- Syntax: TextMate grammar highlights keywords, strings, identifiers, comments
- IntelliSense: grammar-state driven, valid next tokens only (no LLM); hover for keywords
- Validation: reuses `parseCommand`; parse errors surfaced inline
- Config: line comments `#`; bracket pairs `{}`, `()`; auto-closing `"`
- Snippets: built-in for all DSL commands
- Trace: `Choir: Show DSL Editor Trace` (completions, diagnostics, parse errors)

### Internal Architect Role

Defines intent values in `.choir/choir.config.yaml`:

```
choir define mission "deterministic engineering workflow"
choir define vision "policy-native delivery platform"
choir define goal "enforce service boundaries"
choir define constraint "no direct db access"
choir define non-goal "distributed app"
```

### Internal Enforcer Role

Not directly user-addressable. Evaluates all mutations.

### YAML Compiler Behavior

Transactional and deterministic:

1. Tokenize + parse full input
2. Validate AST (`structure → semantics → cross-node`)
3. Incremental rule engine: dependency graph → diff changed nodes → propagate affected → execute indexed rules; cache for unaffected; invalidate changed
4. Apply mutations in memory after validation; validate config against schema
5. Write `.choir/choir.config.yaml` once; build incremental + full state projections; compare before persistence
6. Atomic write + rollback-safe persistence for `state.json`

Trace includes: changed/affected nodes, executed rules, cache usage, fallback status, performance metrics.

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

Intent-level commands that compile into macro + DSL steps: `Abstraction → Macro Composition → DSL → YAML → Policy → Execution → Audit`

Storage: `.choir/abstractions.yaml`. Model: `id`, `version`, `description`, `parameters[]`, `expandsTo[]`.

Built-in: `enforce-hexagonal-architecture`, `migrate-to-service-layer`

Commands: `@choir list abstractions`, `@choir describe <id>`, `choir <id> [key="value"]`

Example:

```yaml
abstractions:
  - id: bootstrap-service
    version: 1.0.0
    parameters:
      - name: name
        required: true
    expandsTo:
      - choir macro architecture.create-service name="{{name}}"
      - choir macro core.enforce-service-boundaries
      - choir plan
      - choir preview
```

---

## Macro Libraries

Versioned, lockfile-pinned, local-only macro libraries.

- Storage: `.choir/libraries/<lib>/<ver>/macros.yaml`; versions immutable
- Lock: `.choir/lock.yaml` pins resolved versions
- Commands: `choir import core@1.0.x`, `choir library list|install|update|lock`
- Namespaced as `<library>.<macroId>`; no unversioned macros; no network calls; breaking changes require MAJOR bump

---

## Audit and Compliance Reporting

Append-only, hash-chained audit log: `.choir/audit.log.jsonl` (chain anchored at `GENESIS`).

Audited: `policy-evaluation`, `compile-dsl`, `approval-granted`, `approval-rejected`, `execute-plan`, `macro-execution`, `ci-policy-gate`, `ci-pipeline`, `abstraction-execution`

- `choir audit log` — recent events
- `choir audit query role=..., environment=..., action=..., from="...", to="..."` — filtered
- `choir audit report` → `.choir/reports/compliance-{report.json,.yaml,.pdf}`

Report fields: `totalEvents`, `approvalsRequired`, `denials`, `violations`, `anomalies`. Macro records include library provenance metadata.

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

Pipeline runs on save; diagnostics published to **Problems** (`View → Problems`).

`state.json` contains: projected state, AST/dependency metadata, diagnostics, metrics, execution runtime state, `strategyHistory`.

State correctness:

- Strict read validation; atomic write with pre/post validation; rollback-safe
- Transitions: deterministic records (`id`, `fromHash`, `toHash`, `action`, `timestamp`, `diff`, metadata)
- Snapshots: hybrid cadence (initial + every 5 transitions)
- Replay: `jumpTo`, `replayTo`, `stepForward`, `stepBackward`; hash continuity verified; snapshot fallback on mismatch
- Distributed sync: deterministic delta/merge, explicit conflicts, convergence checks, tamper rejection
- Global orchestration: full plan + policy validation before execution; rollback-all on failure; deterministic propagation

Artifacts:

| Path | Purpose |
|---|---|
| `.choir/state.json` | Derived state (reproducible) |
| `.choir/state.snapshots.jsonl` | Rollback snapshots |
| `.choir/state.transitions.jsonl` | Append-only transition log |
| `.choir/state.audit.jsonl` | Append-only state audit |
| `.choir/audit.log.jsonl` | Compliance audit log |
| `.choir/memory.json` | Strategy memory |
| `.choir/lock.yaml` | Library version lock |
| `.choir/ci.yaml` | CI pipeline config |
| `.choir/abstractions.yaml` | Abstraction registry |
| `.choir/libraries/` | Macro library manifests |
| `.choir/artifacts/ci/` | CI run artifacts |
| `.choir/reports/` | Compliance report exports |

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
| `Unable to read valid state.json` appears | Validate or remove the corrupted `.choir/state.json`, then rerun a pipeline/compile command so Choir can regenerate a valid derived state. |
