# Choir Manual QA/QC Procedure

Validates all functional capabilities through a manual, step-by-step QA/QC procedure. Steps are grouped by what is being tested. Each numbered step describes the action to perform; sub-items describe what to validate as a result.

---

## Preconditions

1. Open the target workspace in VS Code.

   - Workspace must contain a TypeScript or JavaScript project.
   - A terminal must be open at the repository root.

2. Run `npm run build`.

   - Confirm the build exits with code 0 before proceeding.

3. If the workspace is a Git repository, run `git status --short` and record any pre-existing local changes.

   - If the workspace is not a Git repository, record a baseline file snapshot by listing top-level files and noting modified targets before QA starts.

---

## Topic 1: Initialization and Control-Plane Authoring

1. In chat, enter `@choir init` and respond to all prompts with a mission, vision, two goals, two constraints, and two non-goals.

   - Confirm `.choir/choir.config.yaml` is created.
   - Confirm `.choir/state.json` is created.
   - Confirm the mission, vision, goals, constraints, and non-goals in `.choir/choir.config.yaml` match exactly what was entered.
   - Confirm the YAML file parses without schema errors.

2. In chat, enter `@choir status`.

   - Confirm a summary of the control-plane and state-plane is returned.
   - Confirm no runtime exception is shown.

3. In chat, enter `@choir define mission "<new mission text>"`.

   - Confirm the mission field updates in `.choir/choir.config.yaml`.

4. In chat, enter `@choir define vision "<new vision text>"`.

   - Confirm the vision field updates in `.choir/choir.config.yaml`.

5. In chat, enter `@choir define goal "<goal-1>"` and then `@choir define goal "<goal-2>"`.

   - Confirm both goals are present in the control plane.
   - Confirm order is consistent across multiple reads.

6. In chat, enter `@choir define constraint "<constraint-1>"` and then `@choir define constraint "<constraint-2>"`.

   - Confirm both constraints are persisted.

7. In chat, enter `@choir define non-goal "<non-goal-1>"` and then `@choir define non-goal "<non-goal-2>"`.

   - Confirm both non-goals are persisted.
   - Confirm `.choir/choir.config.yaml` remains valid YAML after all define operations.

---

## Topic 2: Analysis and Planning

1. In chat, enter `@choir analyze workspace`.

   - Confirm analysis completes without runtime errors.
   - Confirm response includes workspace analysis payload (not only a generic no-change message).

2. In chat, enter `@choir analyze hotspots`.

   - Confirm hotspot output is returned.
   - Confirm response is command-specific (not only a generic no-change message).
   - Re-run with unchanged workspace and confirm stable output.

3. In chat, enter `@choir analyze summary`.

   - Confirm the summary is coherent with workspace content.
   - Confirm response is command-specific (not only a generic no-change message).

4. In chat, enter `@choir plan --optimize`.

   - Confirm multiple candidate plans are evaluated.
   - Confirm a selected plan and strategy are returned.
   - Confirm selected plan id is persisted in control plane (for example via `persistedPlan` in output or `.choir/choir.config.yaml`).

5. Re-run `@choir plan --optimize` without changing any input.

   - Confirm the same plan and strategy are selected (deterministic output).

---

## Topic 3: Simulation, Preview, Execution, and Rollout

Topic setup for deterministic lineage:

- For each strategy-specific execute run in this topic, start from a fresh checkpoint or re-run `@choir preview` immediately before execute to bind current state/workspace lineage.
- If integrity reports `STATE_LINEAGE_DIVERGENCE` or `PREVIEW_HASH_MISMATCH`, treat it as a stale-lineage setup issue and refresh preview/simulation before retrying.

1. In chat, enter `@choir simulate`.

   - Confirm simulation completes successfully.
   - Confirm no workspace writes or state commits occur as a side effect.

2. In chat, enter `@choir preview`.

   - Confirm preview is generated successfully.
   - Confirm a preview hash or identity token is present in the response.

