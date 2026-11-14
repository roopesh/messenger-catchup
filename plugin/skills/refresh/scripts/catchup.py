#!/usr/bin/env python3
"""Messenger Catch-up build tool (generic).
  catchup.py bootstrap WORK DBDIR    DBDIR = ArtifactData out_dir holding chunks/*.json, the threading and summary
                                     collections (threading/*.json, summary/*.json) and meta/chat.json. Reads either
                                     layout (below). Writes WORK/all.json, WORK/base/*, WORK/state.json. It stops if
                                     threading and summary disagree on the last message built (a write that half landed);
                                     add --rollback to count threading's extra messages as not built yet. A pair from
                                     different writes (rev) passes when it fits together as a build would check; when it
                                     doesn't, --rollback files the summary's items under threading's conversations
                                     (nothing dropped), and the next build or `relink` with the spec {} writes it.
  catchup.py build WORK RUNDIR SPEC  RUNDIR = out_dir with the touched chunks/*.json + meta/chat.json fetched after import,
                                     and the whole threading and summary collections (listed at step 5). Writes the
                                     documents that changed into RUNDIR/out/{threading,summary}/ and
                                     RUNDIR/out/manifest.json (what to write, in which batches, and what to delete after),
                                     then advances WORK (all.json, base, state), keeping the previous WORK in WORK/prev.
                                     RUNDIR/out/merged/ holds the whole state as the page merges it, for checking only.
  catchup.py restore WORK            Undo the last build or relink (WORK back to WORK/prev): after a refused DB write, or to
                                     rebuild the same RUN with a corrected spec.
  catchup.py relink WORK RUNDIR SPEC Correct links (relink) or conversations (move) of messages already built, when
                                     there's nothing new to build. RUNDIR holds the whole threading collection (list),
                                     and summary too for a move; SPEC holds only "relink", "move" and newconvs for the
                                     move, or is {} after bootstrap --rollback refiled the summary (it writes both). Writes RUNDIR/out/manifest.json and the documents it names, then advances
                                     WORK's threading (and summary), keeping the previous WORK in WORK/prev.
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
  catchup.py days WORK RUNDIR [--backfill] [--max=N]
                                     The days to digest (F16), each day's messages in RUNDIR/out/days/<day>.txt. RUNDIR
                                     holds step 5's chunks and `list digests` (a digests/ folder, empty if need be). A
                                     refresh: finished days after the newest digest (none yet: the newest finished day),
                                     and a day digested before a later day was stored that gained messages since (once),
                                     oldest first, 3 at most. --backfill: finished days that need one, newest first, up to
                                     10 days (or N) and 2,000 messages.
  catchup.py digests WORK RUNDIR SPEC
                                     The backfill's write: SPEC is {"digests": {...}} alone. Saves the listed month
                                     documents in RUNDIR/out/backup/ and writes RUNDIR/out/manifest.json; WORK doesn't move.
  catchup.py check-digests WORK RUNDIR AFTERDIR
                                     After that write, AFTERDIR = a fresh `list digests`: every day the backup held is
                                     unchanged, every day written is there, and how many days still need one.
                                     The refresh skill's references/digests.md has both procedures.
LAYOUT (v1.17). A database document holds at most 256 KiB, so threading and summary are collections of documents:
  threading/current {layout:2, block, blocks:[ids], to, note, builtAt, rev, summaryRev?, convs:[conversations with no
                   messages yet]}
  threading/b<start>-<hash> {start, convs:[{id,title}] starting in the block, members:{conv:[i...]}, links:{i:[p,t]}}
  summary/current {layout:2, block, blocks:[ids], activeFrom, version, toI, generatedAt, rev, fromI?, mentionsNote?,
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
  rev: every write puts one new revision token in both `current` documents (a relink with no move writes only
  threading, naming summary's rev in summaryRev). Bootstrap refuses a pair from different writes (one that only
  partly landed) unless it fits together, and a build or relink refuses a database whose rev isn't the one WORK was
  built from.
SPEC (JSON): {"join":{"convid":[i,...]}, "links":{"i":[parent,"r|rq|rg|i|c"] or null for no link},
  "newconvs":[{"id","title","tag","outcome","key":[...]}], "bullets":{"convid":[["text",[refs]],...]},
  "outcome":{"convid":"..."}, "key":{"convid":[...]}, "deals":[{kind,tag,conv,text,links?,refs,claims?,status?,statusAt?}],
  "dealEdit":{"convid":{"text":"...","addRefs":[...],"addClaims":[{i,who,n}],"removeClaims":[i],
  "status":"sold"|"pending"|null,"statusAt":i,"index":n,"ref":i}} (index or ref only when the conv has several deals;
  ref: a message of the deal; index is refused where the same spec moves or adds deals), "open":[{conv,ask,to,note}], "closeOpen":[ask,...],
  "answered":[{conv,ask,answer,refs}], "mentions":[{"note","refs":[[i],...]}],
  "digests":{"YYYY-MM-DD":[["text",[refs]],...]} (a finished day's digest: 1-8 bullets of at most 15 words and 240
  bytes, one line of plain text each, citing 1-10 stored messages of that day by their date label d (the browser's
  zone; a day never goes back); a day that has one is refused unless that one isn't final (written before a later day
  was stored) and the day gained messages; written to digests/m<YYYY-MM>, pinned when that month exists),
  "relink":{"i":[parent,type] or null} (relink: messages an earlier build threaded; null removes the link),
  "move":{"i":"convid" or "new"} (a built message and its Messenger replies (r, rq, rg) into another conversation: an
  existing one, one in newconvs, or "new"; its own link must end up in that conversation or null. Messages linked to
  it by a guess (i, c) stay, re-pointed to its old parent: printed as LEFT. A conversation left empty is dropped (DROP
  prints its title, tag and outcome) and its summary items go along, otherwise the items whose messages all moved)}
Link defaults per new message: Messenger reply link (pi / pmid) -> 'r' ('rq' if matched by quote in-browser);
else quote match against stored history (same author + first 20 chars, latest wins) -> 'rq';
reply to a photo with no Messenger link -> latest photo by that author, 'rg' + a CHECK warning;
a reply whose parent can't be found -> no link (WARN);
else 'c' if same author as the previous member of its conversation, otherwise 'i' to that member (printed as GUESS
for review; none if that member is over 3 h older -> ROOT). Override any GUESS in "links" and rebuild.
A link whose parent sits in another conversation prints a WARN (the page would show it as a new thread).
A deal may carry claims [{i, who: f of message i, n: count, default 1}] ordered by i, and status "sold"|"pending" with
statusAt (the message that closed it). In a chat whose meta/chat.topic or threadName suggests buying, selling or
trading, a short claim ("In", "in for 2", "In x2", "Dibs", "Sold", "PM'd", ...) prints REACT? i (who: "text") -> up to
3 posts it may react to, by others in the 3 days before: photo posts and open deals' messages first, then text offers,
newest first in each; a raffle post is marked "(raffle)". The seller's own "Sold", "SPF" or "pending" (with a short
tail) after their own post prints CLOSE?. These lines only inform: nothing is linked. A build on a chat with no
meta/chat.topic prints a NOTE to set it."""

import json, sys, re, os, glob, collections, shutil, datetime, hashlib, copy, time


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


def _known_layout(cur, name):
    """1 (no `layout`: the single document before v1.17) or 2 (block documents). A layout this catchup.py doesn't know
    was written by a newer copy of the skill: stop, rather than read (and later rewrite) it as the old layout."""
    v = (cur or {}).get("layout")
    assert v in (None, 2), (
        "%s/current has layout %r, which this catchup.py doesn't know: a newer copy of the skill wrote it. Write "
        "nothing, and tell the user to update the plugin (references/troubleshooting.md)" % (name, v)
    )
    return 2 if v == 2 else 1


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
    _known_layout(docs["current"], c)
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
    if cur is None or _known_layout(cur, "threading") != 2:
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
    if cur is None or _known_layout(cur, "summary") != 2:
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
    # digests/m<month> keep their ids: always written, first (pinned when the listing holds them: _pins)
    creates = [p for p in sorted(docs) if coll(p) == "digests"]
    creates += [
        p for p in sorted(docs) if coll(p) != "digests" and did(p) != "current" and did(p) not in listing[coll(p)]
    ]
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


