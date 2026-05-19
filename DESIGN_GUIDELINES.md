# Choir Design Guidelines

This document defines the minimal, non-negotiable system contracts for Choir.

## Product Scope

Choir is deterministic, policy-driven workspace governance:

- intent and policy compilation
- rule evaluation and diagnostics
- plan synthesis, preview, execution
- deterministic AST-based refactor intent, preview, and guarded execution
- audit/compliance evidence
- macro libraries and abstractions
- distributed state sync
- multi-repo global orchestration with org policy propagation

## Three-Plane Contract

1. Control plane (authoritative)
   - .choir/choir.config.yaml
   - User-authored mission, vision, intent, explicit policy, execution plans
2. State plane (derived)
   - .choir/state.json
   - Reproducible projections, diagnostics, runtime execution state, strategy history
3. Interaction plane (ephemeral)
   - Chat and commands
   - Not authoritative

Hard rule: chat compiles into YAML; YAML remains source of truth.
Hard rule: runtime source modules under `src/` must not import from `src/tests/`; test harnesses are built and executed separately.
Hard rule: VS Code extension package manifest must not declare an npm `bin` entry for `choir`; shell PATH exposure is an explicit CLI-install concern, not extension installation behavior.
Hard rule: shell `choir` command distribution is provided only by standalone package `packages/choir-cli` with explicit user install (`npm install -g choir-cli` or `npx choir-cli`).
Hard rule: standalone CLI release automation must only publish on tag push events; pull requests must run pack dry-run validation and must not publish.
Chat-triggered environment actions (for example CLI install) must execute through explicit, user-visible terminal commands with clear scope selection and cancellation path.
Chat-triggered CLI install must require an explicit package source and fail closed for ambiguous/default package names.

Execute rollout mode must be behaviorally observable: `execute --strategy` must change reported execution stage grouping and expose rollout mode explicitly in runtime/chat output.
Integrity lineage comparison must treat rollout mode as part of execution context; canonical-stage/DAG parity checks are only valid against rollout-compatible lineage artifacts.

Read-only chat commands (for example analyze workspace/hotspots/summary) must still return command-specific result payloads; generic no-change mutation status alone is insufficient UX feedback.
Plan optimization outputs must be promotable to plan approval without manual YAML edits; selected optimize plan ids must be persisted to the control plane when optimization is invoked interactively.
Rollback commands must resolve and persist the deterministic previous state target; when a prior transition exists, `stateHash` after rollback must equal the previous transition hash rather than remaining unchanged.
Rollback stage and unit selectors must support deterministic alias normalization (stage order aliases, canonical punctuation-insensitive unit ids, and resolvable work-unit ids like `wu-<hash>`) while still failing closed on ambiguous selector mappings.
Work-unit selector resolution should prioritize bindings captured from the latest successful execute trace context before using synthesized fallback mappings.

## Compiler and Validation Pipeline

Canonical flow:

```text
DSL -> Tokens -> AST -> Validation -> Rule Engine -> Compiler -> choir.config.yaml -> pipeline
```

Validation order:

1. structural
2. semantic
3. cross-node

Incremental rule execution requirements:

- dependency graph over nodes
- changed-node and affected-node propagation
- scoped cache invalidation
- deterministic fallback to full evaluation on mismatch

## Determinism Rules

For identical inputs, output must be identical for:

- plan ids, ordering, scores, selections
- strategy variants, adaptive iterations, selected strategy
- preview diffs and preview hash
- execution graph, batches, conflict outcomes
- state hash, transitions, snapshots, replay outcomes

Move refactor contracts:

- moving a symbol must deterministically rewrite named workspace imports that reference the symbol through the previous source module to the new declaration module path
- moving a symbol is a clean relocation; the source module must not retain automatic compatibility re-exports of the moved symbol
- rewritten relative import specifiers must respect workspace compiler module-resolution mode (for Node16/NodeNext, include explicit runtime extensions like `.js`)
- post-refactor validation snapshots must include newly created files from the planned change set so module-resolution consistency checks remain sound
- distributed deltas, merges, conflicts, convergence status
- global DAG, policy decisions, rollback outcomes
- audit ordering and hashes

Prohibited:

- randomness in orchestration decisions
- LLM scoring or heuristic tie-breaks
- unstable ordering

## State Integrity Contract

