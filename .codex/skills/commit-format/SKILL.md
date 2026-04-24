---
name: commit-format
description: Formats GitHub commit messages following Conventional Commits style with a title and optional description. Use when proposing or implementing code changes, writing commit messages, or when the user asks for commit message suggestions.
---

# Commit Format

## Template

Title only:

```md
> **Commit title:** `type(scope): short description here`
```

Title with description:

```md
> **Commit title:** `type(scope): short description here`
>
> Description sentence one. Description sentence two with `codeRef()` references.
```

## Rules

1. Use markdown blockquote (`>` prefix).
2. Title goes after `**Commit title:**` wrapped in exactly one backtick pair.
3. Do not put backticks inside the title.
4. Description may use backticks for code references.
5. Types: `fix`, `feat`, `perf`, `refactor`, `docs`, `chore`, `build`, `test`.
6. Use a short scope such as `challenge`, `schema`, `tests`, `docs`, `release`, or `tooling`.
7. Description is optional and should be 2-3 concise sentences.

## Self-check

- Lines start with `>`.
- Title is wrapped in exactly one backtick pair.
- No nested backticks appear inside the title.