def _pins(docs, listing):  # the documents written over an existing one: `current`, and digest months already there
    return {
        p
        for p in docs
        if p.endswith("/current") or p.startswith("digests/") and p.split("/")[1] in listing.get("digests", {})
    }


def _write_out(out, docs, batches, cleanup, merged, pins=None):
    """OUT/<collection>/<id>.json for each document to write, OUT/manifest.json, and OUT/merged/ (for checking only).
    Clears what an earlier build or an older catchup.py left there, its single threading.json and summary.json too.
    pins: the documents written with if_version (default: the `current` documents)."""
    pins = pins if pins is not None else {p for p in docs if p.endswith("/current")}
    for x in ("threading", "summary", "merged", "digests"):
        shutil.rmtree(os.path.join(out, x), ignore_errors=True)
    for x in ("threading.json", "summary.json", "manifest.json"):
        if os.path.exists(os.path.join(out, x)):
            os.remove(os.path.join(out, x))
    entry = lambda p: dict(
        {"op": "set", "collection": p.split("/")[0], "doc_id": p.split("/")[1]},
        file_path=os.path.abspath(os.path.join(out, p + ".json")),
        **({"pin": True} if p in pins else {}),
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


SEEN = {"threading": ("to", "builtAt", "rev"), "summary": ("toI", "generatedAt", "rev")}


def _stamp(t, s, srev=None):
    """A revision token shared by both `current` documents of one write (seconds, then a random part), so bootstrap
    can tell a write that only partly landed and _fresh any other writer. A relink with no move writes only
    threading: its `summaryRev` names the summary it goes with."""
    rev = "%x-%s" % (int(time.time()), os.urandom(3).hex())
    t["rev"] = rev
    t.pop("summaryRev", None)
    if s is not None:
        s["rev"] = rev
    elif srev:
        t["summaryRev"] = srev


def _fresh(listing, lay):  # the database's `current` must still be the one WORK was bootstrapped or built from
    for c, docs in listing.items():
        db, mine = docs["current"], lay["seen"][c]
        assert all(db.get(f) == mine.get(f) for f in SEEN[c]), (
            "%s/current changed since WORK was bootstrapped (%s): another session built. Bootstrap WORK again from a "
            "fresh fetch, then build"
            % (c, ", ".join("%s %s, WORK has %s" % (f, db.get(f), mine.get(f)) for f in SEEN[c]))
        )


def _record(lay, docs):  # what the database holds once this write lands: what its `current` documents name
    if "summary/current" in docs:
        lay.pop("repair", None)
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


# Short reactions and claims in buy/sell chats (F19): the build flags them (REACT?, CLOSE?), Claude decides.

TRADE_TOPIC = re.compile(
    r"\b(buy\w*|sell\w*|sale|sales|trad(e|es|ing)|swap\w*|wts|wtb|wtt|bst|b/s/t|marketplace|classifieds?|paffles?|raffles?)\b",
    re.I,
)
NUMS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}
CLAIM_RE = re.compile(
    r"^(?:(?:i'?m |i am )?in(?:(?: for)? x?(\d{1,2})| for (one|two|three|four|five))?"
    r"|dibs|mine|i'?ll take it|i will take it|sold|pm'?d|pm sent|dm'?d|dm'?ed|dm sent|(?:i'?m |i am )?interested)"
    r"(?: please| pls| plz)?$"
)
CLOSE_RE = re.compile(r"^(?:sold|spf|pending|sale pending)\b(?! out).{0,25}$")
WANT_RE = re.compile(r"\b(wtb|iso|looking for|anyone (selling|have|got))\b", re.I)
OFFER_RE = re.compile(
    r"^\s*fs\b|\b(wts|wtt|fs/ft|fsot|ft/fs|for sale|for trade|selling|up for grabs|free to a good home|price drop|"
    r"paffle|raffle|group buy|obo|anyone interested|first come|"
    r"(let me know|lmk|dm me|pm me) if (you'?re |you are |anyone'?s |anyone is |anybody'?s |anybody is )?interested|"
    r"if (you'?re |you are |anyone'?s |anyone is )?interested)\b",
    re.I,
)
PRICE_RE = re.compile(r"\$\s?\d|\b\d+(\.\d\d)?\s?(shipped|obo|usd|bucks|firm|ppd)\b|\b(asking|price)[:\s]+\$?\d", re.I)
PAID_RE = re.compile(r"\b(i paid|paid|spent|cost me|(got|bought) (it|mine|one|them) for)\b", re.I)
RAFFLE_RE = re.compile(r"\b(paffles?|raffles?)\b", re.I)
REACT_DAYS = 3
REACT_MAX = 3


def trade_topic(*names):
    """meta/chat.topic or threadName suggests buying, selling or trading: only then are short claims flagged."""
    return any(TRADE_TOPIC.search(x or "") for x in names)


