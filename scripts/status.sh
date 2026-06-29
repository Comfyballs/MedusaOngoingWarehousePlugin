#!/usr/bin/env bash
# superpowers-setup managed file. setup-version: 2. Do not edit by hand; re-run /init-project to update.
# Emit project status as TSV for the /status command: one H row per open
# milestone, one I row per open issue. Read-only — no GitHub or local writes.
# Stage is DERIVED (idea/specced/planned/in-progress), never a label. The single
# next-ready pick per milestone comes from ready-issues.sh, not reimplemented here.
# Cost: one `gh issue view` per open issue.
# Usage: status.sh [milestone]   # [milestone] = title to mark expanded; default = active
set -euo pipefail
want="${1:-}"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
here="$(dirname "$0")"

# Open milestones, lowest number first (milestones are phases: M0, M1, …).
titles="$(gh api "repos/$repo/milestones?state=open" --jq 'sort_by(.number)[].title')"

# Active = lowest-numbered milestone with >=1 open issue.
active=""
while IFS= read -r ms; do
  [ -z "$ms" ] && continue
  n="$(gh issue list --milestone "$ms" --state open --json number -q 'length')"
  if [ "$n" -gt 0 ]; then active="$ms"; break; fi
done <<< "$titles"

# Expand target: the named milestone if it exists, else the active one.
expand="$active"
if [ -n "$want" ]; then
  while IFS= read -r ms; do
    [ "$ms" = "$want" ] && expand="$want"
  done <<< "$titles"
fi

while IFS= read -r ms; do
  [ -z "$ms" ] && continue
  closed="$(gh issue list --milestone "$ms" --state closed --json number -q 'length')"
  open="$(gh issue list --milestone "$ms" --state open --json number -q 'length')"
  aflag="inactive"; [ "$ms" = "$expand" ] && aflag="active"
  next_line="$(bash "$here/ready-issues.sh" "$ms" | head -1 || true)"
  next_num="$(printf '%s' "$next_line" | cut -f1)"
  next_title="$(printf '%s' "$next_line" | cut -f2-)"
  printf 'H\t%s\t%s\t%s\t%s\t%s\t%s\n' "$ms" "$closed" "$open" "$aflag" "$next_num" "$next_title"

  gh issue list --milestone "$ms" --state open --json number,title,assignees,labels \
    -q '.[] | [(.number|tostring), .title, ((.assignees|length)>0|tostring), ((.labels|map(.name))|join(","))] | @tsv' \
  | while IFS=$'\t' read -r num title assigned labels; do
      view="$(gh issue view "$num" --json body,comments,closedByPullRequestsReferences \
              -q '"PR:" + ([.closedByPullRequestsReferences[]? | select(.state=="OPEN")] | length | tostring), (.body // ""), (.comments[].body // empty)')"
      haspr="$(printf '%s\n' "$view" | sed -n '1s/^PR://p')"
      all="$(printf '%s\n' "$view" | tail -n +2 \
             | grep -oE 'docs/[^[:space:])]*/(plans|specs)/[^[:space:])]+\.md' || true)"
      # Plan beats spec regardless of text order (stage precedence: planned › specced).
      doc="$(printf '%s\n' "$all" | grep '/plans/' | head -1 || true)"
      [ -z "$doc" ] && doc="$(printf '%s\n' "$all" | grep '/specs/' | head -1 || true)"
      stage="idea"
      case "$doc" in
        */plans/*) stage="planned" ;;
        */specs/*) stage="specced" ;;
      esac
      # in-progress: an assignee OR an open linked PR (spec line 45).
      { [ "$assigned" = "true" ] || [ "${haspr:-0}" -gt 0 ]; } && stage="in-progress"

      section="workable"; sflag=""
      case ",$labels," in
        *,status:backlog,*)  section="parked"; sflag="backlog" ;;
        *,status:deferred,*) section="parked"; sflag="deferred" ;;
      esac
      if [ "$section" = "workable" ]; then
        blk="$(gh api "repos/$repo/issues/$num/dependencies/blocked_by" \
                -q '[.[] | select(.state=="open")][0].number // empty' 2>/dev/null || true)"
        if [ -n "$blk" ]; then section="blocked"; sflag="blocked-by:#$blk"; fi
      fi
      [ "$section" = "workable" ] && [ "$num" = "$next_num" ] && sflag="ready"

      printf 'I\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$ms" "$num" "$title" "$stage" "$section" "$sflag" "$doc"
    done
done <<< "$titles"