Read:

- reject invalid/corrupt .choir/state.json
- verify structure and hash consistency

Write:

- validate before write
- atomic persistence with rollback
- post-write validation
- journaled idempotent persistence with deterministic recovery after interruption

Transition record requirements:

- id, logicalTime, unitId, fromHash, toHash, action, timestamp
- deterministic diff metadata (ordered patches)
- append-only logs

Workspace timeline model requirements:

- every transition must project to a global timeline event
- every transition must also project to its unit timeline event
- global and per-unit timelines must remain index-aligned and deterministic
- missing unit scope defaults to workspace:root

Required files:

- .choir/state.transitions.jsonl
- .choir/state.snapshots.jsonl
- .choir/state.audit.jsonl

Replay contract:

- jumpTo, replayTo, stepForward, stepBackward
- hash continuity verification
- deterministic snapshot fallback on mismatch
- workspace-aware replay must preserve per-unit transition ordering under the global logical clock

## Policy Contract

Decision model:

```text
f(yamlDiff, role, environment[, macroId])
```

Merge order is fixed:

```text
org -> repo -> environment
```

Hard constraints:

- parent deny cannot be overridden
- role/environment are system-derived (not user-spoofable)
- require-approval binds to exact diff hash
- duplicate policy ids across layers are invalid

Imported libraries must participate in policy evaluation order (`org -> repo -> workspace -> library`) and may not bypass deny precedence.

## Strategic Intent Contract

- Strategic intent is a first-class orchestration input, distinct from runtime governance.
- Hierarchy is explicit and deterministic: `global strategicIntent -> packages -> contexts -> orchestration unit`.
- Strategic intent must not be inferred implicitly; resolution is configuration-driven and fail-closed on ambiguity or missing package/context mappings.
- Deterministic planning must include strategic semantics in candidate synthesis, ranking, rollout bias, and rollback posture.
- Deterministic ranking order is: `violations -> strategic alignment -> risk -> rollback complexity -> changes -> execution cost`.
- Strategic inheritance must compose with governance inheritance and must not bypass deny precedence.
- Replay determinism must validate strategic context hash, inheritance chain, and strategic ranking outcomes.
- Diagnostics and traces must expose strategic resolution, alignment, rollout bias, and governance intensity as explainable metadata.
- Monorepo orchestration must support domain-aware strategic partitioning and isolation boundaries.
- Control Center and Timeline projections must render strategic explainability from traces (domain/package posture, selected-candidate alignment, and rollout bias rationale).

Strategic init contract:

- `@choir init` is a deterministic strategic discovery pipeline, not a static config bootstrap.
- Canonical stage order is `discover -> classify -> model -> govern -> calibrate -> synthesize -> generate`.
- Workspace discovery precedence must match workspace detection contract (nx -> turbo -> pnpm-workspace -> package.json workspaces -> fallback).
- Domain IDs must be topology-derived from discovered package paths (no keyword-guessed domain naming during init) and require explicit user confirmation before write.
- Heuristics may suggest default strategic posture values, but may not override topology-derived domain identity.
- In merge mode, scalar root fields (`mission`, `vision`) must be pre-populated from the current control plane before prompting.
- In merge mode after root prompts, domain re-init must be operator-driven with a domain picker loop (select domain -> model domain -> return to picker), with an explicit finish option.
- Strategic init persistence must use `packages` as the canonical strategic catalog and must not persist a duplicate top-level `domains` catalog.
- Persisted package records must not require or emit legacy `packages.*.domain`; strategic resolution is package/context-driven.
- Runtime governance persistence for init must be scope-exclusive: rooted workspaces persist global `runtime`/`capabilities` and omit `packageModes`; rootless workspaces persist `packageModes` and omit global `runtime`/`capabilities`.
- Strategic intent persistence for init must align with governance scope: rooted workspaces may persist global `strategicIntent`; rootless workspaces using `packageModes` must omit global `strategicIntent` and persist package-level `packages.*.strategicIntent`.
- Rootless runtime omission must hold on all init exit paths, including merge-mode early finish with zero selected domains after root intent writes.
- Init must persist runtime `capabilities` at the applicable scope from the authoritative source: template-defined capabilities from `config/init-templates.json` for `--template` runs, otherwise mode-derived defaults (`runtime` when rooted, per-entry `packageModes.*` when rootless).
- Runtime governance mode selection occurs only after strategic domain modeling and calibration.
- Template availability and template defaults for `@choir init --template` must be defined in the repository template catalog (`config/init-templates.json`), not duplicated as hard-coded lists across runtime modules.
- Template catalog loading must be fail-closed with strict schema validation: malformed `config/init-templates.json` entries (invalid enums/shape/duplicates) must throw and block template resolution.
- Strategic init single-select prompt surfaces must explicitly mark the current/default value (not only in placeholder text) for template-seeded init and re-init flows.
- Strategic init template runtime defaults must propagate into domain prompt defaults: when a template defines runtimeMode and no existing package-level mode is uniquely resolved, seeded domain runtime mode must use the template runtimeMode.
- Strategic intent persistence for rooted single-package synthesis must avoid duplicate scope blocks: persist package-level `packages.".".strategicIntent` as canonical and omit global `strategicIntent`.
- Rooted single-package init must not prompt for an additional global runtime selection after domain modeling; global runtime must be derived from the sole domain runtime mode.
- Init rerun surfaces must support incremental strategic evolution: `--expand-domain`, `--reclassify`, `--recalibrate`.
- `--expand-domain` interactive modeling must scope to domains impacted by newly discovered packages; unchanged domains are not re-prompted.
- Init diagnostics must persist pipeline stage outcomes in `.choir/pipeline.diagnostics.jsonl`.
- Strategic init replay artifact `.choir/init-strategic-state.json` is required for reviewable reruns and visualization.

