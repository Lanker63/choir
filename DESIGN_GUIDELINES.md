# Design Guidelines for Choir

## Design Insights

## Build a declarative system contract for the codebase:

- YAML = intent + constraints
- JSON = facts + computed state
- Chat = interface layer

## Design Schema Validation

Use Zod to ensure the schema is:
- Validated
- Enforceable
- Queryable

## Chat Usage

- @choir.architect add goal: build scalable auth
- @choir.architect add constraint: no direct db access
- @choir.analyst workspace summary
- @choir.analyst find hotspots

## Choir Agents

- Architect: defines intent
- Analyst: understands reality
- Enforcer: checks alignment



Next upgrades that actually matter:
1. AST-based analysis (huge upgrade). Replace string matching with:
- TypeScript compiler API
2. Strategy-aware analysis
- Have analyst compare findings against strategy:
- “You defined service layer but only 20% of files follow it”
3. Auto-refactoring suggestions
- Not just “hotspot”

But “split this file into X + Y”