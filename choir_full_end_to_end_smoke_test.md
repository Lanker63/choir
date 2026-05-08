# Choir — Full End-to-End Smoke Test

## Purpose

This smoke test validates that the Choir platform is operational end-to-end across:

- initialization
- compiler pipeline
- deterministic orchestration
- planning
- simulation
- preview
- execution
- rollback
- replay
- policy enforcement
- distributed orchestration
- observability
- verification harnesses
- webviews

This is NOT a deep correctness test.

This is a:

```text
"Can the entire platform execute successfully end-to-end?"
```

validation.

---

# Preconditions

## Environment

- VSCode Insiders installed
- Choir extension installed
- Extension Host operational
- Node/npm installed
- Workspace trusted

---

## Clean Workspace

Create a NEW empty workspace:

```text
choir-smoke-test/
```

Ensure NO existing:

```text
.choir/
choir.config.yaml
```

---

# Phase 1 — Extension Startup

## Step 1.1 — Extension Activation

Open VSCode.

Open:

```text
choir-smoke-test/
```

Assertions:

```text
✔ Choir extension activates
✔ no activation errors
✔ extension host stable
✔ commands registered
✔ @choir visible in chat
```

---

## Step 1.2 — Command Registration

Open Command Palette.

Validate commands exist:

```text
Choir: Init
Choir: Preview
Choir: Simulate
Choir: Execute
Choir: Verify
Choir: Open Control Center
Choir: Open Dependency Graph
Choir: Open Timeline
```

Assertions:

```text
✔ all commands registered
✔ no missing handlers
```

---

# Phase 2 — Initialization

## Step 2.1 — Smart Init

Run:

```text
@choir init
```

Assertions:

```text
✔ init wizard appears
✔ guided prompts shown
✔ defaults suggested
✔ workspace analyzed
✔ deterministic config generated
```

Expected files:

```text
choir.config.yaml
.choir/state.json
.choir/audit/
.choir/traces/
```

---

## Step 2.2 — Config Validation

Open:

```text
choir.config.yaml
```

Assertions:

```text
✔ valid YAML
✔ canonical ordering
✔ required fields present
✔ no empty invalid sections
```

---

# Phase 3 — DSL + Compiler Pipeline

## Step 3.1 — Create Intent

Run:

```text
@choir set goal "Create sample API layer"
```

Assertions:

```text
✔ goal accepted
✔ DSL state updated
✔ YAML updated
```

---

## Step 3.2 — Compiler Pipeline

Run:

```text
@choir preview
```

Assertions:

```text
✔ compiler executes
✔ AST generated
✔ validation passes
✔ plan synthesized automatically
✔ deterministic preview generated
```

Expected diagnostics:

```text
compile
structural-validation
semantic-validation
cross-node-validation
candidate-synthesis
strategy-ranking
strategy-selection
orchestration-build
simulation
replay-verification
```

---

# Phase 4 — Autonomous Planning

## Step 4.1 — Plan Optimization

Run:

```text
@choir plan --optimize
```

Assertions:

```text
✔ no preexisting plan required
✔ multiple candidate plans synthesized automatically
✔ candidate ranking visible
✔ deterministic strategy selected
✔ orchestration DAG generated
✔ rollback scope computed
```

Expected:

```text
strategy: ...
plan: ... (synthesized)
```

---

## Step 4.2 — Determinism Check

Run:

```text
@choir plan --optimize
```

3 times.

Assertions:

```text
✔ same plan ID
✔ same strategy
✔ same hashes
✔ same orchestration ordering
```

---

# Phase 5 — Simulation

## Step 5.1 — Autonomous Simulation

Run:

```text
@choir simulate
```

Assertions:

```text
✔ simulation succeeds
✔ no persisted state mutation
✔ replay verified
✔ simulation hash generated
✔ future state hash generated
```

Expected output sections:

```text
Simulation successful
Replay verified
hashMatch: true
```

---

## Step 5.2 — Simulation Determinism

Run:

```text
@choir simulate
```

3 times.

Assertions:

```text
✔ identical futureState hashes
✔ identical strategy IDs
✔ identical traces
✔ identical orchestration stages
```

---

# Phase 6 — Preview

## Step 6.1 — Execution Preview

Run:

```text
@choir preview
```

Assertions:

```text
✔ preview synthesized automatically
✔ exact execution stages shown
✔ policy decision shown
✔ rollback scope shown
✔ preview hash generated
```

Expected sections:

```text
Policy
Execution stages
Rollback scope
Preview hash
```

