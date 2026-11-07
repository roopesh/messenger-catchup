"""Repo-level checks: helper copies in sync, the sync tool itself, the skill ZIP, and SKILL.md's file references.
Run: python3 -m unittest discover -s tests"""

import html, importlib.util, os, re, shutil, subprocess, tempfile, unittest, urllib.parse, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("sync_helper", os.path.join(ROOT, "tools", "sync-helper.py"))
sync = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sync)


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as fh:
        return fh.read()


REFERENCES = ["database.md", "open-message.md", "outbox.md", "setup.md", "troubleshooting.md"]
SHIPPED = ["SKILL.md", "VERSION", "assets/page.html", "assets/helper.user.js", "scripts/catchup.py"] + [
    "references/" + f for f in REFERENCES
]


class TestHelperCopies(unittest.TestCase):
    def setUp(self):
        self.src = read("assets", "helper.user.js")
        self.page = read("assets", "page.html")

    def textarea(self, page, tid):
        return html.unescape(re.search(r'<textarea id="%s"[^>]*>(.*?)</textarea>' % tid, page, re.S).group(1))

    def test_page_in_sync(self):
        self.assertEqual(sync.generate(self.page, self.src), self.page, "run tools/sync-helper.py")

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

    def test_check_mode_exit_code(self):
        p = subprocess.run(
            ["python3", os.path.join(ROOT, "tools", "sync-helper.py"), "--check"], capture_output=True, text=True
        )
        self.assertEqual(p.returncode, 0, p.stderr)


