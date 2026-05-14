# Choir — Post-Phase-9 Deterministic Mutation Runtime Smoke Test

## Purpose

This smoke test extends the original Choir end-to-end smoke test beginning AFTER Phase 9 and validates the new deterministic transactional filesystem runtime.

This test validates:

- deterministic materialization
- transactional filesystem mutation
- authoritative workspace snapshot hashing
- replay reconstruction
- rollback fidelity
- manifest lineage integrity
- patch-order integrity
- cross-process locking
- crash recovery
- binary-safe replay
- concurrency determinism
- portability normalization
- lineage compaction
- adversarial integrity enforcement
- large-workspace scaling behavior

This is still a smoke test.

It validates:

```text
"Can the deterministic filesystem runtime operate correctly end-to-end under normal and adversarial conditions?"
```

This is NOT intended to replace:

- deep fuzzing
- formal verification
- performance benchmarking
- distributed systems certification
- full OS matrix certification

---

# Preconditions

## Environment

Required:

```text
VSCode Insiders
Choir extension installed
Workspace trusted
Node/npm installed
Git installed
```

Recommended:

```text
Linux/macOS shell
SSD-backed filesystem
8GB+ RAM
```

Optional:

```text
Windows validation environment
Network filesystem validation environment
```

---

# Workspace Setup

Create a NEW workspace:

```text
choir-mutation-runtime-smoke-test/
```

Ensure NO preexisting:

```text
.choir/
choir.config.yaml
```

---

# Baseline Initialization

Run:

```text
@choir init
```

Assertions:

```text
✔ initialization succeeds
✔ deterministic config generated
✔ .choir artifacts created
✔ workspace snapshot baseline generated
```

Expected directories:

```text
.choir/
.choir/audit/
.choir/traces/
.choir/artifacts/
.choir/artifacts/materialization/
```

---

# Phase 10 — Deterministic Materialization Pipeline

## Step 10.1 — Generate Real Workspace Mutations

Run:

```text
@choir set goal "Create sample API service with routes, models, and tests"
```

Then:

```text
@choir execute
```

Assertions:

```text
✔ execution succeeds
✔ analyze stage runs
✔ validate stage runs
✔ synthesize stage runs
✔ generate stage runs
✔ apply stage runs
✔ verify stage runs
✔ commit stage runs
✔ real files created on disk
✔ materialization manifests persisted
✔ workspace snapshot hashes persisted
```

Expected execution stages:

```text
analyze
validate
synthesize
generate
apply
verify
commit
```

---

## Step 10.2 — Verify Real Workspace Mutation

Inspect workspace.

Assertions:

```text
✔ generated files exist
✔ generated directories exist
✔ generated artifacts deterministic
✔ no partial writes
```

Expected generated content examples:

```text
src/
api/
tests/
```

---

## Step 10.3 — Verify Materialization Artifacts

Inspect:

```text
.choir/artifacts/materialization/
```

Assertions:

```text
✔ manifests exist
✔ snapshot manifests exist
✔ patch lineage persisted
✔ pre/post workspace snapshot hashes present
✔ deterministic metadata persisted
```

---

# Phase 11 — Workspace Snapshot Determinism

## Step 11.1 — Deterministic Execute Repetition

Run:

```text
@choir execute
```

3 times without changing workspace.

Assertions:

```text
✔ identical workspace snapshot hashes
✔ identical replay hashes
✔ identical materialization manifests
✔ identical patch ordering
✔ identical generated artifacts
```

---

## Step 11.2 — Non-Targeted Workspace Divergence Detection

Create unrelated file:

```text
rogue-file.txt
```

Add:

```text
tampered
```

Run:

```text
@choir execute
```

Assertions:

```text
✔ integrity violation detected
✔ execution aborted pre-transaction
✔ WORKSPACE_SNAPSHOT_DIVERGENCE emitted
✔ no writes committed
```

---

# Phase 12 — Manifest Integrity Enforcement

## Step 12.1 — Manifest Tamper Detection

Modify materialization manifest hash manually.

Run:

```text
@choir execute
```

Assertions:

```text
✔ MANIFEST_TAMPER detected
✔ execution aborted
✔ no transaction opened
```

---

## Step 12.2 — Patch Order Tamper Detection

Reorder deterministic patch entries in manifest.

Run:

```text
@choir execute
```

Assertions:

```text
✔ PATCH_ORDER_DIVERGENCE detected
✔ execution aborted
✔ no filesystem mutation occurs
```

---

# Phase 13 — Replay Reconstruction

## Step 13.1 — Replay Reconstruction After File Deletion

Delete generated files manually.

Example:

```text
rm -rf src/
```

Run:

```text
@choir replay
```

Assertions:

```text
✔ workspace reconstructed
✔ deleted files restored
✔ replay succeeds
✔ replay workspace hash equals execute workspace hash
✔ generated artifacts restored byte-for-byte
```

---

## Step 13.2 — Replay Fidelity Validation

Capture:

```text
execution.workspaceSnapshotHash
replay.workspaceSnapshotHash
```

Assertions:

```text
✔ hashes identical
```

---

# Phase 14 — Transactional Rollback Fidelity

## Step 14.1 — Forced Failure During Apply

Enable rollback chaos injection.

Example:

```bash
CHOIR_TEST_ROLLBACK_STAGE=apply
```

Run:

```text
@choir execute
```

Assertions:

```text
✔ transaction opened
✔ partial mutation attempted
✔ rollback triggered
✔ workspace restored
✔ no partial files remain
✔ rollback lineage persisted
```

