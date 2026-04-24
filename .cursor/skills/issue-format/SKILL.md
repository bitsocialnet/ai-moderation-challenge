---
name: issue-format
description: Formats GitHub issue titles and descriptions for tracking problems that were fixed. Use when proposing or implementing code changes, creating GitHub issues, or when the user asks for issue suggestions.
---

# Issue Format

## Template

```md
> **GitHub issue:**
>
> - **Title:** `Short issue title here`
> - **Description:** Description sentence one. Sentence two with `codeRef()` references.
```

## Rules

1. Use markdown blockquote (`>` prefix).
2. Title goes after `**Title:**` wrapped in exactly one backtick pair.
3. Do not put backticks inside the title.
4. Description uses present tense and describes the problem, not the solution.
5. Keep the title short.

## Self-check

- Lines start with `>`.
- Title is wrapped in exactly one backtick pair.
- No nested backticks appear inside the title.
