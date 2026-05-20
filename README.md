# Choir

Choir is a VS Code extension for deterministic, policy-driven workspace governance.

It compiles intent and policy into executable checks, plans and previews changes, executes with approval gates, records immutable audit evidence, and supports distributed sync plus multi-repo orchestration.

---

## Requirements

- VS Code 1.90+
- Open workspace folder

## Development Workflow

- Use strict TDD for source-code changes: RED (focused failing test) -> GREEN (minimal fix) -> REFACTOR (safe cleanup) -> regression/build validation.

## Testing Workflow

- Fast TDD loop (source logic units): `npm run test:unit`
- Watch mode for local TDD: `npm run test:unit:watch`
- Unit-only coverage snapshot: `npm run test:unit:coverage`
- Full default test pass: `npm test` (unit + rules + architecture)
- Verification/hardening suites remain available: `npm run verify`, `npm run verify:full`

## Install

- Install from Marketplace: **Choir**
- Or install a `.vsix` from **Extensions > Install from VSIX...**

> Extension install does not add a global `choir` executable to your shell `PATH`.

---

## Quick Start

1. Open a workspace in VS Code.
2. Run `@choir init` in the Chat panel (or create `.choir/choir.config.yaml` manually).
3. Add policy sources at `/org/policies.dsl` or `.choir/policies.dsl`.
4. Commit all three files.

Minimal config:

```yaml
version: "1.0.0"
registries:
  - local
  - org
mission: ""
vision: ""
intent:
  goals: []
  constraints: []
  nonGoals: []
packages: {}
domains: {}
contexts: {}
policy:
  rules: []
execution:
  plans: []
```

---

## What Choir Does

| Capability | Description |
| --- | --- |
| **Strategic Init** | Deterministic workspace discovery → domain mapping → governance synthesis |
| **Policy Evaluation** | Deterministic merge order: org → repo → environment. Parent deny cannot be bypassed. |
| **Planning** | Simulates all candidate strategies before selection; deduplicates equivalent configured plan families for deterministic candidate counts and produces explainable ranked output |
| **Preview** | Hash-bound, simulation-derived preview of every planned change |
| **Execution** | Staged, dependency-aware rollout (canary / phased / batched / all-at-once) with approval gates |
| **Rollback** | Failure-isolated rollback restores control-plane state and workspace snapshot |
| **Audit** | Append-only, hash-chained audit log from GENESIS; compliance reports in JSON/YAML/PDF |
| **Refactoring** | Deterministic rename/move/extract/inline through the same preview → execute pipeline |
| **Libraries** | Registry-backed capability bundles with integrity-hash enforcement and deterministic locking |
| **CI Integration** | `choir ci run` executes the canonical pipeline: source → compile → plan → policy → preview → execute → audit |
| **Compilation Trace** | Operator-facing trace output includes command input and normalized changes (AST payload intentionally omitted) |

---

## Core Model

| Plane | Artifact | Role |
| --- | --- | --- |
| Control plane | `.choir/choir.config.yaml` | Authoritative intent and policy |
| State plane | `.choir/state.json` | Derived, replay-validated runtime state |
| Interaction plane | Chat / CLI commands | Ephemeral operator input |

Runtime guarantee: `preview == simulation == execute == replay`

Strategic mapping guard: package/context domain references fail closed when they target an unknown domain.

---

## Intent Concepts

| Concept | Meaning |
| --- | --- |
| Mission | Why this system/domain exists right now |
| Vision | What this system/domain is ultimately trying to become |
| Goal | Optimize toward this |
| Constraint | Never violate this |
| Non-goal | Do not spend optimization effort pursuing this |

---

## Usage

- **VS Code Chat** (`@choir …`): See [CHAT_USAGE.md](CHAT_USAGE.md)
- **Standalone CLI** (`npx choir-cli …`): See [CLI_USAGE.md](CLI_USAGE.md)

---

## UI Surfaces

Accessible from the Choir activity bar and command palette:

- **Control Center** — strategic overview, domain posture, package posture, candidate rationale
- **Dependency Graph** — workspace topology with focus/dependency/dependent navigation
- **Timeline** — workspace-unit-aware transition replay with governance trace metadata
- **Diagnostics** — pipeline stage traces and preflight failure context

Command palette entries: `Choir: Open Control Center`, `Choir: Open Dependency Graph`, `Choir: Open Timeline`, `Choir: Show Webview Sync Trace`, `Choir: Show DSL Editor Trace`

---

## Key Artifacts

| Path | Description |
| --- | --- |
| `.choir/choir.config.yaml` | Control plane (authoritative) |
| `.choir/state.json` | State plane (derived) |
| `.choir/audit.log.jsonl` | Append-only, hash-chained audit log |
| `choir.lock` | Deterministic library lock |
| `.choir/artifacts/` | CI runs, materializations, workspace snapshots |
| `.choir/reports/` | Compliance reports |

---

## Troubleshooting

- **No diagnostics**: ensure workspace is open and `.choir/choir.config.yaml` exists.
- **Parse/schema issues**: check the Problems panel and YAML/DSL structure.
- **No DSL completion/hover**: use the `.choir` file extension and Choir DSL language mode.
- **Invalid state.json**: remove `.choir/state.json` and rerun a pipeline command.
