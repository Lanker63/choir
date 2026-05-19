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

Extension install does not add a global `choir` executable to your shell `PATH`.

## CLI Usage

- From this source repo: `npm run build:extension && node out/cli.js <args>`
- For target repos, use the standalone CLI package installation flow. Do not assume VS Code extension installation exposes `choir` on `PATH`.

Standalone CLI install and publish path:

- Install globally: `npm install -g choir-cli`
- One-off run: `npx choir-cli verify --quick`
- Build publishable CLI package from source repo: `npm run build:cli:package`
- Pack locally for validation: `npm run pack:cli`
- Publish package: `npm run publish:cli`
- CI behavior:
  - PRs run `npm pack --dry-run ./packages/choir-cli` as a publishability check
  - Release tag pushes matching `choir-cli-v*` publish `choir-cli` to npm via `.github/workflows/choir-cli-publish.yml`

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
registries:
  - local
  - org
mission: ""
vision: ""
intent:
  goals: []
  constraints: []
  nonGoals: []
strategicIntent:
  priorities: []
  optimizationGoals: []
  riskTolerance: moderate
  architecturalPosture: []
  rolloutPreferences: []
  stabilityProfile: adaptive
  governanceIntensity: moderate
packages: {}
contexts: {}
policy:
  rules: []
execution:
  plans: []
runtime:
  mode: execution-enabled
capabilities:
  preview: true
  simulate: true
  execute: true
  optimize: true
  import: true
  install: true
  update: true
