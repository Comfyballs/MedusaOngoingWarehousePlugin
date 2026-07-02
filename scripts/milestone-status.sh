#!/usr/bin/env bash
# superpowers-setup managed file. setup-version: 7. Do not edit by hand; re-run /init-project to update.
# Show open vs closed issue counts for a milestone. Usage: milestone-status.sh "<milestone>"
set -euo pipefail
ms="${1:?usage: milestone-status.sh <milestone>}"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
# Loud-fail guard: gh's --milestone is search-backed and returns 0 *silently*
# when the title is renamed/mistyped, so verify it resolves and warn if not.
if ! gh api "repos/$repo/milestones?state=all" --jq '.[].title' | grep -Fxq -- "$ms"; then
  echo "milestone-status.sh: milestone '$ms' not found in $repo (renamed/mistyped?)" >&2
fi
# Filter client-side by exact milestone title rather than gh's search-backed
# --milestone flag (silently returns 0 on a renamed/mistyped title). --limit 1000
# caps the fetch — ample for one milestone.
open=$(MS="$ms" gh issue list --state open  --limit 1000 --json number,milestone -q '[ .[] | select(.milestone.title == env.MS) ] | length')
closed=$(MS="$ms" gh issue list --state closed --limit 1000 --json number,milestone -q '[ .[] | select(.milestone.title == env.MS) ] | length')
echo "$ms: $closed closed, $open open"
# Ready is derived from the blocker graph, not a label. See ready-issues.sh.
bash "$(dirname "$0")/ready-issues.sh" "$ms" \
  | awk -F'\t' '{ printf "  ready: #%s %s\n", $1, $2 }'
