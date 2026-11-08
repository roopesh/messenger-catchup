#!/usr/bin/env python3
"""Messenger Catch-up build tool (generic).
  catchup.py bootstrap WORK DBDIR    DBDIR = ArtifactData out_dir holding chunks/*.json, threading/current.json,
                                     summary/current.json, meta/chat.json. Writes WORK/all.json, WORK/base/*, WORK/state.json.
  catchup.py build WORK RUNDIR SPEC  RUNDIR = out_dir with the touched chunks/*.json + meta/chat.json fetched after import.
                                     Writes RUNDIR/out/{threading,summary}.json, then advances WORK (all.json, base, state),
                                     keeping the previous WORK in WORK/prev.
  catchup.py restore WORK            Undo the last build or relink (WORK back to WORK/prev): after a refused DB write, or to
                                     rebuild the same RUN with a corrected spec.
  catchup.py relink WORK OUTDIR SPEC Correct links on messages already built, when there's nothing new to build. SPEC holds
                                     only "relink". Writes OUTDIR/threading.json (write it to threading/current, pinned),
                                     then advances WORK's threading, keeping the previous WORK in WORK/prev.
SPEC (JSON): {"join":{"convid":[i,...]}, "links":{"i":[parent,"r|rq|rg|i|c"] or null for no link},
  "newconvs":[{"id","title","tag","outcome","key":[...]}], "bullets":{"convid":[["text",[refs]],...]},
  "outcome":{"convid":"..."}, "key":{"convid":[...]}, "deals":[{kind,tag,conv,text,links?,refs}],
  "dealEdit":{"convid":{"text":"...","addRefs":[...],"index":n}} (index only when the conv has several deals), "open":[{conv,ask,to,note}], "closeOpen":[ask,...],
  "answered":[{conv,ask,answer,refs}], "mentions":[{"note","refs":[[i],...]}],
  "relink":{"i":[parent,type] or null}} (relink: messages an earlier build threaded; null removes the link)
Link defaults per new message: Messenger reply link (pi / pmid) -> 'r' ('rq' if matched by quote in-browser);
else quote match against stored history (same author + first 20 chars, latest wins) -> 'rq';
reply to a photo with no Messenger link -> latest photo by that author, 'rg' + a CHECK warning;
a reply whose parent can't be found -> no link (WARN);
else 'c' if same author as the previous member of its conversation, otherwise 'i' to that member (printed as GUESS
for review; none if that member is over 3 h older -> ROOT). Override any GUESS in "links" and rebuild.
A link whose parent sits in another conversation prints a WARN (the page would show it as a new thread)."""

import json, sys, re, os, glob, collections, shutil, datetime


def _n(s):
    s = re.sub("[\U0001f000-\U0001faff\u2600-\u27bf\ufe0f\u200d]", "", s or "")  # Messenger drops emoji from quotes
    s = re.sub(r"\s+", " ", s).strip().rstrip("…").strip().lower()
    return re.sub(r'^[^\w@$#("\']+', "", s)


def _who_ok(m, p):
    r = m.get("r") or ""
    if r.lower() == "you":
        return p["f"] == "You"
    if r.lower() in ("themself", "themselves", "himself", "herself", "yourself"):
        return p["f"] == m["f"]
    return p["f"] == r or r.startswith(p["f"]) or p["f"].startswith(r)


def resolve(m, pool, window=300, n=20, short=12):
    """Parent of a reply from its quote -> (i, type, doubt). doubt is None when the match is solid, else why to CHECK it."""
    if not m.get("r"):
        return None, None, None
    cand = [p for p in pool if m["i"] - window <= p["i"] < m["i"] and _who_ok(m, p)]
    q = _n(m.get("q"))
    latest = lambda c: max(c, key=lambda p: p["i"])["i"]
    if q in ("", "attachment", "photo", "gif", "video", "sticker"):
        c = [p for p in cand if p.get("p") or p.get("a") or not p.get("b")]
        return (latest(c), "rg", None) if c else (None, None, None)
    if len(q) < short:  # "ok", "Yes": only the same whole text counts, and it's still worth a look
        c = [p for p in cand if _n(p.get("b")) == q]
        return (latest(c), "rq", "short quote, same text") if c else (None, None, None)
    key = q[:n]
    c = [p for p in cand if _n(p.get("b")).startswith(key)]
    if c:
        return latest(c), "rq", None
    c = [p for p in cand if key in _n(p.get("b"))]
    return (latest(c), "rq", "quote found inside the text, not at its start") if c else (None, None, None)


