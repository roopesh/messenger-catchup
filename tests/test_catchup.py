"""Tests for scripts/catchup.py (bootstrap + build). Run: python3 -m unittest discover -s tests
Known bugs from docs/BACKLOG.md are marked expectedFailure; when one starts passing, unittest reports
"unexpected success": remove the marker and close the backlog item."""

import contextlib, copy, importlib.util, io, json, os, random, re, shutil, sys, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "catchup", os.path.join(ROOT, "plugin", "skills", "refresh", "scripts", "catchup.py")
)
catchup = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(catchup)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synth  # noqa: E402


def tm(h, mi, day="Fri"):
    return "%s %d:%02d %s" % (day, (h % 12) or 12, mi, "PM" if h >= 12 else "AM")


def msg(i, f, b="", h=9, mi=None, d="2026-11-06", **kw):
    o = {"i": i, "t": tm(h, i if mi is None else mi), "d": d, "f": f, "b": b, "m": "mid.%d" % i}
    o.update(kw)
    return o


def w(p, o):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as fh:
        json.dump(o, fh)


def r(p):
    with open(p) as fh:
        return json.load(fh)


class Env:
    """A scratch WORK dir plus fake ArtifactData out_dirs, shaped like the real ones."""

    def __init__(self, d):
        self.d = d
        self.msgs = []
        self.n = 0
        self.work = os.path.join(d, "work")

    def _chunks(self, into, only_new_from=None):
        for k in range(0, len(self.msgs), 82):
            ch = self.msgs[k : k + 82]
            if only_new_from is None or ch[-1]["i"] >= only_new_from:
                w(os.path.join(into, "chunks", "c%04d.json" % k), {"start": k, "msgs": ch})

    def seed(self, msgs=(), threading=None, summary=None, meta=None):
        db = os.path.join(self.d, "db")
        self.msgs = list(msgs)
        self._chunks(db)
        os.makedirs(os.path.join(db, "chunks"), exist_ok=True)
        last = self.msgs[-1] if self.msgs else None
        w(
            os.path.join(db, "meta", "chat.json"),
            dict(
                {
                    "lastI": last["i"] if last else -1,
                    "anchorMids": [m["m"] for m in self.msgs[-3:]],
                    "tz": "America/Los_Angeles",
                },
                **(meta or {}),
            ),
        )
        w(
            os.path.join(db, "threading", "current.json"),
            threading or {"convs": [], "links": {}, "to": last["i"] if last else -1, "note": ""},
        )  # seeded history counts as built
        w(
            os.path.join(db, "summary", "current.json"),
            summary
            or {
                "version": 2,
                "convs": [],
                "open": [],
                "answered": [],
                "deals": [],
                "mentions": [],
                "toI": last["i"] if last else -1,
            },
        )
        return quiet(catchup.bootstrap, self.work, db)

    def listing(self, into):
        """Step 5's `list threading` and `list summary`: the database as it stands when every build's manifest was
        written (a restore puts WORK, and so this, back to before the build)."""
        lay = r(os.path.join(self.work, "base", "layout.json"))
        t, s = (r(os.path.join(self.work, "base", f + ".json")) for f in ("threading", "summary"))
        new = catchup.layout_docs(copy.deepcopy(t), copy.deepcopy(s), lay.get("activeFrom", 0))
        for c, single in (("threading", t), ("summary", s)):
            docs = (
                {p: x for p, x in new.items() if p.startswith(c + "/")}
                if lay["layout"][c] == 2
                else {c + "/current": single}
            )
            for p, x in docs.items():
                w(os.path.join(into, p + ".json"), x)

    def run(self, new, meta=None, topic=None):
        """Simulate an import: append `new`, write the touched chunks and the updated meta/chat into a RUN dir, plus
        step 5's listing of threading and summary."""
        self.n += 1
        run = os.path.join(self.d, "run%d" % self.n)
        first = new[0]["i"]
        self.msgs += new
        self._chunks(run, first)
        w(
            os.path.join(run, "meta", "chat.json"),
            meta
            or dict(
                {"lastI": self.msgs[-1]["i"], "anchorMids": [m["m"] for m in self.msgs[-3:]]},
                **({"topic": topic} if topic else {}),
            ),
        )
        self.listing(run)
        return run

    def build(self, run, spec):
        p = os.path.join(self.d, "spec%d.json" % self.n)
        w(p, spec)
        return quiet(catchup.build, self.work, run, p)

    def state(self):
        return r(os.path.join(self.work, "state.json"))


def quiet(fn, *a):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*a)
    return buf.getvalue()


# A first run that exercises every default-link rule.
SCENARIO = [
    msg(0, "Ana", "Anyone selling a 30L pack?"),
    msg(1, "Ben", "I have one, $120"),  # GUESS i -> 0
    msg(2, "Ben", "barely used"),  # GUESS c -> 1
    msg(3, "You", "I'll take it", r="Ben", q="I have one, $120", pi=1),  # Messenger link -> r
    msg(4, "Ana", "nice", r="Ben", q="barely used", pi=2, pq=1),  # quote-matched in browser -> rq
    msg(5, "Cy", "me too", r="Ana", q="Anyone selling a 30L pack?"),  # quote match on history -> rq
    msg(6, "Dee", "", p="999"),  # a photo, first in its conv
    msg(7, "Ben", "that one?", r="Dee", q="Photo"),  # photo reply, no link -> rg + CHECK
    msg(8, "Ana", "new topic", h=13, mi=30),  # >3 h after its conv's last message -> ROOT
    msg(9, "Ben", "hmm", h=13, mi=31),  # would GUESS, spec says null
    msg(10, "Cy", "x", h=13, mi=32),  # spec override
]
SPEC = {
    "newconvs": [
        {"id": "gear1106", "title": "30L pack", "tag": "For sale", "outcome": "Sold to You", "key": [0, 3]},
        {"id": "pics1106", "title": "Photos"},
    ],
    "join": {"gear1106": [0, 1, 2, 3, 4, 5, 8, 9, 10], "pics1106": [6, 7]},
    "links": {"9": None, "10": [5, "i"]},
    "bullets": {"gear1106": [["Ana asked for a 30L pack", [0]], ["Ben offered one for $120", [1, 2]]]},
    "deals": [{"kind": "sale", "tag": "For sale", "conv": "gear1106", "text": "30L pack $120", "refs": [1]}],
    "open": [{"conv": "gear1106", "ask": 8, "to": "anyone", "note": ""}],
    "answered": [{"conv": "gear1106", "ask": 0, "answer": "Ben has one for $120", "refs": [1]}],
    "mentions": [{"note": "Ben offered one", "refs": [[1]]}],
}