---

## Step 14.2 — Byte-for-Byte Recovery Validation

Compare workspace against pre-execution baseline.

Assertions:

```text
✔ byte-for-byte equivalence restored
✔ workspace snapshot hash restored
```

---

# Phase 15 — Crash Recovery

## Step 15.1 — Crash During Apply

Inject process termination during apply stage.

Example:

```bash
CHOIR_TEST_KILL_DURING_APPLY=1
```

Run execute.

Restart runtime.

Assertions:

```text
✔ crash journal detected
✔ recovery executes automatically
✔ no orphaned mutations
✔ workspace restored to consistent state
✔ no partial commit
```

---

## Step 15.2 — Crash During Rollback

Inject crash during rollback.

Restart runtime.

Assertions:

```text
✔ interrupted rollback recovered
✔ deterministic recovery completed
✔ workspace consistent
✔ no unrecoverable transaction state
```

---

# Phase 16 — Cross-Process Locking

## Step 16.1 — Concurrent Execute Storm

Launch multiple concurrent execute operations.

Example:

```bash
for i in {1..10}; do
  @choir execute &
done
```

Assertions:

```text
✔ no race-condition corruption
✔ deterministic final workspace state
✔ lock contention handled safely
✔ stale lock recovery functional
✔ no overlapping partial writes
```

---

## Step 16.2 — Stale Lock Recovery

Simulate abandoned lock ownership.

Assertions:

```text
✔ stale lock reclaimed
✔ execution proceeds safely
✔ ownership verification enforced
```

---

# Phase 17 — Binary Artifact Safety

## Step 17.1 — Binary Replay Validation

Add binary artifact.

Examples:

```text
png
pdf
zip
```

Execute mutation.

Tamper with binary.

Run:

```text
@choir replay
```

Assertions:

```text
✔ binary restored byte-for-byte
✔ replay succeeds
✔ workspace snapshot hash restored
```

---

## Step 17.2 — Invalid Binary Patch Handling

Inject invalid text-patch attempt against binary artifact.

Assertions:

```text
✔ fail-closed behavior
✔ no silent corruption
✔ rollback succeeds
```

---

# Phase 18 — Portability + Path Normalization

## Step 18.1 — Unicode Path Determinism

Create unicode-normalized path variants.

Assertions:

```text
✔ canonical normalization enforced
✔ deterministic workspace hash stable
✔ replay parity preserved
```

---

## Step 18.2 — Case Collision Detection

Create conflicting case-insensitive paths.

Assertions:

```text
✔ collision detected
✔ integrity violation emitted
✔ execution aborted safely
```

---

## Step 18.3 — Symlink Determinism

Create symlink mutation scenario.

Assertions:

```text
✔ symlink captured in snapshot
✔ replay reconstructs symlink state
✔ workspace hash stable
```

---

# Phase 19 — Large Workspace Determinism

## Step 19.1 — Scale Validation

Run:

```bash
CHOIR_RUNTIME_SCALE_FULL=1 npm run verify:runtime
```

Assertions:

```text
✔ 10k entry profile passes
✔ 100k entry profile passes
✔ 1M entry profile passes
✔ deterministic replay maintained
✔ memory remains stable
```

---

## Step 19.2 — Large Replay Reconstruction

Replay large synthetic workspace.

Assertions:

```text
✔ replay completes
✔ workspace parity preserved
✔ snapshot hashes identical
```

---

# Phase 20 — Audit + Forensic Integrity

## Step 20.1 — Audit Chain Verification

Inspect:

```text
.choir/audit/
```

Assertions:

```text
✔ append-only lineage present
✔ mutation manifests linked
✔ snapshot manifests linked
✔ rollback lineage persisted
✔ replay lineage persisted
✔ integrity taxonomy persisted
```

---

## Step 20.2 — Failed Stage Attribution

Inject controlled failure.

Assertions:

```text
✔ failedStage populated correctly
✔ forensic attribution precise
✔ rollback/apply/verify failures distinguishable
```

---

# Phase 21 — Runtime Verification Harnesses

## Step 21.1 — Runtime Verification

Run:

```bash
npm run verify:runtime
```

Assertions:

```text
✔ runtime verification passes
✔ replay verification passes
✔ rollback verification passes
✔ adversarial integrity tests pass
```

---

## Step 21.2 — Architecture Verification

Run:

```bash
npm run test:architecture
```

Assertions:

```text
✔ architecture tests pass
✔ deterministic runtime contracts validated
✔ failed-stage attribution tests pass
```

---

## Step 21.3 — Full Test Suite

Run:

```bash
npm test
```

Assertions:

```text
✔ all tests pass
✔ mutation runtime stable
✔ no nondeterminism detected
```

---

# Final Acceptance Criteria

Choir passes deterministic mutation runtime smoke testing ONLY if:

```text
✔ deterministic materialization operational
✔ real workspace mutation operational
✔ authoritative workspace hashing operational
✔ replay reconstructs filesystem state
✔ rollback restores workspace byte-for-byte
✔ manifest tamper blocked fail-closed
✔ patch-order tamper blocked fail-closed
✔ cross-process locking operational
✔ crash recovery operational
✔ binary-safe replay operational
✔ portability normalization operational
✔ concurrency determinism preserved
✔ adversarial integrity tests pass
✔ replay parity maintained
✔ preview == simulation == execute == replay
✔ no partial commits observed
✔ no silent corruption observed
✔ runtime verification passes
✔ architectur