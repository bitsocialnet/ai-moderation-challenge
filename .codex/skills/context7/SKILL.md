---
name: context7
description: Retrieve up-to-date documentation for software libraries, frameworks, and components via the Context7 API. Use when looking up documentation for a programming library, verifying APIs, or obtaining current library examples.
---

# Context7

Use Context7 when library behavior may have changed since training data. In this repo, likely targets include Zod, Vitest, TypeScript, release-it, esbuild, and provider API clients.

## Search

```bash
curl -s "https://context7.com/api/v2/libs/search?libraryName=LIBRARY_NAME&query=TOPIC" | jq '.results[0]'
```

## Fetch Docs

```bash
curl -s "https://context7.com/api/v2/context?libraryId=LIBRARY_ID&query=TOPIC&type=txt"
```

## Tips

- Use `type=txt` for readable output.
- Be specific with the `query` parameter.
- Prefer official docs when the topic is provider-specific or security-sensitive.