class TestBootstrap(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.e = Env(self.t.name)

    def tearDown(self):
        self.t.cleanup()

    def test_empty_seed(self):
        out = self.e.seed()
        self.assertIn("bootstrap ok: 0 messages built through #-1", out)
        self.assertEqual(self.e.state(), {"base": -1, "stops": [], "tz": "America/Los_Angeles", "chunks": []})
        self.assertEqual(r(os.path.join(self.e.work, "all.json")), [])

    def test_existing_history_and_stops(self):
        ms = [msg(i, "Ana", "m%d" % i, mi=i % 60) for i in range(100)]
        self.e.seed(ms)
        st = self.e.state()
        self.assertEqual(st["base"], 99)
        self.assertEqual(st["stops"], ["mid.99", "mid.98", "mid.97"])
        self.assertEqual(len(r(os.path.join(self.e.work, "all.json"))), 100)

    def test_tz_from_meta(self):
        self.e.seed(meta={"tz": "Europe/Berlin"})
        self.assertEqual(self.e.state()["tz"], "Europe/Berlin")

    def test_meta_with_versions_bootstraps_the_same(self):
        """F5: meta/chat.versions (written by Claude for the page's update notices) is ignored by bootstrap."""
        ms = [msg(i, "Ana", "m%d" % i, mi=i % 60) for i in range(5)]
        self.e.seed(ms)
        plain = (self.e.state(), r(os.path.join(self.e.work, "all.json")))
        versions = {
            "page": "2.7",
            "helper": "2.0",
            "refresh": "Nov 20, 9:04 AM",
            "browsers": {"Work Mac": {"helper": "2.0", "at": "2026-11-20T17:04:00Z"}, "Home": {"helper": "none"}},
        }
        self.e.seed(ms, meta={"lastRefresh": "Nov 20, 9:04 AM", "versions": versions})
        self.assertEqual((self.e.state(), r(os.path.join(self.e.work, "all.json"))), plain)

    def test_unknown_layout_is_refused(self):
        """A threading or summary layout this catchup.py doesn't know (a newer copy of the skill wrote it) stops
        bootstrap and a RUN read, instead of being read, and later rewritten, as the old single document."""
        ms = [msg(i, "Ana", "m%d" % i, mi=i % 60) for i in range(5)]
        with self.assertRaisesRegex(AssertionError, "threading/current has layout 3"):
            self.e.seed(ms, threading={"layout": 3, "blocks": ["t0"], "to": 4, "note": ""})
        with self.assertRaisesRegex(AssertionError, "summary/current has layout 3"):
            self.e.seed(ms, summary={"layout": 3, "blocks": [], "version": 2, "toI": 4})
        for c in ("threading", "summary"):
            run = tempfile.mkdtemp(dir=self.t.name)
            w(os.path.join(run, c, "current.json"), {"layout": 3, "blocks": []})
            with self.assertRaisesRegex(AssertionError, c + "/current has layout 3"):
                catchup._listing(run, c)

    def test_gap_in_stored_messages(self):
        with self.assertRaisesRegex(AssertionError, "gap in stored messages"):
            self.e.seed([msg(0, "Ana"), msg(2, "Ben")])

    def test_lastI_mismatch(self):
        with self.assertRaises(AssertionError):
            self.e.seed([msg(0, "Ana")], meta={"lastI": 5})


class TestBuild(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.e = Env(self.t.name)
        self.e.seed()

    def tearDown(self):
        self.t.cleanup()

    def first(self):
        run = self.e.run([dict(m) for m in SCENARIO])
        out = self.e.build(run, SPEC)
        return run, out

    def test_default_links(self):
        run, out = self.first()
        t = r(os.path.join(run, "out", "merged", "threading.json"))
        self.assertEqual(
            t["links"],
            {
                "1": [0, "i"],
                "2": [1, "c"],
                "3": [1, "r"],
                "4": [2, "rq"],
                "5": [0, "rq"],
                "7": [6, "rg"],
                "10": [5, "i"],
            },
        )

    def test_printed_review_lines(self):
        _, out = self.first()
        for line in (
            "GUESS 1 -> 0 i",
            "GUESS 2 -> 1 c",
            "matched by quote 5 -> 0",
            "CHECK photo-reply guess 7 -> 6",
            "ROOT 8",
        ):
            self.assertIn(line, out)
        self.assertNotIn("GUESS 9", out)
        self.assertNotIn("GUESS 10", out)
        self.assertIn("build ok: #0-#10", out)

    def test_threading_and_summary_outputs(self):
        run, _ = self.first()
        t = r(os.path.join(run, "out", "merged", "threading.json"))
        s = r(os.path.join(run, "out", "merged", "summary.json"))
        self.assertEqual(
            {c["id"]: c["members"] for c in t["convs"]}, {"gear1106": [0, 1, 2, 3, 4, 5, 8, 9, 10], "pics1106": [6, 7]}
        )
        self.assertEqual(t["to"], 10)
        self.assertTrue(t["builtAt"])
        self.assertEqual(s["toI"], 10)
        self.assertTrue(s["generatedAt"])
        self.assertEqual(s["version"], 2)
        self.assertEqual([c["id"] for c in s["convs"]], ["gear1106", "pics1106"])  # newest activity first
        g = s["convs"][0]
        self.assertEqual(g["outcome"], "Sold to You")
        self.assertEqual(len(g["synopsis"]), 2)
        self.assertEqual(s["open"][0]["ask"], 8)
        self.assertEqual(s["answered"][0]["ask"], 0)
        self.assertEqual(s["deals"][0]["refs"], [1])
        self.assertEqual(s["mentions"][0]["refs"], [[1]])

    def test_work_advances(self):
        self.first()
        st = self.e.state()
        self.assertEqual(st["base"], 10)
        self.assertEqual(st["stops"], ["mid.10", "mid.9", "mid.8"])
        self.assertEqual(len(r(os.path.join(self.e.work, "all.json"))), 11)
        self.assertEqual(r(os.path.join(self.e.work, "base", "threading.json"))["to"], 10)

    def test_incremental_build(self):
        self.first()
        new = [
            msg(
                11, "Dee", "still available?", h=13, mi=40, r="Ben", q="I have one, $120", pmid="mid.1"
            ),  # parent by Messenger id from history
            msg(12, "Ben", "yes", h=13, mi=41),
            msg(13, "Ana", "also selling a stove", h=13, mi=42),
        ]
        run = self.e.run(new)
        out = self.e.build(
            run,
            {
                "newconvs": [{"id": "stove1106", "title": "Stove"}],
                "join": {"gear1106": [11, 12], "stove1106": [13]},
                "closeOpen": [8],
                "answered": [{"conv": "gear1106", "ask": 11, "answer": "yes", "refs": [12]}],
                "outcome": {"gear1106": "Still available"},
                "dealEdit": {"gear1106": {"text": "30L pack $120, still available", "addRefs": [12]}},
                "bullets": {"stove1106": [["Ana is selling a stove", [13]]]},
            },
        )
        t = r(os.path.join(run, "out", "merged", "threading.json"))
        s = r(os.path.join(run, "out", "merged", "summary.json"))
        self.assertEqual(t["links"]["11"], [1, "r"])
        self.assertEqual(t["links"]["12"], [11, "i"])
        self.assertNotIn("13", t["links"])  # first message of a new conv
        self.assertEqual(s["open"], [])
        self.assertEqual([a["ask"] for a in s["answered"]], [11, 0])
        self.assertEqual(s["deals"][0]["text"], "30L pack $120, still available")
        self.assertEqual(s["deals"][0]["refs"], [1, 12])
        self.assertEqual(s["convs"][0]["id"], "stove1106")
        self.assertEqual(self.e.state()["base"], 13)
        self.assertIn("build ok: #11-#13", out)

    def test_quote_match_latest_wins_and_window(self):
        ms = [msg(0, "Ana", "same words here again"), msg(1, "Ana", "same words here again"), msg(2, "Ben", "ok")]
        self.assertEqual(
            catchup.resolve(dict(msg(3, "Ben", "x"), r="Ana", q="same words here again"), ms), (1, "rq", None)
        )
        far = [msg(0, "Ana", "far away words")]
        self.assertEqual(
            catchup.resolve(dict(msg(301, "Ben", "x"), r="Ana", q="far away words"), far), (None, None, None)
        )
        self.assertEqual(catchup.resolve(dict(msg(300, "Ben", "x"), r="Ana", q="far away words"), far), (0, "rq", None))

    def test_quote_match_you_and_themself(self):
        ms = [msg(0, "You", "my own words here"), msg(1, "Ben", "ben says something")]
        self.assertEqual(catchup.resolve(dict(msg(2, "Ana", "x"), r="you", q="my own words here"), ms), (0, "rq", None))
        self.assertEqual(
            catchup.resolve(dict(msg(2, "Ben", "x"), r="themself", q="ben says something"), ms), (1, "rq", None)
        )

    def test_normalize(self):
        self.assertEqual(catchup._n("🔥🔥 Great   DEAL…"), "great deal")
        self.assertEqual(catchup._n('  "Quoted"  '), '"quoted"')

    def test_minutes(self):
        self.assertEqual(catchup._min(msg(0, "A", h=12, mi=0)) - catchup._min(msg(0, "A", h=0, mi=0)), 12 * 60)
        old = msg(0, "A", d="2025-10-12")
        old["t"] = "October 12, 2025 at 9:00 AM"  # any label form: time by regex
        self.assertEqual(catchup._min(old) % 1440, 9 * 60)


class TestRestore(unittest.TestCase):
    """B2: a build keeps the WORK it started from in WORK/prev; `restore` undoes it so the same RUN can be built again."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.e = Env(self.t.name)
        self.e.seed()
        self.run = self.e.run([msg(0, "Ana", "a"), msg(1, "Ben", "b")])
        self.spec = {"newconvs": [{"id": "a", "title": "A"}], "join": {"a": [0, 1]}}

    def tearDown(self):
        self.t.cleanup()

    def W(self, f):
        return r(os.path.join(self.e.work, f))

    def test_rebuild_without_restore_says_what_to_do(self):
        self.e.build(self.run, self.spec)
        with self.assertRaisesRegex(
            AssertionError,
            r"RUN already built into WORK \(WORK is at #1, RUN ends at #1\)\. To build it again, run: catchup.py restore WORK",
        ):
            self.e.build(self.run, self.spec)

    def test_restore_then_rebuild_with_a_new_spec(self):
        self.e.build(self.run, self.spec)
        self.assertEqual(self.e.state()["base"], 1)
        out = quiet(catchup.restore, self.e.work)
        self.assertIn("restore ok: WORK back at #-1", out)
        self.assertEqual(self.e.state()["base"], -1)
        self.assertEqual(self.W("all.json"), [])
        self.assertEqual(self.W("base/threading.json")["convs"], [])
        self.assertFalse(os.path.exists(os.path.join(self.e.work, "prev")))
        self.e.build(self.run, {"newconvs": [{"id": "b", "title": "B"}], "join": {"b": [0, 1]}})
        self.assertEqual(
            [c["id"] for c in r(os.path.join(self.run, "out", "merged", "threading.json"))["convs"]], ["b"]
        )
        self.assertEqual(self.e.state()["base"], 1)

    def test_restore_only_undoes_the_last_build(self):
        self.e.build(self.run, self.spec)
        run2 = self.e.run([msg(2, "Cy", "c")])
        self.e.build(run2, {"join": {"a": [2]}})
        quiet(catchup.restore, self.e.work)
        self.assertEqual(self.e.state()["base"], 1)
        self.assertEqual(len(self.W("all.json")), 2)
        with self.assertRaisesRegex(AssertionError, "nothing to restore"):
            catchup.restore(self.e.work)

    def test_nothing_to_restore_after_bootstrap(self):
        with self.assertRaisesRegex(AssertionError, "nothing to restore"):
            catchup.restore(self.e.work)

    def test_bootstrap_clears_a_stale_prev(self):
        self.e.build(self.run, self.spec)
        self.assertTrue(os.path.exists(os.path.join(self.e.work, "prev")))
        self.e.seed()
        self.assertFalse(os.path.exists(os.path.join(self.e.work, "prev")))

    def test_rejected_build_leaves_prev_alone(self):
        self.e.build(self.run, self.spec)
        before = self.W("prev/state.json")
        run2 = self.e.run([msg(2, "Cy", "c")])
        with self.assertRaises(AssertionError):
            self.e.build(run2, {"join": {"nope": [2]}})
        self.assertEqual(self.W("prev/state.json"), before)

    def test_cli_restore(self):
        import subprocess

        self.e.build(self.run, self.spec)
        p = subprocess.run(
            [
                sys.executable,
                os.path.join(ROOT, "plugin", "skills", "refresh", "scripts", "catchup.py"),
                "restore",
                self.e.work,
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("restore ok", p.stdout)


class TestBuildRejects(unittest.TestCase):
    """Every assert fires before anything is written, so WORK never advances on a rejected build."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.e = Env(self.t.name)
        self.e.seed()
        self.new = [msg(0, "Ana", "question here"), msg(1, "Ben", "answer here"), msg(2, "Cy", "more")]
        self.conv = {"newconvs": [{"id": "a", "title": "A"}]}

    def tearDown(self):
        self.t.cleanup()

    def reject(self, spec, pattern="", new=None, meta=None):
        before = self.e.state()
        run = self.e.run(new or self.new, meta)
        with self.assertRaisesRegex(AssertionError, pattern):
            self.e.build(run, spec)
        self.assertEqual(self.e.state(), before, "WORK advanced on a rejected build")
        self.assertFalse(os.path.exists(os.path.join(run, "out")), "RUN/out written on a rejected build")

    def spec(self, **kw):
        return dict(self.conv, join={"a": [0, 1, 2]}, **kw)

    def test_bullet_over_15_words(self):
        self.reject(self.spec(bullets={"a": [[" ".join(["w"] * 16), [0]]]}), "bullet over 15 words")

    def test_bullet_15_words_ok(self):
        run = self.e.run(self.new)
        self.e.build(run, self.spec(bullets={"a": [[" ".join(["w"] * 15), [0]]]}))

    def test_outcome_over_12_words(self):
        self.reject(self.spec(outcome={"a": " ".join(["w"] * 13)}), "outcome over 12 words")

    def test_joined_twice(self):
        self.reject(
            dict(
                self.conv,
                newconvs=[{"id": "a", "title": "A"}, {"id": "b", "title": "B"}],
                join={"a": [0, 1, 2], "b": [2]},
            ),
            "joined twice",
        )

    def test_unassigned_message(self):
        self.reject(dict(self.conv, join={"a": [0, 1]}), "unassigned or extra")

    def test_extra_message(self):
        self.reject(dict(self.conv, join={"a": [0, 1, 2, 3]}), "unassigned or extra")

    def test_unknown_conv(self):
        self.reject({"join": {"nope": [0, 1, 2]}}, "unknown conv")

    def test_conv_id_exists(self):
        run = self.e.run(self.new)
        self.e.build(run, self.spec())
        self.new = [msg(3, "Ana", "x")]
        self.reject({"newconvs": [{"id": "a", "title": "again"}], "join": {"a": [3]}}, "conv id exists")

    def test_link_must_point_back(self):
        self.reject(self.spec(links={"1": [2, "i"]}), "link must point back")

    def test_key_not_in_conv(self):
        self.reject(dict(newconvs=[{"id": "a", "title": "A", "key": [5]}], join={"a": [0, 1, 2]}), "key not in conv")

    def test_bullet_ref_not_in_conv(self):
        self.reject(
            dict(
                newconvs=[{"id": "a", "title": "A"}, {"id": "b", "title": "B"}],
                join={"a": [0, 1], "b": [2]},
                bullets={"a": [["x", [2]]]},
            ),
            "bullet ref not in conv",
        )

    def test_bullet_without_refs(self):
        self.reject(self.spec(bullets={"a": [["x", []]]}), "bullet ref not in conv")

    def test_open_ask_not_in_conv(self):
        self.reject(
            dict(
                newconvs=[{"id": "a", "title": "A"}, {"id": "b", "title": "B"}],
                join={"a": [0, 1], "b": [2]},
                open=[{"conv": "a", "ask": 2, "to": "anyone"}],
            ),
            "ref not in conv",
        )

    def test_deal_conv_missing(self):
        self.reject(self.spec(deals=[{"conv": "zzz", "text": "x", "refs": [0]}]), "deal conv missing")

    def test_meta_not_updated_by_import(self):
        self.reject(self.spec(), "meta/chat not updated", meta={"lastI": -1, "anchorMids": ["x"]})

    def test_new_messages_not_consecutive(self):
        self.reject(dict(self.conv, join={"a": [0, 2]}), "", new=[msg(0, "Ana"), msg(2, "Ben")])

    def test_stored_copy_differs(self):
        run = self.e.run(self.new)
        self.e.build(run, self.spec())
        self.e.msgs[1] = dict(self.e.msgs[1], b="edited after the fact")  # the RUN chunk disagrees with WORK
        self.new = [msg(3, "Ana", "x")]
        self.reject({"join": {"a": [3]}}, "stored copy differs")


class TestBugFixes(unittest.TestCase):
    """Regression tests for fixed docs/BACKLOG.md bugs (B1, B3, B4, B5, B11 fixed in v1.2.1)."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.e = Env(self.t.name)
        self.e.seed()

    def tearDown(self):
        self.t.cleanup()

    def test_B1_note_filled_for_new_pages(self):
        run = self.e.run([msg(0, "Ana", "a"), msg(1, "Ben", "b", r="Ana", q="a", pi=0)])
        self.e.build(run, {"newconvs": [{"id": "a", "title": "A"}], "join": {"a": [0, 1]}})
        self.assertIn("reply links", r(os.path.join(run, "out", "merged", "threading.json"))["note"])

    def test_B3_dealEdit_without_deal_is_a_clear_error(self):
        run = self.e.run([msg(0, "Ana", "a")])
        with self.assertRaises(AssertionError):
            self.e.build(
                run, {"newconvs": [{"id": "a", "title": "A"}], "join": {"a": [0]}, "dealEdit": {"a": {"text": "x"}}}
            )

    def test_B4_cross_conversation_link_flagged(self):
        run = self.e.run([msg(0, "Ana", "a"), msg(1, "Ben", "b")])
        out = self.e.build(
            run,
            {
                "newconvs": [{"id": "a", "title": "A"}, {"id": "b", "title": "B"}],
                "join": {"a": [0], "b": [1]},
                "links": {"1": [0, "i"]},
            },
        )
        self.assertIn("WARN", out)

    def test_B5_unfound_reply_left_unlinked(self):
        run = self.e.run([msg(0, "Ana", "a"), msg(1, "Ben", "b", r="Zed", q="something from before the window")])
        self.e.build(run, {"newconvs": [{"id": "a", "title": "A"}], "join": {"a": [0, 1]}})
        self.assertNotIn("1", r(os.path.join(run, "out", "merged", "threading.json"))["links"])

    def test_B11_messenger_link_to_message_zero(self):
        # pi=0 is falsy, so a Messenger reply link to #0 is ignored and the quote/photo fallback runs instead.
        run = self.e.run(
            [
                msg(0, "Ana", "", p="5"),
                msg(1, "Ana", "other photo", p="6"),
                msg(2, "Ben", "love it", r="Ana", q="Photo", pi=0),
            ]
        )
        self.e.build(run, {"newconvs": [{"id": "a", "title": "A"}], "join": {"a": [0, 1, 2]}})
        self.assertEqual(r(os.path.join(run, "out", "merged", "threading.json"))["links"]["2"], [0, "r"])

    def test_B1_note_keeps_an_old_custom_note(self):
        e = Env(tempfile.mkdtemp(dir=self.t.name))
        e.seed(threading={"convs": [], "links": {}, "to": -1, "note": "Imported from the old page"})
        run = e.run([msg(0, "Ana", "a")])
        e.build(run, {"newconvs": [{"id": "a", "title": "A"}], "join": {"a": [0]}})
        self.assertEqual(
            r(os.path.join(run, "out", "merged", "threading.json"))["note"],
            "0 reply links read straight from Messenger; 0 matched by their quoted text and 0 (replies to photos) by best match. Imported from the old page",
        )

    def test_B1_note_counts_update_on_the_next_build(self):
        run = self.e.run([msg(0, "Ana", "a"), msg(1, "Ben", "b", r="Ana", q="a", pi=0)])
        self.e.build(run, {"newconvs": [{"id": "a", "title": "A"}], "join": {"a": [0, 1]}})
        run = self.e.run([msg(2, "Cy", "c", r="Ben", q="b", pi=1)])
        self.e.build(run, {"join": {"a": [2]}})
        self.assertTrue(
            r(os.path.join(run, "out", "merged", "threading.json"))["note"].startswith(
                "2 reply links read straight from Messenger"
            )
        )

    def test_B3_dealEdit_needs_index_when_ambiguous(self):
        run = self.e.run([msg(0, "Ana", "a"), msg(1, "Ben", "b")])
        deals = [
            {"kind": "sale", "tag": "x", "conv": "a", "text": "one", "refs": [0]},
            {"kind": "sale", "tag": "y", "conv": "a", "text": "two", "refs": [1]},
        ]
        self.e.build(run, {"newconvs": [{"id": "a", "title": "A"}], "join": {"a": [0, 1]}, "deals": deals})
        run = self.e.run([msg(2, "Cy", "c")])
        with self.assertRaisesRegex(AssertionError, '2 deals in a; add "index"'):
            self.e.build(run, {"join": {"a": [2]}, "dealEdit": {"a": {"text": "z"}}})
        self.e.build(run, {"join": {"a": [2]}, "dealEdit": {"a": {"text": "two, sold", "index": 1, "addRefs": [2]}}})
        d = r(os.path.join(run, "out", "merged", "summary.json"))["deals"]
        self.assertEqual([x["text"] for x in d], ["one", "two, sold"])
        self.assertEqual(d[1]["refs"], [1, 2])

    def test_B4_unknown_link_type_refused(self):
        run = self.e.run([msg(0, "Ana", "a"), msg(1, "Ben", "b")])
        with self.assertRaisesRegex(AssertionError, "link type must be one of"):
            self.e.build(
                run, {"newconvs": [{"id": "a", "title": "A"}], "join": {"a": [0, 1]}, "links": {"1": [0, "x"]}}
            )

    def test_B4_same_conversation_link_has_no_warning(self):
        run = self.e.run([msg(0, "Ana", "a"), msg(1, "Ben", "b")])
        self.assertNotIn(
            "crosses",
            self.e.build(
                run, {"newconvs": [{"id": "a", "title": "A"}], "join": {"a": [0, 1]}, "links": {"1": [0, "i"]}}
            ),
        )

    def test_B5_no_guess_line_for_unfound_reply(self):
        run = self.e.run([msg(0, "Ana", "a"), msg(1, "Ben", "b", r="Zed", q="something from before the window")])
        out = self.e.build(run, {"newconvs": [{"id": "a", "title": "A"}], "join": {"a": [0, 1]}})
        self.assertIn("WARN reply parent not found 1 - left unlinked", out)
        self.assertNotIn("GUESS 1", out)

    def test_noreplyline_is_a_check_not_a_guess(self):
        """Helper 2.0: a Messenger reply whose "X replied to Y" line couldn't be read (perr noreplyline, no r) is a CHECK
        and stays unlinked, never a GUESS of the previous message."""
        run = self.e.run([msg(0, "Ana", "Selling my tent"), msg(1, "Ben", "how much?", perr="noreplyline")])
        out = self.e.build(run, {"newconvs": [{"id": "a", "title": "A"}], "join": {"a": [0, 1]}})
        self.assertIn("CHECK reply with no readable reply line 1", out)
        self.assertNotIn("GUESS 1", out)
        t = r(os.path.join(self.e.work, "base", "threading.json"))
        self.assertNotIn("1", t["links"])

    def test_C5_timestamp_format(self):
        self.assertRegex(catchup._ts(), r"^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d\d [AP]M$")


class TestReviewFixes(unittest.TestCase):
    """B13, B18, B21 (v1.5.0), from the independent review of v1.4.1."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.e = Env(self.t.name)
        self.e.seed()

    def tearDown(self):
        self.t.cleanup()

    # B13: short quotes
    def test_B13_short_quote_never_matches_inside_another_word(self):
        ms = [msg(0, "Ana", "it looks great")]
        self.assertEqual(catchup.resolve(dict(msg(1, "Ben", "x"), r="Ana", q="ok"), ms), (None, None, None))

    def test_B13_short_quote_needs_the_same_text_and_is_flagged(self):
        ms = [msg(0, "Ana", "ok"), msg(1, "Ana", "Yes please, the blue one")]
        self.assertEqual(
            catchup.resolve(dict(msg(2, "Ben", "x"), r="Ana", q="ok"), ms), (0, "rq", "short quote, same text")
        )
        self.assertEqual(catchup.resolve(dict(msg(2, "Ben", "x"), r="Ana", q="Yes"), ms), (None, None, None))

    def test_B13_long_quote_found_inside_is_flagged(self):
        ms = [msg(0, "Ana", "@Ben meet at the trailhead at nine")]
        pr = catchup.resolve(dict(msg(1, "Ben", "x"), r="Ana", q="meet at the trailhead at nine"), ms)
        self.assertEqual(pr[:2], (0, "rq"))
        self.assertTrue(pr[2])

    def test_B13_build_prints_CHECK_for_doubtful_matches(self):
        run = self.e.run([msg(0, "Ana", "ok"), msg(1, "Ben", "great", r="Ana", q="ok")])
        out = self.e.build(run, {"newconvs": [{"id": "a", "title": "A"}], "join": {"a": [0, 1]}})
        self.assertIn("CHECK quote match (short quote, same text) 1 -> 0", out)

    # B18: validations
    def first(self):
        run = self.e.run([msg(0, "Ana", "selling a stove"), msg(1, "Ben", "how much?"), msg(2, "You", "me too")])
        self.e.build(
            run,
            {
                "newconvs": [{"id": "a", "title": "A"}, {"id": "b", "title": "B"}],
                "join": {"a": [0, 1], "b": [2]},
                "open": [{"conv": "a", "ask": 1, "to": "Ana"}],
            },
        )

    def rej(self, spec, pat):
        run = self.e.run([msg(3, "Cy", "c")])
        with self.assertRaisesRegex(AssertionError, pat):
            self.e.build(run, dict({"join": {"a": [3]}}, **spec))

    def test_B18_deal_needs_refs_in_its_conversation(self):
        self.first()
        self.rej({"deals": [{"kind": "sale", "tag": "x", "conv": "a", "text": "t", "refs": []}]}, "deal refs must be")

    def test_B18_deal_ref_outside_conversation(self):
        self.first()
        self.rej({"deals": [{"kind": "sale", "tag": "x", "conv": "a", "text": "t", "refs": [2]}]}, "deal refs must be")

    def test_B18_mention_of_your_own_message(self):
        self.first()
        self.rej({"mentions": [{"note": "n", "refs": [[2]]}]}, "mention ref must be")

    def test_B18_mention_of_a_missing_message(self):
        self.first()
        self.rej({"mentions": [{"note": "n", "refs": [[99]]}]}, "mention ref must be")

    def test_B18_closeOpen_must_match(self):
        self.first()
        self.rej({"closeOpen": [0]}, "no open question asks at #0")

    def test_B18_open_question_listed_twice(self):
        self.first()
        self.rej({"open": [{"conv": "a", "ask": 1, "to": "Ana"}]}, "already open")

    def test_B18_dealEdit_addRefs_in_conversation(self):
        run = self.e.run([msg(0, "Ana", "a"), msg(1, "Ben", "b")])
        self.e.build(
            run,
            {
                "newconvs": [{"id": "a", "title": "A"}, {"id": "b", "title": "B"}],
                "join": {"a": [0], "b": [1]},
                "deals": [{"kind": "sale", "tag": "x", "conv": "a", "text": "t", "refs": [0]}],
            },
        )
        run = self.e.run([msg(2, "Cy", "c")])
        with self.assertRaisesRegex(AssertionError, "addRefs must be in"):
            self.e.build(run, {"join": {"b": [2]}, "dealEdit": {"a": {"addRefs": [1]}}})

    def test_B18_valid_close_and_reopen_in_one_build(self):
        self.first()
        run = self.e.run([msg(3, "Ana", "80 dollars")])
        self.e.build(
            run,
            {"join": {"a": [3]}, "closeOpen": [1], "answered": [{"conv": "a", "ask": 1, "answer": "$80", "refs": [3]}]},
        )
        self.assertEqual(r(os.path.join(run, "out", "merged", "summary.json"))["open"], [])

    # B21: stored but never built
    def seed_partly_built(self):
        e = Env(tempfile.mkdtemp(dir=self.t.name))
        ms = [msg(i, "Ana" if i % 2 else "Ben", "m%d" % i, mi=i % 60) for i in range(90)]
        th = {"convs": [{"id": "a", "title": "A", "members": list(range(80))}], "links": {}, "to": 79, "note": ""}
        sm = {
            "version": 2,
            "convs": [{"id": "a", "tag": "", "synopsis": [], "outcome": "", "key": []}],
            "open": [],
            "answered": [],
            "deals": [],
            "mentions": [],
            "toI": 79,
        }
        out = e.seed(ms, threading=th, summary=sm)
        return e, out

    def test_B21_bootstrap_bases_on_what_was_built(self):
        e, out = self.seed_partly_built()
        self.assertEqual(e.state()["base"], 79)
        self.assertIn("#80-#89 are stored but not built yet", out)
        self.assertEqual(len(r(os.path.join(e.work, "all.json"))), 80)

    def test_B21_run_missing_the_unbuilt_messages_names_the_chunks(self):
        e, _ = self.seed_partly_built()
        e.msgs = e.msgs[:90]
        run = os.path.join(e.d, "runX")
        new = [msg(i, "Cy", "n%d" % i, mi=i % 60) for i in range(90, 96)]
        e.msgs += new
        e._chunks(run, 90)  # only c0082 (82-95) fetched
        w(
            os.path.join(run, "meta", "chat.json"),
            {"lastI": 95, "anchorMids": ["mid.93", "mid.94", "mid.95"], "chunkSize": 82},
        )
        p = os.path.join(e.d, "s.json")
        w(p, {"join": {"a": list(range(80, 96))}})
        # c0082 covers 82-95, so 80-81 (in c0000) are missing
        with self.assertRaisesRegex(
            AssertionError, r"RUN is missing #80-#81 \(stored, not built yet\): fetch chunks/c0000 into RUN too"
        ):
            quiet(catchup.build, e.work, run, p)

    def test_B21_full_run_threads_the_unbuilt_messages(self):
        e, _ = self.seed_partly_built()
        e.msgs = e.msgs[:90]
        run = os.path.join(e.d, "runY")
        new = [msg(i, "Cy", "n%d" % i, mi=i % 60) for i in range(90, 96)]
        e.msgs += new
        e._chunks(run, 80)
        e.listing(run)
        w(os.path.join(run, "meta", "chat.json"), {"lastI": 95, "anchorMids": ["mid.93", "mid.94", "mid.95"]})
        p = os.path.join(e.d, "s.json")
        w(p, {"join": {"a": list(range(80, 96))}})
        out = quiet(catchup.build, e.work, run, p)
        self.assertIn("build ok: #80-#95", out)
        self.assertEqual(
            r(os.path.join(run, "out", "merged", "threading.json"))["convs"][0]["members"], list(range(96))
        )


class TestReview2Fixes(unittest.TestCase):
    """B22, B23, B29 (v1.5.1), from the second independent review."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.t.cleanup()

    def test_B22_bootstrap_with_chunks_ahead_of_meta(self):
        e = Env(self.t.name)
        ms = [msg(i, "Ana", "m%d" % i) for i in range(7)]
        th = {"convs": [{"id": "a", "title": "A", "members": [0, 1, 2, 3]}], "links": {}, "to": 3, "note": ""}
        sm = {
            "version": 2,
            "convs": [{"id": "a", "tag": "", "synopsis": [], "outcome": "", "key": []}],
            "open": [],
            "answered": [],
            "deals": [],
            "mentions": [],
            "toI": 3,
        }
        out = e.seed(
            ms, threading=th, summary=sm, meta={"lastI": 3, "anchorMids": ["mid.1", "mid.2", "mid.3"]}
        )  # chunks hold #0-#6, meta says #3
        self.assertEqual(e.state()["base"], 3)
        self.assertIn("#4-#6 are saved but not counted in meta/chat yet", out)
        self.assertEqual(len(r(os.path.join(e.work, "all.json"))), 4)
        run = os.path.join(e.d, "runR")
        e.msgs = ms
        e._chunks(run, 4)  # after the REPAIRED paste: chunk + repaired meta/chat
        e.listing(run)
        w(os.path.join(run, "meta", "chat.json"), {"lastI": 6, "anchorMids": ["mid.4", "mid.5", "mid.6"]})
        p = os.path.join(e.d, "s.json")
        w(p, {"join": {"a": [4, 5, 6]}})
        out = quiet(catchup.build, e.work, run, p)
        self.assertIn("build ok: #4-#6", out)

    def test_B22_meta_ahead_of_chunks_is_still_refused(self):
        e = Env(self.t.name)
        with self.assertRaisesRegex(AssertionError, "is ahead of the newest saved message"):
            e.seed([msg(0, "Ana")], meta={"lastI": 5})

    def test_B23_nothing_left_after_a_fresh_bootstrap(self):
        e = Env(self.t.name)
        e.seed()
        run = e.run([msg(0, "Ana", "a"), msg(1, "Ben", "b")])
        e.build(run, {"newconvs": [{"id": "a", "title": "A"}], "join": {"a": [0, 1]}})
        e2 = Env(tempfile.mkdtemp(dir=self.t.name))
        th = r(os.path.join(run, "out", "merged", "threading.json"))
        sm = r(os.path.join(run, "out", "merged", "summary.json"))
        e2.seed(e.msgs, threading=th, summary=sm)  # the other session already built #0-#1
        p = os.path.join(e2.d, "s.json")
        w(p, {"join": {"a": [0, 1]}})
        with self.assertRaisesRegex(AssertionError, "nothing left to build: WORK already covers RUN"):
            quiet(catchup.build, e2.work, run, p)

    def test_B29_reply_to_yourself(self):
        ms = [msg(0, "You", "my own long message here"), msg(1, "Ana", "other")]
        self.assertEqual(
            catchup.resolve(dict(msg(2, "You", "x"), r="yourself", q="my own long message here"), ms), (0, "rq", None)
        )


class TestReview3Fixes(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.t.cleanup()

    def test_B34_run_with_no_chunks_names_what_to_fetch(self):
        e = Env(self.t.name)
        ms = [msg(i, "Ana", "m%d" % i) for i in range(8)]
        th = {"convs": [{"id": "a", "title": "A", "members": list(range(6))}], "links": {}, "to": 5, "note": ""}
        sm = {
            "version": 2,
            "convs": [{"id": "a", "tag": "", "synopsis": [], "outcome": "", "key": []}],
            "open": [],
            "answered": [],
            "deals": [],
            "mentions": [],
            "toI": 5,
        }
        out = e.seed(ms, threading=th, summary=sm)
        self.assertIn("the next RUN must include chunks/c0000", out)
        run = os.path.join(e.d, "runN")
        w(os.path.join(run, "meta", "chat.json"), {"lastI": 7, "anchorMids": ["mid.5", "mid.6", "mid.7"]})
        os.makedirs(os.path.join(run, "chunks"))
        p = os.path.join(e.d, "s.json")
        w(p, {"join": {"a": [6, 7]}})
        with self.assertRaisesRegex(
            AssertionError, r"RUN is missing #6-#7 \(stored, not built yet\): fetch chunks/c0000 into RUN too"
        ):
            quiet(catchup.build, e.work, run, p)

    def test_B34_nothing_to_build_with_empty_run(self):
        e = Env(self.t.name)
        e.seed([msg(0, "Ana", "a")])
        run = os.path.join(e.d, "runE")
        w(os.path.join(run, "meta", "chat.json"), {"lastI": 0, "anchorMids": ["mid.0"]})
        os.makedirs(os.path.join(run, "chunks"))
        p = os.path.join(e.d, "s.json")
        w(p, {"join": {}})
        with self.assertRaisesRegex(AssertionError, "nothing to build"):
            quiet(catchup.build, e.work, run, p)


class TestRelink(unittest.TestCase):
    """F3: correct the link on a message an earlier build already threaded, in a build spec or on its own."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.e = Env(self.t.name)
        self.e.seed()
        self.e.build(self.e.run(SCENARIO), SPEC)  # built #0-#10: 1 -> 0 i, 2 -> 1 c, 9 unlinked, 10 -> 5 i

    def tearDown(self):
        self.t.cleanup()

    def relink(self, spec):
        """A relink as SKILL.md has it: `list threading` into a fresh RUN, then relink; -> (printout, RUN/out)."""
        p = os.path.join(self.t.name, "relink.json")
        w(p, spec)
        run = os.path.join(self.t.name, "rrun")
        shutil.rmtree(run, ignore_errors=True)
        self.e.listing(run)
        return quiet(catchup.relink, self.e.work, run, p), os.path.join(run, "out")

    def test_relink_in_a_build_spec(self):
        run = self.e.run([msg(11, "Dee", "later", h=13, mi=40)])
        out = self.e.build(run, {"join": {"gear1106": [11]}, "relink": {"2": [0, "i"], "9": [8, "i"]}})
        self.assertIn("RELINK 2 -> 0 i", out)
        self.assertIn("RELINK 9 -> 8 i", out)
        links = r(os.path.join(run, "out", "merged", "threading.json"))["links"]
        self.assertEqual((links["2"], links["9"], links["11"][0]), ([0, "i"], [8, "i"], 10))

    def test_relink_on_its_own(self):
        out, d = self.relink({"relink": {"10": None, "2": [0, "i"]}})
        self.assertIn("UNLINK 10", out)
        self.assertIn("relink ok: 2 change(s)", out)
        t = r(os.path.join(d, "merged", "threading.json"))
        self.assertNotIn("10", t["links"])
        self.assertEqual(t["links"]["2"], [0, "i"])
        self.assertEqual(r(os.path.join(self.e.work, "base", "threading.json")), t, "WORK's base follows")
        self.assertTrue(t["builtAt"])
        self.assertRegex(t["note"], r"^\d+ reply links read straight from Messenger")
        quiet(catchup.restore, self.e.work)  # a refused write: undo
        self.assertEqual(r(os.path.join(self.e.work, "base", "threading.json"))["links"]["10"], [5, "i"])

    def test_relink_rejects(self):
        for spec, msg_re in (
            ({"relink": {"11": [0, "i"]}}, r"only messages already built \(through #10\)"),
            ({"relink": {"5": [7, "i"]}}, "earlier stored message"),
            ({"relink": {"5": [0, "x"]}}, "link type must be one of"),
            ({"relink": {"5": [0, "i"]}, "join": {}}, 'takes only a non-empty "relink"'),
        ):
            before = r(os.path.join(self.e.work, "base", "threading.json"))
            with self.assertRaisesRegex(AssertionError, msg_re):
                self.relink(spec)
            self.assertEqual(r(os.path.join(self.e.work, "base", "threading.json")), before, "WORK untouched")

    def test_relink_across_conversations_warns(self):
        out, _ = self.relink({"relink": {"7": [5, "i"]}})  # 7 is in pics1106, 5 in gear1106
        self.assertIn("WARN link 7 -> 5 crosses conversations (pics1106 -> gear1106)", out)


class Refused(Exception):
    """The database or the batch tool refused a write; nothing was written."""


class FakeDB:
    """ArtifactData with the real limits (artifact runtime contract 0.2.92 and the ArtifactData tool): a document holds at
    most 262,144 bytes of compact JSON; a batch takes 1-50 writes, each document at most once, at most 1 MiB in all; a
    write to an existing document needs the version last read (if_version); a refused batch writes nothing."""

    DOC, WRITES, BODY = 262144, 50, 1 << 20

    def __init__(self):
        self.docs, self.ver = {}, {}

    @staticmethod
    def size(d):
        return len(json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    def put(self, p, d):
        """A write by the page or by setup (the page's runtime has no pins); the size limit still applies."""
        if self.size(d) > self.DOC:
            raise Refused("%s is %d bytes, over 262,144" % (p, self.size(d)))
        self.docs[p] = copy.deepcopy(d)
        self.ver[p] = self.ver.get(p, 0) + 1

    def batch(self, writes):
        if not 1 <= len(writes) <= self.WRITES:
            raise Refused("a batch takes 1-50 writes, not %d" % len(writes))
        paths = [x["collection"] + "/" + x["doc_id"] for x in writes]
        if len(set(paths)) != len(paths):
            raise Refused("a document twice in one batch")
        body = self.size(writes)
        if body > self.BODY:
            raise Refused("batch body is %d bytes, over 1 MiB" % body)
        new = {}
        for x, p in zip(writes, paths):
            if p in self.docs and "if_version" not in x:
                raise Refused("%s exists: the write needs if_version" % p)
            if "if_version" in x and self.ver.get(p) != x["if_version"] or "if_version" in x and p not in self.docs:
                raise Refused("%s changed (version %s, pinned %s)" % (p, self.ver.get(p), x["if_version"]))
            if x["op"] == "delete":
                new[p] = None
                continue
            d = x["data"] if x["op"] == "set" else dict(self.docs[p], **x["data"])
            if self.size(d) > self.DOC:
                raise Refused("%s would be %d bytes, over 262,144" % (p, self.size(d)))
            new[p] = d
        for p, d in new.items():
            if d is None:
                del self.docs[p]
            else:
                self.docs[p] = copy.deepcopy(d)
            self.ver[p] = self.ver.get(p, 0) + 1

    def coll(self, c):
        return {p.split("/")[1]: d for p, d in self.docs.items() if p.split("/")[0] == c and p.count("/") == 1}

    def fetch(self, into, chunks=None):
        """ArtifactData reads into an out_dir (list threading, list summary, chunks, meta/chat); -> the versions seen."""
        for p, d in self.docs.items():
            c = p.split("/")[0]
            if c in ("threading", "summary", "meta") or c == "chunks" and (chunks is None or p in chunks):
                w(os.path.join(into, p + ".json"), d)
        os.makedirs(os.path.join(into, "chunks"), exist_ok=True)
        return dict(self.ver)

    def merged(self):
        return catchup.merge_threading(self.coll("threading")), catchup.merge_summary(self.coll("summary"))

    def layout_sizes(self):
        return {p: self.size(d) for p, d in self.docs.items() if p.split("/")[0] in ("threading", "summary")}


def write_manifest(db, out, seen, upto=None, cleanup=True, one_by_one=False, stop_after=None):
    """Step 7 as SKILL.md has Claude do it: each batch in order, writes as listed, pins from step 5's read (`seen`),
    meta/chat and refresh/status added to the last batch; then, once every batch succeeded, the cleanup, skipping what
    step 5 didn't see. upto=k stops after k batches; one_by_one applies a batch's unpinned creates one write at a time
    and stops before its pinned writes (a tool that can't batch, interrupted); stop_after=k applies every write one at
    a time and stops after k of them, `current` documents included (a last batch that half landed)."""
    man = r(os.path.join(out, "manifest.json"))
    done = 0
    for k, bt in enumerate(man["batches"]):
        if upto is not None and k >= upto:
            return man
        ws = []
        for e in bt:
            x = {"op": e["op"], "collection": e["collection"], "doc_id": e["doc_id"], "data": r(e["file_path"])}
            if e.get("pin"):
                x["if_version"] = seen[e["collection"] + "/" + e["doc_id"]]
            ws.append(x)
        if one_by_one:
            for x in ws:
                if "if_version" not in x:
                    db.batch([x])
            return man
        if k == len(man["batches"]) - 1:
            ws.append(
                {
                    "op": "update",
                    "collection": "meta",
                    "doc_id": "chat",
                    "data": {"lastRefresh": "now"},
                    "if_version": seen["meta/chat"],
                }
            )
            ws.append(
                {
                    "op": "update",
                    "collection": "refresh",
                    "doc_id": "status",
                    "data": {"state": "done"},
                    "if_version": seen["refresh/status"],
                }
            )
        if stop_after is not None:
            for x in ws:
                if done == stop_after:
                    return man
                db.batch([x])
                done += 1
            continue
        db.batch(ws)
    for g in man["cleanup"] if cleanup else []:
        ws = [
            {"op": "delete", "collection": e["collection"], "doc_id": e["doc_id"], "if_version": seen[p]}
            for e in g
            for p in [e["collection"] + "/" + e["doc_id"]]
            if p in seen and p in db.docs
        ]
        if ws:
            db.batch(ws)
    return man


EMPTY_TH = {"convs": [], "links": {}, "to": -1, "note": ""}
EMPTY_SM = {"version": 2, "convs": [], "open": [], "answered": [], "deals": [], "mentions": [], "toI": -1}


def small(n):
    """n messages, all built into one conversation "a"."""
    th = {"convs": [{"id": "a", "title": "A", "members": list(range(n))}], "links": {}, "to": n - 1, "note": ""}
    sm = dict(EMPTY_SM, convs=[{"id": "a", "tag": "", "synopsis": [], "outcome": "", "key": []}], toI=n - 1)
    return [msg(i, "Ana", "m%d" % i, mi=i % 60) for i in range(n)], th, sm


class Live:
    """A page's database (FakeDB) plus Claude's WORK, driven the way a refresh drives them: the page imports into chunks
    and meta/chat, step 5 reads into a RUN folder, catchup.py builds, step 7 writes the manifest."""

    def __init__(self, d, msgs=(), th=None, sm=None, layout="old"):
        self.d, self.db, self.n = d, FakeDB(), 0
        self.work = os.path.join(d, "work")
        self.msgs = list(msgs)
        for k, ch in synth.chunks(self.msgs).items():
            self.db.put("chunks/" + k, ch)
        self.db.put(
            "meta/chat",
            {
                "lastI": len(self.msgs) - 1,
                "anchorMids": [m["m"] for m in self.msgs[-3:]],
                "tz": "America/Los_Angeles",
                "chunkSize": 82,
            },
        )
        self.db.put("refresh/status", {"state": "running", "by": "refresh 1"})
        th, sm = copy.deepcopy(th or EMPTY_TH), copy.deepcopy(sm or EMPTY_SM)
        docs = (
            {"threading/current": th, "summary/current": sm}
            if layout == "old"
            else catchup.layout_docs(catchup._canon_threading(th), sm)
        )
        for p, x in docs.items():
            self.db.put(p, x)

    def bootstrap(self, work=None):
        self.n += 1
        dbd = os.path.join(self.d, "db%d" % self.n)
        self.db.fetch(dbd)
        return quiet(catchup.bootstrap, work or self.work, dbd)

    def run(self, new, imported=False):
        """The page imports `new` (unless already imported), then step 5 reads the touched chunks, meta/chat and both
        collections into a fresh RUN folder."""
        if not imported:
            self.msgs += new
            for k, ch in synth.chunks(self.msgs).items():
                if ch["msgs"][-1]["i"] >= new[0]["i"]:
                    self.db.put("chunks/" + k, ch)
            self.db.put(
                "meta/chat",
                dict(self.db.docs["meta/chat"], lastI=self.msgs[-1]["i"], anchorMids=[m["m"] for m in self.msgs[-3:]]),
            )
        self.n += 1
        run = os.path.join(self.d, "run%d" % self.n)
        touched = {"chunks/c%04d" % (m["i"] // 82 * 82) for m in new}
        self.seen = self.db.fetch(run, chunks=touched)
        return run

    def listing(self, into):
        """`list threading` and `list summary` (and meta/chat) into a fresh folder, as a relink's RUN; keeps the
        versions it saw for the write."""
        self.seen = self.db.fetch(into, chunks=set())
        return into

    def build(self, run, spec, work=None):
        p = os.path.join(self.d, "spec%d.json" % self.n)
        w(p, spec)
        return quiet(catchup.build, work or self.work, run, p)

    def write(self, run, **kw):
        return write_manifest(self.db, os.path.join(run, "out"), self.seen, **kw)


def tail_spec(th, new, nid="tail1111"):
    """A realistic build: a new conversation, one more message each for the busiest and the longest-quiet conversation
    (it comes back from an archive block), bullets, an answer, a deal and a mention."""
    built = [c for c in th["convs"] if c["members"]]
    busy = max(built, key=lambda c: max(c["members"]))
    quiet_ = min(built, key=lambda c: max(c["members"]))
    ids = [m["i"] for m in new]
    others = [m["i"] for m in new[2:] if m["f"] != "You"]
    return {
        "newconvs": [
            {"id": nid, "title": "Pack question", "tag": "Question", "outcome": "Still open", "key": ids[2:4]}
        ],
        "join": {busy["id"]: ids[:1], quiet_["id"]: ids[1:2], nid: ids[2:]},
        "bullets": {
            nid: [["Ana asked about a pack", ids[2:4]]],
            busy["id"]: [["One more reply here", ids[:1]]],
            quiet_["id"]: [["Came back to this", ids[1:2]]],
        },
        "answered": [{"conv": nid, "ask": ids[2], "answer": "Yes, still available", "refs": [ids[3]]}],
        "deals": [{"kind": "sale", "tag": "For sale", "conv": nid, "text": "Pack, $80", "refs": [ids[4]]}],
        "mentions": [{"note": "Named you", "refs": [[others[-1]]]}] if others else [],
    }


def without_times(o):
    return {k: v for k, v in o.items() if k not in ("builtAt", "generatedAt")}


class TestLayout(unittest.TestCase):
    """v1.17: threading and summary are collections of documents that never approach the 256 KiB cap (BACKLOG B43)."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.d = self.t.name

    def tearDown(self):
        self.t.cleanup()

    def patch(self, **kw):
        for k, v in kw.items():
            old = getattr(catchup, k)
            setattr(catchup, k, v)
            self.addCleanup(setattr, catchup, k, old)

    def headroom(self, db):
        """Every threading and summary document at most half the cap: at least 2x headroom."""
        sz = db.layout_sizes()
        big = max(sz.items(), key=lambda kv: kv[1])
        self.assertLessEqual(big[1], FakeDB.DOC // 2, big)
        return big

    def test_fake_db_enforces_the_real_limits(self):
        db = FakeDB()
        with self.assertRaisesRegex(Refused, "over 262,144"):
            db.put("x/big", {"b": "x" * 262144})
        db.put("x/a", {"v": 1})
        put = lambda i, **kw: dict({"op": "set", "collection": "x", "doc_id": i, "data": kw.pop("data", {})}, **kw)
        with self.assertRaisesRegex(Refused, "needs if_version"):
            db.batch([put("a")])
        with self.assertRaisesRegex(Refused, "changed"):
            db.batch([put("a", if_version=7)])
        with self.assertRaisesRegex(Refused, "1-50 writes"):
            db.batch([put("n%d" % k) for k in range(51)])
        with self.assertRaisesRegex(Refused, "over 1 MiB"):
            db.batch([put("n%d" % k, data={"b": "x" * 200000}) for k in range(6)])
        with self.assertRaisesRegex(Refused, "would be"):
            db.batch([put("n0", data={"b": "x" * 262144})])
        with self.assertRaisesRegex(Refused, "needs if_version"):
            db.batch([put("new"), put("a")])  # all or nothing
        self.assertNotIn("x/new", db.docs)
        db.batch([put("new"), put("a", data={"v": 2}, if_version=1)])
        self.assertEqual((db.docs["x/a"], db.ver["x/a"]), ({"v": 2}, 2))

    def test_migration_from_the_old_layout_keeps_everything_and_fromI(self):
        """The owner's page on Nov 11, in miniature: one threading document near the cap, and a summary that earlier
        sessions cut down to the conversations after fromI. The first build converts both; nothing is dropped."""
        msgs, th, sm = synth.chat(6400, seed=5)
        sm = synth.drop_before(sm, th, 2797)
        live = Live(self.d, msgs, th, sm, "old")
        bt, bs = copy.deepcopy(live.db.merged())
        self.assertGreater(FakeDB.size(bt), 150000)
        self.assertIn(
            "threading and summary in the single-document layout: the next build converts it", live.bootstrap()
        )
        new = synth.more(6400, 20)
        run = live.run(new)
        out = live.build(run, tail_spec(th, new))
        self.assertIn("build ok: #6400-#6419", out)
        man = live.write(run)
        self.assertEqual(len(man["batches"]), 1)
        cur = live.db.docs
        self.assertEqual((cur["threading/current"]["layout"], cur["summary/current"]["layout"]), (2, 2))
        self.assertNotIn("links", cur["threading/current"])
        self.assertEqual(cur["summary/current"]["fromI"], 2797, "fromI is kept as is")
        t, s = live.db.merged()
        self.assertEqual(s["fromI"], 2797)
        # nothing dropped: every conversation, bullet, link and list item from before is still there, in order
        after = {c["id"]: c for c in s["convs"]}
        for c in bs["convs"]:
            self.assertEqual(after[c["id"]]["synopsis"][: len(c["synopsis"])], c["synopsis"])
        self.assertEqual(s["answered"][1:], bs["answered"])
        self.assertEqual(s["mentions"][1:], bs["mentions"])
        self.assertEqual(s["deals"][:-1], bs["deals"])
        tc = {c["id"]: c["members"] for c in t["convs"]}
        for c in bt["convs"]:
            self.assertEqual(tc[c["id"]][: len(c["members"])], c["members"])
        self.assertTrue(all(t["links"][k] == v for k, v in bt["links"].items()))
        quiet_ = tail_spec(th, new)["join"]
        revived = [c for c in quiet_ if c != "tail1111" and c not in {x["id"] for x in bs["convs"]}]
        self.assertEqual(len(revived), 1, "the longest-quiet conversation's summary was among those dropped")
        self.assertEqual(
            [b["t"] for b in after[revived[0]]["synopsis"]], ["Came back to this"], "its summary starts again"
        )
        # what the database now holds is exactly what WORK built, and a fresh bootstrap reads it back the same
        self.assertEqual(t, r(os.path.join(self.d, "work", "base", "threading.json")))
        self.assertEqual(s, r(os.path.join(self.d, "work", "base", "summary.json")))
        self.assertEqual(t, r(os.path.join(run, "out", "merged", "threading.json")))
        live.bootstrap(os.path.join(self.d, "work2"))
        for f in ("all.json", "base/threading.json", "base/summary.json", "state.json"):
            self.assertEqual(r(os.path.join(self.d, "work2", f)), r(os.path.join(self.d, "work", f)), f)
        self.headroom(live.db)

    def test_build_at_scale_every_document_under_the_cap(self):
        """6.4k, 25k and 50k messages (the design target): every document at most half the cap, a build writes a few
        documents, and the tool's batch limits hold."""
        for n in (6400, 25000, 50000):
            with self.subTest(n=n):
                d = os.path.join(self.d, str(n))
                msgs, th, sm = synth.chat(n - 20, seed=n)
                if n >= 6400:
                    self.assertGreater(FakeDB.size(sm), FakeDB.DOC, "one summary document couldn't hold this")
                live = Live(d, msgs, th, sm, "new")
                live.bootstrap()
                new = synth.more(n - 20, 20)
                run = live.run(new)
                self.assertIn("build ok", live.build(run, tail_spec(th, new)))
                man = live.write(run)
                self.assertLessEqual(sum(map(len, man["batches"])), 6, man["sizes"])
                big = self.headroom(live.db)
                t, s = live.db.merged()
                self.assertEqual(len(t["convs"]), len(th["convs"]) + 1)
                self.assertEqual(t["to"], n - 1)
                print(
                    "\n  %d messages: %d layout documents, largest %s %d bytes; the build wrote %d in %d batch"
                    % (n, len(live.db.layout_sizes()), *big, sum(map(len, man["batches"])), len(man["batches"])),
                    end="",
                )

    def test_link_correction_lands_in_its_block(self):
        msgs, th, sm = synth.chat(3500, seed=11)
        live = Live(self.d, msgs, th, sm, "new")
        live.bootstrap()
        conv = next(c for c in th["convs"] if 1234 in c["members"])
        parent = next(i for i in conv["members"][::-1] if i < 1234 and th["links"].get("1234", [None])[0] != i)
        before = live.db.docs["threading/current"]["blocks"]
        spec = os.path.join(self.d, "relink.json")
        w(spec, {"relink": {"1234": [parent, "i"]}})
        rrun = live.listing(os.path.join(self.d, "rrun"))
        out = os.path.join(rrun, "out")
        self.assertIn("relink ok: 1 change(s)", quiet(catchup.relink, live.work, rrun, spec))
        man = r(os.path.join(out, "manifest.json"))
        made = [e["doc_id"] for bt in man["batches"] for e in bt]
        self.assertEqual(len(made), 2, made)
        self.assertTrue(made[0].startswith("b001000-") and made[1] == "current", made)
        sv = {p: v for p, v in live.db.ver.items() if p.startswith("summary/")}
        write_manifest(live.db, out, live.seen)
        t, _ = live.db.merged()
        self.assertEqual(t["links"]["1234"], [parent, "i"])
        now = live.db.docs["threading/current"]["blocks"]
        self.assertEqual(
            [b for b in now if not b.startswith("b001000-")], [b for b in before if not b.startswith("b001000-")]
        )
        self.assertEqual({p: v for p, v in live.db.ver.items() if p.startswith("summary/")}, sv, "summary untouched")
        # the same correction inside a build lands in the same block, next to the block the new messages go to
        new = synth.more(3500, 20)
        run = live.run(new)
        spec = dict(tail_spec(t, new), relink={"1234": None})
        live.build(run, spec)
        made = [e["doc_id"] for bt in r(os.path.join(run, "out", "manifest.json"))["batches"] for e in bt]
        self.assertTrue(
            any(x.startswith("b001000-") for x in made) and any(x.startswith("b003000-") for x in made), made
        )
        live.write(run)
        self.assertNotIn("1234", live.db.merged()[0]["links"])

    def test_interrupted_migration_is_safe_and_a_retry_finishes_it(self):
        msgs, th, sm = synth.chat(2600, seed=13)
        live = Live(self.d, msgs, th, sm, "old")
        before = copy.deepcopy(live.db.merged())
        live.bootstrap()
        new = synth.more(2600, 20)
        run = live.run(new)
        spec = tail_spec(th, new)
        live.build(run, spec)
        whole = r(os.path.join(run, "out", "merged", "summary.json"))
        live.write(run, one_by_one=True)  # the blocks landed, then the run died before the `current` documents
        self.assertGreater(len(live.db.coll("threading")), 1)
        self.assertEqual(live.db.merged(), before, "until `current` names them, new blocks change nothing anyone reads")
        # the next session: a fresh WORK, bootstrapped from what's there, builds the same messages again
        work2 = os.path.join(self.d, "work2")
        live.bootstrap(work2)
        run2 = live.run(new, imported=True)
        live.build(run2, spec, work2)
        man = r(os.path.join(run2, "out", "manifest.json"))
        self.assertEqual(
            [e["doc_id"] for bt in man["batches"] for e in bt], ["current", "current"], "blocks already there"
        )
        live.write(run2)
        t, s = live.db.merged()
        self.assertEqual(without_times(s), without_times(whole))
        self.assertEqual(t, r(os.path.join(work2, "base", "threading.json")))
        self.assertEqual(man["cleanup"], [])

    def test_interrupted_between_batches_and_before_cleanup(self):
        self.patch(BATCH_DOCS=2)
        msgs, th, sm = synth.chat(2600, seed=21)
        live = Live(self.d, msgs, th, sm, "old")
        before = copy.deepcopy(live.db.merged())
        live.bootstrap()
        new = synth.more(2600, 20)
        run = live.run(new)
        live.build(run, tail_spec(th, new))
        man = r(os.path.join(run, "out", "manifest.json"))
        self.assertGreater(len(man["batches"]), 2)
        self.assertTrue(all(len(b) <= 2 for b in man["batches"]))
        live.write(run, upto=1)
        self.assertEqual(live.db.merged(), before)
        work2 = os.path.join(self.d, "work2")
        live.bootstrap(work2)
        run2 = live.run(new, imported=True)
        live.build(run2, tail_spec(th, new), work2)
        live.write(run2, cleanup=False)  # done, but the run stopped before deleting the old blocks
        t, s = copy.deepcopy(live.db.merged())
        self.assertEqual(t, r(os.path.join(work2, "base", "threading.json")))
        new2 = synth.more(2620, 20, seed=4)
        run3 = live.run(new2)
        live.build(run3, {"join": {"tail1111": [m["i"] for m in new2]}}, work2)
        man3 = live.write(run3)
        self.assertTrue(man3["cleanup"])
        named = set(live.db.docs["threading/current"]["blocks"]) | set(live.db.docs["summary/current"]["blocks"])
        self.assertEqual(
            {p.split("/")[1] for p in live.db.layout_sizes()} - {"current"}, named, "no unused blocks left"
        )

    def test_hard_size_check(self):
        live = Live(self.d, *small(50))
        live.bootstrap()
        new = [msg(i, "Ben", "n%d" % i, h=10, mi=i % 60) for i in range(50, 80)]
        run = live.run(new)
        long = " ".join(["abcdefghi"] * 15)
        spec = {
            "join": {"a": list(range(50, 80))},
            "bullets": {"a": [[long, [50 + k % 30]] for k in range(1700)]},
        }
        before = live.db.layout_sizes()
        with self.assertRaisesRegex(
            AssertionError,
            r"summary/current would be \d+ bytes, over the 245760-byte limit .*Nothing was written and WORK is unchanged\. "
            r"Never drop or shorten .*largest conversations: a \(",
        ):
            live.build(run, spec)
        self.assertEqual(json.loads(json.dumps(r(os.path.join(live.work, "state.json"))))["base"], 49)
        self.assertFalse(os.path.exists(os.path.join(run, "out")))
        self.assertEqual(live.db.layout_sizes(), before)

    def test_bootstrap_from_either_layout_gives_the_same_state(self):
        msgs, th, sm = synth.chat(2600, seed=17)
        a = Live(os.path.join(self.d, "a"), msgs, th, sm, "old")
        b = Live(os.path.join(self.d, "b"), msgs, th, sm, "new")
        self.assertGreater(len(b.db.coll("summary")), 2)
        a.bootstrap()
        b.bootstrap()
        for f in ("all.json", "base/threading.json", "base/summary.json", "state.json"):
            self.assertEqual(r(os.path.join(a.work, f)), r(os.path.join(b.work, f)), f)

    def test_split_and_merge_keep_every_item_in_order(self):
        """Lists in any order, items with no message numbers, empty conversations, an old string synopsis: merging the
        documents gives back exactly what was split, for several block sizes and activeFrom values."""
        for seed in range(6):
            for block in (7, 50, 1000):
                rnd = random.Random(seed)
                self.patch(BLOCK=block)
                msgs, th, sm = synth.chat(700, seed=seed, per_build=5)
                rnd.shuffle(sm["answered"])
                sm["answered"].insert(0, {"conv": sm["convs"][-1]["id"], "ask": 3, "answer": "late", "refs": []})
                sm["deals"][0]["refs"].append(690)  # dealEdit adds a later message to an old deal
                sm["mentions"].insert(5, {"note": "no refs", "refs": []})
                sm["convs"].insert(
                    3, {"id": "str", "tag": "", "synopsis": "Old one. Two sentences.", "outcome": "", "key": []}
                )
                sm["convs"].append({"id": "nothing", "tag": "", "synopsis": [], "outcome": "", "key": []})
                th["convs"].append({"id": "nothing", "title": "No messages yet", "members": []})
                t = catchup._canon_threading(copy.deepcopy(th))
                docs = catchup.layout_docs(t, copy.deepcopy(sm), active_from=rnd.choice([0, 100, 333]))
                by = lambda c: {p.split("/")[1]: d for p, d in docs.items() if p.startswith(c + "/")}
                self.assertEqual(catchup.merge_threading(by("threading")), t)
                self.assertEqual(catchup.merge_summary(by("summary")), sm)
                for c in ("threading", "summary"):
                    self.assertEqual(sorted(by(c)), sorted(docs[c + "/current"]["blocks"] + ["current"]))

    def test_an_ordinary_build_rewrites_only_the_newest_block(self):
        msgs, th, sm = synth.chat(2500, seed=19)
        live = Live(self.d, msgs, th, sm, "new")
        live.bootstrap()
        for k in range(2):
            new = synth.more(2500 + 20 * k, 20, seed=k)
            run = live.run(new)
            busy = max(live.db.merged()[0]["convs"], key=lambda c: max(c["members"]))
            live.build(run, {"join": {busy["id"]: [m["i"] for m in new]}})
            man = live.write(run)
            made = [e["collection"] + "/" + e["doc_id"] for bt in man["batches"] for e in bt]
            self.assertEqual(
                [m for m in made if "/b" in m and m.startswith("threading/")][0][:18], "threading/b002000-"
            )
            self.assertEqual(len(made), 3, made)  # the newest threading block, then both `current` documents
            self.assertEqual([e["doc_id"][:8] for g in man["cleanup"] for e in g], ["b002000-"])

    def test_cleanup_deletes_only_blocks_the_replaced_current_named(self):
        """Review of #31, finding 1: blocks no `current` names, and documents that aren't blocks, are never deleted."""
        msgs, th, sm = synth.chat(2500, seed=23)
        live = Live(self.d, msgs, th, sm, "new")
        live.db.put("summary/notes-kept", {"from": "an earlier session"})
        live.db.put("threading/b009000-deadbeef", {"start": 9000})
        live.bootstrap()
        named = {c: set(live.db.docs[c + "/current"]["blocks"]) for c in ("threading", "summary")}
        new = synth.more(2500, 20)
        run = live.run(new)
        live.build(run, tail_spec(th, new))
        man = live.write(run)
        gone = {e["collection"] + "/" + e["doc_id"] for g in man["cleanup"] for e in g}
        dropped = {c + "/" + b for c in named for b in named[c] - set(live.db.docs[c + "/current"]["blocks"])}
        self.assertTrue(gone)
        self.assertEqual(gone, dropped)
        for p in ("threading/b009000-deadbeef", "summary/notes-kept", "threading/current"):
            self.assertIn(p, live.db.docs)

    def test_build_refuses_when_another_session_built(self):
        live = Live(self.d, *small(5))
        live.bootstrap()
        live.db.put("threading/current", dict(live.db.docs["threading/current"], builtAt="Wed Nov 11, 9:05 PM"))
        run = live.run([msg(5, "Ben", "x")])
        with self.assertRaisesRegex(
            AssertionError, "threading/current changed since WORK was bootstrapped .*Bootstrap WORK again"
        ):
            live.build(run, {"join": {"a": [5]}})

    def test_work_from_an_older_catchup_needs_a_bootstrap(self):
        live = Live(self.d, *small(5))
        live.bootstrap()
        os.remove(os.path.join(live.work, "base", "layout.json"))
        run = live.run([msg(5, "Ben", "x")])
        with self.assertRaisesRegex(AssertionError, "older catchup.py .*bootstrap it again"):
            live.build(run, {"join": {"a": [5]}})

    def test_a_big_migration_fits_the_tool_in_several_batches(self):
        self.patch(BLOCK=20)
        msgs, th, sm = synth.chat(1500, seed=29)
        live = Live(self.d, msgs, th, sm, "old")
        live.bootstrap()
        new = synth.more(1500, 20)
        run = live.run(new)
        live.build(run, tail_spec(th, new))
        man = live.write(run)  # FakeDB refuses any batch over 50 writes or 1 MiB
        self.assertGreater(len(man["batches"]), 2)
        self.assertTrue(all(len(b) <= catchup.BATCH_DOCS for b in man["batches"]))
        self.assertEqual(live.db.merged()[0], r(os.path.join(live.work, "base", "threading.json")))


class TestReview31(unittest.TestCase):
    """Findings of the independent review of PR #31 (v1.17.0), each reproduced before it was fixed."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.d = self.t.name

    def tearDown(self):
        self.t.cleanup()

    def deal(self, live):
        return any(x.get("text") == "Pack, $80" for x in live.db.merged()[1]["deals"])

    def test_a_current_an_older_skill_wrote_never_leads_to_deleting_blocks(self):
        """Finding 1 (s6): after 1.17 converts a page, a 1.16 session writes its stale single documents (left in a
        reused RUN/out) to both `current` documents. The next build's cleanup used to delete the blocks that held the
        conversion build, and with them its deal."""
        msgs, th, sm = synth.chat(2600, seed=13)
        live = Live(self.d, msgs, th, sm, "old")
        stale_t, stale_s = copy.deepcopy(th), copy.deepcopy(sm)
        live.bootstrap()
        new = synth.more(2600, 20)
        run = live.run(new)
        live.build(run, tail_spec(th, new))
        live.write(run)
        self.assertTrue(self.deal(live))
        kept = {p for p in live.db.docs if "/b" in p}
        live.db.batch(
            [
                {
                    "op": "set",
                    "collection": c,
                    "doc_id": "current",
                    "data": x,
                    "if_version": live.db.ver[c + "/current"],
                }
                for c, x in (("threading", stale_t), ("summary", stale_s))
            ]
        )
        out = live.bootstrap(os.path.join(self.d, "w2"))
        run2 = live.run(new, imported=True)
        busy = max(th["convs"], key=lambda c: max(c["members"]))
        live.build(run2, {"join": {busy["id"]: [m["i"] for m in new]}}, os.path.join(self.d, "w2"))
        man = live.write(run2)
        self.assertEqual(man["cleanup"], [], "the replaced current was a single document: it named no blocks")
        self.assertTrue(kept <= set(live.db.docs), "every block of the conversion build is still stored")
        self.assertIn(
            "WARN block documents no current names hold messages through #2619, past threading/current's #2599", out
        )
        self.assertIn("block document(s) no current names, left alone", out)

    def test_a_reused_run_folder_loses_its_legacy_files(self):
        """Finding 1: a 1.16 build's RUN/out/threading.json and summary.json must not survive a 1.17 build in the same
        RUN folder, where a model could take them for this build's output."""
        live = Live(self.d, *small(20))
        live.bootstrap()
        run = live.run([msg(20, "Ben", "x", mi=20)])
        for f in ("threading.json", "summary.json"):
            w(os.path.join(run, "out", f), {"stale": True})
        live.build(run, {"join": {"a": [20]}})
        self.assertFalse(os.path.exists(os.path.join(run, "out", "threading.json")))
        self.assertFalse(os.path.exists(os.path.join(run, "out", "summary.json")))
        self.assertTrue(os.path.exists(os.path.join(run, "out", "manifest.json")))

    def test_relink_after_cleanup_writes_the_block_it_names(self):
        """Finding 2 (S3): a build changes a link and its cleanup deletes the old block; a relink that undoes the change
        hashes back to that deleted block's id, and used to write a `current` naming it without creating it."""
        msgs, th, sm = synth.chat(3500, seed=11)
        live = Live(self.d, msgs, th, sm, "new")
        live.bootstrap()
        orig = th["links"].get("1234")
        conv = next(c for c in th["convs"] if 1234 in c["members"])
        parent = next(i for i in conv["members"][::-1] if i < 1234 and (orig is None or orig[0] != i))
        new = synth.more(3500, 20)
        run = live.run(new)
        live.build(run, dict(tail_spec(th, new), relink={"1234": [parent, "i"]}))
        man = live.write(run)
        gone = [e["doc_id"] for g in man["cleanup"] for e in g if e["doc_id"].startswith("b001000-")]
        self.assertEqual(len(gone), 1)
        spec = os.path.join(self.d, "rl.json")
        w(spec, {"relink": {"1234": orig}})
        rrun = live.listing(os.path.join(self.d, "rrun"))
        quiet(catchup.relink, live.work, rrun, spec)
        made = [e["doc_id"] for bt in r(os.path.join(rrun, "out", "manifest.json"))["batches"] for e in bt]
        self.assertEqual(made, [gone[0], "current"], "the block comes back as a new document")
        write_manifest(live.db, os.path.join(rrun, "out"), live.seen)
        cur = live.db.docs["threading/current"]
        self.assertEqual([b for b in cur["blocks"] if "threading/" + b not in live.db.docs], [])
        self.assertEqual(live.db.merged()[0]["links"].get("1234"), orig)
        self.assertIn("bootstrap ok", live.bootstrap(os.path.join(self.d, "w3")))
        self.assertEqual(r(os.path.join(live.work, "base", "layout.json"))["threading"], cur["blocks"])

    def test_build_and_relink_refuse_an_incomplete_listing(self):
        """Finding 3 (s5): with only the two `current` documents in RUN (what 1.16's step 5 fetched), a build used to
        write `current` documents naming blocks it never listed."""
        msgs, th, sm = synth.chat(3500, seed=11)
        live = Live(self.d, msgs, th, sm, "new")
        live.bootstrap()
        new = synth.more(3500, 20)
        run = live.run(new)
        for c in ("threading", "summary"):
            for f in os.listdir(os.path.join(run, c)):
                if f != "current.json":
                    os.remove(os.path.join(run, c, f))
        with self.assertRaisesRegex(
            AssertionError,
            r"RUN/threading/current names b\d{6}-\w+, .* not in RUN: list the whole threading collection",
        ):
            live.build(run, tail_spec(th, new))
        self.assertFalse(os.path.exists(os.path.join(run, "out")))
        shutil.rmtree(os.path.join(run, "threading"))
        with self.assertRaisesRegex(AssertionError, "RUN has no threading/current.json: list the whole threading"):
            live.build(run, tail_spec(th, new))
        spec = os.path.join(self.d, "rl.json")
        w(spec, {"relink": {"1234": None}})
        with self.assertRaisesRegex(AssertionError, "RUN has no threading/current.json"):
            quiet(catchup.relink, live.work, os.path.join(self.d, "empty"), spec)

    def test_bootstrap_says_what_to_do_about_a_missing_block(self):
        """Finding 4: fetching again doesn't bring back a block that was deleted."""
        msgs, th, sm = synth.chat(2500, seed=3)
        live = Live(self.d, msgs, th, sm, "new")
        b = live.db.docs["threading/current"]["blocks"][1]
        del live.db.docs["threading/" + b]
        with self.assertRaisesRegex(
            AssertionError,
            "threading/current names %s, which is not in the folder. Fetch the whole threading collection .*If it's "
            "still missing after that, it was deleted: write nothing, and tell the user" % b,
        ):
            live.bootstrap()

    def test_a_partly_applied_write_stops_bootstrap_and_rollback_recovers(self):
        """Finding 5: a tool that applies a batch one write at a time and stops after threading/current leaves threading
        a build ahead of summary. Bootstrap stops and says how to recover; --rollback rebuilds those messages."""
        msgs, th, sm = synth.chat(2600, seed=31)
        live = Live(self.d, msgs, th, sm, "new")
        live.bootstrap()
        new = synth.more(2600, 20)
        run = live.run(new)
        spec = tail_spec(th, new)
        live.build(run, spec)
        whole = {c: r(os.path.join(run, "out", "merged", c + ".json")) for c in ("threading", "summary")}
        man = r(os.path.join(run, "out", "manifest.json"))
        writes = [e["collection"] + "/" + e["doc_id"] for bt in man["batches"] for e in bt]
        live.write(run, stop_after=writes.index("threading/current") + 1)
        t, s = live.db.merged()
        self.assertEqual((t["to"], s["toI"]), (2619, 2599))
        w2 = os.path.join(self.d, "w2")
        with self.assertRaisesRegex(
            AssertionError,
            r"threading/current is built through #2619 but summary/current through #2599: the last write was only "
            r"partly applied\. Nothing was changed\. .*--rollback`: #2600-#2619 then count as not built yet",
        ):
            live.bootstrap(w2)
        self.assertFalse(os.path.exists(os.path.join(w2, "state.json")), "WORK isn't made")
        dbd = os.path.join(self.d, "dbr")
        live.db.fetch(dbd)
        self.assertIn("rolled threading back from #2619 to #2599", quiet(catchup.bootstrap, w2, dbd, True))
        run2 = live.run(new, imported=True)
        self.assertIn("build ok: #2600-#2619", live.build(run2, spec, w2))
        live.write(run2)
        t, s = live.db.merged()
        for c, got in (("threading", t), ("summary", s)):
            self.assertEqual(without_times(got), without_times(whole[c]), c)


class TestIssue33(unittest.TestCase):
    """Found on the first live refresh on 1.17.0 (GitHub issue #33)."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.d = self.t.name

    def tearDown(self):
        self.t.cleanup()

    def collection(self, db, c):
        return {p.split("/", 1)[1]: d for p, d in db.docs.items() if p.startswith(c + "/")}

    def test_conversation_ids_used_twice_are_renamed_and_the_conversion_goes_through(self):
        msgs = [msg(i, "Ana", "m%d" % i, mi=i % 60) for i in range(200)]
        th = {
            "convs": [
                {"id": "a", "title": "A", "members": list(range(0, 50))},
                {"id": "b", "title": "B", "members": list(range(50, 100))},
                {"id": "a", "title": "A again", "members": list(range(100, 150))},
                {"id": "b", "title": "B again", "members": list(range(150, 200))},
            ],
            "links": {},
            "to": 199,
            "note": "",
        }
        sm = dict(EMPTY_SM, convs=[{"id": "a", "tag": "", "synopsis": [], "outcome": "", "key": []}], toI=199)
        live = Live(self.d, msgs, th, sm)
        out = live.bootstrap()
        self.assertIn("conversation id(s) used twice, renamed: a -> a100, b -> b150", out)
        new = [msg(i, "Ben", "n%d" % i, mi=i % 60) for i in range(200, 204)]
        run = live.run(new)
        self.assertIn("build ok", live.build(run, {"join": {"a100": [200, 201], "b": [202, 203]}}))
        live.write(run)
        got = catchup.merge_threading(self.collection(live.db, "threading"))
        mem = {c["id"]: c["members"] for c in got["convs"]}
        self.assertEqual(sorted(mem), ["a", "a100", "b", "b150"])
        self.assertEqual(mem["a100"], list(range(100, 150)) + [200, 201])
        self.assertEqual(mem["b"], list(range(50, 100)) + [202, 203])
        self.assertEqual(mem["a"], list(range(0, 50)))

    def test_a_summary_with_an_id_used_twice_stops_bootstrap_with_what_to_do(self):
        msgs, th, sm = small(20)
        sm["convs"].append(dict(sm["convs"][0]))
        live = Live(self.d, msgs, th, sm)
        with self.assertRaisesRegex(
            AssertionError, r"summary has more than one conversation with id a: nothing was changed"
        ):
            live.bootstrap()

    def test_chunk_names_come_from_the_stored_chunks(self):
        """Chunks start where imports landed (c0000, c0049, …), not at multiples of chunkSize."""
        msgs, th, sm = small(120)
        th["convs"][0]["members"] = list(range(100))
        th["to"] = sm["toI"] = 99
        live = Live(self.d, msgs, th, sm)
        for p in [p for p in live.db.docs if p.startswith("chunks/")]:
            del live.db.docs[p]
        live.db.put("chunks/c0000", {"start": 0, "msgs": msgs[:49]})
        live.db.put("chunks/c0049", {"start": 49, "msgs": msgs[49:]})
        out = live.bootstrap()
        self.assertIn("#100-#119 are stored but not built yet: the next RUN must include chunks/c0049", out)
        self.assertEqual(r(os.path.join(live.work, "state.json"))["chunks"], [0, 49])
        self.assertEqual(catchup._chunk_names(40, 60, [0, 49], 82), ["chunks/c0000", "chunks/c0049"])
        self.assertEqual(catchup._chunk_names(90, 95, None, 82), ["chunks/c0082"], "an older WORK falls back")


CUT, FROM = 1200, 500  # the trim's cutoff (the live page: 2797) and the backup's fromI (1654)
OLD_SYN = "Ana asked about the tent. Ben said it sold."  # an old string synopsis: two sentences, so two bullets
OLD_BULLETS = [{"t": "Ana asked about the tent.", "refs": []}, {"t": "Ben said it sold.", "refs": []}]


def backup_parts(sm):
    """The full summary saved as the live session saved it: part a holds every field and half the conversations."""
    meta = {"what": "summary/current before a refresh dropped items to fit", "savedAt": "2026-11-12T01:00:00.000Z"}
    half = len(sm["convs"]) // 2
    a = dict({k: v for k, v in sm.items() if k != "convs"}, part="a", of=2, convs=sm["convs"][:half], **meta)
    return a, dict(part="b", of=2, convs=sm["convs"][half:], **meta)


def fetch_backups(db, into):
    """`list backups` into an out_dir."""
    for p, d in db.docs.items():
        if p.startswith("backups/"):
            w(os.path.join(into, p + ".json"), d)
    return into


class TestRestoreSummary(unittest.TestCase):
    """F10 (issue #32 §4): put back what a pre-1.17 refresh dropped from the summary, from the page's `backups`.

    Two pages start from the same 3,000-message history and get the same two later builds. One (U) was never trimmed;
    the other (T) was trimmed the way the live session trimmed it, saved its backup first, then converted to the block
    layout and continued two of the conversations it had dropped. Restored, T must equal U: nothing lost, nothing twice,
    every item in its place."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.d = self.t.name

    def tearDown(self):
        self.t.cleanup()

    def restore(self, live, work, run, bk, dec=None, dry=False):
        if dec is not None:
            p = os.path.join(self.d, "decisions%d.json" % live.n)
            w(p, dec)
            dec = p
        return quiet(catchup.restore_summary, work, run, bk, dec, dry)

    def world(self):
        """-> (T, U, facts): both pages after their later builds, and what the trim did."""
        msgs, th, sm = synth.chat(3000, seed=41)
        sm["fromI"] = FROM
        last = {c["id"]: max(c["members"]) for c in th["convs"]}
        mem = {c["id"]: c["members"] for c in th["convs"]}
        dropped = [c["id"] for c in sm["convs"] if last[c["id"]] < CUT]
        kept = [c["id"] for c in sm["convs"] if last[c["id"]] >= CUT]
        for k, cid in enumerate(dropped):  # a third of the dropped conversations, and one kept one, in the old format
            if k % 3 == 0:
                next(c for c in sm["convs"] if c["id"] == cid)["synopsis"] = OLD_SYN
        sc = {c["id"]: c for c in sm["convs"]}
        sc[kept[5]]["synopsis"] = OLD_SYN
        X = next(c for c in dropped if sc[c]["synopsis"] == OLD_SYN)  # continued later: an old string synopsis
        lists = [c for c in dropped if isinstance(sc[c]["synopsis"], list) and len(mem[c]) >= 3]
        Y, A, O = lists[0], lists[1], lists[2]  # Y continued later; A's and O's questions still open
        asks = {o["ask"] for o in sm["open"]}
        oY, oA, oO = ({"conv": c, "ask": mem[c][0], "to": "anyone", "note": "Still around?"} for c in (Y, A, O))
        assert not {oY["ask"], oA["ask"], oO["ask"]} & asks
        sm["open"][1:1] = [oA]
        sm["open"][4:4] = [oY, oO]
        deal_conv = next(c for c in kept if [d["conv"] for d in sm["deals"]].count(c) == 1 and c != kept[5])
        K = next(c for c in kept if isinstance(sc[c]["synopsis"], list) and len(sc[c]["synopsis"]) >= 4)
        full = copy.deepcopy(sm)
        # the trim: conversations that ended before CUT and their items, then a few items of kept conversations
        trim = synth.drop_before(sm, th, CUT)
        next(c for c in trim["convs"] if c["id"] == K)["synopsis"] = sc[K]["synopsis"][2:]
        gone = {
            "answered": trim["answered"].pop(3),
            "deals": next(x for x in trim["deals"] if x["conv"] != deal_conv),
            "mentions": trim["mentions"].pop(6),
        }
        trim["deals"].remove(gone["deals"])
        T = Live(os.path.join(self.d, "t"), msgs, th, trim, "old")
        for p, x in zip(("a", "b"), backup_parts(full)):
            T.db.put("backups/summary-pre-prune-" + p, x)
        U = Live(os.path.join(self.d, "u"), msgs, th, full, "old")
        # two later builds on both pages; the first converts them to the block layout
        new1, new2 = synth.more(3000, 20, seed=3), synth.more(3020, 20, seed=4)
        ids1, ids2 = [m["i"] for m in new1], [m["i"] for m in new2]
        you = [m["i"] for m in new1 if m["f"] != "You"]
        spec1 = {
            "newconvs": [{"id": "tail1112", "title": "Pack", "tag": "Question", "outcome": "Open", "key": ids1[4:6]}],
            "join": {X: ids1[:2], Y: ids1[2:4], "tail1112": ids1[4:]},
            "bullets": {
                X: [["Came back to the tent", ids1[:1]]],
                Y: [["Ben answered at last", ids1[3:4]]],
                "tail1112": [["Ana asked about a pack", ids1[4:5]]],
            },
            "answered": [{"conv": Y, "ask": oY["ask"], "answer": "Yes, it fits", "refs": ids1[3:4]}],
            "mentions": [{"note": "Named you", "refs": [[you[-1]]]}],
        }
        spec2 = {
            "join": {deal_conv: ids2[:1], "tail1112": ids2[1:]},
            "dealEdit": {deal_conv: {"text": "Price dropped", "addRefs": ids2[:1]}},
            "deals": [{"kind": "sale", "tag": "For sale", "conv": "tail1112", "text": "Pack, $80", "refs": ids2[1:2]}],
            "open": [{"conv": "tail1112", "ask": ids2[2], "to": "anyone", "note": "Price?"}],
            "bullets": {"tail1112": [["Price dropped to $80", ids2[1:2]]]},
        }
        for live, close in ((T, []), (U, [oY["ask"]])):  # only U still had oY open to close
            live.bootstrap()
            for new, spec in ((new1, dict(spec1, closeOpen=close)), (new2, spec2)):
                run = live.run(new)
                self.assertIn("build ok", live.build(run, spec))
                live.write(run)
        facts = dict(
            full=full, trim=trim, dropped=dropped, kept=kept, X=X, Y=Y, K=K, oA=oA, oO=oO, oY=oY, mem=mem, gone=gone
        )
        return T, U, facts

    def ready(self, T, tag):
        """The procedure's reads: fetch everything and bootstrap a fresh WORK, list the collections, list backups."""
        work = os.path.join(self.d, "work-" + tag)
        T.bootstrap(work)
        run = T.listing(os.path.join(self.d, "run-" + tag))
        return work, run, fetch_backups(T.db, os.path.join(self.d, "bk-" + tag))

    def snapshot(self, work):
        return {f: r(os.path.join(work, f)) for f in catchup.WFILES}

    def test_restore_puts_back_everything_the_trim_dropped(self):
        T, U, f = self.world()
        full, trim = f["full"], f["trim"]
        work, run, bk = self.ready(T, "1")
        n_syn = lambda c: 2 if c["synopsis"] == OLD_SYN else len(c["synopsis"])
        sc = {c["id"]: c for c in full["convs"]}
        qkey = lambda o: (o["conv"], o["ask"])
        answered = {qkey(a) for a in full["answered"]} | {qkey(f["oY"])}  # in the backup's answers, or answered since
        dropped_open = [o for o in full["open"] if o["conv"] in f["dropped"]]
        cands = [o for o in dropped_open if qkey(o) not in answered]
        self.assertIn(f["oA"], cands)
        self.assertIn(f["oO"], cands)
        self.assertNotEqual(T.db.docs["summary/current"].get("layout"), None, "converted to the block layout")
        self.assertEqual(T.db.merged()[1]["fromI"], CUT)
        counts = lambda opened: [
            "  convs: %d restored, 3 merged, %d already present, 0 skipped"
            % (len(f["dropped"]) - 2, len(f["kept"]) - 1),
            "  bullets: %d restored, %d already present, 0 skipped"
            % (sum(n_syn(sc[c]) for c in f["dropped"]) + 2, sum(n_syn(sc[c]) for c in f["kept"]) - 2),
            opened
            + ", %d already present, %d already answered, 0 skipped"
            % (len([o for o in full["open"] if o["conv"] in f["kept"]]), len(dropped_open) - len(cands)),
            "  answered: %d restored, %d already present, 0 skipped"
            % (len(full["answered"]) - len(trim["answered"]), len(trim["answered"])),
            "  deals: %d restored, %d already present, 0 skipped"
            % (len(full["deals"]) - len(trim["deals"]), len(trim["deals"])),
            "  mentions: %d restored, %d already present, 0 skipped"
            % (len(full["mentions"]) - len(trim["mentions"]), len(trim["mentions"])),
            "  fromI: %d -> %d" % (CUT, FROM),
        ]
        before_db, before_work = copy.deepcopy(T.db.docs), self.snapshot(work)
        # the dry run: counts only, nothing written
        out = self.restore(T, work, run, bk, dry=True)
        self.assertEqual(out.splitlines()[1:8], counts("  open: %d to decide" % len(cands)), out)
        self.assertIn("dry run: nothing written. %d open question(s) need a decision" % len(cands), out)
        for x in [OLD_SYN, "Ben", "Ana"] + [
            c["synopsis"][0]["t"] for c in full["convs"] if isinstance(c["synopsis"], list) and c["synopsis"]
        ][:20]:
            self.assertNotIn(x, out, "the dry run never prints text")
        self.assertFalse(os.path.exists(os.path.join(run, "out")))
        # without DECISIONS: the open questions to check, and nothing else
        out = self.restore(T, work, run, bk)
        self.assertIn("Nothing written. %d open question(s) to decide" % len(cands), out)
        self.assertEqual(os.listdir(os.path.join(run, "out")), ["restore-open.json"])
        self.assertEqual(self.snapshot(work), before_work, "WORK unchanged")
        self.assertFalse(os.path.exists(os.path.join(work, "prev")))
        self.assertEqual(T.db.docs, before_db, "database unchanged")
        ro = r(os.path.join(run, "out", "restore-open.json"))
        self.assertEqual([q["ask"] for q in ro["questions"]], [o["ask"] for o in cands])
        self.assertEqual(ro["template"], {str(o["ask"]): "open" for o in cands})
        qa = next(q for q in ro["questions"] if q["ask"] == f["oA"]["ask"])
        self.assertEqual(qa["message"]["i"], f["oA"]["ask"])
        self.assertEqual([m["i"] for m in qa["after"]], [i for i in f["mem"][f["oA"]["conv"]] if i > f["oA"]["ask"]])
        self.assertTrue(all(m["b"] == T.msgs[m["i"]]["b"] for m in qa["after"]))
        # the decisions: A's question was answered by the next message in its conversation; the rest stay open
        refs = [f["mem"][f["oA"]["conv"]][1]]
        dec = {str(o["ask"]): "open" for o in cands}
        dec[str(f["oA"]["ask"])] = {"answer": "Ben has one", "refs": refs}
        out = self.restore(T, work, run, bk, dec, dry=True)
        self.assertEqual(
            out.splitlines()[1:8], counts("  open: %d restored, 1 answered (DECISIONS)" % (len(cands) - 1))
        )
        self.assertEqual(self.snapshot(work), before_work)
        out = self.restore(T, work, run, bk, dec)
        self.assertEqual(
            out.splitlines()[1:8], counts("  open: %d restored, 1 answered (DECISIONS)" % (len(cands) - 1))
        )
        self.assertIn("restore ok", out)
        man = T.write(run)  # pinned from the listing; refresh/status (the lock) in the last batch
        self.assertTrue(man["batches"][-1][-1]["pin"] and man["batches"][-1][-1]["doc_id"] == "current")
        self.assertTrue(all(e["collection"] == "summary" for bt in man["batches"] for e in bt), "threading untouched")
        # restored, T is U: the backup plus everything built after it
        t_t, t_s = T.db.merged()
        u_t, u_s = U.db.merged()
        want = copy.deepcopy(u_s)
        for c in want["convs"]:
            if c["id"] in f["dropped"] and c["synopsis"] == OLD_SYN:
                c["synopsis"] = OLD_BULLETS
        self.assertEqual(next(c for c in want["convs"] if c["id"] == f["X"])["synopsis"][:2], OLD_BULLETS)
        want["open"].remove(f["oA"])
        want["open"] = [o for o in want["open"] if o in cands or o not in dropped_open]  # already answered: left out
        want["answered"].insert(
            0, {"conv": f["oA"]["conv"], "ask": f["oA"]["ask"], "answer": "Ben has one", "refs": refs}
        )
        self.assertEqual(without_times(t_s), without_times(want))
        self.assertEqual(without_times(t_t), without_times(u_t))
        self.assertEqual(t_s["fromI"], FROM)
        # no duplicates anywhere, and every document at most half the cap
        self.assertEqual(len({c["id"] for c in t_s["convs"]}), len(t_s["convs"]))
        for k in ("open", "answered", "deals", "mentions"):
            self.assertEqual(len({json.dumps(x, sort_keys=True) for x in t_s[k]}), len(t_s[k]), k)
        sz = T.db.layout_sizes()
        self.assertLessEqual(max(sz.values()), FakeDB.DOC // 2, sz)
        self.assertEqual(t_s, r(os.path.join(work, "base", "summary.json")), "WORK advanced like a build")
        # the verification: a fresh bootstrap reads it back, and a second run restores nothing
        work2, run2, bk2 = self.ready(T, "2")
        self.assertEqual(r(os.path.join(work2, "base", "summary.json")), t_s)
        out = self.restore(T, work2, run2, bk2, dry=True)
        self.assertIn("nothing to restore: 0 restored", out)
        self.assertIn(
            "  open: 0 to decide, %d already present"
            % (len(cands) - 1 + len([o for o in full["open"] if o["conv"] in f["kept"]])),
            out,
        )
        out = self.restore(T, work2, run2, bk2)
        self.assertIn("nothing to restore: 0 restored; nothing written", out)
        self.assertFalse(os.path.exists(os.path.join(run2, "out")))
        # and refreshes carry on: a restored conversation with old string bullets takes a new message
        R = next(c for c in f["dropped"] if c not in (f["X"], f["Y"]) and sc[c]["synopsis"] == OLD_SYN)
        new3 = synth.more(3040, 3, seed=5)
        run3 = T.run(new3)
        self.assertIn(
            "build ok",
            T.build(run3, {"join": {R: [m["i"] for m in new3]}, "bullets": {R: [["More on it", [3040]]]}}, work2),
        )
        T.write(run3)
        syn = next(c for c in T.db.merged()[1]["convs"] if c["id"] == R)["synopsis"]
        self.assertEqual(syn, OLD_BULLETS + [{"t": "More on it", "refs": [3040]}])

    def test_refusals_leave_everything_as_it_was(self):
        T, U, f = self.world()
        work, run, bk = self.ready(T, "1")
        before = self.snapshot(work)
        parts = os.path.join(bk, "backups")
        pa, pb = (os.path.join(parts, "summary-pre-prune-%s.json" % p) for p in "ab")
        a, b = r(pa), r(pb)
        for broken, pattern in (
            ({"b": None}, r"incomplete or mismatched: it has part\(s\) a of 2, and needs a, b"),
            ({"b": dict(b, of=3)}, "disagree on how many parts there are"),
            ({"b": dict(b, savedAt="2026-11-12T02:00:00.000Z")}, "disagree on savedAt: they come from different saves"),
            ({"b": dict(b, part="c")}, "summary-pre-prune-b say\\(s\\) another part than its name"),
            ({"b": dict(b, toI=1)}, "part b holds toI, which only part a may hold"),
        ):
            with self.subTest(pattern=pattern):
                for p, x in (("a", a), ("b", b)):
                    x = broken.get(p, x)
                    path = os.path.join(parts, "summary-pre-prune-%s.json" % p)
                    if x is None:
                        os.remove(path)
                    else:
                        w(path, x)
                with self.assertRaisesRegex(AssertionError, pattern):
                    self.restore(T, work, run, bk, dry=True)
                with self.assertRaisesRegex(AssertionError, pattern):
                    self.restore(T, work, run, bk)
                self.assertFalse(os.path.exists(os.path.join(run, "out")))
                self.assertEqual(self.snapshot(work), before)
        w(pa, a)
        w(pb, b)
        # DECISIONS must cover exactly the questions in restore-open.json
        self.restore(T, work, run, bk)
        asks = [str(q["ask"]) for q in r(os.path.join(run, "out", "restore-open.json"))["questions"]]
        for dec, pattern in (
            ({k: "open" for k in asks[1:]}, "no decision for #%s" % asks[0]),
            (dict({k: "open" for k in asks}, **{"7": "open"}), "names #7, which isn't an open question to restore"),
            (
                dict({k: "open" for k in asks}, **{asks[0]: {"answer": "x", "refs": [int(asks[0]) - 1]}}),
                "after the ask",
            ),
            (dict({k: "open" for k in asks}, **{asks[0]: {"answer": "a\nb", "refs": []}}), "one line"),
        ):
            with self.subTest(dec=pattern), self.assertRaisesRegex(AssertionError, pattern):
                self.restore(T, work, run, bk, dec)
        self.assertEqual(self.snapshot(work), before)
        # another session built after this WORK was bootstrapped: refused before anything is written
        T.db.put("summary/current", dict(T.db.docs["summary/current"], generatedAt="Thu Nov 12, 9:05 AM"))
        run2 = T.listing(os.path.join(self.d, "run-stale"))
        with self.assertRaisesRegex(AssertionError, "summary/current changed since WORK was bootstrapped"):
            self.restore(T, work, run2, bk, {k: "open" for k in asks})
        self.assertFalse(os.path.exists(os.path.join(run2, "out")))

    def test_a_stale_current_is_refused_by_the_pins_and_restore_undoes_it(self):
        T, U, f = self.world()
        work, run, bk = self.ready(T, "1")
        before = self.snapshot(work)
        self.restore(T, work, run, bk)
        asks = r(os.path.join(run, "out", "restore-open.json"))["template"]
        self.assertIn("restore ok", self.restore(T, work, run, bk, asks))
        self.assertNotEqual(self.snapshot(work), before)
        # the page or another session writes summary/current between the listing and the write
        T.db.put("summary/current", dict(T.db.docs["summary/current"], mentionsNote="changed"))
        docs = copy.deepcopy(T.db.docs)
        with self.assertRaisesRegex(Refused, "summary/current changed"):
            T.write(run)
        self.assertEqual(T.db.docs, docs, "a refused batch writes nothing")
        quiet(catchup.restore, work)
        self.assertEqual(self.snapshot(work), before, "restore WORK undoes it")
        self.assertFalse(os.path.exists(os.path.join(work, "prev")))

    def small_world(self, backup, current, fromI=None):
        msgs = [msg(i, "Ana" if i % 2 else "Ben", "m%d" % i, mi=i % 60) for i in range(100)]
        th = {
            "convs": [
                {"id": "a", "title": "A", "members": list(range(50))},
                {"id": "b", "title": "B", "members": list(range(50, 100))},
            ],
            "links": {},
            "to": 99,
            "note": "",
        }
        live = Live(self.d, msgs, th, dict(EMPTY_SM, toI=99, **current), "new")
        for p, x in zip("ab", backup_parts(dict(EMPTY_SM, toI=90, **backup))):
            live.db.put("backups/summary-pre-prune-" + p, x)
        return live

    def test_items_that_dont_fit_threading_are_skipped_and_listed(self):
        conv = lambda cid, syn: {"id": cid, "tag": "Trip", "synopsis": syn, "outcome": "Done", "key": []}
        live = self.small_world(
            {
                "convs": [
                    conv("b", [{"t": "B1", "refs": [60]}]),
                    conv("ghost", "Gone. Long gone."),
                    conv("a", [{"t": "A1", "refs": [3]}, {"t": "A2", "refs": [70]}]),
                ],
                "answered": [
                    {"conv": "ghost", "ask": 5, "answer": "x", "refs": []},
                    {"conv": "a", "ask": 5, "answer": "y", "refs": [6]},
                ],
                "open": [{"conv": "a", "ask": 5, "to": "anyone", "note": "also in answered"}],
                "deals": [{"kind": "sale", "tag": "", "conv": "a", "text": "d", "refs": [55]}],
                "mentions": [{"note": "n", "refs": [[150]]}],
                "fromI": 0,
            },
            {"convs": [conv("b", [{"t": "B1", "refs": [60]}])], "fromI": 50},
        )
        work, run, bk = self.ready(live, "1")
        out = self.restore(live, work, run, bk)
        for line in (
            "  convs: 1 restored, 0 merged, 1 already present, 1 skipped",
            "  bullets: 1 restored, 1 already present, 3 skipped",
            "  open: 0 to decide, 0 already present, 1 already answered, 0 skipped",
            "  answered: 1 restored, 0 already present, 1 skipped",
            "  deals: 0 restored, 0 already present, 1 skipped",
            "  mentions: 0 restored, 0 already present, 1 skipped",
            "  fromI: 50 -> none",
        ):
            self.assertIn(line, out)
        self.assertIn("5 skipped, listed in", out)  # a skipped conversation takes its bullets with it
        sk = r(os.path.join(run, "out", "restore-skipped.json"))
        self.assertEqual(
            sorted((x["kind"], x.get("conv")) for x in sk),
            [("answered", "ghost"), ("bullet", "a"), ("conv", "ghost"), ("deals", "a"), ("mentions", None)],
        )
        self.assertNotIn("Gone", json.dumps(sk), "ids and refs only")
        live.write(run)
        s = live.db.merged()[1]
        self.assertEqual([c["id"] for c in s["convs"]], ["b", "a"])
        self.assertEqual(s["convs"][1]["synopsis"], [{"t": "A1", "refs": [3]}])
        self.assertNotIn("fromI", s, "the summary now covers everything from #0")

    def test_coverage_refusals(self):
        live = self.small_world({"fromI": 10}, {"fromI": 95})
        work, run, bk = self.ready(live, "1")
        with self.assertRaisesRegex(AssertionError, "the backup ends at #90, but the stored summary starts at #95"):
            self.restore(live, work, run, bk, dry=True)
        live = self.small_world({}, {})
        b = live.db.docs["backups/summary-pre-prune-a"]
        live.db.put("backups/summary-pre-prune-a", dict(b, toI=120))
        work, run, bk = self.ready(live, "2")
        with self.assertRaisesRegex(AssertionError, r"ends at #120, past what the stored summary covers \(#99\)"):
            self.restore(live, work, run, bk, dry=True)
        live.db.put("backups/other-a", dict(b, of=1))
        work, run, bk = self.ready(live, "3")
        with self.assertRaisesRegex(
            AssertionError, r"holds several backups \(other, summary-pre-prune\): name one with --backup=NAME"
        ):
            self.restore(live, work, run, bk, dry=True)

    def test_a_build_adds_bullets_to_an_old_string_synopsis(self):
        """B47: a build that gave a conversation with an old string synopsis a bullet crashed (str has no append)."""
        msgs, th, sm = small(20)
        sm["convs"][0]["synopsis"] = OLD_SYN
        live = Live(self.d, msgs, th, sm)
        live.bootstrap()
        run = live.run([msg(20, "Ben", "x", mi=20)])
        self.assertIn("build ok", live.build(run, {"join": {"a": [20]}, "bullets": {"a": [["Ben came back", [20]]]}}))
        live.write(run)
        self.assertEqual(
            live.db.merged()[1]["convs"][0]["synopsis"], OLD_BULLETS + [{"t": "Ben came back", "refs": [20]}]
        )

    def test_old_string_synopses_split_as_the_page_splits_them(self):
        page = read_page()
        fn = re.search(r"^  function synItems\(syn\) \{.*?^  \}$", page, re.M | re.S).group(0)
        cases = [
            OLD_SYN,
            'Is it gone? #3 says yes. ok then. He said "Sold." Then left.',
            "One sentence only",
            "",
            "Prices: $40 (firm). Ships Monday! (Maybe.) “Quote” here.",
            ["a string bullet", {"t": "a bullet", "refs": [3]}],
        ]
        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")
        import subprocess

        js = fn + "\nconsole.log(JSON.stringify(%s.map(synItems)));" % json.dumps(cases)
        got = json.loads(subprocess.run([node, "-e", js], capture_output=True, text=True, check=True).stdout)
        self.assertEqual([catchup._syn_items(c) for c in cases], got)

    def test_cli(self):
        import subprocess

        p = subprocess.run(
            [
                sys.executable,
                os.path.join(ROOT, "plugin", "skills", "refresh", "scripts", "catchup.py"),
                "restore-summary",
                "w",
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(p.returncode, 1)
        self.assertIn("catchup.py restore-summary WORK RUNDIR BACKUPDIR [DECISIONS] [--dry-run]", p.stderr)


TRADE = "Pack buy/sell/trade"


def react_lines(out):
    return [x for x in out.splitlines() if x.startswith(("REACT?", "CLOSE?"))]


class TestClaims(unittest.TestCase):
    """F19 (issue #41): in a buy/sell chat the build flags short claims (REACT?) with the posts they may react to, and
    the seller's own "Sold"/"SPF" (CLOSE?). Claude decides; deals record claims and a sold or pending status."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.e = Env(self.t.name)

    def tearDown(self):
        self.t.cleanup()

    def test_claim_words(self):
        for text, n in (
            ("In", 1),
            ("in", 1),
            ("IN!!", 1),
            ("In!! 🙋‍♀️", 1),
            ("  I'm in ", 1),
            ("I’m in", 1),
            ("Im in", 1),
            ("I am in.", 1),
            ("in for 2", 2),
            ("In for two!", 2),
            ("I'm in for 3", 3),
            ("Dibs", 1),
            ("Mine!", 1),
            ("I'll take it", 1),
            ("Ill take it!", 1),
            ("Sold", 1),
            ("SOLD!", 1),
            ("PM'd", 1),
            ("PMd", 1),
            ("pm sent", 1),
            ("DM sent", 1),
            ("DMed", 1),
            ("DM'd", 1),
            ("Interested", 1),
            ("interested!!", 1),
        ):
            self.assertEqual(catchup.claim_word(text), n, text)
        for text in (
            "Insane",
            "in the car",
            "#7",
            "#7 please",
            "in for 2 spots",
            "In for 2 spots please",
            "Inn",
            "within",
            "interested in the blue one",
            "Mine is the same",
            "sold out everywhere",
            "in for 0",
            "",
            None,
        ):
            self.assertIsNone(catchup.claim_word(text), text)
        self.assertEqual(
            [catchup.close_word(x) for x in ("Sold", "SPF", "spf!", "Pending", "sale pending", "In", "pending?? lol")],
            ["sold", "pending", "pending", "pending", "pending", None, None],
        )

    def test_topic_gate(self):
        for topic in ("Pack buy/sell/trade", "BST for packs", "WTS / WTB", "Gear swap", "Paffles and sales", "Selling"):
            self.assertTrue(catchup.trade_topic(topic), topic)
        for topic in ("Hiking friends", "Trail chat", "", None, "Insiders"):
            self.assertFalse(catchup.trade_topic(topic), topic)

    def test_offer_heuristics(self):
        offer = lambda b, **kw: catchup.looks_like_offer(dict({"b": b}, **kw))
        for b in (
            "WTS blue pack",
            "FS: 30L pack",
            "Selling my old tent",
            "Let me know if you're interested in this one",
            "let me know if anyone's interested",
            "Raffle for the green bag, 10 spots",
            "Group buy is open",
            "$120 shipped",
            "120 shipped",
            "asking $80",
            "Price drop on the quilt",
        ):
            self.assertTrue(offer(b), b)
        self.assertTrue(offer("$95", p="1"), "a photo with a price")
        for b in ("Anyone selling a 30L pack?", "WTB a stove", "ISO a quilt, $100 budget", "nice bag", "lol", ""):
            self.assertFalse(offer(b), b)

    def history(self):
        """Built history across five days; the claims come on Nov 6 around 9:10."""
        return [
            msg(0, "Ana", "WTS blue pack $120 shipped", p="1", d="2026-11-01"),  # an offer, 5 days back: too old
            msg(1, "Dee", "", p="2", d="2026-11-03", h=9, mi=0),  # a photo 3 days and 10 minutes back: too old
            msg(2, "Dee", "my new bag", p="3", d="2026-11-03", h=10, mi=0),  # a photo post, inside 3 days
            msg(3, "Cy", "Group buy for the quilts is open", d="2026-11-04"),  # an offer
            msg(4, "Ana", "Let me know if you're interested in this one", d="2026-11-05"),  # an offer
            msg(5, "Cy", "Anyone selling a 30L?", d="2026-11-05"),  # a request
            msg(6, "Ana", "In", d="2026-11-05"),  # a claim, never a post
            msg(7, "Dee", "$80 shipped", p="4", h=9, mi=0),  # photo with a price
            msg(8, "Ben", "", p="5", h=9, mi=1),  # Ben's own photo
            msg(9, "Cy", "nice weather", h=9, mi=2),
        ]

    def seed_history(self, deals=()):
        hist = self.history()
        ids = [m["i"] for m in hist]
        th = {"convs": [{"id": "a", "title": "A", "members": ids}], "links": {}, "to": ids[-1], "note": ""}
        sm = dict(EMPTY_SM, convs=[{"id": "a", "tag": "", "synopsis": [], "outcome": "", "key": []}], toI=ids[-1])
        sm["deals"] = list(deals)
        self.e.seed(hist, th, sm)

    def test_window_ranking_and_who(self):
        self.seed_history()
        new = [
            msg(10, "Ben", "In!!", h=9, mi=10),
            msg(11, "Dee", "in for 2", h=9, mi=11),
            msg(12, "Cy", "Insane", mi=12),
        ]
        out = self.e.build(self.e.run(new, topic=TRADE), {"join": {"a": [10, 11, 12]}})
        self.assertEqual(
            react_lines(out),
            [
                'REACT? 10 (Ben: "In!!") -> 7, 4, 3',  # newest first, three at most; not Ben's own photo
                'REACT? 11 (Dee: "in for 2") -> 8, 4, 3',  # not Dee's own posts; claims are never posts
            ],
        )
        links = r(os.path.join(self.e.work, "base", "threading.json"))["links"]
        self.assertEqual(links["10"], [9, "i"], "the line informs; the build's guess stands")

    def test_other_chats_get_no_change(self):
        new = [msg(10, "Ben", "In!!", h=9, mi=10)]
        for topic in (None, "Hiking friends"):
            with self.subTest(topic=topic):
                self.e = Env(tempfile.mkdtemp(dir=self.t.name))
                self.seed_history()
                out = self.e.build(self.e.run([dict(m) for m in new], topic=topic), {"join": {"a": [10]}})
                self.assertEqual(react_lines(out), [])
                self.assertIn("GUESS 10 -> 9 i", out)

    def test_open_deals_none_in_window_and_the_sellers_close(self):
        deal = lambda refs, **kw: dict(
            {"kind": "sale", "tag": "For sale", "conv": "a", "text": "x", "refs": refs}, **kw
        )
        hist = [
            msg(0, "Ana", "details in the post above", h=8, mi=0),  # in an open deal
            msg(1, "Cy", "and this one", h=8, mi=1),  # only in a sold deal
            msg(2, "Cy", "hi", h=8, mi=2),
        ]
        th = {"convs": [{"id": "a", "title": "A", "members": [0, 1, 2]}], "links": {}, "to": 2, "note": ""}
        sm = dict(EMPTY_SM, convs=[{"id": "a", "tag": "", "synopsis": [], "outcome": "", "key": []}], toI=2)
        sm["deals"] = [deal([0]), deal([1], status="sold", statusAt=2)]
        self.e.seed(hist, th, sm)
        new = [
            msg(3, "Ben", "dibs", h=9, mi=0),
            msg(4, "Ana", "SPF", h=9, mi=1),  # the seller: closes it
            msg(5, "Cy", "Sold", h=9, mi=2),  # someone else: a claim
            msg(6, "Ana", "Sold!", h=9, mi=3),  # the seller's "Sold": both readings are offered
            msg(7, "Dee", "Interested", d="2026-11-12"),  # nothing within 3 days
        ]
        out = self.e.build(self.e.run(new, topic=TRADE), {"join": {"a": [3, 4, 5, 6, 7]}})
        self.assertEqual(
            react_lines(out),
            [
                'REACT? 3 (Ben: "dibs") -> 0',
                'CLOSE? 4 (Ana: "SPF") -> own 0',
                'REACT? 5 (Cy: "Sold") -> 0',
                'REACT? 6 (Ana: "Sold!") -> none within 3 days | own posts 0: the seller closing?',
                'REACT? 7 (Dee: "Interested") -> none within 3 days',
            ],
        )

    def test_messenger_reply_is_named(self):
        self.seed_history()
        out = self.e.build(self.e.run([msg(10, "Ben", "In", pi=2, h=9, mi=10)], topic=TRADE), {"join": {"a": [10]}})
        self.assertEqual(react_lines(out), ['REACT? 10 (Ben: "In") -> 7, 4, 3 (Messenger reply to 2)'])

    def claims_env(self):
        hist = [msg(0, "Ana", "WTS pack $90", p="1"), msg(1, "Ben", "hi")]
        th = {"convs": [{"id": "a", "title": "A", "members": [0, 1]}], "links": {}, "to": 1, "note": ""}
        sm = dict(EMPTY_SM, convs=[{"id": "a", "tag": "", "synopsis": [], "outcome": "", "key": []}], toI=1)
        sm["deals"] = [{"kind": "sale", "tag": "For sale", "conv": "a", "text": "Pack $90", "refs": [0]}]
        self.e.seed(hist, th, sm)
        return [msg(2, "Cy", "In"), msg(3, "Ben", "in for 2"), msg(4, "Ana", "Sold")]

    def test_claims_and_status_are_stored(self):
        new = self.claims_env()
        out = self.e.build(
            self.e.run(new, topic=TRADE),
            {
                "join": {"a": [2, 3, 4]},
                "links": {"2": [0, "i"], "3": [0, "i"], "4": [0, "c"]},
                "dealEdit": {
                    "a": {
                        "addClaims": [{"i": 3, "who": "Ben", "n": 2}, {"i": 2, "who": "Cy"}],
                        "status": "sold",
                        "statusAt": 4,
                    }
                },
            },
        )
        self.assertIn("build ok", out)
        d = r(os.path.join(self.e.work, "base", "summary.json"))["deals"][0]
        self.assertEqual(d["claims"], [{"i": 2, "who": "Cy", "n": 1}, {"i": 3, "who": "Ben", "n": 2}])
        self.assertEqual((d["status"], d["statusAt"]), ("sold", 4))
        # a later build: one more claim after it sold, then reopened
        run = self.e.run([msg(5, "Dee", "Mine")], topic=TRADE)
        self.e.build(
            run, {"join": {"a": [5]}, "dealEdit": {"a": {"addClaims": [{"i": 5, "who": "Dee"}], "status": None}}}
        )
        d = r(os.path.join(run, "out", "merged", "summary.json"))["deals"][0]
        self.assertEqual([c["i"] for c in d["claims"]], [2, 3, 5])
        self.assertNotIn("status", d)
        self.assertNotIn("statusAt", d)

    def test_a_new_deal_with_claims(self):
        new = self.claims_env()
        spec = {
            "join": {"a": [2, 3, 4]},
            "deals": [
                {
                    "kind": "sale",
                    "tag": "For sale",
                    "conv": "a",
                    "text": "Second pack",
                    "refs": [2],
                    "claims": [{"i": 4, "who": "Ana", "n": 1}, {"i": 3, "who": "Ben", "n": 2}],
                }
            ],
        }
        self.e.build(self.e.run(new, topic=TRADE), spec)
        d = r(os.path.join(self.e.work, "base", "summary.json"))["deals"][1]
        self.assertEqual([c["i"] for c in d["claims"]], [3, 4], "ordered by message")

    def test_claims_validation(self):
        new = self.claims_env()
        run = self.e.run(new, topic=TRADE)
        base = {"join": {"a": [2, 3, 4]}}
        for edit, why in (
            ({"addClaims": [{"i": 99, "who": "Cy"}]}, "claim i must be a stored message"),
            ({"addClaims": [{"i": "2", "who": "Cy"}]}, "claim i must be a stored message"),
            ({"addClaims": [{"i": 2, "who": "Ben"}]}, "claim who must be the name stored on message #2"),
            ({"addClaims": [{"i": 2, "who": "Cy", "n": 0}]}, "claim n must be a positive whole number"),
            ({"addClaims": [{"i": 2, "who": "Cy", "n": -1}]}, "claim n must be a positive whole number"),
            ({"addClaims": [{"i": 2, "who": "Cy", "n": 1.5}]}, "claim n must be a positive whole number"),
            ({"addClaims": [{"i": 2, "who": "Cy", "n": True}]}, "claim n must be a positive whole number"),
            ({"addClaims": [{"i": 2, "who": "Cy"}, {"i": 2, "who": "Cy", "n": 2}]}, "claims a deal only once"),
            ({"addClaims": [{"i": 2, "who": "Cy", "x": 1}]}, r"a claim is \{i, who, n\}"),
            ({"status": "gone"}, "deal status is sold or pending"),
            ({"status": "sold", "statusAt": 99}, "deal statusAt must be a stored message"),
            ({"claims": []}, "dealEdit takes text, addRefs, index, addClaims, status and statusAt"),
        ):
            with self.subTest(edit=edit):
                p = os.path.join(self.t.name, "bad.json")
                w(p, dict(base, dealEdit={"a": edit}))
                with self.assertRaisesRegex(AssertionError, why):
                    quiet(catchup.build, self.e.work, run, p)
        # a claim added twice across builds is refused too
        self.e.build(run, dict(base, dealEdit={"a": {"addClaims": [{"i": 2, "who": "Cy"}]}}))
        run2 = self.e.run([msg(5, "Dee", "hi")], topic=TRADE)
        p = os.path.join(self.t.name, "bad.json")
        w(p, {"join": {"a": [5]}, "dealEdit": {"a": {"addClaims": [{"i": 2, "who": "Cy"}]}}})
        with self.assertRaisesRegex(AssertionError, "claims a deal only once"):
            quiet(catchup.build, self.e.work, run2, p)
        w(p, {"join": {"a": [5]}, "deals": [{"kind": "sale", "conv": "a", "text": "x", "refs": [5], "claims": {}}]})
        with self.assertRaisesRegex(AssertionError, "deal claims must be a list"):
            quiet(catchup.build, self.e.work, run2, p)


# F20: a chat where two claims were misfiled: Dee's "In" in a conversation of its own, Ben's in the hiking talk.
MOVE_MSGS = [
    msg(0, "Ana", "WTS blue pack $120", p="1"),
    msg(1, "Ben", "nice"),
    msg(2, "Cy", "what size?"),
    msg(3, "Ana", "30L", r="Cy", q="what size?", pi=2),
    msg(4, "Dee", "In"),
    msg(5, "Ana", "ok Dee", r="Dee", q="In", pi=4),
    msg(6, "Cy", "anyone hiking sat?"),
    msg(7, "Ben", "me"),
    msg(8, "Ben", "In"),
    msg(9, "Cy", "Ben? for the pack?", r="Ben", q="In", pi=8),
    msg(10, "Dee", "sat works"),
]
MOVE_SPEC = {
    "newconvs": [
        {"id": "sale", "title": "Blue pack", "tag": "For sale", "outcome": "Ana selling", "key": [0, 3]},
        {"id": "dee", "title": "Dee in", "tag": "Claim", "outcome": "Dee is in", "key": [4, 5]},
        {"id": "hike", "title": "Saturday hike", "tag": "Trip", "outcome": "", "key": [6, 8]},
    ],
    "join": {"sale": [0, 1, 2, 3], "dee": [4, 5], "hike": [6, 7, 8, 9, 10]},
    "links": {"1": [0, "i"], "2": [0, "i"], "4": None, "6": None, "7": [6, "i"], "8": [7, "i"], "10": [6, "i"]},
    "bullets": {
        "sale": [["Ana sells a blue pack for $120", [0]], ["It's 30L", [2, 3]]],
        "dee": [["Dee is in", [4]]],
        "hike": [["Cy asked about Saturday", [6, 7]], ["Ben said in", [8, 9]], ["Ben is going, then in", [7, 8]]],
    },
    "deals": [{"kind": "sale", "tag": "For sale", "conv": "sale", "text": "Blue pack $120", "refs": [0]}],
    "open": [{"conv": "dee", "ask": 4, "to": "anyone", "note": ""}],
    "answered": [
        {"conv": "hike", "ask": 6, "answer": "Ben and Dee", "refs": [7, 10]},
        {"conv": "hike", "ask": 8, "answer": "For the pack", "refs": [9]},
    ],
}


class TestMove(unittest.TestCase):
    """F20: `move` puts a built message, and what's threaded under it, into another conversation; summary items follow,
    and a conversation left empty is dropped. In a build spec, or on its own through `catchup.py relink`."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.e = Env(self.t.name)
        self.e.seed()
        self.e.build(self.e.run([dict(m) for m in MOVE_MSGS]), MOVE_SPEC)

    def tearDown(self):
        self.t.cleanup()

    def move(self, spec):
        """On its own, as writing-the-build.md has it: `list threading` and `list summary` into a fresh RUN."""
        p = os.path.join(self.t.name, "move.json")
        w(p, spec)
        run = os.path.join(self.t.name, "mrun")
        shutil.rmtree(run, ignore_errors=True)
        self.e.listing(run)
        out = quiet(catchup.relink, self.e.work, run, p)
        d = os.path.join(run, "out")
        return out, r(os.path.join(d, "merged", "threading.json")), r(os.path.join(d, "merged", "summary.json")), d

    def base(self):
        return [r(os.path.join(self.e.work, "base", f + ".json")) for f in ("threading", "summary")]

    def test_into_an_existing_conversation_dropping_the_empty_one(self):
        before = self.base()
        out, t, s, d = self.move({"move": {"4": "sale"}, "relink": {"4": [0, "i"]}})
        self.assertIn("RELINK 4 -> 0 i", out)
        self.assertNotIn("crosses conversations", out)
        self.assertIn("MOVE 4 (with 5) dee -> sale", out)
        self.assertIn('DROP dee ("Dee in"): no messages left; its summary went to sale', out)
        self.assertIn("moved to sale from dee: 1 bullet, 2 key, 1 open", out)
        self.assertIn("relink ok: 1 change(s), 1 move(s), dropped dee", out)
        mem = {c["id"]: c["members"] for c in t["convs"]}
        self.assertEqual(mem, {"sale": [0, 1, 2, 3, 4, 5], "hike": [6, 7, 8, 9, 10]})
        sc = {c["id"]: c for c in s["convs"]}
        self.assertNotIn("dee", sc)
        self.assertEqual(
            [b["t"] for b in sc["sale"]["synopsis"]], ["Ana sells a blue pack for $120", "It's 30L", "Dee is in"]
        )
        self.assertEqual(sc["sale"]["key"], [0, 3, 4, 5])
        self.assertEqual(
            (sc["sale"]["tag"], sc["sale"]["outcome"]), ("For sale", "Ana selling"), "the target's own stay"
        )
        self.assertEqual([(o["conv"], o["ask"]) for o in s["open"]], [("sale", 4)])
        self.assertEqual(t["links"]["4"], [0, "i"])
        # WORK follows, through the manifest, and restore undoes it
        self.assertEqual(self.base(), [t, s])
        man = r(os.path.join(d, "manifest.json"))
        self.assertEqual(
            sorted(e["collection"] for e in man["batches"][-1] if e["doc_id"] == "current"), ["summary", "threading"]
        )
        quiet(catchup.restore, self.e.work)
        self.assertEqual(self.base(), before)

    def test_the_rest_stays_and_loses_only_the_moved_refs(self):
        out, t, s, _ = self.move({"move": {"8": "sale"}, "relink": {"8": [0, "i"]}})
        self.assertIn("MOVE 8 (with 9) hike -> sale", out)
        self.assertNotIn("DROP", out)
        self.assertIn("moved to sale from hike: 1 answered, 1 bullet, 1 key", out)
        self.assertIn("refs 8 dropped from hike: 1 bullet", out)
        mem = {c["id"]: c["members"] for c in t["convs"]}
        self.assertEqual((mem["sale"], mem["hike"]), ([0, 1, 2, 3, 8, 9], [6, 7, 10]))
        sc = {c["id"]: c for c in s["convs"]}
        self.assertEqual(
            [(b["t"], b["refs"]) for b in sc["sale"]["synopsis"]],
            [("Ana sells a blue pack for $120", [0]), ("It's 30L", [2, 3]), ("Ben said in", [8, 9])],
        )
        self.assertEqual(
            [(b["t"], b["refs"]) for b in sc["hike"]["synopsis"]],
            [("Cy asked about Saturday", [6, 7]), ("Ben is going, then in", [7])],
        )
        self.assertEqual((sc["hike"]["key"], sc["sale"]["key"]), ([6], [0, 3, 8]))
        self.assertEqual(sorted((a["conv"], a["ask"]) for a in s["answered"]), [("hike", 6), ("sale", 8)])
        self.assertEqual([c["id"] for c in s["convs"]], ["hike", "sale", "dee"], "newest activity first")

    def test_into_new(self):
        out, t, s, _ = self.move({"move": {"8": "new"}, "relink": {"8": None}})
        self.assertIn('NEW conversation mv8 "In"', out)
        self.assertIn("MOVE 8 (with 9) hike -> mv8", out)
        mem = {c["id"]: c["members"] for c in t["convs"]}
        self.assertEqual((mem["mv8"], mem["hike"]), ([8, 9], [6, 7, 10]))
        self.assertNotIn("8", t["links"])
        sc = {c["id"]: c for c in s["convs"]}
        self.assertEqual([b["t"] for b in sc["mv8"]["synopsis"]], ["Ben said in"])

    def test_into_a_new_conversation_with_its_title_and_tag(self):
        spec = {
            "newconvs": [{"id": "benin1106", "title": "Ben's claim", "tag": "Claim", "outcome": "Ben is in"}],
            "move": {"8": "benin1106"},
            "relink": {"8": None},
        }
        out, t, s, _ = self.move(spec)
        self.assertIn("MOVE 8 (with 9) hike -> benin1106", out)
        c = next(c for c in t["convs"] if c["id"] == "benin1106")
        self.assertEqual((c["title"], c["members"]), ("Ben's claim", [8, 9]))
        sc = next(c for c in s["convs"] if c["id"] == "benin1106")
        self.assertEqual((sc["tag"], sc["outcome"]), ("Claim", "Ben is in"))

    def test_in_a_build_spec_with_new_messages_and_a_claim(self):
        run = self.e.run([msg(11, "Ana", "sold to Dee"), msg(12, "Ben", "Mine")], topic=TRADE)
        spec = {
            "move": {"4": "sale"},
            "join": {"sale": [11, 12]},
            "links": {"11": [4, "i"], "12": [0, "i"]},
            "dealEdit": {
                "sale": {
                    "addClaims": [{"i": 12, "who": "Ben"}, {"i": 4, "who": "Dee"}],
                    "status": "sold",
                    "statusAt": 11,
                }
            },
            "bullets": {"sale": [["Dee is in, then it sold", [4, 11]]]},
        }
        out = self.e.build(run, spec)
        self.assertIn("MOVE 4 (with 5) dee -> sale", out)
        self.assertNotIn("WARN", out)
        self.assertIn('REACT? 12 (Ben: "Mine") -> 0', out)  # the open deal's post; Dee's In is no post
        s = r(os.path.join(run, "out", "merged", "summary.json"))
        self.assertEqual([c["i"] for c in s["deals"][0]["claims"]], [4, 12])
        self.assertNotIn("dee", {c["id"] for c in s["convs"]})

    def test_refusals_leave_work_as_it_was(self):
        before = self.base()
        for spec, why in (
            ({"move": {"99": "sale"}}, r"move #99: only messages already built \(through #10\)"),
            ({"move": {"4": "nope"}}, 'move #4: no conversation "nope"'),
            ({"move": {"4": "dee"}}, "move #4: it's already in dee"),
            ({"move": {"8": "sale"}}, r"move #8: its link points to #7 in hike, not in sale. Add a relink for #8"),
            ({"move": {"8": "sale", "9": "dee"}, "relink": {"8": None}}, "move #9: it already moves with #8"),
            ({"newconvs": [{"id": "x", "title": "X"}], "relink": {"4": None}}, "newconvs only for a move"),
            ({"move": {}}, 'takes only a non-empty "relink"'),
        ):
            with self.subTest(spec=spec):
                with self.assertRaisesRegex(AssertionError, why):
                    self.move(spec)
                self.assertEqual(self.base(), before, "WORK untouched")
        # a message not built yet can't move: it joins
        run = self.e.run([msg(11, "Ana", "hi")])
        p = os.path.join(self.t.name, "spec.json")
        w(p, {"join": {"sale": [11]}, "move": {"11": "hike"}})
        with self.assertRaisesRegex(AssertionError, r"move #11: only messages already built \(through #10\); use join"):
            quiet(catchup.build, self.e.work, run, p)

    def test_across_block_documents_through_the_database(self):
        """Layout 2 at scale: a conversation emptied by moves is dropped and its summary goes along; the documents land
        through the manifest, a fresh bootstrap reads back exactly WORK, and restore undoes the move."""
        msgs, th, sm = synth.chat(3500, seed=17)
        live = Live(self.t.name + "/live", msgs, th, sm, "new")
        live.bootstrap()
        t0, s0 = live.db.merged()
        where = {i: c["id"] for c in t0["convs"] for i in c["members"]}
        S0 = {c["id"]: c for c in s0["convs"]}
        # a conversation with a few messages and bullets in an older block, moved into a busy recent one
        src = next(
            c
            for c in t0["convs"]
            if 1000 <= c["members"][0] < 2000 and len(c["members"]) >= 3 and S0[c["id"]]["synopsis"]
        )
        dst = max((c for c in t0["convs"] if c["id"] != src["id"]), key=lambda c: max(c["members"]))
        mem = set(src["members"])
        roots = [i for i in src["members"] if t0["links"].get(str(i), [None])[0] not in mem]
        spec = {
            "move": {str(i): dst["id"] for i in roots},
            "relink": {str(i): None for i in roots if str(i) in t0["links"]},
        }
        p = os.path.join(self.t.name, "move.json")
        w(p, spec)
        rrun = live.listing(os.path.join(self.t.name, "rrun"))
        out = quiet(catchup.relink, live.work, rrun, p)
        self.assertIn("DROP %s" % src["id"], out)
        self.assertIn("dropped %s" % src["id"], out)
        write_manifest(live.db, os.path.join(rrun, "out"), live.seen)
        t, s = live.db.merged()
        T = {c["id"]: c for c in t["convs"]}
        self.assertNotIn(src["id"], T)
        self.assertEqual(T[dst["id"]]["members"], sorted(dst["members"] + src["members"]))
        self.assertNotIn(src["id"], {c["id"] for c in s["convs"]})
        moved = next(c for c in s["convs"] if c["id"] == dst["id"])
        for b in S0[src["id"]]["synopsis"]:
            self.assertIn(b, moved["synopsis"])
        for name in ("open", "answered", "deals"):
            self.assertFalse([x for x in s[name] if x["conv"] == src["id"]], name)
            self.assertEqual(len(s[name]), len(s0[name]), "nothing dropped: " + name)
        self.assertEqual(sum(len(c["synopsis"]) for c in s["convs"]), sum(len(c["synopsis"]) for c in s0["convs"]))
        self.assertEqual(sorted(where), sorted(i for c in t["convs"] for i in c["members"]), "every message kept")
        self.assertEqual(t, r(os.path.join(live.work, "base", "threading.json")))
        self.assertEqual(s, r(os.path.join(live.work, "base", "summary.json")))
        live.bootstrap(os.path.join(self.t.name, "work2"))
        for f in ("base/threading.json", "base/summary.json"):
            self.assertEqual(r(os.path.join(self.t.name, "work2", f)), r(os.path.join(live.work, f)), f)
        # undo: restore WORK, and the previous documents are still what the database's old blocks held
        quiet(catchup.restore, live.work)
        self.assertEqual(without_times(r(os.path.join(live.work, "base", "threading.json"))), without_times(t0))
        self.assertEqual(without_times(r(os.path.join(live.work, "base", "summary.json"))), without_times(s0))


def read_page():
    with open(os.path.join(ROOT, "plugin", "skills", "refresh", "assets", "page.html"), encoding="utf-8") as fh:
        return fh.read()


class TestCli(unittest.TestCase):
    def test_usage_on_unknown_command(self):
        import subprocess

        p = subprocess.run(
            [sys.executable, os.path.join(ROOT, "plugin", "skills", "refresh", "scripts", "catchup.py"), "nope"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(p.returncode, 1)
        self.assertIn("catchup.py bootstrap WORK DBDIR", p.stderr)


if __name__ == "__main__":
    unittest.main()
