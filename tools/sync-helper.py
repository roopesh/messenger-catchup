#!/usr/bin/env python3
"""Keep the page's bookmarklet in sync with the refresh skill's assets/helper.user.js. (The userscript itself is installed from the GitHub
release and updates itself; the page only links to it.)
  tools/sync-helper.py          rewrite the #jump-bm bookmarklet textarea in assets/page.html
  tools/sync-helper.py --check  exit 1 if it differs from what the helper would generate (used by npm test)
The bookmarklet is the helper's mcJump IIFE (at any indent), lines stripped and
joined with spaces (so it must use /* */ comments only), then percent-encoded where a javascript: URL needs it (% ^ # and non-ASCII), then HTML-escaped."""

import html, re, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILL = os.path.join(ROOT, "plugin", "skills", "refresh")
HELPER = os.path.join(SKILL, "assets", "helper.user.js")
PAGE = os.path.join(SKILL, "assets", "page.html")


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


if __name__ == "__main__":
    src = open(HELPER, encoding="utf-8").read()
    page = open(PAGE, encoding="utf-8").read()
    new = generate(page, src)
    if "--check" in sys.argv:
        if new != page:
            sys.exit("page.html bookmarklet is out of date: run tools/sync-helper.py")
        print("bookmarklet in sync")
    elif new != page:
        open(PAGE, "w", encoding="utf-8").write(new)
        print("page.html updated")
    else:
        print("page.html already in sync")
