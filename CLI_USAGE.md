# Choir CLI Usage Guide

`choir-cli` is the standalone command-line interface for Choir. It provides non-interactive access to the same pipeline operations available through the VS Code chat participant, and is designed for CI/CD pipelines, scripting, and local terminal workflows.

---

## Table of Contents

1. [Installation](#installation)
2. [Requirements](#requirements)
3. [Workspace Convention](#workspace-convention)
4. [Output Format](#output-format)
5. [Exit Codes](#exit-codes)
6. [Verification — `verify`](#verification)
7. [CI Pipeline — `ci run`](#ci-pipeline)
8. [Initialization — `init`](#initialization)
9. [Intent Definition — `define`](#intent-definition)
10. [Goal Mutation — `remove goal`](#goal-mutation)
11. [Status — `status`](#status)
12. [Workspace Analysis — `analyze`](#workspace-analysis)
13. [Planning — `plan`](#planning)
14. [Simulation — `simulate`](#simulation)
15. [Preview — `preview`](#preview)
16. [Execution — `execute`](#execution)
17. [Rollback — `rollback`](#rollback)
18. [Refactoring — `refactor`](#refactoring)
19. [Approval & Rejection — `approve` / `reject` / `policy status`](#approval--rejection)
20. [Export — `export`](#export)
21. [Audit — `audit`](#audit)
22. [Macros — `macro`](#macros)
23. [Libraries — `library` / `import`](#libraries)
24. [Abstractions](#abstractions)
25. [VS Code-Only Commands](#vs-code-only-commands)
26. [Policy & Governance Responses](#policy--governance-responses)
27. [Pipeline Errors](#pipeline-errors)

---

## Installation

### From npm

```bash
npm install -g choir-cli
```

### Local (dev) install

```bash
npm install --save-dev choir-cli
```

Then invoke via `npx choir` or add a package.json script:

```json
{
  "scripts": {
    "choir:verify": "choir verify --full",
    "choir:ci": "choir ci run"
  }
}
```

### Building from source

From the repository root:

```bash
npm run build
npm run build:cli:package
```

This compiles TypeScript, copies the `out/` artifacts into `packages/choir-cli/dist/out/`, and aligns the package version and dependency list automatically.

---

## Requirements

- **Node.js** `>= 20`
- The binary is `choir` (registered via the `bin` field in `package.json`)

---

## Workspace Convention

Most commands operate against the workspace rooted at the **current working directory** (`$PWD`). The control plane is expected at:

```
<cwd>/.choir/choir.config.yaml
```

Commands that require a control plane will fail with a JSON error envelope if this file does not exist. The exceptions are `verify` (which works without a control plane) and `ci run` (which loads the control plane itself).

Run all `choir` commands from the root of the target repository, or set `cwd` explicitly in your CI runner configuration.

---

## Output Format

All commands emit a single JSON envelope to **stdout**:

```json
{
  "ok": true,
  "command": "verify",
  "data": { ... }
}
```

On failure:

```json
{
  "ok": false,
  "command": "verify",
  "error": {
    "message": "Choir verification failed: ..."
  }
}
```

The `data` field is present on success and varies per command. The `error` field is present when `ok` is `false`. Some commands include both `data` and `error` (e.g., when a policy approval is required, the `data` contains the `pendingApprovalId`).

Parse stdout as JSON in scripts:

```bash
result=$(choir status)
ok=$(echo "$result" | jq -r '.ok')
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Command succeeded |
| `1` | Command failed, policy denied, parse error, or verification failure |

---

## Verification

Run runtime verification checks against the current workspace. Does not require a control plane.

```bash
choir verify
choir verify --quick
choir verify --contracts
choir verify --determinism
choir verify --transactions
choir verify --state
choir verify --policy
choir verify --orchestration
choir verify --production
choir verify --libraries
choir verify --compiler
choir verify --full
choir verify --property
choir verify --chaos
choir verify --chaos light
choir verify --chaos moderate
choir verify --chaos extreme
```

### Verification modes

| Flag | Description |
|------|-------------|
| _(none)_ | Standard full verification |
| `--quick` | Abbreviated check set, fastest feedback |
| `--contracts` | Contract boundary validation |
| `--determinism` | Replay and determinism counter health |
| `--transactions` | Transaction integrity checks |
| `--state` | State plane consistency checks |
| `--policy` | Policy enforcement verification |
| `--orchestration` | Orchestration execution counter health |
| `--production` | Production readiness snapshot |
| `--libraries` | Library lock and capability graph artifact checks |
| `--compiler` | Compiler pipeline integrity |
| `--full` | Full system verification (all checks) |
| `--property` | Property-based invariant checks |
| `--chaos` | Chaos injection; levels: `none`, `light`, `moderate` (default), `extreme` |

> `--chaos extreme` is intentionally source-only and does not perform injection in runtime-safe verification.

### Optional flag: `--seed`

Accepted by `--property` and `--chaos` but has no effect on runtime-safe verification paths. It is noted in the output as `ignoredSeed`.

```bash
choir verify --property --seed 42
choir verify --chaos moderate --seed 7
```

### Example output

```json
{
  "ok": true,
  "command": "verify",
  "data": {
    "mode": "quick",
    "summary": "...",
    "report": {
      "mode": "quick",
      "scope": "runtime",
      "status": "pass",
      "passed": true,
      "checks": [
        { "name": "determinism", "passed": true, "detail": "determinism counters stable" }
      ],
      "failures": []
    }
  }
}
```

Exit code is `1` when `report.status === "fail"`.

---

## CI Pipeline

Run the Choir CI pipeline. Evaluates policy, validates plans, and checks governance rules.

```bash
choir ci run
```

Loads `.choir/choir.config.yaml` from the current directory. The actor is `choir-cli` and the environment is auto-detected (`local`, `ci`, `staging`, or `production`) from environment variables.

### Example output

```json
{
  "ok": true,
  "command": "ci-run",
  "data": {
    "summary": "...",
    "result": {
      "trace": { "result": "success", ... }
    }
  }
}
```

Exit code is `1` when `result.trace.result !== "success"`.

---

## Initialization

Non-interactively synthesize or update `.choir/choir.config.yaml` using auto-discovered workspace topology and seeded strategic defaults.

> Unlike `@choir init` in VS Code, the CLI init is **fully non-interactive** — no wizard prompts, no QuickPick dialogs. Domain models are seeded from template defaults and workspace topology heuristics.

```bash
choir init
choir init --template <template>
choir init --expand-domain
choir init --reclassify
choir init --recalibrate
choir init --template backend --reclassify
```

### Flags

| Flag | Description |
|------|-------------|
| _(none)_ | Full init: discover topology, seed domain models, synthesize control plane |
| `--template <name>` | Seed strategic defaults from a named template |
| `--expand-domain` | Add newly discovered packages to existing domains without touching existing models |
| `--reclassify` | Re-derive domain classification when packages have been added or removed |
| `--recalibrate` | Recalibrate orchestration posture for existing domains; fails if the package catalog has changed |

### Available templates

| Template | Governance posture |
|---|---|
| `backend` | Moderate; phased rollout; execution-enabled |
| `frontend` | Moderate; iteration-speed focused |
| `fintech-platform` | Strict; canary + phased required; approval-required |
| `saas-product` | Moderate; phased rollout |
| `enterprise-monolith` | Strict; low risk; approval-required |
| `internal-tooling` | Relaxed; all-at-once allowed; execution-enabled |
| `experimentation-platform` | Relaxed; simulation-only; no execution |
| `distributed-platform` | Moderate; distributed-control; canary + phased required |

### Example output

```json
{
  "ok": true,
  "command": "init",
  "data": {
    "mode": "full",
    "template": "backend",
    "report": {
      "runId": "...",
      "topologyHash": "...",
      "strategicHash": "...",
      "calibrationHash": "..."
    }
  }
}
```

---

## Intent Definition

Write mission, vision, goals, constraints, or non-goals to the control plane.

```bash
choir define mission "build a deterministic delivery platform"
choir define vision "every deployment is safe, auditable, and reversible"
choir define goal "enforce service boundary contracts"
choir define constraint "no direct database access from API layer"
choir define non-goal "real-time analytics"
```

### Define types

| Type | Alias forms accepted |
|------|---------------------|
| `mission` | — |
| `vision` | — |
| `goal` | — |
| `constraint` | — |
| `non-goal` | `non`, `nongoal`, `non_goal` |

Values may be passed with or without surrounding quotes. Multi-word values without quotes are joined as a single string:

```bash
choir define goal enforce service boundary contracts
choir define goal "enforce service boundary contracts"
```

Both produce the same result.

### Policy behavior

If the control plane has a policy rule that `require-approval` or `deny` the mutation, the response will have `ok: false` and `data.decision` set accordingly. See [Policy & Governance Responses](#policy--governance-responses).

### Example output

```json
{
  "ok": true,
  "command": "define",
  "data": {
    "decision": "allow",
    "changed": true,
    "diffHash": "sha256:..."
  }
}
```

---

## Goal Mutation

Remove an existing goal from the control plane by exact text match.

```bash
choir remove goal "enforce service boundaries"
choir remove goal enforce service boundaries
```

Returns `ok: false` if the goal does not exist.

### Example output

```json
{
  "ok": true,
  "command": "remove-goal",
  "data": {
    "removed": "enforce service boundaries",
    "remainingGoals": 2
  }
}
```

---

## Status

Display a structured summary of the current control plane and state plane.

```bash
choir status
```

### Example output

```json
{
  "ok": true,
  "command": "status",
  "data": {
    "mission": "build a deterministic delivery platform",
    "vision": "every deployment is safe, auditable, and reversible",
    "intent": {
      "goals": 3,
      "constraints": 2,
      "nonGoals": 1
    },
    "plans": {
      "total": 2,
      "approved": 1
    },
    "approvals": {
      "pending": 0
    },
    "state": {
      "present": true,
      "stateHash": "sha256:..."
    }
  }
}
```

---

## Workspace Analysis

Analyze the workspace without mutating the control plane.

```bash
choir analyze workspace
choir analyze hotspots
choir analyze summary
```

| Target | Returns |
|--------|---------|
| `workspace` | Full workspace structure analysis |
| `hotspots` | Files / modules with high change frequency or complexity |
| `summary` | Both workspace and hotspot data combined |

### Example output

```json
{
  "ok": true,
  "command": "analyze",
  "data": {
    "target": "summary",
    "workspace": { ... },
    "hotspots": [ ... ]
  }
}
```

---

## Planning

Generate and manage execution plans.

### Basic plan

```bash
choir plan for "service boundary contracts"
choir plan
```

### Optimized plan

```bash
choir plan --optimize
choir plan --optimize for "service boundary contracts"
```

Runs the multi-stage optimization pipeline: evaluates multiple strategy candidates, scores against policy / risk / blast-radius / rollback complexity, and persists the best option to the control plane.

### Adaptive plan

```bash
choir plan --adaptive
choir plan --adaptive for "service boundaries"
```

Uses adaptive strategy planning with iterative mutation and memory-backed reuse.

### Approve a draft plan

```bash
choir plan approve <planId>
```

Transitions a draft plan to approved status.

### Example output (optimized)

```json
{
  "ok": true,
  "command": "plan",
  "data": {
    "optimize": true,
    "selectedPlan": "plan-abc123",
    "persistedPlan": "plan-abc123",
    "strategyId": "low-risk-phased",
    "planHash": "sha256:...",
    "simulationHash": "sha256:...",
    "runtime": { ... }
  }
}
```

---

## Simulation

Dry-run an execution plan. No state is persisted.

```bash
choir simulate
choir simulate plan <planId>
choir simulate units <unitId>,<unitId2>
```

### Example output

```json
{
  "ok": true,
  "command": "simulate",
  "data": {
    "runtime": { ... }
  }
}
```

The `runtime` object contains strategy, plan source, changed units, violations, policy decision, replay hashes, and rollback scope.

---

## Preview

Synthesize a read-only execution contract: runs the plan in simulation mode, generates file diffs, and records a `previewHash`.

```bash
choir preview
choir preview plan <planId>
```

The preview is persisted to the state plane and a pending approval is recorded when the runtime mode requires it.

### Example output

```json
{
  "ok": true,
  "command": "preview",
  "data": {
    "runtime": {
      "preview": {
        "previewHash": "sha256:...",
        "simulationHash": "sha256:...",
        "stateHash": "sha256:...",
        "fileChanges": [ ... ],
        "summary": { "filesChanged": 3, "patchesCount": 5, "remainingViolations": 0 }
      },
      "policy": { "decision": "allow", "violations": [] },
      "approval": { "required": false }
    }
  }
}
```

---

## Execution

Execute the current approved plan against the workspace.

```bash
choir execute
choir execute plan <planId>
choir execute --preview <previewId>
```

### Rollout strategies

```bash
choir execute --strategy all-at-once
choir execute --strategy canary --steps 1,10,25,100
choir execute --strategy phased --phases 1,2,3
choir execute --strategy batched --batch-size 2
```

| Strategy | Description |
|----------|-------------|
| `all-at-once` | Deploy all units simultaneously |
| `canary` | Progressive traffic steps (e.g., 1%, 10%, 25%, 100%) |
| `phased` | Explicit phase gates |
| `batched` | Fixed-size batches processed sequentially |

### Example output

```json
{
  "ok": true,
  "command": "execute",
  "data": {
    "runtime": {
      "execute": {
        "success": true,
        "planId": "plan-abc123",
        "rolloutStrategy": "canary",
        "transactionId": "txn-...",
        "executionHash": "sha256:...",
        "finalStateHash": "sha256:..."
      }
    }
  }
}
```

Exit code is `1` when `runtime.execute.success` is falsy.

---

## Rollback

Revert to a deterministic prior state.

```bash
choir rollback
choir rollback <unitId>
choir rollback --stage <stageId>
```

| Form | Behavior |
|------|----------|
| `choir rollback` | Auto-selects the last deployed unit |
| `choir rollback <unitId>` | Rolls back a specific workspace unit |
| `choir rollback --stage <stageId>` | Rolls back all units in an execution stage |

Rollback resolves the previous state transition deterministically. If no prior transition exists, it returns `ok: false`.

### Example output

```json
{
  "ok": true,
  "command": "rollback",
  "data": {
    "selector": "auto",
    "stateHashBefore": "sha256:...",
    "stateHashAfter": "sha256:...",
    "sourceTransitionId": "transition-..."
  }
}
```

---

## Refactoring

Perform governed code refactoring operations. All operations produce a preview, validate policy, and execute if validation passes.

### Rename

```bash
choir refactor rename MyService UserService
choir refactor rename MyService UserService --declaration "src/services/my-service.ts:10:14"
```

The `--declaration` flag pins to a specific location (`file:line:character`, 1-based) to resolve ambiguous or overloaded symbols. If a single declaration exists in the specified file, `file` alone is sufficient; if multiple declarations exist in that file, `file:line:character` is required.

### Move

```bash
choir refactor move MyService users
choir refactor move MyService --file "src/modules/users/service.ts"
```

> **Note:** File paths for `--file` must use the `--file "path"` form. A bare path with `/` characters is not a valid identifier token in the DSL lexer.

### Extract

```bash
choir refactor extract processPayment payments
choir refactor extract processPayment --file "src/payments/processor.ts"
```

Copies the implementation to the target and replaces the source with a delegating import wrapper (`__choirExtract_<symbol>`). Node16/NodeNext explicit `.js` extensions are generated automatically.

### Inline

```bash
choir refactor inline processPayment
```

### Example output

```json
{
  "ok": true,
  "command": "refactor-rename",
  "data": {
    "impact": {
      "affectedUnits": ["packages/api"],
      "affectedFiles": ["src/services/user-service.ts", "src/index.ts"]
    },
    "preview": {
      "hash": "sha256:...",
      "changes": [ { "file": "...", "diff": "..." } ]
    },
    "simulation": {
      "validation": { "passed": true, "policy": { "violations": [] } }
    },
    "execution": {
      "committed": true,
      "snapshotId": "snapshot-..."
    }
  }
}
```

Exit code is `1` when `simulation.validation.passed` is `false`.

---

## Approval & Rejection

### View pending approvals

```bash
choir policy status
```

Returns all pending approval IDs and the commands that triggered them.

### Approve a pending diff

```bash
choir approve <diffId>
```

Marks the pending diff as approved. **Re-run the original command** to apply the now-approved mutation.

### Reject a pending diff

```bash
choir reject <diffId>
```

Permanently discards the pending diff.

### Example output (approve)

```json
{
  "ok": true,
  "command": "approve",
  "data": {
    "approved": true,
    "diffHash": "sha256:..."
  }
}
```

---

## Export

### DSL export

Exports the control plane as a Choir DSL file.

```bash
choir export dsl
choir export dsl all
choir export dsl intent
choir export dsl policy
choir export dsl plans
```

| Section | Output file | Contents |
|---------|-------------|---------|
| `all` (default) | `.choir/choir.dsl` | Complete DSL |
| `intent` | `.choir/choir.intent.dsl` | Mission, vision, goals, constraints, non-goals |
| `policy` | `.choir/choir.policy.dsl` | Policy rules |
| `plans` | `.choir/choir.plans.dsl` | Execution plans |

### JSON export

Exports the control plane as a JSON file.

```bash
choir export --format json
```

Writes to `.choir/choir.config.json`. Only `json` is supported; other formats return a parse error.

### Example output (DSL)

```json
{
  "ok": true,
  "command": "export-dsl",
  "data": {
    "section": "all",
    "outputPath": ".choir/choir.dsl",
    "generatedCommands": 8,
    "warnings": [],
    "dsl": "choir define mission \"...\"\nchoir define goal \"...\"\n..."
  }
}
```

---

## Audit

### Tail the full audit log

```bash
choir audit log
```

Returns all audit records. The log is the append-only JSONL file at `.choir/audit.log.jsonl`.

### Query the audit log

```bash
choir audit query role=architect
choir audit query environment=production
choir audit query action=compile-dsl
choir audit query role=conductor,environment=ci
choir audit query from="2024-01-01" to="2024-12-31"
```

Filters can be combined with commas. `from` and `to` must always be provided together.

| Filter | Valid values |
|--------|-------------|
| `role` | `architect`, `analyst`, `conductor`, `enforcer` |
| `environment` | `local`, `ci`, `staging`, `production` |
| `action` | any action string (e.g., `compile-dsl`, `policy-evaluation`) |
| `from` / `to` | ISO date strings |

### Generate a compliance report

```bash
choir audit report
```

Writes three report artifacts and returns summary statistics:

```
.choir/reports/compliance-report.json
.choir/reports/compliance-report.yaml
.choir/reports/compliance-report.pdf
```

### Example output (query)

```json
{
  "ok": true,
  "command": "audit-query",
  "data": {
    "total": 3,
    "records": [ ... ]
  }
}
```

---

## Macros

### List macros

```bash
choir macro list
```

Lists all macros from installed libraries and local `.choir/macros.yaml`.

### Inspect a macro

```bash
choir macro show <macroId>
choir macro show architecture.hexagonal
```

Returns version, description, parameters (with defaults and required flags), and the command body.

### Run a macro

```bash
choir macro <macroId> key="value",key2="value2"
choir macro bootstrap-service name="user-service"
```

Expands the macro body with the supplied arguments and executes each resulting DSL command. The output includes per-step decision, diff hash, and any pending approval IDs.

### Example output (run)

```json
{
  "ok": true,
  "command": "macro-run",
  "data": {
    "decision": "allow",
    "trace": {
      "abstractionId": "bootstrap-service",
      "expandedCommands": ["choir define goal \"...\"", "choir plan"],
      "executedSteps": 2
    },
    "steps": [ ... ]
  }
}
```

Exit code is `1` when the macro is blocked by policy (`deny` or `require-approval`).

---

## Libraries

### Import a library (shorthand)

```bash
choir import core@1.0.x
choir import refactoring@2.x
```

Registers and resolves the library. Version selectors support exact (`1.0.0`), minor wildcard (`1.0.x`), and major wildcard (`1.x`).

### Install a library

```bash
choir library install core@1.0.0
```

Installs into `.choir/libraries/<lib>/` and writes to `choir.lock`.

### Update a library

```bash
choir library update core
```

Resolves the latest compatible version and updates the lockfile.

### Lock all libraries

```bash
choir library lock
```

Refreshes `choir.lock` for all installed libraries.

### List available libraries

```bash
choir library list
```

Lists all libraries under `.choir/libraries/` with their versions, selectors, capability count, compatibility, and lock status.

> `import`, `library install`, and `library update` are gated by the runtime governance capability check. Responses will have `ok: false` and a `runtime-governance:` message if the workspace mode disallows these capabilities.

---

## Abstractions

Abstractions are named multi-step command sequences defined in `.choir/abstractions.yaml`.

### List abstractions

```bash
choir abstraction list
```

### Describe an abstraction

```bash
choir abstraction describe <id>
choir abstraction describe enforce-hexagonal-architecture
```

### Run an abstraction

Abstractions are invoked directly using the DSL:

```bash
choir enforce-hexagonal-architecture
choir bootstrap-service name="user-service"
```

Arguments are passed as comma-separated `key="value"` pairs.

### Built-in abstractions

| ID | Description |
|----|-------------|
| `enforce-hexagonal-architecture` | Applies hexagonal architecture guardrails, generates a plan, and runs a preview |
| `migrate-to-service-layer` | Migrates modules to service-layer boundaries and generates a plan |

### Example output (list)

```json
{
  "ok": true,
  "command": "abstraction-list",
  "data": {
    "abstractions": [
      {
        "id": "enforce-hexagonal-architecture",
        "version": "1.0.0",
        "description": "Apply hexagonal architecture guardrails...",
        "parameters": [],
        "expandsTo": ["choir macro architecture.hexagonal", "choir plan", "choir preview"]
      }
    ]
  }
}
```

---

## VS Code-Only Commands

The following commands are available in the `@choir` VS Code chat participant but are **not** available in `choir-cli`:

| Command | Reason |
|---------|--------|
| `graph` / `graph focus` / `graph dependencies` / `graph dependents` | Requires the VS Code webview panel |
| `@choir control` | Opens a VS Code panel |
| `@choir timeline` | Opens a VS Code panel |
| `@choir cli install` | VS Code terminal wizard |
| `@choir init` (interactive wizard) | Requires VS Code QuickPick and InputBox dialogs |

Attempting to pass `control`, `timeline`, or `diagnostics` as a command returns:

```json
{
  "ok": false,
  "command": "parse",
  "error": {
    "message": "VS Code-only chat shortcuts are not available in choir-cli."
  }
}
```

---

## Policy & Governance Responses

Every mutating command is evaluated by the policy engine before any write. Three outcomes are possible:

### Allow

The control plane is updated and `ok: true` is returned with `data.decision = "allow"`.

### Require Approval

```json
{
  "ok": false,
  "command": "define",
  "data": {
    "decision": "require-approval",
    "diffHash": "sha256:...",
    "pendingApprovalId": "pending-abc123"
  },
  "error": {
    "message": "Policy approval is required before mutation can be applied."
  }
}
```

After approving the diff:

```bash
choir approve pending-abc123
# then re-run the original command
choir define goal "new goal"
```

### Deny

```json
{
  "ok": false,
  "command": "define",
  "data": {
    "decision": "deny",
    "diffHash": "sha256:...",
    "violations": [
      { "ruleId": "no-execution-in-production", "message": "..." }
    ]
  },
  "error": {
    "message": "Policy denied control-plane mutation."
  }
}
```

Exit code is `1` for both `require-approval` and `deny`.

---

## Pipeline Errors

If a command fails inside a multi-stage orchestration pipeline (optimize, simulate, preview, execute), the error envelope includes stage-level diagnostics:

```json
{
  "ok": false,
  "command": "execute",
  "error": {
    "message": "Pipeline failed at stage policy-evaluation: ..."
  },
  "data": {
    "stageResults": [
      { "stage": "plan-resolution", "status": "success", "detail": "..." },
      { "stage": "policy-evaluation", "status": "failure", "detail": "..." }
    ]
  }
}
```

Exit code is always `1` for pipeline errors.

---

## Quick Reference

```
choir verify [--quick|--contracts|--determinism|--transactions|--state|
             --policy|--orchestration|--production|--libraries|--compiler|
             --full|--property|--chaos [none|light|moderate|extreme]] [--seed <n>]

choir ci run

choir init [--template <name>] [--expand-domain|--reclassify|--recalibrate]

choir define mission|vision|goal|constraint|non-goal "value"
choir remove goal "value"

choir status
choir policy status
choir approve <diffId>
choir reject <diffId>

choir analyze workspace|hotspots|summary

choir plan [for "goal"] [--optimize] [--adaptive]
choir plan approve <planId>

choir simulate [plan <planId>] [units <id>,<id>]
choir preview [plan <planId>]

choir execute [plan <planId>] [--preview <id>]
             [--strategy all-at-once|canary|phased|batched]
             [--steps 1,10,25,100] [--phases 1,2,3] [--batch-size 2]

choir rollback [<unitId>] [--stage <stageId>]

choir refactor rename <symbol> <newName> [--declaration "file:line:char"]
choir refactor move <symbol> (<targetUnit> | --file "path")
choir refactor extract <symbol> (<targetUnit> | --file "path")
choir refactor inline <symbol>

choir export dsl [all|intent|policy|plans]
choir export --format json

choir audit log
choir audit query [role=... environment=... action=... from=... to=...]
choir audit report

choir macro list
choir macro show <macroId>
choir macro <macroId> [key="value",...]

choir import <lib>@<version>
choir library list
choir library install <lib>@<version>
choir library update <lib>
choir library lock

choir abstraction list
choir abstraction describe <id>
choir <abstractionId> [key="value",...]
```
