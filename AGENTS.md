# AGENTS.md

## Purpose

This file defines the always-on rules for AI agents working on `@bitsocial/ai-moderation-challenge`.
Use this as the default policy. Load linked playbooks only when their trigger condition applies.

## Surprise Handling

The role of this file is to reduce recurring agent mistakes and confusion points in this repository.
If you encounter something surprising or ambiguous while working, alert the developer immediately.
After confirmation, add a concise entry to `docs/agent-playbooks/known-surprises.md` so future agents avoid the same issue.
Only record items that are repo-specific, likely to recur, and have a concrete mitigation.

## Project Overview

`@bitsocial/ai-moderation-challenge` is a Bitsocial PKC community challenge package. It evaluates comment content against `community.rules` through an OpenAI-compatible model endpoint, without requiring a hosted Bitsocial moderation server.

## Instruction Priority

- **MUST** rules are mandatory.
- **SHOULD** rules are strong defaults unless task context requires a different choice.
- If guidance conflicts, prefer: user request > MUST > SHOULD > playbooks.

## Agent Operating Principles

- Before editing, state important assumptions when the task is ambiguous. Ask instead of silently choosing between materially different interpretations.
- Prefer the smallest implementation that solves the requested problem. Do not add speculative abstractions, configurability, or features.
- Keep diffs surgical. Do not refactor, reformat, rename, or "improve" adjacent code unless it is necessary for the task.
- Clean up only artifacts created by the current change, such as newly unused imports or dead helper code.
- For non-trivial work, define success criteria and verify them with the narrowest reliable checks before marking the task complete.

## LLM Knowledge Base Policy

Use compiled context for orientation, not as source of truth.

Source of truth:

- Code, tests, package manifests, docs, and runtime/live evidence when relevant.

Compiled context:

- `AGENTS.md`, directory-specific `AGENTS.md` files, `CLAUDE.md`, and repo-managed `.codex/`, `.cursor/`, and `.claude/` workflow files.
- `docs/agent-playbooks/**`, `docs/agent-runs/**`, `docs/agent-playbooks/known-surprises.md`, and tracked `llms.txt` / `llms-full.txt` files when present.

Agents may use compiled context to navigate quickly, but must verify against source files before making behavioral claims or edits. External code graph, RAG, MCP, or wiki tools are optional local accelerators unless the developer explicitly asks to make one part of the committed workflow.

## Task router

| Change                                                                 | Guidance                                                                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Runtime `src/**`                                                       | Read `src/AGENTS.md`; choose checks with `docs/agent-playbooks/verification.md`.                     |
| Tests                                                                  | Read `tests/AGENTS.md`; run the affected tests.                                                      |
| Provider parsing, prompts, cache keys, secrets, or branch semantics    | Add focused Vitest coverage; use the moderation-reviewer checklist when a separate review is useful. |
| Dependency manifest                                                    | Run `corepack yarn install` and include the lockfile.                                                |
| Public docs or AI context                                              | Run `corepack yarn llms:generate` and include `llms*.txt`.                                           |
| Release                                                                | Use the release skill within the requested preview/preparation/publication boundary.                 |
| Durable handoff/resumption                                             | Use `docs/agent-playbooks/long-running-agent-workflow.md`.                                           |
| Requested PR review or merge                                           | Use `review-and-merge-pr` within the authorized scope.                                               |
| Bug fix or substantive review correction exposes a preventable mistake | Use [retro](.agents/skills/retro/SKILL.md) before finishing; preserve review-only scope.             |

## Stack

- Node.js 22+
- TypeScript with `NodeNext` (see installed manifest version)
- esbuild for the bundled ESM output
- Vitest for tests
- Zod for option and model-verdict validation
- `@pkcprotocol/pkc-js` community challenge APIs
- Corepack-managed Yarn 4
- Prettier
- release-it and trusted npm publishing through GitHub Actions

## Project Structure