def _claim_text(b):  # trimmed, any case, emoji and punctuation dropped ("I’m in!! 🙋" -> "i'm in"); '#' kept
    s = re.sub("[\U0001f000-\U0001faff☀-➿️‍]", " ", b or "").replace("’", "'").lower()
    s = re.sub(r"[^\w#' ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip(" '")


def claim_word(b):
    """A short claim or reaction ("In", "I'm in", "in for 2", "In x2", "Dibs", "Mine", "I'll take it", "Sold", "PM'd",
    "DM sent", "I'm interested", optionally "please") -> its count (1 unless one is given), else None. Raffle spot
    claims ("#7", "in for 2 spots") and anything longer are not claims."""
    x = CLAIM_RE.match(_claim_text(b))
    if not x:
        return None
    k = x.group(1) or x.group(2)
    return 1 if k is None else NUMS.get(k) or int(k) or None


def close_word(b):
    """A seller closing their own offer: "Sold", "SPF", "pending", with a short tail ("Sold to Ben", "SPF Ben",
    "Sold, thanks all", "pending pickup", "sold ppu") -> "sold" | "pending". "Sold out…" is not one."""
    s = _claim_text(b)
    if not CLOSE_RE.match(s):
        return None
    return "pending" if re.match(r"^(spf|pending|sale pending)\b|^sold (pending|ppu)\b", s) else "sold"


def looks_like_offer(m):
    """A post that offers something: offer words (WTS, for sale, raffle, "let me know if you're interested…"), or a
    price ("$80", "80 shipped", "asking 80"). A request (WTB, "anyone selling…?") or what someone paid is not one."""
    b = m.get("b") or ""
    if WANT_RE.search(b):
        return False
    return bool(OFFER_RE.search(b) or PRICE_RE.search(b) and not PAID_RE.search(b))


def _same_person(a, b):  # by full name when both messages carry one, so two people shown as "Ben" are told apart
    return a.get("fn") == b.get("fn") if a.get("fn") and b.get("fn") else a["f"] == b["f"]


def react_candidates(m, pool, open_refs, own=False):
    """The posts a short claim may react to: messages within REACT_DAYS before it (by timestamp) that are a photo post,
    belong to an open deal, or look like an offer, by someone else (own=True: by its author). Photos and open deals
    rank before text-only offers, newest first within each; at most REACT_MAX. Claims and closes are never posts."""
    found = []
    for k in range(m["i"] - 1, max(m["i"] - 5000, -1), -1):
        P = pool.get(k)
        if P is None:
            continue
        if _min(m) - _min(P) > REACT_DAYS * 1440:
            break
        if _same_person(P, m) != own or claim_word(P.get("b")) or close_word(P.get("b")):
            continue
        if P.get("p") or k in open_refs:
            found.append((0, -k))
        elif looks_like_offer(P):
            found.append((1, -k))
    return [-k for _, k in sorted(found)[:REACT_MAX]]


def _flag_reactions(ids, pool, deals, links):
    """REACT? i (who: "text") -> candidates: a short claim in a buy/sell chat, with the posts it may react to; a
    raffle post is marked "(raffle)" (a reaction to it is a spot claim). CLOSE? i: the seller's own "Sold"/"SPF"/
    "pending" after their own post. Lines only; nothing is linked."""
    open_refs = {r for d in deals if not d.get("status") for r in _nums(d.get("refs") or [])}
    raffles = {r for d in deals if d.get("kind") == "raffle" for r in _nums(d.get("refs") or [])}
    name = lambda k: "%d (raffle)" % k if k in raffles or RAFFLE_RE.search(pool[k].get("b") or "") else str(k)
    for i in ids:
        m = pool[i]
        n, how = claim_word(m.get("b")), close_word(m.get("b"))
        if n is None and how is None:
            continue
        said = '%s: "%s"' % (m["f"][:12], (m.get("b") or "").strip()[:30])
        mine = react_candidates(m, pool, open_refs, own=True) if how else []
        L = links.get(str(i))
        via = " (Messenger reply to %d)" % L[0] if L and L[1] in ("r", "rq", "rg") else ""
        own = ", ".join(map(name, mine))
        if n is not None:  # "Sold" is both: a claim from a buyer, a close from the seller
            c = react_candidates(m, pool, open_refs)
            print(
                "REACT? %d (%s) -> %s%s%s"
                % (
                    i,
                    said,
                    ", ".join(map(name, c)) or "none within 3 days",
                    via,
                    " | own posts %s: the seller closing?" % own if own else "",
                )
            )
        elif mine:
            print("CLOSE? %d (%s) -> own %s%s" % (i, said, own, via))


DEAL_STATUS = ("sold", "pending")


def _msg_no(i, pool):  # a stored message number (not a bool)
    return isinstance(i, int) and not isinstance(i, bool) and i in pool


def _check_deal(d, pool):
    """A deal's optional claims [{i, who, n}] (ordered by i; n defaults to 1) and status ("sold" | "pending", with
    statusAt, the message that closed it)."""
    cl = d.get("claims")
    if cl is not None:
        assert isinstance(cl, list), ("deal claims must be a list of {i, who, n}", d.get("conv"))
        for c in cl:
            assert isinstance(c, dict) and set(c) <= {"i", "who", "n"}, ("a claim is {i, who, n}", d.get("conv"), c)
            i = c.get("i")
            assert _msg_no(i, pool), ("claim i must be a stored message", d.get("conv"), c)
            assert c.get("who") == pool[i]["f"], (
                "claim who must be the name stored on message #%d (%r)" % (i, pool[i]["f"]),
                d.get("conv"),
                c,
            )
            n = c.setdefault("n", 1)
            assert isinstance(n, int) and not isinstance(n, bool) and n > 0, (
                "claim n must be a positive whole number",
                d.get("conv"),
                c,
            )
        ii = [c["i"] for c in cl]
        assert len(set(ii)) == len(ii), (
            "a message claims a deal only once (to change one, removeClaims it and add it again)",
            d.get("conv"),
            ii,
        )
        cl.sort(key=lambda c: c["i"])
    if "status" in d or "statusAt" in d:
        assert d.get("status") in DEAL_STATUS, ("deal status is sold or pending", d.get("conv"), d.get("status"))
        assert _msg_no(d.get("statusAt"), pool), (
            "deal statusAt must be the stored message that closed it",
            d.get("conv"),
            d.get("statusAt"),
        )


def _deal_list(ds):  # a conversation's deals with the index dealEdit takes
    return "; ".join('%d "%s" (refs %s)' % (k, d.get("text", "")[:30], d.get("refs")) for k, d in enumerate(ds))


def _deal_edit(d, e, pool, cid):
    """One dealEdit's claims and status (text and addRefs are applied by build)."""
    for f in ("addClaims", "removeClaims"):
        assert isinstance(e.get(f, []), list), ("dealEdit %s must be a list" % f, cid, e.get(f))
    have = [c.get("i") for c in d.get("claims") or [] if isinstance(c, dict)]
    for i in e.get("removeClaims", []):
        assert i in have, ("dealEdit removeClaims: #%s isn't among the deal's claims %s" % (i, have), cid)
    if "removeClaims" in e:
        d["claims"] = [c for c in d.get("claims") or [] if c.get("i") not in e["removeClaims"]]
    if e.get("addClaims"):  # in message order; _check_deal refuses a message that claims twice
        d["claims"] = list(d.get("claims") or []) + e["addClaims"]
    if "statusAt" in e:
        assert e.get("status"), ("dealEdit statusAt needs status", cid)
    if "status" in e and e["status"] is None:  # reopened
        d.pop("status", None)
        d.pop("statusAt", None)
    elif "status" in e:
        assert "statusAt" in e, (
            'dealEdit status needs statusAt: the message that closed it ("status": null reopens)',
            cid,
        )
        d["status"], d["statusAt"] = e["status"], e["statusAt"]
    _check_deal(d, pool)


def _relink(t, sp, stored, base):  # correct the link on messages an earlier build already threaded; -> their numbers
    done = []
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
        done.append(i)
    return done


def _cross_warn(t, ids):  # after any move: a relinked message whose parent sits in another conversation
    conv = {i: c["id"] for c in t["convs"] for i in c["members"]}
    for i in ids:
        L = t["links"].get(str(i))
        if L and conv.get(i) and conv.get(L[0]) and conv[i] != conv[L[0]]:
            print(
                "WARN link %d -> %d crosses conversations (%s -> %s); the page shows %d as a new thread"
                % (i, L[0], conv[i], conv[L[0]], i)
            )


def _newconvs(t, s, sp):  # the spec's new conversations, in threading and summary; -> {id: threading conversation}
    C = {cv["id"]: cv for cv in t["convs"]}
    for nc in sp.get("newconvs", []):
        assert nc["id"] not in C and nc["id"] != "new", ("conv id exists", nc["id"])
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
    return C


def _merge_by_ref(a, b):
    """Bullets b joined into a, each list's order kept, b's placed by the messages they cite (a running maximum, so
    bullets without refs stay next to the ones before them)."""
    ka = _runmax([max(_nums(x.get("refs") if isinstance(x, dict) else []) or [-1]) for x in a], False)
    kb = _runmax([max(_nums(x.get("refs") if isinstance(x, dict) else []) or [-1]) for x in b], False)
    out, j = [], 0
    for x, k in zip(a, ka):
        while j < len(b) and kb[j] < k:
            out.append(b[j])
            j += 1
        out.append(x)
    return out + b[j:]


REPLY_TYPES = ("r", "rq", "rg")  # a Messenger reply; `i` and `c` are the build's or Claude's guesses


def _move(t, s, sp, stored, base, before):
    """`move` {"<i>": "<conv id>" | "new"}: put messages an earlier build threaded into another conversation, with the
    Messenger replies (r, rq, rg) threaded under them in their old one. A guessed link (i, c) never drags a message
    along: such a child stays, re-pointed to the moved message's old parent (LEFT lines), so Claude can move the ones
    that belong with it. Summary items follow: a conversation left with no messages is dropped and everything of it
    goes along; otherwise only the items whose messages all moved go along, and the others lose the refs that moved.
    `before` is the links as they were before this spec's relinks. -> (groups moved, {dropped conversation: target})"""
    mv = sp.get("move") or {}
    if not mv:
        return 0, {}, set()
    T = {c["id"]: c for c in t["convs"]}
    S = {c["id"]: c for c in s["convs"]}
    ids = set(T) | set(S)
    where = {i: c["id"] for c in t["convs"] for i in c["members"]}
    kids = collections.defaultdict(list)
    for k, L in t["links"].items():
        kids[L[0]].append((int(k), L[1]))
    moved, plan = {}, []  # moved: {message: (old conversation, new conversation)}
    for k in sorted(mv, key=lambda k: int(k)):
        i, dest = int(k), mv[k]
        assert i in stored and i <= base, (
            "move #%d: only messages already built (through #%d); use join for new ones"
            % (
                i,
                base,
            )
        )
        assert i not in moved, (
            "move #%d: it already moves with #%d, as a Messenger reply to it. Move only #%d, or relink #%d (null) in "
            "the same spec to move it on its own" % (i, next(r for r, _, _, g in plan if i in g), i, i)
        )
        old = where.get(i)
        assert old, "move #%d: it isn't in any conversation" % i
        if dest == "new":
            dest = "mv%d" % i
            while dest in ids:
                dest += "x"
            ids.add(dest)
            title = re.sub(r"\s+", " ", (stored[i].get("b") or "").strip())[:40] or _short(stored[i])
            T[dest] = {"id": dest, "title": title, "members": []}
            t["convs"].append(T[dest])
            print(
                'NEW conversation %s "%s" (to give it a title and tag, list it in newconvs and move into it)'
                % (dest, title)
            )
        assert dest in T, 'move #%d: no conversation "%s" (an existing id, one in this spec\'s newconvs, or "new")' % (
            i,
            dest,
        )
        assert dest != old, "move #%d: it's already in %s" % (i, dest)
        group, todo = {i}, [i]
        while todo:
            for c, ty in kids[todo.pop()]:
                if ty in REPLY_TYPES and where.get(c) == old and c not in group:
                    group.add(c)
                    todo.append(c)
        for x in group:
            moved[x] = (old, dest)
        plan.append((i, old, dest, group))
    for i, old, dest, group in plan:
        T[old]["members"] = [x for x in T[old]["members"] if x not in group]
        T[dest]["members"] = sorted(T[dest]["members"] + list(group))
        rest = sorted(group - {i})
        print(
            "MOVE %d%s %s -> %s"
            % (i, " (with its Messenger replies %s)" % ", ".join(map(str, rest)) if rest else "", old, dest)
        )
    where = {i: c["id"] for c in t["convs"] for i in c["members"]}
    for i, old, dest, group in plan:  # guessed children that stay: re-pointed to the moved message's old parent
        L0 = before.get(str(i))
        up = L0[0] if L0 and where.get(L0[0]) == old else None
        for x in sorted(group):
            for c, ty in sorted(kids[x]):
                if ty in REPLY_TYPES or c in moved or where.get(c) != old or str(c) in sp.get("relink", {}):
                    continue
                if up is None:
                    del t["links"][str(c)]
                    print("LEFT %d (%s -> %d), now unlinked: move it too if it goes with %d" % (c, ty, x, i))
                else:
                    t["links"][str(c)] = [up, "c" if _same_person(stored[c], stored[up]) else "i"]
                    print("LEFT %d (%s -> %d), now -> %d: move it too if it goes with %d" % (c, ty, x, up, i))
    for i, old, dest, group in plan:
        L = t["links"].get(str(i))
        assert not L or where.get(L[0]) == dest, (
            "move #%d: its link points to #%d in %s, not in %s. Add a relink for #%d in the same spec: to a message in "
            "%s, or null" % (i, L[0], where.get(L[0]), dest, i, dest)
        )
    # the summary: items follow their messages
    for cid in {d for _, _, d, _ in plan}:
        if cid not in S:  # a new conversation, or one whose summary a session before v1.17 dropped
            S[cid] = {"id": cid, "tag": "", "synopsis": [], "outcome": "", "key": []}
            s["convs"].append(S[cid])
    dropped, gained = {}, set()
    for old in sorted({o for _, o, _, _ in plan}):
        gone = {x: d for x, (o, d) in moved.items() if o == old}
        empty = not T[old]["members"]
        first = gone[min(gone)]  # where the whole conversation goes when it's left empty
        told = collections.defaultdict(collections.Counter)

        def home(refs, lead=None):
            """Where an item with these refs goes (None: it stays), and the refs it keeps there."""
            refs = _nums(refs)
            if lead is not None:  # a question follows the message that asks it
                d = gone.get(lead)
            elif refs and all(r in gone for r in refs):
                d = gone[min(refs)]
            else:
                d = first if empty else None
            # only refs that moved away from the item go: one that was never in this conversation is left as it was
            stays = set(T[old]["members"])
            keep = [r for r in refs if (gone[r] == d if r in gone else not (d and r in stays))]
            return d, keep

        def note(d, what, refs, keep):
            if d:
                told["to " + d][what] += 1
            if len(keep) < len(_nums(refs)):
                told["refs %s dropped from" % ", ".join(map(str, sorted(set(_nums(refs)) - set(keep))))][what] += 1

        sc = S.get(old)
        if sc is not None:
            syn = _syn_items(sc.get("synopsis"))
            stay, go = [], collections.defaultdict(list)
            for b in syn:
                d, keep = home(b.get("refs") or [])
                note(d, "bullet", b.get("refs") or [], keep)
                b = dict(b, refs=keep)
                (go[d] if d else stay).append(b)
            texts = {x.get("t") for x in _syn_items(S[first].get("synopsis")) + go.get(first, [])}
            if (
                empty
                and sc.get("outcome")
                and S[first].get("outcome")
                and sc["outcome"] not in texts | {S[first]["outcome"]}
            ):
                go[first].append({"t": sc["outcome"], "refs": [max(x for x, d in gone.items() if d == first)]})
                told["to " + first]["outcome as a bullet"] += 1
            for d, bs in go.items():
                S[d]["synopsis"] = _merge_by_ref(_syn_items(S[d].get("synopsis")), bs)
            if go or isinstance(sc.get("synopsis"), list):
                sc["synopsis"] = stay
            for r in list(sc.get("key") or []):
                d = gone.get(r) or (first if empty else None)
                if d:
                    sc["key"].remove(r)
                    if r in gone and r not in (S[d].get("key") or []):
                        S[d]["key"] = list(S[d].get("key") or []) + [r]
                        told["to " + d]["key"] += 1
            if empty:
                for f in ("tag", "outcome"):
                    if sc.get(f) and not S[first].get(f):
                        S[first][f] = sc[f]
                        told["to " + first][f] += 1
        for name in ("open", "answered"):
            for o in s[name]:
                if o.get("conv") != old:
                    continue
                refs = list(o.get("refs") or [])
                d, keep = home([o["ask"]] + refs, o["ask"])
                note(d, name, [o["ask"]] + refs, keep)
                if d:
                    o["conv"] = d
                if "refs" in o:
                    o["refs"] = [r for r in refs if r in keep]
        for dl in s["deals"]:
            if dl.get("conv") != old:
                continue
            d, keep = home(dl.get("refs") or [])
            note(d, "deal", dl.get("refs") or [], keep)
            if d:
                dl["conv"] = d
                gained |= {d, old}
            dl["refs"] = keep
        if empty:
            t["convs"] = [c for c in t["convs"] if c["id"] != old]
            if sc is not None:
                assert not sc["synopsis"] and not sc.get("key"), (
                    "internal error: items left in a dropped conversation",
                    old,
                )
                s["convs"] = [c for c in s["convs"] if c["id"] != old]
            dropped[old] = first
            print(
                'DROP %s (title "%s", tag "%s", outcome "%s"): no messages left; its summary went to %s'
                % (old, T[old].get("title", ""), (sc or {}).get("tag", ""), (sc or {}).get("outcome", ""), first)
            )
        for k, c in told.items():
            what = ", ".join(
                "%d %s%s" % (n, w, "s" * (n > 1 and w in ("bullet", "deal"))) for w, n in sorted(c.items())
            )
            print(
                "  moved %s %s: %s" % (k, "from " + old, what)
                if k.startswith("to ")
                else "  %s %s: %s" % (k, old, what)
            )
    for d in sorted(gained):  # the indexes a dealEdit would use from now on, where a deal moved in or out
        print("  deals in %s now: %s" % (d, _deal_list([x for x in s["deals"] if x.get("conv") == d]) or "none"))
    return len(plan), dropped, {c for _, o, d, _ in plan for c in (o, d)}


def _check_summary(t, s, pool):  # every summary ref belongs to its conversation; deals' claims and status
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
        _check_deal(d, pool)
    return cm


def _problems(t, s):
    """What a build's _check_summary would refuse in this pair, as messages (never raises): a summary item whose
    conversation threading lacks, or whose refs lie outside its conversation."""
    cm = {cv["id"]: set(cv["members"]) for cv in t.get("convs", [])}
    out = []
    for cv in s.get("convs", []):
        mem = cm.get(cv.get("id"))
        refs = list(cv.get("key") or []) + [
            r for b in cv.get("synopsis") or [] if isinstance(b, dict) for r in b.get("refs") or []
        ]
        if refs and (mem is None or not all(r in mem for r in refs)):
            out.append("%s's bullets or key messages lie outside it" % cv.get("id"))
    for name in ("open", "answered"):
        for o in s.get(name, []):
            mem = cm.get(o.get("conv"))
            if mem is None or not all(r in mem for r in [o.get("ask")] + list(o.get("refs") or [])):
                out.append("%s #%s isn't in %s" % (name, o.get("ask"), o.get("conv")))
    for d in s.get("deals", []):
        if d.get("conv") not in cm:
            out.append("a deal's conversation %s isn't in threading" % d.get("conv"))
    return out


def _heal(t, s):
    """Make the summary fit threading, which says where each message is: every item goes to the conversation that
    holds its messages (refs outside it dropped from the item, never the item), and a summary conversation threading
    lacks is dropped once nothing of it is left (its tag and outcome go along). -> what was refiled"""
    where = {i: cv["id"] for cv in t["convs"] for i in cv["members"]}
    cm = {cv["id"]: set(cv["members"]) for cv in t["convs"]}
    S = {c["id"]: c for c in s["convs"]}
    n, went = collections.Counter(), {}  # went: {summary conversation: where its first refiled item went}

    def conv(cid):
        if cid not in S:
            S[cid] = {"id": cid, "tag": "", "synopsis": [], "outcome": "", "key": []}
            s["convs"].append(S[cid])
        return S[cid]

    def home(cid, refs):  # where an item of cid with these refs belongs
        refs = _nums(refs)
        if cid in cm and all(r in cm[cid] for r in refs):
            return cid
        if cid in cm and any(r in cm[cid] for r in refs):
            return cid  # mostly here: it stays, losing the refs elsewhere
        placed = [where[r] for r in refs if r in where]
        return placed[0] if placed else cid

    for cv in list(s["convs"]):
        cid, syn = cv["id"], cv.get("synopsis")
        if isinstance(syn, list):
            keep = []
            for b in _syn_items(syn):
                d = home(cid, b.get("refs") or [])
                b = dict(b, refs=[r for r in b.get("refs") or [] if r in cm.get(d, ())]) if d in cm else b
                if d == cid:
                    keep.append(b)
                else:
                    went.setdefault(cid, d)
                    conv(d)["synopsis"] = _merge_by_ref(_syn_items(conv(d).get("synopsis")), [b])
                    n["bullets"] += 1
            cv["synopsis"] = keep
        for r in list(cv.get("key") or []):
            if r not in cm.get(cid, ()):
                cv["key"].remove(r)
                if r in where:
                    went.setdefault(cid, where[r])
                if r in where and r not in (conv(where[r]).get("key") or []):
                    conv(where[r])["key"] = list(conv(where[r]).get("key") or []) + [r]
                n["key messages"] += 1
    for name in ("open", "answered"):
        for o in s[name]:
            mem = cm.get(o.get("conv"))
            if mem is None or o.get("ask") not in mem:
                if o.get("ask") in where:
                    o["conv"] = where[o["ask"]]
                    conv(o["conv"])
                    n[name] += 1
            if "refs" in o and o.get("conv") in cm:
                o["refs"] = [r for r in o["refs"] if r in cm[o["conv"]]]
    for d in s["deals"]:
        if d.get("conv") not in cm:
            placed = [where[r] for r in _nums(d.get("refs") or []) if r in where]
            if placed:
                d["conv"] = placed[0]
                conv(d["conv"])
                n["deals"] += 1
    for cv in list(s["convs"]):  # a conversation threading lacks, with nothing left: dropped, tag and outcome kept
        cid = cv["id"]
        if cid in cm or cv.get("key") or _syn_items(cv.get("synopsis")):
            continue
        if any(o.get("conv") == cid for o in s["open"] + s["answered"]) or any(
            x.get("conv") == cid for x in s["deals"]
        ):
            continue
        s["convs"].remove(cv)
        n["conversations dropped"] += 1
        d = S.get(went.get(cid))
        for f in ("tag", "outcome") if d is not None else ():
            if cv.get(f) and not d.get(f):
                d[f] = cv[f]
            elif f == "outcome" and cv.get(f) and cv[f] != d[f]:
                d["synopsis"] = _syn_items(d.get("synopsis")) + [{"t": cv[f], "refs": []}]
    last = {cv["id"]: max(cv["members"]) for cv in t["convs"] if cv["members"]}
    s["convs"].sort(key=lambda c: -last.get(c["id"], 0))
    return ", ".join("%d %s" % (v, k) for k, v in sorted(n.items())) or "nothing"


def relink(work, run, specp):
    """`catchup.py relink`: correct links (relink) and conversations (move) of messages already built."""
    global TZ
    sp = _load(specp)
    lay = _layout(work)
    assert (
        set(sp) <= {"relink", "move", "newconvs"}
        and (sp.get("relink") or sp.get("move") or lay.get("repair") and not sp)
        and (sp.get("move") or "newconvs" not in sp)
    ), (
        'relink SPEC takes only a non-empty "relink" and/or "move" (newconvs only for a move; {} only to write what '
        "bootstrap --rollback refiled; use build for the rest)"
    )
    for nc in sp.get("newconvs", []):
        assert nc.get("id") in (sp.get("move") or {}).values(), (
            "newconvs %s: no move in this spec puts a message in it, so it would stay empty" % nc.get("id")
        )
    st = _load(work + "/state.json")
    TZ = st.get("tz") or TZ
    both = sp.get("move") or lay.get("repair")  # a move, or a summary bootstrap refiled: write both documents
    colls = ("threading", "summary") if both else ("threading",)
    listing = {c: _listing(run, c) for c in colls}  # a fresh read: which blocks exist, and that WORK is current
    _fresh(listing, lay)
    t = _load(work + "/base/threading.json")
    s = _load(work + "/base/summary.json") if both else None
    stored = {m["i"]: m for m in _load(work + "/all.json")}
    before = copy.deepcopy(t["links"])
    relinked = _relink(t, sp, stored, st["base"])
    moves, dropped, touched = 0, {}, set()
    if sp.get("move"):
        _newconvs(t, s, sp)
        moves, dropped, touched = _move(t, s, sp, stored, st["base"], before)
        seen = collections.Counter(x for cv in t["convs"] for x in cv["members"])
        assert all(v == 1 for v in seen.values()), ("internal error: a message in two conversations", seen)
        _check_summary(t, s, stored)
        last = {c["id"]: max(c["members"]) for c in t["convs"] if c["members"]}
        s["convs"].sort(key=lambda c: -last.get(c["id"], 0))
    _cross_warn(t, relinked)
    _note(t)
    t["builtAt"] = _ts()
    _stamp(t, s, _load(work + "/base/summary.json").get("rev"))
    merged = {"threading": t}
    if s is not None:
        s["generatedAt"] = t["builtAt"]  # so a WORK bootstrapped before this write sees that summary/current changed
        merged["summary"] = s
    scur = listing.get("summary", {}).get("current") or {}
    docs = layout_docs(t, s, scur.get("activeFrom", 0) if scur.get("layout") == 2 else 0)
    _roundtrip(docs, t, s)
    batches, cleanup = _plan(docs, listing)
    told = _write_out(run + "/out", docs, batches, cleanup, merged)
    _snapshot(work)
    _dump(t, work + "/base/threading.json")
    if s is not None:
        _dump(s, work + "/base/summary.json")
    _dump(_record(lay, docs), work + "/base/layout.json")
    if touched:  # the next build refuses a dealEdit "index" there: deals may have changed places since they were read
        _dump(dict(st, moved=sorted(set(st.get("moved") or []) | touched)), work + "/state.json")
    print(
        "relink ok: %d change(s)%s. Write it as in step 7: %s"
        % (
            len(sp.get("relink") or {}),
            ", %d move(s)%s" % (moves, ", dropped %s" % ", ".join(sorted(dropped)) if dropped else "") if moves else "",
            told,
        )
    )


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
    tr, sr, paired, repair = th.get("rev"), sm.get("rev"), "", False
    if (tr or sr) and not (tr and sr and sr in (tr, th.get("summaryRev"))):
        # the pair comes from different writes (or only one carries a rev: the first write after v1.23 that only
        # partly landed, or a relink on a page from before it): fine if it fits together, as a build would check
        bad = _problems(th, sm)
        if bad and rollback:
            healed, repair = _heal(th, sm), True
            assert not _problems(th, sm), ("internal error: the summary still doesn't fit threading", _problems(th, sm))
            paired = (
                "; threading/current and summary/current came from different writes and didn't fit together: filed %s "
                "under the conversations threading has them in (nothing dropped). The next build or relink writes it "
                "(with nothing new to build: catchup.py relink WORK RUN with the spec {}); say so in the report"
                % healed
            )
        else:
            assert not bad, (
                "threading/current and summary/current come from different writes (rev %s and %s) and don't fit "
                "together (%s): the last build, relink, move or restore-summary was only partly applied. Nothing was "
                "changed. If the session that wrote it still has its RUN/out/manifest.json, send the rest of its last "
                "batch again (pinned with fresh versions), then bootstrap again. Otherwise run `catchup.py bootstrap "
                "WORK DBDIR --rollback`: it files the summary's items under the conversations threading has them in, "
                "dropping nothing (references/writing-the-build.md › A partly applied write)"
                % (tr, sr, "; ".join(bad[:3]) + ("; …" if len(bad) > 3 else ""))
            )
            paired = (
                "; threading/current and summary/current come from different writes but fit together: the next write "
                "gives both the same rev (say so in the report)"
            )
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
    if repair:  # WORK's summary was refiled to fit threading: the next write must carry both documents
        lay["repair"] = True
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
        + paired
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
    before = copy.deepcopy(t["links"])
    relinked = _relink(t, sp, byi, base)
    _newconvs(t, s, sp)
    homes = [d["conv"] for d in s["deals"]]
    _, dropped, touched = _move(t, s, sp, byi, base, before)  # before new messages join, so they can join the target
    _cross_warn(t, relinked)
    for k in ("join", "bullets", "outcome", "key", "dealEdit"):
        for cid in sp.get(k) or {}:
            assert cid not in dropped, (
                '%s names %s, which this spec\'s move empties and drops (its summary went to %s): use "%s" instead'
                % (k, cid, dropped.get(cid), dropped.get(cid))
            )
    for k in ("deals", "open", "answered"):
        for x in sp.get(k) or []:
            assert x.get("conv") not in dropped, (
                '%s names %s, which this spec\'s move empties and drops (its summary went to %s): use "%s" instead'
                % (k, x.get("conv"), dropped.get(x.get("conv")), dropped.get(x.get("conv")))
            )
    gained = (  # conversations whose deal indexes changed: a deal moved in or out, a new deal, an earlier move
        {d["conv"] for d, h in zip(s["deals"], homes) if d["conv"] != h}
        | {h for d, h in zip(s["deals"], homes) if d["conv"] != h}
        | {d.get("conv") for d in sp.get("deals", [])}
        | set(st.get("moved") or [])
    )
    C = {cv["id"]: cv for cv in t["convs"]}
    for k in ("bullets", "outcome", "key"):
        for cid in sp.get(k) or {}:
            assert cid in C, ("%s: unknown conv" % k, cid)
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
        keys = ("text", "addRefs", "index", "ref", "addClaims", "removeClaims", "status", "statusAt")
        bad = sorted(set(e) - set(keys))
        assert not bad, ("dealEdit takes %s" % ", ".join(keys), cid, bad)
        assert not ("ref" in e and "index" in e), 'dealEdit %s: "ref" or "index", not both' % cid
        if "ref" in e:  # the deal whose refs hold this message
            pick = [d for d in ds if e["ref"] in (d.get("refs") or [])]
            assert len(pick) == 1, 'dealEdit %s: "ref" %s is in %d of its deals: %s' % (
                cid,
                e["ref"],
                len(pick),
                _deal_list(ds),
            )
            d = pick[0]
        else:
            assert len(ds) == 1 or "index" in e, 'dealEdit: %d deals in %s; add "index" (or "ref"): %s' % (
                len(ds),
                cid,
                _deal_list(ds),
            )
            assert "index" not in e or cid not in gained, (
                "dealEdit %s: a move (in this spec or since WORK was bootstrapped) or new deals changed its deals, so "
                '"index" may name another deal than you read. Name it by "ref" (one of its messages) instead. Its '
                "deals now: %s" % (cid, _deal_list(ds))
            )
            assert isinstance(e.get("index", 0), int) and 0 <= e.get("index", 0) < len(ds), (
                'dealEdit %s: no deal at "index" %s: %s' % (cid, e.get("index"), _deal_list(ds))
            )
            d = ds[e.get("index", 0)]
        if "text" in e:
            d["text"] = e["text"]
        assert all(r in cmem(cid) for r in e.get("addRefs", [])), ("dealEdit addRefs must be in the conversation", cid)
        d["refs"] = sorted(set(d.get("refs", []) + e.get("addRefs", [])))
        _deal_edit(d, e, pool, cid)
    s["open"] = sp.get("open", []) + [o for o in s["open"] if o["ask"] not in sp.get("closeOpen", [])]
    s["answered"] = sp.get("answered", []) + s["answered"]
    s["mentions"] = sp.get("mentions", []) + s["mentions"]
    s["toI"] = ids[-1]
    cm = _check_summary(t, s, pool)
    if trade_topic(mt.get("topic"), mt.get("threadName")):  # a buy/sell chat: flag short claims for Claude (F19)
        _flag_reactions(ids, pool, s["deals"], t["links"])
    if not mt.get("topic"):
        print("NOTE meta/chat has no topic: set it once (references/writing-the-build.md › The chat's topic)")
    last = {c: max(m) for c, m in cm.items() if m}
    s["convs"].sort(key=lambda c: -last.get(c["id"], 0))
    a = mt["anchorMids"]
    assert mt["lastI"] == ids[-1] and a[-1] == new[-1]["m"], "meta/chat not updated by import"
    ts = _ts()
    t["builtAt"] = ts
    s["generatedAt"] = ts
    _stamp(t, s)
    scur = listing["summary"]["current"]
    docs = layout_docs(t, s, scur.get("activeFrom", 0) if scur.get("layout") == 2 else 0)
    _roundtrip(docs, t, s)
    digested = _digest_spec(sp, pool, run, docs, listing)  # digests/m<month> documents join docs (first batch)
    # _plan fails here, before anything is written, if a document is too big
    batches, cleanup = _plan(docs, listing)
    told = _write_out(run + "/out", docs, batches, cleanup, {"threading": t, "summary": s}, _pins(docs, listing))
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
        "build ok: #%d-#%d | %s | %s | next STOPS=%s"
        % (ids[0], ids[-1], dict(collections.Counter(joined.values())), digested, json.dumps(st["stops"]))
    )
    print("write: " + told)


