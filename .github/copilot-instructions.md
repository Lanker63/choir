# Choir — Copilot Agent Instructions

## Design Guidelines: Read Before Acting

Before making any design decision, architectural choice, or behavioral contract change in this repository, read the full contents of [`DESIGN_GUIDELINES.md`](../DESIGN_GUIDELINES.md) into context.

This applies to:
- Adding or modifying DSL commands, grammar, or parser logic
- Changing control-plane, state-plane, or interaction-plane behavior
- Modifying execution, simulation, preview, rollback, or refactor flows
- Adding or changing policy evaluation, approval, or audit logic
- Changing runtime governance, capability gates, or library distribution
- Adding or modifying orchestration, planning, or strategy selection
- Modifying strategic init, domain modeling, or template catalog logic
- Adding new canonical artifacts, output formats, or surface contracts
- Changing webview sync, panel behavior, or UI projection logic
- Writing or modifying tests that exercise any of the above

DESIGN_GUIDELINES.md is the authoritative source of truth for system contracts. Conflicting implementation choices must be reconciled against it, not the other way around.

## Memory: Do Not Store Design Guidelines

Do **not** store design guidelines, architectural contracts, or system behavioral rules in any memory file (`/memories/`, `/memories/repo/`, or `/memories/session/`).

Specifically prohibited from memory storage:
- Any rule, constraint, or contract that already exists in `DESIGN_GUIDELINES.md`
- Summaries or paraphrases of sections from `DESIGN_GUIDELINES.md`
- Architectural decisions that belong in `DESIGN_GUIDELINES.md` rather than a memory note

When a session produces a new design rule or behavioral contract that is not yet in `DESIGN_GUIDELINES.md`, the correct action is to **update `DESIGN_GUIDELINES.md` directly**, not to store it in memory.

Memory files are for:
- Verified build commands, tool invocations, and environment-specific facts
- Codebase navigation shortcuts (e.g., which file owns a given feature)
- Observed bugs and their root causes (short, factual, non-prescriptive)
- User preferences for this workspace that are not design contracts

## Source-of-Truth Hierarchy

```
DESIGN_GUIDELINES.md          ← system contracts and behavioral rules
src/                          ← implementation (must conform to guidelines)
/memories/repo/               ← build facts, navigation aids, bug notes only
```

If a memory note contradicts DESIGN_GUIDELINES.md, DESIGN_GUIDELINES.md wins. Update or delete the memory note.