## Runtime Governance Contract

- Runtime governance is an execution control plane, not a UI preference toggle.
- Capability gates must be evaluated in runtime before orchestration execution/mutation stages.
- Runtime decision order is deterministic and fail-closed: runtime -> policy -> approval -> execution.
- Runtime modes and capability maps must participate in replay determinism checks.
- Runtime gates must be command-consistent across preview, simulate, optimize, execute, import, library install, and library update.
- Runtime mode defaults must derive deterministic capability maps.
- Package-level runtime modes are allowed for monorepo containment and must aggregate with global runtime gates using deny > require-approval > allow precedence.
- CI execution paths must enforce the same runtime gates used by chat and orchestration runtime.
- In approval-required mode, preview starts a fresh approval cycle by invalidating prior approvals bound to the same preview hash.
- When execute is blocked by approval gating, a pending approval record must be persisted and surfaced for explicit approve/reject actions.

## Library Distribution Contract

- registries are deterministic and explicit via control-plane `registries` configuration
- import/install resolution must be deterministic for semantic and named selectors
- `import` attaches capability metadata and lock state without requiring full materialization
- `install` materializes capability bundles under `.choir/libraries/<id>/`
- `update` is deterministic and compatibility-safe (no silent major drift)
- `lock` writes authoritative dependency state to `choir.lock`
- lock entries require integrity hash and selector provenance
- capability graph must be auditable and persisted (`.choir/capability-graph.json`)
- replay safety requires same lock, same library graph, same integrity hashes
- integrity mismatch blocks orchestration fail-closed

## Execution Contract

Execution primitive:

```text
analyze -> validate -> synthesize -> generate -> apply -> verify -> commit
```

Hard constraints:

