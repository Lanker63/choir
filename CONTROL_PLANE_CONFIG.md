# Control Plane Configuration Guide

This document exists only to describe manual configuration of .choir/choir.config.yaml for human authors.

It is based on the authoritative runtime schema in src/schema.ts and related runtime behavior.

## 1. File Location

- Expected path: .choir/choir.config.yaml
- YAML must parse cleanly.
- Unknown keys in strict objects are rejected.

## 2. Top-Level Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| version | string | Yes | Current project constant is 1.0.0. |
| registries | string[] | No | Library registry sources. |
| mission | string | No | Defaults to empty string when omitted. |
| vision | string | No | Defaults to empty string when omitted. |
| intent | object | Yes | Human intent contract. |
| domains | map | No | Named domain strategic blocks. |
| packages | map | No | Package-level mapping and strategic intent. |
| contexts | map | No | Context-level package groupings and strategic intent. |
| policy | object | Yes | Rule list and optional priority overrides. |
| execution | object | No | Defaults to plans: []. |
| runtime | object | No | Global runtime mode. |
| capabilities | object | No | Global capability overrides. |
| packageModes | map | No | Per-package runtime and capability overrides. |

Important scope note:

- Strategic intent is now modeled at domain, package, and context scopes.
- Top-level strategicIntent is not part of the current control-plane schema.
- Global runtime and packageModes are mutually exclusive.

## 3. Enumerated Values and Meanings

### 3.1 Runtime Modes

| Value | Meaning |
|---|---|
| observe-only | Read and simulate posture. Execution is denied by default capabilities. |
| simulation-only | Similar to observe-only for capability defaults; intended for non-mutating evaluation flow. |
| approval-required | Execution-capable posture where execute requires approval gating. |
| execution-enabled | Execution-capable posture without mandatory runtime approval gate. |
| distributed-control | Execution-capable posture intended for broader multi-unit or federated control scenarios. |

### 3.2 Capability Keys

| Value | Meaning |
|---|---|
| preview | Controls whether preview pipeline operations are allowed. |
| simulate | Controls whether simulation operations are allowed. |
| execute | Controls whether execute operations are allowed. |
| optimize | Controls whether planning optimization operations are allowed. |
| import | Controls whether library import operations are allowed. |
| install | Controls whether library install/materialization operations are allowed. |
| update | Controls whether library update operations are allowed. |

### 3.3 Strategic Priority

| Value | Meaning |
|---|---|
| correctness | Prefer semantically correct and safe outcomes over speed. |
| auditability | Prefer traceable, reviewable, compliance-friendly changes. |
| rollback-safety | Prefer changes that are easy and safe to roll back. |
| minimal-blast-radius | Prefer smallest affected surface area per change. |
| deterministic-replay | Prefer reproducible outcomes and stable replay lineage. |
| iteration-speed | Prefer faster delivery loops. |
| developer-autonomy | Prefer lower friction for independent engineering flow. |
| dependency-safety | Prefer stable dependency boundaries and reduced coupling risk. |
| stability | Prefer runtime and operational steadiness over aggressive change. |

### 3.4 Optimization Goal

| Value | Meaning |
|---|---|
| minimal-blast-radius | Optimize for smallest changed footprint. |
| deterministic-replay | Optimize for replay and reproducibility guarantees. |
| rapid-delivery | Optimize for delivery speed and throughput. |
| low-governance-friction | Optimize for reduced process overhead. |
| dependency-isolation | Optimize for stronger isolation across dependency boundaries. |
| rollback-minimized | Optimize to reduce rollback probability and rollback scope. |
| parallel-throughput | Optimize for safe parallelism and multi-unit throughput. |

### 3.5 Risk Tolerance

| Value | Meaning |
|---|---|
| low | Conservative risk posture. |
| moderate | Balanced risk posture. |
| high | Aggressive risk posture. |

### 3.6 Architectural Posture

| Value | Meaning |
|---|---|
| conservative | Favor low-risk, conservative architectural change. |
| highly-reviewed | Favor heavily reviewed and tightly governed change paths. |
| exploratory | Favor experimentation and discovery-oriented architecture work. |
| adaptive | Favor flexible architecture that can evolve incrementally. |
| strict-boundaries | Favor strong boundaries between components and domains. |
| performance-optimized | Favor architecture choices that prioritize performance characteristics. |

### 3.7 Rollout Preference

| Value | Meaning |
|---|---|
| canary-required | Require canary rollout behavior for applicable changes. |
| phased-required | Require phased/staged rollout behavior. |
| phased-optional | Prefer phased rollout but do not strictly require it. |
| all-at-once-allowed | Allow all-at-once rollout where policy/runtime permits. |
| parallel-optimized | Prefer rollout patterns that maximize safe parallel progression. |

### 3.8 Stability Profile

