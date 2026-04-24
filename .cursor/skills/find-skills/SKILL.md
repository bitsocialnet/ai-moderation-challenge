---
name: find-skills
description: Helps users discover and install agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express interest in extending capabilities.
---

# Find Skills

Use this when the user is looking for functionality that might exist as an installable skill.

## Workflow

1. Identify the domain and task.
2. Search:

    ```bash
    npx skills find <query>
    ```

3. Present relevant options with install commands.
4. If the user wants installation, install with:

    ```bash
    npx skills add <owner/repo@skill> -g -y
    ```

## Common Searches

- `typescript testing`
- `vitest`
- `release notes`
- `security review`
- `github pr review`

## When No Skill Is Found

Say no matching skill was found and proceed with the task directly if it is still within scope.
