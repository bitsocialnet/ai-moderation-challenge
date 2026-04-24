# Bug Investigation Workflow

Use this when a bug is reported in a specific file, line, stack trace, or code block.

## Mandatory First Step

Before editing, check git history for the relevant code. Previous contributors may have introduced behavior for a PKC compatibility edge case, provider quirk, or privacy constraint.

## Workflow

1. Scan recent commit titles for the file or area:

```bash
git log --oneline -10 -- src/index.ts
git blame -L 120,150 src/index.ts
```

2. Inspect only relevant commits with scoped diffs:

```bash
git show <commit-hash> -- src/index.ts
```

3. Reproduce with the narrowest check:

```bash
corepack yarn test -- tests/challenge.test.ts
```

4. Fix after understanding the history context, then run the required verification from `AGENTS.md`.

## Troubleshooting Rule

When blocked, search current docs or package issue trackers for recent fixes/workarounds, especially for provider API response shapes, `pkc-js` challenge types, Zod behavior, or Yarn 4 behavior.
