#!/bin/sh
# Prepare a fresh cc-mods worktree for tsc/eslint/tests.
# - .claude-plugin/types is gitignored and written by Claude Code into the main
#   checkout only, so copy it (without it tsc reports ~390 bogus errors).
# - A plain `bun install` hangs at "Resolving dependencies" here; with the main
#   checkout's bun.lock (gitignored too) it installs in ~3s.
# node_modules is a real install, not a symlink to the main checkout: `rm -r`
# on such a symlink would delete the main checkout's node_modules.
set -eu
main=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
[ "$main" = "$(git rev-parse --show-toplevel)" ] && { echo "main checkout: nothing to do"; exit 0; }
[ -d .claude-plugin/types ] || cp -R "$main/.claude-plugin/types" .claude-plugin/types
[ -f bun.lock ] || cp "$main/bun.lock" bun.lock
bun install --frozen-lockfile
