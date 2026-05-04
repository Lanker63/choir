# Choir Design Guidelines (Revised)

Choir is a VSCode extension that enables structured, policy-driven management of a workspace through a formal enforcement pipeline. It exposes chat participants that allow users to define strategy and constraints, which are compiled into enforceable rules applied to the codebase.

---

# Core System Model

## Three-Plane Architecture

### 1. Control Plane (Authoritative Source of Truth)
- Format: YAML
- Owned by: User (via Architect)
- Defines:
  - Intent
  - Constraints
  - Policies
- Properties:
  - Versioned
  - Deterministic
  - Immutable input to enforcement

> Chat must compile into YAML. YAML is the only source of truth.

---

### 2. State Plane (Derived, Reproducible)
- Format: JSON
- Owned by: System (Enforcer)
- Contains:
  - AST indexes
  - Symbol graphs
  - Violations
  - Metrics
  - Dependency graph
- Properties:
  - Fully reproducible from (workspace + YAML)
  - No user edits

---

### 3. Interaction Plane (Ephemeral Interface)
- Format: Chat
- Owned by: User + Agents
- Used for:
  - Authoring intent
  - Triggering analysis
  - Explaining results

> Chat is not state. It is a compiler interface into the control plane.

---

# System Contract

```yaml
YAML  = intent + constraints + policy
JSON  = facts + computed state
Chat  = interface (non-authoritative)