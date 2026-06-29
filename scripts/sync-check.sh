#!/usr/bin/env bash
# superpowers-setup managed file. setup-version: 2. Do not edit by hand; re-run /init-project to update.
# Warn if the current branch is behind its upstream. Run before working an existing branch.
set -euo pipefail
git fetch -q
branch="$(git rev-parse --abbrev-ref HEAD)"
if git rev-parse --verify -q "origin/$branch" >/dev/null; then
  behind=$(git rev-list --count "HEAD..origin/$branch")
  if [ "$behind" -gt 0 ]; then
    echo "Behind origin/$branch by $behind commit(s). Rebase before committing." >&2
    exit 1
  fi
fi
echo "Up to date."