---

## Step 6.2 — Preview Consistency

Assertions:

```text
✔ preview uses same strategy as simulation
✔ preview hashes stable
✔ preview deterministic
```

---

# Phase 7 — Policy Enforcement

## Step 7.1 — Policy Evaluation

Assertions:

```text
✔ org policies evaluated
✔ repo policies evaluated
✔ environment policies evaluated
✔ deny precedence enforced
```

---

## Step 7.2 — Approval Enforcement

If preview requires approval:

Run:

```text
@choir execute
```

Assertions:

```text
✔ execution blocked without approval
✔ approval hash binding enforced
```

---

# Phase 8 — Execution

## Step 8.1 — Autonomous Execution

Run:

```text
@choir execute
```

Assertions:

```text
✔ no persisted plan required
✔ plan synthesized automatically
✔ simulation parity precheck passes
✔ transaction begins
✔ orchestration executes
✔ commit succeeds
✔ replay verified
```

Expected sections:

```text
Execution successful
Replay verified
finalState
replayState
```

---

## Step 8.2 — Simulation / Execution Equivalence

Capture:

From simulation:

```text
futureStateHash
```

From execution:

```text
finalStateHash
```

Assertions:

```text
✔ simulation.futureStateHash === execution.finalStateHash
```

---

## Step 8.3 — Replay Equivalence

Capture:

```text
execution.finalStateHash
replay.hash
```

Assertions:

```text
✔ replay.hash === execution.finalStateHash
```

---

# Phase 9 — Rollback

## Step 9.1 — Forced Failure

Inject invalid mutation.

Run:

```text
@choir execute
```

Assertions:

```text
✔ transaction failure detected
✔ rollback executed
✔ no partial commit
✔ unrelated units preserved
```

---

# Phase 10 — Audit + Replay

## Step 10.1 — Audit Validation

Inspect:

```text
.choir/audit/
```

Assertions:

```text
✔ append-only logs exist
✔ hashes present
✔ transitions recorded
✔ traces persisted
```

---

## Step 10.2 — Replay Command

Run:

```text
@choir replay
```

Assertions:

```text
✔ replay succeeds
✔ replay deterministic
✔ hashes match execution
```

---

# Phase 11 — Webviews

## Step 11.1 — Control Center

Open:

```text
Choir: Open Control Center
```

Assertions:

```text
✔ webview opens
✔ no blank screen
✔ state loaded
✔ orchestration visible
```

---

## Step 11.2 — Dependency Graph

Open:

```text
Choir: Open Dependency Graph
```

Assertions:

```text
✔ graph renders
✔ nodes visible
✔ edges visible
✔ deterministic ordering
```

---

## Step 11.3 — Timeline

Open timeline.

Assertions:

```text
✔ transitions visible
✔ replay traces visible
✔ execution stages visible
```

---

# Phase 12 — Verification Harnesses

## Step 12.1 — Contract Verification

Run:

```bash
npm run verify
```

Assertions:

```text
✔ verification passes
✔ no contract failures
```

---

## Step 12.2 — Architecture Tests

Run:

```bash
npm run test:architecture
```

Assertions:

```text
✔ architecture tests pass
```

---

## Step 12.3 — Property Tests

Run:

```bash
npm run verify:property
```

Assertions:

```text
✔ invariants preserved
✔ deterministic outputs
```

---

## Step 12.4 — Chaos Tests

Run:

```bash
npm run verify:chaos
```

Assertions:

```text
✔ rollback remains correct
✔ no corruption
✔ invariants preserved
```

---

# Phase 13 — Final Contract Validation

## Step 13.1 — Full Contract Verification

Run:

```text
@choir verify --contracts
```

Assertions:

```text
✔ 14/14 contracts pass
```

---

# Final Smoke Test Acceptance Criteria

Choir passes smoke testing ONLY if:

```text
✔ extension activates
✔ init succeeds
✔ compiler succeeds
✔ plans synthesize automatically
✔ simulation succeeds
✔ preview succeeds
✔ execution succeeds
✔ rollback works
✔ replay matches execution
✔ policies enforced
✔ orchestration deterministic
✔ webviews functional
✔ verification harnesses pass
✔ no nondeterminism detected
✔ all contracts pass
```

---

# Final Release Gate

Choir is considered:

```text
SMOKE TEST PASSING
```

ONLY if:

```text
✔ no manual intervention required
✔ no persisted plans required
✔ autonomous orchestration operational
✔ simulatio