```

## Core Model

- Control plane (authoritative): .choir/choir.config.yaml
- State plane (derived): .choir/state.json
- Interaction plane (ephemeral): chat and commands

Policy merge order is deterministic: org -> repo -> environment.
Parent deny cannot be bypassed.
Runtime governance order is deterministic: runtime -> policy -> approval -> execution.
Strategic intent order is deterministic: global strategicIntent -> domain -> package -> context -> orchestration unit.

## Intent Semantics

| Concept | Meaning |
| --- | --- |
| Mission | Why this system/domain exists right now |
| Vision | What this system/domain is ultimately trying to become |
| Goal | Optimize toward this |
| Constraint | Never violate this |
| Non-goal | Do not spend optimization effort pursuing this |

## Main Commands

Entry point: @choir

Core flow:

- define, analyze, plan, simulate, preview, execute, status
- strategic initialization pipeline: `@choir init` now runs deterministic discovery -> topology-derived domain mapping -> strategic modeling -> governance modeling -> orchestration calibration -> control-plane synthesis
- strategic init does not guess domain IDs from keywords; domain IDs are derived from workspace topology/package paths and then confirmed by the user
- merge-mode init pre-populates mission/vision prompts from current control-plane values
- merge-mode strategic re-init is domain-by-domain: choose a candidate domain, re-initialize it, return to the domain list, then finish when ready
- strategic init persists `packages` as the canonical strategic catalog; `domains` are modeling-time constructs and are not persisted as a duplicate catalog
- strategic domain mission text is persisted on package-level `packages.*.strategicIntent.mission` and re-used to seed re-init/reclassify domain mission prompts when top-level `domains` is omitted
- package entries in persisted init output no longer carry legacy `packages.*.domain`; package-level `strategicIntent` and `contexts` provide canonical strategic scope
- runtime governance scope is exclusive during init synthesis: rooted workspaces persist global `runtime` + `capabilities`, rootless workspaces persist `packageModes`
- strategic intent scope is exclusive during init synthesis when `packageModes` are present: rootless workspaces omit global `strategicIntent` and persist package-level `packages.*.strategicIntent`
- rootless runtime scoping is enforced on final init write paths (including merge-mode finish with no domains selected) so root-level intent updates never leave global `runtime`/`capabilities` behind
- init persists `capabilities` at the applicable governance scope from the authoritative source: template-defined capabilities from `config/init-templates.json` when `--template` is used, otherwise deterministic mode defaults
- strategic init rerun modes: `@choir init --expand-domain`, `@choir init --reclassify`, `@choir init --recalibrate`
- `@choir init --expand-domain` scopes strategic re-model prompts to domains touched by newly discovered packages (it does not re-prompt unchanged domains)
- strategic init templates are sourced from `config/init-templates.json` (single source of truth for available `@choir init --template` values and defaults)
- malformed `config/init-templates.json` entries now fail closed at load time via strict schema validation (startup/runtime command surfaces reject invalid catalogs)
- strategic init single-select prompts (for example risk tolerance, stability profile, governance intensity, runtime mode) explicitly mark the current/default value during template-seeded init and re-init flows
- template-selected runtimeMode (from config/init-templates.json) now seeds per-domain runtime prompt defaults during fresh init and re-init when no package-level runtime override exists
- rooted single-package synthesis now avoids duplicated strategic intent blocks by persisting package-level `packages.".".strategicIntent` and omitting global `strategicIntent`
- rooted single-package init no longer prompts for a separate global runtime mode after domain modeling; global runtime is derived from the sole domain runtime selection
- analyze commands are read-only but must return analysis payloads (workspace, hotspots, summary) instead of mutation-only status text
- deterministic plan optimization: choir plan --optimize [for "<goalRef>"]
- progressive rollout execution: choir execute --strategy <all-at-once|canary|phased|batched>
- execute output reports both selectionStrategy (optimizer candidate strategy) and rolloutStrategy (requested rollout mode)
- plan --optimize persists the selected execution plan to control plane so `plan approve <id>` can be executed immediately
- integrity lineage checks are rollout-mode aware to avoid false canonical-stage mismatches when switching execute rollout modes
- failure isolation rollback: choir rollback [<unitId>] | choir rollback --stage <stageId>
- rollback must restore the previous persisted state hash (stateHash before rollback differs from stateHash after rollback when a reversible transition exists)
- rollback selectors accept deterministic alias forms: stages support order aliases (for example batch-L1-1 -> stage order 1), units support canonical punctuation variants (for example packages.api -> packages:api), and work unit ids (for example wu-<hash>) map to deterministic unit ids when resolvable (prioritizing latest execute trace context)
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
  - @choir diagnostics
- UI panels:
  - Choir: Open Control Center
  - Choir: Open Dependency Graph
  - Choir: Open Timeline
  - Choir: Open Diagnostics
  - Choir: Open Strategic Init Wizard
  - Choir: Show Webview Sync Trace (opens Output channel `Choir Webview Sync Trace`)
  - Choir: Show DSL Editor Trace (opens Output channel `Choir DSL Editor Trace`)
  - Dependency Graph panel controls:
    - Open Node opens the node package manifest and emits timeline navigation for that node
    - Open Node resolves node context from selected node or current Focus Node; if neither exists it reports that a selection is required
    - Node-scoped controls (Open Node, Dependencies, Dependents) are disabled when no valid node selection/focus exists
    - Refresh reruns the workspace pipeline and refreshes graph/timeline/diagnostics projections
    - Refresh updates graph status text with a `refreshed=<time>` stamp and trace metadata with `generatedAt=<isoTime>`
- Governance:
  - choir policy status
  - choir audit log|query|report
- Refactor (PASS 1):
  - choir refactor rename <symbol> <newName>
  - optional disambiguation: choir refactor rename <symbol> <newName> --declaration "<file>" (when unique) or "<file:line:character>"
  - semantic rename resolves declaration identifiers (including exported declarations)
  - rename fails closed when the symbol name maps to multiple declarations and lists deterministic candidate locations
  - ambiguity is reported as a command failure (runtime validation), not a grammar parse error
  - choir refactor inline <symbol>
  - choir refactor move <symbol> <targetUnit>
  - choir refactor move <symbol> --file "<workspace-relative-file>"
  - MVP execution supports moving top-level exported function declarations between units with deterministic import rewrites to the target module path (clean move; no automatic source-file re-export)
  - rewritten import specifiers respect tsconfig module-resolution semantics (Node16/NodeNext keep explicit runtime file extensions such as .js)
  - choir refactor extract <symbol> <targetUnit>
  - choir refactor extract <symbol> --file "<workspace-relative-file>"
  - MVP execution supports extracting top-level exported non-default function declarations into the target unit while preserving source compatibility through a deterministic delegating wrapper
  - rewritten import specifiers respect tsconfig module-resolution semantics (Node16/NodeNext keep explicit runtime file extensions such as .js)
- Libraries:
  - choir import <lib>@<selector>
  - choir library list|install|update|lock
  - `@choir import` resolves and attaches capabilities into workspace scope without mandatory local materialization
  - `@choir library install` materializes capability artifacts under `.choir/libraries/<library>/`
  - `@choir library lock` writes deterministic lock state to `choir.lock`
  - selectors support semantic selectors (`1.2.3`, `1.2.x`, `1.x`) and named selectors (`stable`, `latest`, custom tags)
- CI:
  - choir ci run
- Verification:
  - @choir cli install (optional helper to install CLI from chat via terminal; requires explicit package source and blocks bare `choir` package)
  - @choir verify --production
  - choir verify --production
  - @choir verify --full
  - choir verify --full
  - Chat/CLI verification now uses runtime-safe checks only (no direct dependency on `src/tests` modules)
  - npm test and npm run verify:* execute TypeScript source tests directly from src/tests via ts-node ESM loader (no out/tests JavaScript execution)
  - `verify --contracts` reports a runtime contract subset in target repos; full source harness contract checks remain source-repo CI concerns
  - npm run verify:simulation
  - npm run verify:execution
  - npm run verify:runtime-governance
  - npm run verify:strategic-intent
  - npm run verify:init
  - npm run verify:full
  - npm run verify:libraries

## Library Registry and Locking

Choir libraries are deterministic capability bundles (macros, policies, strategies, templates).

Registry sources are configured in `.choir/choir.config.yaml`:

```yaml
registries:
  - local
  - org
