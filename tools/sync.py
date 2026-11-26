#!/usr/bin/env python3
"""Generated copies, kept in sync (npm run sync; npm test runs --check):
1. The page's bookmarklet and its HELPER_VERSION, from the refresh skill's assets/helper.user.js. (The userscript itself is installed from the
   GitHub release and updates itself; the page only links to it.)
1b. The page's REACTIONS_MD: the meaning table and rules from the refresh skill's references/reactions.md, between its
   two markers (B67), so the page's Ask and the summary build read the same ones.
2. The setup and replies skills' copies of the refresh skill's shared files (SHARED, REPLIES_SHARED). A skill can only
   count on its own folder, so each carries its own copy. Edit the refresh skill's file; never a copy.
  tools/sync.py          rewrite the #jump-bm bookmarklet textarea, then refresh the copies
  tools/sync.py --check  exit 1 if anything differs from what it would generate
The bookmarklet is the helper's mcJump IIFE (at any indent), lines stripped and
joined with spaces (so it must use /* */ comments only), then percent-encoded where a javascript: URL needs it (% ^ # and non-ASCII), then HTML-escaped."""

import html, re, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILL = os.path.join(ROOT, "plugin", "skills", "refresh")
SETUP = os.path.join(ROOT, "plugin", "skills", "setup")
REPLIES = os.path.join(ROOT, "plugin", "skills", "replies")
HELPER = os.path.join(SKILL, "assets", "helper.user.js")
PAGE = os.path.join(SKILL, "assets", "page.html")
REACTIONS = os.path.join(SKILL, "references", "reactions.md")
SHARED = [
    os.path.join("assets", "page.html"),
    os.path.join("references", "database.md"),
    os.path.join("references", "scheduling.md"),
]
# what a reply-only run (the replies skill) may need: posting, the helper to inject, and the files those name
REPLIES_SHARED = [
    os.path.join("assets", "helper.user.js"),
    os.path.join("references", "database.md"),
    os.path.join("references", "helper.md"),
    os.path.join("references", "outbox.md"),
    os.path.join("references", "posting-with-helper.md"),
]
COPIES = {SETUP: SHARED, REPLIES: REPLIES_SHARED}


def bookmarklet(src):
    m = re.search(r"^([ \t]*)\(async function mcJump\(\) ?\{\n.*?^\1\}\)\(\);$", src, re.S | re.M)
    assert m, "mcJump IIFE not found in the helper"
    js = " ".join(l.strip() for l in m.group(0).split("\n"))
    enc = "".join(c if c.isascii() and c not in "%^#" else "".join("%%%02X" % b for b in c.encode()) for c in js)
    return "javascript:" + enc


def reactions_part(md):
    """The part of references/reactions.md the page carries (B67): the meaning table and the rules for reading them."""
    m = re.search(r"<!-- the page's copy starts here -->\n(.*?)\n<!-- the page's copy ends here -->", md, re.S)
    assert m, "the page's copy markers not found in references/reactions.md"
    return m.group(1)


def generate(page, src, rx=None):
    out = page
    # B67: the reaction meanings, as a JS template literal (Prettier leaves its text alone)
    if rx is None:
        with open(REACTIONS, encoding="utf-8") as f:
            rx = f.read()
    js = reactions_part(rx).replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
    pat = re.compile(r"(const REACTIONS_MD = `)((?:\\.|[^`\\])*)(`;)", re.S)
    assert len(pat.findall(out)) == 1, "expected one REACTIONS_MD in the page"
    out = pat.sub(lambda m: m.group(1) + js + m.group(3), out)
    for tid, val in (("jump-bm", bookmarklet(src)),):
        pat = re.compile(r'(<textarea id="%s"[^>]*>)(.*?)(</textarea>)' % tid, re.S)
        assert len(pat.findall(out)) == 1, "expected one #%s textarea" % tid
        out = pat.sub(lambda m: m.group(1) + html.escape(val) + m.group(3), out)
    # the helper version the page compares each Chrome's with (its update notices)
    ver = re.search(r"@version\s+(\S+)", src)
    assert ver, "@version not found in the helper"
    pat = re.compile(r'(const HELPER_VERSION = ")[^"]*(";)')
    assert len(pat.findall(out)) == 1, "expected one HELPER_VERSION in the page"
    out = pat.sub(lambda m: m.group(1) + ver.group(1) + m.group(2), out)
    return out


def read(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return None


def stale_copies():
    """The copies (as "<skill>/<path>") that differ from, or are missing next to, the refresh skill's files."""
    return [
        os.path.join(os.path.basename(dst), f)
        for dst, files in COPIES.items()
        for f in files
        if read(os.path.join(dst, f)) != read(os.path.join(SKILL, f))
    ]


if __name__ == "__main__":
    with open(HELPER, encoding="utf-8") as f:
        src = f.read()
    with open(PAGE, encoding="utf-8") as f:
        page = f.read()
    new = generate(page, src)
    if "--check" in sys.argv:
        if new != page:
            sys.exit("page.html is out of date (bookmarklet, HELPER_VERSION or REACTIONS_MD): run npm run sync")
        if stale_copies():
            sys.exit("skill copies out of date (%s): run npm run sync" % ", ".join(stale_copies()))
        print("page and skill copies in sync")
        sys.exit(0)
    if new != page:
        with open(PAGE, "w", encoding="utf-8") as f:
            f.write(new)
        print("page.html updated")
    for f in stale_copies():
        skill, rel = f.split(os.sep, 1)
        dst = os.path.join(ROOT, "plugin", "skills", f)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "w", encoding="utf-8") as out:
            out.write(read(os.path.join(SKILL, rel)))
        print(skill + "/" + rel + " updated")
