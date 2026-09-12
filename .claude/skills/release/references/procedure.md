# Release procedure

Inspect `.release-it.json` immediately before use: its `before:git:release` hook commits `CHANGELOG.md` and `package.json`, and release-it can tag, push, and create a GitHub release. Package publication is disabled in release-it; `.github/workflows/publish.yml` handles npm publication when the version change reaches `master`.

For a release that authorizes those operations, verify the intended version, a clean task-owned diff, and tag availability. Run the release checks once: `corepack yarn install --immutable`, `corepack yarn build`, `corepack yarn type-check`, `corepack yarn test`, and `corepack yarn format:check`. Keep preexisting output; do not delete another task's `dist`.

Use `corepack yarn release --ci --increment <bump-or-version>` only when its configured side effects are authorized. If only preparing files, update the version/changelog directly and stop at that boundary; do not call release-it and hope it stays local. Do not overwrite an existing tag despite the current config's force option.

Inspect the resulting version, changelog, commit, tag, and publish workflow outcome as applicable. Report exact completed operations and any remaining authorized step.