```

Supported registry roots:

- `local` -> `.choir/registry/local`
- `org` -> `.choir/registry/org`
- `file:<path>` or relative/absolute custom paths for future remote/file-backed registries

Deterministic lock output is written to `choir.lock`:

```yaml
libraries:
  org.auth-patterns:
    version: 2.1.4
    selector: stable
    integrityHash: sha256:...
    source: local
    installed: true
```

Hard runtime guarantees for libraries:

- deterministic registry and selector resolution
- policy-aware import/install (fail-closed on deny)
- integrity-hash enforcement for replay safety
- capability graph persistence at `.choir/capability-graph.json`
- replay verification fails closed on lock/hash drift

## Runtime Governance

Runtime modes:

- observe-only
- simulation-only
- approval-required
- execution-enabled
- distributed-control

Capability gates:

- preview
- simulate
- execute
- optimize
- import
- install
- update

Rooted example (global runtime governance):

```yaml
runtime:
  mode: observe-only

capabilities:
  preview: true
  simulate: true
  execute: false
  optimize: true
  import: true
  install: false
  update: false
```

Rootless example (package-scoped runtime governance):

```yaml
packageModes:
  payments:
    mode: approval-required
  playground:
    mode: execution-enabled
```

Global `runtime` and `packageModes` are mutually exclusive in a valid control plane.
Global `strategicIntent` and `packageModes` are also mutually exclusive; package-scoped governance must use `packages.*.strategicIntent`.

Runtime governance decisions are persisted in orchestration traces and diagnostics metadata under runtimeGovernance.

Strategic intent answers what each domain/package optimizes for. Runtime governance answers what operations are allowed. These are separate layers and both are replay-validated.

Control Center and Timeline now surface strategic runtime explainability directly from deterministic traces:
- domain strategic context and package posture mappings
- selected candidate strategic alignment and governance intensity
- rollout bias rationale (preferred rollout, stage sizing, rollback posture, dependency isolation)

In approval-required mode, each new preview invalidates any prior approval bound to that preview hash, so execute requires a fresh approval grant for the current preview cycle.

When execute is blocked for approval, runtime emits both preview hash context and a pendingId; approve accepts either pending id or preview hash.

## DSL Grammar (Compact)

```bnf
<command> ::= "choir" <action> ("then" <action>)*

