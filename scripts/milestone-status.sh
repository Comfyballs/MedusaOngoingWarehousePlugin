#!/usr/bin/env bash
# superpowers-setup managed file. setup-version: 5. Do not edit by hand; re-run /init-project to update.
# Show open vs closed issue counts for a milestone. Usage: milestone-status.sh "<milestone>"
set -euo pipefail
ms="${1:?usage: milestone-status.sh <milestone>}"
# LOCAL PATCH (gh milestone-filter bug): `gh issue list --milestone` returns 0 in
# this environment (gh 2.93.0), so filter by milestone title client-side. Report upstream.
open=$(MS="$ms"  gh issue list --state open   --limit 1000 --json number,milestone -q '[.[] | select(.milestone.title == env.MS)] | length')
closed=$(MS="$ms" gh issue list --state closed --limit 1000 --json number,milestone -q '[.[] | select(.milestone.title == env.MS)] | length')
echo "$ms: $closed closed, $open open"
# Ready is derived from the blocker graph, not a label. See ready-issues.sh.
bash "$(dirname "$0")/ready-issues.sh" "$ms" \
  | awk -F'\t' '{ printf "  ready: #%s %s\n", $1, $2 }'
