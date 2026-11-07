#!/bin/sh
# Builds messenger-catchup.zip (the skill folder only) for Customize › Skills › Upload a skill.
set -e
cd "$(dirname "$0")/.."
rm -f messenger-catchup.zip
zip -r -X messenger-catchup.zip messenger-catchup/SKILL.md messenger-catchup/VERSION messenger-catchup/assets messenger-catchup/scripts >/dev/null
echo "built $(pwd)/messenger-catchup.zip"