<action> ::= <define> | <analyze> | <plan> | <simulate> | <preview> | <execute> | <status>
           | <refactor> | <export> | <approve> | <reject> | <policy-status>
           | <rollback> | <graph> | <import> | <library> | <ci> | <audit> | <macro> | <abstraction>

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
<execute> ::= "execute" [["plan" <identifier>] | <identifier>] ["--preview" <identifier>] ["--strategy" <execute-strategy>] ["--steps" <int-list>] ["--phases" <int-list>] ["--batch-size" <integer>]
<rollback> ::= "rollback" | "rollback" <identifier> | "rollback" "--stage" <identifier>
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
<version-selector> ::= MAJOR "." MINOR "." PATCH | MAJOR "." MINOR "." "x" | MAJOR "." "x" | <identifier>
<args> ::= <key-value> ("," <key-value>)*
<key-value> ::= <identifier> "=" <string>
<execute-strategy> ::= "all-at-once" | "canary" | "phased" | "batched"
<int-list> ::= <integer> ("," <integer>)*
<integer> ::= [0-9]+
<identifier> ::= [a-zA-Z0-9._-]+
```

## Execution and Safety

- Canonical execute runtime stages:

```text
analyze -> validate -> synthesize -> generate -> apply -> verify -> commit
```

- Deterministic planning and strategy selection
- Strategy selection simulates all candidates before selection (no heuristic-only path)
- Ranking order is deterministic: violations -> strategicAlignment -> risk -> rollbackComplexity -> changes -> executionCost (lexical id tie-break)
- Violating strategies are excluded by default unless explicitly allowed
- Rollout execution is staged and dependency-aware; each stage must validate before progression
- Rollout supports deterministic canary/phased/batched expansion with threshold gates and failure isolation rollback
- Preview is simulation-derived and hash-bound to execution
- Execute enforces a deterministic integrity gate before any transaction starts (preview hash, simulation parity, DAG signature, replay contract, and state snapshot integrity)
- Transactional execution apply backend is scheduler-backed and filesystem materializing by default
- Generate is read-only and emits deterministic mutation contracts (patch operations, workspace mutation grouping, mutation hash)
- Goal-driven semantic generation is operational: intent can synthesize deterministic source artifacts (for example routes/models/controllers/tests) as transaction-bound mutation sets
- Semantic generation selection is registry-driven and deterministic; same goal and input state produce byte-identical generated artifacts, patch ordering, and lineage hashes
- Verify is mutation-aware and fail-closed (mutation hash parity, full-workspace snapshot parity, replay workspace equivalence)
- Commit persists deterministic mutation artifacts under .choir/artifacts/materialization/ and authoritative workspace snapshots under .choir/artifacts/workspace-snapshots/
- Authoritative workspace hashing is canonical and deterministic across full workspace scope (files, directories, symlinks, unicode paths, permissions metadata, create/delete/rename effects)
- Snapshot hashing supports incremental cache reuse and hash-only capture mode for large workspaces while preserving fail-closed integrity checks
- Snapshot capture/projection enforce case-insensitive portability collision checks and NFC-normalized path handling
- Preview, simulation, execute, and replay lineage include preWorkspaceSnapshotHash and postWorkspaceSnapshotHash bindings
- Replay reconstruction is operational: execution lineage + mutation manifests + deterministic patch replay can reconstruct full workspace state
- Replay reconstructs only patch-required text inputs from snapshots and fails closed for undecodable binary text-patch inputs
- Integrity diagnostics are forensic and category-specific: MANIFEST_TAMPER, WORKSPACE_SNAPSHOT_DIVERGENCE, PATCH_ORDER_DIVERGENCE, REPLAY_LINEAGE_DIVERGENCE, STATE_LINEAGE_DIVERGENCE
- Workspace mutation/replay paths use a cross-process lock coordinator to enforce deterministic isolation under concurrent execution
- Workspace lock coordination is lease-based (owner token + heartbeat + stale-lease reclamation) for resilient multi-process contention handling
- Rollback restores control-plane state and workspace filesystem snapshot on apply/verify failure
- Transactional apply is crash-recoverable via materialization journals that restore pre-workspace snapshot and pre-state before new apply/replay
- State persistence is journaled and idempotent, preventing partial transition/snapshot/audit commits after abrupt interruption
- Lineage compaction prunes old materialization/snapshot/journal artifacts without weakening deterministic replay guarantees
- Global orchestration validates full cross-repo graph and policy before execution
- Global failure handling is isolation-first: rollback affects failed units and already-executed dependents only
- Full rollback is fail-safe fallback only when isolated rollback cannot restore consistency
- Execution and rollout are observability-first: each path emits deterministic telemetry, structured logs, and trace spans
- Production safety guards include deterministic performance validation, timeout wrapping, and rate/circuit guard evaluation
- Guard blocks fail closed while preserving deterministic replay behavior for verification and auditability

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
- `choir simulate` does not require pre-existing execution plans; when no configured plans exist, Choir synthesizes a deterministic candidate plan from current intent/state.
- `choir simulate units <unitA>,<unitB>` simulates selected units plus dependency closure.
- `choir execute` is intent-first: when no persisted plans exist, execution synthesizes deterministic candidate plans from current intent and workspace state.
- `choir execute --preview <id-or-hash>` binds execution to an explicit preview reference, and deterministic integrity checks still run even when approval policy is `allow`.
- `choir execute <planId>` and `choir execute plan <planId>` target an explicit persisted plan when needed; persisted plans are optional artifacts, not prerequisites.
- `choir plan --optimize` simulates all candidate strategies and returns explainable ranking and selected strategy.
- `choir execute --strategy ...` runs progressive staged rollout (canary/phased/batched/all-at-once) with per-stage validation.
- `choir rollback`, `choir rollback <unit>`, and `choir rollback --stage <id>` compute deterministic rollback scope/order and record rollback timeline transitions.
- Simulation is an execution gate: failed simulation blocks execution.
- Execution enforces simulation equivalence and fails closed on divergence.
- Runtime parity requirement is strict:

```text
preview == simulation == execute == replay
```

- Parity is enforced across control-plane state, mutation lineage, and authoritative workspace snapshot hashes.
- Execute/replay parity invariant for filesystem state:

```text
execution.workspaceSnapshotHash == replay.workspaceSnapshotHash
```
- Pre-transaction integrity failures abort execution without opening a transaction; post-transaction runtime failures trigger rollback.
- Execution failure output now includes rollback evidence metadata (`rollback=applied|not-applied`, and when available: `failedUnit`, `rollbackSet`, `rollbackOrder`) so rollback behavior is visible in CLI diagnostics.
- Temporary rollback test hook: setting `CHOIR_TEST_ROLLBACK=1` forces a runtime error only during execution (never simulation) and only after at least one mutation executes, so rollback paths can be exercised deterministically in tests.
- Invalid simulation intent (for example, unknown explicit plan/unit targets) is blocked before simulation runs.
- Invalid execution intent (for example, unknown explicit plan targets) is blocked before execution runs.

## Workspace Detection

detectWorkspace precedence:

1. nx.json
2. turbo.json
3. pnpm-workspace.yaml
4. package.json workspaces
5. root fallback

Package output is sorted and unique; node_modules, .git, dist, out are excluded.

Root fallback behavior:

- if root `package.json` exists, packages = ["."]
- if root `package.json` does not exist, use top-level directories that contain `package.json` (for example `client`, `server`) as deterministic package candidates
- ignore `.choir`, `.git`, `.github`, `.idea`, `.vscode`, `node_modules`, `dist`, `out`, `build`, `coverage`, `tmp`

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
- .choir/artifacts/materialization/<manifest-id>.json

## Audit and Reports

- Audit log: .choir/audit.log.jsonl
- Append-only and hash-chained from GENESIS
- Reports: .choir/reports/compliance-{report.json,report.yaml,report.pdf}

## Execution Diagnostics

- Pipeline diagnostics log: .choir/pipeline.diagnostics.jsonl
- Captures compiler gate outcomes and orchestrator stage execution (plan optimize, preview, simulate, execute)
- Captures command preflight failures (for example control-plane path/load failures) when a workspace root is available
- Diagnostics panel renders the latest recorded stage traces and metadata for each command run
- Empty diagnostics state surfaces the active diagnostics log path for faster root/path troubleshooting

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

Strategic UI projection contract:
- Control Center dashboard must expose strategic overview, domain posture, package posture, and selected-candidate rationale.
- Timeline view must expose strategic replay rationale alongside runtime governance trace metadata.

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
- choir.lock
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
