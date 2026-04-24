# scripts/AGENTS.md

These rules apply to `scripts/**`. Follow the repo-root `AGENTS.md` first, then use this file for automation and workflow helpers.

- Keep scripts non-interactive and idempotent. Print the command, branch, or path being acted on so failures are diagnosable.
- Use repo-relative paths and environment variables instead of user-specific absolute paths.
- Keep shell helpers thin. When logic becomes stateful or cross-platform, prefer a Node script.
- Git and worktree helpers must validate input and default to safe operations.
- Shared hook implementations live under `scripts/agent-hooks/`; `.codex/hooks/`, `.cursor/hooks/`, and `.claude/hooks/` should stay thin wrappers.
- If a helper deletes local branches automatically, document the exact eligibility checks and keep the behavior conservative.