- no write before validation
- deterministic integrity gate is mandatory before execution transaction start
- approval policy is governance-only and must not control deterministic integrity enforcement
- simulation mode never commits
- generate stage is read-only and must emit canonical deterministic mutation contracts
- semantic generation must compile goals into deterministic source-artifact work units (for example project structure, routes, models, controllers, tests, config)
- semantic work-unit materializers must be discovered via deterministic registry ordering and must emit filesystem mutations only through PatchOperation -> WorkspaceMutation transaction flow
- apply stage uses scheduler-backed transactional filesystem mutation as canonical backend
- verify stage is mutation-aware and fail-closed (mutation hash parity, workspace hash parity, replay workspace equivalence)
- commit persists mutation manifests and lineage artifacts
- workspace hash in runtime contracts is authoritative full-workspace snapshot hash (not mutation-scope hash)
- workspace hashing must support deterministic hash-only capture and cache-assisted incremental recomputation for scale
- preWorkspaceSnapshotHash and postWorkspaceSnapshotHash are required lineage fields for preview, simulation, execute, and replay contracts
- replay must be operationally reconstructive: lineage + mutation manifest patch order + deterministic patch replay must reproduce postWorkspaceSnapshotHash
- replay input decoding must be binary-safe and fail closed for undecodable text patch dependencies
- integrity diagnostics must be categorized (MANIFEST_TAMPER, WORKSPACE_SNAPSHOT_DIVERGENCE, PATCH_ORDER_DIVERGENCE, REPLAY_LINEAGE_DIVERGENCE, STATE_LINEAGE_DIVERGENCE)
- concurrent execute/replay mutation paths must use cross-process workspace lock coordination
- lock coordination must be lease-based with heartbeat renewal, ownership tokens, and stale lease reclamation
- rollback restores pre-execution control-plane state and workspace filesystem state on failure
- interrupted apply/rollback paths must recover from materialization journals and restore pre-snapshot workspace + pre-state deterministically
- lineage growth must be bounded with deterministic compaction/GC that preserves replay authority
- temporary test-only failure hook: `CHOIR_TEST_ROLLBACK=1` may force a runtime error only in execution mode (never simulation) and only after at least one mutation executes, to validate rollback handling deterministically
- execution-stage failure diagnostics must surface rollback evidence (`rollback=applied|not-applied`, and when available: failed unit and rollback scope/order) so rollback outcomes are explicit in operator-facing output

## Production Readiness and Observability Contract

- no execution or rollout path may bypass observability instrumentation
- each run emits deterministic telemetry events, structured logs, and trace spans
- production health must expose determinism, replay consistency, audit-chain validity, and policy-enforcement status
- alerting must cover: nondeterminism, replay mismatch, audit-chain break, rollback failure, and policy-bypass attempt
- each required alert must have an explicit runbook mapping
- safety guards must include: deterministic performance validation, timeout wrapper, rate limiter, and circuit breaker
- safety-guard state must not introduce nondeterministic outcomes across fixed-seed verification/property runs

## Final Hardening Gate Contract (Phase 8)

- release gate command is `npm run verify:full`
- merge/deploy is blocked unless:
   - all 14 contract sections pass
   - cross-system invariants all hold
   - replay and rollback exactness are preserved
   - policy bypass attack checks fail closed
   - deterministic lock and stress checks pass
- proof artifacts must be emitted under `.choir/artifacts/proofs/`

## Org-Wide Simulation Contract

- Simulation reuses execution logic with isolated state layer:

```text
execution(mode=simulation) == execution(mode=execution)
```

- Simulation never mutates real workspace or persisted state.
- Simulation evaluates the same validation and policy pipeline as execution.
- Simulation must not require pre-existing execution plans; if no configured plans exist, deterministic candidate synthesis from intent/state is mandatory.
- Simulation output includes deterministic final state projection, per-unit change summary, violations, and replayable trace.
- Partial simulation must include dependency closure for selected units.
- Invalid simulation intent (unknown explicit plan/unit target) must fail closed before simulation execution.
- Execution is blocked when simulation fails.
- If simulated and executed outcomes diverge, execution fails closed.

## Intent-First Execution Contract

- Execution must be intent-centric and autonomous: persisted execution plans are optional artifacts, never mandatory prerequisites.
- Execution must compile and validate command intent before orchestration begins.
- Execution must synthesize deterministic candidate plans from current control/state/workspace inputs when persisted plans are absent.
- Execution strategy selection must be deterministic and stable for identical inputs.
- Execution must run simulation parity precheck before any transaction begins.
- Execution must run deterministic integrity validation before any transaction begins:
   - preview/execution hash consistency
   - simulation/execution parity
   - orchestration DAG integrity (nodes, edges, canonical order, hash/signature)
   - deterministic replay/hash integrity
   - state snapshot integrity
- Execution policy gates (org -> repo -> environment) must be enforced before transaction execution.
- Preview-bound execution (`execute --preview <id-or-hash>`) must validate binding against approved preview hashes before execution.
- Execution and simulation must share the same orchestration and mutation path; execution cannot use alternate commit logic.
- Transaction lifecycle remains strict and mutation-aware: analyze -> validate -> synthesize -> generate -> apply -> verify -> commit.
- Post-execution replay verification must match committed final state hash; mismatch fails closed.
- Post-execution replay verification must also match committed full-workspace snapshot hash and mutation lineage.
- Pre-transaction integrity failures abort execution without opening a transaction.
- Post-transaction runtime failures must rollback and preserve no partial writes.

