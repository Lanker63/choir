# Choir: Chat Usage Guide

Choir exposes its full feature set through the `@choir` VS Code chat participant. You interact with it by typing commands in the VS Code Chat panel. This document covers every supported command, how they work, and what to expect from each.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Input Syntax](#input-syntax)
3. [Initialization — `@choir init`](#initialization)
4. [Intent Definition — `define`](#intent-definition)
5. [Workspace Analysis — `analyze`](#workspace-analysis)
6. [Planning — `plan`](#planning)
7. [Simulation — `simulate`](#simulation)
8. [Preview — `preview`](#preview)
9. [Execution — `execute`](#execution)
10. [Rollback — `rollback`](#rollback)
11. [Refactoring — `refactor`](#refactoring)
12. [Status — `status`](#status)
13. [Export — `export`](#export)
14. [Approval & Rejection — `approve` / `reject` / `policy status`](#approval--rejection)
15. [Audit — `audit`](#audit)
16. [Macros — `macro`](#macros)
17. [Libraries — `library` / `import`](#libraries)
18. [CI — `ci run`](#ci)
19. [Dependency Graph — `graph`](#dependency-graph)
20. [Verification — `@choir verify`](#verification)
21. [Panel Shortcuts — `control` / `timeline`](#panel-shortcuts)
22. [CLI Installation — `@choir cli install`](#cli-installation)
23. [Abstractions](#abstractions)
24. [Goal Mutation — `remove goal`](#goal-mutation)
25. [Command Chaining](#command-chaining)
26. [Policy & Governance Responses](#policy--governance-responses)
27. [DSL Grammar Reference](#dsl-grammar-reference)

---

## Getting Started

Open the VS Code Chat panel and address the participant with `@choir`. If the workspace has not been initialized, most commands will return:

```
No control plane found in this workspace. Run `@choir init` to initialize Choir for this repository.
```

Sending an empty message to `@choir` prints the full command grammar and example list.

---

## Input Syntax

Choir accepts several equivalent input forms. The parser normalizes them all before dispatch:

| What you type | What it becomes |
|---|---|
| `@choir define goal "X"` | `choir define goal "X"` |
| `define goal "X"` | `choir define goal "X"` |
| `choir define goal "X"` | `choir define goal "X"` |
| `set goal "X"` | `choir define goal "X"` |
| `set mission "X"` | `choir define mission "X"` |
| `show` | `choir status` |
| `show status` | `choir status` |

The `@choir` prefix is always optional for DSL commands. Shortcut commands (`init`, `verify`, `cli install`, etc.) accept the `@choir` prefix; some also work without it.

---

## Initialization

`@choir init` is a guided interactive wizard that populates `.choir/choir.config.yaml` for the first time or updates an existing one.

### Basic init

```
@choir init
```

If a `choir.config.yaml` already exists, you will be prompted to choose **Merge** (upsert wizard values into the existing control plane) or **Overwrite** (start from an empty control plane). A saved wizard session can be resumed if the previous run was paused.

The wizard walks through these steps in order:

1. **Mission** — a single sentence describing the project's purpose
2. **Vision** — the desired future state
3. **Goals** — one or more delivery goals (enter each individually; type `done` to finish)
4. **Constraints** — architectural and policy constraints
5. **Non-goals** — explicit exclusions
6. **Review** — preview the generated DSL before committing
7. **Confirm** — apply or cancel

After the intent wizard completes, Choir discovers workspace packages and topology, then runs an interactive domain-modeling loop to configure strategic posture, runtime governance mode, and per-domain settings.

### Init with a template

```
@choir init --template <template>
```

Templates pre-populate default goals, constraints, priorities, and governance settings for common project archetypes. Available templates:

| Template | Best for |
|---|---|
| `backend` | Service APIs, moderate governance |
| `frontend` | UI packages, iteration-speed focused |
| `fintech-platform` | Regulated financial services, strict governance, canary required |
| `saas-product` | SaaS products, phased rollout |
| `enterprise-monolith` | Large monoliths, low risk, approval-required |
| `internal-tooling` | Internal tools, high risk tolerance, relaxed governance |
| `experimentation-platform` | R&D / prototyping, simulation-only, no execution |
| `distributed-platform` | Distributed systems, canary + phased required |

### Init modes

```
@choir init --expand-domain
```
Adds new domains discovered since the last init without touching existing domain models.

```
@choir init --reclassify
```
Re-classifies domains from scratch when the package topology has changed (packages added or removed). Run this before `--recalibrate` if the package catalog has drifted.

```
@choir init --recalibrate
```
Recalibrates strategic posture for existing domains without reclassifying. Fails closed if the package catalog has changed — run `--reclassify` first.

---

## Intent Definition

Define or update the mission, vision, goals, constraints, and non-goals stored in the control plane.

```
choir define mission "build a deterministic delivery platform"
choir define vision "every deployment is safe, auditable, and reversible"
choir define goal "enforce service boundary contracts"
choir define constraint "no direct database access from API layer"
choir define non-goal "real-time analytics"
```

All values are stored in `.choir/choir.config.yaml` under `mission`, `vision`, and `intent.*`.

**Aliases** — `set` is accepted as a synonym for `define`:

```
set goal "improve test coverage"
set mission "deliver with confidence"
```

Multiple definitions can be chained in a single message (see [Command Chaining](#command-chaining)).

---

## Workspace Analysis

Analyzes the workspace and reports structure, hotspots, or a combined summary.

```
choir analyze workspace
choir analyze hotspots
choir analyze summary
```

| Target | What it returns |
|---|---|
| `workspace` | Full workspace structure analysis |
| `hotspots` | Files or modules with highest change frequency / complexity |
| `summary` | Combined workspace and hotspot overview |

Analysis commands produce no YAML mutations; they are always read-only.

---

## Planning

Generate an execution plan aligned to the current goals and intent.

### Basic plan

```
choir plan
choir plan for "service boundary contracts"
```

Creates or refreshes an execution plan targeting the given goal. Without `for`, the plan is derived from all active goals.

### Optimized plan

```
choir plan --optimize
choir plan --optimize for "service boundary contracts"
```

Runs the multi-stage plan optimization pipeline. Evaluates multiple strategy candidates (canary, phased, batched, all-at-once), scores each against policy, risk, blast-radius, and rollback complexity, then selects the best option. The selected plan is persisted to the control plane.

Output includes:
- Selected plan ID and strategy
- Full candidate ranking with scores
- Pipeline stage results
- Execution stages with parallelization hints

### Adaptive plan

```
choir plan --adaptive
choir plan --adaptive for "service boundaries"
```

Uses adaptive strategy planning with iterative mutation and memory-backed reuse. Reports iterations, strategies evaluated, and the decision trace.

### Approve a draft plan

```
choir plan approve <planId>
```

Transitions a draft plan to approved status in the control plane.

---

## Simulation

Run a dry-run execution of the current or a specific plan. No state mutations are persisted.

```
choir simulate
choir simulate plan <planId>
choir simulate units <unitId>,<unitId2>
```

Output includes strategy, plan source, changed units, violations, policy decisions, replay hashes, and rollback scope.

---

## Preview

Synthesize a read-only execution contract: runs the plan in simulation mode, produces file diffs, and records a `previewHash` that can later be bound to execution.

```
choir preview
choir preview plan <planId>
```

Output includes:
- Preview hash, simulation hash, state hash
- File diff blocks (up to 5 files shown inline)
- Execution stages with parallelization
- Policy violations
- Approval status

If the runtime mode requires approval, the preview records a pending approval ID that must be satisfied before `execute`.

---

## Execution

Execute the current approved plan against the workspace.

```
choir execute
choir execute plan <planId>
choir execute --preview <previewId>
```

### Rollout strategies

```
choir execute --strategy all-at-once
choir execute --strategy canary --steps 1,10,25,100
choir execute --strategy phased --phases 1,2,3
choir execute --strategy batched --batch-size 2
```

| Strategy | Description |
|---|---|
| `all-at-once` | Deploy all units simultaneously |
| `canary` | Progressive traffic steps (e.g., 1%, 10%, 25%, 100%) |
| `phased` | Explicit phase gates |
| `batched` | Fixed-size batches processed sequentially |

Output includes transaction ID, execution hash, final state hash, replay hash, pipeline stages, and execution stages.

---

## Rollback

Revert the workspace to a deterministic prior state after a failed or unwanted execution.

```
choir rollback
choir rollback <unitId>
choir rollback --stage <stageId>
```

| Form | Behavior |
|---|---|
| `choir rollback` | Rolls back the last-deployed unit (auto-detected) |
| `choir rollback <unitId>` | Rolls back a specific workspace unit and all dependents |
| `choir rollback --stage <stageId>` | Rolls back all units in the specified execution stage |

Rollback uses the dependency graph to compute the minimal safe rollback set and validates isolation. Output includes the rollback order, state hashes before and after, and any isolation errors.

---

## Refactoring

Perform governed code refactoring operations that respect workspace boundaries and policy.

### Rename

```
choir refactor rename <symbol> <newName>
choir refactor rename MyService UserService --declaration "src/services/my-service.ts:10:14"
```

The `--declaration` flag pins the refactor to a specific source location (file, line, character) to disambiguate overloaded or shadowed symbols.

### Move

```
choir refactor move <symbol> <targetUnit>
choir refactor move MyService --file "src/modules/users/service.ts"
```

Move is a clean relocation for top-level declarations: dependents are rewritten to import from the new declaration module path, compiler-aware module specifiers are enforced (including explicit `.js` for Node16/NodeNext), and the previous source module does not retain automatic compatibility re-exports for the moved symbol.

When using `--file`, the target must resolve inside the workspace root; unresolved or out-of-root targets fail closed.

### Extract

```
choir refactor extract <symbol> <targetUnit>
choir refactor extract processPayment --file "src/payments/processor.ts"
```

### Inline

```
choir refactor inline <symbol>
```

All refactor operations produce a preview hash, impact report (affected units and files), and inline diff blocks for up to 5 changed files. The result indicates whether the refactor was committed or rolled back.

---

## Status

Display a summary of the current control plane and state plane.

```
choir status
show
show status
```

Output includes:
- Mission and vision
- Goal, constraint, non-goal counts
- Policy rule count
- Plan count (approved vs. draft)
- Pending policy approvals
- State plane hash and violation count
- Active plan and task status breakdown (pending / in-progress / complete / failed)

---

## Export

Export the current control plane as a DSL file or JSON.

### DSL export

```
choir export dsl
choir export dsl all
choir export dsl intent
choir export dsl policy
choir export dsl plans
```

Writes a `.choir/*.dsl` file and prints the DSL inline. Also reports round-trip stability (whether re-parsing the exported DSL reproduces the same YAML).

| Section | File | Contents |
|---|---|---|
| `all` (default) | `choir.dsl` | Complete control plane DSL |
| `intent` | `choir.intent.dsl` | Mission, vision, goals, constraints, non-goals |
| `policy` | `choir.policy.dsl` | Policy rules |
| `plans` | `choir.plans.dsl` | Execution plans |

### JSON export

```
@choir export --format json
```

Exports the control plane as structured JSON. Only `json` is supported; other formats return an error.

---

## Approval & Rejection

When a command is blocked by a policy that requires approval rather than an outright deny, the YAML is **not** mutated and a pending diff is recorded.

### View pending approvals

```
choir policy status
```

Lists all pending approval IDs and the commands that triggered them.

### Approve

```
choir approve <diffId>
```

Marks the pending diff as approved. After approving, **re-run the original command** to apply it.

### Reject

```
choir reject <diffId>
```

Discards the pending diff permanently.

---

## Audit

Query and report on the append-only audit log at `.choir/audit.log.jsonl`.

### Tail the log

```
choir audit log
```

Displays the 20 most recent events: timestamp, actor role, action, and result.

### Generate a compliance report

```
choir audit report
```

Produces a compliance report with totals (approvals required, denials, violations, anomalies) and recent activity. Writes three artifacts:

```
.choir/reports/compliance-report.json
.choir/reports/compliance-report.yaml
.choir/reports/compliance-report.pdf
```

### Query the log

```
choir audit query role=architect
choir audit query environment=production
choir audit query action=compile-dsl
choir audit query role=conductor,environment=ci
choir audit query from="2024-01-01" to="2024-12-31"
```

Filters can be combined with commas. Valid values:

| Filter | Valid values |
|---|---|
| `role` | `architect`, `analyst`, `conductor`, `enforcer` |
| `environment` | `local`, `ci`, `staging`, `production` |
| `action` | any action string (e.g., `compile-dsl`, `policy-evaluation`) |
| `from` / `to` | ISO date strings; both must be provided together |

Displays up to 20 matching records.

---

## Macros

Macros are parameterized command templates. They can be local (`.choir/macros.yaml`) or sourced from installed libraries.

### List macros

```
choir macro list
```

Lists all macros from installed libraries and local definitions, with version and description.

### Inspect a macro

```
choir macro show <macroId>
choir macro show architecture.hexagonal
```

Shows the macro's version, description, parameters (with defaults and required flags), and the command body.

### Run a macro

```
choir macro <macroId> key="value",key2="value2"
choir macro bootstrap-service name="user-service"
```

Executes the macro by expanding its body with the supplied arguments, then running each resulting DSL command in sequence. Output shows per-step decision, diff hash, and any pending approval IDs.

---

## Libraries

Macro libraries extend Choir with reusable macro collections.

### Import (shorthand)

```
choir import core@1.0.x
choir import refactoring@2.x
```

Registers the library and resolves a compatible version. Version selectors support exact (`1.0.0`), minor wildcard (`1.0.x`), and major wildcard (`1.x`).

### Install

```
choir library install core@1.0.0
```

Installs the library into `.choir/libraries/core/` and writes a lock entry to `choir.lock`.

### Update

```
choir library update core
```

Resolves the latest compatible version and updates the lockfile.

### Lock

```
choir library lock
```

Refreshes the `choir.lock` file for all installed libraries. Output shows each library with its locked version, selector, and integrity hash.

### List

```
choir library list
```

Lists all locally available libraries with their available versions, selectors, capability counts, compatibility, and lock status.

> **Note:** `import`, `install`, and `update` are gated by the runtime governance capability check. If the workspace is in a mode that disables these capabilities, a `runtime-governance:` block will be returned instead.

---

## CI

Run the Choir CI pipeline against the current control plane.

```
choir ci run
```

Evaluates policy, validates plans, and checks governance rules in a non-interactive pipeline context. The result includes stage-by-stage pass/fail details.

---

## Dependency Graph

Open the interactive dependency graph panel.

```
choir graph
@choir graph
```

Opens the full dependency graph.

```
choir graph focus <nodeId>
choir graph dependencies <nodeId>
choir graph dependents <nodeId>
```

| Mode | Description |
|---|---|
| `focus <nodeId>` | Centers the graph on a specific node |
| `dependencies <nodeId>` | Shows only the nodes that `nodeId` depends on |
| `dependents <nodeId>` | Shows only the nodes that depend on `nodeId` |

Node IDs correspond to workspace unit identifiers (e.g., package paths like `packages/api` or `services/auth`).

---

## Verification

Runtime verification runs a suite of checks against the current workspace. All modes run within the extension — no external target repository access is required.

### Modes

```
@choir verify
@choir verify --quick
@choir verify --property
@choir verify --contracts
@choir verify --determinism
@choir verify --transactions
@choir verify --state
@choir verify --policy
@choir verify --orchestration
@choir verify --production
@choir verify --compiler
@choir verify --full
@choir verify --chaos
@choir verify --chaos light
@choir verify --chaos moderate
@choir verify --chaos extreme
```

| Flag | Scope |
|---|---|
| _(none)_ | Standard full verification |
| `--quick` | Abbreviated check set, fastest |
| `--property` | Property-based invariant checks |
| `--contracts` | Contract boundary validation |
| `--determinism` | Replay and determinism counter checks |
| `--transactions` | Transaction integrity checks |
| `--state` | State plane consistency checks |
| `--policy` | Policy enforcement verification |
| `--orchestration` | Orchestration execution counter health |
| `--production` | Production readiness snapshot checks |
| `--compiler` | Compiler pipeline integrity |
| `--full` | Full system verification (all checks) |
| `--chaos` | Chaos injection; modes: `light`, `moderate` (default), `extreme` |

> `--chaos extreme` is intentionally source-only and will not perform injection in the runtime-safe verification path.

Each mode returns a structured report with named checks, pass/fail status, and a detail message per check.

---

## Panel Shortcuts

Open VS Code webview panels directly from chat.

```
@choir control
```
Opens the **Control Center** panel — a visual editor for the control plane.

```
@choir timeline
```
Opens the **Timeline** panel — a chronological view of execution and state transitions.

---

## CLI Installation

Install the Choir CLI tool into the current workspace or globally.

```
@choir cli install
```

A two-step interactive prompt:

1. **Scope** — choose local (`npm install --save-dev`) or global (`npm install -g`)
2. **Package source** — enter the package specifier (e.g., `@your-org/choir-cli` or `github:owner/repo#tag`)

The install command is sent to a new VS Code terminal. Verify the install with `choir --help` after the terminal completes.

---

## Abstractions

Abstractions are named, multi-step command sequences defined in `.choir/abstractions.yaml`. They expand into DSL commands (and optionally macros) at execution time.

### List available abstractions

```
@choir list abstractions
```

### Describe an abstraction

```
@choir describe <abstractionId>
@choir describe enforce-hexagonal-architecture
```

### Run an abstraction

```
@choir run <abstractionId>
@choir run migrate-to-service-layer
```

Abstractions can also be invoked directly via the DSL with optional arguments:

```
choir <abstractionId> key="value",key2="value2"
choir bootstrap-service name="user-service"
```

### Built-in abstractions

| ID | Description |
|---|---|
| `enforce-hexagonal-architecture` | Applies hexagonal architecture guardrails, generates a plan, and runs a preview |
| `migrate-to-service-layer` | Migrates modules to service-layer boundaries and generates a plan |

Custom abstractions are defined in `.choir/abstractions.yaml` and are discovered automatically.

---

## Goal Mutation

Remove an existing goal from the control plane.

```
@choir remove goal "enforce service boundaries"
@choir remove goal: enforce service boundaries
```

The goal text must match an existing goal in the control plane (exact match, case-sensitive). If the goal is not found, an error is returned.

---

## Command Chaining

Multiple DSL actions can be chained in a single message using `then`:

```
choir define mission "X" then define vision "Y"
choir define goal "A" then define constraint "B" then define non-goal "C"
choir analyze workspace then define goal "address hotspots"
```

The following commands **cannot** be chained and must be sent individually:

`export`, `approve`, `reject`, `policy status`, `import`, `library`, `ci run`, `abstraction`, `audit`, `macro`, `graph`, `simulate`, `refactor`, `rollback`, `plan --optimize`, `plan --adaptive`, `execute --strategy`

---

## Policy & Governance Responses

Every mutating DSL command is evaluated by the policy engine before any YAML write. There are three possible outcomes:

### Allow

The YAML is written to `.choir/choir.config.yaml` and a compilation trace is rendered.

### Require Approval

```
Policy approval required. YAML was not mutated.
- diffId: pending-abc123
- diffHash: sha256:...
Approve with: choir approve <diffId>
Reject with: choir reject <diffId>
```

The pending diff is stored. Re-run the original command after approving.

### Deny

```
Policy violation. YAML mutation denied.

- [rule-id] Reason the rule was triggered
```

The YAML is not written. Review the policy rules in the control plane to understand the violation.

### Runtime Governance Block

Some capabilities are restricted by the workspace's runtime governance mode:

```yaml
runtime-governance:
  status: blocked
  mode: simulation-only
  capability: install
  decision: deny
  reason: capability not permitted in current mode
```

To enable blocked capabilities, update the `runtime.mode` in the control plane via `@choir init --recalibrate` or by directly editing `.choir/choir.config.yaml`.

---

## DSL Grammar Reference

The complete formal grammar:

```bnf
<command> ::= "choir" <action> ("then" <action>)*

<action> ::=
    <define>
  | <analyze>
  | <plan>
  | <refactor>
  | <simulate>
  | <preview>
  | <execute>
  | <rollback>
  | <status>
  | <export>
  | <approve>
  | <reject>
  | <policy-status>
  | <import>
  | <library>
  | <ci>
  | <audit>
  | <macro>
  | <graph>
  | <abstraction>

<define>      ::= "define" ("mission"|"vision"|"goal"|"constraint"|"non-goal") <string>
<analyze>     ::= "analyze" ("workspace"|"hotspots"|"summary")
<plan>        ::= "plan" ["for" <string>] ["--optimize"] ["--adaptive"]
                | "plan" "approve" <identifier>
<refactor>    ::= "refactor" "rename" <identifier> <identifier> ["--declaration" <string>]
                | "refactor" "move"    <identifier> (<identifier> | "--file" <string>)
                | "refactor" "extract" <identifier> (<identifier> | "--file" <string>)
                | "refactor" "inline"  <identifier>
<simulate>    ::= "simulate" [<plan-ref>] | "simulate" "units" <id-list>
<preview>     ::= "preview" [<plan-ref>]
<execute>     ::= "execute" [<plan-target>] ["--preview" <id>]
                  ["--strategy" ("all-at-once"|"canary"|"phased"|"batched")]
                  ["--steps" <int-list>] ["--phases" <int-list>] ["--batch-size" <int>]
<rollback>    ::= "rollback" | "rollback" <identifier> | "rollback" "--stage" <identifier>
<status>      ::= "status"
<export>      ::= "export" "dsl" ["all"|"intent"|"policy"|"plans"]
<approve>     ::= "approve" <identifier>
<reject>      ::= "reject" <identifier>
<policy-status> ::= "policy" "status"
<import>      ::= "import" <library-spec>
<library>     ::= "library" ("list"|"install" <spec>|"update" <id>|"lock")
<ci>          ::= "ci" "run"
<audit>       ::= "audit" ("log"|"report"|"query" [<filters>])
<macro>       ::= "macro" ("list"|"show" <id>|<id> [<args>])
<graph>       ::= "graph" ["focus"|"dependencies"|"dependents" <identifier>]
<abstraction> ::= <identifier> [<args>]

<library-spec> ::= <identifier> "@" <version-selector>
<version-selector> ::= MAJOR.MINOR.PATCH | MAJOR.MINOR.x | MAJOR.x
<args>        ::= <key>="<value>" ("," <key>="<value>")*
<int-list>    ::= <int> ("," <int>)*
<plan-ref>    ::= "plan" <identifier>
<string>      ::= QUOTED_STRING
<identifier>  ::= [a-zA-Z0-9._-]+
```
