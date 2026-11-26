#!/usr/bin/env python3
"""Every change considers the docs (F42, #96): a PR body carries a `Docs:` line naming the docs it updated, or
`Docs: none needed — <reason>`. CI runs this on every PR (docs.yml) with the body in $PR_BODY and the changed files on
stdin, one per line; it prints what's wrong and exits 1, else prints the docs line and exits 0.
  PR_BODY="..." git diff --name-only origin/main...HEAD | python3 tools/docs_check.py"""

import os
import re
import sys

NONE = re.compile(r"^none(\s+needed)?\b\s*[-—–:,;]?\s*(.*)$", re.I)


def docs_line(body):
    """the text after the first `Docs:` at the start of a line (markdown bold allowed), or None"""
    for line in (body or "").splitlines():
        m = re.match(r"^\s*(?:[-*]\s*)?\**docs\**\s*:\s*\**\s*(.*)$", line, re.I)
        if m:
            return m.group(1).strip()
    return None


def check(body, files):
    """the problems with this PR's docs line, given its changed files ([] when it's fine)"""
    line = docs_line(body)
    if line is None:
        return ["the PR body has no `Docs:` line: name the docs you updated, or `Docs: none needed — <reason>`"]
    if not line or "<" in line:
        return ["the `Docs:` line is still the template's placeholder: name the docs, or say none needed and why"]
    m = NONE.match(line)
    if m:
        reason = m.group(2).strip()
        return (
            []
            if len(reason) >= 10
            else ["`Docs: none needed` needs a reason (what you checked, and why nothing changes)"]
        )
    named = re.findall(r"[\w./-]+\.md\b", line)
    if not named:
        return [
            "the `Docs:` line names no document (e.g. `Docs: README.md, docs/STATUS.md`), or say none needed and why"
        ]
    files = [f.strip() for f in files if f.strip()]
    missing = [d for d in named if not any(f == d or f.endswith("/" + d) for f in files)]
    return ["named in `Docs:` but not changed in this PR: " + ", ".join(missing)] if missing else []


def main():
    problems = check(os.environ.get("PR_BODY", ""), sys.stdin.read().splitlines())
    for p in problems:
        print("::error::" + p)
    if not problems:
        print("Docs: " + docs_line(os.environ.get("PR_BODY", "")))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