## Refactor Contract (PASS 1)

- Refactor operations are AST/symbol-based. Raw string replacement refactors are forbidden.
- Refactor flow is deterministic and must follow the same execution primitive:

```text
intent -> impact -> plan -> preview -> simulate -> validate -> commit|rollback
```

- Refactor preview must be deterministic and hash-stable for identical inputs.
- Execution must snapshot impacted files and support deterministic rollback.
- Unsupported refactor execution intents must fail closed (no writes).
- PASS 1 executable intents: rename, inline.
- PASS 1 parsed/planned intents (execution not yet enabled): move, extract.

## Planning Contract

Cost model (static, deterministic):

```text
totalCost = editCost*1.0 + fileTouchCost*2.0 + riskCost*5.0 + dependencyCost*1.5 - violationReduction*3.0
```

Selection:

- default strategy selection is simulation-first and violation-intolerant
- strategies with violations are rejected unless explicitly allowed by config
- strict lexicographic order: violations -> strategic alignment -> risk -> rollback complexity -> changes -> execution cost
- optional weighted scoring is secondary and applies only after lexicographic filtering
- final tie-break is lexical strategy id

Strategy evaluation:

- fixed strategy registry
- simulation-only evaluation
- deterministic ranking metrics
- deterministic, explainable decision output with full ranking and reason
- deterministic selection trace: evaluated/rejected counts and selection time
- bounded adaptive refinement
- deterministic memory reuse from .choir/memory.json

## Global Orchestration Contract

- one global cross-repo DAG (no per-repo isolated execution path)
- validate full graph and policy before execution
- inter-repo cycle -> fail
- cross-repo deny/approval-required -> block entire execution
- any execution failure -> isolate failed unit and rollback only impacted units
- progressive rollout supports deterministic staged execution:
   - all-at-once
   - canary (percent expansion)
   - phased (explicit percent phases)
   - batched (dependency-safe unit groups)
- each rollout stage must pass dependency checks, policy/validation gates, and metric thresholds before proceeding
- stage failure triggers deterministic isolation rollback (failed unit + executed dependents)
- rollout can continue only when remaining stages are unaffected and post-rollback consistency holds
- rollout is simulation-gated and fails closed on simulation/execution divergence; fallback rollback-all is last resort only

Workspace detection contract:

- detectWorkspace precedence:
  - nx.json
  - turbo.json
  - pnpm-workspace.yaml
  - package.json workspaces
  - root fallback
- output packages sorted and unique
- exclude node_modules, .git, dist, out
- root fallback must be deterministic:
   - root `package.json` present -> packages = ["."]
   - root `package.json` absent -> use top-level directories that contain `package.json` as package candidates
   - ignore `.choir`, `.git`, `.github`, `.idea`, `.vscode`, `node_modules`, `dist`, `out`, `build`, `coverage`, `tmp`

## Distributed Sync Contract

- delta-based changesets (add/update/remove)
- logical clock increment += 1, merge = max + 1
- explicit conflicts only (no silent drop)
- deterministic merge and eventual convergence under identical inputs
- security mode rejects untrusted/tampered changesets

## Audit Contract

- append-only .choir/audit.log.jsonl
- hash-chained from GENESIS
- mandatory auditing for policy, compile, execution, CI, macro, abstraction actions
- deterministic compliance report outputs for identical filters

## Pipeline Diagnostics Contract

- Pipeline and orchestration execution traces must be visible outside transient chat output.
- Every pipeline run must append a diagnostics record to `.choir/pipeline.diagnostics.jsonl`.
- Compiler gate results and orchestration stage outcomes (planning, preview, simulation, execution) must be persisted with stage-level status and detail.
- Command preflight failures (for example missing control-plane resolution) must append failure diagnostics whenever a workspace root is available.
- Diagnostics records must include command, source, category, result, summary, timestamp, and optional metadata.
- A dedicated Diagnostics UI panel must render persisted records and stage details, including failure points.

## Command and Language Surface

