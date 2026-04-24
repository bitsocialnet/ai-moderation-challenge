# Skills and Tools

Use this playbook when setting up or adjusting skills and external tooling.

## Repo-Managed Skills

This repository mirrors compatible skills under:

- `.codex/skills/`
- `.cursor/skills/`
- `.claude/skills/`

When updating a shared skill, keep the three copies aligned unless a harness requires a different config format.

## Recommended Skills

### Context7

Use Context7 for up-to-date docs on libraries such as Zod, Vitest, TypeScript, release-it, and provider SDKs.

```bash
npx skills add https://github.com/intellectronica/agent-skills --skill context7
```

### Find Skills

Use this to discover/install skills from the open ecosystem when a contributor asks for specialized help.

```bash
npx skills add https://github.com/vercel-labs/skills --skill find-skills
```

### Debug Agent

Use the debug-agent workflow only when a bug needs runtime evidence. For this package, prefer a focused Vitest reproduction or a small Node script over live provider calls.

## Tool Policy Rationale

Avoid GitHub MCP for this project because it adds significant tool-schema/context overhead.

- GitHub operations: use `gh` CLI.
- Provider/API documentation: use official docs or Context7 where available.
- Runtime reproduction: prefer Vitest with stubbed `fetch`; do not call live moderation providers unless the user explicitly asks.