# Per-day digests (F16): a few bullets per finished day, citing its messages, for Ask on the page about stretches older
# than its conversation lines reach. One document per month, digests/m<YYYY-MM> {month, days:{"<YYYY-MM-DD>":
# {bullets:[{t, refs}], fromI, toI, n, at, final}}}: a refresh writes one document, or two when its days (DUE_MAX at
# most) cross a month; the page reads a few dozen for years of history; and with the caps below a full month stays
# under 90 KB of the 240 KiB a build allows.

DIGEST_WORDS = 15  # like a conversation bullet
DIGEST_BYTES = 240  # UTF-8 bytes of one bullet's text
DIGEST_BULLETS = 8  # bullets per day
DIGEST_REFS = 10  # messages one bullet cites
DUE_MAX = 3  # days one refresh digests (oldest first); the next refresh carries on
BACKFILL_DAYS = 10  # days per backfill batch (newest first) ...
BACKFILL_MSGS = 2000  # ... and no more messages than this in one batch (one day at least)
DAY_RE = re.compile(r"^\d{4}-\d\d-\d\d$")
CONTROL_RE = re.compile("[\x00-\x1f\x7f-\x9f\u2028\u2029]")  # one bullet is one line in Ask's prompt
MONTH_RE = re.compile(r"^m\d{4}-\d\d$")
NOW = None  # tests: an aware datetime standing in for the clock


