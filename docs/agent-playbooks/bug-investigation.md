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
corepack yarn exec vitest run --maxWorkers=2 tests/challenge.test.ts
```

4. Fix after understanding the history context, then run the required verification from `AGENTS.md`.

## Troubleshooting Rule

Consult current official documentation or package issue trackers when a concrete provider/API or dependency question blocks progress. Report missing private source or user-only reproduction steps precisely; continue independent work.