| Value | Meaning |
|---|---|
| stable | Favor stability-first operational posture. |
| adaptive | Favor balanced stability with controlled adaptation. |
| experimental | Favor experimentation-oriented operational posture. |

### 3.9 Governance Intensity

| Value | Meaning |
|---|---|
| strict | High-governance and high-control posture. |
| moderate | Balanced governance posture. |
| relaxed | Lower-governance posture for faster iteration. |

### 3.10 Plan Fields

execution.plans[].derivedFrom:

| Value | Meaning |
|---|---|
| goal | Plan derived from one or more goals. |
| constraint | Plan derived from constraint-driven remediation or safety needs. |
| manual | Plan authored directly by operator intent. |

execution.plans[].status:

| Value | Meaning |
|---|---|
| draft | Candidate plan not yet approved for enforced execution flow. |
| approved | Plan approved for execution path usage. |

### 3.11 Task Type

| Value | Meaning |
|---|---|
| analysis | Non-mutating analysis task. |
| refactor | Refactor-oriented mutation task. |
| create | File/unit creation task. |
| delete | File/unit deletion task. |
| enforce | Enforcement/remediation task. |
| generate-typescript-module | Generate TypeScript module artifact. |
| generate-api-route | Generate API route artifact. |
| generate-model | Generate model artifact. |
| generate-controller | Generate controller artifact. |
| generate-tests | Generate test artifacts. |
| generate-config | Generate configuration artifacts. |
| apply-ast-patch | Apply AST-level patch operation. |
| create-directory | Create directory structure node(s). |
| create-project-structure | Create broader project scaffold structure. |

### 3.12 Policy Rule Fields

policy.rules[].constraint.type:

| Value | Meaning |
|---|---|
| forbid | Rule enforces disallowed pattern/behavior. |
| require | Rule enforces required pattern/behavior. |

policy.rules[].severity:

| Value | Meaning |
|---|---|
| error | Blocking/high-severity diagnostic. |
| warning | Non-blocking warning-level diagnostic. |
| info | Informational diagnostic. |
| hint | Low-severity hint diagnostic. |

## 4. Field Shapes

### 4.1 intent

```yaml
intent:
  goals: []
  constraints: []
  nonGoals: []
```

Notes:

- nonGoals uses a hyphen in the key name.
- Each array item is a string.

### 4.2 Strategic Intent Block (used under domains, packages, contexts)

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

All keys are optional inside strategicIntent, but values must match enums where applicable.

### 4.3 domains

```yaml
domains:
  payments:
    mission: "Owns payment correctness"
    strategicIntent:
      priorities:
        - correctness
```

Domain key is a free-form non-empty string.

### 4.4 packages

```yaml
packages:
  packages/payments:
    domain: payments
    strategicIntent:
      riskTolerance: low
```

Notes:

- Package key is a non-empty string (typically workspace-relative package path/id).
- domain is optional.
- strategicIntent is optional.

### 4.5 contexts

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

### 4.6 policy

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

priorityOverrides is optional and each value must be a finite number.

### 4.7 execution

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

- id, title, type, successCriteria are required.
- successCriteria must have at least one string.

### 4.8 runtime and capabilities

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

### 4.9 packageModes

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

- mode
- capabilities

## 5. Registry Configuration (registries)

registries is an ordered list that is normalized deterministically.

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

- local and org map to .choir/registry/local and .choir/registry/org.
- file:<path> supports absolute or workspace-relative path.
- Any other entry is treated as path (absolute or workspace-relative).
- If omitted or empty, runtime defaults to local.

## 6. Cross-Field Validation Rules

### 6.1 Runtime and Package Mode Exclusivity

Invalid:

- runtime with non-empty packageModes

### 6.2 Domain References

If domains is non-empty:

- packages.*.domain must reference an existing key in domains.
- contexts.*.domain must reference an existing key in domains.

### 6.3 Context Package References

- Every package listed in contexts.*.packages must exist in top-level packages.

### 6.4 packageModes Entry Shape

Invalid:

- packageModes.<pkg> entries that define neither mode nor capabilities.

### 6.5 Plan Integrity

Invalid:

- duplicate execution.plans[].id
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

Do not set packageModes in the same file when using global runtime.

### 7.2 Package-Governed Workspace

```yaml
capabilities:
  preview: true
  simulate: true
  execute: true
  optimize: true
  import: true
  install: true
  update: true

packageModes:
  packages/payments:
    mode: approval-required
  packages/sandbox:
    mode: execution-enabled
```

When using packageModes, do not define global runtime.
Global capabilities remain allowed and act as baseline capability overrides.

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
  nonGoals:
    - "Prioritize speed over safety"

domains:
  payments:
    mission: "Financial correctness"
    strategicIntent:
      mission: "High-assurance payment domain"
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

Note: The exhaustive example above uses global runtime mode. If you switch to packageModes, remove global runtime to remain schema-valid.
