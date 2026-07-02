#!/usr/bin/env bash
# superpowers-setup managed file. setup-version: 7. Do not edit by hand; re-run /init-project to update.
# List ready issues in a milestone, highest priority first.
# Ready = open AND no open blocked-by deps AND not status:backlog/status:deferred.
# Readiness is derived from the native blocked-by graph, not a label.
# Usage: ready-issues.sh "<milestone>"
set -euo pipefail
ms="${1:?usage: ready-issues.sh <milestone>}"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

# Loud-fail guard: gh's --milestone is search-backed and returns 0 *silently*
# when the title is renamed/mistyped, so verify it resolves and warn if not.
if ! gh api "repos/$repo/milestones?state=all" --jq '.[].title' | grep -Fxq -- "$ms"; then
  echo "ready-issues.sh: milestone '$ms' not found in $repo (renamed/mistyped?)" >&2
fi

# Open, non-parked issues in the milestone, ranked by priority (high=0 … none=3).
# Filter client-side by exact milestone title rather than gh's search-backed
# --milestone flag (which silently returns 0 on a renamed/mistyped title).
# --limit 1000 caps the fetch — ample for one milestone's open issues.
MS="$ms" gh issue list --state open --limit 1000 --json number,title,labels,milestone \
  -q '.[] | select(.milestone.title == env.MS) | (.labels | map(.name)) as $l
      | select(($l | index("status:backlog") | not) and ($l | index("status:deferred") | not))
      | "\(if   ($l | index("priority:high"))   then 0
            elif ($l | index("priority:medium")) then 1
            elif ($l | index("priority:low"))    then 2
            else 3 end)\t\(.number)\t\(.title)"' \
| while IFS=$'\t' read -r rank num title; do
    # Drop any issue with at least one still-open blocker.
    blk="$(gh api "repos/$repo/issues/$num/dependencies/blocked_by" \
      -q '[.[] | select(.state=="open")] | length' 2>/dev/null || echo 0)"
    [ "${blk:-0}" -eq 0 ] && printf '%s\t%s\t%s\n' "$rank" "$num" "$title"
  done \
| sort -n -k1,1 \
| cut -f2-