3. In chat, enter `@choir execute`.

   - Confirm execution succeeds from intent-first flow (no manually pre-created plan required).
   - Confirm pre-commit simulation parity and integrity checks are reported as passing.
   - Confirm post-execution replay verification succeeds.

4. In chat, enter `@choir preview`, then `@choir execute --strategy all-at-once`.

   - Confirm successful execution with rollout output.
   - Confirm output includes `rolloutStrategy: all-at-once`.
   - Confirm no integrity failure is reported for stale lineage (`STATE_LINEAGE_DIVERGENCE`, `PREVIEW_HASH_MISMATCH`).

5. In chat, enter `@choir preview`, then `@choir execute --strategy canary`.

   - Confirm staged canary progression and per-stage validation are reported.
   - Confirm output includes `rolloutStrategy: canary` and strategy-specific stage grouping.

6. In chat, enter `@choir preview`, then `@choir execute --strategy phased`.

   - Confirm phased progression is reported.
   - Confirm output includes `rolloutStrategy: phased` and strategy-specific stage grouping.

7. In chat, enter `@choir preview`, then `@choir execute --strategy batched`.

   - Confirm batched progression is reported.
   - Confirm output includes `rolloutStrategy: batched` and strategy-specific stage grouping.
   - Confirm strategy-switch runs do not fail solely with `DAG_CANONICAL_ORDER_MISMATCH` when inputs are otherwise unchanged.

8. In chat, enter `@choir status`.

   - Confirm status reflects the latest execution state.

---

## Topic 4: Rollback and Failure Isolation

1. Trigger an execution that changes state.

   - Confirm the state change is observable before rollback.

2. In chat, enter `@choir rollback`.

   - Confirm rollback completes successfully.
   - Confirm `stateHashBefore` and `stateHashAfter` are both present in rollback output.
   - Confirm `stateHashAfter` matches the pre-execution hash and differs from the post-execution hash.
   - Confirm state and workspace are restored to pre-execution values.

3. In chat, enter `@choir rollback --stage <stageId>` using a valid stage id from a prior run.

   - Confirm stage-scoped rollback behavior is reported.
   - Confirm deterministic alias selectors (for example `batch-L1-1`) resolve to a reported `resolvedStageId` when applicable.

4. In chat, enter `@choir rollback <unitId>` using a valid unit id from a prior run.

   - Confirm unit-targeted rollback behavior is reported.
   - Confirm canonical alias selectors (for example `packages.api` for `packages:api`) resolve to a reported `resolvedUnitId` when applicable.
   - Confirm work-unit selectors (for example `wu-<hash>` from prior execution output) resolve to a reported `resolvedUnitId` when mapping is deterministic.
   - Confirm work-unit selector resolution prefers the latest successful execute context (same run lineage) before synthesized fallback mapping.

---

## Topic 5: Policy Enforcement and Approval Gates

1. Add a `deny` rule for a specific action prefix in `.choir/policies.dsl`.

2. Execute the action covered by the deny rule.

   - Confirm the action is blocked and the response is fail-closed (no partial write).

3. Replace the deny rule with a `require-approval` rule for the same action.

4. Re-run the covered action.

   - Confirm the response shows approval is required and includes a pending identifier or hash.

5. Approve the pending action using the pending identifier, then re-run the action.

   - Confirm the action proceeds only after approval.

6. Create a new pending action and reject it using `@choir reject <id>`.

   - Confirm the action remains blocked after rejection.

7. In chat, enter `@choir policy status`.

   - Confirm the effective policy decision summary reflects the current rules correctly.

---

## Topic 6: Graph, Timeline, Diagnostics, and Webview Surfaces

1. Open the Command Palette and run **Choir: Open Control Center**.

   - Confirm the panel loads and renders without console or runtime errors.

2. Open the Command Palette and run **Choir: Open Dependency Graph**.

   - Confirm the graph panel loads and dependency data renders.

