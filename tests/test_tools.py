"""Repo-level checks: helper copies in sync, the sync tool itself, the plugin and its ZIP, and SKILL.md's file references.
Run: python3 -m unittest discover -s tests"""

import collections, contextlib, html, importlib.util, io, json, os, re, shutil, subprocess, tempfile, unittest, urllib.parse, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("sync_helper", os.path.join(ROOT, "tools", "sync.py"))
sync = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sync)


SKILL = os.path.join("plugin", "skills", "refresh")
SETUP = os.path.join("plugin", "skills", "setup")
REPLIES = os.path.join("plugin", "skills", "replies")
REPLY_CHECK = os.path.join("plugin", "skills", "reply-check")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as fh:
        return fh.read()


def in_skill(*p):
    return read(SKILL, *p)


def in_setup(*p):
    return read(SETUP, *p)


def in_replies(*p):
    return read(REPLIES, *p)


REFERENCES = [
    "chats.md",
    "database.md",
    "day-summaries.md",
    "first-run.md",
    "groups.md",
    "helper.md",
    "open-message.md",
    "outbox.md",
    "people.md",
    "photos.md",
    "posting-with-helper.md",
    "reports.md",
    "restoring-a-summary.md",
    "scheduling.md",
    "troubleshooting.md",
    "updating-the-page.md",
    "writing-the-build.md",
]
SHIPPED = ["SKILL.md", "assets/page.html", "assets/helper.user.js", "scripts/catchup.py"] + [
    "references/" + f for f in REFERENCES
]
# keys of a JS object literal, shorthand ones included ({text, state: "x"})
OBJ_KEYS = r"(?:^|[{,])\s*(\w+)\s*(?=[:,}])"
SETUP_SHIPPED = ["SKILL.md", "assets/page.html", "references/database.md", "references/scheduling.md"]
REPLIES_SHIPPED = [
    "SKILL.md",
    "assets/helper.user.js",
    "references/database.md",
    "references/helper.md",
    "references/outbox.md",
    "references/posting-with-helper.md",
]
REPLY_CHECK_SHIPPED = ["SKILL.md"]


class TestHelperCopies(unittest.TestCase):
    def setUp(self):
        self.src = in_skill("assets", "helper.user.js")
        self.page = in_skill("assets", "page.html")

    def textarea(self, page, tid):
        return html.unescape(re.search(r'<textarea id="%s"[^>]*>(.*?)</textarea>' % tid, page, re.S).group(1))

    def test_page_in_sync(self):
        self.assertEqual(sync.generate(self.page, self.src), self.page, "run npm run sync")

    def test_page_installs_the_userscript_from_the_release(self):
        """The page links the userscript's release URL (no embedded copy), and the helper updates itself from that URL."""
        url = "https://github.com/roopesh/messenger-catchup/releases/latest/download/helper.user.js"
        self.assertNotIn('id="jump-us"', self.page)
        self.assertRegex(self.page, r'<a\s+id="us-install"\s+href="%s"' % re.escape(url))
        self.assertEqual(re.search(r"^// @updateURL\s+(\S+)$", self.src, re.M).group(1), url)
        self.assertEqual(re.search(r"^// @downloadURL\s+(\S+)$", self.src, re.M).group(1), url)

    def test_release_attaches_the_userscript(self):
        rel = read("tools", "release.sh")
        self.assertRegex(rel, r'gh release create "\$tag" "\$zip" "\$us"')
        self.assertIn("helper.user.js", rel)

    def test_bookmarklet_is_the_jump_code(self):
        bm = self.textarea(self.page, "jump-bm")
        self.assertRegex(bm, r"^javascript:\(async function mcJump\(\) ?\{")
        self.assertNotIn("//", bm.replace("://", ""), "a // comment would swallow the rest of the one-line bookmarklet")
        js = urllib.parse.unquote(bm[len("javascript:") :])
        body = re.search(r"^([ \t]*)\(async function mcJump\(\) ?\{\n.*?^\1\}\)\(\);$", self.src, re.S | re.M).group(0)
        self.assertEqual(js, " ".join(l.strip() for l in body.split("\n")))

    def test_bookmarklet_encoding(self):
        bm = self.textarea(self.page, "jump-bm")
        self.assertNotRegex(bm[len("javascript:") :], r"%(?![0-9A-F]{2})", "bare % would break the URL")
        self.assertNotIn("#", bm)
        self.assertNotIn("^", bm)
        self.assertTrue(bm.isascii())

    def test_generate_follows_helper_edits(self):
        edited = self.src.replace("say('Jump: found it.')", "say('Jump: found it!')")
        self.assertNotEqual(edited, self.src)
        out = sync.generate(self.page, edited)
        self.assertIn("found it!", urllib.parse.unquote(self.textarea(out, "jump-bm")))
        self.assertEqual(sync.generate(out, edited), out, "generate is not idempotent")

    def test_page_helper_version_follows_the_helper(self):
        """v1.35.1: the page compares each Chrome's helper with the one it shipped with, written by sync."""
        ver = re.search(r"@version\s+(\S+)", self.src).group(1)
        self.assertIn('const HELPER_VERSION = "%s";' % ver, self.page)
        edited = self.src.replace("@version      " + ver, "@version      9.9")
        self.assertNotEqual(edited, self.src)
        self.assertIn('const HELPER_VERSION = "9.9";', sync.generate(self.page, edited))

    def test_check_mode_exit_code(self):
        p = subprocess.run(
            ["python3", os.path.join(ROOT, "tools", "sync.py"), "--check"], capture_output=True, text=True
        )
        self.assertEqual(p.returncode, 0, p.stderr)


class TestVersions(unittest.TestCase):
    def test_helper_version_strings_agree(self):
        src = in_skill("assets", "helper.user.js")
        found = {
            re.search(r"@version\s+(\S+)", src).group(1),
            re.search(r"__mcHelper\s*=\s*'([^']+)'", src).group(1),
            re.search(r"setAttribute\('data-mc-helper',\s*'([^']+)'\)", src).group(1),
            re.search(r"ping:\s*\(\)\s*=>\s*\(\{\s*v:\s*'([^']+)'\s*\}\)", src).group(1),
        }
        self.assertEqual(len(found), 1, found)

    def test_page_has_no_document_skeleton(self):
        """The Artifact tool adds the skeleton at publish time and only recognizes its own exact one, so the page stores none."""
        page = in_skill("assets", "page.html")
        self.assertTrue(page.startswith("<title>"), page[:60])
        self.assertNotRegex(page, r"(?i)<!doctype|<html[\s>]|<body[\s>]")

    def test_component_versions_read_the_same_as_decimals(self):
        """Minor parts stay one digit (1.9 -> 2.0, never 1.10): read as decimals, 1.1 and 1.10 look equal and a
        republish or update notice could be skipped."""
        page, src = in_skill("assets", "page.html"), in_skill("assets", "helper.user.js")
        for name, v in (
            ("PAGE_VERSION", re.search(r'const PAGE_VERSION\s*=\s*"([^"]+)"', page).group(1)),
            ("helper @version", re.search(r"@version\s+(\S+)", src).group(1)),
        ):
            self.assertRegex(v, r"^\d+\.\d$", name + " " + v)

    def test_page_version_present(self):
        self.assertRegex(in_skill("assets", "page.html"), r'const PAGE_VERSION\s*=\s*"\d+\.\d+";')

    def test_page_version_bumped_when_page_changed_since_last_release(self):
        """assets/page.html differs from the newest release tag -> PAGE_VERSION must differ too (pages only republish on a bump)."""
        tags = subprocess.run(
            ["git", "tag", "--list", "v*", "--sort=-v:refname"], cwd=ROOT, capture_output=True, text=True
        ).stdout.split()
        if not tags:
            self.skipTest("no release tags (shallow clone?)")
        for path in (SKILL + "/assets/page.html", "assets/page.html"):  # before v1.15.0 the skill sat at the repo root
            old = subprocess.run(["git", "show", tags[0] + ":" + path], cwd=ROOT, capture_output=True, text=True)
            if not old.returncode:
                break
        if old.returncode:
            self.skipTest("page not in " + tags[0])
        ver = lambda s: re.search(r'const PAGE_VERSION\s*=\s*"([^"]+)"', s).group(1)
        if old.stdout != in_skill("assets", "page.html"):
            self.assertNotEqual(
                ver(old.stdout),
                ver(in_skill("assets", "page.html")),
                "page.html changed since " + tags[0] + " but PAGE_VERSION did not",
            )


class TestReleaseVersion(unittest.TestCase):
    """VERSION is the release version; package.json, its lockfile and the newest CHANGELOG entry must match it."""

    def setUp(self):
        self.v = read("VERSION").strip()

    def test_semver(self):
        self.assertRegex(self.v, r"^\d+\.\d+\.\d+$")

    def test_package_json(self):
        import json

        self.assertEqual(json.loads(read("package.json"))["version"], self.v)
        lock = json.loads(read("package-lock.json"))
        self.assertEqual(lock["version"], self.v)
        self.assertEqual(lock["packages"][""]["version"], self.v)

    def test_changelog_top_entry(self):
        top = re.search(r"^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d\d-\d\d)$", read("CHANGELOG.md"), re.M)
        self.assertTrue(top, 'CHANGELOG.md needs "## [X.Y.Z] - YYYY-MM-DD" entries')
        self.assertEqual(top.group(1), self.v, "newest CHANGELOG entry must be VERSION")

    def test_status_names_the_release(self):
        """docs/STATUS.md is the handoff: its release line names this VERSION and the page and helper it ships, so every
        PR updates it (it once said v1.21.0 with page 2.5 and helper 2.0 while v1.53.1 shipped page 6.0 and helper 3.8)."""
        line = re.search(
            r"^- \*\*Release: (v\S+)\*\* \(page `PAGE_VERSION` (\S+), helper (\S+)\)\.", read("docs", "STATUS.md"), re.M
        )
        self.assertTrue(
            line, "docs/STATUS.md needs its line '- **Release: vX.Y.Z** (page `PAGE_VERSION` A.B, helper C.D).'"
        )
        page = re.search(r'const PAGE_VERSION\s*=\s*"([^"]+)"', in_skill("assets", "page.html")).group(1)
        helper = re.search(r"@version\s+(\S+)", in_skill("assets", "helper.user.js")).group(1)
        self.assertEqual(line.groups(), ("v" + self.v, page, helper), "update docs/STATUS.md's release line")

    def test_changelog_versions_descend(self):
        vs = [tuple(map(int, v.split("."))) for v in re.findall(r"^## \[(\d+\.\d+\.\d+)\]", read("CHANGELOG.md"), re.M)]
        self.assertEqual(vs, sorted(vs, reverse=True))
        self.assertEqual(len(vs), len(set(vs)), "duplicate CHANGELOG version")


class TestNoLeftoverNames(unittest.TestCase):
    def test_no_pa_names_in_shipped_files(self):
        for f in (
            [os.path.join(SKILL, f) for f in SHIPPED]
            + [os.path.join(SETUP, f) for f in SETUP_SHIPPED]
            + [os.path.join(REPLIES, f) for f in REPLIES_SHIPPED]
            + [os.path.join(REPLY_CHECK, f) for f in REPLY_CHECK_SHIPPED]
        ):
            self.assertNotRegex(read(f), r"\bcc(Scan|Verify|Capture)\b|cctool|cc-capture|cc-cmd|cc_result", f)