class TestVersions(unittest.TestCase):
    def test_helper_version_strings_agree(self):
        src = read("assets", "helper.user.js")
        found = {
            re.search(r"@version\s+(\S+)", src).group(1),
            re.search(r"__mcHelper\s*=\s*'([^']+)'", src).group(1),
            re.search(r"setAttribute\('data-mc-helper',\s*'([^']+)'\)", src).group(1),
            re.search(r"ping:\s*\(\)\s*=>\s*\(\{\s*v:\s*'([^']+)'\s*\}\)", src).group(1),
        }
        self.assertEqual(len(found), 1, found)

    def test_page_has_no_document_skeleton(self):
        """The Artifact tool adds the skeleton at publish time and only recognizes its own exact one, so the page stores none."""
        page = read("assets", "page.html")
        self.assertTrue(page.startswith("<title>"), page[:60])
        self.assertNotRegex(page, r"(?i)<!doctype|<html[\s>]|<body[\s>]")

    def test_component_versions_read_the_same_as_decimals(self):
        """Minor parts stay one digit (1.9 -> 2.0, never 1.10): read as decimals, 1.1 and 1.10 look equal and a
        republish or update notice could be skipped."""
        page, src = read("assets", "page.html"), read("assets", "helper.user.js")
        for name, v in (
            ("PAGE_VERSION", re.search(r'const PAGE_VERSION\s*=\s*"([^"]+)"', page).group(1)),
            ("helper @version", re.search(r"@version\s+(\S+)", src).group(1)),
        ):
            self.assertRegex(v, r"^\d+\.\d$", name + " " + v)

    def test_page_version_present(self):
        self.assertRegex(read("assets", "page.html"), r'const PAGE_VERSION\s*=\s*"\d+\.\d+";')

    def test_page_version_bumped_when_page_changed_since_last_release(self):
        """assets/page.html differs from the newest release tag -> PAGE_VERSION must differ too (pages only republish on a bump)."""
        tags = subprocess.run(
            ["git", "tag", "--list", "v*", "--sort=-v:refname"], cwd=ROOT, capture_output=True, text=True
        ).stdout.split()
        if not tags:
            self.skipTest("no release tags (shallow clone?)")
        old = subprocess.run(["git", "show", tags[0] + ":assets/page.html"], cwd=ROOT, capture_output=True, text=True)
        if old.returncode:
            self.skipTest("page not in " + tags[0])
        ver = lambda s: re.search(r'const PAGE_VERSION\s*=\s*"([^"]+)"', s).group(1)
        if old.stdout != read("assets", "page.html"):
            self.assertNotEqual(
                ver(old.stdout),
                ver(read("assets", "page.html")),
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

    def test_changelog_versions_descend(self):
        vs = [tuple(map(int, v.split("."))) for v in re.findall(r"^## \[(\d+\.\d+\.\d+)\]", read("CHANGELOG.md"), re.M)]
        self.assertEqual(vs, sorted(vs, reverse=True))
        self.assertEqual(len(vs), len(set(vs)), "duplicate CHANGELOG version")


class TestNoLeftoverNames(unittest.TestCase):
    def test_no_pa_names_in_shipped_files(self):
        for f in SHIPPED:
            self.assertNotRegex(
                read(f), r"\bcc(Scan|Verify|Capture)\b|cctool|cc-capture|cc-cmd|cc_result", f
            )


class TestSkillReferences(unittest.TestCase):
    def test_every_db_path_the_page_uses_is_documented(self):
        page, skill = read("assets", "page.html"), read("SKILL.md") + read("references", "database.md")
        paths = set(re.findall(r'db\s*\.(?:collection|doc)\(\s*"([^"]+)"\s*\)', page))
        self.assertGreater(len(paths), 10)
        for p in paths:
            top = p.split("/")[0]
            self.assertTrue(("`%s`" % p in skill) or ("`%s/" % top in skill), "SKILL.md never mentions " + p)

    def test_every_meta_chat_field_the_page_writes_is_documented(self):
        page, skill = read("assets", "page.html"), read("references", "database.md")
        lits = (
            re.findall(r"const upd\s*=\s*\{([^{}]*)\}", page)
            + re.findall(r'doc\("meta/chat"\)\s*\.update\(\{([^{}]*)\}', page)
            + re.findall(r"Object\.assign\(\{\s*(markerMode[^{}]*)\}", page)
            + re.findall(r'setMarker\("time",\s*\{([^{}]*)\}', page)
        )
        fields = set(k for l in lits for k in re.findall(r"(\w+):", l)) | set(re.findall(r"\bupd\.(\w+)\s*=", page))
        self.assertTrue({"lastI", "ownLastMid", "markerTo", "caughtUpAt"} <= fields, fields)
        meta = re.search(r"^- `meta/chat`:(.*)$", skill, re.M).group(1)
        for f in fields:
            self.assertIn("`%s`" % f, meta, "meta/chat field not documented in SKILL.md: " + f)

    def test_every_referenced_file_exists(self):
        text = read("SKILL.md") + "".join(read("references", f) for f in REFERENCES)
        refs = set(re.findall(r"`((?:assets|scripts|references)/[\w.\-]+)`", text))
        self.assertTrue(refs)
        for r in refs:
            self.assertTrue(os.path.exists(os.path.join(ROOT, r)), r)

    def test_skill_names_every_reference_file(self):
        """Claude only opens a reference file SKILL.md tells it about; an unnamed file would never be read."""
        skill = read("SKILL.md")
        self.assertEqual(sorted(os.listdir(os.path.join(ROOT, "references"))), REFERENCES)
        for f in REFERENCES:
            self.assertIn("`references/%s`" % f, skill, f)

    def test_skill_stays_small(self):
        """SKILL.md is read on every refresh (hourly); keep on-demand material in references/ (BACKLOG C7)."""
        self.assertLess(len(read("SKILL.md").encode()), 20000)

    def test_skill_database_lines_match_the_reference(self):
        """The few database lines SKILL.md repeats must stay word for word the same as references/database.md."""
        ref = read("references", "database.md").split("\n")
        core = re.search(r"^## Database.*?(?=^## )", read("SKILL.md"), re.M | re.S).group(0)
        prefixes = ("- `chunks/", "- `threading/", "- `summary/", "- `people/", "- `photos/")
        shared = [l for l in core.split("\n") if l.startswith(prefixes)]
        self.assertEqual(len(shared), 5)
        for l in shared:
            self.assertIn(l, ref)

    def test_setup_points_at_the_field_names_it_seeds(self):
        """Setup seeds meta/chat from the user's answers; the field names live in references/database.md."""
        seed = re.search(r"^4\. \*\*Seed the database\*\*.*$", read("references", "setup.md"), re.M).group(0)
        self.assertIn("`references/database.md`", seed)

    def test_outbox_is_read_before_any_reply_is_posted(self):
        skill = read("SKILL.md")
        step8 = re.search(r"^8\. Handle the outbox.*$", skill, re.M).group(0)
        self.assertIn("read `references/outbox.md` in full first", step8)
        self.assertIn("Never send a message", skill, "the hard rule stays in SKILL.md")


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
        out, page = read("references", "outbox.md"), read("assets", "page.html")
        states = {st for st in ("queued", "sending", "sent", "failed", "unconfirmed") if re.search(r"\b%s\b" % st, out)}
        self.assertTrue({"queued", "sending", "sent", "failed", "unconfirmed"} <= states, states)
        labels = re.search(r'\{\s*queued:\s*"queued",[^}]*\}', page).group(0)
        for st in states - {"cancelled"}:
            self.assertIn(st + ":", labels, "page has no label for outbox state " + st)


class TestReleaseScript(unittest.TestCase):
    def test_release_script(self):
        f = os.path.join(ROOT, "tools", "release.sh")
        self.assertTrue(os.access(f, os.X_OK))
        self.assertEqual(subprocess.run(["sh", "-n", f]).returncode, 0)

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


class TestZip(unittest.TestCase):
    def test_make_zip_contents(self):
        with tempfile.TemporaryDirectory() as t:
            dst = os.path.join(t, "some-other-clone-name")  # any folder name works (B10)
            for f in SHIPPED + ["make-zip.sh"]:
                os.makedirs(os.path.dirname(os.path.join(dst, f)), exist_ok=True)
                shutil.copy2(os.path.join(ROOT, f), os.path.join(dst, f))
            open(os.path.join(dst, "assets", ".DS_Store"), "w").write("junk")
            os.makedirs(os.path.join(dst, "scripts", "__pycache__"))
            open(os.path.join(dst, "scripts", "__pycache__", "x.pyc"), "w").write("junk")
            subprocess.run(["sh", os.path.join(dst, "make-zip.sh")], check=True, capture_output=True)
            names = sorted(
                n
                for n in zipfile.ZipFile(os.path.join(dst, "dist", "messenger-catchup.zip")).namelist()
                if not n.endswith("/")
            )
            self.assertEqual(
                names, sorted("messenger-catchup/" + f for f in SHIPPED), "ZIP holds exactly the shipped files, no junk"
            )


if __name__ == "__main__":
    unittest.main()
