#!/bin/bash

# afterFileEdit hook: run Corepack-managed Yarn install when package.json changes.
# Receives JSON via stdin: {"file_path": "...", "edits": [...]}

input="$(cat)"

extract_file_path() {
    if command -v jq >/dev/null 2>&1; then
        printf '%s' "$input" | jq -r '.file_path // empty' 2>/dev/null
        return
    fi

    printf '%s' "$input" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*:.*"\([^"]*\)"/\1/'
}

file_path="$(extract_file_path)"

if [ -z "$file_path" ]; then
    exit 0
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

case "$file_path" in
    package.json | "$repo_root/package.json")
        cd "$repo_root" || exit 0
        echo "package.json changed - running corepack yarn install to update yarn.lock..."
        corepack yarn install
        ;;
esac

exit 0