def _min(m):  # date from d, time by regex from t, so any Messenger label form (old dates) parses
    d = datetime.date.fromisoformat(m["d"])
    x = re.search(r"(\d{1,2}):(\d{2})\s*([AP]M)", m.get("t") or "", re.I)
    if not x:
        return d.toordinal() * 1440
    return (
        d.toordinal() * 1440 + (int(x.group(1)) % 12 + (12 if x.group(3).upper() == "PM" else 0)) * 60 + int(x.group(2))
    )


def _short(m):
    return (
        (m.get("b") or "").replace("\n", " ")[:60]
        + (" [photo]" if m.get("p") else "")
        + (" [link]" if m.get("a") else "")
    ) or "[media]"


def _load(p):
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def _dump(o, p):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(o, fh, ensure_ascii=False)


TZ = "America/Los_Angeles"


def _ts():  # "Fri Nov 6, 8:41 PM" in the chat's time zone
    try:
        import zoneinfo

        d = datetime.datetime.now(zoneinfo.ZoneInfo(TZ))
    except Exception:  # no tz database here: fall back to the system clock's zone
        d = datetime.datetime.now().astimezone()
    return "%s %d, %d:%02d %s" % (
        d.strftime("%a %b"),
        d.day,
        (d.hour % 12) or 12,
        d.minute,
        "AM" if d.hour < 12 else "PM",
    )


LINK_TYPES = ("r", "rq", "rg", "i", "c")
NOTE_RE = r"^\d+ reply links.*?\(replies to photos\) by best match"

WFILES = ("all.json", "base/threading.json", "base/summary.json", "state.json")


def _note(t):  # the Messages tab's line on where reply links came from
    cn = collections.Counter(v[1] for v in t["links"].values())
    note = (
        "%d reply links read straight from Messenger; %d matched by their quoted text and %d (replies to photos) by best match"
        % (cn["r"], cn["rq"], cn["rg"])
    )
    old = t.get("note") or ""
    t["note"] = re.sub(NOTE_RE, note, old) if re.match(NOTE_RE, old) else note + (". " + old if old else "")


def _relink(t, sp, stored, base):  # correct the link on messages an earlier build already threaded
    conv = lambda i: next((c["id"] for c in t["convs"] if i in c["members"]), None)
    for k, L in sp.get("relink", {}).items():
        i = int(k)
        assert i <= base and i in stored, (
            "relink #%d: only messages already built (through #%d); use links for new ones"
            % (
                i,
                base,
            )
        )
        if L is None:
            if t["links"].pop(str(i), None) is not None:
                print("UNLINK", i)
            continue
        assert len(L) == 2 and L[1] in LINK_TYPES, ("link type must be one of %s" % "/".join(LINK_TYPES), i, L)
        assert L[0] in stored and L[0] < i, ("relink parent must be an earlier stored message", i, L)
        t["links"][str(i)] = L
        print("RELINK %d -> %d %s" % (i, L[0], L[1]))
        if conv(i) and conv(L[0]) and conv(i) != conv(L[0]):
            print(
                "WARN link %d -> %d crosses conversations (%s -> %s); the page shows %d as a new thread"
                % (i, L[0], conv(i), conv(L[0]), i)
            )


def relink(work, out, specp):
    global TZ
    sp = _load(specp)
    assert (
        set(sp) == {"relink"} and sp["relink"]
    ), 'relink SPEC takes only a non-empty "relink" (use build for the rest)'
    st = _load(work + "/state.json")
    TZ = st.get("tz") or TZ
    t = _load(work + "/base/threading.json")
    _relink(t, sp, {m["i"]: m for m in _load(work + "/all.json")}, st["base"])
    _note(t)
    t["builtAt"] = _ts()
    _dump(t, out + "/threading.json")
    _snapshot(work)
    _dump(t, work + "/base/threading.json")
    print("relink ok: %d change(s); write %s/threading.json to threading/current (pinned)" % (len(sp["relink"]), out))


def _snapshot(work):  # the WORK a build started from, so `restore` can undo it
    shutil.rmtree(work + "/prev", ignore_errors=True)
    for f in WFILES:
        os.makedirs(os.path.dirname(work + "/prev/" + f), exist_ok=True)
        shutil.copy2(work + "/" + f, work + "/prev/" + f)


