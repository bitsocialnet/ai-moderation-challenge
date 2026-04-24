# Agent Hooks Setup

If your AI coding assistant supports lifecycle hooks, configure these for this repo.

## Recommended Hooks

| Hook            | Command                                            | Purpose                                                                                     |
| --------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `afterFileEdit` | `scripts/agent-hooks/format.sh`                    | Auto-format edited files with the repo Prettier config                                      |
| `afterFileEdit` | `scripts/agent-hooks/yarn-install.sh`              | Run `corepack yarn install` when `package.json` changes                                     |
| `afterFileEdit` | `scripts/agent-hooks/moderation-pattern-review.sh` | Remind agents to re-check privacy and fail-closed behavior after sensitive moderation edits |
| `stop`          | `scripts/agent-hooks/sync-git-branches.sh`         | Prune stale refs and delete integrated temporary task branches                              |
| `stop`          | `scripts/agent-hooks/moderation-pattern-review.sh` | Re-scan the current diff for sensitive moderation changes before final verification         |
| `stop`          | `scripts/agent-hooks/verify.sh`                    | Hard-gate build, type-check, test, and format check; keep `yarn npm audit` informational    |

## Why

- Consistent formatting
- Lockfile stays in sync
- Sensitive prompt/API/cache changes get an explicit second look
- Build, type, test, and formatting issues are caught early
- Security visibility via `corepack yarn npm audit`
- One shared hook implementation for Codex, Cursor, and Claude
- Temporary task branches stay aligned with the repo's worktree workflow

## Verification Mode

By default, `scripts/agent-hooks/verify.sh` exits non-zero when required checks fail. Set `AGENT_VERIFY_MODE=advisory` only when you intentionally need signal from a broken tree without blocking the hook.

## Toolchain Wiring

`.codex/hooks/*.sh`, `.cursor/hooks/*.sh`, and `.claude/hooks/*.sh` should stay thin wrappers that delegate to the shared implementations under `scripts/agent-hooks/`.

Harness-specific startup hooks can live alongside those wrappers when other harnesses do not have an equivalent entry point. Claude uses `.claude/hooks/session-start.sh` to install dependencies when a new worktree has a `yarn.lock` but no populated `node_modules`.