class TestSkillReferences(unittest.TestCase):
    def test_every_db_path_the_page_uses_is_documented(self):
        page, skill = in_skill("assets", "page.html"), in_skill("SKILL.md") + in_skill("references", "database.md")
        paths = set(re.findall(r'db\s*\.(?:collection|doc)\(\s*"([^"]+)"\s*\)', page))
        self.assertGreater(len(paths), 10)
        for p in paths:
            top = p.split("/")[0]
            self.assertTrue(("`%s`" % p in skill) or ("`%s/" % top in skill), "SKILL.md never mentions " + p)

    def test_database_md_documents_sent(self):
        """The page saves what each answer and view read (F6); a later Claude reading qa/* has to know an answer rested
        on summaries, so the field and its parts are documented on their own line."""
        page, db = in_skill("assets", "page.html"), in_skill("references", "database.md")
        self.assertIn("row.sent = Object.assign({}, sent, sr)", page)
        self.assertIn("v.sent = sent", page)
        line = re.search(r"^- `sent` on `qa/\*` and `views/\*`.*$", db, re.M)
        self.assertTrue(line, "database.md has no line for sent")
        self.assertIn("afterFrom:", page)
        for part in ("`from`", "`to`", "`sumFrom`", "`afterFrom`"):
            self.assertIn(part.strip("`"), line.group(0))
        # F17: a Look deeper answer saves another shape; a later Claude must not read #from-#to as all read
        self.assertIn("stretches:", page)
        self.assertIn("wanted:", page)
        for part in ('scope:"deeper"', "{from, to, stretches, wanted}", "outer bounds, not all read"):
            self.assertIn(part, line.group(0))
        # F32: with search tools, what Claude searched and read with them
        self.assertIn("searches: rec.searches.map", page)
        for part in ("`searches`", "`reads`", "[{q, n, from?, to?, sender?}]"):
            self.assertIn(part, line.group(0))

    def test_every_meta_chat_field_the_page_writes_is_documented(self):
        """Anchored on each doc("meta/chat").update(...): an object literal, or a variable traced back to its literal,
        the fields assigned to it before the write, and (for setMarker's Object.assign) what its callers pass."""
        page, skill = in_skill("assets", "page.html"), in_skill("references", "database.md")
        fields = set()

        def keys(lit):
            return set(re.findall(OBJ_KEYS, lit))

        def resolve(name, pos):
            defs = list(re.finditer(r"const %s\s*=\s*(Object\.assign\()?(\{[^{}]*\})" % name, page[:pos]))
            if not defs:
                alias = list(re.finditer(r"\b%s\s*=\s*(\w+);" % name, page[:pos]))
                self.assertTrue(alias, "can't trace the meta/chat write of " + name)
                return resolve(alias[-1].group(1), alias[-1].start())
            d = defs[-1]
            fields.update(keys(d.group(2)))
            fields.update(re.findall(r"\b%s\.(\w+)\s*=" % name, page[d.end() : pos]))
            if d.group(1):
                for lit in re.findall(r"setMarker\(\"\w+\",\s*(\{[^{}]*\})", page):
                    fields.update(keys(lit))

        writes = list(re.finditer(r'doc\("meta/chat"\)\s*\.update\((\{[^{}]*\}|\w+)\)', page))
        self.assertGreaterEqual(len(writes), 4, "the page's meta/chat writes moved; update this test")
        for w in writes:
            if w.group(1).startswith("{"):
                fields.update(keys(w.group(1)))
            else:
                resolve(w.group(1), w.start())
        self.assertTrue(
            {"lastI", "ownLastMid", "markerTo", "caughtUpAt", "markerSetAt", "anchorMids"} <= fields, fields
        )
        # the meta/chat line, plus the lines of their own for fields added later (`meta/chat.photosOwed`, ...)
        meta = re.search(r"^- `meta/chat`:(.*)$", skill, re.M).group(1)
        meta += " ".join("`%s`" % f for f in re.findall(r"^- `meta/chat\.(\w+)`", skill, re.M))
        for f in fields:
            self.assertIn("`%s`" % f, meta, "meta/chat field not documented in references/database.md: " + f)

    def test_every_referenced_file_exists(self):
        text = in_skill("SKILL.md") + "".join(in_skill("references", f) for f in REFERENCES)
        refs = set(re.findall(r"`((?:assets|scripts|references)/[\w.\-]+)`", text))
        self.assertTrue(refs)
        for r in refs:
            self.assertTrue(os.path.exists(os.path.join(ROOT, SKILL, r)), r)

    def test_skill_names_every_reference_file(self):
        """Claude only opens a reference file SKILL.md tells it about, or one a reference it names tells it about (rare
        procedures, kept out of SKILL.md, which is read on every refresh); an unnamed file would never be read."""
        skill = in_skill("SKILL.md")
        self.assertEqual(sorted(os.listdir(os.path.join(ROOT, SKILL, "references"))), REFERENCES)
        rare = {"restoring-a-summary.md": "troubleshooting.md"}
        for f in REFERENCES:
            if f in rare:
                self.assertIn("`references/%s`" % rare[f], skill, rare[f])
                self.assertIn("`references/%s`" % f, in_skill("references", rare[f]), f)
            else:
                self.assertIn("`references/%s`" % f, skill, f)

    def test_skill_stays_small(self):
        """SKILL.md is read on every refresh (hourly); keep on-demand material in references/ (BACKLOG C7)."""
        self.assertLess(len(in_skill("SKILL.md").encode()), 20000)

    def test_skill_database_lines_match_the_reference(self):
        """The few database lines SKILL.md repeats must stay word for word the same as references/database.md."""
        ref = in_skill("references", "database.md").split("\n")
        core = re.search(r"^## Database.*?(?=^## )", in_skill("SKILL.md"), re.M | re.S).group(0)
        prefixes = ("- `chunks/", "- `threading/", "- `summary/", "- `people/", "- `photos/")
        shared = [l for l in core.split("\n") if l.startswith(prefixes)]
        self.assertEqual(len(shared), 5)
        for l in shared:
            self.assertIn(l, ref)

    def test_every_catchup_command_is_documented(self):
        """Every refresh command in SKILL.md; restore-summary and the day summary backfill, run only when the user asks, in
        their own references."""
        py = in_skill("scripts", "catchup.py")
        cmds = re.findall(r'cmd == "([\w-]+)"', py)
        self.assertEqual(
            sorted(cmds),
            [
                "bootstrap",
                "build",
                "captions",
                "chats",
                "check-day-summaries",
                "day-summaries",
                "days",
                "relink",
                "restore",
                "restore-summary",
                "run-plan",
                "versions",
            ],
        )
        rare = {
            "restore-summary": "restoring-a-summary.md",
            "day-summaries": "day-summaries.md",
            "check-day-summaries": "day-summaries.md",
            "captions": "photos.md",
            "chats": "chats.md",
            "run-plan": "chats.md",
            "versions": "database.md",
        }
        for c in cmds:
            where = in_skill("references", rare[c]) if c in rare else in_skill("SKILL.md")
            self.assertIn("catchup.py " + c, where, c)
            self.assertIn("catchup.py " + c, py.split('"""')[1], "the usage text names " + c)

    def test_restoring_a_summary_is_reachable_and_safe(self):
        """F10: the restore procedure is named from troubleshooting.md (SKILL.md has no room), and it keeps a refresh's
        safeguards: the run lock, a dry run the user confirms, open questions checked first, pinned writes."""
        ref = in_skill("references", "restoring-a-summary.md")
        trouble = in_skill("references", "troubleshooting.md")
        self.assertRegex(trouble, r"put back summary items .*`references/restoring-a-summary\.md`")
        self.assertNotIn("restoring-a-summary", in_skill("SKILL.md"))
        for must in (
            "**Take the run lock**",
            '`{state:"running",startedAt,step:"restore",by:"restore-summary"}`, pinned',
            "release the lock",
            "--dry-run",
            "ask them to confirm. Without a yes, release the lock and stop",
            "`DB/out/restore-open.json`",
            '`{"<ask>": "open"}`',
            "`if_version` from step 2's read on every entry that has `pin`",
            "nothing to restore: 0 restored",
            "`python3 catchup.py restore WORK`",
            "Delete it only if the user asks",
            "Never start a restore on your own or during a scheduled run",
        ):
            self.assertIn(must, ref)
        self.assertIn("`backups/<name>-a`", in_skill("references", "database.md"))

    def test_rare_import_toasts_are_reachable_from_step_4(self):
        step4 = re.search(r"^4\. Import by paste:.*?(?=^5\. )", in_skill("SKILL.md"), re.M | re.S).group(0)
        self.assertIn("`references/troubleshooting.md` › Import toasts", step4)
        toasts = re.search(
            r"^## Import toasts.*?(?=^## )", in_skill("references", "troubleshooting.md"), re.M | re.S
        ).group(0)
        for t in ("REPAIRED", "Photos not stored", "Another import is running", "`references/photos.md` › Waiting"):
            self.assertIn(t, toasts)

    def test_setup_points_at_the_field_names_it_seeds(self):
        """Setup seeds meta/chat from the user's answers; the field names live in references/database.md."""
        seed = re.search(r"^4\. \*\*Seed the database\*\*.*$", in_setup("SKILL.md"), re.M).group(0)
        self.assertIn("`references/database.md`", seed)

    def test_step_7_writes_what_the_manifest_lists(self):
        """B43: threading and summary are block documents; step 7 writes exactly what the build's manifest names, pinned
        where it says, and cleans up only after every batch succeeded."""
        skill = in_skill("SKILL.md")
        step5 = re.search(r"^5\. .*$", skill, re.M).group(0)
        step7 = re.search(r"^7\. .*$", skill, re.M).group(0)
        self.assertIn("`list threading` and `list summary` (limit 1000) into RUN", step5)
        for must in (
            "`RUN/out/manifest.json`",
            "one `batch` per entry of `batches`, in order",
            "`if_version` from step 5 where it has `pin`",
            "The last batch also gets `meta/chat`",
            "Once every batch has succeeded, delete what `cleanup` lists",
            "`references/writing-the-build.md` › Refused writes",
        ):
            self.assertIn(must, step7)
        self.assertNotIn("RUN/out/*.json", skill, "the old single-document write")
        self.assertIn(
            "`list threading` and `list summary`, each limit 1000", skill, "bootstrap fetches the collections"
        )
        relink = re.search(r"^- \*\*Fixing a link with nothing new to build:\*\*.*$", skill, re.M).group(0)
        self.assertIn("`list threading` (limit 1000) into a fresh RUN", relink)
        self.assertIn("`RUN/out/manifest.json`", relink)
        ref = in_skill("references", "writing-the-build.md")
        for must in (
            "## Refused writes",
            "`pin:true`",
            "48 documents and 900 KiB",
            "never invent a window",
            "`summary.fromI`",
        ):
            self.assertIn(must, ref)

    def test_writing_the_build_covers_partial_writes_strays_and_missing_blocks(self):
        """Review of #31, finding 5: a refused batch writes nothing, but one applied a write at a time can stop partway;
        and the reference says what to do about blocks no current names and a block that's gone."""
        ref = in_skill("references", "writing-the-build.md")
        self.assertNotIn("A refused batch writes nothing", ref)
        for must in (
            "## A partly applied write",
            "`catchup.py bootstrap WORK DBDIR --rollback`",
            "## Blocks no current names",
            "Never delete them",
            "## A missing block",
            "Blocks no `current` names are never in it",
        ):
            self.assertIn(must, ref)
        self.assertIn('"--rollback" in sys.argv', in_skill("scripts", "catchup.py"))

    def test_never_drop_anything_to_save_space(self):
        rules = re.search(r"^## Hard rules.*?(?=^## )", in_skill("SKILL.md"), re.M | re.S).group(0)
        self.assertRegex(
            rules, r"Never drop, shorten or prune conversations, bullets or other summary items to save space"
        )
        self.assertIn("## Never drop anything to save space", in_skill("references", "writing-the-build.md"))

    def test_page_and_catchup_merge_the_same_layout(self):
        """The page and catchup.py each merge the block documents; their layout keys and list orders must agree."""
        page, py = in_skill("assets", "page.html"), in_skill("scripts", "catchup.py")
        keys = lambda s: re.findall(r'"(\w+)"', s)
        self.assertEqual(
            keys(re.search(r"const LAYOUT_KEYS = \[([^\]]*)\]", page).group(1)),
            keys(re.search(r"^LAYOUT_KEYS = \(([^)]*)\)", py, re.M).group(1)),
        )
        self.assertEqual(
            keys(re.search(r'\[("convs", "open", "answered", "mentions")\]\.forEach', page).group(1)),
            keys(re.search(r"^NEWEST_FIRST = \(([^)]*)\)", py, re.M).group(1)),
        )
        db = in_skill("references", "database.md")
        for f in ("`layout:2`", "`blocks`", "`activeFrom`", "`members:", "`syn:", "`start`", "newest block first"):
            self.assertIn(f, db)

    def test_setup_seed_bootstraps_and_the_first_build_converts_it(self):
        """Setup seeds the single-document layout; first-run.md says the first build converts it. Run exactly that."""
        import json

        seed = re.search(r"^4\. \*\*Seed the database\*\*.*$", in_setup("SKILL.md"), re.M).group(0)
        js = lambda s: json.loads(re.sub(r"([{,])(\w+):", r'\1"\2":', s))
        th = js(re.search(r"`threading/current` `(\{[^`]*\})`", seed).group(1))
        sm = js(re.search(r"`summary/current` `(\{[^`]*\})`", seed).group(1))
        self.assertIn("first build's manifest turns them into the block layout", in_skill("references", "first-run.md"))
        _c = importlib.util.spec_from_file_location("catchup_seed", os.path.join(ROOT, SKILL, "scripts", "catchup.py"))
        catchup = importlib.util.module_from_spec(_c)
        _c.loader.exec_module(catchup)
        with tempfile.TemporaryDirectory() as t:
            for p, o in (
                ("threading/current", th),
                ("summary/current", sm),
                ("meta/chat", {"lastI": -1, "anchorMids": []}),
            ):
                os.makedirs(os.path.dirname(os.path.join(t, "seed", p)), exist_ok=True)
                with open(os.path.join(t, "seed", p + ".json"), "w") as fh:
                    json.dump(o, fh)
            os.makedirs(os.path.join(t, "seed", "chunks"))
            with contextlib.redirect_stdout(io.StringIO()):
                catchup.bootstrap(os.path.join(t, "work"), os.path.join(t, "seed"))
            run = os.path.join(t, "run")
            os.makedirs(os.path.join(run, "chunks"))
            os.makedirs(os.path.join(run, "meta"))
            for c, o in (("threading", th), ("summary", sm)):  # step 5's listing: the seeded documents
                os.makedirs(os.path.join(run, c))
                with open(os.path.join(run, c, "current.json"), "w") as fh:
                    json.dump(o, fh)
            msgs = [
                {"i": i, "t": "Fri 9:0%d AM" % i, "d": "2026-11-06", "f": "Ana", "b": "m", "m": "mid.%d" % i}
                for i in range(3)
            ]
            for p, o in (
                ("chunks/c0000", {"start": 0, "msgs": msgs}),
                ("meta/chat", {"lastI": 2, "anchorMids": ["mid.0", "mid.1", "mid.2"]}),
            ):
                with open(os.path.join(run, p + ".json"), "w") as fh:
                    json.dump(o, fh)
            with open(os.path.join(t, "spec.json"), "w") as fh:
                json.dump({"newconvs": [{"id": "a", "title": "A"}], "join": {"a": [0, 1, 2]}}, fh)
            with contextlib.redirect_stdout(io.StringIO()):
                catchup.build(os.path.join(t, "work"), run, os.path.join(t, "spec.json"))
            with open(os.path.join(run, "out", "manifest.json")) as fh:
                man = json.load(fh)
            written = [e["collection"] + "/" + e["doc_id"] for b in man["batches"] for e in b]
            self.assertEqual(written[-2:], ["threading/current", "summary/current"])
            with open(os.path.join(run, "out", "threading", "current.json")) as fh:
                self.assertEqual(json.load(fh)["layout"], 2)

    def test_outbox_is_read_before_any_reply_is_posted(self):
        """Every place that posts reads outbox.md in full first: a refresh's replies first (step 2) and step 8, and the
        replies skill's step 5."""
        skill = in_skill("SKILL.md")
        step8 = re.search(r"^8\. Handle the outbox.*$", skill, re.M).group(0)
        self.assertIn("read `references/outbox.md` in full first (unless step 2 did)", step8)
        self.assertIn("read `references/outbox.md` in full and post those now", bullet(skill, "Replies first"))
        self.assertIn("Read `references/outbox.md` in full first", bullet(in_replies("SKILL.md"), "Post"))
        self.assertIn("Never send a message", skill, "the hard rule stays in SKILL.md")
        self.assertIn("Never send a message", in_replies("SKILL.md"), "and is in the replies skill")


class TestPhotos(unittest.TestCase):
    """R2: photos stored as they upload. What SKILL.md and references/photos.md must say for the page's states, stop
    codes and timings, the backfill, the storage warning and the cleanup."""

    def setUp(self):
        self.skill = in_skill("SKILL.md")
        self.page = in_skill("assets", "page.html")
        self.doc = in_skill("references", "photos.md")

    def section(self, name):
        return re.search(r"^## %s.*?(?=^## |\Z)" % name, self.doc, re.M | re.S).group(0)

    def tune(self, key):
        lit = re.search(r"const IMPORT_TUNE = Object\.freeze\(\s*Object\.assign\(\s*(\{[^{}]*\})", self.page).group(1)
        return int(re.search(r"\b%s:\s*(\d+)" % key, lit).group(1))

    def test_steps_point_at_photos_md(self):
        step3 = re.search(r"^3\. .*$", self.skill, re.M).group(0)
        step4 = re.search(r"^4\. Import by paste:.*?(?=^5\. )", self.skill, re.M | re.S).group(0)
        step5 = re.search(r"^5\. .*$", self.skill, re.M).group(0)
        self.assertIn("`meta/chat.photosOwed` set: `references/photos.md` › Backfill", step3)
        self.assertIn("`references/photos.md` › Waiting", step4)
        self.assertIn("never close the page tab", step4)
        self.assertIn("`references/photos.md` › Looking", step5)
        self.assertNotIn("photos/index", step5)

    def test_every_state_and_stop_the_page_writes_has_a_rule(self):
        imp = self.page[self.page.index("async function planPhotos(") : self.page.index("/* Status line: refreshes")]
        states = set(re.findall(r'R\.state = (?:[\w.]+ \? )?"(\w+)"(?: : "(\w+)")?', imp))
        states = {s for pair in states for s in pair if s} | set(re.findall(r'state: "(\w+)"', imp))
        self.assertEqual(states, {"uploading", "done", "partial", "refused", "failed"})
        stop_of = re.search(r"const stopOf = c =>(.*?);\n", self.page, re.S).group(1)
        stops = set(re.findall(r'\? "(\w+)"', stop_of)) | set(re.findall(r': "(\w+)"\s*$', stop_of))
        stops |= set(re.findall(r'\bstop = "(\w+)"', self.page)) | {"index"}  # a block write refused
        self.assertEqual(
            stops, {"rate_limited", "timeout", "quota", "auth", "no_assets", "unavailable", "lease", "index"}
        )
        waiting = self.section("Waiting")
        for s in states:
            self.assertIn("`%s`" % s, waiting, "photos.md › Waiting has no rule for state " + s)
        rules = re.findall(r"^   - (.*)$", waiting, re.M)
        for s in stops:
            self.assertTrue(any("`%s`" % s in r.split(":")[0] for r in rules), "no rule for stop " + s)
        self.assertIn("Don't paste again", [r for r in rules if r.startswith("`quota`")][0])
        self.assertIn("even in a scheduled run", [r for r in rules if r.startswith("`quota`")][0])

    def test_stall_and_wait_fit_the_page_timings(self):
        """Two reads at least 60 s apart with the same beat: at least 3 heartbeats; the 10-minute cap is longer than
        one upload's timeout, so a single slow photo never ends the wait."""
        waiting = self.section("Waiting")
        stall = int(re.search(r"at least (\d+) s apart show the same `beat`", waiting).group(1))
        cap = int(re.search(r"Wait at most (\d+) minutes in total", waiting).group(1))
        self.assertGreaterEqual(stall * 1000, 3 * self.tune("beatMs"))
        self.assertGreater(cap * 60000, self.tune("uploadTimeoutMs"))
        self.assertGreaterEqual(stall * 1000, self.tune("leaseMs"), "a stalled tab's lease lapses within the stall")
        self.assertIn("never `beat` with your clock", waiting)
        self.assertIn("leave the page tab open", waiting)

    def test_backfill_matches_the_pages_give_up_window(self):
        backfill = self.section("Backfill")
        window = self.tune("owedWindow")
        self.assertIn("`S = max(fromI, meta.lastI − %d, 3)`" % window, backfill)
        self.assertIn("`BASE = S−1`", backfill)
        self.assertIn("more than %d messages behind the newest" % window, self.doc)
        # photos owed on #0-#2 can't be backfilled: the page gives them up, and the procedure says so
        self.assertIn('`e:"no-backfill"`', backfill)
        self.assertIn('"no-backfill"', self.page)
        # (that a capture's own owed photos are never given up by it is the page test "review 12")

    def test_only_store_unavailable_is_retried(self):
        """assets.d.ts: store_unavailable is the only retry-once code; upstream_error includes an unanswered call."""
        loop = self.page[self.page.index("res = await upload(ph);") : self.page.index("if (res.code && !GIVE_UP")]
        self.assertIn('c === "rate_limited"', loop)
        self.assertIn('c === "store_unavailable"', loop)
        self.assertNotIn('stopOf(c) === "unavailable"', loop)
        self.assertIn("unpublished or being deleted", self.page, "quota_or_state is also an unpublished page")
        self.assertIn("unpublished or being deleted", self.section("Waiting"))

    def test_waiting_and_cleanup_never_trust_a_dead_tabs_record(self):
        """Review of #42: a paste is matched by sha and at; a record stuck at uploading with a frozen beat doesn't
        block Cleanup; step 5 leaves the page tab open when Waiting says so; the lease's time is to the second."""
        waiting = self.section("Waiting")
        self.assertIn("**and** its `at` differs from the one you noted", waiting)
        cleanup = self.section("Cleanup")
        self.assertIn("`get` it again at least 60 s later. If `beat` changed", cleanup)
        self.assertIn("If it didn't, the tab that wrote it is gone: carry on", cleanup)
        step5 = re.search(r"^5\. .*$", self.skill, re.M).group(0)
        # B61: step 5 keeps the one page tab (helper.md › Tabs), which never closes a tab still storing photos
        self.assertTrue(step5.startswith("5. Close the page tab unless photos still store (helper.md › Tabs);"))
        tabs = re.search(r"^## Tabs\n.*?(?=^## )", in_skill("references", "helper.md"), re.M | re.S).group(0)
        self.assertIn("then leave it open, never reloaded, until the upload ends", tabs)
        self.assertIn("Never close or touch any other tab of the user's", tabs)
        self.assertIn("fmtTime(L.until)", self.page)
        self.assertIn('second: "2-digit"', self.page)

    def test_every_import_toast_has_a_rule(self):
        """Waiting sends refused and failed to troubleshooting › Import toasts, which must cover them."""
        toasts = re.search(
            r"^## Import toasts.*?(?=^## )", in_skill("references", "troubleshooting.md"), re.M | re.S
        ).group(0)
        for s in ('ending "Nothing saved."', '"Import failed: …"', '"Saved, but the read-back of c…', "`refused`"):
            self.assertIn(s, toasts)
        self.assertIn("Saved, but the read-back of ", self.page)
        self.assertIn('msg: "Import failed: "', self.page)

    def test_an_older_skill_says_photos_wont_be_stored(self):
        """A pre-1.22 SKILL.md closes the page tab right after IMPORT OK and reads photos/index: on a 2.7 page photos
        are neither stored nor seen until the plugin is updated. The page's notice and the older-copy section say so."""
        newer = re.search(
            r"^## `pageVersion` is newer.*?(?=^## |\Z)", in_skill("references", "updating-the-page.md"), re.M | re.S
        ).group(0)
        self.assertIn("new photos aren't stored or seen until the plugin is updated", newer)
        self.assertIn("so new photos aren't stored or seen until it's updated", newer)
        self.assertIn("**Never republish**", newer, "F5's rule stays")
        self.assertIn("Until it's updated, new photos may not be stored or shown.", self.page)

    def test_setup_seeds_no_photo_index(self):
        """photos/index is never written again; older pages read a missing one as empty."""
        seed = re.search(r"^4\. \*\*Seed the database\*\*.*$", in_setup("SKILL.md"), re.M).group(0)
        self.assertNotIn("photos/", seed)

    def test_every_new_photo_is_looked_at(self):
        """The owner kept today's behavior: no cap on the photos Claude opens."""
        looking = self.section("Looking")
        self.assertIn("Open every one", looking)
        self.assertIn("`stored`", looking)
        self.assertNotRegex(looking, r"at most \d+")

    def test_storage_warning_and_cleanup_are_safe(self):
        storage = self.section("Storage")
        self.assertIn("80%", storage)
        self.assertIn("usageLevel(u) < 0.8", self.page)
        cleanup = self.section("Cleanup")
        for s in (
            "only when the user asks",
            "never in a scheduled run",
            "**never delete a file any `photos` document references**",
            "SHA-256",
            "Without a clear yes",
            "List `photos` again",
            '`Artifact` `action:"delete"`',
        ):
            self.assertIn(s, cleanup)
        self.assertIn("offer Cleanup", storage)

    def test_one_pack_check_and_one_asset_id_rule(self):
        """PR #58's review: packing and the leftover sweep check a full pack with the same function, and the asset-id
        pattern is written once for an id (isAssetId) and once for a "/_blob/" string (blobOf)."""
        self.assertEqual(self.page.count("async function fullPackBad("), 1)
        self.assertIn("await fullPackBad(fb, day, part.length,", self.page, "packCheck uses it")
        self.assertIn("await fullPackBad(fb, e.day,", self.page, "the sweep uses it")
        self.assertNotIn("reclaimCheck", self.page)
        self.assertEqual(self.page.count("[^#?\\s/]"), 2, "the asset-id pattern, once in isAssetId and once in blobOf")

    def test_cleanup_honours_what_the_sweep_keeps(self):
        """PR #58's review: what the page's leftover sweep keeps is in use for Cleanup ("/_blob/" ids in
        photos/swept-<pack>), and while a pack is lost (missing or unreadable: its originals can't be named, and one
        may be the only copy) Cleanup deletes only duplicates."""
        cleanup = self.section("Cleanup")
        self.assertIn("`photos/swept-<pack>`", cleanup)
        self.assertIn("`lost: true`", cleanup)
        self.assertIn("delete only duplicates", cleanup)
        self.assertIn("never offer the other unused files", cleanup)
        db = in_skill("references", "database.md")
        for s in ("- `photos/swept-<key>`", "`refresh/packing`", "`reclaim`"):
            self.assertIn(s, db)

    def test_database_md_documents_the_photo_documents(self):
        db = in_skill("references", "database.md")
        for s in (
            "- `photos/b<start>`",
            "- `meta/chat.photosOwed`",
            "- `meta/chat.assetUsage`",
            "- `refresh/lastImport`",
            "`stored` `[{i,k,id}]`",
            "never writes it again",
        ):
            self.assertIn(s, db)
        for f in ("photosOwed", "assetUsage"):
            self.assertRegex(self.page, r'doc\("meta/chat"\)\.update\(\{ %s: ' % f)
        self.assertNotRegex(self.page, r'doc\("photos/index"\)\.(set|update)', "the old index is never written")

    def test_every_given_up_code_is_reported(self):
        """R15: every code the page gives a photo up with (GIVEN, the toast's reasons) is in Waiting's report line and
        in database.md, no-fetch included."""
        given = re.search(r"const GIVEN = \{(.*?)\n  \};", self.page, re.S).group(1)
        codes = set(re.findall(r'^\s*"?([\w-]+)"?:', given, re.M))
        self.assertIn("no-fetch", codes)
        report = [line for line in self.section("Waiting").splitlines() if line.startswith("4. `done`")][0]
        db = in_skill("references", "database.md")
        for c in codes:
            self.assertIn("`%s`" % c, report, "photos.md › Waiting doesn't name " + c)
            self.assertIn('"%s"' % c, db, "database.md doesn't name " + c)

    def test_fetch_failures_give_up_after_the_pages_tries(self):
        """R15: photos.md says how many runs the page tries an unfetchable photo, the number the page uses."""
        n = self.tune("fetchTries")
        self.assertEqual(n, 3, "the owner's decision: give up after 3 runs")
        self.assertIn('After %d runs the page gives it up (`e:"no-fetch"`)' % n, self.doc)
        self.assertIn('"no-fetch"', self.page)
        self.assertIn("meta/chat.lastRefresh", self.doc + in_skill("references", "database.md"))
        self.assertIn("P.meta.lastRefresh", self.page, "a try counts once per refresh run")

    def test_backfill_passes_a_skip_list_the_helper_reads(self):
        """R16: photos.md › Backfill builds `skip` for `full`; the helper carries it across the reload to the capture,
        and skips by attachment id (a string) or slot (a number); the page documents aids in the blocks."""
        backfill = self.section("Backfill")
        self.assertIn("pass `skip` to `full`", backfill)
        self.assertIn("`aids[i][k]`", backfill)
        self.assertIn("Leave out owed (`null`) slots", backfill)
        self.assertIn("An older helper ignores it", backfill)
        self.assertIn("follow Waiting even if the summary shows `photos 0`", backfill)
        helper = in_skill("assets", "helper.user.js")
        self.assertIn("skip: a.skip || null", helper)
        self.assertIn("mcCapture(p.base, { skip: p.skip, run: p.run })", helper)
        self.assertIn("sk.some(x => x === j || (t.aid && x === t.aid))", helper)
        db = in_skill("references", "database.md")
        for s in ("`aids`", "`tries`", "`retry` `[{i,k,n}]`"):
            self.assertIn(s, db)
        # review of v1.24: a skip the page doesn't hold is reported back, and photos.md tells Claude what to do
        self.assertIn("skipOwed", self.page)
        self.assertIn("`refresh/lastImport.skipOwed`", backfill)
        for s in ("`skipOwed` `[{i,k}]`", "`h` `{"):
            self.assertIn(s, db)
        # the shared-id warning the helper gives is explained where Claude looks warnings up
        self.assertIn("whose photos share one Messenger id", helper)
        self.assertIn("message(s) whose photos share one Messenger id", in_skill("references", "helper.md"))
        # a capture that shows only FAILED still sends Claude to photos.md › Waiting
        step4 = re.search(r"^4\. Import by paste:.*?(?=^5\. )", self.skill, re.M | re.S).group(0)
        self.assertIn("Photos or `FAILED`: never close the page tab", step4)


