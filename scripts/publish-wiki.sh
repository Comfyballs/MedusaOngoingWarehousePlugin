#!/usr/bin/env bash
set -euo pipefail

# Publish docs/wiki/ to the GitHub wiki repo (<origin>.wiki.git).
#
# docs/wiki/ is the source of truth: pages are mirrored, and any page in the
# wiki that no longer exists in docs/wiki/ is deleted. Do not edit the live
# wiki directly — the next sync overwrites it.
#
# One-time prerequisite: GitHub only creates the .wiki.git repo after the wiki
# is initialized in the browser (wiki tab -> "Create the first page"; any
# content works, the first sync replaces it).

REPO_ROOT="$(git rev-parse --show-toplevel)"
SRC="$REPO_ROOT/docs/wiki"
ORIGIN_URL="$(git -C "$REPO_ROOT" remote get-url origin)"
WIKI_URL="${ORIGIN_URL%.git}.wiki.git"

# Derive the browser URL for the hint below (works for ssh and https remotes).
WEB_URL="${ORIGIN_URL%.git}"
WEB_URL="${WEB_URL/git@github.com:/https:\/\/github.com\/}"

[ -d "$SRC" ] || { echo "error: $SRC not found" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! git clone --depth 1 "$WIKI_URL" "$TMP/wiki" 2>/dev/null; then
  echo "error: could not clone $WIKI_URL" >&2
  echo "If this is the first publish, initialize the wiki once in the browser:" >&2
  echo "  $WEB_URL/wiki  ->  'Create the first page'" >&2
  exit 1
fi

rsync -a --delete --exclude ".git" "$SRC/" "$TMP/wiki/"

cd "$TMP/wiki"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "docs: sync wiki from docs/wiki @ $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  git push
  echo "Published to $WEB_URL/wiki"
else
  echo "Wiki already up to date."
fi
