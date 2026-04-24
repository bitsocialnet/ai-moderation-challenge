---
name: refactor-pass
description: Perform a refactor pass focused on simplicity after recent changes. Use when the user asks for a refactor, cleanup pass, simplification, dead-code removal, or says "refactor pass".
---

# Refactor Pass

## Workflow

1. Review recent changes:

    ```bash
    git diff
    git diff --cached
    git log --oneline -5
    ```

2. Apply refactors in priority order:
    - Remove dead code and unreachable paths.
    - Straighten convoluted control flow.
    - Remove unnecessary intermediaries or abstractions.
    - Replace `as any` with correct types or guards.
    - Consolidate duplicated provider parsing, cache-key, or validation logic only when it clearly improves clarity.

3. Verify:

    ```bash
    corepack yarn build && corepack yarn type-check && corepack yarn test && corepack yarn format:check
    ```

## Project-Specific Anti-patterns

| Anti-pattern                                                     | Refactor to                                      |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| Raw external values trusted directly                             | Zod schema, URL parsing, or explicit type guards |
| Live provider calls in tests                                     | Stubbed `fetch` responses                        |
| Raw prompts/API keys/content in persistent cache                 | Stable hash keys plus verdict-only cache entries |
| Broad catch-all behavior that allows content on provider failure | Existing fail-closed handling                    |
| Hand-built JSON parsing scattered across files                   | A focused helper near the behavior it supports   |

## Rules

- Preserve behavior.
- Do not introduce dependencies.
- Keep changes scoped to recently touched code unless the user asks for a broader pass.
