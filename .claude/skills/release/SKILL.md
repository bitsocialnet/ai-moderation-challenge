---
name: release
description: Preview or prepare an ai-moderation-challenge release when a release is requested.
---

<!-- Generated from .agents/skills/release/SKILL.md; run yarn ai-workflow:sync. -->

# Release

Establish the requested boundary: preview, preparation, or publication. Inspect the current version, relevant tag, commits, `.release-it.json`, and `.github/workflows/publish.yml` before deciding what will run.

For a preview, report the proposed bump and release summary without changing files, installing, or running release-it. For an authorized release, use [the release procedure](references/procedure.md). Ask for a missing bump only when it cannot be inferred from the requested version or existing release plan.

Release-it can commit, tag, push, and create a GitHub release. Preserve the user's authorization for each external action; do not interpret preparation alone as permission to publish.
