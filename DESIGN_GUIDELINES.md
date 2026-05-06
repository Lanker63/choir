# Choir Design Guidelines

Choir is a VS Code extension for deterministic, policy-driven workspace governance: compiles intent → rules, synthesizes plans from state, optimizes and executes plans transactionally, records immutable audit evidence, supports versioned macro libraries, distributed state sync, and global orchestration with org-wide policy propagation.

---

# Core System Model

## Three-Plane Architecture

### 1. Control Plane (Authoritative)

- Format: YAML (`.choir/choir.config.yaml`)
- Owner: User (primarily through Architect/Conductor workflows)
- Defines:
  - Mission and vision
  - Intent (`goals`, `constraints`, `non-goals`)
  - Explicit policy rules
  - Execution plans (`execution.plans`)
- Required properties:
  - Versioned and schema-validated
  - Deterministic input for all pipeline and scheduler runs
  - Single source of truth for workspace intent and execution plans
  - Repo-level policy source of truth for workspace policy intent (`.choir/policies.dsl`), composed with org and environment layers at evaluation time

> Chat compiles into YAML. YAML is authoritative.

---

### 2. State Plane (Derived)

- Format: JSON (`.choir/state.json`)
- Owner: System
- Contains:
  - Versioned projected state model (`version`, `intent`, `ast`, `graph`, `ruleViolations`, `plans`, `stateHash`)
  - AST indexes
  - Symbol/dependency graphs
  - Diagnostics
  - Metrics
  - Execution runtime state (task status, task results, history, preview approvals)
  - Strategy outcome history used for deterministic adaptive refinement (`strategyHistory`)
- Required properties:
  - Fully reproducible from workspace + control plane
  - Not user-authored
  - Deterministically serialized
  - State hash integrity must verify on every read/write
  - Persistence must be atomic and rollback-safe
  - Consistency with YAML/AST/rule outputs must be enforceable at write time
  - Invalid persisted state must fail fast during read

State correctness layer contract:

- `readStatePlane` validates and rejects invalid/corrupt `state.json`.
- `persistStatePlane` performs deterministic validation and consistency checks before write.
- Writes are atomic and include post-write validation; failures rollback to prior bytes.
- State transitions are validated and recorded deterministically.
- Transition records must include deterministic replay fields:
  - `id`, `fromHash`, `toHash`, `action`, `timestamp`
  - `diff` (`patchCount`, ordered `patches[]` with `path`, `op`, `before`, `after`)
  - metadata (`command`, `policyDecision`, `auditId`, optional `ruleTriggers`, optional `dependencyChain`)
- Snapshot lifecycle is deterministic and includes:
  - save (`.choir/state.snapshots.jsonl`)
  - list
  - rollback
  - replay
- Snapshot cadence is deterministic and hybrid:
  - initial snapshot on first transition
  - periodic snapshots at fixed transition interval (`SNAPSHOT_INTERVAL`, currently 5)
- Replay navigation supports deterministic index/hash targeting:
  - `jumpTo`
  - `replayTo`
  - `stepForward`
  - `stepBackward`
- Replay integrity must recompute and verify transition hash continuity; mismatch triggers deterministic snapshot fallback.
- Transition/audit side logs are append-only:
  - `.choir/state.transitions.jsonl`
  - `.choir/state.audit.jsonl`
- Distributed sync contract: delta-based `ChangeSet` sync (`add`/`update`/`remove`); clock increment `+= 1`, merge `= max + 1`; no silent conflict resolution; last-write-wins default with tie-break; `push`/`pull`/`bidirectional` modes with convergence requirement; tamper → explicit manual-resolution conflict. (Full spec: Distributed Synchronization Contract.)
- Global orchestration contract: cross-repo DAG with inter-repo edges; cycle → fail; one global plan (no per-repo isolation); validation: no missing/circular deps, no conflicting actions; org policies propagate to all repos, no opt-out; cross-repo violations block entire plan; any batch failure → rollback-all; cache reuse deterministic and input-hash bound. (Full spec: Global Orchestration Contract.)

---

### 3. Interaction Plane (Ephemeral)

- Format: Chat prompts/responses; Owner: User + agents
- Used for: authoring intent, triggering analysis/execution, explaining outcomes

> Chat is an interface, not persisted state.

