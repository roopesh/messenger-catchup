#!/usr/bin/env python3
"""Messenger Catch-up build tool (generic).
  catchup.py bootstrap WORK DBDIR    DBDIR = ArtifactData out_dir holding chunks/*.json, the threading and summary
                                     collections (threading/*.json, summary/*.json) and meta/chat.json. Reads either
                                     layout (below). Writes WORK/all.json, WORK/base/*, WORK/state.json. It stops if
                                     threading and summary disagree on the last message built (a write that half landed);
                                     add --rollback to count threading's extra messages as not built yet.
  catchup.py build WORK RUNDIR SPEC  RUNDIR = out_dir with the touched chunks/*.json + meta/chat.json fetched after import,
                                     and the whole threading and summary collections (listed at step 5). Writes the
                                     documents that changed into RUNDIR/out/{threading,summary}/ and
                                     RUNDIR/out/manifest.json (what to write, in which batches, and what to delete after),
                                     then advances WORK (all.json, base, state), keeping the previous WORK in WORK/prev.
                                     RUNDIR/out/merged/ holds the whole state as the page merges it, for checking only.
  catchup.py restore WORK            Undo the last build or relink (WORK back to WORK/prev): after a refused DB write, or to
                                     rebuild the same RUN with a corrected spec.
  catchup.py relink WORK RUNDIR SPEC Correct links on messages already built, when there's nothing new to build. RUNDIR
                                     holds the whole threading collection (list); SPEC holds only "relink". Writes
                                     RUNDIR/out/manifest.json and the threading documents it names, then advances WORK's
                                     threading, keeping the previous WORK in WORK/prev.
  catchup.py restore-summary WORK RUNDIR BACKUPDIR [DECISIONS] [--dry-run] [--backup=NAME]
                                     Put back what sessions before v1.17 dropped from the summary, from the copy they saved
                                     in the page's `backups` collection (BACKUPDIR = out_dir with backups/*.json; its parts,
                                     {part:"a"|"b"…, of}, are joined and must all be there). RUNDIR holds the whole threading
                                     and summary collections (list). --dry-run prints only counts. Without DECISIONS, the
                                     backup's open questions that would come back are written to RUNDIR/out/restore-open.json
                                     with the later messages in their conversations, and nothing else is written. With
                                     DECISIONS ({"<ask>": "open" | {"answer", "refs"}}), it writes the summary documents and
                                     RUNDIR/out/manifest.json as a build does and advances WORK's summary (`restore` undoes it).
                                     The refresh skill's references/restoring-a-summary.md has the whole procedure.
LAYOUT (v1.17). A database document holds at most 256 KiB, so threading and summary are collections of documents:
  threading/current {layout:2, block, blocks:[ids], to, note, builtAt, convs:[conversations with no messages yet]}
  threading/b<start>-<hash> {start, convs:[{id,title}] starting in the block, members:{conv:[i...]}, links:{i:[p,t]}}
  summary/current {layout:2, block, blocks:[ids], activeFrom, version, toI, generatedAt, fromI?, mentionsNote?,
                   convs, open, answered, mentions, deals: the items whose messages reach activeFrom}
  summary/b<start>-<hash> {start, convs (by last message), open, answered, mentions, deals (by first message):
                   older items by the block of their messages; syn:{conv:[bullets]}: a conversation's bullets
                   from this block, so no document grows with one conversation}
  A block covers BLOCK messages from start. Its id carries a hash of its content, so a changed block is a new
  document: nothing anyone reads is overwritten until `current` names the new one, and a retry finds what an
  interrupted write already created. Merged, these are exactly the old single documents (newest-first lists:
  current, then blocks newest first; deals: blocks oldest first, then current). The old layout, one `current`
  document each without `layout`, is still read, and the first build converts it. Nothing is ever dropped: the
  cleanup deletes only blocks the replaced `current` named and the new one doesn't, never blocks no `current` names.
  summary.fromI (optional, pages from before v1.17): the first message the stored summary covers. Earlier sessions
  dropped older conversations and moved it; the page offers to summarize spans before it. A build keeps it as is;
  restore-summary moves it back to what the backup covered (or removes it when the summary covers everything).
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

import json, sys, re, os, glob, collections, shutil, datetime, hashlib, copy


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

WFILES = ("all.json", "base/threading.json", "base/summary.json", "base/layout.json", "state.json")

BLOCK = 1000  # messages per block document
DOC_LIMIT = 240 * 1024  # a build fails above this; the database refuses documents over 256 KiB (262,144 bytes)
SOFT = 96 * 1024  # summary/current above this archives one more block (activeFrom moves up a block)
BATCH_DOCS = 48  # documents per batch: the tool takes 50 writes, and the last batch adds meta/chat and refresh/status
BATCH_BYTES = 900 * 1024  # the tool takes 1 MiB per batch
LAYOUT_KEYS = ("layout", "block", "blocks", "activeFrom")
BLOCK_ID = re.compile(r"^b\d{6,}-[0-9a-f]{8}$")
NEWEST_FIRST = ("convs", "open", "answered", "mentions")  # summary lists kept newest first; deals are oldest first
SUMMARY_LISTS = NEWEST_FIRST + ("deals",)


def _size(o):  # bytes as the database counts a document: compact JSON
    return len(json.dumps(o, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _bid(start, doc):  # a block's id carries a hash of its content, so a changed block is a new document
    h = hashlib.sha256(json.dumps(doc, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    return "b%06d-%s" % (start, h.hexdigest()[:8])


def _nums(x):  # the message numbers in a value ([1, [2], 3] -> [1, 2, 3])
    if isinstance(x, list):
        return [n for v in x for n in _nums(v)]
    return [x] if isinstance(x, int) and not isinstance(x, bool) else []


def _docs(d):  # an out_dir collection folder -> {doc id: document}
    return {os.path.basename(f)[:-5]: _load(f) for f in glob.glob(d + "/*.json")}


def _blocks(cur, docs, name):
    missing = [b for b in cur.get("blocks") or [] if b not in docs]
    assert not missing, (
        "%s/current names %s, which %s not in the folder. Fetch the whole %s collection (list, limit 1000). If it's "
        "still missing after that, it was deleted: write nothing, and tell the user (references/writing-the-build.md "
        "› A missing block)" % (name, ", ".join(missing), "is" if len(missing) == 1 else "are", name)
    )
    return sorted((docs[b] for b in cur.get("blocks") or []), key=lambda d: d["start"])


def _named(docs):  # the block ids a collection's `current` names ([] in the old single-document layout)
    cur = docs.get("current") or {}
    return list(cur.get("blocks") or []) if cur.get("layout") == 2 else []


def _listing(run, c):
    """Step 5's read of a collection in RUN, which must be the whole collection: every block `current` names."""
    docs = _docs(run + "/" + c)
    assert "current" in docs, "RUN has no %s/current.json: list the whole %s collection into RUN (list, limit 1000)" % (
        c,
        c,
    )
    missing = [b for b in _named(docs) if b not in docs]
    assert not missing, (
        "RUN/%s/current names %s, which %s not in RUN: list the whole %s collection into RUN (list, limit 1000), not "
        "only its current document" % (c, ", ".join(missing), "is" if len(missing) == 1 else "are", c)
    )
    return docs