3. Open the Command Palette and run **Choir: Open Timeline**.

   - Confirm the timeline panel loads and prior transitions appear.

4. Open the Command Palette and run **Choir: Open Diagnostics**.

   - Confirm the diagnostics panel loads and displays entries.

5. In chat, enter `@choir graph`.

   - Confirm a graph summary is returned.

6. In chat, enter `@choir graph focus <node>` using a known node id.

   - Confirm focused node projection is returned.

7. In chat, enter `@choir graph dependencies <node>`.

   - Confirm the dependency list is returned and matches known structure.

8. In chat, enter `@choir graph dependents <node>`.

   - Confirm the dependents list is returned and matches known structure.

9. In the Dependency Graph panel, select a node and click **Open Node**.

   - Confirm the selected node manifest file opens in the editor.
   - Confirm Timeline is opened (if not already open) and navigates to the same unit context.
   - Close both the manifest editor tab and Timeline, click **Open Node** again, and confirm they reopen for the same node.
   - Clear Focus Node (or switch to a state with no valid focus) and confirm **Open Node**, **Dependencies**, and **Dependents** are visibly disabled.
   - Re-select a valid node and confirm those controls re-enable.

10. In the Dependency Graph panel, click **Refresh**.

   - Confirm the status line briefly shows `Refreshing graph projection...`.
   - Confirm the status line updates to include `refreshed=<time>`.
   - Confirm Trace updates with `generatedAt=<isoTime>` (new value on each refresh).
   - Confirm pipeline-driven projections refresh (graph/timeline/diagnostics) rather than a no-op repaint.

11. Open the Command Palette and run **Choir: Show Webview Sync Trace**.

   - Confirm Output opens to channel **Choir Webview Sync Trace**.
   - Confirm host-to-webview events are listed.

12. Open the Command Palette and run **Choir: Show DSL Editor Trace**.

   - Confirm Output opens to channel **Choir DSL Editor Trace**.
   - Confirm counters are shown (`completionsTriggered`, `diagnosticsCount`, `parseErrors`).

---

## Topic 7: Governance, Audit, and Reporting

1. In chat, enter `@choir audit log`.

   - Confirm audit entries are returned.

2. In chat, enter `@choir audit query`.

   - Confirm query results are returned and readable.

3. In chat, enter `@choir audit report`.

   - Confirm compliance report artifacts are generated.

4. Open `.choir/audit.log.jsonl` in a text editor or run `cat .choir/audit.log.jsonl`.

   - Confirm the file exists and contains entries from the current run.
   - Confirm no entries from the current run are missing or out of order.

---

## Topic 8: Refactor Feature Surface

1. Run `@choir refactor rename <symbol> <newName>` using a real symbol in the workspace.

   - Confirm the refactor preview and execute path completes without corruption.
   - Confirm the renamed symbol appears correctly across all affected source files.

2. Run `@choir refactor rename <symbol> <newName>` where `<symbol>` exists as multiple declarations in different files.

   - Confirm the command fails closed.
   - Confirm the error includes deterministic candidate declaration locations so the user can disambiguate.
   - Confirm it is reported as a command/runtime failure, not as `Invalid Choir DSL command`.

3. Re-run rename using a selected declaration: `@choir refactor rename <symbol> <newName> --declaration "<file>"`.

   - Confirm the selected declaration is renamed.
   - Confirm other same-name declarations remain unchanged.
   - If more than one matching declaration exists in the selected file, confirm the command asks for `"<file:line:character>"`.

4. Run `@choir refactor inline <symbol>` using a valid symbol.

   - Use a variable declaration with an initializer (for example `const taxRate = 0.07;`) as the inline target symbol.
   - Confirm inline completes safely with no stray source artifacts.

5. Run `@choir refactor move <symbol> <targetUnit>`.
   - Alternative path-target form: `@choir refactor move <symbol> --file "<workspace-relative-file>"`.

   - Confirm the command is accepted at the parse or plan level.
   - Use a top-level exported function declaration as the move target symbol.
   - Confirm execution succeeds for supported move cases.
   - Confirm source compatibility is preserved (for example, source re-export still satisfies existing importers).
   - Confirm unsupported move shapes fail closed with a clear message.

