---
name: commit
description: Commit current work by reviewing diffs, splitting into logical commits, and writing standardized messages. Use when the user says "commit", "commit this", "commit current work", or asks to create a git commit.
disable-model-invocation: true
---

# Commit Current Work

## Workflow

1. Review all uncommitted changes:

    ```bash
    git status
    git diff
    git diff --cached
    ```

2. Group changes into logical commits. Split unrelated documentation, tooling, tests, and runtime changes when that makes review clearer.

3. Stage only the relevant files for each commit:

    ```bash
    git add <relevant-files>
    git commit -m "type(scope): short description"
    ```

4. Display the commit title to the user wrapped in inline code.

## Commit Message Rules

- Use Conventional Commits with a required scope: `type(scope): description`.
- Good scopes for this repo include `challenge`, `schema`, `tests`, `docs`, `release`, and `tooling`.
- Use `perf:` for performance optimizations, not `fix:`.
- Keep titles short. Add a body only when the title is not enough.

## Constraints

- Only commit when instructed.
- Never push unless the user explicitly asks.
- Never amend commits that have been pushed to a remote unless the user explicitly asks.
