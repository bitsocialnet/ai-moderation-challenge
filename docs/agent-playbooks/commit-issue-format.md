# Commit and Issue Format

Use this when proposing or implementing meaningful code changes.

## Commit Suggestion Format

- **Title:** Conventional Commits style with a short scope, wrapped in backticks.
- Use `perf` for performance optimizations, not `fix`.
- **Description:** Optional 2-3 informal sentences describing the solution. Concise, technical, no bullet points.

Example:

> **Commit title:** `fix(cache): include prompt hash in verdict cache key`
>
> Updated cache key construction so different private prompts cannot share stale verdicts.

## GitHub Issue Suggestion Format

- **Title:** As short as possible, wrapped in backticks.
- **Description:** 2-3 informal sentences describing the problem, not the solution, as if still unresolved.

Example:

> **GitHub issue:**
>
> - **Title:** `Verdict cache can reuse results across prompt changes`
> - **Description:** Cached moderation verdicts can remain valid after the private system prompt changes. That can route comments with stale moderation policy even when the community node operator updates the prompt.
