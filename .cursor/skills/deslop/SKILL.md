---
name: deslop
description: Scan recent changes for AI-generated code slop and remove it. Use when the user says "deslop", "remove slop", "clean up AI code", or asks to remove AI-generated artifacts from the codebase.
disable-model-invocation: true
---

# Remove AI Code Slop

Scan the diff against `master` and remove AI-generated artifacts introduced in this branch.

## Workflow

1. Get the diff:

    ```bash
    git diff master...HEAD
    git diff master
    ```

2. Scan each changed file for the slop categories below.
3. Fix each instance to match surrounding style.
4. Verify:

    ```bash
    corepack yarn build && corepack yarn type-check && corepack yarn test && corepack yarn format:check
    ```

## Slop Categories

- Comments that restate obvious code instead of explaining a moderation, privacy, provider, or PKC constraint.
- Excessive defensive checks on trusted internal values while missing validation at external boundaries.
- `as any` casts that avoid fixing the actual type issue.
- New abstractions that hide simple request parsing, schema validation, cache-key, or branch logic.
- Inconsistent formatting, import ordering, naming, or test style.
- Live provider calls in tests or examples where a stub would be safer.

## Rules

- Do not change behavior during a deslop pass.
- Do not introduce dependencies.
- Keep comments that explain non-obvious constraints.
