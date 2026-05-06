# Choir

Choir is a VS Code extension for deterministic, policy-driven workspace governance.

It compiles intent and policy into executable checks, plans and previews changes, executes with approval gates, records immutable audit evidence, and supports distributed sync plus multi-repo orchestration.

## Requirements

- VS Code 1.90+
- Open workspace folder
- TypeScript/JavaScript codebase

## Install

- Install from Marketplace: Choir
- Or install a .vsix from Extensions > Install from VSIX...

## Quick Start

1. Initialize:
   - Run @choir init
   - Or create .choir/choir.config.yaml manually
2. Add policy sources:
   - /org/policies.dsl
   - .choir/policies.dsl
3. Commit all three files.

Minimal config:

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

## Core Model

- Control plane (authoritative): .choir/choir.config.yaml
- State plane (derived): .choir/state.json
- Interaction plane (ephemeral): chat and commands

Policy merge order is deterministic: org -> repo -> environment.
Parent deny cannot be bypassed.

## Main Commands

Entry point: @choir

Core flow:

- define, analyze, plan, simulate, preview, execute, status
- deterministic plan optimization: choir plan --optimize [for "<goalRef>"]
- approve/reject policy-gated diffs
- export deterministic DSL projections

Additional commands:

- Graph:
  - @choir graph
  - @choir graph focus <node>
  - @choir graph dependencies <node>
  - @choir graph dependents <node>
- Chat panel shortcuts:
  - @choir control
  - @choir timeline
- UI panels:
  - Choir: Open Control Center
  - Choir: Open Dependency Graph
  - Choir: Open Timeline
- Governance:
  - choir policy status
  - choir audit log|query|report
- Refactor (PASS 1):
  - choir refactor rename <symbol> <newName>
  - choir refactor inline <symbol>
  - choir refactor move <symbol> <targetUnit> (parsed/planned; execution path not yet enabled)
  - choir refactor extract <symbol> <targetUnit> (parsed/planned; execution path not yet enabled)
- Libraries:
  - choir import <lib>@<selector>
  - choir library list|install|update|lock
- CI:
  - choir ci run

## DSL Grammar (Compact)

```bnf
<command> ::= "choir" <action> ("then" <action>)*

<action> ::= <define> | <analyze> | <plan> | <simulate> | <preview> | <execute> | <status>
           | <refactor> | <export> | <approve> | <reject> | <policy-status>
           | <graph> | <import> | <library> | <ci> | <audit> | <macro> | <abstraction>

<define> ::= "define" ("mission" | "vision" | "goal" | "constraint" | "non-goal") <string>
<analyze> ::= "analyze" ("workspace" | "hotspots" | "summary")
<plan> ::= "plan" ["for" <string>] ["--optimize"]
         | "plan" "--optimize" ["for" <string>]
         | "plan" "approve" <identifier>
<simulate> ::= "simulate" ["plan" <identifier>] | "simulate" "units" <identifier> ("," <identifier>)*
<refactor> ::= "refactor" "rename" <identifier> <identifier>
             | "refactor" "move" <identifier> <identifier>
             | "refactor" "extract" <identifier> <identifier>
             | "refactor" "inline" <identifier>
<preview> ::= "preview" ["plan" <identifier>]
<execute> ::= "execute" ["plan" <identifier>]
<status> ::= "status"
<export> ::= "export" "dsl" ["all" | "intent" | "policy" | "plans"]
<approve> ::= "approve" <identifier>
<reject> ::= "reject" <identifier>
<policy-status> ::= "policy" "status"
<graph> ::= "graph" | "graph" "focus" <identifier> | "graph" "dependencies" <identifier> | "graph" "dependents" <identifier>
<import> ::= "import" <library-spec>
<library> ::= "library" "list" | "library" "install" <library-spec> | "library" "update" <identifier> | "library" "lock"
<ci> ::= "ci" "run"
<audit> ::= "audit" "log" | "audit" "report" | "audit" "query" [<audit-filters>]
<macro> ::= "macro" "list" | "macro" "show" <identifier> | "macro" <identifier> [<args>]

<library-spec> ::= <identifier> "@" <version-selector>
<version-selector> ::= MAJOR "." MINOR "." PATCH | MAJOR "." MINOR "." "x" | MAJOR "." "x"
<args> ::= <key-value> ("," <key-value>)*
<key-value> ::= <identifier> "=" <string>
<identifier> ::= [a-zA-Z0-9._-]+
```