class TestUpdateNotice(unittest.TestCase):
    """F5: Claude writes meta/chat.versions with every lastRefresh, and the page compares it with its own version. The
    skill text must document every key the page reads, and tell Claude when to write it."""

    def setUp(self):
        self.page = in_skill("assets", "page.html")
        self.db = in_skill("references", "database.md")
        m = re.search(r"^## Versions\n.*?(?=^## )", self.db, re.M | re.S)
        self.versions = m.group(0) if m else ""

    def test_database_md_documents_versions(self):
        self.assertRegex(self.db, r"(?m)^- `meta/chat\.versions` \(Claude; with every `lastRefresh`")
        for k in ("page", "helper", "refresh", "browsers", "at"):
            self.assertIn("`%s`" % k, self.versions, k)
        self.assertIn('`"none"`', self.versions)
        self.assertIn("30 days", self.versions)

    def test_every_versions_key_the_page_reads_is_documented(self):
        body = re.search(r"function updateNotices\(.*?\n  \}\n", self.page, re.S).group(0)
        keys = set(re.findall(r"\bV\.(\w+)", body)) | set(re.findall(r"\bb\.(\w+)", body))
        self.assertTrue({"page", "helper", "refresh", "browsers", "at"} <= keys, keys)
        for k in keys:
            self.assertIn("`%s`" % k, self.versions, "database.md › Versions doesn't name " + k)

    def test_versions_window_matches_the_page(self):
        days = re.search(r"const VERSIONS_FRESH_DAYS = (\d+);", self.page).group(1)
        self.assertIn("older than %s days" % days, self.versions)

    def test_lastrefresh_is_always_written_with_versions(self):
        """Every place that tells Claude to write lastRefresh names versions, SKILL.md's steps first: they're what a
        refresh follows (a run that wrote lastRefresh alone after one that wrote versions shows "an older copy of the
        skill ran" on a current plugin). Step 7 says where the shape is."""
        skill = in_skill("SKILL.md")
        texts = {"SKILL.md": skill, "scripts/catchup.py": in_skill("scripts", "catchup.py")}
        texts.update({"references/" + f: in_skill("references", f) for f in REFERENCES})
        found = collections.Counter()
        for name, text in texts.items():
            for lit in re.findall(r"\{lastRefresh[^}]*\}", text):
                found[name] += 1
                self.assertIn("versions", lit, name + ": " + lit)
        self.assertGreaterEqual(found["SKILL.md"], 2, "the nothing-new path and step 7")
        self.assertGreaterEqual(sum(found.values()), 5)
        step7 = re.search(r"^7\. .*$", skill, re.M).group(0)
        self.assertIn(
            "{lastRefresh, coverage, versions}` (`references/database.md` › Versions: start from `catchup.py versions TZ`)",
            step7,
        )
        # B54: database.md gives lastRefresh's format and the command that prints it with versions, ready-made
        self.assertIn("**Start from `python3 catchup.py versions TZ`**", self.versions)
        self.assertIn(
            '`lastRefresh`: the time in `meta/chat.tz` as `Ddd Mon D, H:MM AM` ("Fri Nov 20, 9:04 AM")', self.versions
        )
        self.assertIn("{lastRefresh, coverage, versions:{page, helper, refresh, browsers:", self.versions)

    def test_page_version_check_goes_both_ways(self):
        skill = in_skill("SKILL.md")
        self.assertIn(
            "If `meta/chat.pageVersion` differs from `PAGE_VERSION` in `assets/page.html` (compare number by number),"
            " read `references/updating-the-page.md` first.",
            skill,
        )
        doc = in_skill("references", "updating-the-page.md")
        older = re.search(r"^## `pageVersion` is older.*?(?=^## )", doc, re.M | re.S).group(0)
        newer = re.search(r"^## `pageVersion` is newer.*", doc, re.M | re.S).group(0)
        self.assertIn("publish `assets/page.html` to that url", older)
        self.assertIn("`{pageVersion, versions:{page}}`", older)
        for must in ("**Never republish**", "never lower `pageVersion`", "carry on with the run", "Update the"):
            self.assertIn(must, newer)
        self.assertIn("scheduled runs included", newer)
        self.assertIn("`{pageVersion, versions:{page}}`", self.versions)
        # a newer major stops instead of carrying on; minors can change what's stored too (R2 did, in v1.22.0)
        self.assertNotIn("only changes in a major release", doc)
        major = re.search(r"^- \*\*A newer major\*\*.*$", newer, re.M)
        self.assertTrue(major, "updating-the-page.md › newer: no **A newer major** rule")
        for must in ("stop before step 1", "write nothing", "tell the user"):
            self.assertIn(must, major.group(0))
        self.assertIn("Claude Code: `/plugin`", newer)
        # setup reuses an existing page the same way: pageVersion and versions.page in one pinned update, or the page
        # would say an older skill ran (versions.page from the last refresh below the new pageVersion)
        reuse = re.search(r"^   - `Artifact list` .*$", in_setup("SKILL.md"), re.M).group(0)
        self.assertIn("`{pageVersion, versions:{page}}`", reuse)
        self.assertIn("one pinned update", reuse)

    def test_self_update_threshold_matches_helper_md(self):
        """The page's D notice (can't update itself) uses the same line as helper.md › Versions, which is the first
        helper with @updateURL."""
        page_v = re.search(r'const SELF_UPDATE_FROM = "([\d.]+)";', self.page).group(1)
        helper_md = re.search(
            r"\*\*older than ([\d.]+):\*\* it was installed by pasting", in_skill("references", "helper.md")
        )
        self.assertEqual(helper_md.group(1), page_v)
        first = re.search(r"\*\*Helper ([\d.]+):\*\* `@updateURL`", read("CHANGELOG.md"))
        self.assertEqual(first.group(1), page_v)

    def test_notice_install_link_is_the_release_url(self):
        """One install URL in the page (the #us-install anchor); the notices read it from there, and How to install
        points at the README's Install section."""
        self.assertEqual(self.page.count("releases/latest/download/helper.user.js"), 1)
        self.assertRegex(
            self.page, r'id="us-install"\s+href="https://github\.com/[^"]+/releases/latest/download/helper\.user\.js"'
        )
        render = re.search(r"function renderUpdates\(.*?\n  \}\n", self.page, re.S).group(0)
        self.assertIn('$("#us-install")', render)
        docs = re.search(r'const INSTALL_DOCS = "([^"]+)";', self.page).group(1)
        self.assertTrue(docs.endswith("#install"), docs)
        self.assertRegex(read("README.md"), r"(?m)^## Install$")

    def test_helper_md_records_the_browser(self):
        which = re.search(r"^## Which Chrome.*?(?=^## )", in_skill("references", "helper.md"), re.M | re.S).group(0)
        self.assertIn("`meta/chat.versions.browsers`", which)
        self.assertIn('`"none"`', which)

    def test_page_never_writes_versions(self):
        """versions is Claude's: the page only reads it (dismissals stay in localStorage). Catches a key with any value,
        quoted or not, the shorthand `{versions}`, a dotted update path and an assignment."""
        for pat in (
            r"""[{,]\s*["'`]?versions["'`]?\s*:""",  # { versions: …, "versions": …, 'versions': … (not a ?: ternary)
            r"[{,]\s*versions\s*[,}]",  # update({versions}), {a, versions}
            r"""["'`]versions\.""",  # update({"versions.page": …})
            r"\.versions\s*=[^=]",
            r"\[\s*[\"'`]versions[\"'`]\s*\]\s*=[^=]",
        ):
            self.assertNotRegex(self.page, pat)

    def test_page_never_writes_versions_catches_writes(self):
        """The check above, on the writes it must catch."""
        test = TestUpdateNotice("test_page_never_writes_versions")
        for bad in (
            'S.db.doc("meta/chat").update({ versions: { page: "9.9" } });',
            'S.db.doc("meta/chat").update({ "versions": v });',
            'S.db.doc("meta/chat").update({ versions });',
            'S.db.doc("meta/chat").update({ lastI, versions });',
            'S.db.doc("meta/chat").update({ "versions.page": "9.9" });',
            "meta.versions = {};",
            'meta["versions"] = {};',
        ):
            test.page = self.page + "\n" + bad
            with self.assertRaises(AssertionError, msg=bad):
                test.test_page_never_writes_versions()


