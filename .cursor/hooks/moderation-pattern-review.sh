#!/bin/bash

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
exec "$repo_root/scripts/agent-hooks/moderation-pattern-review.sh" --scope-prefix src/ --scope-prefix tests/ --scope-prefix README.md --scope-prefix package.json "$@"
