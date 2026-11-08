#!/usr/bin/env python3
"""Generated copies, kept in sync (npm run sync; npm test runs --check):
1. The page's bookmarklet, from the refresh skill's assets/helper.user.js. (The userscript itself is installed from the
   GitHub release and updates itself; the page only links to it.)
2. The setup skill's copies of the refresh skill's shared files (SHARED). A skill can only count on its own folder, so
   setup carries its own copy. Edit the refresh skill's file; never the copy.
  tools/sync.py          rewrite the #jump-bm bookmarklet textarea, then refresh the copies
  tools/sync.py --check  exit 1 if anything differs from what it would generate
The bookmarklet is the helper's mcJump IIFE (at any indent), lines stripped and
joined with spaces (so it must use /* */ comments only), then percent-encoded where a javascript: URL needs it (% ^ # and non-ASCII), then HTML-escaped."""

import html, re, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILL = os.path.join(ROOT, "plugin", "skills", "refresh")
SETUP = os.path.join(ROOT, "plugin", "skills", "setup")
HELPER = os.path.join(SKILL, "assets", "helper.user.js")
PAGE = os.path.join(SKILL, "assets", "page.html")
SHARED = [os.path.join("assets", "page.html"), os.path.join("references", "database.md")]


def bookmarklet(src):
    m = re.search(r"^([ \t]*)\(async function mcJump\(\) ?\{\n.*?^\1\}\)\(\);$", src, re.S | re.M)
    assert m, "mcJump IIFE not found in the helper"
    js = " ".join(l.strip() for l in m.group(0).split("\n"))
    enc = "".join(c if c.isascii() and c not in "%^#" else "".join("%%%02X" % b for b in c.encode()) for c in js)
    return "javascript:" + enc


def generate(page, src):
    out = page
    for tid, val in (("jump-bm", bookmarklet(src)),):
        pat = re.compile(r'(<textarea id="%s"[^>]*>)(.*?)(</textarea>)' % tid, re.S)
        assert len(pat.findall(out)) == 1, "expected one #%s textarea" % tid
        out = pat.sub(lambda m: m.group(1) + html.escape(val) + m.group(3), out)
    return out


def read(p):
    try:
        return open(p, encoding="utf-8").read()
    except FileNotFoundError:
        return None


def stale_copies():
    """The setup skill's copies that differ from (or are missing next to) the refresh skill's files."""
    return [f for f in SHARED if read(os.path.join(SETUP, f)) != read(os.path.join(SKILL, f))]


if __name__ == "__main__":
    src = open(HELPER, encoding="utf-8").read()
    page = open(PAGE, encoding="utf-8").read()
    new = generate(page, src)
    if "--check" in sys.argv:
        if new != page:
            sys.exit("page.html bookmarklet is out of date: run npm run sync")
        if stale_copies():
            sys.exit("setup skill copies out of date (%s): run npm run sync" % ", ".join(stale_copies()))
        print("bookmarklet and setup copies in sync")
        sys.exit(0)
    if new != page:
        open(PAGE, "w", encoding="utf-8").write(new)
        print("page.html updated")
    for f in stale_copies():
        os.makedirs(os.path.dirname(os.path.join(SETUP, f)), exist_ok=True)
        open(os.path.join(SETUP, f), "w", encoding="utf-8").write(read(os.path.join(SKILL, f)))
        print("setup/" + f + " updated")
