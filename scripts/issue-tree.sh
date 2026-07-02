#!/usr/bin/env bash
# superpowers-setup managed file. setup-version: 7. Do not edit by hand; re-run /init-project to update.
# Manage native sub-issues (epic -> task) and print the tree with rollup.
# Usage: issue-tree.sh add <parent> <child> | remove <parent> <child> | show <parent>
set -euo pipefail
cmd="${1:-}"; parent="${2:-}"; child="${3:-}"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
case "$cmd" in
  add)
    child_id="$(gh api "repos/$repo/issues/$child" --jq .id)"
    gh api -X POST "repos/$repo/issues/$parent/sub_issues" -F "sub_issue_id=$child_id" ;;
  remove)
    child_id="$(gh api "repos/$repo/issues/$child" --jq .id)"
    gh api -X DELETE "repos/$repo/issues/$parent/sub_issue" -F "sub_issue_id=$child_id" ;;
  show)
    gh issue view "$parent" --json number,title,state -q '"#\(.number) \(.title) [\(.state)]"'
    gh api "repos/$repo/issues/$parent/sub_issues" \
      -q '.[] | "  #\(.number) \(.title) [\(.state)]"' ;;
  *) echo "usage: issue-tree.sh add|remove|show <parent> [child]" >&2; exit 2 ;;
esac
