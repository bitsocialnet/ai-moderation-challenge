---
name: readme
description: Create or update README.md documentation for this package. Use when the user says "write readme", "create readme", "document this project", "project documentation", or asks for README help.
---

# README Generator

Write README documentation that helps a contributor or community node operator understand setup, behavior, configuration, and publishing.

## Before Writing

Explore the codebase first:

- `package.json`
- `README.md`
- `src/index.ts`
- `src/schema.ts`
- `tests/challenge.test.ts`
- `.github/workflows/*.yml`

Confirm option defaults from source rather than copying stale docs.

## Required Coverage

- What the package does and where it runs.
- Installation command.
- Challenge configuration examples for `allow` and `review` branches.
- Full options table with defaults.
- Behavior for new comments, edits, deletes, non-comment publication types, provider failures, and caching.
- Privacy boundaries for `apiKey`, prompts, prompt paths, and cache files.
- Local development commands.
- Publishing and trusted publishing expectations.

## Rules

- Do not include real API keys.
- Make examples clearly fake.
- Keep user-facing behavior plain and precise.
- If documenting provider compatibility, state that OpenAI-compatible APIs are a practical convention and must be tested before live use.
- Run `corepack yarn format:check` after README edits.
