---
name: fix-merge-conflicts
description: Resolve all merge conflicts on the current branch non-interactively, validate the package, and commit. Use when the user says "fix merge conflicts", "resolve conflicts", or when git status shows conflicting files.
disable-model-invocation: true
---

# Fix Merge Conflicts

Resolve all merge conflicts on the current branch and leave the repo buildable.

## Workflow

1. Detect conflicts:

    ```bash
    git status --porcelain
    rg '<<<<<<<|=======|>>>>>>>' .
    ```

2. Resolve each file. Preserve both sides' intent when feasible.

3. File-type strategies:

    | File type           | Strategy                                                        |
    | ------------------- | --------------------------------------------------------------- |
    | `package.json`      | Merge keys conservatively, then run `corepack yarn install`     |
    | `yarn.lock`         | Regenerate with `corepack yarn install`; do not hand-edit       |
    | Config files        | Preserve the union of safe settings                             |
    | Markdown            | Include both unique sections, deduplicate headings              |
    | Generated artifacts | Prefer regeneration or deletion over manual conflict resolution |

4. Validate:

    ```bash
    corepack yarn build
    corepack yarn type-check
    corepack yarn test
    corepack yarn format:check
    ```

5. Verify no markers remain:

    ```bash
    rg '<<<<<<<|=======|>>>>>>>' .
    ```

6. Finalize:

    ```bash
    git add -A
    git commit -m "chore(merge): resolve conflicts"
    ```

## Constraints

- Do not push or tag.
- Keep edits minimal.
- If a resolution is ambiguous and blocks verification, prefer the variant that compiles and preserves public API behavior.