def restore(work):
    assert os.path.exists(
        work + "/prev/state.json"
    ), "nothing to restore: no build since bootstrap, or already restored"
    for f in WFILES:
        shutil.copy2(work + "/prev/" + f, work + "/" + f)
    shutil.rmtree(work + "/prev")
    print("restore ok: WORK back at #%d" % _load(work + "/state.json")["base"])


def bootstrap(work, db):
    shutil.rmtree(work + "/prev", ignore_errors=True)  # a fresh WORK has nothing to undo
    ms = []
    for f in sorted(glob.glob(db + "/chunks/*.json")):
        ms += _load(f)["msgs"]
    byi = {}
    for m in ms:
        byi[m["i"]] = m
    al = [byi[i] for i in sorted(byi)]
    assert [m["i"] for m in al] == list(range(len(al))), "gap in stored messages"
    mt = _load(db + "/meta/chat.json")
    stored = al[-1]["i"] if al else -1
    assert mt["lastI"] <= stored, (
        "meta/chat.lastI (#%d) is ahead of the newest saved message (#%d): fix meta/chat first (SKILL.md Troubleshooting)"
        % (mt["lastI"], stored)
    )
    last = mt["lastI"]
    ahead = stored - last  # chunks past lastI: an import that stopped before meta/chat; the next paste repairs them
    th = _load(db + "/threading/current.json")
    to = th.get("to")
    base = last
    if isinstance(to, int) and -1 <= to < last:
        base = to  # stored but never built (a run that stopped after its import): the next build covers them
    _dump(al[: base + 1], work + "/all.json")
    _dump(th, work + "/base/threading.json")
    _dump(_load(db + "/summary/current.json"), work + "/base/summary.json")
    st = {"base": base, "stops": (mt.get("anchorMids") or [])[::-1], "tz": mt.get("tz") or "America/Los_Angeles"}
    _dump(st, work + "/state.json")
    print(
        "bootstrap ok: %d messages built through #%d; STOPS=%s" % (base + 1, base, json.dumps(st["stops"]))
        + (
            ""
            if base == last
            else "; #%d-#%d are stored but not built yet: the next RUN must include %s"
            % (
                base + 1,
                last,
                ", ".join(
                    sorted(
                        {
                            "chunks/c%04d" % (x // (mt.get("chunkSize") or 82) * (mt.get("chunkSize") or 82))
                            for x in range(base + 1, last + 1)
                        }
                    )
                ),
            )
        )
        + (
            "; #%d-#%d are saved but not counted in meta/chat yet: the next paste repairs them (REPAIRED)"
            % (last + 1, stored)
            if ahead
            else ""
        )
    )


def build(work, run, specp):
    global TZ
    sp = _load(specp)
    st = _load(work + "/state.json")
    base = st["base"]
    TZ = st.get("tz") or TZ
    ms = []
    for f in sorted(glob.glob(run + "/chunks/*.json")):
        ms += _load(f)["msgs"]
    al = _load(work + "/all.json")
    byi = {m["i"]: m for m in al}
    assert (al[-1]["i"] if al else -1) == base == len(al) - 1, (len(al), base)
    for m in ms:
        if m["i"] in byi:
            assert byi[m["i"]] == m, ("stored copy differs", m["i"])
    new = sorted({m["i"]: m for m in ms if m["i"] > base}.values(), key=lambda m: m["i"])
    N = {m["i"]: m for m in new}
    if not new and ms:
        if os.path.exists(work + "/prev/state.json"):
            raise AssertionError(
                "RUN already built into WORK (WORK is at #%d, RUN ends at #%d). To build it again, run: catchup.py restore WORK"
                % (base, max(m["i"] for m in ms))
            )
        raise AssertionError(
            "nothing left to build: WORK already covers RUN (through #%d; another build did it). Write only meta/chat {lastRefresh} and refresh/status"
            % base
        )
    ids = [m["i"] for m in new]
    mt = _load(run + "/meta/chat.json")
    hi = (ids[0] - 1) if ids else mt.get("lastI", base)
    if hi > base:  # messages after WORK's base that RUN doesn't carry (it may carry no chunks at all)
        cs = mt.get("chunkSize") or 82
        need = sorted({"c%04d" % (x // cs * cs) for x in range(base + 1, hi + 1)})
        raise AssertionError(
            "RUN is missing #%d-#%d (stored, not built yet): fetch %s into RUN too"
            % (base + 1, hi, ", ".join("chunks/" + c for c in need))
        )
    assert ids, "nothing to build: meta/chat ends at #%d and WORK already covers it" % base
    assert ids and ids == list(range(base + 1, base + 1 + len(ids))), (
        "new messages must be #%d onward with no gaps" % (base + 1),
        ids,
    )
    bym = {m.get("m"): m["i"] for m in al + new if m.get("m")}
    t = _load(work + "/base/threading.json")
    s = _load(work + "/base/summary.json")
    _relink(t, sp, byi, base)
    C = {cv["id"]: cv for cv in t["convs"]}
    for nc in sp.get("newconvs", []):
        assert nc["id"] not in C, ("conv id exists", nc["id"])
        cv = {"id": nc["id"], "title": nc["title"], "members": []}
        t["convs"].append(cv)
        C[nc["id"]] = cv
        s["convs"].append(
            {
                "id": nc["id"],
                "tag": nc.get("tag", ""),
                "synopsis": [],
                "outcome": nc.get("outcome", ""),
                "key": nc.get("key", []),
            }
        )
    joined = {}
    for cid, mem in sp["join"].items():
        assert cid in C, ("unknown conv", cid)
        for i in mem:
            assert i not in joined, ("joined twice", i)
            joined[i] = cid
    assert sorted(joined) == ids, ("unassigned or extra", sorted(set(ids) ^ set(joined)))
    for i in ids:
        cv = C[joined[i]]
        m = N[i]
        prev = [x for x in cv["members"] if x < i]
        LS = sp.get("links", {})
        L = LS.get(str(i))
        unfound = False
        if L:
            assert len(L) == 2 and L[1] in LINK_TYPES, ("link type must be one of %s" % "/".join(LINK_TYPES), i, L)
        if not L and not (str(i) in LS and L is None):  # "i": null in links = deliberately no link (a new topic)
            if m.get("pi") is not None:
                L = [m["pi"], "rq" if m.get("pq") else "r"]  # pi can be 0
            elif m.get("pmid") and m["pmid"] in bym:
                L = [bym[m["pmid"]], "rq" if m.get("pq") else "r"]
            elif m.get("r"):
                pr, k, doubt = resolve(m, al + new)
                if pr is not None:
                    L = [pr, k]
                    print(
                        "CHECK photo-reply guess"
                        if k == "rg"
                        else ("CHECK quote match (%s)" % doubt if doubt else "matched by quote"),
                        i,
                        "->",
                        pr,
                    )
                else:
                    print("WARN reply parent not found", i, '- left unlinked; set "links" by hand if you know it')
                    unfound = True
            if not L and prev and not unfound:  # a reply whose parent wasn't found is not guessed as an answer
                p = max(prev)
                P = byi.get(p) or N.get(p)
                if _min(m) - _min(P) <= 180:
                    L = [p, "c" if P["f"] == m["f"] else "i"]
                    print(
                        "GUESS %d -> %d %s | %s: %s  <=  %s: %s"
                        % (i, p, L[1], m["f"][:12], _short(m), P["f"][:12], _short(P))
                    )
                else:
                    print("ROOT %d (over 3 h since the conversation's previous message) | %s" % (i, _short(m)))
        cv["members"].append(i)
        cv["members"].sort()
        if L:
            t["links"][str(i)] = L
            pc = joined.get(L[0]) or next((c["id"] for c in t["convs"] if L[0] in c["members"]), None)
            if pc and pc != joined[i]:
                print(
                    'WARN link %d -> %d crosses conversations (%s -> %s); the page shows %d as a new thread. Join them, or set "links"'
                    % (i, L[0], joined[i], pc, i)
                )
    t["to"] = ids[-1]
    _note(t)
    seen = collections.Counter(x for cv in t["convs"] for x in cv["members"])
    lo = min(min(cv["members"]) for cv in t["convs"] if cv["members"])
    for i in range(lo, ids[-1] + 1):
        assert seen[i] == 1, ("message in %d conversations" % seen[i], i)
    for k, v in t["links"].items():
        assert v[0] < int(k), ("link must point back", k, v)
    SC = {c["id"]: c for c in s["convs"]}
    for cid, bs in sp.get("bullets", {}).items():
        for tx, refs in bs:
            assert len(tx.split()) <= 15, ("bullet over 15 words", tx)
            SC[cid]["synopsis"].append({"t": tx, "refs": refs})
    for cid, o in sp.get("outcome", {}).items():
        assert len(o.split()) <= 12, ("outcome over 12 words", o)
        SC[cid]["outcome"] = o
    for cid, k in sp.get("key", {}).items():
        SC[cid]["key"] = k
    pool = {m["i"]: m for m in al + new}
    cmem = lambda cid: set(C[cid]["members"]) if cid in C else set()
    for d in sp.get("deals", []):
        assert d.get("conv") in C, ("deal conv missing", d.get("conv"))
        assert d.get("refs") and all(r in cmem(d["conv"]) for r in d["refs"]), (
            "deal refs must be messages in its conversation (the page hides a deal without them)",
            d,
        )
    for x in sp.get("mentions", []):
        for r in x.get("refs", []):
            k = r[0] if isinstance(r, list) else r
            assert k in pool and pool[k]["f"] != "You", (
                "mention ref must be a stored message by someone else",
                k,
                x.get("note"),
            )
    open_asks = {o["ask"] for o in s["open"]}
    for k in sp.get("closeOpen", []):
        assert k in open_asks, "closeOpen: no open question asks at #%s" % k
    for o in sp.get("open", []):
        assert o["ask"] not in open_asks or o["ask"] in sp.get("closeOpen", []), ("already open", o["ask"])
    s["deals"] += sp.get("deals", [])
    for cid, e in sp.get("dealEdit", {}).items():
        ds = [d for d in s["deals"] if d["conv"] == cid]
        assert ds, ("dealEdit: no deal in conversation", cid)
        assert len(ds) == 1 or "index" in e, 'dealEdit: %d deals in %s; add "index" (0 = the first listed)' % (
            len(ds),
            cid,
        )
        d = ds[e.get("index", 0)]
        if "text" in e:
            d["text"] = e["text"]
        assert all(r in cmem(cid) for r in e.get("addRefs", [])), ("dealEdit addRefs must be in the conversation", cid)
        d["refs"] = sorted(set(d.get("refs", []) + e.get("addRefs", [])))
    s["open"] = sp.get("open", []) + [o for o in s["open"] if o["ask"] not in sp.get("closeOpen", [])]
    s["answered"] = sp.get("answered", []) + s["answered"]
    s["mentions"] = sp.get("mentions", []) + s["mentions"]
    s["toI"] = ids[-1]
    cm = {cv["id"]: set(cv["members"]) for cv in t["convs"]}
    for cv in s["convs"]:
        for k in cv.get("key", []):
            assert k in cm[cv["id"]], ("key not in conv", cv["id"], k)
        for b in cv["synopsis"] if isinstance(cv["synopsis"], list) else []:
            assert b["refs"] and all(r in cm[cv["id"]] for r in b["refs"]), ("bullet ref not in conv", cv["id"], b)
    for o in s["open"] + s["answered"]:
        assert all(r in cm[o["conv"]] for r in [o["ask"]] + o.get("refs", [])), ("ref not in conv", o)
    for d in s["deals"]:
        assert d["conv"] in cm, ("deal conv missing", d["conv"])
    last = {c: max(m) for c, m in cm.items() if m}
    s["convs"].sort(key=lambda c: -last.get(c["id"], 0))
    a = mt["anchorMids"]
    assert mt["lastI"] == ids[-1] and a[-1] == new[-1]["m"], "meta/chat not updated by import"
    ts = _ts()
    t["builtAt"] = ts
    s["generatedAt"] = ts
    _dump(t, run + "/out/threading.json")
    _dump(s, run + "/out/summary.json")
    _snapshot(work)
    _dump(t, work + "/base/threading.json")
    _dump(s, work + "/base/summary.json")
    _dump(al + new, work + "/all.json")
    st = {"base": ids[-1], "stops": a[::-1], "tz": TZ}
    _dump(st, work + "/state.json")
    print(
        "build ok: #%d-#%d | %s | next STOPS=%s"
        % (ids[0], ids[-1], dict(collections.Counter(joined.values())), json.dumps(st["stops"]))
    )


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "bootstrap":
        bootstrap(sys.argv[2].rstrip("/"), sys.argv[3].rstrip("/"))
    elif cmd == "build":
        build(sys.argv[2].rstrip("/"), sys.argv[3].rstrip("/"), sys.argv[4])
    elif cmd == "restore":
        restore(sys.argv[2].rstrip("/"))
    elif cmd == "relink":
        relink(sys.argv[2].rstrip("/"), sys.argv[3].rstrip("/"), sys.argv[4])
    else:
        sys.exit(__doc__)
