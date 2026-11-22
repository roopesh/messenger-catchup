#!/bin/sh
# tools/ci-green.sh SHA: exit 0 only if main's CI for that exact commit finished green on its first attempt. A re-run
# that went green isn't a pass: find why the first attempt failed and fix it in a new PR, or tell the owner. Used by
# tools/release.sh before it tags anything (CLAUDE.md > Every change, steps 5-6).
sha=$1
[ -n "$sha" ] || { echo "ci-green: usage: tools/ci-green.sh SHA" >&2; exit 2; }
ci=$(gh run list --workflow ci --branch main --event push --commit "$sha" --limit 1 \
  --json databaseId,status,conclusion,attempt -q '.[0] | "\(.databaseId) \(.status) \(.conclusion) \(.attempt)"') || exit 1
[ -n "$ci" ] || { echo "release: no CI run on main for $sha yet; wait for it (gh run list --branch main)" >&2; exit 1; }
set -- $ci
[ "$2" = completed ] || { echo "release: main's CI for $sha is still running; watch it: gh run watch $1" >&2; exit 1; }
[ "$3" = success ] || { echo "release: main's CI for $sha failed (run $1); fix the cause in a new PR, or tell the owner" >&2; exit 1; }
[ "$4" = 1 ] || { echo "release: main's CI for $sha passed only on attempt $4 (run $1); a re-run isn't a pass: fix why attempt 1 failed, or tell the owner" >&2; exit 1; }
echo "ci-green: main's CI for $sha passed on its first attempt (run $1)"