def _strays(docs):  # block documents no `current` names: an interrupted write, or a `current` another writer replaced
    named = set(_named(docs))
    return sorted(x for x in docs if BLOCK_ID.match(x) and x not in named)


def merge_threading(docs):
    """The threading collection ({doc id: document}) -> the single document of the old layout. The page does the same."""
    cur = docs.get("current")
    if cur is None or cur.get("layout") != 2:
        return cur
    t = {k: v for k, v in cur.items() if k not in LAYOUT_KEYS}
    convs, by, links = [], {}, {}
    for b in _blocks(cur, docs, "threading"):
        for c in b.get("convs", []):
            by[c["id"]] = dict(c, members=[])
            convs.append(by[c["id"]])
        for cid, mem in b.get("members", {}).items():
            if cid not in by:  # never written that way, but keep the messages
                by[cid] = {"id": cid, "title": cid, "members": []}
                convs.append(by[cid])
            by[cid]["members"] += mem
        links.update(b.get("links", {}))
    for c in cur.get("convs", []):  # conversations with no messages yet
        if c["id"] not in by:
            convs.append(dict(c, members=list(c.get("members", []))))
    t["convs"], t["links"] = convs, links
    return t


def merge_summary(docs):
    """The summary collection -> the single document of the old layout. The page does the same."""
    cur = docs.get("current")
    if cur is None or cur.get("layout") != 2:
        return cur
    s = {k: v for k, v in cur.items() if k not in LAYOUT_KEYS}
    bs = _blocks(cur, docs, "summary")
    for k in NEWEST_FIRST:
        s[k] = list(cur.get(k, [])) + [x for b in reversed(bs) for x in b.get(k, [])]
    s["deals"] = [x for b in bs for x in b.get("deals", [])] + list(cur.get("deals", []))
    syn = {}  # a conversation's older bullets, by block, oldest first
    for b in bs:
        for cid, items in b.get("syn", {}).items():
            syn.setdefault(cid, []).extend(items)
    have = {c["id"] for c in s["convs"]}
    s["convs"] = [dict(c, synopsis=syn[c["id"]] + c["synopsis"]) if c["id"] in syn else c for c in s["convs"]]
    s["convs"] += [  # never written that way, but keep the bullets
        {"id": cid, "tag": "", "synopsis": items, "outcome": "", "key": []}
        for cid, items in syn.items()
        if cid not in have
    ]
    return s


