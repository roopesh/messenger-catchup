#!/bin/sh
# After a release PR is merged: tag the merge commit, build the skill ZIP from that tag, publish the GitHub release
# with the version's CHANGELOG entry as notes, and attach the userscript (installed userscripts update themselves from
# releases/latest/download/helper.user.js, so every release must carry it). Run on main: tools/release.sh
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
zip="$tmp/messenger-catchup/dist/messenger-catchup.zip"
zv=$(unzip -p "$zip" messenger-catchup/VERSION)
if [ "$zv" != "$v" ]; then git tag -d "$tag" >/dev/null; echo "release: ZIP says $zv, expected $v" >&2; exit 1; fi
us="$tmp/messenger-catchup/assets/helper.user.js"
[ -s "$us" ] || { git tag -d "$tag" >/dev/null; echo "release: no assets/helper.user.js in $tag" >&2; exit 1; }
git push -q origin "$tag"
printf '%s\n' "$notes" | gh release create "$tag" "$zip" "$us" --title "$tag" --notes-file - --verify-tag