def _today():  # the date in the chat's time zone (meta/chat.tz), or None when this Python can't tell
    now = NOW or datetime.datetime.now(datetime.timezone.utc)
    try:
        import zoneinfo

        return now.astimezone(zoneinfo.ZoneInfo(TZ)).date().isoformat()
    except Exception:  # no tz database (or an unknown zone): the machine's clock may be in any zone, so don't guess
        return None


def _days(msgs):
    """{day: [i, ...]}: a message's day is its date label `d`, as the helper read it in the browser's time zone. A day
    never goes back: a message without a label, or dated before the message before it (the browser's zone changed
    between captures), belongs to that message's day, as on the page. So every day is one run of numbers."""
    out, prev = {}, None
    for m in sorted(msgs, key=lambda m: m["i"]):
        d = max(m.get("d") or "", prev or "") or None
        prev = d
        if d:
            out.setdefault(d, []).append(m["i"])
    return out


def _finished_before(days):
    """Every day before this one has finished: a later day is stored, or it's before today in meta/chat.tz. Without a
    tz database only the first counts."""
    t = _today()
    return max(list(days) + ([t] if t else []))


def _digest_listing(run):  # RUN's `list digests`: {doc id: document}
    assert os.path.isdir(run + "/digests"), (
        "%s has no digests/ folder: list the digests collection into it (list, limit 1000). If the collection is "
        "empty and the list leaves no folder, create an empty %s/digests folder (references/digests.md)" % (run, run)
    )
    return {k: v for k, v in _docs(run + "/digests").items() if MONTH_RE.match(k)}


