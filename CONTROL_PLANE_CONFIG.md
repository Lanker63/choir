# Control Plane Configuration Guide

This document exists only to describe manual configuration of `.choir/choir.config.yaml` for human authors.

It is based on the authoritative runtime schema in `src/schema.ts` and related registry/runtime behavior.

## 1. File Location

- Expected path: `.choir/choir.config.yaml`
- YAML must parse cleanly.
- Unknown keys in strict objects are rejected.

## 2. Top-Level Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `version` | string | Yes | Current project constant is `1.0.0`. |
| `registries` | string[] | No | Library registry sources. |
| `mission` | string | No | Defaults to empty string when omitted. |
| `vision` | string | No | Defaults to empty string when omitted. |
| `intent` | object | Yes | Human intent contract. |
| `strategicIntent` | object | No | Global strategic posture. Disallowed when `packageModes` is non-empty. |
| `domains` | map | No | Named domain strategic blocks (optional manual catalog). |
| `packages` | map | No | Package-level mapping/intent. |
| `contexts` | map | No | Context-level package groupings/intent. |
| `policy` | object | Yes | Rule list and optional priority overrides. |
| `execution` | object | No | Defaults to `{ plans: [] }`. |
| `runtime` | object | No | Global runtime mode. Disallowed when `packageModes` is non-empty. |
| `capabilities` | object | No | Global capability overrides (may still be used as baseline with `packageModes`). |
| `packageModes` | map | No | Per-package runtime/capability overrides. |

Important scope note:

- Strategic init persistence is scope-dependent. In rooted workspaces, init persists global `runtime` + `capabilities`. In rootless/package-governed workspaces, init persists `packageModes` and omits global `runtime`/`capabilities`.
- Strategic init uses `packages` as canonical strategic persistence and does not persist a duplicate top-level `domains` catalog by default.
- The schema still supports top-level `domains` and top-level `strategicIntent` for manual authoring scenarios that do not use `packageModes`.

## 3. Enumerated Values

### 3.1 Runtime Modes

```yaml
observe-only
simulation-only
approval-required
execution-enabled
distributed-control
```

### 3.2 Capability Keys

```yaml
preview
simulate
execute
optimize
import
install
update
```

### 3.3 Strategic Priority

```yaml
correctness
auditability
rollback-safety
minimal-blast-radius
deterministic-replay
iteration-speed
developer-autonomy
dependency-safety
stability
```

### 3.4 Optimization Goal

```yaml
minimal-blast-radius
deterministic-replay
rapid-delivery
low-governance-friction
dependency-isolation
rollback-minimized
parallel-throughput
```

### 3.5 Risk Tolerance

```yaml
low
moderate
high
```

### 3.6 Architectural Posture

```yaml
conservative
highly-reviewed
exploratory
adaptive
strict-boundaries
performance-optimized
```

### 3.7 Rollout Preference

```yaml
canary-required
phased-required
phased-optional
all-at-once-allowed
parallel-optimized
```

### 3.8 Stability Profile

```yaml
stable
adaptive
experimental
```

### 3.9 Governance Intensity

```yaml
strict
moderate
relaxed
```

### 3.10 Plan Fields

`execution.plans[].derivedFrom`:

```yaml
goal
constraint
manual
```

`execution.plans[].status`:

```yaml
draft
approved
```

### 3.11 Task Type

```yaml
analysis
refactor
create
delete
enforce
generate-typescript-module
generate-api-route
generate-model
generate-controller
generate-tests
generate-config
apply-ast-patch
create-directory
create-project-structure
```

### 3.12 Policy Rule Fields

`policy.rules[].constraint.type`:

```yaml
forbid
require
```

`policy.rules[].severity`:

```yaml
error
warning
info
hint
```

## 4. Field Shapes

### 4.1 `intent`

```yaml
intent:
  goals: []
  constraints: []
  non-goals: []
```

Notes:

- `non-goals` uses a hyphen in the key name.
- Each array item is a string.

### 4.2 `strategicIntent`

```yaml
strategicIntent:
  mission: "Optional mission text"
  priorities: []
  optimizationGoals: []
  riskTolerance: moderate
  architecturalPosture: []
  rolloutPreferences: []
  stabilityProfile: adaptive
  governanceIntensity: moderate
```

All keys are optional inside `strategicIntent`, but values must match enums where applicable.

### 4.3 `domains`

```yaml
domains:
  payments:
    mission: "Owns payment correctness"
    strategicIntent:
      priorities:
        - correctness
```

Domain key is free-form non-empty string.

### 4.4 `packages`

```yaml
packages:
  packages/payments:
    domain: payments
    strategicIntent:
      riskTolerance: low
```

Notes:

- Package key is a non-empty string (typically workspace-relative package path/id).
- `domain` is optional.
- `strategicIntent` is optional.

### 4.5 `contexts`

```yaml
contexts:
  checkout-flow:
    domain: payments
    packages:
      - packages/payments
      - packages/orders
    strategicIntent:
      rolloutPreferences:
        - canary-required
```

### 4.6 `policy`

```yaml
policy:
  rules:
    - id: no-direct-fs
      description: "Disallow direct fs imports"
      priority: 10
      appliesTo:
        files:
          - "src/**/*.ts"
        language: "typescript"
      match:
        imports:
          - "fs"
        callExpressions:
          - "fs.readFileSync"
        functionNames:
          - "readFileSync"
      constraint:
        type: forbid
      message: "Use abstraction instead of direct fs usage"
      severity: error
  priorityOverrides:
    AST: 100
    semantic: 90
    strategy: 80
    pattern: 70
```

`priorityOverrides` is optional and each value must be a finite number.

### 4.7 `execution`

