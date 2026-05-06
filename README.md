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

- define, analyze, plan, preview, execute, status
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
- Libraries:
  - choir import <lib>@<selector>
  - choir library list|install|update|lock
- CI:
  - choir ci run

## DSL Grammar (Compact)

```bnf
<command> ::= "choir" <action> ("then" <action>)*

<action> ::= <define> | <analyze> | <plan> | <preview> | <execute> | <status>
           | <export> | <approve> | <reject> | <policy-status>
           | <graph> | <import> | <library> | <ci> | <audit> | <macro> | <abstraction>

<define> ::= "define" ("mission" | "vision" | "goal" | "constraint" | "non-goal") <string>
<analyze> ::= "analyze" ("workspace" | "hotspots" | "summary")
<plan> ::= "plan" ["for" <string>] | "plan" "approve" <identifier>
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
- Preview is simulation-derived and hash-bound to execution
- Transactional execution: simulate -> validate -> commit/rollback
- Global orchestration validates full cross-repo graph and policy before execution
- Any global execution failure triggers rollback-all

Preview hash gate:

```text
hash = sha256(JSON.stringify(preview.fileChanges))
```

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