```text
src/
├── index.ts    # Challenge metadata, PKC runtime entrypoint, model calls, cache handling
└── schema.ts   # Options, API format, branch, and model-verdict schemas
tests/
└── challenge.test.ts
scripts/
├── agent-hooks/          # Shared lifecycle hooks for AI tooling
├── agent-init.sh         # Fresh-session setup and smoke verification
└── create-task-worktree.sh
docs/
└── agent-playbooks/      # On-demand workflows for agents
```

## Core MUST Rules

### Package and Dependency Rules

- Use Corepack-managed Yarn 4, never npm for development commands. Run `corepack enable` once on a new machine before using `yarn`.
- Pin exact dependency versions (`package@x.y.z`), never `^` or `~`.
- Keep `yarn.lock` synchronized when dependency manifests change.
- Do not add a dependency when a small typed helper or existing standard library API is enough.

### Moderation and Security Rules

- Treat `apiKey`, inline prompts, prompt files, and cache paths as private community-node settings. Never copy secrets into public challenge metadata, docs examples, tests, logs, or cache payloads.
- Preserve fail-closed moderation behavior. If the provider is unavailable or returns malformed output, the challenge must not silently allow content.
- Do not fetch linked media or linked pages. The package may use URL metadata already present in the publication, but it must not retrieve external content during moderation.
- Keep model output schema-driven and strict. Validate provider output through `ModelVerdictSchema` or an equally strict schema before using it.
- Keep request construction deterministic and testable. Model payload changes should be covered by Vitest assertions against the outgoing `fetch` body.
- Keep cache keys derived from stable hashes of provider/model config, final prompt identity, community context, and target content. Do not store raw API keys, raw prompts, or raw publication content in persistent cache files.
- Keep branch semantics explicit: `allow` means the branch allows only `allow` verdicts; `review` means the branch routes `review` verdicts to PKC pending approval when paired with challenge settings.
- Content edits require extra care because PKC pending approval does not cover edits in the same way as new comments. Preserve the existing reject-on-review and reject-on-unavailable behavior unless the PKC API changes and tests prove the new behavior.
- Avoid logging raw model prompts, full model payloads, authorization headers, or private cache paths.

### TypeScript Rules

- Prefer `unknown` plus narrow type guards over `any`.
- Keep public exports stable unless the user explicitly asks for a breaking change.
- Use Zod for external or user-configured data boundaries.
- Keep module imports compatible with NodeNext ESM and the package `exports` map.
- Comments should explain non-obvious moderation, privacy, PKC, or provider-compatibility constraints. Remove comments that only restate the code.

### Bug Investigation Rules

- A bug fix requires either a reproduction of the reported behavior or conclusive source/runtime evidence that identifies both the defect and the correct fix with equivalent certainty.
- If the bug cannot be reproduced and the evidence is not conclusive, do not guess or make speculative changes. Report what was checked, say that the bug was not reproduced, and ask for the missing reproduction details when useful.
- When proceeding from conclusive evidence without a reproduction, explain why the evidence is sufficient and add a targeted regression test when practical.
- For bug reports tied to a specific file/line, check relevant git history before any fix.
- Minimum sequence: `git log --oneline` or `git blame` first, then scoped `git show` for relevant commits.
- Full workflow: `docs/agent-playbooks/bug-investigation.md`.

### Project Maintenance Rules

- Keep README examples aligned with the code defaults in `src/schema.ts` and runtime behavior in `src/index.ts`.
- If package version changes, verify release notes/changelog output with the `release` skill and the GitHub workflow expectations in `README.md`.
- First-time npm publishing is manual; future version publishes are handled by `.github/workflows/publish.yml` when `package.json` changes on `master`.

## Additional guidance

- Extend nearby tests for non-trivial moderation changes. Keep provider calls stubbed and avoid private settings in fixtures.
- Use `gh` for GitHub operations. Provide commit/issue suggestions when requested, not on every answer.
- Search current official documentation when a concrete provider/API or dependency-version question requires it. Tool integrations are optional; do not install additional tools merely because the task mentions their domain.

## Common Commands