class TestDaySummaries(unittest.TestCase):
    """F29: one fuller summary per day. The refresh queries the collection and writes the days `catchup.py days` names
    (the day in progress from its summary so far and the new messages, a finished day from all its messages); the
    backfill is on request, bounded, backed up and checked; the page only reads them; refreshes no longer write the
    per-day digests (F16), which the page still reads for days without a summary."""

    def setUp(self):
        self.skill = in_skill("SKILL.md")
        self.ref = in_skill("references", "day-summaries.md")
        self.py = in_skill("scripts", "catchup.py")
        self.page = in_skill("assets", "page.html")

    def const(self, name):
        return int(re.search(r"^%s = (\d+)" % name, self.py, re.M).group(1))

    def test_a_refresh_queries_the_collection_and_asks_for_the_days(self):
        five = step(self.skill, 5)
        self.assertIn("`list threading` and `list summary` (limit 1000) into RUN", five)
        self.assertIn("query `reports` and `daySummaries`", five)
        self.assertIn("`references/day-summaries.md`", five)
        self.assertNotIn("list digests", self.skill)
        six = step(self.skill, 6)
        self.assertLess(six.index("catchup.py days WORK RUN"), six.index("catchup.py build WORK RUN spec.json"))
        self.assertIn("the spec's `daySummaries` (`references/day-summaries.md`)", six)
        self.assertIn("`daySummaries`", section(self.skill, "catchup.py"))
        self.assertNotIn("`digests`", section(self.skill, "catchup.py"))
        self.assertIn("`references/day-summaries.md` › Backfill", section(self.skill, "Which part to follow"))
        query = section(self.ref, "During a refresh")
        self.assertIn(
            'query: {order_by: {field: "day", direction: "desc"}, limit: %d}' % self.const("DAY_QUERY"), query
        )
        self.assertIn("create an empty one", query)

    def test_the_reference_states_catchups_rules(self):
        during = section(self.ref, "During a refresh")
        self.assertIn("%d at most" % self.const("DAY_DUE_MAX"), during)
        for kind in ("`UPDATE`", "`NEW`", "`FINAL`"):
            self.assertIn(kind, during)
            self.assertIn('"%s"' % kind.strip("`").lower(), self.py, "catchup.py names it")
        self.assertIn("only the messages stored after it", during)
        self.assertIn("write the whole summary, not just the changes", during)
        self.assertIn("A final day is never written again", during)
        rules = section(self.ref, "What catchup.py checks")
        for must in (
            "the day's summary isn't final",
            "`limit: 30`",
            "only `sections` and `open`",
            "at least one section, each a one-line heading and at least one bullet",
            "citing at least one message number, all stored messages of that day",
            "within the build's 240 KiB",
            "the old `digests` is refused",
        ):
            self.assertIn(must, rules)
        self.assertEqual(catchup_doc_limit(self.py), 240 * 1024)
        writing = section(self.ref, "Writing a day's summary")
        self.assertIn("No length limit", writing)
        self.assertIn("never write message numbers in the text", writing)
        self.assertNotRegex(writing + rules, r"≤\d+ words|\d+ bullets of", "no word or bullet caps")
        example = re.search(r"```json\n(.*?)```", writing, re.S).group(1)
        self.assertEqual(set(json.loads(example)["2026-11-22"]), {"sections", "open"})

    def test_the_backfill_is_on_request_bounded_backed_up_and_checked(self):
        bf = section(self.ref, "Backfill")
        self.assertTrue(bf.startswith("## Backfill\nOnly when the user asks"))
        self.assertIn(
            "up to %d days and %s messages" % (self.const("BACKFILL_DAYS"), "{:,}".format(self.const("BACKFILL_MSGS"))),
            bf,
        )
        order = [
            "catchup.py days WORK RUN --backfill",
            "catchup.py day-summaries WORK RUN spec.json",
            "Take the run lock just before the write",
            "`RUN/out/manifest.json`",
            "Release the lock right after",
            "catchup.py check-day-summaries WORK RUN AFTER",
        ]
        self.assertEqual([bf.index(x) for x in order], sorted(bf.index(x) for x in order))
        self.assertIn("`RUN/out/backup/`", bf)
        self.assertIn("stop, write nothing more, and tell the user", bf)
        self.assertIn("found again by the next `days`", bf)
        self.assertIn("Do 2 or 3 batches in a session, then stop and tell the user how many days are left", bf)
        self.assertIn("`offset` and `limit`", in_skill("references", "day-summaries.md"))
        lock = re.search(r"^4\. Take the run lock.*$", bf, re.M).group(0)
        for must in (
            '`{state:"running",startedAt,step:"daySummaries",by:"day summary backfill"}`, pinned',
            "under 20 minutes old",
            "`get` it again",
            'update `refresh/status` (pinned) to `{state:"done",finishedAt}`',
        ):
            self.assertIn(must, lock)
        refused = re.search(r"^   - \*\*A refused write\*\*.*$", bf, re.M).group(0)
        self.assertIn("Don't run the check", refused)
        self.assertIn("go back to step 2 with a fresh folder", refused)
        self.assertIn("If the same batch is refused again from a fresh, whole listing, stop and tell the user", refused)
        # F29 review, finding 1: one document per day, so the backfill lists every page and marks the listing whole
        listing = re.search(r"^2\. .*$", bf, re.M).group(0)
        for must in (
            "a page at a time",
            "query: {limit: %d}" % self.const("PAGE"),
            "`next_cursor`",
            "cursor: <next_cursor>",
            "`RUN/daySummaries/%s`" % re.search(r'^WHOLE = "([^"]+)"', self.py, re.M).group(1),
            "every backfill command refuses a listing without it",
        ):
            self.assertIn(must, listing)
        self.assertIn("`AFTER/daySummaries/.all`", re.search(r"^5\. .*$", bf, re.M).group(0))

    def test_days_are_the_browsers_dates(self):
        """The helper dates messages in the browser's zone, not meta/chat.tz; days never go back; final summaries."""
        db = in_skill("references", "database.md")
        for text in (self.ref, db):
            self.assertIn("browser's time zone", text)
            self.assertNotIn("in the chat's time zone (`meta/chat.tz`)", text)
            self.assertIn("final", text)
        self.assertIn("A day never goes back", self.ref)
        wb = in_skill("references", "writing-the-build.md")
        self.assertIn("a `daySummaries/d<YYYY-MM-DD>` day step 5's query of the day summaries held", wb)
        self.assertIn("`references/day-summaries.md` › A refused write", wb)
        self.assertNotIn("digests.md", wb + in_skill("references", "reports.md"))

    def test_database_md_documents_day_summaries_and_older_digests(self):
        db = in_skill("references", "database.md")
        line = re.search(r"^- `daySummaries/d<YYYY-MM-DD>`.*$", db, re.M)
        self.assertTrue(line)
        for part in (
            "`{day, fromI, toI, n, at, full, fullToI, final, sections:[{h, bullets:[{t, refs}]}], open:[{t, refs}]}`",
            "the page reads them all",
            "only `catchup.py` writes them",
            "the By day tab shows them",
            "Copy for chat",
            "`day_summaries` tool",
            "never written again",
        ):
            self.assertIn(part, line.group(0))
        old = re.search(r"^- `digests/m<YYYY-MM>`.*$", db, re.M).group(0)
        for part in ("never since", "for days without a day summary", "never delete them", "bullets:[{t, refs}]"):
            self.assertIn(part, old)
        self.assertIn("`digests` (when present) `{n, from, to}`", db)
        self.assertIn("digests: P.digests", self.page)

    def test_per_day_collections_share_their_helpers(self):
        """F29 review, finding 9: day summaries and reports are read by one per-day helper, with one id pattern and one
        query size, and hashes come from one helper."""
        self.assertNotRegex(self.py, r"REPORT_ID|REPORT_QUERY|_sum_hash|hashlib\.sha256\(json")
        for name in ("_sum_listing", "_report_listing"):
            body = re.search(r"^def %s\(.*?(?=^def )" % name, self.py, re.M | re.S).group(0)
            self.assertIn("return _per_day(", body, name)
        self.assertEqual(len(re.findall(r"DAY_ID\.match", self.py)), 1, "only _per_day matches day ids")
        self.assertIn("_hash(doc)[:8]", self.py, "block ids use the shared hash")

    def test_nothing_mentions_asks_old_include_older_box(self):
        """F32 made Ask and Views always take the whole history: the page and the skill docs never mention the
        "include older" checkbox (found on claude.ai in the Refreshing help, F29 review)."""
        stale = re.compile(r"include (them|older)|with its checkbox|messages before the catch-up window", re.I)
        texts = {"page.html": self.page}
        for skill in ("refresh", "setup", "replies", "reply-check"):
            d = os.path.join(ROOT, "plugin", "skills", skill)
            for base, _, files in os.walk(d):
                for f in files:
                    if f.endswith(".md"):
                        texts[os.path.relpath(os.path.join(base, f), ROOT)] = read(
                            os.path.relpath(os.path.join(base, f), ROOT)
                        )
        for name, text in texts.items():
            self.assertNotRegex(text, stale, name)

    def test_catchup_writes_day_summaries_and_never_digests(self):
        self.assertIn('FIXED_IDS = ("daySummaries", "reports", "captions")', self.py)
        self.assertNotRegex(self.py, r"DIGEST_|def _digest|def digests_cmd|def check_digests")
        self.assertIn("refreshes no longer write per-day digests", self.py)

    def test_the_page_reads_both_and_writes_neither(self):
        """The page only reads them, each collection whole by one snapshot listener, never a write (windowed loading
        of the day summaries is a backlog item for very long histories)."""
        for c in ("daySummaries", "digests"):
            uses = re.findall(r'collection\(\s*"%s"\s*\)\s*\.(\w+)' % c, self.page)
            # F1: each chat's listener goes through on(), which drops it when another chat is opened
            uses += ["onSnapshot"] * len(re.findall(r'on\(\s*db\.collection\(\s*"%s"\s*\)' % c, self.page))
            self.assertEqual(uses, ["onSnapshot"], c)
            self.assertNotRegex(self.page, r'doc\(\s*["`]%s/' % c)
        self.assertIn("return daySumLine(x, cap) || digestLine(x);", self.page, "a day's summary before its digest")


def catchup_doc_limit(py):
    return eval(re.search(r"^DOC_LIMIT = ([\d *]+)", py, re.M).group(1))


class TestHelper2(unittest.TestCase):
    """Helper 2.0 (issue #32, R3, B41): what the skill text must say for the new helper behavior."""

    def setUp(self):
        self.skill = in_skill("SKILL.md")
        self.src = in_skill("assets", "helper.user.js")

    def jump_code(self):
        return re.search(r"^([ \t]*)\(async function mcJump\(\) ?\{\n.*?^\1\}\)\(\);$", self.src, re.S | re.M).group(0)

    def test_post_is_opt_in_and_documented(self):
        """post sends messages: off by default, turned on only by the user through Claude (meta/chat.helperPost)."""
        meta = re.search(r"^- `meta/chat`:(.*)$", in_skill("references", "database.md"), re.M).group(1)
        self.assertIn("`helperPost`", meta)
        self.assertIn("references/posting-with-helper.md", meta)
        doc = in_skill("references", "posting-with-helper.md")
        for s in (
            "off by default",
            "The user turns it on by asking you",
            "Never set it on your own",
            "helperPost:true",
        ):
            self.assertIn(s, doc)
        commands = section(in_skill("references", "helper.md"), "Commands")
        self.assertRegex(
            commands, r"`post` only when `meta/chat.helperPost` is true \(`references/posting-with-helper.md`\)"
        )
        line = re.search(r"^- Commands \(.*$", self.skill, re.M).group(0)
        self.assertIn("`post`", line, "SKILL.md names post and where it's described")
        self.assertIn("`references/helper.md` › Commands", line)
        self.assertIn("a.helperPost !== true", self.src, "the helper itself refuses without the opt-in")

    def test_post_maps_every_result_to_an_outbox_state(self):
        doc = in_skill("references", "posting-with-helper.md")
        post = self.src[self.src.index("async function mcPost(") : self.src.index("async function probe(")]
        errs = set(re.findall(r"err: '([\w-]+)'", post)) | set(
            re.findall(r"'([\w-]+-not-accepted|type-mismatch)'", post)
        )
        self.assertTrue({"not-opted-in", "wrong-reply-target", "enter-not-accepted", "unconfirmed"} <= errs, errs)
        for e in sorted(errs):
            self.assertTrue(
                "`%s`" % e in doc or 'err:"%s"' % e in doc, "posting-with-helper.md doesn't say what to do with " + e
            )
        for state in ('`{state:"sending"}`', "add `sent` with `sentAt`", "add `failed`", "Leave the row in `sending`"):
            self.assertIn(state, doc)
        self.assertIn("**stop posting**", doc, "an unconfirmed post leaves at most one row in sending (outbox.md)")

    def settle(self):
        """The bullets of posting-with-helper.md's step 4, keyed by the first code span in each."""
        doc = in_skill("references", "posting-with-helper.md")
        step = re.search(r"^4\. Settle.*?(?=^5\. )", doc, re.M | re.S).group(0)
        return step, re.findall(r"^   - (.*)$", step, re.M)

    def test_only_unconfirmed_may_have_sent_and_it_is_never_retried(self):
        """Review of PR #38: a result that may have sent must leave the row sending and stop posting, never retry, never
        press Return; a lost result counts the same; post is never started twice for a row."""
        doc = in_skill("references", "posting-with-helper.md")
        step, bullets = self.settle()
        self.assertIn("**Never start `post` twice for a row**", doc)
        self.assertIn("Only `unconfirmed` means some of the reply may have gone out", step)
        unconf = [b for b in bullets if b.startswith('`err:"unconfirmed"`')]
        self.assertEqual(len(unconf), 1, bullets)
        for s in ("Leave the row in `sending`", "**stop posting**", "Never post it again", "never press Return"):
            self.assertIn(s, unconf[0])
        lost = [b for b in bullets if b.startswith("**No result**")]
        self.assertEqual(len(lost), 1, bullets)
        self.assertIn("counts as `unconfirmed`", lost[0])
        self.assertIn("stop posting", lost[0])
        # Return, or another post, only after results the helper checked sent nothing
        for b in bullets:
            says_return = re.search(r"\bReturn\b", b) and "never press Return" not in b
            if says_return:
                self.assertTrue(
                    b.startswith('`err:"enter-not-accepted"`'), "Return after a result that may have sent: " + b
                )
            if "start `post` once" in b or "start `post` again" in b:
                self.assertTrue(b.startswith("`scan-running`"), "post started again after: " + b)
        running = [b for b in bullets if b.startswith("`post-running`")][0]
        self.assertIn("Don't start another", running)

    def test_a_users_draft_is_never_cleared(self):
        step, bullets = self.settle()
        b = [x for x in bullets if "`box-not-empty`" in x][0]
        self.assertIn("leave it as it is", b)
        self.assertNotRegex(b.lower(), r"\bclear (it|the box)")

    def test_post_never_reports_entered_false_after_a_key(self):
        """Every result after the first scripted shift+Enter or Enter says `entered` (true), and a matching message from
        you is never followed by a retryable error."""
        post = self.src[self.src.index("async function postOne(") : self.src.index("async function probe(")]
        after = post[post.index("mark('typing')") :]
        calls = re.findall(r"(?:out|refuse)\(\{([^{}]*)\}\)", after)
        self.assertTrue(calls)
        for c in calls:
            self.assertRegex(c, r"\bentered\b", "a result after a key press without entered: " + c)
        self.assertIn("const el = match();\n    if (el)\n      return {\n        sent: true", post)

    def test_only_the_bridge_can_post(self):
        """The jump code (also the page's bookmarklet and URL-hash handler) never types or presses Enter, and post is
        reached from the bridge's command table only."""
        jump = self.jump_code()
        for s in ("insertText", "'Enter'", "mcPost", "postOne"):
            self.assertNotIn(s, jump)
        self.assertEqual(re.findall(r"\bmcPost\(", self.src), ["mcPost(", "mcPost("], "defined once, called once")
        self.assertIn("post: (a, id) => mcPost(a, id),", self.src)

    def test_more_actions_reply_is_an_allowed_click(self):
        rules = re.search(r"^## Hard rules.*?(?=^## )", self.skill, re.M | re.S).group(0)
        self.assertIn("More actions › Reply", rules)
        self.assertIn("More actions", in_skill("references", "posting-with-helper.md"))
        self.assertIn('[aria-label="More actions"]', self.jump_code())

    def test_stall_and_navigation_are_explained(self):
        self.assertIn(
            '"Inspected target navigated": expected', section(in_skill("references", "helper.md"), "Commands")
        )
        step3 = re.search(r"^3\. .*$", self.skill, re.M).group(0)
        self.assertIn('`"stalled"` or `"top-spinner"`: retry once, `references/helper.md` › Scan results', step3)
        for e in ('err:"stalled"', 'err:"top-spinner"'):
            self.assertIn(e, in_skill("references", "helper.md"))
        for e in ("'top-spinner'", "'stalled'"):
            self.assertIn(e, self.src)

    def test_warnings_and_browsers_reach_the_report(self):
        step2 = re.search(r"^2\. .*$", self.skill, re.M).group(0)
        self.assertIn("`references/helper.md` › Which Chrome", step2)
        self.assertIn("`references/helper.md` › Warnings", step2)
        helper = in_skill("references", "helper.md")
        for s in (
            "never pick one yourself",
            "names the browser used",
            "page language",
            "24-hour clock",
            "go backwards",
        ):
            self.assertIn(s, helper)

    def test_names_are_reported_until_captured_and_the_backfill_retried(self):
        """B41: each refresh reports missing full names and a pending backfill, and retries the backfill once the
        helper is 1.7+."""
        step8 = re.search(r"^8\. .*$", self.skill, re.M).group(0)
        self.assertIn("if it has no `scannedAt`, this run's messages from others carry no `fn`", step8)
        people = in_skill("references", "people.md")
        for s in (
            "Full names: not captured",
            "Full names: one-time scan pending",
            "Each refresh tries again until `scannedAt` is set",
            "Run it on every refresh until it has succeeded",
            "Once the helper is 1.7 or later, the next refresh runs the scan",
        ):
            self.assertIn(s, people)


class TestSkillRoom(unittest.TestCase):
    """R14 (A3, v1.23.0): text only some refreshes need moved out of SKILL.md to make room. Each moved fact is asserted
    in its new place, and SKILL.md names that place, saying when to read it, in the step where the fact was."""

    def setUp(self):
        self.skill = in_skill("SKILL.md")
        self.helper = in_skill("references", "helper.md")
        self.trouble = in_skill("references", "troubleshooting.md")

    def test_helper_commands_live_in_helper_md(self):
        line = re.search(r"^- Commands \(.*$", section(self.skill, "Helper"), re.M).group(0)
        self.assertIn(
            "`references/helper.md` › Commands. Read it before your first command in each conversation.", line
        )
        self.assertNotIn("probe{anchor}", self.skill, "the command list moved")
        self.assertIn("Commands (before your first command in each conversation)", self.helper.split("\n## ")[0])
        commands = section(self.helper, "Commands")
        src = in_skill("assets", "helper.user.js")
        table = src[src.index("const CMDS = {") : src.index("\n  };", src.index("const CMDS = {"))]
        names = re.findall(r"^    (\w+):", table, re.M)
        self.assertGreaterEqual(len(names), 10, names)
        for n in names:
            self.assertIn("`%s" % n, commands, "helper.md › Commands doesn't describe " + n)
        for must in (
            "`ping` → `{v}`",
            "`probe{anchor}` → `{vis,n,found,after}`",
            "`scan{stops}` or `scan{first:{count}}`; `verify`; `capture{base}`",
            "`full{stops|first, base, run}`: scan, reload, verify, capture. Pass a fresh `run` id",
            "poll `sessionStorage.mc_result` in new calls",
            "accept it only when its `run` equals yours: `stage:'captured'`, `'verify-failed'`, or `'scan'`",
            "with `err:null, win:0` = nothing new since the last run",
            "Results carry `warn`, `top` and `scroller`",
            "Messages that arrive during the run (`extra>0`) wait for the next run.",
            "`selfcheck` → `{ok,missing,warn,counts}`",
            "`jump{mid,reply}`",
            "`people{count}`: `references/people.md`",
        ):
            self.assertIn(must, commands)
        self.assertIn("`references/helper.md` › Commands", in_skill("references", "outbox.md"))

    def test_install_link_lives_in_helper_md(self):
        url = "https://github.com/roopesh/messenger-catchup/releases/latest/download/helper.user.js"
        self.assertNotIn(url, self.skill)
        self.assertIn("(install link: `references/helper.md` › Versions)", section(self.skill, "Helper"))
        versions = section(self.helper, "Versions")
        self.assertIn("Install link (also on the page; steps in the setup skill): " + url, versions)
        self.assertIn("open the install link (below)", versions)

    def test_dates_guessed_reaches_the_report(self):
        step3 = step(self.skill, 3)
        self.assertIn(
            "a capture summary ending `DATES-GUESSED #…`, in the report (`references/helper.md` › Warnings)", step3
        )
        warnings = section(self.helper, "Warnings")
        for must in (
            "`DATES-GUESSED #…`",
            "`mc_result.capture`, or the `capture` command's result",
            "couldn't be read and took the previous message's date",
            "List them in the report, since Messenger may have changed its labels.",
        ):
            self.assertIn(must, warnings)

    def test_nothing_new_with_unbuilt_messages(self):
        """Review of release A: the condition is WORK's base below meta/chat.lastI, not bootstrap's message. A chain
        conversation reuses WORK without bootstrapping, so messages a dead run imported would never be built."""
        step3 = step(self.skill, 3)
        self.assertIn(
            "**Nothing new** (`err:null, win:0`), unless WORK is behind (its `base` below `meta/chat.lastI`: `references/troubleshooting.md`)",
            step3,
        )
        self.assertNotIn("unless bootstrap said", step3)
        self.assertIn(
            'bootstrap says so as "stored but not built yet"', self.skill, "Before each run names the message"
        )
        line = re.search(
            r"^- WORK is behind: its `state.json` `base` is below `meta/chat.lastI`.*$", self.trouble, re.M
        ).group(0)
        for must in (
            '"stored but not built yet"',
            "a conversation that reuses WORK doesn't bootstrap, so compare them yourself",
            "skip only step 4, not 4–6",
            "then build and write as usual",
        ):
            self.assertIn(must, line)

    def test_selfcheck_failure_and_copy_failed(self):
        self.assertIn("(the message: `references/troubleshooting.md`, its `selfcheck` line)", step(self.skill, 2))
        line = re.search(r"^- `selfcheck` says `ok:false`.*$", self.trouble, re.M).group(0)
        for must in ('"Messenger changed: " and the `missing` items', "names the page language, say that instead"):
            self.assertIn(must, line)
        step4 = re.search(r"^4\. Import by paste:.*?(?=^5\. )", self.skill, re.M | re.S).group(0)
        self.assertIn("(COPY FAILED: `references/troubleshooting.md` › Import toasts)", step4)
        self.assertIn("allow clipboard access for facebook.com", section(self.trouble, "Import toasts"))

    def test_catchup_checks_are_listed_where_a_failure_sends_claude(self):
        self.assertIn(
            "(all its checks: `references/writing-the-build.md` › What catchup.py checks)",
            section(self.skill, "catchup.py"),
        )
        self.assertNotIn("It asserts:", self.skill)
        ref = in_skill("references", "writing-the-build.md")
        self.assertIn("a listing or a broken rule", ref.split("\n## ")[0])
        checks = section(ref, "What catchup.py checks")
        for must in (
            "bullets ≤15 words, outcomes ≤12, each message in exactly one conversation",
            "links point backwards with a known type",
            "every reference belongs to its conversation (bullets, keys, open, answered, deal refs and `dealEdit` additions)",
            "mentions point at stored messages by someone else",
            "`closeOpen` matches an open question, no question is opened twice",
            "the import updated `meta/chat`",
            "before anything is written or WORK moves",
        ):
            self.assertIn(must, checks)

    def test_a_refused_relink_write(self):
        relink = re.search(r"^- \*\*Fixing a link with nothing new to build:\*\*.*$", self.skill, re.M).group(0)
        self.assertIn("as in step 7 (a refused write included)", relink)
        self.assertIn("`references/writing-the-build.md` › Refused writes", step(self.skill, 7))
        refused = section(in_skill("references", "writing-the-build.md"), "Refused writes")
        self.assertIn("**A relink:** `catchup.py restore WORK` and bootstrap again.", refused)

    def test_quote_match_check_carries_its_reason(self):
        """SKILL.md no longer spells out the two doubtful quote matches: the CHECK line prints the reason."""
        self.assertIn("`CHECK quote match (…)` (a doubtful quote match, the reason in brackets", step(self.skill, 6))
        py = in_skill("scripts", "catchup.py")
        self.assertIn('"CHECK quote match (%s)" % doubt', py)
        for reason in ("short quote, same text", "quote found inside the text, not at its start"):
            self.assertIn('"%s"' % reason, py)


