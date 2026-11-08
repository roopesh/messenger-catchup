#!/bin/sh
# Builds dist/messenger-catchup-plugin.zip (the plugin folder only) for claude.ai › Customize › Plugins › Add › Upload plugin.
# Works from a clone with any folder name: the files are staged under a folder named messenger-catchup.
set -e
root=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/messenger-catchup" "$root/dist"
cp -R "$root/plugin/." "$tmp/messenger-catchup/"
rm -f "$root/dist/messenger-catchup-plugin.zip"
(cd "$tmp" && zip -r -X -q "$root/dist/messenger-catchup-plugin.zip" messenger-catchup -x '*.DS_Store' '*__pycache__*')
echo "built $root/dist/messenger-catchup-plugin.zip"
