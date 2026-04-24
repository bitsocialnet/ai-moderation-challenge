#!/bin/bash

set -euo pipefail

run_smoke=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --smoke)
            run_smoke=1
            ;;
        *)
            echo "Unknown argument: $1" >&2
            echo "Usage: ./scripts/agent-init.sh [--smoke]" >&2
            exit 1
            ;;
    esac
    shift
done

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

echo "Repo root: $repo_root"

if [ -f "yarn.lock" ] && { [ ! -d "node_modules" ] || [ -z "$(ls -A node_modules 2>/dev/null | head -1)" ]; }; then
    echo "node_modules missing - running corepack yarn install..."
    corepack yarn install
fi

if [ "$run_smoke" -eq 1 ]; then
    echo "Running smoke verification..."
    corepack yarn build
    corepack yarn type-check
    corepack yarn test
    corepack yarn format:check
fi
