---
name: review-and-merge-pr
description: Review an open GitHub pull request, inspect feedback from bots, CI, and human reviewers, implement valid fixes on the PR branch, merge when ready, and clean up local state. Use when the user says "check the PR", "address comments", "review PR feedback", or "merge this PR".
---

# Review And Merge PR

## Overview

Use this after a feature branch already has an open PR into `master`. Treat review bots as input rather than authority. Merge only once the branch is verified and remaining comments are fixed, deferred, or declined with a reason.

## Workflow

### 1. Identify the PR

```bash
gh pr status
gh pr list --repo bitsocialnet/ai-moderation-challenge --state open
gh pr view <pr-number> --repo bitsocialnet/ai-moderation-challenge --json number,title,url,headRefName,baseRefName,isDraft,reviewDecision,mergeStateStatus
```

If there is no open PR, stop and use `make-closed-issue` or create a PR first.

### 2. Gather Review Signals

```bash
gh pr checks <pr-number>
gh api "repos/bitsocialnet/ai-moderation-challenge/issues/<pr-number>/comments?per_page=100"
gh api "repos/bitsocialnet/ai-moderation-challenge/pulls/<pr-number>/reviews?per_page=100"
gh api "repos/bitsocialnet/ai-moderation-challenge/pulls/<pr-number>/comments?per_page=100"
```

Read CI failures, review summaries, and inline comments before editing.

### 3. Triage Findings

- `must-fix`: correctness bugs, broken behavior, crashes, security issues, test failures, privacy leaks, fail-open moderation behavior.
- `should-fix`: clear maintainability or edge-case issues with concrete evidence.
- `defer`: real but non-blocking follow-up work.
- `decline`: false positives, stale comments, duplicate findings, speculative style-only suggestions, or already-addressed feedback.

Never merge with unresolved `must-fix` findings.

### 4. Work on the PR Branch

```bash
git switch <head-branch>
git fetch origin <head-branch>
git status --short --branch
```

Apply valid fixes, commit, and push to the same branch. Do not open a replacement PR unless the user asks.

### 5. Verify

```bash
corepack yarn build
corepack yarn type-check
corepack yarn test
corepack yarn format:check
```

### 6. Comment if Feedback Was Addressed

```bash
gh pr comment <pr-number> --repo bitsocialnet/ai-moderation-challenge --body "Addressed the valid review findings in the latest commit. Remaining comments were triaged as stale, low-risk, or follow-up work that does not block this merge."
```

### 7. Merge When Ready

Only merge if:

- The PR is not draft.
- Required checks are passing.
- The branch is mergeable into `master`.
- No unresolved `must-fix` findings remain.
- The latest code was verified locally after the last review-driven change.

```bash
gh pr merge <pr-number> --repo bitsocialnet/ai-moderation-challenge --squash --delete-branch
```

### 8. Clean Up Local State

```bash
git switch master
git fetch origin --prune
git pull --ff-only
git branch -D <head-branch> 2>/dev/null || true
git branch -D "pr/<pr-number>" 2>/dev/null || true
```

If the PR branch lived in a dedicated worktree, remove that worktree after leaving it.

### 9. Report Outcome

Report findings fixed, findings deferred/declined, verification commands, merge status, linked issues closed, refs pruned, and local branch/worktree cleanup.