class TestSetupSkill(unittest.TestCase):
    """Setup is its own skill (BACKLOG F7 part 2). A skill can only count on its own folder, so setup carries copies of
    the refresh skill's shared files, regenerated by npm run sync."""

    def test_copies_match_the_refresh_skill(self):
        self.assertEqual(sync.stale_copies(), [], "run npm run sync")
        self.assertEqual(
            sorted(sync.SHARED), sorted(os.path.normpath(f) for f in SETUP_SHIPPED if f != "SKILL.md"), sync.SHARED
        )
        self.assertEqual(
            sorted(sync.REPLIES_SHARED),
            sorted(os.path.normpath(f) for f in REPLIES_SHIPPED if f != "SKILL.md"),
            sync.REPLIES_SHARED,
        )
        self.assertEqual(sorted(os.path.basename(d) for d in sync.COPIES), ["replies", "setup"])

    def test_sync_rewrites_a_stale_copy(self):
        """npm run sync puts back a copy that was edited by hand, in either skill."""
        with tempfile.TemporaryDirectory() as t:
            shutil.copytree(os.path.join(ROOT, "plugin"), os.path.join(t, "plugin"))
            shutil.copytree(os.path.join(ROOT, "tools"), os.path.join(t, "tools"))
            for skill in ("setup", "replies"):
                with open(os.path.join(t, "plugin", "skills", skill, "references", "database.md"), "a") as fh:
                    fh.write("stale")
            os.remove(os.path.join(t, "plugin", "skills", "replies", "references", "outbox.md"))
            run = lambda *a: subprocess.run(["python3", os.path.join(t, "tools", "sync.py"), *a], capture_output=True)
            self.assertEqual(run("--check").returncode, 1)
            self.assertEqual(run().returncode, 0)
            self.assertEqual(run("--check").returncode, 0)
            for skill in ("setup", "replies"):
                with open(os.path.join(t, "plugin", "skills", skill, "references", "database.md")) as fh:
                    self.assertEqual(fh.read(), in_skill("references", "database.md"))
            with open(os.path.join(t, "plugin", "skills", "replies", "references", "outbox.md")) as fh:
                self.assertEqual(fh.read(), in_skill("references", "outbox.md"))

    def test_every_file_setup_names_exists(self):
        text = in_setup("SKILL.md")
        refs = set(re.findall(r"`((?:assets|scripts|references)/[\w.\-]+)`", text))
        self.assertEqual(refs, {"assets/page.html", "references/database.md", "references/scheduling.md"})
        for r in refs:
            self.assertTrue(os.path.exists(os.path.join(ROOT, SETUP, r)), r)

    def test_skills_name_each_other_by_their_real_names(self):
        import json

        plugin = json.loads(read("plugin", ".claude-plugin", "plugin.json"))["name"]
        skills = sorted(os.listdir(os.path.join(ROOT, "plugin", "skills")))
        self.assertEqual(skills, ["refresh", "replies", "reply-check", "setup"])
        self.assertIn("`%s:setup`" % plugin, in_skill("SKILL.md"))
        self.assertIn("`%s:replies`" % plugin, in_skill("SKILL.md"))
        self.assertIn("`%s:refresh`" % plugin, in_setup("SKILL.md"))
        self.assertIn("`%s:replies`" % plugin, in_setup("SKILL.md"))
        self.assertIn("`%s:refresh`" % plugin, in_replies("SKILL.md"))
        self.assertIn("`%s:setup`" % plugin, in_replies("SKILL.md"))
        text = (
            in_skill("SKILL.md")
            + in_setup("SKILL.md")
            + in_replies("SKILL.md")
            + read(REPLY_CHECK, "SKILL.md")
            + in_skill("references", "outbox.md")
        )
        named = set(re.findall(r"\b%s:([a-z-]+)" % plugin, text))
        self.assertLessEqual(named, set(skills), "a skill name that doesn't exist")

    def test_setup_hands_the_first_capture_to_refresh(self):
        step5 = re.search(r"^5\. \*\*First capture and build:\*\*.*$", in_setup("SKILL.md"), re.M).group(0)
        self.assertIn("messenger-catchup:refresh", step5)
        self.assertIn("`references/first-run.md`", in_skill("SKILL.md"))
        first = in_skill("references", "first-run.md")
        for must in ("first:{count:N}", "meta/chat.firstCount", "catchup.py bootstrap WORK seed", 'markerMode:"time"'):
            self.assertIn(must, first)

    def test_setup_seeds_what_refresh_and_a_later_setup_need(self):
        """The first capture's size must survive a retry in another session; kind and pageVersion let setup find the
        page again and keep the first refresh from republishing it."""
        seed = re.search(r"^4\. \*\*Seed the database\*\*.*$", in_setup("SKILL.md"), re.M).group(0)
        for f in ('kind:"messenger-catchup"', "`pageVersion`", "`tz`", "`firstCount`", "`lastI:-1`"):
            self.assertIn(f, seed)
        self.assertIn(
            "`firstCount`", re.search(r"^- `meta/chat`:(.*)$", in_skill("references", "database.md"), re.M).group(1)
        )

    def test_setup_never_reseeds_a_page_that_has_messages(self):
        step2 = re.search(
            r"^2\. \*\*Find or create the page\.\*\*.*?(?=^3\. )", in_setup("SKILL.md"), re.M | re.S
        ).group(0)
        self.assertIn("never reseed it", step2)

    def test_setup_stays_small(self):
        self.assertLess(len(in_setup("SKILL.md").encode()), 20000)


def section(text, heading):
    """The markdown section that starts with `## <heading>`, up to the next `## ` heading."""
    m = re.search(r"^## %s.*?(?=^## |\Z)" % re.escape(heading), text, re.M | re.S)
    assert m, "no section ## " + heading
    return m.group(0)


def step(text, n):
    """Numbered step n of a markdown list (one line)."""
    m = re.search(r"^%d\. .*$" % n, text, re.M)
    assert m, "no step %d" % n
    return m.group(0)


def bullet(text, label):
    """The one-line bullet (or numbered item) that starts with **<label>."""
    m = re.search(r"^ *(?:- |\d\. )\*\*%s.*$" % re.escape(label), text, re.M)
    assert m, "no bullet " + label
    return m.group(0)


def step(text, n):
    """Numbered step n of a markdown list (one line)."""
    m = re.search(r"^%d\. .*$" % n, text, re.M)
    assert m, "no step %d" % n
    return m.group(0)


def bullet(text, label):
    """The one-line bullet (or numbered item) that starts with **<label>."""
    m = re.search(r"^ *(?:- |\d\. )\*\*%s.*$" % re.escape(label), text, re.M)
    assert m, "no bullet " + label
    return m.group(0)