- user surface: @choir only
- DSL is strict grammar, no natural language parsing
- .choir language support is grammar-state driven (completions, hover, validation)
- internal roles (architect, analyst, conductor, enforcer) are routing boundaries, not user-facing participants
- refactor DSL surface:
  - choir refactor rename <symbol> <newName>
  - optional disambiguation: choir refactor rename <symbol> <newName> --declaration "<file>" (when unique) or "<file:line:character>"
  - semantic rename must resolve the declaration identifier token (including exported declarations)
  - name-only rename must fail closed when multiple declarations share the same symbol name, with deterministic candidate locations
  - ambiguity failures are runtime command errors and must not be labeled as DSL grammar-invalid
  - choir refactor inline <symbol>
  - choir refactor move <symbol> <targetUnit>
  - choir refactor move <symbol> --file "<workspace-relative-file>"
  - MVP execution supports top-level function declaration moves as clean relocation (no automatic source compatibility re-export)
  - choir refactor extract <symbol> <targetUnit>
  - choir refactor extract <symbol> --file "<workspace-relative-file>"
  - MVP execution supports extracting top-level exported non-default function declarations with deterministic source wrapper delegation to target implementation
- plan optimization surface:
   - choir plan --optimize
   - choir plan --optimize for <goalRef>
- rollout execution surface:
   - choir execute --strategy all-at-once
   - choir execute --strategy canary --steps <p1>,<p2>,...,100
   - choir execute --strategy phased --phases <p1>,<p2>,...,100
   - choir execute --strategy batched --batch-size <n>
- rollback surface:
   - choir rollback
   - choir rollback <unitId>
   - choir rollback --stage <stageId>
- panel chat shortcuts:
   - @choir control
   - @choir timeline
- UI opening model:
   - Control Center, Dependency Graph, and Timeline open as full editor webview panels
   - primary open commands: Choir: Open Control Center, Choir: Open Dependency Graph, Choir: Open Timeline
   - main Choir activity bar container keeps Rules as the persistent view
   - persistent Rules view title icons open Control Center, Dependency Graph, and Timeline panels
   - dependency graph interactions:
     - Open Node must open the selected unit manifest and also navigate timeline to that unit, opening Timeline if needed
      - Open Node interaction must not silently no-op; node resolution should fallback to current Focus Node and show explicit status when selection is missing
      - Node-scoped controls (Open Node/Dependencies/Dependents) must be visibly disabled when no valid node is selected/focused
     - Refresh must rerun pipeline projection refresh (state/plan/graph/timeline/diagnostics) rather than only repainting the current graph snapshot
       - Refresh must provide visible confirmation in the graph surface (status refreshed time + trace generatedAt metadata)

## Webview Sync Contract

- Extension host is the single source of truth for state and replay
- Webviews are stateless projections (control, graph, timeline)
- Messaging uses typed host<->webview protocol
- Synchronization uses push-based event bus broadcasts
- `Choir: Show Webview Sync Trace` must open Output channel `Choir Webview Sync Trace` and print current host<->webview trace entries
- `Choir: Show DSL Editor Trace` must open Output channel `Choir DSL Editor Trace` and print current editor trace counters
- Polling-based state synchronization is forbidden
- View lifecycle must support deterministic rehydrate on reopen
- All inbound webview messages must be validated before execution
- Webview strategic sections must remain projection-only and must not synthesize strategic decisions client-side.

## Non-Negotiable Safeguards

1. Control plane authority is strict; derived state is never user-authored.
2. All mutation decisions pass through policy and enforcer logic.
3. Preview hash, simulation contract, orchestration DAG signature, replay hash, and state snapshot integrity must match at execution time or execution is rejected before transaction start.
4. Mutation manifests and workspace hash lineage must validate at execution time; tamper or drift is rejected before transactional apply.
5. Incremental and full recomputation results must be equivalent; mismatch triggers deterministic full fallback.
6. State and workspace writes are atomic and rollback-safe.
7. Replay and distributed sync must be integrity-checked and deterministic.
8. Global execution is blocked until full graph and policy validation succeeds.
9. Global failures use isolation-first rollback; rollback-all is permitted only as deterministic fail-safe fallback.
10. Audit evidence is immutable, append-only, and hash-chained.
11. Macro/abstraction flows must not bypass DSL, policy, execution, or audit layers.

## Canonical Artifacts

- .choir/choir.config.yaml
- .choir/state.json
- .choir/artifacts/materialization/<manifest-id>.json
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
