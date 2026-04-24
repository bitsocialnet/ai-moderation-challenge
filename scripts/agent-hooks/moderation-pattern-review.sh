#!/bin/bash

# afterFileEdit/stop hook: remind agents to re-check sensitive moderation changes.

set -u

input="$(cat)"
scope_prefixes=()

while [ "$#" -gt 0 ]; do
    case "$1" in
        --scope-prefix)
            scope_prefixes+=("${2:-}")
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root" || exit 0

extract_file_path() {
    if command -v jq >/dev/null 2>&1; then
        printf '%s' "$input" | jq -r '.file_path // empty' 2>/dev/null
        return
    fi

    printf '%s' "$input" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*:.*"\([^"]*\)"/\1/'
}

is_reviewed_file() {
    case "$1" in
        *.js | *.cjs | *.mjs | *.ts | *.tsx | *.json | *.md | *.yml | *.yaml) return 0 ;;
        *) return 1 ;;
    esac
}

matches_scope() {
    local candidate="$1"

    if [ "${#scope_prefixes[@]}" -eq 0 ]; then
        return 0
    fi

    local prefix
    for prefix in "${scope_prefixes[@]}"; do
        case "$candidate" in
            "$prefix"*) return 0 ;;
        esac
    done

    return 1
}

sensitive_pattern='(apiKey|authorization|Bearer|prompt(Path)?|cachePath|fetch[[:space:]]*\(|pendingApproval|ModelVerdictSchema|matchedRuleIndexes|community\.rules|writeFile|readFile|DEFAULT_MODEL|DEFAULT_API_URL|verdict)'

parse_matches_from_diff() {
    awk -v pattern="$sensitive_pattern" '
        /^\+\+\+ b\// {
            file = substr($0, 7)
            next
        }

        /^\+[^+]/ {
            line = substr($0, 2)
            if (line ~ pattern) {
                print file ": " line
            }
        }
    '
}

scan_untracked_file() {
    local file_path="$1"

    [ -f "$file_path" ] || return 0

    awk -v file="$file_path" -v pattern="$sensitive_pattern" '
        {
            line = $0
            if (line ~ pattern) {
                print file ": " line
            }
        }
    ' "$file_path"
}

append_results() {
    local existing="$1"
    local incoming="$2"

    if [ -z "$incoming" ]; then
        printf '%s' "$existing"
        return
    fi

    if [ -z "$existing" ]; then
        printf '%s' "$incoming"
        return
    fi

    printf '%s\n%s' "$existing" "$incoming"
}

results=""
file_path="$(extract_file_path)"

if [ -n "$file_path" ]; then
    if is_reviewed_file "$file_path" && matches_scope "$file_path"; then
        if git ls-files --others --exclude-standard -- "$file_path" | grep -q '.'; then
            results="$(scan_untracked_file "$file_path")"
        else
            diff_output="$(git diff --no-ext-diff --unified=0 --no-color HEAD -- "$file_path" 2>/dev/null || true)"
            results="$(printf '%s\n' "$diff_output" | parse_matches_from_diff)"
        fi
    fi
else
    diff_output="$(git diff --no-ext-diff --unified=0 --no-color HEAD -- '*.js' '*.cjs' '*.mjs' '*.ts' '*.tsx' '*.json' '*.md' '*.yml' '*.yaml' 2>/dev/null || true)"
    results="$(printf '%s\n' "$diff_output" | parse_matches_from_diff)"

    while IFS= read -r untracked_file; do
        [ -z "$untracked_file" ] && continue
        is_reviewed_file "$untracked_file" || continue
        matches_scope "$untracked_file" || continue
        file_results="$(scan_untracked_file "$untracked_file")"
        results="$(append_results "$results" "$file_results")"
    done < <(git ls-files --others --exclude-standard -- '*.js' '*.cjs' '*.mjs' '*.ts' '*.tsx' '*.json' '*.md' '*.yml' '*.yaml')
fi

results="$(printf '%s\n' "$results" | sed '/^$/d' | awk '!seen[$0]++')"

if [ -z "$results" ]; then
    exit 0
fi

echo "=== Moderation Safety Review Reminder ==="
echo "Sensitive moderation, provider, prompt, cache, or verdict terms were added in the current diff:"

match_count=0
while IFS= read -r match_line; do
    [ -z "$match_line" ] && continue
    match_count=$((match_count + 1))
    if [ "$match_count" -le 12 ]; then
        echo "- $match_line"
    fi
done <<< "$results"

if [ "$match_count" -gt 12 ]; then
    echo "- ... and $((match_count - 12)) more"
fi

echo "Questions to resolve before finishing:"
echo "- Does this preserve fail-closed behavior for provider errors and malformed model output?"
echo "- Are API keys, prompts, authorization headers, and raw publication content kept out of logs, public metadata, and persistent cache files?"
echo "- Does the change avoid fetching linked media or external URLs during moderation?"
echo "- Do Vitest assertions cover the changed request payload, response parsing, cache key, or branch behavior?"

exit 0