class TestScheduling(unittest.TestCase):
    """R6 (v1.21.0): scheduling tools are named only in references/scheduling.md, which says to use only a visible
    tool. Every follow-up and recurring prompt carries a token (armId); arming is a pinned write before the tool call,
    so there's only ever one schedule. Each test names the rule it guards; the PR lists the mutation check."""

    NAMES = [
        "send_later",
        "create_trigger",
        "requires_local_device",
        "CronCreate",
        "CronList",
        "CronDelete",
        "ScheduleWakeup",
        "list_triggers",
        "update_trigger",
    ]

    def ref(self):
        return in_skill("references", "scheduling.md")

    def run_steps(self):
        return section(self.ref(), "A scheduled run")

    def arm(self):
        return section(self.ref(), "Arm")

    def after(self):
        return section(self.ref(), "After a refresh the user asked for")

    def setup_scheduling(self):
        return section(in_setup("SKILL.md"), "Scheduling")

    def test_tool_names_only_in_the_scheduling_reference(self):
        others = {
            "refresh SKILL.md": in_skill("SKILL.md"),
            "setup SKILL.md": in_setup("SKILL.md"),
            "page.html": in_skill("assets", "page.html"),
            "helper.user.js": in_skill("assets", "helper.user.js"),
        }
        for f in REFERENCES:
            if f != "scheduling.md":
                others["references/" + f] = in_skill("references", f)
        for where, text in others.items():
            for name in self.NAMES:
                self.assertNotIn(name, text, "%s names %s; only references/scheduling.md may" % (where, name))
            self.assertNotRegex(
                text, r"\b(send|create|list|update|delete|fire)_(later|triggers?|scheduled_tasks?)\b", where
            )
        for name in ("send_later", "create_trigger", "requires_local_device", "CronCreate"):
            self.assertIn("`%s" % name, self.ref())

    def test_scheduling_reference_is_shared(self):
        self.assertIn(os.path.join("references", "scheduling.md"), sync.SHARED)
        self.assertEqual(in_setup("references", "scheduling.md"), self.ref(), "run npm run sync")

    def test_files_named_in_setup_copies_exist(self):
        """A copy in setup can only point at files setup has, unless it says the file is the refresh skill's."""
        copies = [f for f in sync.SHARED if f.endswith(".md")]
        self.assertIn(os.path.join("references", "scheduling.md"), copies)
        for f in copies:
            for prefix, r in re.findall(
                r"(the refresh skill's )?`((?:assets|scripts|references)/[\w.\-]+)`", in_setup(f)
            ):
                if not prefix:
                    self.assertTrue(os.path.exists(os.path.join(ROOT, SETUP, r)), "setup's %s names %s" % (f, r))

    def test_both_skills_send_claude_to_the_reference(self):
        """M1: read before Before each run (it bootstraps and can republish). M-a: a message naming the page, chat or
        thread, or asking to schedule a run, is scheduled. M-c: only an explicit "manual" skips the check."""
        runs = section(in_skill("SKILL.md"), "Scheduled runs")
        for must in (
            "`references/scheduling.md` before anything else, Before each run included",
            '"Scheduled catch-up run"',
            "names the page, `chatUrl` or thread id, or asks you to schedule a run came from it",
            'unless `schedule.mode` is `"manual"`: it checks the schedule.',
        ):
            self.assertIn(must, runs)
        self.assertIn("Do this before anything else, Before each run included.", self.run_steps())
        self.assertIn("`references/scheduling.md`", self.setup_scheduling())
        which = bullet(in_setup("SKILL.md"), "Change or stop the schedule:")
        self.assertIn("Scheduling › Stop or change", which)

    def test_every_reschedule_is_defined(self):
        """Every "reschedule" in the refresh steps is defined by the Scheduled runs section below them, and the reference
        says every ending arms, the lock skip and errors included."""
        skill = in_skill("SKILL.md")
        runs_at = skill.index("## Scheduled runs")
        uses = re.findall(r"reschedule", skill[:runs_at])
        self.assertGreaterEqual(len(uses), 3, "Before each run and step 2 reschedule")
        self.assertIn('that is what "reschedule" means above', skill[runs_at:])
        ends = step(self.run_steps(), 6)
        for must in (
            "**End of a chain run**, however it ends",
            "done, nothing new, skipped because another run holds the lock, an error, Chrome unreachable",
            'that\'s what "reschedule" means in the refresh steps',
        ):
            self.assertIn(must, ends)
        self.assertIn("A chain run then Arms, before the refresh steps", step(self.run_steps(), 5))

    def test_follow_up_messages_match(self):
        """H2: the recurring prompt carries a token too, so stopping or changing the schedule makes old tasks stale."""
        templates = re.findall(r"`(Scheduled catch-up run[^`]*)`", self.ref())
        self.assertEqual(len(templates), 2, templates)
        chain, recurring = templates
        self.assertIn("(chain <armId>)", chain)
        self.assertIn("messenger-catchup:refresh", chain)
        for must in ("(recurring <armId>)", "messenger-catchup:refresh", "<page url>", "<chatUrl>", "<thread>"):
            self.assertIn(must, recurring)
        self.assertIn('"Scheduled catch-up run"', in_skill("SKILL.md"))
        self.assertIn("carrying that token", bullet(self.setup_scheduling(), "A recurring task tied to this computer"))

    def test_schedule_fields_documented(self):
        """L1: the shape of hours and the time format are written down."""
        db = in_skill("references", "database.md")
        meta = re.search(r"^- `meta/chat`:(.*)$", db, re.M).group(1)
        self.assertIn("`schedule` (`{mode, every, hours, tz}`", meta)
        live = re.search(r"^- `refresh/schedule`:.*$", db, re.M)
        self.assertTrue(live, "database.md doesn't document refresh/schedule")
        stored = section(self.ref(), "Where it's stored")
        for field in ("armId", "nextAt", "tool", "lastRunAt", "misses", "problem", "switchAskedAt"):
            self.assertIn("`%s`" % field, live.group(0), field)
            self.assertIn("`%s`" % field, stored, field)
        for mode in ("chain", "recurring", "manual", "A", "B", "loop"):
            self.assertIn('`"%s"`' % mode, stored, mode)
        for must in (
            '`hours`: `{from, to}` as `"HH:MM"` in `tz`',
            "`from` included, `to` excluded",
            "a `to` before `from` wraps past midnight",
            "up to 5 minutes early counts as inside",
            "no `hours` means all day",
            "`nextAt`: when the follow-up is due (ISO, UTC)",
            "`lastRunAt`: when a scheduled run last started (ISO, UTC)",
        ):
            self.assertIn(must, stored)

    def test_setup_writes_only_documented_modes(self):
        """M4: setup seeds the schedule as manual until step 6 sets it up, so the first refresh doesn't check it."""
        setup = in_setup("SKILL.md")
        modes = set(re.findall(r'mode:"(\w+)"', setup + self.ref()))
        self.assertLessEqual(modes, {"chain", "recurring", "manual"}, modes)
        self.assertEqual(set(re.findall(r'mode:"(\w+)"', setup)), {"chain", "recurring", "manual"})
        seed = re.search(r"^4\. \*\*Seed the database\*\*.*$", setup, re.M).group(0)
        self.assertIn('`schedule:{mode:"manual"}` (step 6 sets the real one', seed)
        self.assertNotRegex(in_skill("SKILL.md"), r'`?mode`? "A"', 'refresh still treats mode "A" as current')

    def test_arm_rereads_and_stops_when_superseded(self):
        one = step(self.arm(), 1)
        for must in (
            "Get `refresh/schedule` and keep its version.",
            "From a chain run: if `armId` isn't this run's token, another session has armed: stop.",
            "if `nextAt` is in the future, the chain is alive: stop",
        ):
            self.assertIn(must, one)

    def test_arming_is_a_compare_and_swap(self):
        """M3a: a refused write means someone wrote; only a changed armId means someone armed."""
        arm = self.arm()
        self.assertIn("only ever one", arm.split("\n")[0])
        write = step(arm, 4)
        for must in (
            "with `if_version` from step 1, with a new `armId`",
            "If the write is refused, get it again: if `armId` changed",
            "`nextAt` is now in the future), another session armed first: stop",
            "Otherwise something else wrote it: start again at step 1.",
        ):
            self.assertIn(must, write)
        self.assertTrue(step(arm, 5).startswith("5. Call the tool"), "the tool is called after the pinned write")

    def test_mode_conversion_never_blocks_the_tool_call(self):
        """M3b: the meta/chat mode write comes after the tool call and is retried; it can't strand an armId. M-b: it
        converts only older or missing modes, and only while armId is still this token, so it can't undo a stop."""
        self.assertNotIn("meta/chat", step(self.arm(), 4))
        six = step(self.arm(), 6)
        for must in (
            '6. Then, only if `meta/chat.schedule.mode` is an older value or missing (never `"manual"` or `"recurring"`)',
            'get `refresh/schedule` again and, if `armId` is still the token just written, set `mode:"chain"`',
            "retry once",
            "never holds up step 5",
        ):
            self.assertIn(must, six)

    def test_arm_failures_are_visible(self):
        """M5: a failed arm clears nextAt and says so, and a missing nextAt reads as a stopped chain. The failure write
        needs armId still to be this token (a newer arm wins), and covers only a tool that returns."""
        self.assertIn('None: write `problem` ("no scheduling tool in this app") and `nextAt:null`', step(self.arm(), 2))
        five = step(self.arm(), 5)
        for must in (
            "If it returns an error, get `refresh/schedule` and, if `armId` is still this token, write `problem` (what happened) and `nextAt:null`",
            "say it in this run's report",
            "A call stuck on an approval can't be seen",
        ):
            self.assertIn(must, five)
        self.assertIn("`nextAt` missing or over 30 minutes past", bullet(self.after(), "Chain stopped:"))

    def test_outside_hours_and_the_longest_delay(self):
        """H3: an overnight arm is capped at the tool's longest delay; the outside-hours rule re-arms."""
        outside = step(self.run_steps(), 4)
        for must in ("**Outside the chosen hours:** don't refresh.", "Chain: Arm", "Recurring: stop."):
            self.assertIn(must, outside)
        delay = step(self.arm(), 3)
        self.assertIn("If it would end outside the window: the start of the next window.", delay)
        self.assertIn("If that's longer than the tool allows, arm for the longest it allows", delay)

    def test_no_backoff_when_chrome_is_unreachable(self):
        """Owner's call (Nov 12): runs that can't reach Chrome keep the chosen interval; misses are only reported."""
        for where, text in (("scheduling.md", self.ref()), ("setup's Scheduling", self.setup_scheduling())):
            self.assertNotRegex(text, r"(?i)\bdoubl(e|es|ed|ing)\b(?!-)|\bback ?off\b|\bexponential", where)
        delay = step(self.arm(), 3)
        self.assertIn("`every` minus 3 minutes from now", delay)
        self.assertIn("whatever `misses` says: no waiting longer", delay)

    def test_misses_are_counted_reported_and_cleared(self):
        """L3: every arm sets misses; a lock skip reached Chrome; a report clears it."""
        write = step(self.arm(), 4)
        for must in (
            "from a chain run (its early arm, or outside the hours), unchanged: the run's end sets it",
            "from setup or a refresh the user asked for, 0",
        ):
            self.assertIn(must, write)
        end = step(self.run_steps(), 6)
        for must in (
            "0 if this run reached Chrome (a run skipped for the lock counts as reaching it)",
            "otherwise its current value plus 1",
        ):
            self.assertIn(must, end)
        self.assertTrue(bullet(self.after(), "`misses` above 0").endswith("then set it to 0."))

    def test_stale_runs_do_nothing(self):
        """H2 and stop/change: a token that isn't armId, or a mode that no longer matches the message, is stale."""
        stale = step(self.run_steps(), 3)
        for must in (
            "the token isn't `refresh/schedule.armId`",
            'a chain run while `mode` is `"recurring"` or `"manual"`',
            'a recurring run while `mode` isn\'t `"recurring"`',
            'an older message while `mode` is `"chain"`, `"recurring"` or `"manual"`',
            "Stop without refreshing, arming or writing anything, and say nothing.",
        ):
            self.assertIn(must, stale)
        # nothing may let a stale run through
        self.assertTrue(stale.endswith("Stop without refreshing, arming or writing anything, and say nothing."), stale)
        self.assertNotRegex(stale, r"misses|anyway|unless|except", "the stale rule has no exceptions")
        # M-c: a missing schedule never makes an older message stale; only an explicit "manual" does
        self.assertNotIn("missing", stale)

    def test_last_run_is_written_only_after_the_stale_check(self):
        """A stale run writes nothing, so lastRunAt can't appear before step 5; a refused lastRunAt write redoes the
        stale check before retrying."""
        steps = self.run_steps()
        for n in (1, 2, 3, 4):
            self.assertNotIn("lastRunAt", step(steps, n), "step %d" % n)
        self.assertNotIn("lastRunAt", steps.split("\n1. ")[0], "the intro, before step 1")
        five = step(steps, 5)
        self.assertIn(
            "update `refresh/schedule` `{lastRunAt}` (if that's refused, get it again and redo step 3 before retrying)",
            five,
        )

    def test_scheduled_messages_are_recognized(self):
        """M-a: an old "B" prompt or a loop can look typed; a message naming the page, chat or thread, or asking to
        schedule a run, is scheduled, and a typed request never contains those."""
        intro = self.run_steps().split("\n1. ")[0]
        self.assertIn(
            'A message is scheduled if it starts "Scheduled catch-up run", names the page URL, `chatUrl` or thread id, or asks you to schedule a run: a request the user types never contains those.',
            intro,
        )

    def test_older_scheduled_runs_follow_their_prompt(self):
        """H1 and M-c: until the user switches, a scheduled run under an older or missing mode does what its message
        says (reschedule included), converts nothing and asks nothing; no scheduled run ever asks."""
        older = step(self.run_steps(), 2)
        for must in (
            "**Older message** (no token",
            "while `mode` is an older value or missing: do what the message says, the old way",
            "(no conversion, no question)",
            '"reschedule" means what the message says',
        ):
            self.assertIn(must, older)
        self.assertIn("Never ask the user anything about the schedule during a scheduled run", self.run_steps())
        self.assertIn("or no `schedule` at all", section(self.ref(), "Where it's stored"))

    def test_after_checks_only_for_a_typed_request(self):
        """M-a: every question in the After section (the switch and "Chain stopped") needs a request the user typed."""
        intro = self.after().split("\n")[1]
        self.assertTrue(
            intro.startswith(
                "Only when the user typed the request in this conversation (never for a stored prompt or follow-up, or any scheduled message as defined above)."
            ),
            intro,
        )

    def test_older_schedule_switch(self):
        """H1, M-a, M-d: an older schedule is switched once, after the user answers; a recurring task or cron is
        cancelled or deleted first, an old chain switches at once; never a restart offer from lastRefresh."""
        older = bullet(self.after(), "Older schedule")
        for must in (
            "(`mode` an older value or missing) and no `switchAskedAt`",
            "explain once",
            "write `switchAskedAt` once they answer",
            "**On yes:** find the old task, cron or follow-up with a listing tool you can see and cancel it.",
            'A recurring task (`"B"`) or recurring cron you can\'t cancel: ask the user to delete it in the app',
            "and wait until they say it's gone.",
            'An old chain (`"A"`, `"loop"`, other, none) needs no wait: say it ends at its next follow-up.',
            "Then Arm from this conversation.",
            "Without a yes, change nothing.",
            "Never offer a restart from `lastRefresh` while `mode` is an older value.",
        ):
            self.assertIn(must, older)
        self.assertNotIn("Write `switchAskedAt` either way", older)
        self.assertLess(older.index("wait until they say it's gone"), older.index("Then Arm"))
        self.assertEqual(self.ref().count("lastRefresh"), 1, "no other check may use lastRefresh")
        self.assertIn('`"B"` is a recurring task', section(self.ref(), "Where it's stored"))

    def test_dead_chain_asks_before_rearming(self):
        """Owner's call (Nov 12) and M2: a refresh the user asked for asks before restarting a dead chain, and a chain
        with a run going isn't dead; skipped on a first run and when the user's refresh lost the lock."""
        dead = bullet(self.after(), "Chain stopped:")
        for must in (
            '`mode` `"chain"`, now inside the chosen hours',
            "over 30 minutes past",
            "no run going (`refresh/status` isn't `\"running\"` from the last 20 minutes, and `lastRunAt` isn't from the last 30)",
            "**Ask first:**",
            "**On yes:** Arm from this conversation",
            "Without a yes, arm nothing",
        ):
            self.assertIn(must, dead)
        intro = self.after().split("\n")[1]
        self.assertIn(
            "Skip this on a first run, and when the refresh was skipped because another run holds the lock.", intro
        )
        self.assertIn("(never for a stored prompt or follow-up", intro, "the typed-request guard covers Chain stopped")
        self.assertIn("the schedule check (SKILL.md › Scheduled runs)", in_skill("references", "first-run.md"))

    def test_recurring_task_kept_only_when_bound(self):
        tools = section(self.ref(), "Tools")
        self.assertIn('"cloud only"', tools)
        self.assertIn('"not bound"', tools)
        rec = bullet(self.setup_scheduling(), "A recurring task tied to this computer")
        for must in (
            "Keep it only if the result says it's tied to this computer.",
            "disable it (without a cancelling tool, ask the user to delete it on the app's Scheduled page), store a new token",
            "`{armId:<token>, nextAt:null, tool, problem:null}` (clearing any `problem` a failed choice 1 left)",
            '"Require this computer"',
            "find their token stale",
        ):
            self.assertIn(must, rec)

    def test_only_visible_tools(self):
        self.assertIn("Use only a tool you can see", self.ref())
        self.assertIn("Never call a name from this file that you can't see", self.ref())

    def test_no_scheduler_path(self):
        none = bullet(self.setup_scheduling(), "No scheduling tool here:")
        self.assertIn('mode:"manual"', none)
        self.assertIn("`refresh/schedule.armId` to null", none)
        self.assertIn("<refreshPhrase>", none)

    def test_scheduling_reference_stays_small(self):
        """Read on every scheduled run (hourly). 10,500 since R14 (v1.23.0) added the end-of-run step, the overlap and the
        early arm's approval note; 12,500 since F30 step 2 (v1.37.0) added Reply checks (about 500 tokens a refresh)."""
        self.assertLess(len(self.ref().encode()), 12500)

    def reply_checks(self):
        return section(self.ref(), "Reply checks")

    def test_reply_checks_are_a_recurring_task_tied_to_this_computer(self):
        """F30 step 2: a recurring task tied to this computer (posting needs the user's Chrome), its cron carrying both
        the interval and the hours, its prompt naming the reply-check skill and the page; no tool: change nothing."""
        rc = self.reply_checks()
        for must in (
            "`create_trigger` with `requires_local_device:true`",
            "say so and change nothing",
            "`*/<every> <hours> * * *`",
            "`*/10 5-21 * * *`",
            "Keep it only if its result confirms the tie",
            '"Automatically approve"',
            "can pause the task",
        ):
            self.assertIn(must, rc)
        prompts = re.findall(r"`(Scheduled reply check[^`]*)`", rc)
        self.assertEqual(
            prompts,
            [
                "Scheduled reply check (recurring <armId>): use the messenger-catchup:reply-check skill on the page <page url>."
            ],
        )

    def test_reply_checks_change_and_stop(self):
        """Changing arms a new task with a new armId before the old one is disabled, so a failure leaves the old one;
        stopping disables it and clears the choice. A check reads no token, so an old task left enabled keeps checking."""
        rc = self.reply_checks()
        change = bullet(rc, "Change:")
        self.assertIn("new `armId`", change)
        self.assertLess(change.index("Set up"), change.index("`update_trigger` `enabled:false`"))
        self.assertIn("`list_triggers`", change)
        self.assertIn("`replyCheck:null`", bullet(rc, "Stop:"))
        self.assertIn("ask the user to delete it on the app's Scheduled page", rc)
        self.assertIn("no `refresh/schedule`", rc)

    def test_reply_check_choice_stored(self):
        """`meta/chat.replyCheck` holds the choice; its hours default to the refresh schedule's."""
        stored = bullet(self.reply_checks(), "Stored:")
        for must in ("`meta/chat.replyCheck` `{every, hours, tz, armId}`", "`meta/chat.schedule.hours`"):
            self.assertIn(must, stored)
        meta = re.search(r"^- `meta/chat`:(.*)$", in_skill("references", "database.md"), re.M).group(1)
        self.assertIn("`replyCheck` (`{every, hours, tz, armId}`", meta)
        self.assertIn("`references/scheduling.md` › Reply checks", meta)

    def test_a_scheduled_reply_check_is_not_a_scheduled_run(self):
        """Its prompt names the page, which would make it a scheduled refresh under A scheduled run's rule."""
        intro = self.run_steps().split("\n1. ")[0]
        self.assertIn('A message starting "Scheduled reply check" never is', intro)
        self.assertIn('"Scheduled reply check"', section(in_skill("SKILL.md"), "Which part to follow"))
        self.assertIn(
            '- **"Check replies", or a message starting "Scheduled reply check":** `messenger-catchup:reply-check`.',
            in_skill("SKILL.md"),
        )

    def test_setup_routes_reply_check_scheduling(self):
        which = bullet(in_setup("SKILL.md"), "Reply checks")
        for must in (
            '"schedule reply checks"',
            '"check replies every 10 minutes"',
            '"stop reply checks"',
            "`references/scheduling.md` › Reply checks",
            "step 2's lookup only",
        ):
            self.assertIn(must, which)
        desc = json.loads(re.search(r"^description: (.*)$", in_setup("SKILL.md"), re.M).group(1))
        self.assertIn("reply checks", desc)
        self.assertIn("schedule, change or stop reply checks", self.ref().split("\n## ")[0])

    def test_desktop_requirement(self):
        self.assertIn("**The Claude Desktop app is open**", section(in_setup("SKILL.md"), "Requirements"))
        self.assertIn("**Claude Desktop app**", section(read("README.md"), "Requirements"))
        # R10 (v1.25.0): the page's own requirements say it too, in the same words as setup (claude.ai, the phone, Cowork, a schedule)
        page = re.sub(r"\s+", " ", read("plugin", "skills", "refresh", "assets", "page.html"))
        self.assertIn("Keep the Claude Desktop app open on that computer too", page)
        self.assertIn("when a refresh runs from claude.ai, the phone, Cowork or a schedule", page)

    def test_stop_and_change_leave_one_schedule(self):
        """H1 and H2: stopping clears the token, so every old follow-up and task goes stale; a recurring task that
        can't be cancelled is deleted by the user; an older mode's task is cancelled before the new one starts."""
        stop = bullet(self.setup_scheduling(), "Stop or change:")
        for must in (
            "`refresh/schedule` `{armId:null, nextAt:null}` (create it if it doesn't exist)",
            "finds its token stale",
            "a recurring task keeps firing",
            "ask the user to delete it on the app's Scheduled page",
            "With an older `mode`",
            "A recurring task (`\"B\"`) or recurring cron you can't cancel: ask the user to delete it in the app and wait until they say it's gone before setting up the new choice, so two schedules never run.",
            "An old chain needs no wait: its next follow-up finds the schedule changed and stops.",
            "only ever one",
        ):
            self.assertIn(must, stop)

    def test_rerunning_setup_stops_the_old_schedule_first(self):
        """M-e: setup run again on a page with a schedule does Stop or change before choosing a new one."""
        sched = self.setup_scheduling()
        first = bullet(sched, "A schedule already set")
        self.assertIn(
            '`meta/chat.schedule.mode` is set and isn\'t `"manual"`, older values included): do Stop or change first.',
            first,
        )
        self.assertLess(sched.index(first), sched.index("- Then use the first of these that works"))

    def test_a_refused_lock_write_still_reschedules(self):
        """A scheduled run that loses the lock at step 1 writes nothing, but still arms the next run."""
        one = step(section(in_skill("SKILL.md"), "Refresh steps"), 1)
        self.assertIn("skip quietly without writing anything (scheduled: still reschedule).", one)

    def test_claude_code_cli_is_a_chain_tool(self):
        """Owner's call (Nov 12): the Claude Code CLI is supported, with a warning that the session must stay open."""
        chain = bullet(self.ref(), "One-time follow-up into this conversation")
        for must in ("`CronCreate` with `recurring:false`", "Claude Code CLI", "stays open"):
            self.assertIn(must, chain)
        self.assertIn("in Claude Code the session must stay open", self.setup_scheduling())

    def test_a_missing_schedule_document(self):
        """M4: refresh/schedule may not exist (older pages, recurring setups): writes create it, and no nextAt means no
        chain is armed; setup creates it for every choice."""
        stored = section(self.ref(), "Where it's stored")
        self.assertIn("Get it before each write and pin the write (`set` it if it doesn't exist).", stored)
        self.assertIn("null or missing means no chain is armed", stored)
        self.assertIn(
            "Each choice also sets `refresh/schedule` (create it if it doesn't exist)", self.setup_scheduling()
        )

    def test_arm_ids_are_unique(self):
        """L2: two first arms in the same second can't share a token."""
        stored = section(self.ref(), "Where it's stored")
        self.assertIn("UTC time plus 4 random characters", stored)
        self.assertRegex(stored, r"`\d{8}T\d{6}Z-[a-z0-9]{4}`")

    def test_chain_run_arms_before_the_refresh(self):
        """R14: a chain run arms right after the stale and hours checks, so a run that dies mid-refresh still leaves
        the next one armed."""
        five = step(self.run_steps(), 5)
        self.assertIn(
            "A chain run then Arms, before the refresh steps, so the next run is armed even if this one dies.", five
        )
        self.assertLess(five.index("{lastRunAt}"), five.index("Arms"))
        self.assertLess(five.index("Arms"), five.index("Then do the refresh steps."))
        self.assertTrue(five.endswith("Then do the refresh steps."), five)
        runs = section(in_skill("SKILL.md"), "Scheduled runs")
        self.assertIn("arms the next run before the refresh (only ever one, even if this run dies)", runs)

    def test_early_arm_counts_nothing_yet(self):
        """R14: the early arm writes a new armId and nextAt and leaves misses as it was."""
        write = step(self.arm(), 4)
        self.assertIn("from a chain run (its early arm, or outside the hours), unchanged", write)
        self.assertNotIn("plus 1", write)
        self.assertIn("A scheduled run, step 6", write)

    def test_end_of_run_records_only_misses(self):
        """R14: the end of a chain run gets refresh/schedule and, only while armId is still its token, sets misses,
        pinned; it never arms again or touches nextAt and problem."""
        six = step(self.run_steps(), 6)
        for must in (
            "Get `refresh/schedule`.",
            "If `armId` is still the last token this run wrote (its early arm's, or its own if Arm wrote none), set `misses`, pinned",
            "Leave `nextAt` and `problem` as Arm left them.",
            "If refused, do this step again.",
            "If `armId` has changed, another session armed: write nothing.",
        ):
            self.assertIn(must, six)
        self.assertNotRegex(six, r"\bArms\b|\bArm\b(?! (wrote|left))", "the end of a run never arms")

    def test_overlapping_runs_keep_one_chain(self):
        """R14, review of release A: the early-armed next run starts `every` after this one, so it finds a running
        run's lock fresh only when that delay is under 20 minutes (the lock's stale age). For usual settings it takes the
        lock over (BACKLOG R18), and pinned writes stop the run whose write is refused. Either way it arms its own
        successor first, so this run's end writes nothing."""
        overlap = bullet(self.run_steps(), "Overlap")
        stale = int(re.search(r"its `startedAt` is less than (\d+) minutes old", in_skill("SKILL.md")).group(1))
        for must in (
            "(BACKLOG R18)",
            "the run this one armed starts `every` minus 3 minutes after this one did",
            "That run Arms its own successor.",
            "If that delay is under %d minutes, this run's lock is still fresh: it skips for the lock and sets `misses` to 0."
            % stale,
            "Otherwise the lock is over %d minutes old: it takes it over as stale and refreshes beside this run"
            % stale,
            "a run whose write is refused while another run's `running` is in `refresh/status` stops",
            "`references/writing-the-build.md` › Refused writes",
            "Either way this run's step 6 finds `armId` changed and writes nothing",
            "one chain, no miss counted twice",
        ):
            self.assertIn(must, overlap)
        self.assertIn("### R18", read("docs", "BACKLOG.md"))
        refused = section(in_skill("references", "writing-the-build.md"), "Refused writes")
        self.assertIn("if `refresh/status` now shows another run's `running`", refused)

    def test_runs_start_every_apart(self):
        """Review of release A: the early arm counts the delay from the run's start. `every` minus 3 minutes keeps starts
        close to the user's choice (57 minutes for hourly; minus 5 ran 5 minutes early), while a wake 1-2 minutes late
        after a short run still lands inside the prompt cache (LEARNINGS › Cost)."""
        delay = step(self.arm(), 3)
        self.assertIn("A chain run arms as it starts, so runs start `every` minus 3 minutes apart", delay)
        self.assertIn("a wake a minute or two late still finds the prompt cache warm", delay)
        self.assertEqual(set(re.findall(r"`every` minus (\d+)", self.ref())), {"3"}, "one delay everywhere")
        self.assertIn("A follow-up is armed `every` minus 3 minutes after a run starts", read("docs", "DECISIONS.md"))

    def test_an_early_arm_stuck_on_approval(self):
        """Review of release A: an approval on the early arm holds the refresh up, and only a run with the user present
        meets one."""
        five = step(self.arm(), 5)
        for must in (
            "A chain run arms before its refresh, so such a call holds the refresh up too until the user answers it.",
            "Only a run with the user present (setup, a refresh they asked for) meets an approval: unattended chain runs already need none.",
        ):
            self.assertIn(must, five)

    def test_superseded_and_failed_early_arms(self):
        """R14: losing the arm to another session stops the run; a failed arm (no tool, a tool error) follows Arm's
        problem/nextAt:null rule and the refresh goes ahead."""
        five = step(self.run_steps(), 5)
        self.assertIn(
            "If Arm stops because another session armed, this run is superseded: stop without refreshing or writing anything more.",
            five,
        )
        self.assertIn("If Arm fails (no tool, or the tool returns an error), the refresh still goes ahead.", five)
        self.assertIn("write `problem` (what happened) and `nextAt:null`", step(self.arm(), 5))

    def test_outside_hours_runs_skip_the_end_step(self):
        """R14: a run outside the hours arms for the window and stops; it reached nothing, so it counts nothing."""
        outside = step(self.run_steps(), 4)
        self.assertIn("Chain: Arm (it aims for the window's start), then stop, skipping step 6.", outside)

    def test_dead_chain_check_reads_an_early_armed_next_at(self):
        """R14: nextAt is now set as a run starts, so a live chain's nextAt is ahead even mid-run."""
        dead = bullet(self.after(), "Chain stopped:")
        self.assertIn("(a chain run arms as it starts, so a live chain's `nextAt` is ahead even mid-run)", dead)

    def test_recurring_quiet_counts_from_the_window_start(self):
        """L1: a recurring task isn't called quiet just because the night had no runs."""
        quiet = bullet(self.after(), "Recurring task quiet:")
        self.assertIn("since the later of `lastRunAt` and the start of the current window", quiet)


