# Choir Design Guidelines

Choir is a VS Code extension for deterministic, policy-driven workspace governance. The extension compiles intent into enforceable rules, synthesizes plans from state, optimizes execution across plans, and applies speculative execution with rollback-safe transactional batches.

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
  - Single source of truth for policy and plan intent

> Chat compiles into YAML. YAML is authoritative.

---

### 2. State Plane (Derived)

- Format: JSON (`.choir/state.json`)
- Owner: System
- Contains:
  - AST indexes
  - Symbol/dependency graphs
  - Diagnostics
  - Metrics
  - Execution runtime state (task status, task results, history)
- Required properties:
  - Fully reproducible from workspace + control plane
  - Not user-authored
  - Deterministically serialized

---

### 3. Interaction Plane (Ephemeral)

- Format: Chat participant prompts/responses
- Owner: User + agents
- Used for:
  - Authoring intent and policy
  - Triggering analysis and execution
  - Explaining outcomes and state

> Chat is an interface, not persisted policy or state.

---

# Orchestration Layer

## Conductor Responsibilities

- Generate draft plans from control+state
- Score candidate plans with a deterministic cost model
- Select optimal plan set before execution
- Approve and execute plans
- Report plan/task execution status
- Preserve deterministic task ordering and dependency semantics

Supported command surface:

- `plan`
- `plan for goal: <goal>`
- `approve <planId>`
- `execute`
- `execute <planId>`
- `status`

## Deterministic State → Plan Synthesis

Plan synthesis must be deterministic for identical `(control plane, state plane)` inputs.

### Algorithm contract

1. Filter diagnostics by policy/intent scope.
2. Group by rule id.
3. Build dependency-aware file layers from the dependency graph.
4. Synthesize tasks:
   - One analysis task
   - Minimal grouped refactor tasks (rule/file scoped)
   - One final enforce/validate task
5. Generate deterministic plan id from normalized input payload.

### Required guarantees

- Stable sorting at every step
- No random identifiers
- Repeatable output shape and task order

---

# Cost-Based Planning

Approved plans are evaluated with a deterministic, explainable cost model before execution.

## Cost dimensions

- `editCost`: estimated patch count
- `fileTouchCost`: number of unique files modified
- `riskCost`: risk heuristic based on refactor intensity
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

- Score all eligible plans
- Select plan set with minimum total cost
- Tie-break by `planId` lexical order
- Produce explainable cost trace (`selectedPlanId`, evaluated scores, decision)

## Hard constraints

- No randomness
- No LLM scoring
- No mutation during scoring
- No dependence on execution order
- Same input always yields same selected plan(s)

---

# Multi-Plan Optimization

Execution planning across multiple plans follows a global optimization pass.

## Global execution model

- Flatten tasks into global ids (`planId:taskId`)
- Normalize dependencies into a single DAG
- Compute deterministic topological layers
- Build a conflict matrix using:
  - file mutation overlap
  - dependency chain constraints
- Batch compatible work units within each layer

## Parallel scheduling rules

- Batches in the same dependency layer may run concurrently
- Conflicting work units must not share a batch
- Layer order remains deterministic

---

# Transactional Batch Execution

Each execution batch is processed transactionally:

`prepare → simulate → validate → commit | rollback`

## Transaction model

- Snapshot only touched files + state plane
- Simulate all patches in virtual FS (no disk writes)
- Run invariant validation before commit
- Commit atomically, or rollback to snapshot

## Invariants required before commit

- No new blocking errors (or within configured threshold)
- No overlapping patch ranges
- AST parse success for touched files
- Type check pass (if enabled)
- Priority/conflict constraints respected
- Idempotency: reapplying patches yields no further changes

## Commit/Rollback guarantees

- No partial writes
- State/file consistency preserved
- Rollback always available for failed or invalid transactions
- File-set commit locking prevents cross-batch corruption

---

# Determinism and Safety Contract

For identical inputs, Choir must produce identical:

- Plan ids and task ordering
- Plan scores and selected plan sets
- Execution graph/layers/batches
- Conflict decisions
- Transaction outcomes

Non-negotiable safeguards:

1. No direct disk writes before validation pass
2. All code mutation decisions flow through Enforcer logic
3. Control plane and state plane authority boundaries remain strict
4. Scheduler decisions are stable and auditable

---

# System Contract

```yaml
YAML = intent + policy + execution plans (authoritative)
JSON = computed facts + execution runtime state (derived)
Chat = orchestration interface (non-authoritative)
```