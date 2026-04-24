---
name: debug-agent
description: Systematic evidence-based debugging using runtime logs or focused reproductions. Use when the user reports a bug, unexpected behavior, or asks to debug an issue.
---

# Debug Mode

Debug with evidence. For this package, prefer a failing Vitest case or a small local Node reproduction over live provider calls.

## Workflow

1. Generate 3-5 precise hypotheses about why the bug occurs.
2. Create the smallest reproduction that can prove or reject those hypotheses.
3. Instrument only if assertions are not enough. Never log API keys, prompts, authorization headers, raw publication content, or private cache paths.
4. Run the reproduction and classify each hypothesis as `CONFIRMED`, `REJECTED`, or `INCONCLUSIVE` with cited evidence.
5. Fix only after evidence points to the cause.
6. Verify with the same reproduction plus the relevant repo checks.
7. Remove temporary instrumentation before finishing.

## Preferred Commands

```bash
corepack yarn test -- tests/challenge.test.ts
corepack yarn type-check
```

If the bug needs the external debug-agent logger:

```bash
npx debug-agent --daemon
```

Use its returned endpoint/log path only for this debugging session. Clear that session's logs between runs and never touch logs from other sessions.

## Constraints

- Do not call live moderation providers unless the user explicitly asks.
- Do not keep speculative defensive code from rejected hypotheses.
- Do not claim success without rerunning the reproduction.