def _canon_threading(t):  # the order a merge gives back: by the block of the first message, then empty conversations
    for c in t["convs"]:
        c["members"] = sorted(c["members"])
    t["convs"].sort(key=lambda c: (0, c["members"][0] // BLOCK) if c["members"] else (1, 0))
    return t


def split_threading(t):
    """Links and members go to the block of their message; a conversation's title to the block of its first message."""
    cur = {k: v for k, v in t.items() if k not in ("convs", "links") + LAYOUT_KEYS}
    bl = {}
    blk = lambda i: bl.setdefault(i // BLOCK * BLOCK, {"start": i // BLOCK * BLOCK})
    cur["convs"] = []
    for c in _canon_threading(t)["convs"]:
        meta = {k: v for k, v in c.items() if k != "members"}
        if not c["members"]:
            cur["convs"].append(dict(meta, members=[]))
            continue
        blk(c["members"][0]).setdefault("convs", []).append(meta)
        for i in c["members"]:
            blk(i).setdefault("members", {}).setdefault(c["id"], []).append(i)
    for k, v in sorted(t["links"].items(), key=lambda kv: int(kv[0])):
        blk(int(k)).setdefault("links", {})[k] = v
    return cur, bl


def _runmax(ks, newest_first):  # running maximum from the oldest end: the keys never rise toward that end
    out, m = [], -1
    for k in ks[::-1] if newest_first else ks:
        m = max(m, k)
        out.append(max(m, 0))
    return out[::-1] if newest_first else out


def split_summary(s, t, active_from):
    """Items whose message numbers reach activeFrom stay in current; older ones go to the block of those numbers. A
    conversation lives in current while active, else in the block of its last message, and its bullets from earlier
    blocks sit in those blocks (`syn`), so no document grows with one conversation. Keys are a running maximum from each
    list's oldest end, so each document holds one unbroken run of each list and merging gives back the exact order."""
    last = {c["id"]: max(c["members"]) for c in t["convs"] if c["members"]}
    key = {
        "convs": lambda c: last.get(c["id"], 0),
        "open": lambda o: max(_nums([o.get("ask")]) or [-1]),
        "answered": lambda a: max(_nums([a.get("ask")] + list(a.get("refs") or [])) or [-1]),
        "mentions": lambda x: max(_nums(x.get("refs") or []) or [-1]),
        "deals": lambda d: min(_nums(d.get("refs") or []) or [-1]),  # the first message: dealEdit only adds later ones
    }
    cur = {k: v for k, v in s.items() if k not in SUMMARY_LISTS + LAYOUT_KEYS}
    bl = {}
    blk = lambda k: bl.setdefault(k // BLOCK * BLOCK, {"start": k // BLOCK * BLOCK})
    for name in SUMMARY_LISTS:
        items = list(s.get(name) or [])
        cur[name] = []
        for x, k in zip(items, _runmax([key[name](x) for x in items], name != "deals")):
            home = None if k >= active_from else k // BLOCK * BLOCK
            if name == "convs" and isinstance(x.get("synopsis"), list):
                keep = []
                bks = [max(_nums(b.get("refs") if isinstance(b, dict) else []) or [-1]) for b in x["synopsis"]]
                for b, bk in zip(x["synopsis"], _runmax(bks, False)):
                    if (bk >= active_from) if home is None else (bk // BLOCK * BLOCK == home):
                        keep.append(b)
                    else:
                        blk(bk).setdefault("syn", {}).setdefault(x["id"], []).append(b)
                x = dict(x, synopsis=keep)
            (cur[name] if home is None else blk(k).setdefault(name, [])).append(x)
    return cur, bl


def layout_docs(t, s=None, active_from=0):
    """The whole state as block-layout documents: {"threading/current": ..., "threading/<id>": ..., "summary/...": ...}.
    summary/current keeps what's newer than activeFrom: the start of the block before the newest, moved up a block at a
    time while current is over SOFT. activeFrom never moves back, so conversations don't hop between documents."""
    docs = {}
    cur, bl = split_threading(t)
    cur.update(layout=2, block=BLOCK, blocks=[])
    for st in sorted(bl):
        cur["blocks"].append(_bid(st, bl[st]))
        docs["threading/" + cur["blocks"][-1]] = bl[st]
    docs["threading/current"] = cur
    if s is not None:
        to = s.get("toI") if isinstance(s.get("toI"), int) else -1
        top = max(to, 0) // BLOCK * BLOCK
        T = min(max(active_from or 0, (to // BLOCK - 1) * BLOCK, 0), top)
        cur, bl = split_summary(s, t, T)
        while _size(cur) > SOFT and T < top:
            T = min((T // BLOCK + 1) * BLOCK, top)
            cur, bl = split_summary(s, t, T)
        cur.update(layout=2, block=BLOCK, blocks=[], activeFrom=T)
        for st in sorted(bl):
            cur["blocks"].append(_bid(st, bl[st]))
            docs["summary/" + cur["blocks"][-1]] = bl[st]
        docs["summary/current"] = cur
    return docs


def _too_big(big, docs):
    p, z = big[0]
    hint = "Report it (github.com/roopesh/messenger-catchup/issues)."
    if p.startswith("summary/"):
        cs = sorted(((_size(c), c["id"]) for c in docs[p].get("convs", [])), reverse=True)[:3]
        if cs:
            hint = (
                (
                    "Its largest conversations: %s. If one conversation holds most of it, start a new conversation for its "
                    "new messages (newconvs) instead of joining it, then `catchup.py restore WORK` and build again. Otherwise "
                    % ", ".join("%s (%d bytes)" % (i, n) for n, i in cs)
                )
                + hint[0].lower()
                + hint[1:]
            )
    return (
        "%s would be %d bytes, over the %d-byte limit (the database refuses documents over 262,144). Nothing was written "
        "and WORK is unchanged. Never drop or shorten conversations, bullets or summaries to make it fit. %s"
        % (p, z, DOC_LIMIT, hint)
    )


def _plan(docs, listing):
    """Check every document's size, then decide what to write: blocks that RUN's listing doesn't hold yet (unpinned
    creates) and the `current` documents (pinned) last, in batches the tool accepts; and the blocks the replaced
    `current` named that the new one doesn't (deleted once the batches have succeeded). Blocks no `current` named are
    never deleted: they may be all that's left of a build another writer's `current` replaced."""
    big = sorted(((p, _size(d)) for p, d in docs.items() if _size(d) > DOC_LIMIT), key=lambda x: -x[1])
    if big:
        raise AssertionError(_too_big(big, docs))
    coll = lambda p: p.split("/")[0]
    did = lambda p: p.split("/")[1]
    creates = [p for p in sorted(docs) if did(p) != "current" and did(p) not in listing[coll(p)]]
    currents = [p for p in ("threading/current", "summary/current") if p in docs]
    batches, b, n = [], [], 0
    for p in creates:
        z = _size(docs[p])
        if b and (len(b) >= BATCH_DOCS or n + z > BATCH_BYTES):
            batches.append(b)
            b, n = [], 0
        b.append(p)
        n += z
    if b and (len(b) + len(currents) > BATCH_DOCS or n + sum(_size(docs[p]) for p in currents) > BATCH_BYTES):
        batches.append(b)
        b = []
    batches.append(b + currents)
    gone = []
    for c in sorted({coll(p) for p in currents}):
        keep = set(docs[c + "/current"]["blocks"])
        gone += [c + "/" + x for x in _named(listing[c]) if x not in keep and BLOCK_ID.match(x) and x in listing[c]]
    return batches, [gone[k : k + 50] for k in range(0, len(gone), 50)]


def _write_out(out, docs, batches, cleanup, merged):
    """OUT/<collection>/<id>.json for each document to write, OUT/manifest.json, and OUT/merged/ (for checking only).
    Clears what an earlier build or an older catchup.py left there, its single threading.json and summary.json too."""
    for x in ("threading", "summary", "merged"):
        shutil.rmtree(os.path.join(out, x), ignore_errors=True)
    for x in ("threading.json", "summary.json", "manifest.json"):
        if os.path.exists(os.path.join(out, x)):
            os.remove(os.path.join(out, x))
    entry = lambda p: dict(
        {"op": "set", "collection": p.split("/")[0], "doc_id": p.split("/")[1]},
        file_path=os.path.abspath(os.path.join(out, p + ".json")),
        **({"pin": True} if p.endswith("/current") else {}),
    )
    for bt in batches:
        for p in bt:
            _dump(docs[p], os.path.join(out, p + ".json"))
    for k, v in merged.items():
        _dump(v, os.path.join(out, "merged", k + ".json"))
    man = {
        "batches": [[entry(p) for p in bt] for bt in batches],
        "cleanup": [
            [{"op": "delete", "collection": p.split("/")[0], "doc_id": p.split("/")[1], "pin": True} for p in g]
            for g in cleanup
        ],
        "sizes": {p: _size(docs[p]) for bt in batches for p in bt},
    }
    _dump(man, os.path.join(out, "manifest.json"))
    big = max(man["sizes"].items(), key=lambda kv: kv[1])
    return "%s/manifest.json: %d batch%s, %d document%s (largest %s, %d bytes)%s" % (
        out,
        len(batches),
        "" if len(batches) == 1 else "es",
        sum(map(len, batches)),
        "" if sum(map(len, batches)) == 1 else "s",
        big[0],
        big[1],
        "; then delete %d unused block%s" % (sum(map(len, cleanup)), "" if sum(map(len, cleanup)) == 1 else "s")
        if cleanup
        else "",
    )


def _layout(work):
    p = work + "/base/layout.json"
    lay = _load(p) if os.path.exists(p) else {}
    assert "seen" in lay, "WORK was made by an older catchup.py (no base/layout.json record): bootstrap it again"
    return lay


SEEN = {"threading": ("to", "builtAt"), "summary": ("toI", "generatedAt")}


def _fresh(listing, lay):  # the database's `current` must still be the one WORK was bootstrapped or built from
    for c, docs in listing.items():
        db, mine = docs["current"], lay["seen"][c]
        assert all(db.get(f) == mine.get(f) for f in SEEN[c]), (
            "%s/current changed since WORK was bootstrapped (%s): another session built. Bootstrap WORK again from a "
            "fresh fetch, then build"
            % (c, ", ".join("%s %s, WORK has %s" % (f, db.get(f), mine.get(f)) for f in SEEN[c]))
        )


def _record(lay, docs):  # what the database holds once this write lands: what its `current` documents name
    for c in ("threading", "summary"):
        cur = docs.get(c + "/current")
        if cur is not None:
            lay[c] = list(cur["blocks"])
            lay.setdefault("layout", {})[c] = 2
            lay["seen"][c] = {f: cur.get(f) for f in SEEN[c]}
            if c == "summary":
                lay["activeFrom"] = cur["activeFrom"]
    return lay


def _roundtrip(docs, t, s):  # never write a layout that doesn't merge back into exactly this state
    for c, want, fn in (("threading", t, merge_threading), ("summary", s, merge_summary)):
        if want is not None:
            got = fn({p.split("/")[1]: d for p, d in docs.items() if p.startswith(c + "/")})
            assert got == want, "internal error: the %s documents don't merge back into the built state" % c


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


def relink(work, run, specp):
    global TZ
    sp = _load(specp)
    assert (
        set(sp) == {"relink"} and sp["relink"]
    ), 'relink SPEC takes only a non-empty "relink" (use build for the rest)'
    st = _load(work + "/state.json")
    TZ = st.get("tz") or TZ
    lay = _layout(work)
    listing = {"threading": _listing(run, "threading")}  # a fresh read: which blocks exist, and that WORK is current
    _fresh(listing, lay)
    t = _load(work + "/base/threading.json")
    _relink(t, sp, {m["i"]: m for m in _load(work + "/all.json")}, st["base"])
    _note(t)
    t["builtAt"] = _ts()
    docs = layout_docs(t)
    _roundtrip(docs, t, None)
    batches, cleanup = _plan(docs, listing)
    told = _write_out(run + "/out", docs, batches, cleanup, {"threading": t})
    _snapshot(work)
    _dump(t, work + "/base/threading.json")
    _dump(_record(lay, docs), work + "/base/layout.json")
    print("relink ok: %d change(s); write what %s lists, as in step 7" % (len(sp["relink"]), told))


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


def _rollback(th, toi):  # threading back to #toi: later links and memberships come from a write that half landed
    gone = {c["id"] for c in th["convs"] if c["members"] and min(c["members"]) > toi}
    th["convs"] = [dict(c, members=[i for i in c["members"] if i <= toi]) for c in th["convs"] if c["id"] not in gone]
    th["links"] = {k: v for k, v in th["links"].items() if int(k) <= toi}
    th["to"] = toi
    return th


def _chunk_names(lo, hi, chunks, cs):  # the chunk documents holding #lo-#hi: chunks start where imports landed
    if not chunks:  # a WORK bootstrapped before 1.17.1 has no chunk list
        return sorted({"chunks/c%04d" % (x // cs * cs) for x in range(lo, hi + 1)})
    starts = sorted(chunks)
    return sorted({"chunks/c%04d" % max([s for s in starts if s <= x] or [starts[0]]) for x in range(lo, hi + 1)})


def _dedupe_convs(th):  # earlier sessions could create two conversations with one id; the block layout keys by id
    seen, renamed = set(), []
    for c in th["convs"]:
        if c["id"] in seen:
            new = c["id"] + str(c["members"][0] if c["members"] else len(renamed))
            while new in seen:
                new += "x"
            renamed.append((c["id"], new))
            c["id"] = new
        seen.add(c["id"])
    return renamed


def bootstrap(work, db, rollback=False):
    shutil.rmtree(work + "/prev", ignore_errors=True)  # a fresh WORK has nothing to undo
    ms, chunks = [], []
    for f in sorted(glob.glob(db + "/chunks/*.json")):
        ch = _load(f)
        ms += ch["msgs"]
        if ch["msgs"]:
            chunks.append(ch.get("start", ch["msgs"][0]["i"]))
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
    tdocs, sdocs = _docs(db + "/threading"), _docs(db + "/summary")
    for c, d in (("threading", tdocs), ("summary", sdocs)):
        need = "%s/%s/current.json is missing: fetch the whole %s collection into DBDIR (list, limit 1000)"
        assert "current" in d, need % (db, c, c)
    th = _canon_threading(merge_threading(tdocs))
    sm = merge_summary(sdocs)
    dup = sorted({c["id"] for c in sm.get("convs", []) if [x["id"] for x in sm["convs"]].count(c["id"]) > 1})
    assert not dup, (
        "summary has more than one conversation with id %s: nothing was changed. Merge each pair into one entry (or give "
        "the second the id of its own threading conversation) in the fetched summary file, bootstrap again, and say so "
        "in the report" % ", ".join(dup)
    )
    renamed = _dedupe_convs(th)
    to, toi, rolled = th.get("to"), sm.get("toI"), ""
    if isinstance(to, int) and isinstance(toi, int) and to != toi:  # every write sets both; a batch stopped partway
        how = (
            "If the session that built it still has its RUN/out/manifest.json, send the rest of its last batch again "
            "(pinned with fresh versions), then bootstrap again. Otherwise run `catchup.py bootstrap WORK DBDIR "
            "--rollback`: #%d-#%d then count as not built yet, and the next build threads and summarizes them again"
            % (toi + 1, to)
            if to > toi
            else "catchup.py never writes summary ahead of threading: write nothing, and tell the user"
        )
        assert rollback and to > toi, (
            "threading/current is built through #%d but summary/current through #%d: the last write was only partly "
            "applied. Nothing was changed. %s (references/writing-the-build.md › A partly applied write)"
            % (to, toi, how)
        )
        th, to, rolled = _rollback(th, toi), toi, "; rolled threading back from #%d to #%d" % (to, toi)
    base = last
    if isinstance(to, int) and -1 <= to < last:
        base = to  # stored but never built (a run that stopped after its import): the next build covers them
    _dump(al[: base + 1], work + "/all.json")
    _dump(th, work + "/base/threading.json")
    _dump(sm, work + "/base/summary.json")
    docs = {"threading": tdocs, "summary": sdocs}
    old = [c for c, d in docs.items() if d["current"].get("layout") != 2]
    lay = {
        "threading": _named(tdocs),
        "summary": _named(sdocs),
        "activeFrom": sdocs["current"].get("activeFrom", 0) if "summary" not in old else 0,
        "layout": {c: 1 if c in old else 2 for c in docs},
        "seen": {c: {f: d["current"].get(f) for f in SEEN[c]} for c, d in docs.items()},
    }
    _dump(lay, work + "/base/layout.json")
    st = {
        "base": base,
        "stops": (mt.get("anchorMids") or [])[::-1],
        "tz": mt.get("tz") or "America/Los_Angeles",
        "chunks": chunks,
    }
    _dump(st, work + "/state.json")
    strays = {c: _strays(d) for c, d in docs.items()}
    past = max(
        [int(k) for b in strays["threading"] for k in tdocs[b].get("links", {})]
        + [i for b in strays["threading"] for m in tdocs[b].get("members", {}).values() for i in m]
        or [-1]
    )
    if isinstance(th.get("to"), int) and past > th["to"]:
        print(
            "WARN block documents no current names hold messages through #%d, past threading/current's #%d: a write "
            "was interrupted (the next build redoes it), or an older version of the skill replaced current. Nothing is "
            "deleted; say so in the report (references/writing-the-build.md › Blocks no current names)"
            % (past, th["to"])
        )
    print(
        "bootstrap ok: %d messages built through #%d; STOPS=%s" % (base + 1, base, json.dumps(st["stops"]))
        + rolled
        + (
            "; conversation id(s) used twice, renamed: %s (the summary stays with the first; say so in the report)"
            % ", ".join("%s -> %s" % r for r in renamed)
            if renamed
            else ""
        )
        + ("; %s in the single-document layout: the next build converts it" % " and ".join(old) if old else "")
        + (
            "; %d block document(s) no current names, left alone" % sum(map(len, strays.values()))
            if any(strays.values())
            else ""
        )
        + (
            ""
            if base == last
            else "; #%d-#%d are stored but not built yet: the next RUN must include %s"
            % (
                base + 1,
                last,
                ", ".join(_chunk_names(base + 1, last, chunks, mt.get("chunkSize") or 82)),
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
    lay = _layout(work)
    ms, starts = [], set()
    for f in sorted(glob.glob(run + "/chunks/*.json")):
        ch = _load(f)
        ms += ch["msgs"]
        if ch["msgs"]:
            starts.add(ch.get("start", ch["msgs"][0]["i"]))
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
            "nothing left to build: WORK already covers RUN (through #%d; another build did it). Write only meta/chat {lastRefresh, versions} and refresh/status"
            % base
        )
    ids = [m["i"] for m in new]
    mt = _load(run + "/meta/chat.json")
    hi = (ids[0] - 1) if ids else mt.get("lastI", base)
    if hi > base:  # messages after WORK's base that RUN doesn't carry (it may carry no chunks at all)
        need = _chunk_names(base + 1, hi, st.get("chunks"), mt.get("chunkSize") or 82)
        raise AssertionError(
            "RUN is missing #%d-#%d (stored, not built yet): fetch %s into RUN too" % (base + 1, hi, ", ".join(need))
        )
    assert ids, "nothing to build: meta/chat ends at #%d and WORK already covers it" % base
    assert ids and ids == list(range(base + 1, base + 1 + len(ids))), (
        "new messages must be #%d onward with no gaps" % (base + 1),
        ids,
    )
    bym = {m.get("m"): m["i"] for m in al + new if m.get("m")}
    t = _load(work + "/base/threading.json")
    s = _load(work + "/base/summary.json")
    listing = {c: _listing(run, c) for c in ("threading", "summary")}  # step 5's read of both whole collections
    _fresh(listing, lay)
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
            elif m.get("perr") == "noreplyline":
                # helper 2.0: a Messenger reply whose "X replied to Y" line couldn't be read: who it answers is unknown
                print(
                    "CHECK reply with no readable reply line",
                    i,
                    '- a Messenger reply, left unlinked; read it in context and set "links"',
                )
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
    for cid in set(sp.get("bullets", {})) | set(sp.get("outcome", {})) | set(sp.get("key", {})) | set(joined.values()):
        if cid in C and cid not in SC:  # its summary was dropped by a session before v1.17: start it again
            SC[cid] = {"id": cid, "tag": "", "synopsis": [], "outcome": "", "key": []}
            s["convs"].append(SC[cid])
    for cid, bs in sp.get("bullets", {}).items():
        if not isinstance(SC[cid]["synopsis"], list):  # an old string synopsis: bullets as the page reads it
            SC[cid]["synopsis"] = _syn_items(SC[cid]["synopsis"])
        for tx, refs in bs:
            assert len(tx.split()) <= 15, ("bullet over 15 words", tx)
            assert refs, ("bullet ref not in conv: a new bullet needs refs", cid, tx)
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
        for b in cv["synopsis"] if isinstance(cv["synopsis"], list) else []:  # bullets from old strings have no refs
            refs = (b.get("refs") or []) if isinstance(b, dict) else []
            assert all(r in cm[cv["id"]] for r in refs), ("bullet ref not in conv", cv["id"], b)
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
    scur = listing["summary"]["current"]
    docs = layout_docs(t, s, scur.get("activeFrom", 0) if scur.get("layout") == 2 else 0)
    _roundtrip(docs, t, s)
    # _plan fails here, before anything is written, if a document is too big
    batches, cleanup = _plan(docs, listing)
    told = _write_out(run + "/out", docs, batches, cleanup, {"threading": t, "summary": s})
    _snapshot(work)
    _dump(t, work + "/base/threading.json")
    _dump(s, work + "/base/summary.json")
    _dump(al + new, work + "/all.json")
    _dump(_record(lay, docs), work + "/base/layout.json")
    chunks = st.get("chunks")  # a WORK from before 1.17.1 has none; a partial list would name the wrong chunk
    st = {"base": ids[-1], "stops": a[::-1], "tz": TZ}
    if chunks is not None:
        st["chunks"] = sorted(set(chunks) | starts)
    _dump(st, work + "/state.json")
    print(
        "build ok: #%d-#%d | %s | next STOPS=%s"
        % (ids[0], ids[-1], dict(collections.Counter(joined.values())), json.dumps(st["stops"]))
    )
    print("write: " + told)


# restore-summary: put back what sessions before v1.17 dropped from the summary, from their copy in `backups`

PART_META = ("part", "of", "what", "savedAt")
AFTER_MAX = 60  # later messages per open question in restore-open.json (WORK/all.json has the rest)


def _syn_items(syn):
    """A synopsis as a list of bullets, the way the page reads it (synItems): an old string synopsis becomes one bullet
    per sentence, with no refs; a string inside a list becomes a bullet with no refs."""
    if isinstance(syn, list):
        return [{"t": x, "refs": []} if isinstance(x, str) else x for x in syn]
    parts = re.split(r'(?:(?<=[.!?])|(?<=[.!?]["”)]))\s+(?=["“(]?[A-Z#])', str(syn or ""))
    return [{"t": p.strip(), "refs": []} for p in parts if p.strip()]


def _same(a, b):
    return json.dumps(a, sort_keys=True, ensure_ascii=False) == json.dumps(b, sort_keys=True, ensure_ascii=False)


def _anchor_merge(cur, bak, same, oldest_first, take=lambda x: True, loose=None):
    """cur plus the items of bak it lacks, in bak's order: each missing item goes right after the bak item before it
    (where that one now is), or, for the first ones, right before the first later bak item cur holds; with none, at the
    old end of the list (the start when oldest_first, else the end). Each cur item stands for at most one bak item:
    exact matches (same) first, then loose ones for what's left. take(x) says whether a missing item may come back.
    -> (merged list, added, present, refused)"""
    used, pos = set(), [None] * len(bak)
    for test in (same, loose) if loose else (same,):
        for n, b in enumerate(bak):
            if pos[n] is None:
                pos[n] = next((j for j, c in enumerate(cur) if j not in used and test(b, c)), None)
                if pos[n] is not None:
                    used.add(pos[n])
    out = [("c", j) for j in range(len(cur))]
    anchor, added, present, refused = None, 0, 0, 0
    for n, b in enumerate(bak):
        if pos[n] is not None:
            anchor = out.index(("c", pos[n]))
            present += 1
            continue
        if not take(b):
            refused += 1
            continue
        if anchor is None:
            later = [p for p in pos[n + 1 :] if p is not None]
            k = out.index(("c", later[0])) if later else (0 if oldest_first else len(out))
        else:
            k = anchor + 1
        out.insert(k, ("b", n))
        anchor = k
        added += 1
    return [cur[j] if w == "c" else bak[j] for w, j in out], added, present, refused


def _load_backup(bdir, name=None):
    """The backup's parts ({part, of, what, savedAt, ...} in BACKUPDIR or BACKUPDIR/backups) joined into one summary:
    part a's fields, with each list made of every part's, in part order. Incomplete or mismatched parts are refused."""
    d = os.path.join(bdir, "backups") if os.path.isdir(os.path.join(bdir, "backups")) else bdir
    groups = {}
    for did, doc in sorted(_docs(d).items()):
        if isinstance(doc, dict) and "part" in doc and "of" in doc:  # ids <name>-a, <name>-b, …
            groups.setdefault(re.sub(r"-[a-z]$", "", did), []).append((did, doc))
    assert groups, (
        "no backup parts ({part, of}) in %s: list the whole backups collection into it (list, limit 1000)" % d
    )
    if name is None:
        assert len(groups) == 1, "%s holds several backups (%s): name one with --backup=NAME" % (d, ", ".join(groups))
        name = next(iter(groups))
    assert name in groups, "no backup named %s in %s (there: %s)" % (name, d, ", ".join(groups))
    parts = groups[name]
    stop = "Write nothing, and tell the user (references/restoring-a-summary.md › Refusals)"
    ofs = sorted({json.dumps(doc["of"]) for _, doc in parts})
    assert len(ofs) == 1 and isinstance(parts[0][1]["of"], int) and parts[0][1]["of"] >= 1, (
        "backup %s's parts disagree on how many parts there are (of: %s). %s" % (name, ", ".join(ofs), stop)
    )
    n = parts[0][1]["of"]
    want = [chr(ord("a") + k) for k in range(n)]
    got = sorted(str(doc["part"]) for _, doc in parts)
    wrong = [did for did, doc in parts if re.search(r"-[a-z]$", did) and did[-1] != str(doc["part"])]
    assert not wrong, "backup %s is mismatched: %s say(s) another part than its name. %s" % (
        name,
        ", ".join(wrong),
        stop,
    )
    assert got == want, (
        "backup %s is incomplete or mismatched: it has part(s) %s of %d, and needs %s. List the whole backups collection "
        "again (list, limit 1000). If that doesn't bring them, %s%s"
        % (name, ", ".join(got), n, ", ".join(want), stop[0].lower(), stop[1:])
    )
    for f in ("what", "savedAt"):
        vals = {json.dumps(doc.get(f), sort_keys=True) for _, doc in parts}
        assert len(vals) == 1, "backup %s's parts disagree on %s: they come from different saves. %s" % (name, f, stop)
    by = {str(doc["part"]): doc for _, doc in parts}
    s = {k: v for k, v in by["a"].items() if k not in PART_META}
    for p in want[1:]:
        extra = sorted(set(by[p]) - set(PART_META) - set(SUMMARY_LISTS))
        assert not extra, "backup %s part %s holds %s, which only part a may hold. %s" % (
            name,
            p,
            ", ".join(extra),
            stop,
        )
        for k in SUMMARY_LISTS:
            if k in by[p]:
                s[k] = list(s.get(k) or []) + list(by[p][k])
    for k in SUMMARY_LISTS:
        s[k] = list(s.get(k) or [])
    assert s.get("version") == 2 and isinstance(s.get("toI"), int), (
        "backup %s isn't a version 2 summary with toI: joined, it has version %s, toI %s. %s"
        % (name, s.get("version"), s.get("toI"), stop)
    )
    ids = [c.get("id") for c in s["convs"]]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    assert not dup, "backup %s has more than one conversation with id %s. %s" % (name, ", ".join(dup), stop)
    return name, n, s


def _merge_backup(B, s0, t, base, dec):
    """What restore-summary changes: s0 (WORK's merged summary) plus what the backup B has that it lacks.
    -> (new summary, counts, open questions to decide, skipped items)"""
    s = copy.deepcopy(s0)
    cm = {c["id"]: set(c["members"]) for c in t["convs"]}
    last = {c: max(m) for c, m in cm.items() if m}
    stored = lambda refs: all(isinstance(r, int) and not isinstance(r, bool) and 0 <= r <= base for r in refs)
    inconv = lambda cid, refs: cid in cm and stored(refs) and all(r in cm[cid] for r in refs)
    skipped = []
    C = {k: collections.Counter() for k in ("convs", "bullets", "open", "answered", "deals", "mentions")}

    def skip(kind, why, **ids):
        skipped.append(dict(ids, kind=kind, why=why))
        return False

    # conversations: missing ones come back (old string synopses as bullets); present ones get the bullets and empty
    # fields they lack
    cur = {c["id"]: c for c in s["convs"]}
    back = []
    for b in B["convs"]:
        cid = b.get("id")
        items = _syn_items(b.get("synopsis"))
        if cid not in cm or not inconv(cid, b.get("key") or []):
            C["convs"]["skipped"] += 1
            C["bullets"]["skipped"] += len(items)
            skip("conv", "not in threading" if cid not in cm else "key refs not in its conversation", conv=cid)
            continue
        good = []
        for x in items:
            if inconv(cid, (x.get("refs") or []) if isinstance(x, dict) else [None]):
                good.append(x)
            else:
                C["bullets"]["skipped"] += 1
                skip("bullet", "refs not in its conversation", conv=cid, refs=x.get("refs"))
        if cid not in cur:
            back.append(dict(b, synopsis=good))
            C["convs"]["restored"] += 1
            C["bullets"]["restored"] += len(good)
            continue
        c, changed = cur[cid], False
        back.append(c)
        if _same(b.get("synopsis"), c.get("synopsis")):
            C["bullets"]["present"] += len(good)
        else:
            syn, add, have, _ = _anchor_merge(_syn_items(c.get("synopsis")), good, _same, True)
            C["bullets"]["restored"] += add
            C["bullets"]["present"] += have
            if add:
                c["synopsis"], changed = syn, True
        for k, v in b.items():
            if k not in ("id", "synopsis") and v not in ("", [], None) and c.get(k) in ("", [], None):
                c[k], changed = v, True
        C["convs"]["merged" if changed else "present"] += 1
    if C["convs"]["restored"]:  # newest first by their last message, as a build sorts them
        s["convs"] = _anchor_merge(s["convs"], back, lambda x, y: x["id"] == y["id"], False)[0]
        s["convs"].sort(key=lambda c: -last.get(c["id"], 0))

    # open questions: one missing from open, and answered in neither summary, comes back only as DECISIONS says
    key = lambda o: (o.get("conv"), o.get("ask"))
    is_open, is_answered = {key(o) for o in s["open"]}, {key(a) for a in s["answered"] + B["answered"]}
    todo = []
    for o in B["open"]:
        if key(o) in is_open:
            C["open"]["present"] += 1
        elif key(o) in is_answered:
            C["open"]["already answered"] += 1
        elif not inconv(o.get("conv"), [o.get("ask")]):
            C["open"]["skipped"] += 1
            skip("open", "ask not in its conversation", conv=o.get("conv"), ask=o.get("ask"))
        else:
            todo.append(o)
    reopen, answers = set(), []
    if dec is not None:
        asks = {str(o["ask"]): o for o in todo}
        assert isinstance(dec, dict), 'DECISIONS must be {"<ask>": "open" | {"answer": "...", "refs": [...]}}'
        extra = sorted(set(dec) - set(asks), key=lambda k: int(k) if k.isdigit() else -1)
        assert not extra, "DECISIONS names #%s, which isn't an open question to restore (see restore-open.json)" % (
            ", #".join(extra)
        )
        missing = sorted((k for k in asks if k not in dec), key=int)
        assert not missing, "DECISIONS has no decision for #%s: every question in restore-open.json needs one" % (
            ", #".join(missing)
        )
        for o in todo:
            d = dec[str(o["ask"])]
            if d == "open":
                reopen.add(key(o))
                continue
            assert isinstance(d, dict) and set(d) == {"answer", "refs"}, (
                'DECISIONS #%s: "open", or {"answer": "one line", "refs": [...]}' % o["ask"]
            )
            a, refs = d["answer"], d["refs"]
            assert isinstance(a, str) and a.strip() and "\n" not in a and len(a.split()) <= 30, (
                "DECISIONS #%s: the answer is one line of at most 30 words" % o["ask"]
            )
            assert isinstance(refs, list) and inconv(o["conv"], refs) and all(r > o["ask"] for r in refs), (
                "DECISIONS #%s: refs are the answering messages: stored, after the ask, in its conversation (%s); "
                "[] only when the answer is in another conversation, named in the answer" % (o["ask"], o["conv"])
            )
            answers.append({"conv": o["conv"], "ask": o["ask"], "answer": a.strip(), "refs": refs})
        C["open"]["restored"] = len(reopen)
        C["open"]["answered (DECISIONS)"] = len(answers)
    else:
        C["open"]["to decide"] = len(todo)
    s["open"] = _anchor_merge(s["open"], B["open"], lambda x, y: key(x) == key(y), False, lambda o: key(o) in reopen)[0]

    # answered, deals, mentions: the items missing come back where they were; ones that don't fit threading are listed
    def merge(name, same, oldest_first, ok, ids, loose=None):
        def take(x):
            return ok(x) or skip(name, "refs not in threading", **ids(x))

        out, add, have, bad = _anchor_merge(s[name], B[name], same, oldest_first, take, loose)
        C[name].update({"restored": add, "present": have, "skipped": bad})
        return out

    s["answered"] = answers + merge(
        "answered",
        _same,
        False,
        lambda a: inconv(a.get("conv"), [a.get("ask")] + list(a.get("refs") or [])),
        lambda a: {"conv": a.get("conv"), "ask": a.get("ask")},
    )
    edited = lambda b, c: (  # dealEdit changes the text and adds refs, never removes one
        b.get("conv") == c.get("conv") and bool(b.get("refs")) and set(b["refs"]) <= set(c.get("refs") or [])
    )
    s["deals"] = merge(
        "deals",
        _same,
        True,
        lambda d: bool(d.get("refs")) and inconv(d.get("conv"), d["refs"]),
        lambda d: {"conv": d.get("conv"), "refs": d.get("refs")},
        edited,
    )
    s["mentions"] = merge(
        "mentions", _same, False, lambda x: stored(_nums(x.get("refs") or [])), lambda x: {"refs": x.get("refs")}
    )

    # fromI: the first message either summary covers (none: everything from #0)
    num = lambda v: v if isinstance(v, int) and not isinstance(v, bool) else 0
    bf, cf = num(B.get("fromI")), num(s0.get("fromI"))
    assert cf <= B["toI"] + 1, (
        "the backup ends at #%d, but the stored summary starts at #%d: the messages between are in neither, so "
        "restoring would claim they're summarized. Write nothing, and tell the user" % (B["toI"], cf)
    )
    s.pop("fromI", None)
    if min(bf, cf):
        s["fromI"] = min(bf, cf)
    return s, C, todo, skipped


def _restore_open(t, al, todo, name):  # RUN/out/restore-open.json: each question, its conversation's later messages
    links = t.get("links", {})
    title = {c["id"]: c.get("title", "") for c in t["convs"]}
    mem = {c["id"]: sorted(c["members"]) for c in t["convs"]}

    def brief(i):
        m = al[i]
        o = {k: m[k] for k in ("i", "f", "fn", "d", "t", "b", "r", "q", "p", "a") if m.get(k) not in (None, "")}
        if str(i) in links:
            o["link"] = links[str(i)]
        return o

    qs = []
    for o in todo:
        after = [i for i in mem[o["conv"]] if i > o["ask"]]
        replies = sorted(int(k) for k, v in links.items() if v[0] == o["ask"] and int(k) not in mem[o["conv"]])
        q = dict(o, title=title[o["conv"]], message=brief(o["ask"]), after=[brief(i) for i in after[:AFTER_MAX]])
        if len(after) > AFTER_MAX:
            q["moreAfter"] = "%d more later messages in this conversation (WORK/all.json)" % (len(after) - AFTER_MAX)
        if replies:
            q["repliesElsewhere"] = [brief(i) for i in replies]
        qs.append(q)
    return {
        "backup": name,
        "how": 'For each question, read the messages after it. Set DECISIONS["<ask>"] to "open" if nobody answered it, '
        'or to {"answer": "<one line>", "refs": [<the answering messages: after the ask, in its conversation>]}. Then run '
        "restore-summary again with DECISIONS (references/restoring-a-summary.md).",
        "questions": qs,
        "template": {str(o["ask"]): "open" for o in todo},
    }


def restore_summary(work, run, bdir, decp=None, dry=False, name=None):
    global TZ
    st = _load(work + "/state.json")
    TZ = st.get("tz") or TZ
    lay = _layout(work)
    listing = {
        c: _listing(run, c) for c in ("threading", "summary")
    }  # a fresh read: what exists, and that WORK is current
    _fresh(listing, lay)
    t = _load(work + "/base/threading.json")
    s = _load(work + "/base/summary.json")
    al = _load(work + "/all.json")
    name, nparts, B = _load_backup(bdir, name)
    base = st["base"]
    assert B["toI"] <= min(base, s.get("toI") if isinstance(s.get("toI"), int) else -1), (
        "backup %s ends at #%d, past what the stored summary covers (#%s): it isn't an older copy of it"
        % (name, B["toI"], s.get("toI"))
    )
    dec = _load(decp) if decp else None
    new, C, todo, skipped = _merge_backup(B, s, t, base, dec)
    out = os.path.join(run, "out")
    print(
        "restore-summary%s: backup %s (%d part%s, through #%d) into the summary through #%s"
        % (" (dry run)" if dry else "", name, nparts, "" if nparts == 1 else "s", B["toI"], s.get("toI"))
    )
    order = {
        "convs": ("restored", "merged", "present", "skipped"),
        "open": ("to decide",) if dec is None else ("restored", "answered (DECISIONS)"),
    }
    for k in ("convs", "bullets", "open", "answered", "deals", "mentions"):
        fs = order.get(k, ("restored",)) + (
            () if k == "convs" else ("present",) + (("already answered",) if k == "open" else ()) + ("skipped",)
        )
        print("  %s: %s" % (k, ", ".join("%d %s" % (C[k][f], "already present" if f == "present" else f) for f in fs)))
    print("  fromI: %s -> %s" % (s.get("fromI", "none"), new.get("fromI", "none")))
    restored = sum(C[k]["restored"] for k in C) + C["open"]["answered (DECISIONS)"]
    if todo and dec is None:
        if dry:
            print("dry run: nothing written. %d open question(s) need a decision before they come back" % len(todo))
            return
        for x in ("threading", "summary", "merged"):  # nothing stale here can be taken for this run's output
            shutil.rmtree(os.path.join(out, x), ignore_errors=True)
        if os.path.exists(os.path.join(out, "manifest.json")):
            os.remove(os.path.join(out, "manifest.json"))
        _dump(_restore_open(t, al, todo, name), os.path.join(out, "restore-open.json"))
        print(
            "Nothing written. %d open question(s) to decide: read %s/restore-open.json, write DECISIONS, and run "
            "restore-summary again with it" % (len(todo), out)
        )
        return
    if new == s:
        print("nothing to restore: 0 restored; nothing written, WORK unchanged")
        return
    if dry:
        print("dry run: %d restored; nothing written" % restored)
        return
    new["generatedAt"] = _ts()  # so a WORK bootstrapped before this write sees that summary/current changed
    scur = listing["summary"]["current"]
    af = scur.get("activeFrom", 0) if scur.get("layout") == 2 else 0
    docs = {p: d for p, d in layout_docs(t, new, af).items() if p.startswith("summary/")}
    _roundtrip(docs, None, new)
    batches, cleanup = _plan(docs, listing)  # fails here, before anything is written, if a document is too big
    told = _write_out(out, docs, batches, cleanup, {"summary": new})
    if skipped:
        _dump(skipped, os.path.join(out, "restore-skipped.json"))
    _snapshot(work)
    _dump(new, work + "/base/summary.json")
    _dump(_record(lay, docs), work + "/base/layout.json")
    print(
        "restore ok: %d restored%s"
        % (restored, "; %d skipped, listed in %s/restore-skipped.json" % (len(skipped), out) if skipped else "")
    )
    print("write: " + told)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "bootstrap":
        bootstrap(sys.argv[2].rstrip("/"), sys.argv[3].rstrip("/"), "--rollback" in sys.argv[4:])
    elif cmd == "build":
        build(sys.argv[2].rstrip("/"), sys.argv[3].rstrip("/"), sys.argv[4])
    elif cmd == "restore":
        restore(sys.argv[2].rstrip("/"))
    elif cmd == "relink":
        relink(sys.argv[2].rstrip("/"), sys.argv[3].rstrip("/"), sys.argv[4])
    elif cmd == "restore-summary":
        a = [x for x in sys.argv[2:] if not x.startswith("--")]
        bk = [x.split("=", 1)[1] for x in sys.argv[2:] if x.startswith("--backup=")]
        if len(a) not in (3, 4):
            sys.exit(__doc__)
        restore_summary(
            a[0].rstrip("/"),
            a[1].rstrip("/"),
            a[2].rstrip("/"),
            a[3] if len(a) == 4 else None,
            "--dry-run" in sys.argv[2:],
            bk[0] if bk else None,
        )
    else:
        sys.exit(__doc__)
