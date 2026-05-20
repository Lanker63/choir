## Summary

- Describe the change and why it is needed.

## Scope

- [ ] Source code under src/ changed
- [ ] Tests changed
- [ ] Docs/config only (no source code behavior change)

## TDD Evidence (Required when source code changed)

### RED (must happen before production edits)

- [ ] I added or updated a focused test first.
- [ ] I ran the focused test before production edits and it failed.

Command(s):

```text
<paste RED command(s)>
```

Key failing output:

```text
<paste failing assertion or error lines>
```

### GREEN

- [ ] I implemented the minimal production change to satisfy the focused test.
- [ ] I re-ran the focused test and it passed.

Command(s):

```text
<paste GREEN command(s)>
```

Key passing output:

```text
<paste passing result lines>
```

### REFACTOR + REGRESSION

- [ ] Any refactor preserved behavior.
- [ ] I ran regression/build validation relevant to touched surfaces.

Command(s):

```text
<paste regression/build command(s)>
```

Key output:

```text
<paste pass summary lines>
```

## TDD Waiver (only when explicitly requested)

- [ ] TDD waiver explicitly requested for this change.

If checked, link to the explicit waiver request and explain why:

```text
<link and rationale>
```

## Verification Checklist

- [ ] Design and behavior contracts reviewed against DESIGN_GUIDELINES.md.
- [ ] Tests and docs updated where needed.
- [ ] No unrelated changes included.