class TestPrePushHook(unittest.TestCase):
    """.githooks/pre-push blocks direct pushes to main (installed by npm run setup)."""

    HOOK = os.path.join(ROOT, ".githooks", "pre-push")

    def push(self, remote_ref):
        return subprocess.run(
            [self.HOOK, "origin", "url"],
            input="refs/heads/x 1111 %s 2222\n" % remote_ref,
            capture_output=True,
            text=True,
        ).returncode

    def test_executable(self):
        self.assertTrue(os.access(self.HOOK, os.X_OK))

    def test_blocks_main(self):
        self.assertEqual(self.push("refs/heads/main"), 1)

    def test_allows_branches_and_tags(self):
        self.assertEqual(self.push("refs/heads/fix/thing"), 0)
        self.assertEqual(self.push("refs/tags/v9.9.9"), 0)

    def test_ci_workflow_has_the_three_jobs(self):
        wf = read(".github", "workflows", "test.yml")
        for job in ("  test:", "  version-bump:", "  pr-only:"):
            self.assertIn("\n" + job + "\n", wf)
        self.assertIn("npm test", wf)


class TestOutboxStates(unittest.TestCase):
    def test_page_labels_every_outbox_state_skill_uses(self):
        out, page = in_skill("references", "outbox.md"), in_skill("assets", "page.html")
        states = {st for st in ("queued", "sending", "sent", "failed", "unconfirmed") if re.search(r"\b%s\b" % st, out)}
        self.assertTrue({"queued", "sending", "sent", "failed", "unconfirmed"} <= states, states)
        labels = re.search(r'\{\s*queued:\s*"queued",[^}]*\}', page).group(0)
        for st in states - {"cancelled"}:
            self.assertIn(st + ":", labels, "page has no label for outbox state " + st)

    ALL_STATES = ("queued", "sending", "sent", "failed", "unconfirmed", "cancelled", "dismissed")

    def page_writes(self):
        """The page's five outbox writes: Queue reply and React (set), Cancel, Dismiss and the react picker's cancel of a
        queued reaction (update)."""
        page = in_skill("assets", "page.html")
        writes = re.findall(r'doc\("outbox/"\s*\+\s*[\w.]+\)\s*\.(set|update)\(\s*(\{[^{}]*\})\s*\)', page)
        self.assertEqual(len(writes), 5, "expected exactly 5 outbox writes in page.html; the regex or the page changed")
        return writes

    def outbox_line(self):
        return re.search(r"^- `outbox/r<ms>`.*$", in_skill("references", "database.md"), re.M).group(0)

    def test_database_md_documents_every_outbox_field_and_state(self):
        """G6: every field and state the page writes, every state outbox.md uses, and Claude's own fields are on
        database.md's outbox line."""
        writes, line = self.page_writes(), self.outbox_line()
        fields = {k for _, lit in writes for k in re.findall(OBJ_KEYS, lit)}
        states = {s for _, lit in writes for s in re.findall(r'state:\s*"(\w+)"', lit)}
        self.assertEqual(states, {"queued", "cancelled", "dismissed"})
        self.assertTrue({"i", "mid", "to", "snip", "text", "queuedAt", "cancelledAt", "dismissedAt"} <= fields, fields)
        out = in_skill("references", "outbox.md")
        states |= {st for st in self.ALL_STATES if "`%s`" % st in out or 'state:"%s"' % st in out}
        self.assertEqual(states, set(self.ALL_STATES))
        for name in fields | states | {"sentAt", "sentMid", "error"}:
            self.assertIn("`%s`" % name, line, "outbox field or state missing from database.md: " + name)
        self.assertIn('"no Messenger id"', line)
        self.assertIn("120 characters", line)
        self.assertIn('"[photo]"', line)

    def test_database_md_defines_coverage(self):
        meta = re.search(r"^- `meta/chat`:(.*)$", in_skill("references", "database.md"), re.M).group(1)
        self.assertIn('`coverage` (one short sentence the page shows after "Stored: N messages, #a to #b."', meta)
        self.assertIn('(mt.coverage ? ". " + mt.coverage : ".")', in_skill("assets", "page.html"))

    def test_open_message_queues_with_the_pages_fields(self):
        _, lit = [w for w in self.page_writes() if w[0] == "set"][0]
        fields = re.findall(OBJ_KEYS, lit)
        step = re.search(r"^5\. To queue it.*$", in_skill("references", "open-message.md"), re.M).group(0)
        self.assertIn('state:"queued"', step)
        self.assertIn("`outbox/r<ms>`", step)
        for f in fields:
            self.assertRegex(step, r"[{ ]%s[:,}]" % f, "open-message.md doesn't queue field " + f)


class TestOutboxPosting(unittest.TestCase):
    """Issue #32: about 3 calls per reply (§1), multi-line replies (§3), real sentAt (§5), and G6's rules."""

    def setUp(self):
        self.out = in_skill("references", "outbox.md")
        self.post = re.search(r"^## Posting\n.*", self.out, re.M | re.S).group(0)
        self.code = re.findall(r"```js\n(.*?)```", self.post, re.S)

    def section(self, start, end):
        return re.search(
            r"^- \*\*%s.*?(?=^- (?:\*\*)?%s)" % (re.escape(start), re.escape(end)), self.post, re.M | re.S
        ).group(0)

    def test_three_calls_per_reply(self):
        self.assertIn("About 3 calls per reply", self.post)
        self.assertEqual(len(self.code), 3, "call 1, the check, the confirm")
        c1 = self.section("Call 1, javascript_tool", "Call 2")
        c2 = self.section("Call 2, ArtifactData `batch`", "Call 3")
        c3 = self.section("Call 3, `browser_batch`", "After the last row")
        # call 1: jump, wait for the tip, the bar and the snip, the empty box, then insertText, in that order
        js = self.code[0]
        order = [
            "cmd: 'jump'",
            "{ wait: tip }",
            "'Replying to '",
            "sq(R.snip).slice(0, 20)",
            "if (sq(box.innerText)) return { fail:",
            "document.execCommand('insertText', false, first)",
        ]
        at = [js.find(s) for s in order]
        self.assertTrue(all(a >= 0 for a in at), list(zip(order, at)))
        self.assertEqual(at, sorted(at), "call 1 does its checks before it types")
        self.assertIn("{ wait: tip }", js)
        # call 2: the previous row's outcome and this row's sending, in one pinned batch
        self.assertIn('the pending outcomes, plus this row updated to `{state:"sending"}`', c2)
        self.assertIn("so a row's `sent` lands with the next row's `sending`", self.post)
        # call 3: later lines, the check, Return, the confirm
        steps = ["`shift+Return`", "the check", "`computer` key `Return`", "the confirm"]
        at = [c3.find(s) for s in steps]
        self.assertTrue(all(a >= 0 for a in at) and at == sorted(at), list(zip(steps, at)))
        self.assertIn("throws, which stops the batch, so Return never reaches the box", c3)
        self.assertIn("box?.blur()", self.code[1])
        self.assertIn("if (ab !== null) return { abort:", self.code[2])
        # a crash between rows leaves at most one row in sending
        self.assertIn("at most one row is ever in `sending`", self.post)
        self.assertIn("**stop posting** for this run, so a second row is never left in `sending`", c3)
        self.assertIn("at most one row is left in `sending`, and the settle check above finds it", self.post)
        self.assertIn("Never mark a reply that may have been sent as `failed`", c3)
        self.assertNotIn('Write `state:"sending"`, then press Enter', self.out)
        self.assertTrue(c1)

    def test_multi_line_replies(self):
        c3 = self.section("Call 3, `browser_batch`", "After the last row")
        self.assertIn("`text.split('\\n')`", c3)
        self.assertIn("never insert a `\\n`", c3)
        self.assertIn("skip the insert for an empty line", c3)
        self.assertIn("R.text.split('\\n')[0]", self.code[0])
        self.assertIn("sq(box.innerText) === sq(R.text)", self.code[1])
        self.assertIn("sq(m.innerText).includes(sq(R.text))", self.code[2])
        self.assertNotIn("innerText.trim()===text.trim()", self.out, "the exact match fails every multi-line reply")

    def test_sent_always_has_a_real_sent_at_and_sent_mid(self):
        self.assertIn("**`sent` always gets both `sentAt` and `sentMid`**", self.out)
        self.assertIn("never an estimate", self.out)
        self.assertIn("at: new Date().toISOString()", self.code[2])
        self.assertIn("add `sent` with `sentAt` = its `at` and `sentMid` = its `mid`", self.post)
        settle = re.search(r"^  - Found: mark it `sent`.*$", self.out, re.M).group(0)
        self.assertIn("`sentAt` set to that message's time (its `d` and `t`", settle)
        self.assertIn("When the user says it went out, look for it in the saved messages", self.out)

    def test_row_without_mid_fails(self):
        rule = re.search(r"^- \*\*No `mid`\*\*.*$", self.post, re.M).group(0)
        self.assertIn("don't open Messenger", rule)
        self.assertIn('`failed` with `error:"no Messenger id"`', rule)

    def test_sending_write_is_pinned_and_cancel_wins(self):
        c2 = self.section("Call 2, ArtifactData `batch`", "Call 3")
        self.assertIn("every write pinned with `if_version`", c2)
        self.assertIn("If this row's `state` is no longer `queued`, the user cancelled it on the page", c2)
        self.assertIn("their Cancel wins: clear the box, don't post it", c2)
        self.assertIn("Every write to a row is pinned with `if_version`", self.out)

    def test_failed_rows_are_never_retried(self):
        self.assertIn(
            "Failed rows are never retried, by you or by the page. To try again, the user queues a new reply.", self.out
        )


class TestSeveralChatsRules(unittest.TestCase):
    """F1 review of PR #60: rules that must hold on every page, one chat or several."""

    def test_approval_follows_a_chats_own_setting_in_both_skills(self):
        """A chat set to "wait for my yes" never posts on its own, even on a one-chat page where chats.md isn't read."""
        rs, sk = in_replies("SKILL.md"), in_skill("SKILL.md")
        for name, text in (("refresh", sk), ("replies", rs)):
            rule = re.search(r"^- \*\*Never send a message or add a reaction\*\*.*$", text, re.M).group(0)
            self.assertIn("`auto`", rule, name + " hard rule")
        step2 = re.search(r"^   - \*\*Replies first\*\*.*$", sk, re.M).group(0)
        self.assertNotIn("(`outboxAuto`, or a yes", step2, "refresh step 2 names the rule, not outboxAuto alone")
        r2 = re.search(r"^2\. \*\*Check approval\.\*\*.*$", rs, re.M).group(0)
        self.assertIn("`auto`", r2, "replies step 2")

    def test_cleanup_counts_every_chats_photos_as_in_use(self):
        """The asset store is shared by the page's chats: an added chat's photos are never unused."""
        c = in_skill("references", "photos.md").split("## Cleanup", 1)[1].split("\n## ", 1)[0]
        self.assertIn("`KEY_photos`", c)
        self.assertIn("`meta/chat.chats`", c)


class TestSendReplies(unittest.TestCase):
    """F30 part 1: "send replies" posts the approved queued replies without a refresh (the replies skill), and every
    refresh posts them before its scan. tests/sim.js (section S) runs these steps; these check the text they run."""

    def setUp(self):
        self.rs = in_replies("SKILL.md")
        self.run = section(self.rs, "Send replies")
        self.skill = in_skill("SKILL.md")
        self.out = in_skill("references", "outbox.md")

    def step(self, label):
        return bullet(self.run, label)

    def test_the_steps_in_order(self):
        """Approval before the lock (nothing locked or opened while the user decides), the lock before the tab."""
        steps = re.findall(r"^\d+\. \*\*(.+?)\.?\*\*", self.run, re.M)
        self.assertEqual(
            steps,
            [
                "Read the outbox",
                "Check approval",
                "Take the run lock",
                "Find the Messenger tab",
                "Post",
                "Release and report",
            ],
        )

    def test_a_reply_run_reads_little(self):
        """A reply run reads this SKILL.md, not the refresh's (read on every refresh, capped at 20 KB), plus outbox.md
        (and posting-with-helper.md when helperPost is on). It names no file only a refresh needs."""
        size = len(self.rs.encode())
        self.assertLess(size, 8000)
        self.assertLess(size, len(self.skill.encode()) / 2)
        for f in (
            "catchup.py",
            "page.html",
            "photos.md",
            "day-summaries.md",
            "scheduling.md",
            "writing-the-build.md",
            "first-run.md",
        ):
            self.assertNotIn(f, self.rs, f)
        self.assertNotRegex(self.rs, r"`(chunks|threading|summary)/", "a reply run reads no stored messages")

    def test_every_file_it_reads_is_in_its_folder(self):
        """A skill can only count on its own folder: what SKILL.md names is its own copy, and so is every file named by
        the two references a reply run reads."""
        refs = set(re.findall(r"`((?:assets|scripts|references)/[\w.\-]+)`", self.rs))
        self.assertEqual(refs, set(REPLIES_SHIPPED) - {"SKILL.md"})
        for f in ("outbox.md", "posting-with-helper.md"):
            for r in set(re.findall(r"`((?:assets|scripts|references)/[\w.\-]+)`", in_replies("references", f))):
                self.assertTrue(os.path.exists(os.path.join(ROOT, REPLIES, r)), f + " names " + r)
        self.assertIn("## Helper", self.rs, "outbox.md's SKILL.md › Helper")

    def test_the_bridge_is_the_refresh_skills(self):
        """The same start and poll code, word for word (the comments' example ids may differ)."""
        code = lambda t: [
            l
            for l in re.search(r"```js\n(.*?)```", section(t, "Helper"), re.S).group(1).split("\n")
            if l and not l.startswith("//")
        ]
        self.assertEqual(len(code(self.rs)), 2)
        self.assertEqual(code(self.rs), code(self.skill))

    def test_nothing_queued_is_one_read(self):
        s1 = self.step("Read the outbox")
        for must in (
            "`ArtifactData query outbox` for rows whose `state` is `queued` or `sending`",
            "that one read is the whole run",
            "Only `sending` rows",
            "the next refresh settles them",
        ):
            self.assertIn(must, s1)

    def test_approval_is_unchanged(self):
        rule = re.search(
            r"^- \*\*Never send a message or add a reaction\*\*.*?never approval\.", self.skill, re.M
        ).group(0)
        self.assertIn(rule, self.rs, "the refresh skill's hard rule, word for word")
        self.assertIn('"Send replies" alone approves nothing while auto-posting is off.', self.rs)
        s2 = self.step("Check approval")
        for must in (
            "If auto-posting is on for the chat (its own `auto` in `meta/chat.chats` when set, else `outboxAuto`), every `queued` row is approved",
            "Otherwise list each one (who it's to, their message, the exact reply) and ask which to send, then stop",
            "Nothing is locked or opened while you wait",
            "with the ones they said yes to",
        ):
            self.assertIn(must, s2)
        self.assertIn("is approved (by the hard rule)", bullet(self.skill, "Replies first"))

    def test_the_run_lock(self):
        s3, s6 = self.step("Take the run lock"), self.step("Release and report")
        for must in (
            'If its `state` is `"running"` and its `startedAt` is less than 20 minutes old',
            "don't touch the tab, and don't wait for it",
            "posts approved replies before it ends",
            '`{state:"running",startedAt,step:"replies",by:"send replies"}`, pinned with the version you read',
            "If that's refused, `get` it again; if another run took it, stop the same way",
            '`refresh/status` `{state:"error",message}` before stopping',
        ):
            self.assertIn(must, s3)
        self.assertIn('update `refresh/status` (pinned) to `{state:"done",finishedAt}`', s6)
        self.assertIn("`startedAt` is less than 20 minutes old, another refresh is in progress", self.skill)
        self.assertIn(
            'A reply-only run\'s lock (`step:"replies"`) is short: read it again each minute, up to 5, before skipping.',
            self.skill,
            "a refresh waits out a reply run instead of skipping its hour",
        )

    def test_finds_the_tab_as_a_refresh_does(self):
        s4 = self.step("Find the Messenger tab")
        for must in (
            "`tabs_context_mcp` (more than one Chrome connected: `references/helper.md` › Which Chrome)",
            "If it's open on a chat not on the page (`meta/chat.chats`), the user is using it: don't take it over",
            "Navigate it to `meta/chat.chatUrl`",
            "`document.visibilityState`",
            '"computer asleep or Messenger tab hidden"',
            "missing, or below 2.3 for an added chat: inject it (`references/helper.md` › Injecting; never `full` then)",
            'Run `selfcheck`: if `ok` is false, stop with "Messenger changed: "',
        ):
            self.assertIn(must, s4)

    def test_posts_by_outbox_md_and_leaves_sending_rows(self):
        s5 = self.step("Post")
        for must in (
            "`references/posting-with-helper.md` too when `meta/chat.helperPost` is true and the helper is 2.0 or later",
            "Post the approved rows by outbox.md › Posting",
            "skip outbox.md's settle step and its stored-message check",
            "`sending` rows from earlier runs stay as they are for the next refresh to settle",
        ):
            self.assertIn(must, s5)
        self.assertIn(
            'A reply-only run skips this read: call 1 and `post` check the "Replying to" bar against `to` and `snip`',
            self.out,
        )
        settle = re.search(r'^- Settle any row left in `state:"sending"`.*$', self.out, re.M).group(0)
        for must in (
            "only **after this refresh's import** (its step 8)",
            "they hold anything this run posted before its scan",
            "Before the scan, and in a reply-only run, leave `sending` rows as they are",
        ):
            self.assertIn(must, settle)
        self.assertNotIn("First, settle any row", self.out)

    def test_routing(self):
        desc = lambda t: json.loads(re.search(r"^description: (.*)$", t, re.M).group(1))
        rd, fd = desc(self.rs), desc(self.skill)
        for must in ('"send replies"', '"send my replies"', "without a refresh", "messenger-catchup:refresh"):
            self.assertIn(must, rd)
        self.assertIn('"Send replies" alone (no refresh) is messenger-catchup:replies', fd)
        self.assertIn("posting replies they queued on it first", fd)
        self.assertIn(
            '- **"Send replies"** (post queued replies now, without a refresh): the `messenger-catchup:replies` skill.',
            section(self.skill, "Which part to follow"),
        )
        self.assertIn('"send replies" sends them at once without a refresh', in_setup("SKILL.md"))

    def test_replies_first_in_every_refresh(self):
        """Approved replies go out before the scan; settling `sending` rows waits for step 8, after the import."""
        first = bullet(self.skill, "Replies first")
        self.assertLess(self.skill.index(step(self.skill, 2)), self.skill.index(first))
        self.assertLess(self.skill.index(first), self.skill.index(step(self.skill, 3)))
        for must in (
            "`ArtifactData query outbox` for `queued` and `sending` rows",
            "post those now by its Posting section, then navigate the tab to `chatUrl` again",
            "`sending` rows and unapproved ones wait for step 8",
        ):
            self.assertIn(must, first)
        self.assertIn(
            'or to `{state:"running",step:"outbox",added}` if it found approved `queued` rows for step 8 to post',
            step(self.skill, 7),
        )
        step8 = step(self.skill, 8)
        for must in (
            "settle `sending` rows from the saved messages, post approved `queued` ones, and list the rest for a yes",
            "(a yes after this run: post with `messenger-catchup:replies`)",
        ):
            self.assertIn(must, step8)
        self.assertIn("a refresh, before its scan (its step 2) and for rows queued while it ran (step 8)", self.out)


