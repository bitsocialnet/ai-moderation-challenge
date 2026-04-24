# tests/AGENTS.md

These rules apply to `tests/**`. Follow the repo-root `AGENTS.md` first, then use this file for Vitest coverage.

- Tests should describe observable challenge behavior rather than implementation details where possible.
- Stub `fetch` and filesystem paths explicitly; never depend on live provider endpoints, real API keys, or a contributor's private cache file.
- Include assertions for privacy-sensitive behavior when relevant: no linked media fetches, no raw prompt/API key cache storage, and fail-closed provider errors.
- Keep fixtures small and focused. Prefer helpers that mirror PKC request shapes over broad `as any` shortcuts.
- After test edits, run `corepack yarn test`. Run `corepack yarn type-check` when helper types or source imports changed.
