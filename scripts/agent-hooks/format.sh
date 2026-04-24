#!/bin/bash

# afterFileEdit hook: auto-format files after AI edits them.
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
cd "$repo_root" || exit 0

case "$file_path" in
    /*) candidate="$file_path" ;;
    *) candidate="$repo_root/$file_path" ;;
esac

dir_part="${candidate%/*}"
base_name="${candidate##*/}"
resolved_dir="$(cd -P -- "$dir_part" 2>/dev/null && pwd -P)" || exit 0
resolved_path="$resolved_dir/$base_name"

case "$resolved_path" in
    "$repo_root"/* | "$repo_root") ;;
    *) exit 0 ;;
esac

case "$resolved_path" in
    *.js | *.cjs | *.mjs | *.ts | *.tsx | *.json | *.jsonc | *.md | *.yml | *.yaml)
        [ -f "$resolved_path" ] || exit 0
        corepack yarn prettier --write "$resolved_path" 2>/dev/null || true
        ;;
esac

exit 0
