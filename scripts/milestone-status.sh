#!/usr/bin/env bash
# superpowers-setup managed file. setup-version: 2. Do not edit by hand; re-run /init-project to update.
# Show open vs closed issue counts for a milestone. Usage: milestone-status.sh "<milestone>"
set -euo pipefail
ms="${1:?usage: milestone-status.sh <milestone>}"
open=$(gh issue list --milestone "$ms" --state open  --json number -q 'length')
closed=$(gh issue list --milestone "$ms" --state closed --json number -q 'length')
echo "$ms: $closed closed, $open open"
# Ready is derived from the blocker graph, not a label. See ready-issues.sh.
bash "$(dirname "$0")/ready-issues.sh" "$ms" \
  | awk -F'\t' '{ printf "  ready: #%s %s\n", $1, $2 }'