class TestReleaseScript(unittest.TestCase):
    def test_release_script(self):
        f = os.path.join(ROOT, "tools", "release.sh")
        self.assertTrue(os.access(f, os.X_OK))
        self.assertEqual(subprocess.run(["sh", "-n", f]).returncode, 0)

    def test_release_waits_for_mains_ci(self):
        rel = read("tools", "release.sh")
        guard, tag = rel.index('sh tools/ci-green.sh "$(git rev-parse HEAD)"'), rel.index('git tag -a "$tag"')
        self.assertLess(guard, tag, "release.sh checks main's CI before it tags anything")

    def test_ci_green_takes_only_a_first_attempt_pass(self):
        # a fake gh prints what `gh run list ... -q` would for each case; ci-green.sh must pass only the last
        cases = [
            ("", 1, "no CI run on main"),
            ("7 in_progress  1", 1, "still running; watch it: gh run watch 7"),
            ("7 completed failure 1", 1, "failed (run 7); fix the cause in a new PR, or tell the owner"),
            ("7 completed failure 2", 1, "failed (run 7)"),
            ("7 completed success 2", 1, "passed only on attempt 2 (run 7); a re-run isn't a pass"),
            ("7 completed success 1", 0, "passed on its first attempt (run 7)"),
        ]
        for line, code, says in cases:
            with tempfile.TemporaryDirectory() as t:
                gh = os.path.join(t, "gh")
                with open(gh, "w") as fh:
                    fh.write("#!/bin/sh\nprintf '%%s' '%s'\n" % line)
                os.chmod(gh, 0o755)
                env = dict(os.environ, PATH=t + os.pathsep + os.environ["PATH"])
                r = subprocess.run(
                    ["sh", os.path.join(ROOT, "tools", "ci-green.sh"), "abc123"],
                    capture_output=True,
                    text=True,
                    env=env,
                )
                self.assertEqual(r.returncode, code, (line, r.stdout, r.stderr))
                self.assertIn(says, r.stdout + r.stderr, line)

    def test_notes_extraction_matches_changelog(self):
        v = read("VERSION").strip()
        out = subprocess.run(
            [
                "awk",
                "-v",
                "h=## [%s] " % v,
                "index($0,h)==1{f=1;next} /^## \\[/{f=0} f",
                os.path.join(ROOT, "CHANGELOG.md"),
            ],
            capture_output=True,
            text=True,
        ).stdout
        self.assertTrue(out.strip())
        self.assertNotIn("\n## [", out)


class TestReplyCheck(unittest.TestCase):
    """F30 option C, step 1: a frequent scheduled check that reads the outbox once and hands a waiting reply to the
    replies skill. It must stay tiny (it runs every few minutes) and never take "send replies" or a refresh."""

    def setUp(self):
        self.rc = read(REPLY_CHECK, "SKILL.md")
        self.desc = json.loads(re.search(r"^description: (.*)$", self.rc, re.M).group(1))

    def test_it_is_tiny(self):
        self.assertLess(len(self.rc.encode()), 1500)
        self.assertNotRegex(self.rc, r"`(assets|scripts|references)/", "it reads no file of its own")

    def test_routing(self):
        self.assertRegex(self.rc, r"(?m)^name: reply-check$")
        use, _, rest = self.desc.partition("Scheduling")
        phrases = re.findall(r'"([^"]+)"', use)
        self.assertEqual(phrases, ["check replies", "reply check", "Scheduled reply check"])
        self.assertIn("Use only for", self.desc)
        self.assertNotRegex(self.desc, r"(?i)send replies|send my replies|refresh|catch-up run")
        # F30 step 2: "check replies every 10 minutes" starts like "check replies"; scheduling them is setup's
        self.assertIn('"check replies every 10 minutes"', rest)
        self.assertIn("is messenger-catchup:setup", rest)
        self.assertIn(
            '- **"Check replies", or a message starting "Scheduled reply check":** `messenger-catchup:reply-check`.',
            section(in_skill("SKILL.md"), "Which part to follow"),
        )

    def test_a_scheduled_check_asks_nothing(self):
        """F30 step 2: a scheduled check is unattended (every 10 minutes); with auto-posting off, replies lists the
        waiting rows and stops instead of asking."""
        sched = re.search(r'(?m)^A message starting "Scheduled reply check".*$', self.rc).group(0)
        self.assertIn("never ask the user anything", sched)
        two = re.search(r"(?m)^2\. \*\*Check approval\.\*\*.*$", in_replies("SKILL.md")).group(0)
        self.assertIn(
            'From a scheduled reply check, ask nothing: list them, say "send replies" asks for the yes, and stop.', two
        )

    def test_reads_each_active_chat_then_stop_or_hand_over(self):
        """F30 step 2 (owner: "check each chat"): meta/chat, then one queued-row query per active chat (an added chat's
        KEY_outbox too); paused, hidden, deleted and pending chats are skipped. The cost is said honestly."""
        read_step = re.search(r"(?m)^2\. \*\*Reads:\*\*.*$", self.rc).group(0)
        for must in (
            "`ArtifactData get meta/chat`",
            "whose `state` is `active` (no `chats`: the one chat)",
            '`where` `["state","==","queued"]` and `limit` 1',
            "the first chat's (`home:true`) is `outbox`, an added chat KEY's `KEY_outbox`",
            'None anywhere: say "No replies waiting." and stop.',
            "(1 plus one per active chat)",
            "no other read, file, browser or schedule",
        ):
            self.assertIn(must, read_step)
        self.assertNotIn("one read", self.rc.lower())
        self.assertIn("1 read plus one per active chat", self.rc)
        self.assertIn("one database read plus one per active chat", self.desc)
        self.assertNotIn("sending", self.rc, "rows in sending are the next refresh's: they don't start a reply run")
        hand = re.search(r"(?m)^3\. .*$", self.rc).group(0)
        self.assertIn("follow `messenger-catchup:replies` on that page", hand)
        self.assertIn("for only the chats with a waiting row", hand)
        self.assertIn("never posts by itself", hand)
        self.assertNotRegex(self.rc, r"tabs_context_mcp|javascript_tool|refresh/status|outboxAuto")
        # replies does just those chats, each with its own auto, in its own thread
        several = section(in_replies("SKILL.md"), "Several chats")
        self.assertIn("From a reply check, do only the chats it found a queued row in.", several)
        self.assertIn("a reply never goes to another chat", several)
        self.assertIn("its `auto` in `meta/chat.chats` when set", in_replies("SKILL.md"))
        self.assertIn(
            "A reply check (`messenger-catchup:reply-check`)",
            section(in_skill("references", "chats.md"), "Replies in several chats"),
        )
        rc = section(in_skill("references", "scheduling.md"), "Reply checks")
        self.assertIn("`meta/chat` plus one outbox read per active chat", rc)
        self.assertNotIn("one outbox read;", rc)

    def test_B60_each_chat_gets_its_own_name_scan(self):
        """An added chat's step 8 reads its own people index and runs the one-time scan for it; emoji aren't names."""
        added = section(in_skill("references", "chats.md"), "Refreshing an added chat KEY")
        self.assertIn("`get` `KEY_people/index`, and when it has no `scannedAt`", added)
        self.assertIn("`count` = its `lastI` + 1", added)
        self.assertIn("(per chat: `references/chats.md`)", in_skill("SKILL.md"))
        self.assertIn("whose `full` has a letter in it", in_skill("references", "people.md"))
        self.assertIn('"Full Name (nickname)" when known', in_skill("SKILL.md"))

    def test_it_finds_the_page_as_the_replies_skill_does(self):
        self.assertIn(
            'an artifact titled "… Catch-up" whose `meta/chat` has `kind:"messenger-catchup"`', in_replies("SKILL.md")
        )
        self.assertIn('the artifact titled "… Catch-up" whose `meta/chat` has `kind:"messenger-catchup"`', self.rc)
        self.assertIn("the URL in the message, else the one this conversation uses", self.rc)


class TestZip(unittest.TestCase):
    def test_make_zip_contents(self):
        with tempfile.TemporaryDirectory() as t:
            dst = os.path.join(t, "some-other-clone-name")  # any folder name works (B10)
            files = (
                [".claude-plugin/plugin.json"]
                + ["skills/refresh/" + f for f in SHIPPED]
                + ["skills/setup/" + f for f in SETUP_SHIPPED]
                + ["skills/replies/" + f for f in REPLIES_SHIPPED]
                + ["skills/reply-check/" + f for f in REPLY_CHECK_SHIPPED]
            )
            for f in files:
                os.makedirs(os.path.dirname(os.path.join(dst, "plugin", f)), exist_ok=True)
                shutil.copy2(os.path.join(ROOT, "plugin", f), os.path.join(dst, "plugin", f))
            shutil.copy2(os.path.join(ROOT, "make-zip.sh"), dst)
            sk = os.path.join(dst, "plugin", "skills", "refresh")
            with open(os.path.join(sk, "assets", ".DS_Store"), "w") as f:
                f.write("junk")
            os.makedirs(os.path.join(sk, "scripts", "__pycache__"))
            with open(os.path.join(sk, "scripts", "__pycache__", "x.pyc"), "w") as f:
                f.write("junk")
            subprocess.run(["sh", os.path.join(dst, "make-zip.sh")], check=True, capture_output=True)
            names = sorted(
                n
                for n in zipfile.ZipFile(os.path.join(dst, "dist", "messenger-catchup-plugin.zip")).namelist()
                if not n.endswith("/")
            )
            self.assertEqual(
                names, sorted("messenger-catchup/" + f for f in files), "ZIP holds exactly the plugin's files, no junk"
            )

    def test_plugin_holds_only_shipped_files(self):
        """Everything under plugin/ reaches users; dev files stay outside it."""
        tracked = subprocess.run(
            ["git", "ls-files", "plugin"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.split()
        self.assertEqual(
            sorted(tracked),
            sorted(
                ["plugin/.claude-plugin/plugin.json"]
                + [SKILL + "/" + f for f in SHIPPED]
                + [SETUP + "/" + f for f in SETUP_SHIPPED]
                + [REPLIES + "/" + f for f in REPLIES_SHIPPED]
                + [REPLY_CHECK + "/" + f for f in REPLY_CHECK_SHIPPED]
            ),
        )


class TestPlugin(unittest.TestCase):
    """The repo is a marketplace (.claude-plugin/marketplace.json) serving the plugin in plugin/."""

    def setUp(self):
        import json

        self.plugin = json.loads(read("plugin", ".claude-plugin", "plugin.json"))
        self.market = json.loads(read(".claude-plugin", "marketplace.json"))

    def test_plugin_version_is_the_release_version(self):
        """Installed plugins update when this version changes, so it moves with every release."""
        self.assertEqual(self.plugin["version"], read("VERSION").strip())

    def test_names(self):
        self.assertEqual(self.plugin["name"], "messenger-catchup")
        self.assertEqual(self.market["name"], "rando-tools")
        (entry,) = self.market["plugins"]
        self.assertEqual(entry["name"], self.plugin["name"])
        self.assertEqual(entry["source"], "./plugin")
        self.assertNotIn("version", entry, "plugin.json carries the version")

    def test_skill_names_match_their_folders(self):
        root = os.path.join(ROOT, "plugin", "skills")
        for d in sorted(os.listdir(root)):
            name = re.search(r"^name: (\S+)$", read("plugin", "skills", d, "SKILL.md"), re.M).group(1)
            self.assertEqual(name, d)

    def test_descriptions_survive_yaml(self):
        """An unquoted ` #` starts a YAML comment: the loaded description stopped at "open (issue #33). A double-quoted
        description is read like a JSON string, so json.loads gives what Claude sees."""
        root = os.path.join(ROOT, "plugin", "skills")
        for d in sorted(os.listdir(root)):
            raw = re.search(r"^description: (.*)$", read("plugin", "skills", d, "SKILL.md"), re.M).group(1)
            if raw.startswith('"'):
                text = json.loads(raw)
            else:
                self.assertNotRegex(raw, r" #|: |^[\[{&*!|>'%@`]", d + ": quote the description")
                text = raw
            self.assertTrue(text.endswith("."), (d, text[-40:]))
            self.assertGreater(len(text), 200, d)

    def test_nothing_that_stops_claude_ai_installing_it(self):
        """claude.ai and Cowork refuse a plugin with a top-level bin/."""
        self.assertFalse(os.path.exists(os.path.join(ROOT, "plugin", "bin")))

    def test_claude_plugin_validate(self):
        exe = shutil.which("claude")
        if not exe:
            self.skipTest("claude CLI not installed")
        for target in ("plugin", "."):
            p = subprocess.run(
                [exe, "plugin", "validate", "--strict", target], cwd=ROOT, capture_output=True, text=True
            )
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)


def unclosed_files(root):
    """`path:line` of every `.py` file under root that reads or writes straight off `open()`. Folders are skipped by
    their name inside root, never by root's own path (a worktree under `.claude/` must still be scanned). The pattern
    runs over the whole file, so a call the formatter wrapped across lines is found too (`[^()]` matches newlines);
    the line given is the one `open(` is on."""
    pattern = re.compile(r"open\([^()]*(\([^()]*\)[^()]*)*\)\s*\.(read|write)\(")
    skip = {".git", "node_modules", ".venv", ".claude"}
    found = []
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in skip]
        for name in files:
            if name.endswith(".py"):
                path = os.path.join(d, name)
                with open(path, encoding="utf-8") as f:
                    text = f.read()
                for m in pattern.finditer(text):
                    found.append("%s:%d" % (os.path.relpath(path, root), text.count("\n", 0, m.start()) + 1))
    return sorted(found)


class TestNoUnclosedFiles(unittest.TestCase):
    def test_no_open_read_or_write_one_liners(self):
        """Reading or writing straight off `open()` leaves the file to the garbage collector, which prints "Exception ignored … ResourceWarning"
        that `-W error::ResourceWarning` can't fail on (BACKLOG C8). Use `with open(...)`."""
        self.assertEqual(unclosed_files(ROOT), [])

    def test_scanner_finds_planted_files_under_a_claude_path(self):
        """The scan must not pass vacuously: Claude Code worktrees live under `.claude/worktrees/`, so a checkout's own path
        can contain `.claude`. Only folders inside the checkout are skipped, `.github` is scanned, and a call the formatter
        wrapped across lines is still found."""
        op = "op" + "en"  # spelled apart so this file doesn't plant a match in the real scan
        planted = {
            "tools/a.py": "x = %s('a').read()\n" % op,
            "tools/b.py": "import os\n%s(\n    os.path.join('a', 'b'), 'w'\n).write('x')\n" % op,
            ".github/c.py": "%s('c', 'w').write('x')\n" % op,
            "tools/ok.py": "with %s('a') as f:\n    f.read()\n" % op,
            "node_modules/d.py": "%s('d').read()\n" % op,
            ".claude/e.py": "%s('e').read()\n" % op,
            ".venv/lib/f.py": "%s('f').read()\n" % op,
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, ".claude", "worktrees", "agent-x")
            for rel, text in planted.items():
                path = os.path.join(root, rel)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)
            self.assertEqual(unclosed_files(root), [".github/c.py:1", "tools/a.py:1", "tools/b.py:2"])


if __name__ == "__main__":
    unittest.main()
