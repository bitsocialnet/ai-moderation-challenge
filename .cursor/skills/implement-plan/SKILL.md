---
name: implement-plan
description: Orchestrates implementation of a multi-task plan by spawning plan-implementer subagents in parallel. Use when the user provides a plan file or plan text and asks to implement it, execute it, or says "implement plan".
---

# Implement Plan

You are the orchestrator. Execute an attached plan by delegating scoped tasks to `plan-implementer` agents when the harness supports it and the user has asked for plan execution.

## Workflow

1. Read the plan and identify discrete tasks, dependencies, files, and acceptance criteria.
2. Group tasks into parallel batches. Tasks touching the same files must be in the same agent or a later sequential batch.
3. Give each implementer exact tasks, paths, constraints, and verification expectations.
4. Handle partial failures by reading the report, adding context, and retrying only when the next step is clear.
5. After all batches complete, run final verification:

    ```bash
    corepack yarn build
    corepack yarn type-check
    corepack yarn test
    corepack yarn format:check
    ```

6. Report completed tasks, failed tasks, files changed, and verification results.

## Key Constraints

- Do not let subagents own overall task state.
- Keep write scopes disjoint for parallel agents.
- Follow `AGENTS.md` privacy and fail-closed moderation rules.
