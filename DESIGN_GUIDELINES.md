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

## Execution Contract

Execution primitive:

```text
prepare -> simulate -> validate -> commit|rollback
```

Hard constraints:

- no write before validation
- no execution without valid preview hash approval
- simulation mode never commits
- rollback restores pre-execution state on failure

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
- Simulation output includes deterministic final state projection, per-unit change summary, violations, and replayable trace.
- Partial simulation must include dependency closure for selected units.
- Execution is blocked when simulation fails.
- If simulated and executed outcomes diverge, execution fails closed.

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
- strict lexicographic order: violations -> risk -> changes -> executionCost
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

## Command and Language Surface

- user surface: @choir only
- DSL is strict grammar, no natural language parsing
- .choir language support is grammar-state driven (completions, hover, validation)
- internal roles (architect, analyst, conductor, enforcer) are routing boundaries, not user-facing participants
- refactor DSL surface:
   - choir refactor rename <symbol> <newName>
   - choir refactor inline <symbol>
   - choir refactor move <symbol> <targetUnit> (parsed/planned in PASS 1)
   - choir refactor extract <symbol> <targetUnit> (parsed/planned in PASS 1)
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

## Webview Sync Contract

- Extension host is the single source of truth for state and replay
- Webviews are stateless projections (control, graph, timeline)
- Messaging uses typed host<->webview protocol
- Synchronization uses push-based event bus broadcasts
- Polling-based state synchronization is forbidden
- View lifecycle must support deterministic rehydrate on reopen
- All inbound webview messages must be validated before execution

## Non-Negotiable Safeguards

1. Control plane authority is strict; derived state is never user-authored.
2. All mutation decisions pass through policy and enforcer logic.
3. Preview hash must match at execution time or execution is rejected.
4. Incremental and full recomputation results must be equivalent; mismatch triggers deterministic full fallback.
5. State writes are atomic and rollback-safe.
6. Replay and distributed sync must be integrity-checked and deterministic.
7. Global execution is blocked until full graph and policy validation succeeds.
8. Global failures use isolation-first rollback; rollback-all is permitted only as deterministic fail-safe fallback.
9. Audit evidence is immutable, append-only, and hash-chained.
10. Macro/abstraction flows must not bypass DSL, policy, execution, or audit layers.

## Canonical Artifacts

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
