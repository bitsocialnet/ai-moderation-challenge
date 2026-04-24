# src/AGENTS.md

These rules apply to `src/**`. Follow the repo-root `AGENTS.md` first, then use this file for runtime challenge code.

- Keep challenge metadata, PKC integration, provider calls, and cache behavior in `src/index.ts` unless a split clearly reduces complexity.
- Keep option, API format, branch, and model-verdict validation in `src/schema.ts`.
- Treat external input as untrusted: challenge settings, community runtime data, provider responses, file-backed prompts, and file-backed caches all need parsing or guards.
- Preserve privacy boundaries. Do not persist raw prompts, API keys, authorization headers, or publication content in cache files or logs.
- Preserve fail-closed behavior for unavailable or malformed model responses.
- Do not fetch linked media or URLs during moderation.
- When changing request payloads, response parsing, cache keys, or option defaults, update `tests/challenge.test.ts` or a nearby test file.
- After edits, run `corepack yarn build`, `corepack yarn type-check`, `corepack yarn test`, and `corepack yarn format:check`.