def _digest_index(docs):  # {day: its digest} from the month documents
    return {day: e for k in sorted(docs) for day, e in ((docs[k] or {}).get("days") or {}).items()}


def _needs(e, ids, later):
    """No digest yet; or one written before a later day was stored (not `final`: the browser's zone may still have
    been on that day) whose day gained messages, now that a later day is stored. That second digest is final, so a day
    is digested twice at most, however far meta/chat.tz runs ahead of the browser."""
    if not isinstance(e, dict) or not isinstance(e.get("toI"), int):
        return True
    return not e.get("final") and later and max(ids) > e["toI"]


def _due(msgs, have, backfill=False, most=None):
    """The days to digest, how many more need one after them, and every stored day. A refresh: finished days newer than
    the newest digest (none yet: only the newest finished day; older ones are the backfill's) and any digested day that
    gained messages, oldest first, DUE_MAX at most. A backfill: every finished day that needs one, newest first, up to
    BACKFILL_DAYS days (or `most`) and BACKFILL_MSGS messages."""
    days = _days(msgs)
    edge, last = _finished_before(days), max(days, default="")
    need = [d for d in sorted(days) if d < edge and _needs(have.get(d), days[d], d < last)]
    if backfill:
        out, n = [], 0
        for d in reversed(need):
            if out and (len(out) >= (most or BACKFILL_DAYS) or n + len(days[d]) > BACKFILL_MSGS):
                break
            out.append(d)
            n += len(days[d])
        return out, len(need) - len(out), days
    newest = max(have, default=None)
    fin = [d for d in sorted(days) if d < edge]
    need = [d for d in need if d in have or (d > newest if newest else d == fin[-1])]
    return need[: most or DUE_MAX], max(0, len(need) - (most or DUE_MAX)), days