Exception: guided init state may persist to `.choir/init-state.json` (interaction metadata only; non-authoritative).

---

## Unified Agent Facade

- Single participant: `@choir` (`id: choir`)
- Internal roles are module boundaries, not user-facing: `architect`, `analyst`, `enforcer`, `conductor`
- Routing from `@choir` to internal roles is deterministic

Compiler pipeline: `User -> @choir -> DSL -> Tokens -> AST -> Validation -> Rule Engine -> Compiler -> choir.config.yaml -> pipeline`

### Time-Travel Replay Debugger Contract

- Surface id: `timeline-view`; timeline source: `snapshots + transitions`
- Entries include: index, action, hashes, timestamp, metadata
- Controls (action messages, not DSL): `play`, `pause`, `step-forward`, `step-backward`, `jump`
- Playback: deterministic step-forward on fixed interval; auto-pauses at end
- Inspector: why summary, dependency chain, replayed state, patch table (`before`/`after`), replay trace (`visitedStates`, `replayTime`, `consistencyCheck`, `fallbackUsed`)
- Must never mutate control plane or bypass state validation

### Distributed Synchronization Contract

Types: `Replica`, `LogicalClock`, `VersionVector`, `ChangeSet`, `StateOperation`, `SyncConflict`, `SyncAudit`, `SyncTrace`

Operations: `computeDelta`, `applyDelta`, `mergeStates`/`mergeReplicaStates`, `sync`

- Transport: interface with deterministic in-memory implementation; optional pub/sub event bus
- Convergence: replicas must converge for identical input deltas + merge policy; merge commutative at state-result level

### Global Orchestration and Org Policy Propagation Contract

Types: `Repo`, `GlobalContext`, `GlobalDependencyGraph`, `GlobalPlan`, `ExecutionOrder`, `TaskBatch`, `OrgPolicy`, `PolicyPropagation`, `GlobalAudit`, `GlobalTrace`

Operations: `buildGlobalDependencyGraph`, `synthesizeGlobalPlan`, `validateGlobalPlan`, `orderPlan`, `batchTasks`, `executeGlobalPlan`, `propagatePolicies`, `evaluateGlobalPolicies`, `detectPolicyDrift`

Hard constraints:
- No per-repo isolated planning/execution path; no execution before full graph + policy validation; no inconsistent policy enforcement across repos; deterministic plan synthesis

Ordering/batching: topological; independent tasks batch by dependency layer; dependency constraints take precedence.

Enforcement: cross-repo deny/required-approval blocks entire execution; no partial execution on policy failure.

Drift: detected per repo; surfaced as violation, not silently corrected.

Scope: core engine + architecture harness only; UI wiring is a separate layer.

### Interactive Init Wizard Contract (`@choir init`)

Wizard state machine: `mission -> vision -> goals -> constraints -> non-goals -> review -> confirm`

- Controls: `back`, `cancel`, explicit `yes`/`no`
- UX: deterministic per-step prompts; progress shown (`Step N/6`); required fields validated; duplicates rejected
- Persistence: state saved to `.choir/init-state.json`; cancel/no clears saved state
- Apply: generates DSL commands from confirmed state; applied through DSL compiler + policy gate; no direct YAML writes; deterministic output for identical wizard state