```bash
corepack yarn install
corepack yarn build
corepack yarn type-check
corepack yarn test
corepack yarn format
corepack yarn format:check
corepack yarn npm audit
./scripts/create-task-worktree.sh chore ai-workflow-improvement
./scripts/agent-init.sh --smoke
```

## Playbooks (Load On Demand)

Use these only when relevant to the active task:

- Hooks setup and scripts: `docs/agent-playbooks/hooks-setup.md`
- Long-running agent workflow: `docs/agent-playbooks/long-running-agent-workflow.md`
- Commit/issue output format: `docs/agent-playbooks/commit-issue-format.md`
- Skills/tools setup and rationale: `docs/agent-playbooks/skills-and-tools.md`
- Bug investigation workflow: `docs/agent-playbooks/bug-investigation.md`
- Known surprises log: `docs/agent-playbooks/known-surprises.md`

## Workflow and ownership

- Continue authorized work through implementation, affected checks, and fixes. Ask only when missing information changes the result or an action lacks authorization; do not add approval gates from suggested skill procedures.
- Verify technical claims against source, tests, manifests, and runtime evidence. Agent instructions and generated context orient the task; they do not establish behavior.
- Keep changes scoped, preserve unrelated edits and preexisting artifacts, and stage only task-owned changes. Commit, push, publish, or merge only within the user’s authorization; existing authorization persists.
- Keep `master` releasable. Use a short-lived descriptive `codex/` branch for new work unless the user requests another branch or direct work on `master`. Use separate worktrees for unrelated concurrent tasks; never switch branches underneath another agent.
- Delegate substantial independent slices when useful, with explicit scope, file ownership, acceptance criteria, and evidence to return. Small or coupled work can stay local. Use built-in worker/explorer roles where available; custom roles cover project-specific review or verification.
- One owner runs installs, full suites, builds, and browsers. Parallelize independent reads and non-overlapping edits; use at most four workers by default. Do not run Git cleanup, installs, full verification, or review loops from lifecycle hooks.
- Review the final diff and use the narrowest reliable checks in [verification.md](docs/agent-playbooks/verification.md). Repeat checks only after relevant changes, failures, or new uncertainty. Preserve explicit CI/release requirements.

## Shared AI tooling

- Edit `.agents/skills/` and `.agents/roles/`, then run `corepack yarn ai-workflow:sync`, `corepack yarn ai-workflow:check`, and `corepack yarn ai-workflow:test`.
- `.agents/roles/` is this repository’s generator input, not a native app discovery path. Commit the generated `.codex/agents/*.toml`, `.cursor/agents/*.md`, `.claude/agents/*.md`, and `.claude/skills/` outputs. Codex and Cursor read `.agents/skills/`; Claude uses the generated copies and `CLAUDE.md` importing `AGENTS.md`.
- Leave model and reasoning fields unset in skills and roles. Runtime invocation, app/user defaults, and parent inheritance select them. Do not pin a generation or model family in repository prompts.
- Keep hook schemas and permissions native to each harness; similar file contents do not imply identical runtime behavior. See [skills-and-tools.md](docs/agent-playbooks/skills-and-tools.md).
- Keep skill descriptions precise and roots short. Load references when relevant; preserve domain constraints and supported manual-invocation metadata. Prefer installed tools and current official documentation when versions matter; search for or install additional skills only when requested.

## Optional Jev semantic review

For an explicitly selected code or documentation diff, use `scripts/jev/review-README.md`. The bounded helper is opt-in, uses the private machine configuration only with `--live`, and produces advisory issues or uncertainty. Keep ordinary linting, tests, and independent review authoritative; do not add automatic edit, commit, or repair hooks. Offline checks run with `node --test scripts/jev/tests/*.test.mjs`.

For investigation of recurring backend failures, `scripts/jev/triage-README.md` covers an opt-in experiment on explicitly sanitized event groups; keep deterministic alerts and original evidence. The helper requires explicit live invocation for provider calls and is not a service integration.
