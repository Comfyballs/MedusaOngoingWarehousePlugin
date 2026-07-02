#!/usr/bin/env bash
# superpowers-setup managed file. setup-version: 7. Do not edit by hand; re-run /init-project to update.
# Manage native "blocked by" relationships between issues.
# Usage: issue-deps.sh block <issue> <blocker> | unblock <issue> <blocker> | list <issue>
set -euo pipefail
cmd="${1:-}"; issue="${2:-}"; blocker="${3:-}"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
case "$cmd" in
  block)
    blocker_id="$(gh api "repos/$repo/issues/$blocker" --jq .id)"
    gh api -X POST "repos/$repo/issues/$issue/dependencies/blocked_by" -F "issue_id=$blocker_id" ;;
  unblock)
    blocker_id="$(gh api "repos/$repo/issues/$blocker" --jq .id)"
    gh api -X DELETE "repos/$repo/issues/$issue/dependencies/blocked_by/$blocker_id" ;;
  list)    gh api "repos/$repo/issues/$issue/dependencies/blocked_by" ;;
  *) echo "usage: issue-deps.sh block|unblock|list <issue> [blocker]" >&2; exit 2 ;;
esac
