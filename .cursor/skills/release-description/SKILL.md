---
name: release-description
description: Draft a concise release summary by analyzing commit titles since the last git tag. Use when the user asks to update release notes, prepare a release summary, or summarize changes for a version.
---

# Release Description

## Steps

1. Find the latest release tag:

    ```bash
    git tag --sort=-creatordate | head -1
    ```

2. List commit titles since that tag:

    ```bash
    git log --oneline <tag>..HEAD
    ```

3. Categorize commits:

    | Prefix                   | Category         |
    | ------------------------ | ---------------- |
    | `feat`                   | New behavior     |
    | `fix`                    | Bug fixes        |
    | `perf`                   | Performance      |
    | `refactor`               | Internal cleanup |
    | `docs`                   | Documentation    |
    | `chore`, `build`, `test` | Maintenance      |

4. Write a concise, user-facing summary:
    - One sentence.
    - Plain language.
    - Mention moderation behavior, provider compatibility, privacy, caching, or publishing only when those changed.
    - Do not mention every commit.

5. If the user wants it written into release materials, update the relevant changelog or GitHub release draft after confirming where it should live.