def _day_line(m):  # one message as Claude reads it to write a digest
    s = "#%d [%s] %s" % (m["i"], m.get("t") or "", m.get("f") or "?")
    if m.get("r"):
        s += " (replying to %s%s)" % (m["r"], ': "%s"' % m["q"][:60] if m.get("q") else "")
    s += ": " + (m.get("b") or "").replace("\n", " ")
    return s + (" [photo]" if m.get("p") else "") + (" [link]" if m.get("a") else "")


def _pool(work, run):  # WORK's messages and this run's import (stored, not built yet)
    msgs = {m["i"]: m for m in _load(work + "/all.json")}
    for f in sorted(glob.glob(run + "/chunks/*.json")):
        for m in _load(f)["msgs"]:
            msgs.setdefault(m["i"], m)
    return msgs


def _bullet(b):  # [text, [refs]] (as conversation bullets) or {t, refs} -> (text, refs)
    if isinstance(b, dict):
        return b.get("t"), b.get("refs")
    return (b[0], b[1]) if isinstance(b, list) and len(b) == 2 else (None, None)


def _digest_entries(sd, pool, have):
    """The spec's `digests` ({"YYYY-MM-DD": [[text, [refs]], ...]}), checked, as the entries to store."""
    assert isinstance(sd, dict) and sd, 'digests: {"YYYY-MM-DD": [["bullet", [refs]], ...]}, one key per day'
    days = _days(pool.values())
    dayof = {i: d for d, ids in days.items() for i in ids}
    edge = _finished_before(days)
    out = {}
    for day in sorted(sd):
        try:
            real = bool(DAY_RE.match(day)) and datetime.date.fromisoformat(day).isoformat() == day
        except ValueError:
            real = False
        assert real, "digests: %r is not a day (YYYY-MM-DD)" % day
        assert day in days, "digests %s: no stored message has that date" % day
        ids, bs = days[day], sd[day]
        assert day < edge, (
            "digests %s: that day hasn't finished in %s (meta/chat.tz) and no later day is stored: digest it at a later "
            "refresh" % (day, TZ)
        )
        assert _needs(have.get(day), ids, day < max(days)), (
            "digests %s: it already has a digest (through #%s) that stays: drop it from the spec (a day is digested "
            "again only once, when it gained messages before the next day began)" % (day, have[day].get("toI"))
        )
        assert isinstance(bs, list) and 1 <= len(bs) <= DIGEST_BULLETS, "digests %s: 1 to %d bullets, as a list" % (
            day,
            DIGEST_BULLETS,
        )
        items = []
        for b in bs:
            t, refs = _bullet(b)
            assert isinstance(t, str) and t.strip(), "digests %s: each bullet is [text, [refs]]: %r" % (day, b)
            assert not CONTROL_RE.search(t), (
                "digests %s: a bullet is one line of plain text (no line breaks or control characters): %r" % (day, t)
            )
            assert len(t.split()) <= DIGEST_WORDS, ("digest bullet over %d words" % DIGEST_WORDS, day, t)
            assert len(t.encode("utf-8")) <= DIGEST_BYTES, ("digest bullet over %d bytes" % DIGEST_BYTES, day, t)
            assert (
                isinstance(refs, list)
                and 1 <= len(refs) <= DIGEST_REFS
                and all(isinstance(r, int) and not isinstance(r, bool) for r in refs)
            ), ("digests %s: each bullet cites 1 to %d message numbers" % (day, DIGEST_REFS), t, refs)
            bad = [r for r in refs if dayof.get(r) != day]
            assert not bad, "digests %s: %s %s not a stored message from that day (#%d-#%d): %r" % (
                day,
                ", ".join("#%d" % r for r in bad),
                "is" if len(bad) == 1 else "are",
                ids[0],
                ids[-1],
                t,
            )
            items.append({"t": t.strip(), "refs": list(dict.fromkeys(refs))})
        out[day] = {"bullets": items, "fromI": ids[0], "toI": ids[-1], "n": len(ids), "at": _ts()}
        out[day]["final"] = day < max(days)  # a later day was already stored: never digested again
    return out