```yaml
execution:
  plans:
    - id: plan-001
      title: "Harden payments path"
      description: "Optional"
      derivedFrom: goal
      goalRefs:
        - "Increase reliability"
      status: draft
      tasks:
        - id: task-001
          title: "Add contract checks"
          description: "Optional"
          type: analysis
          scope:
            files:
              - "src/payments/**/*.ts"
            modules:
              - "payments"
          dependsOn: []
          successCriteria:
            - "No regressions"
```

Task requirements:

- `id`, `title`, `type`, `successCriteria` are required.
- `successCriteria` must have at least one string.

### 4.8 `runtime` and `capabilities`

```yaml
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

Mode default capabilities before overrides:

```yaml
observe-only:
  preview: true
  simulate: true
  execute: false
  optimize: true
  import: true
  install: false
  update: false

simulation-only:
  preview: true
  simulate: true
  execute: false
  optimize: true
  import: true
  install: false
  update: false

approval-required:
  preview: true
  simulate: true
  execute: true
  optimize: true
  import: true
  install: true
  update: true

execution-enabled:
  preview: true
  simulate: true
  execute: true
  optimize: true
  import: true
  install: true
  update: true

distributed-control:
  preview: true
  simulate: true
  execute: true
  optimize: true
  import: true
  install: true
  update: true
```

### 4.9 `packageModes`

```yaml
packageModes:
  packages/payments:
    mode: approval-required
    capabilities:
      execute: true
      install: false
  packages/playground:
    mode: execution-enabled
```

Per-package entry must define at least one of:

- `mode`
- `capabilities`

## 5. Registry Configuration (`registries`)

`registries` is an ordered list that is normalized deterministically.

Supported entry styles:

```yaml
registries:
  - local
  - org
  - file:.choir/custom-registry
  - /absolute/path/to/registry
  - relative/path/to/registry
```

Resolution behavior:

- `local` and `org` map to `.choir/registry/local` and `.choir/registry/org`.
- `file:<path>` supports absolute or workspace-relative path.
- Any other entry is treated as path (absolute or workspace-relative).
- If omitted or empty, runtime defaults to `local`.

## 6. Cross-Field Validation Rules

### 6.1 Runtime/Package Mode Exclusivity

Invalid:

- `runtime` with non-empty `packageModes`

### 6.2 Strategic Intent/Package Mode Exclusivity

Invalid:

- global `strategicIntent` with non-empty `packageModes`

### 6.3 Domain References

If `domains` is non-empty:

- `packages.*.domain` must reference an existing key in `domains`.
- `contexts.*.domain` must reference an existing key in `domains`.

### 6.4 Context Package References

- Every package listed in `contexts.*.packages` must exist in top-level `packages`.

### 6.5 Plan Integrity

Invalid:

- duplicate `execution.plans[].id`
- duplicate task id inside one plan
- task depending on itself
- task dependency on unknown task id
- circular task dependency graph

## 7. Recommended Authoring Patterns

### 7.1 Rooted Workspace (single global runtime)

```yaml
runtime:
  mode: approval-required
capabilities:
  preview: true
  simulate: true
  execute: true
  optimize: true
  import: true
  install: true
  update: true
```

Do not set `packageModes` in the same file when using global runtime.

### 7.2 Package-Governed Workspace

```yaml
packageModes:
  packages/payments:
    mode: approval-required
  packages/sandbox:
    mode: execution-enabled
```

When using `packageModes`, do not define global `runtime` and do not define global `strategicIntent`.
Global `capabilities` remains allowed and acts as a baseline capability override.

## 8. Full Exhaustive Example

```yaml
version: "1.0.0"
registries:
  - local
  - org

mission: "Deterministic platform governance"
vision: "Safe, explainable autonomous delivery"

intent:
  goals:
    - "Minimize rollback risk"
  constraints:
    - "No uncontrolled production changes"
  non-goals:
    - "Prioritize speed over safety"

strategicIntent:
  mission: "Global platform guardrails"
  priorities:
    - correctness
    - dependency-safety
  optimizationGoals:
    - deterministic-replay
  riskTolerance: low
  architecturalPosture:
    - conservative
    - highly-reviewed
  rolloutPreferences:
    - canary-required
  stabilityProfile: stable
  governanceIntensity: strict

domains:
  payments:
    mission: "Financial correctness"
    strategicIntent:
      priorities:
        - correctness
      riskTolerance: low

packages:
  packages/payments:
    domain: payments
    strategicIntent:
      architecturalPosture:
        - strict-boundaries
  packages/playground:
    strategicIntent:
      architecturalPosture:
        - exploratory
      riskTolerance: high

contexts:
  checkout:
    domain: payments
    packages:
      - packages/payments
    strategicIntent:
      rolloutPreferences:
        - canary-required

policy:
  rules:
    - id: no-direct-fs
      match:
        imports:
          - fs
      constraint:
        type: forbid
      message: "Disallow direct fs import"
      severity: error
  priorityOverrides:
    AST: 100
    semantic: 90

execution:
  plans:
    - id: plan-payments-hardening
      title: "Payments hardening"
      derivedFrom: goal
      goalRefs:
        - "Minimize rollback risk"
      status: draft
      tasks:
        - id: task-analysis
          title: "Analyze critical path"
          type: analysis
          dependsOn: []
          successCriteria:
            - "Critical path analyzed"

runtime:
  mode: approval-required
capabilities:
  preview: true
  simulate: true
  execute: true
  optimize: true
  import: true
  install: true
  update: true
```

Note: The exhaustive example above uses global runtime mode. If you switch to `packageModes`, remove global `runtime` and global `strategicIntent` to remain schema-valid.
