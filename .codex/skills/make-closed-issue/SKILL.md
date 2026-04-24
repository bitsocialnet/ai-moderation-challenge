---
name: make-closed-issue
description: Create a GitHub issue from recent changes, commit relevant diffs on a short-lived task branch, push that branch, and open a PR into master that will close the issue on merge. Use when the user says "make closed issue", "close issue", or wants a tracked, already-resolved GitHub issue for completed work.
---

# Make Closed Issue

Creates a GitHub issue, commits relevant changes on a review branch, pushes the branch, and opens a PR into `master` that closes the issue when merged.

## Workflow

### 1. Choose Labels

Default mapping:

| Label           | When                                          |
| --------------- | --------------------------------------------- |
| `bug`           | Bug fix                                       |
| `enhancement`   | New feature                                   |
| `documentation` | README, AGENTS.md, docs-only changes          |
| `maintenance`   | Tooling, CI, release, or workflow maintenance |

Make a reasonable choice from the diff. Ask only if ambiguity materially affects tracking.

### 2. Resolve Current GitHub Assignee

```bash
GH_LOGIN=$(gh api user --jq '.login' 2>/dev/null || true)
```

If this is empty, stop and ask the contributor for their GitHub username.

### 3. Ensure a Reviewable Branch

- If already on `codex/feature/*`, `codex/fix/*`, `codex/docs/*`, or `codex/chore/*`, stay on it.
- If on `master`, create a task branch before staging or committing.

```bash
git switch -c codex/docs/ai-workflow
```

### 4. Review Diffs for Relevance

```bash
git status
git diff
git diff --cached
```

Stage only files related to the completed work. If a file has mixed relevant and unrelated changes and interactive staging is unavailable, include the whole file and note the caveat.

### 5. Create Issue

Write a short problem-focused title and 2-3 sentence description, then:

```bash
gh issue create \
  --repo bitsocialnet/ai-moderation-challenge \
  --title "ISSUE_TITLE" \
  --body "ISSUE_DESCRIPTION" \
  --label "LABEL1,LABEL2" \
  --assignee "$GH_LOGIN"
```

### 6. Commit Relevant Changes

```bash
git add <relevant-files>
git commit -m "type(scope): concise title"
```

Use scopes such as `challenge`, `schema`, `tests`, `docs`, `release`, or `tooling`.

### 7. Push and Open PR

```bash
COMMIT_HASH=$(git rev-parse HEAD)
BRANCH_NAME=$(git branch --show-current)
git push -u origin "$BRANCH_NAME"

gh pr create \
  --repo bitsocialnet/ai-moderation-challenge \
  --base master \
  --head "$BRANCH_NAME" \
  --title "PR_TITLE" \
  --body "$(cat <<EOF
SUMMARY

Closes #ISSUE_NUMBER
EOF
)"
```

Do not merge the PR as part of this skill unless the user explicitly asks.

### 8. Report Summary

```text
Issue #NUMBER created, committed, pushed, and linked to a PR into master.
  Branch: BRANCH_NAME
  Commit: HASH
  Labels: label1, label2
  PR: PR_URL
  URL: https://github.com/bitsocialnet/ai-moderation-challenge/issues/NUMBER
```