## Execution and Safety

- Deterministic planning and strategy selection
- Strategy selection simulates all candidates before selection (no heuristic-only path)
- Ranking order is deterministic: violations -> risk -> changes -> executionCost (lexical id tie-break)
- Violating strategies are excluded by default unless explicitly allowed
- Preview is simulation-derived and hash-bound to execution
- Transactional execution: simulate -> validate -> commit/rollback
- Global orchestration validates full cross-repo graph and policy before execution
- Any global execution failure triggers rollback-all

Preview hash gate:

```text
hash = sha256(JSON.stringify(preview.fileChanges))
```

Refactor safety notes (PASS 1):

- Refactors run through the same deterministic preview/validation/commit pipeline.
- Rename and inline are executable with rollback snapshots.
- Move and extract are accepted at DSL parse/plan level, but execution is intentionally fail-closed until full transformation support lands.

Org-wide simulation notes:

- `choir simulate` runs deterministic, non-mutating simulation with the same execution logic as real execution.
- `choir simulate units <unitA>,<unitB>` simulates selected units plus dependency closure.
- `choir plan --optimize` simulates all candidate strategies and returns explainable ranking and selected strategy.
- Simulation is an execution gate: failed simulation blocks execution.
- Execution enforces simulation equivalence and fails closed on divergence.

## Workspace Detection

detectWorkspace precedence:

1. nx.json
2. turbo.json
3. pnpm-workspace.yaml
4. package.json workspaces
5. root fallback

Package output is sorted and unique; node_modules, .git, dist, out are excluded.

## CI

Run:

```text
choir ci run
```

Canonical stage order:

```text
source -> compile -> plan -> policy -> preview -> execute -> audit
```

Artifacts:

- .choir/artifacts/ci/<run-key>/plan.json
- .choir/artifacts/ci/<run-key>/preview.json
- .choir/artifacts/ci/<run-key>/preview.diff
- .choir/artifacts/ci/<run-key>/execution.json (if execute runs)
- .choir/artifacts/ci/<run-key>/audit.log
- .choir/artifacts/ci/<run-key>/trace.json

## Audit and Reports

- Audit log: .choir/audit.log.jsonl
- Append-only and hash-chained from GENESIS
- Reports: .choir/reports/compliance-{report.json,report.yaml,report.pdf}

## UI Surfaces

- Rules view
- Control Center panel (full editor webview)
- Dependency Graph panel (full editor webview)
- Timeline panel (full editor webview)

## Workspace-Aware Timeline (PASS 1)

- Timeline transitions are now workspace-unit aware.
- Each transition records a deterministic logical clock and unit id.
- Timeline events project into:
  - one global timeline
  - one per-unit timeline
- If no unit is provided, the transition is scoped to workspace:root.
- Determinism guarantee: same ordered transitions -> same global and unit replay ordering.

Webview synchronization contract:

- Extension host is the single state owner
- Control Center, Graph, and Timeline are pure projections
- Sync is push-based via typed event bus
- No polling-based state sync

From the main Choir activity bar, persistent toolbar icons on the Rules view header open:

- Control Center panel
- Dependency Graph panel
- Timeline panel

Command palette:

- Choir: Open Control Center
- Choir: Open Dependency Graph
- Choir: Open Timeline
- Choir: Show Webview Sync Trace
- Choir: Show DSL Editor Trace

## Key Artifacts

- .choir/choir.config.yaml
- .choir/state.json
- .choir/state.snapshots.jsonl
- .choir/state.transitions.jsonl
- .choir/state.audit.jsonl
- .choir/audit.log.jsonl
- .choir/memory.json
- .choir/lock.yaml
- .choir/ci.yaml
- .choir/abstractions.yaml
- .choir/libraries/
- .choir/artifacts/ci/
- .choir/reports/

## Troubleshooting

- No diagnostics: ensure workspace is open and .choir/choir.config.yaml exists
- Parse/schema issues: check Problems panel and YAML/DSL structure
- No DSL completion/hover: use .choir extension and Choir DSL language mode
- Invalid state.json: fix/remove .choir/state.json, then rerun pipeline command
