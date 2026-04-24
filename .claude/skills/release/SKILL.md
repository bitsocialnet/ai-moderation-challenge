---
name: release
description: Prepare an ai-moderation-challenge release by analyzing commits, choosing a version bump, verifying the package, running release-it, and checking publish workflow expectations. Use when the user says "release", "new version", "cut a release", "prepare release", or provides a version number to ship.
---

# Release

## Inputs

The user should provide a bump (`patch`, `minor`, `major`) or explicit `x.y.z`. If omitted, ask which bump level they want.

## Workflow

Track progress with this checklist:

```text
Release Progress:
- [ ] Step 1: Inspect current version and latest tag
- [ ] Step 2: Analyze commits since latest tag
- [ ] Step 3: Verify package
- [ ] Step 4: Run release-it
- [ ] Step 5: Inspect generated changelog, version, tag, and release notes
- [ ] Step 6: Push only if the user asked
```

### Step 1: Inspect Version and Tag

```bash
node -p "require('./package.json').version"
git tag --sort=-creatordate | head -1
```

### Step 2: Analyze Commits

```bash
git log --oneline <tag>..HEAD
```

If there are no new commits, stop.

### Step 3: Verify

```bash
corepack yarn install --immutable
corepack yarn build
corepack yarn type-check
corepack yarn test
corepack yarn format:check
```

Remove generated `dist/` after local verification unless the release command needs it.

### Step 4: Run release-it

Use the repo script and pass the intended increment or explicit version:

```bash
corepack yarn release --ci --increment patch
```

or:

```bash
corepack yarn release --ci --increment 0.1.2
```

The release-it config updates `CHANGELOG.md`, bumps `package.json`, commits, tags, and creates a GitHub release. Npm publishing is handled later by `.github/workflows/publish.yml` when the version change lands on `master`.

### Step 5: Inspect Results

```bash
git status --short
git log --oneline -3
git tag --sort=-creatordate | head -3
```

Confirm `CHANGELOG.md` and `package.json` reflect the intended release.

### Step 6: Push

Do not push commits or tags unless the user explicitly asks.

## Dry-run Mode

If the user says "dry run" or "preview", do Steps 1-3 and report the planned bump and release summary without running release-it.