See DSL command grammar in [Conductor Responsibilities](#orchestration-layer).

Router constraints: strict parser; invalid syntax rejected; AST maps directly to YAML mutations; config validated before write; single-step write.

**AST/Rule engine contract:**
- Pipeline: `DSL -> Tokens -> AST -> VALIDATION -> RULE ENGINE -> OUTPUT`
- Validation: fail-fast, ordered: structural → semantic → cross-node
- Incremental execution: build dependency graph; diff to find changed nodes; propagate to affected; execute indexed rules for affected only; cache for unaffected
- Duplicate `define` within sequence: rejected; re-define of existing identical: deterministic no-op
- Rule evaluation sorted by `rule.id`; cache keys: `(ruleId, nodeId, context signature, dependency signature)`; invalidation scoped to changed + affected
- Incremental supports bounded fixpoint iteration; consistency check vs full recomputation; mismatch → full evaluation
- Conflicting fixes rejected; fixes applied on cloned AST only

**Macro constraints:**
- Expansion produces valid DSL only; no direct YAML writes
- Flows through DSL compiler and policy gate
- Versioned by semver, immutable per version; unversioned rejected
- Namespaced as `<library>.<macroId>`; resolves through lockfile-pinned versions
- Composition permitted with recursion detection and depth limit

## VS Code Language Support Contract (`.choir`)

- Language id: `choir`; file extension: `.choir`
- Tokenization: stable TextMate keyword list derived from DSL terminals
- Completions: grammar-state driven, valid next tokens only; no LLM
- Validation: reuses `parseCommand`; no heuristic parsing
- Hover content: deterministic and keyword-based
- Packaging: `package.json` contributes `languages`, `grammars` (`source.choir`), `snippets`, default `*.choir` association
- Language assets: `syntaxes/choir.tmLanguage.json`, `language-configuration.json`, `snippets/choir.json`
- Trace: `completionsTriggered`, `diagnosticsCount`, `parseErrors` — visible via `Choir: Show DSL Editor Trace`

---

# Orchestration Layer

## Conductor Responsibilities

- Generate and score draft plans (deterministic cost model); select optimal plan set
- Evaluate strategy variants per plan (simulation-based, no LLM); select best validated strategy
- Generate execution preview; enforce preview-hash approval gate before execution
- Synthesize global multi-repo plans; resolve inter-repo dependencies into one DAG
- Apply org policy propagation + cross-repo gating; coordinate rollback-all on failure
- Approve and execute plans; report status; preserve deterministic task ordering

Command surface (via `@choir`):

```
choir define mission|vision|goal|constraint|non-goal "..."
choir analyze workspace|hotspots|summary
choir plan [for "..."] | plan approve <planId>
choir preview [plan <planId>]
choir execute [plan <planId>]
choir status
choir export dsl [all|intent|policy|plans]
choir approve <diffId> | reject <diffId>
choir policy status
choir import <library>@<version-selector>
choir library list|install <lib>@<ver>|update <lib>|lock
choir ci run
choir <abstraction-id> [key="value", ...]
choir audit log|report|query [filters]
choir macro list|show <id>|<id> [args]
@choir init [--template backend|frontend]
```

DSL command grammar:

```bnf
<command> ::= "choir" <action> ("then" <action>)*

<action> ::= <define> | <analyze> | <plan> | <preview> | <execute> | <status> | <export> | <approve> | <reject> | <policy-status> | <import> | <library> | <ci> | <audit> | <macro> | <abstraction>

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
<import> ::= "import" <library-spec>
<library> ::= "library" ("list" | "install" <library-spec> | "update" <identifier> | "lock")
<library-spec> ::= <identifier> "@" <version-selector>
<version-selector> ::= MAJOR "." MINOR "." PATCH | MAJOR "." MINOR "." "x" | MAJOR "." "x"
<ci> ::= "ci" "run"
<audit> ::= "audit" ("log" | "report" | "query" [<audit-filters>])
<audit-filters> ::= <audit-filter> ("," <audit-filter>)*
<audit-filter> ::= ("role" | "environment" | "action" | "from" | "to") "=" (<identifier> | <string>)
<macro> ::= "macro" ("list" | "show" <identifier> | <identifier> [<args>])
<abstraction> ::= <identifier> [<args>]
<args> ::= <key-value> ("," <key-value>)*
<key-value> ::= <identifier> "=" <string>
<identifier> ::= [a-zA-Z0-9._-]+
```

**Macro execution contract:**
- Sources: `.choir/macros.yaml` (local), `.choir/libraries/<lib>/<ver>/macros.yaml` (library); versions pinned in `.choir/lock.yaml`
- Flow: `Macro -> DSL -> AST -> Validation -> Rule Engine -> YAML -> Pipeline`; each command via `compileDSLAndWrite`; subject to policy gate
- Version selectors: `1.0.0`, `1.0.x`, `1.x` → exact local version; no network calls; breaking changes require MAJOR bump

**Mutation contract:**
- `define mission|vision`: set; `define goal|constraint|non-goal`: upsert
- Duplicate `define` in same sequence: fail; re-define identical value: deterministic no-op (warning)
- Incremental rule state is runtime-only and non-authoritative
- `plan`: upserts draft; `plan approve`: sets `approved`
- `analyze|preview|execute|status|ci|audit|import|library|<abstraction-id>`: non-mutating in YAML compiler mode

**Projection contract:**
- `export dsl`: non-mutating; stable ordering; unsupported fields skipped with warnings

**Audit and compliance contract:**
- Append-only `.choir/audit.log.jsonl`; hash-chained (`chainIndex`, `previousHash`, `hash`; first record anchors at `GENESIS`)
- Audited actions: `compile-dsl`, `policy-evaluation`, `approval-granted`, `approval-rejected`, `execute-plan`, `macro-execution`, `ci-policy-gate`, `ci-pipeline`, `abstraction-execution`
- Query filters: `role`, `environment`, `action`, `from`+`to` (both required for time range)
- Reports: deterministic summaries; export formats `json`, `yaml`, `pdf` to `.choir/reports/`
- Macro records include library provenance: `macroLibrary`, `version`, `macroId`, `resolvedVersion`

**Policy gate contract:**
- Decision model: `f(yamlDiff, role, environment)`; extended to `f(..., macroId)` for macros
- Sources, fixed merge order: org (`/org/policies.dsl`) → repo (`.choir/policies.dsl`) → environment (runtime)
- Flow: `Policy DSL -> AST -> Compiled Rules -> Merge Engine -> Policy Engine`
- Precedence: `deny > require-approval > allow`; child cannot override parent `deny`
- Role: system-derived; environment: runtime-detected; macro context: lockfile-resolved — none user-spoofable
- Org policies propagate to all global orchestration repos; no opt-out
- Global policy evaluation covers all repos; cross-repo compatibility checked; denial blocks entire global execution
- `deny`: blocks immediately; `require-approval`: blocks until exact diff hash approved
- Duplicate policy IDs across layers: invalid; circular inheritance: disallowed
- Policy trace: role, environment, matched rules, DSL traces, inheritance trace, final decision

**CI/CD pipeline contract:**
- Entry: `choir ci run`; canonical stage order: `source → compile → plan → policy → preview → execute → audit`
- `.choir/ci.yaml` may omit stages; cannot reorder
- `policy` stage fails on `deny` or missing approval; `execute` stage blocked if preview hash changes
- Macro and plan execution blocked outside `choir ci run`; environment context runtime-validated
- Artifacts: `.choir/artifacts/ci/<run-key>/{plan,preview,preview.diff,execution,audit.log,trace}.json`

**Abstraction contract:**
- Registry: `.choir/abstractions.yaml`; model: `id`, `version`, `description`, `parameters[]`, `expandsTo[]`
- Flow: `Abstraction -> Macro Composition -> DSL -> YAML -> Policy -> Execution -> Audit`
- Recursion-depth guarded; non-execution commands disallowed; trace includes abstraction id, commands, macro usage, result

Policy DSL grammar contract:

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

Inheritance operator contract:

- `append`: add child rule in addition to inherited parent rules.
- `assign`: replace matching inherited selectors only when parent override policy permits child override.
- `remove`: subtract matching inherited selectors only when parent override policy permits child override.

## Deterministic State → Plan Synthesis

For identical `(control plane, state plane)` inputs, output is identical.

Algorithm: filter diagnostics by scope → group by rule id → build dependency-aware file layers → synthesize tasks (one analysis, grouped refactor, one enforce/validate) → generate deterministic plan id from normalized input.

Required: stable sorting; no random identifiers; repeatable output.

---

# Cost-Based Planning

Static, execution-free deterministic cost model evaluated before execution.

## Cost dimensions

- `editCost`: estimated patch count
- `fileTouchCost`: unique files modified
- `riskCost`: refactor risk heuristic
- `dependencyCost`: longest in-plan dependency chain
- `violationReduction`: estimated enforcement benefit

## Total cost

```text
totalCost =
  editCost * 1.0 +
  fileTouchCost * 2.0 +
  riskCost * 5.0 +
  dependencyCost * 1.5 -
  violationReduction * 3.0
```

## Selection policy

- Lowest total cost wins; tie-break by `planId` lexical order
- Output: cost trace with evaluated scores and decision

---

# Multi-Strategy Planning (Deterministic, No LLM)

After cost-based selection, each plan enters a five-pass strategy evaluation.

## Strategy set

- `minimal`: preserve base plan structure
- `grouped`: merge overlapping refactor tasks by file overlap
- `layered`: reorder/reshape by dependency layers
- `aggressive`: merge refactors into one broad transformation

## Five-pass contract

1. **Registry** — enumerate fixed strategy ids in stable lexical order
2. **Transforms** — generate strategy variants with deterministic ids/dependencies
3. **Simulation** — validate each via `prepare → simulate → validate`; no commit, no state write
4. **Selection** — prefer validated; rank by `remainingViolations`, `introducedErrors`, `patchesCount`, `filesChanged`; tie-break by `strategyId`
5. **Execute + trace** — execute only selected strategy; emit strategy trace

## Hard constraints

- No LLM, no randomness, no mutation during evaluation, stable ordering

## Adaptive Refinement (Deterministic)

After baseline pass, bounded adaptive iterations:

1. Extract deterministic failure patterns from outcomes
2. Apply rule-based mutations from fixed registry
3. Re-evaluate merged pool
4. Stop when: success + `remainingViolations === 0`, no new strategies, or max iterations reached

Failure patterns: `validation-failure`, `high-remaining-violations`, `too-many-patches`, `too-many-files`, `conflict-heavy`

Mutation constraints: deterministic functions over `(plan, state)`; fixed registry and ordering; adaptive ids = hash of source + pattern + mutation + normalized plan shape; pool size capped.

Trace: iteration count, strategies evaluated, mutations applied, selected id, decision log.

## Strategy Memory and Reuse

- Storage: `.choir/memory.json`; keyed by deterministic context signature (sorted goals, constraints, violation summary `ruleId`+`count`, module hints)
- Reuse requires: `success === true`, `remainingViolations === 0`; select by lowest `patchesCount`; tie-break by entry id
- Safety: applicability check before reuse (plan id, task graph, files, violation overlap); fail → adaptive evaluation
- After execution: record to memory; deduplicated and bounded in size
- No hidden memory state outside `.choir/state.json` and `.choir/memory.json`
- Trace: signature used, matched count, reuse flag, selected id, fallback flag

## Cost-planning hard constraints

- No randomness, no LLM scoring, no mutation during scoring, no execution-order dependence

---

# Execution Preview (Deterministic, Simulation-Derived)

- Derived from simulation; never mutates real files or persists state
- Deterministic for identical inputs; must match what execution applies

## Preview model

```ts
type MultiStrategyPreview = {
  previewId: string;
  hash: string;
  planId: string;
  strategies: Array<{
    strategyId: string;
    summary: { filesChanged: number; patches: number; violationsRemaining: number };
    diff: FileChange[];
  }>;
  selectedStrategyId: string;
};
```

## Preview pipeline

1. Cost-select approved plans
2. Simulate all strategies via transaction flow (no-persist mode)
3. Select best strategy by deterministic outcome metrics
4. Build file changes/diffs per strategy; compute hash from selected strategy file changes

If preview and execution diverge, the execution pipeline is incorrect and must be fixed.

## Approval gate

- Execution requires explicit preview hash; stored in `execution.lastPreview` (`hash`, `planId`, optional `strategyId`)
- Preview recomputed before execution; hash mismatch rejects and requires fresh preview

```ts
hash = sha256(JSON.stringify(preview.fileChanges));
```

---

# Multi-Plan Optimization

- Flatten tasks to global ids (`planId:taskId`); normalize to single DAG; compute topological layers
- Conflict matrix: file mutation overlap + dependency chain constraints
- Batches in same layer may run concurrently; conflicting units must not share batch; layer order deterministic

---

# Transactional Batch Execution

`prepare → simulate → validate → commit | rollback`

- Snapshot touched files + state plane; simulate all patches in virtual FS; run invariant validation before commit
- Commit atomically; rollback to snapshot on failure; file-set locking prevents cross-batch corruption

Simulation-only mode: same primitives, `prepare` + `simulate` + `validate`, no commit/rollback writes.

## Invariants required before commit

- No new blocking errors (or within configured threshold)
- No overlapping patch ranges
- AST parse success for touched files
- Type check pass (if enabled)
- Idempotency: reapplying patches yields no further changes

---

# Determinism and Safety Contract

For identical inputs, Choir must produce identical:

- Plan ids and task ordering
- Plan scores and selected plan sets
- Strategy variants and selected strategy ids
- Adaptive refinement path (generated adaptive strategy ids, iteration decisions)
- Preview file changes and preview hash
- Execution graph/layers/batches
- Conflict decisions
- Transaction outcomes
- State hash values and transition records
- Snapshot ids and rollback/replay outcomes
- Replay timeline entries, patch projections, and replay trace flags
- Distributed delta sets, merge outputs, conflict sets, sync audit records, and convergence status
- Global dependency graphs, global plan ids, global execution order, and task batches
- Policy propagation targets, cross-repo policy decisions, and global violation sets
- Global rollback outcomes and post-execution convergence flags
- Audit chain ordering and record hashes
- Compliance report summaries for identical filter windows
- Macro library version resolution and lockfile pinning outcomes
- Incremental rule traces (changed/affected nodes, executed rule ids, cache-hit counts)

Non-negotiable safeguards:

1. No direct disk writes before validation pass
2. All code mutation decisions flow through Enforcer logic
3. Control plane and state plane authority boundaries remain strict
4. Scheduler decisions are stable and auditable
5. Execution is blocked unless preview hash is explicitly approved and revalidated
6. Adaptive strategy feedback is persisted only in `.choir/state.json` (`strategyHistory`)
7. Policy context cannot be user-spoofed: role is system-derived and environment is runtime-derived
8. Audit evidence is append-only, hash-chained, and emitted for all significant policy and execution decisions
9. Macro library execution is lockfile-pinned and version-deterministic
10. CI mode execution is restricted to `choir ci run` with runtime environment validation
11. Intent-level abstractions must not bypass DSL, policy, execution, or audit layers
12. Incremental rule execution must not return stale cache results; invalidation is required on changed nodes
13. Incremental results must equal full recomputation; mismatch requires deterministic fallback to full evaluation
14. `state.json` reads must fail on invalid structure, broken references, or hash mismatch
15. State writes must be atomic, validated pre/post write, and rollback-safe on failure
16. Incremental projected state must equal full recomputed state; mismatch requires deterministic full-state fallback
17. Snapshot rollback/replay must be deterministic and integrity-checked before reuse
18. Replay must verify transition hash continuity while applying diffs; on mismatch, deterministic snapshot fallback is required
19. Distributed merge/sync must not allow long-term divergence under identical deltas and conflict policy
20. Distributed conflict resolution must always be explicit and traceable; silent conflict dropping is forbidden
21. Distributed synchronization must reject untrusted/tampered changesets when security checks are enabled
22. Global orchestration must not execute any task before full-graph and policy validation
23. Global policy propagation must be complete for all target repos and cannot be bypassed
24. Any global execution failure must rollback all participating repos to pre-execution state

---

# System Contract

```yaml
YAML = intent + policy + execution plans (authoritative)
JSON = computed facts + execution runtime state (derived)
State Integrity = validated hash + consistency checks + transition validation
State Snapshots = `.choir/state.snapshots.jsonl` (derived rollback points)
State Transition Log = `.choir/state.transitions.jsonl` (append-only)
State Transition Record = `id/fromHash/toHash/timestamp/action/diff/metadata` (deterministic replay contract)
State Audit Log = `.choir/state.audit.jsonl` (append-only)
Replay Timeline = derived from snapshots + transitions (`jump/step/replay` navigation)
Distributed Replica = `id/state/version/clock/versionVector/pathClocks/tombstones/conflicts/audit`
Distributed Delta = ordered `ChangeSet` operations over canonical paths
Distributed Sync = deterministic `push|pull|bidirectional` with eventual convergence
Global Context = `repos + policies + global dependency graph`
Global Plan = deterministic cross-repo DAG over `repoId:taskId`
Global Policy Propagation = org source distributed to all repo targets (no opt-out)
Global Enforcement Gate = block entire global execution on deny/approval-required violations
Global Execution = dependency-ordered batches with rollback-all transactional semantics
Chat = orchestration interface (non-authoritative)
Init Session = resumable wizard interaction state (`.choir/init-state.json`, non-authoritative)
Audit = immutable compliance evidence (append-only, hash-chained)
Lock = resolved macro library versions for reproducible execution
```