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
  - Execution runtime state (task status, task results, history, preview approvals)
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
- Evaluate deterministic strategy variants per selected plan
- Select best validated strategy before execution
- Generate exact execution preview from simulation
- Enforce preview-hash approval gate before execution
- Approve and execute plans
- Report plan/task execution status
- Preserve deterministic task ordering and dependency semantics

Supported command surface:

- `plan`
- `plan for goal: <goal>`
- `approve <planId>`
- `preview [planId]`
- `execute <previewHash>`
- `execute <planId> <previewHash>`
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

## Scope boundary

Cost-based planning chooses which approved plan(s) should execute.
It does not choose how each plan is internally structured at execution time.

That second decision is handled by deterministic multi-strategy planning.

---

# Multi-Strategy Planning (Deterministic, No LLM)

After cost-based plan-set selection, each selected plan enters a deterministic strategy pass.

## Strategy set

- `minimal`: preserve base plan structure
- `grouped`: merge overlapping refactor tasks by file overlap
- `layered`: reorder/reshape refactors by dependency layers
- `aggressive`: merge refactors into one broad transformation task

## Five-pass execution contract

1. **Pass 1 — Strategy registry**
  - Enumerate fixed strategy ids in stable lexical order.
2. **Pass 2 — Pure transforms**
  - Generate strategy-specific plan variants with deterministic ids/dependencies.
3. **Pass 3 — Simulation-only validation**
  - Evaluate each variant with transactional simulation (`prepare → simulate → validate`) and no commit.
4. **Pass 4 — Deterministic selection**
  - Prefer strategies whose validation passes.
  - Then choose lowest total cost.
  - Tie-break by lexical `strategyId`.
5. **Pass 5 — Execution + trace**
  - Execute only the selected strategy plan.
  - Emit explainable strategy trace (evaluated strategies, costs, success flags, decision).

## Hard constraints

- No LLM involvement
- No randomness
- No mutation during strategy evaluation
- Stable ordering of strategies and comparisons
- Same inputs always produce same selected strategy

## Cost-planning hard constraints

- No randomness
- No LLM scoring
- No mutation during scoring
- No dependence on execution order
- Same input always yields same selected plan(s)

---

# Execution Preview (Deterministic, Simulation-Derived)

Before execution, Conductor can produce a user-visible preview that shows exactly what will change.

## Preview contract

- Preview is derived from the execution simulation path, not a separate approximation.
- Preview never mutates real workspace files.
- Preview output is deterministic for identical inputs.
- Preview must match what execution would apply for the same selected strategy plan.

## Preview model

```ts
type ExecutionPreview = {
  previewId: string;
  hash: string;
  planId: string;

  summary: {
    totalFilesChanged: number;
    totalPatches: number;
    totalDiagnosticsResolved: number;
  };

  fileChanges: Array<{
    file: string;
    patches: Patch[];
    diff: string;
    before: string;
    after: string;
  }>;

  diagnostics: Diagnostic[];

  strategy?: {
    strategyId: string;
    cost: number;
  };
};
```

## Preview pipeline

1. Select approved plan(s) by deterministic cost policy.
2. Select best strategy by deterministic multi-strategy policy.
3. Execute selected strategy plan through simulation-only transaction flow.
4. Collect proposed patches and virtual-FS after-state.
5. Build grouped file changes and unified diffs.
6. Compute deterministic hash from preview file changes.

If preview and execution diverge, the execution pipeline is considered incorrect and must be fixed.

## Approval gate

- Execution requires an explicit preview hash.
- Stored approval metadata in state (`execution.lastPreview`) includes:
  - `hash`
  - `planId`
  - optional `strategyId`
- Before execution, preview is recomputed and hash-compared.
- Hash mismatch rejects execution and requires a fresh preview.

## Hash rule

```ts
hash = sha256(JSON.stringify(preview.fileChanges));
```

This binds approval to exact file-level change content.

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

Simulation-only planning reuses the same transaction primitives but omits commit/rollback writes:

- `prepare` snapshot
- `simulate` patches in virtual FS
- `validate` invariants
- return validation outcome and trace

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
- Strategy variants and selected strategy ids
- Preview file changes and preview hash
- Execution graph/layers/batches
- Conflict decisions
- Transaction outcomes

Non-negotiable safeguards:

1. No direct disk writes before validation pass
2. All code mutation decisions flow through Enforcer logic
3. Control plane and state plane authority boundaries remain strict
4. Scheduler decisions are stable and auditable
5. Execution is blocked unless preview hash is explicitly approved and revalidated

---

# System Contract

```yaml
YAML = intent + policy + execution plans (authoritative)
JSON = computed facts + execution runtime state (derived)
Chat = orchestration interface (non-authoritative)
```