def _digest_docs(entries, listed):  # the month documents to write: each as the listing holds it, plus these days
    docs = {}
    for day in sorted(entries):
        p = "digests/m" + day[:7]
        if p not in docs:
            docs[p] = copy.deepcopy(listed.get(p.split("/")[1]) or {"month": day[:7], "days": {}})
        docs[p]["days"] = dict(sorted(dict(docs[p].get("days") or {}, **{day: entries[day]}).items()))
    return docs


def _digest_spec(sp, pool, run, docs, listing):
    """A build's `digests`: checked, their month documents added to docs and listing. -> a line on what's still due."""
    if not sp.get("digests") and not os.path.isdir(run + "/digests"):
        return "0 digest(s); RUN has no digests/ folder, so what's due is unknown (step 5 lists digests)"
    listed = _digest_listing(run)
    have = _digest_index(listed)
    entries = _digest_entries(sp["digests"], pool, have) if sp.get("digests") else {}
    if entries:
        docs.update(_digest_docs(entries, listed))
        listing["digests"] = listed
    todo, more, _ = _due(pool.values(), dict(have, **entries))
    if not todo:
        return "%d digest(s)" % len(entries)
    return "%d digest(s); still due: %s%s (catchup.py days, references/digests.md)" % (
        len(entries),
        ", ".join(todo),
        " and %d more" % more if more else "",
    )


def days_cmd(work, run, backfill=False, most=None):
    """`catchup.py days WORK RUN [--backfill] [--max=N]`: the days to digest, each written to RUN/out/days/<day>.txt."""
    global TZ
    TZ = _load(work + "/state.json").get("tz") or TZ
    pool = _pool(work, run)
    have = _digest_index(_digest_listing(run))
    todo, more, days = _due(pool.values(), have, backfill, most)
    out = os.path.join(run, "out", "days")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out, exist_ok=True)
    for d in todo:
        ids = days[d]
        head = (
            "%s: #%d-#%d, %d message%s. Up to %d bullets of at most %d words, each citing messages of this day.\n"
            % (
                d,
                ids[0],
                ids[-1],
                len(ids),
                "" if len(ids) == 1 else "s",
                DIGEST_BULLETS,
                DIGEST_WORDS,
            )
        )
        with open(os.path.join(out, d + ".txt"), "w", encoding="utf-8") as fh:
            fh.write(head + "\n".join(_day_line(pool[i]) for i in ids) + "\n")
        print("DIGEST %s #%d-#%d (%d messages): %s" % (d, ids[0], ids[-1], len(ids), os.path.join(out, d + ".txt")))
    if backfill:
        left = "; %d more day%s without a digest after these" % (more, "" if more == 1 else "s")
        left = left if todo else "; every finished day has a digest: the backfill is complete"
    else:
        left = "; %d more due: the next refresh carries on" % more if more else ""
    print("days ok: %d day%s to digest%s" % (len(todo), "" if len(todo) == 1 else "s", left))


def digests_cmd(work, run, specp):
    """`catchup.py digests WORK RUN SPEC`: write only digests (the backfill). SPEC is {"digests": {...}}. Saves the
    month documents as listed, and the days they hold, in RUN/out/backup/ first; WORK doesn't move."""
    global TZ
    sp = _load(specp)
    assert set(sp) == {"digests"}, 'digests SPEC takes only "digests" (a refresh puts them in the build spec)'
    TZ = _load(work + "/state.json").get("tz") or TZ
    pool = _pool(work, run)
    listed = _digest_listing(run)
    entries = _digest_entries(sp["digests"], pool, _digest_index(listed))
    docs = _digest_docs(entries, listed)
    listing = {"digests": listed}
    batches, cleanup = _plan(docs, listing)  # fails here, before anything is written, if a document is too big
    out = os.path.join(run, "out")
    shutil.rmtree(os.path.join(out, "backup"), ignore_errors=True)
    for k, v in listed.items():
        _dump(v, os.path.join(out, "backup", "digests", k + ".json"))
    _dump({"had": sorted(_digest_index(listed)), "wrote": sorted(entries)}, os.path.join(out, "backup", "days.json"))
    told = _write_out(out, docs, batches, cleanup, {}, _pins(docs, listing))
    print(
        "digests ok: %d day%s (%s); backup of %d month document%s in %s"
        % (
            len(entries),
            "" if len(entries) == 1 else "s",
            ", ".join(sorted(entries)),
            len(listed),
            "" if len(listed) == 1 else "s",
            os.path.join(out, "backup"),
        )
    )
    print("write: " + told)


def check_digests(work, run, after):
    """`catchup.py check-digests WORK RUN AFTER`: after a digests write, AFTER = a fresh `list digests`. Every day the
    backup held is still there unchanged (or replaced by this write), and every day written is there as written."""
    global TZ
    TZ = _load(work + "/state.json").get("tz") or TZ
    out = os.path.join(run, "out")
    assert os.path.exists(out + "/backup/days.json"), "RUN/out has no backup: run catchup.py digests first"
    rec = _load(out + "/backup/days.json")
    before = _digest_index(_docs(out + "/backup/digests"))
    wrote = _digest_index(_docs(out + "/digests"))
    now = _digest_index(_digest_listing(after))
    lost = [d for d in rec["had"] if d not in rec["wrote"] and now.get(d) != before.get(d)]
    bad = [d for d in rec["wrote"] if now.get(d) != wrote.get(d)]
    assert not lost and not bad, (
        "check-digests: %s. Write nothing more, and tell the user (references/digests.md › Backfill)"
        % "; ".join(
            x
            for x in (
                "changed or missing since the backup: %s" % ", ".join(lost) if lost else "",
                "not as written: %s" % ", ".join(bad) if bad else "",
            )
            if x
        )
    )
    todo, more, _ = _due(_pool(work, after).values(), now, True)
    print(
        "check ok: %d day%s written, %d kept; %d finished day%s still without a digest%s"
        % (
            len(rec["wrote"]),
            "" if len(rec["wrote"]) == 1 else "s",
            len([d for d in rec["had"] if d not in rec["wrote"]]),
            len(todo) + more,
            "" if len(todo) + more == 1 else "s",
            "" if todo else ": the backfill is complete",
        )
    )


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
    _stamp(t, new)  # threading/current carries the same rev, so it's written too (its blocks don't change)
    docs = layout_docs(t, new, af)
    _roundtrip(docs, t, new)
    batches, cleanup = _plan(docs, listing)  # fails here, before anything is written, if a document is too big
    told = _write_out(out, docs, batches, cleanup, {"threading": t, "summary": new})
    if skipped:
        _dump(skipped, os.path.join(out, "restore-skipped.json"))
    _snapshot(work)
    _dump(new, work + "/base/summary.json")
    _dump(t, work + "/base/threading.json")
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
    elif cmd == "days":
        a = [x for x in sys.argv[2:] if not x.startswith("--")]
        mx = [int(x.split("=", 1)[1]) for x in sys.argv[2:] if x.startswith("--max=")]
        if len(a) != 2:
            sys.exit(__doc__)
        days_cmd(a[0].rstrip("/"), a[1].rstrip("/"), "--backfill" in sys.argv[2:], mx[0] if mx else None)
    elif cmd == "digests":
        digests_cmd(sys.argv[2].rstrip("/"), sys.argv[3].rstrip("/"), sys.argv[4])
    elif cmd == "check-digests":
        check_digests(sys.argv[2].rstrip("/"), sys.argv[3].rstrip("/"), sys.argv[4].rstrip("/"))
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
