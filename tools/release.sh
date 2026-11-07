#!/bin/sh
# After a release PR is merged: tag the merge commit, build the skill ZIP from that tag, publish the GitHub release
# with the version's CHANGELOG entry as notes. Run on main: tools/release.sh
set -e
cd "$(dirname "$0")/.."
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "release: switch to main first" >&2; exit 1; }
git fetch -q origin main --tags
git merge -q --ff-only origin/main
v=$(cat VERSION); tag="v$v"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then echo "release: $tag already exists" >&2; exit 1; fi
notes=$(awk -v h="## [$v] " 'index($0,h)==1{f=1;next} /^## \[/{f=0} f' CHANGELOG.md)
[ -n "$notes" ] || { echo "release: no CHANGELOG entry for $v" >&2; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/messenger-catchup"
git tag -a "$tag" -m "$tag"
git archive "$tag" | tar -x -C "$tmp/messenger-catchup"
sh "$tmp/messenger-catchup/make-zip.sh" >/dev/null
zv=$(unzip -p "$tmp/messenger-catchup.zip" messenger-catchup/VERSION)
if [ "$zv" != "$v" ]; then git tag -d "$tag" >/dev/null; echo "release: ZIP says $zv, expected $v" >&2; exit 1; fi
git push -q origin "$tag"
printf '%s\n' "$notes" | gh release create "$tag" "$tmp/messenger-catchup.zip" --title "$tag" --notes-file - --verify-tag
