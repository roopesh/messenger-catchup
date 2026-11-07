#!/bin/sh
# Builds dist/messenger-catchup.zip (the skill folder only) for Customize › Skills › Upload a skill.
# Works from a clone with any folder name: the files are staged under a folder named messenger-catchup.
set -e
root=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/messenger-catchup" "$root/dist"
cp -R "$root/SKILL.md" "$root/VERSION" "$root/assets" "$root/scripts" "$root/references" "$tmp/messenger-catchup/"
rm -f "$root/dist/messenger-catchup.zip"
(cd "$tmp" && zip -r -X -q "$root/dist/messenger-catchup.zip" messenger-catchup -x '*.DS_Store' '*__pycache__*')
echo "built $root/dist/messenger-catchup.zip"
