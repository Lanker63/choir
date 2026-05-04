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

## Chat Partipant Functions
- choir.architect: defines intent (rules, constraints)
- choir.analyst:   interprets code/tasks
- choir.enforcer:  guarantees compliance (hard + soft)

choir.enforcer is the only authoritative gate.

The enforcer pipeline:

    Input (task + workspace snapshot)  
        ↓  
    Context Builder  
        ↓  
    AST Enforcement        (hard guarantees)  
        ↓  
    Semantic Enforcement   (cross-file, type-aware)  
        ↓  
    Code Enforcement       (lint, patterns)  
        ↓  
    Strategy Enforcement   (LLM / intent alignment)  
        ↓  
    Conflict Resolver  
        ↓  
    Fix Engine  
        ↓  
    Output (diagnostics + patches + verdict)  

## Chat Usage

- @choir.architect add goal: build scalable auth
- @choir.architect add constraint: no direct db access
- @choir.analyst workspace summary
- @choir.analyst find hotspots

## Choir Agents

- Architect: defines intent
- Analyst: understands reality
- Enforcer: checks alignment

## Rule Editor for Enforcer

    VSCode Webview (Rule Editor)  
        ⇅ postMessage  
    Extension Host (Controller)  
        ⇅  
    Choir Enforcer Pipeline  
        ⇅  
    Diagnostics + Fixes

## TODOs
- Introduce a dedicated AST enforcement phase
    - Strategy-aware analysis
    - Auto-refactoring suggestions (not just hotspots)
- Use real parsers (TypeScript / Tree-sitter)
- Define structured rules with fixers
- Integrate into VSCode diagnostics

## Notes
- Within extension always resolve from context.extensionPath, not cwd
- /media = dumb static assets