6. Run `@choir refactor extract <symbol> <targetUnit>`.
   - Alternative path-target form: `@choir refactor extract <symbol> --file "<workspace-relative-file>"`.

   - Confirm the command is accepted at the parse or plan level.
   - Use a top-level exported non-default function declaration as the extract target symbol.
   - Confirm execution succeeds for supported extract cases.
   - Confirm source compatibility is preserved through deterministic wrapper delegation to the target implementation.
   - Confirm unsupported extract shapes fail closed with a clear message.

---

## Topic 9: Library and Import Commands

1. Run `@choir library list`.

   - Confirm the command returns a result without error.

2. Run `@choir import <lib>@<selector>` using a prepared library reference.

   - Confirm the command completes without a runtime exception.

3. Run `@choir library install <lib>@<selector>`.

   - Confirm the install result is reported.

4. Run `@choir library update <identifier>`.

   - Confirm the update result is reported.

5. Run `@choir library lock`.

   - Confirm lock behavior and any lock artifacts are reported.

---

## Topic 10: CI Pipeline

1. Confirm `.choir/choir.config.yaml` is valid (run `@choir status` if unsure).

2. Run `@choir ci run`.

   - Confirm the CI pipeline completes successfully.
   - Confirm the canonical stage order is reported: `source → compile → plan → policy → preview → execute → audit`.
   - Confirm CI artifacts are written under `.choir/artifacts/ci/`.

---

## Topic 11: CLI Verification Surface

Run each command below and confirm the stated result for each.

1. `node out/cli.js verify --compiler` — compiler verification passes with no failures.

2. `node out/cli.js verify --determinism` — determinism verification passes.

3. `node out/cli.js verify --transactions` — transaction verification passes.

4. `node out/cli.js verify --state` — state integrity verification passes.

5. `node out/cli.js verify --policy` — policy enforcement verification passes.

6. `node out/cli.js verify --orchestration` — global orchestration verification passes.

7. `node out/cli.js verify --production` — production readiness verification passes.

8. `node out/cli.js verify --property --seed 1337` — property test run reports zero failures.

9. `node out/cli.js verify --chaos moderate --seed 1337` — chaos test run reports zero failures.

10. `node out/cli.js verify --full` — full-system gate passes with no unresolved invariant or hardening failures.

---

## Topic 12: Determinism and Repeatability

Run each command below a second time on unchanged inputs and confirm stability.

1. Re-run `@choir plan --optimize`.

   - Confirm the same plan and strategy are selected.

2. Re-run `@choir preview`.

   - Confirm the preview hash or identity token is identical to the first run.

3. Re-run `@choir simulate`.

   - Confirm the simulation outcome matches the first run.

---

## Sign-Off

| Topic | Result | Notes |
|---|---|---|
| 1. Initialization and Control-Plane Authoring | PASS / FAIL | |
| 2. Analysis and Planning | PASS / FAIL | |
| 3. Simulation, Preview, Execution, and Rollout | PASS / FAIL | |
| 4. Rollback and Failure Isolation | PASS / FAIL | |
| 5. Policy Enforcement and Approval Gates | PASS / FAIL | |
| 6. Graph, Timeline, Diagnostics, and Webview Surfaces | PASS / FAIL | |
| 7. Governance, Audit, and Reporting | PASS / FAIL | |
| 8. Refactor Feature Surface | PASS / FAIL | |
| 9. Library and Import Commands | PASS / FAIL | |
| 10. CI Pipeline | PASS / FAIL | |
| 11. CLI Verification Surface | PASS / FAIL | |
| 12. Determinism and Repeatability | PASS / FAIL | |

**Overall result:** PASS / FAIL

**Tester:**

**Date:**

**Defects filed (if any):**
