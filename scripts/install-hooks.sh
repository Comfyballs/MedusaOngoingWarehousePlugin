#!/usr/bin/env bash
# superpowers-setup managed file. setup-version: 5. Do not edit by hand; re-run /init-project to update.
# Install the repo's pre-push hook.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
# Resolve the real hooks dir via git so worktrees and submodules (where .git is a
# file, not a directory) work too.
hooks_dir="$(git rev-parse --git-path hooks)"
mkdir -p "$hooks_dir"
ln -sf "$root/scripts/pre-push" "$hooks_dir/pre-push"
chmod +x "$root/scripts/pre-push"
echo "pre-push hook installed."
