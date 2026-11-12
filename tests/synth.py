"""Synthetic chat history for size and layout tests: messages, threading and summary shaped like a busy group chat, with
the mock cast only. Built straight from a model of the chat (no catchup.py build per batch), but valid for every build
assert, so catchup.py can bootstrap it and build on top.

Calibrated against the owner's live page on Nov 11, 2026 (counts only): 6,933 messages, 504 conversations, 6,068 links,
threading about 27 bytes per message and a full summary about 50 bytes per message. `heavy=True` makes the summary about
1.6 times denser (more and longer bullets), for headroom.

  python3 tests/synth.py page N BLOCK   JSON for the page test: chunks, meta, the old layout and the block layout
"""

import datetime, json, os, random, sys

CAST = ["Ana", "Ben", "Cy", "Dee", "You"]
WORDS = (
    "pack trail tent stove price shipping size boots jacket filter bottle strap frame carbon fleece rain hike trip "
    "weekend sale offer deal trade bought sold still available pickup local review fits light heavy summer winter "
    "group buy order code discount color green blue black spare gear list question answer maybe tomorrow tonight "
    "photo link thread update night camp lake ridge pass bag quilt pad poles socks shell layer stuff sack knife lamp "
    "battery charger solar map route permit parking early late cheap worth great nice thanks agree plan meet"
).split()
TAGS = ["For sale", "Group buy", "Heads-up", "Trip", "Gear talk", "Question", "Deal"]


def _words(rnd, a, b):
    return " ".join(rnd.choice(WORDS) for _ in range(rnd.randint(a, b)))


def _time(i, start):
    d = start + datetime.timedelta(minutes=i * 1440 / 460)  # about 460 messages a day
    return d.strftime("%a ") + "%d:%02d %s" % ((d.hour % 12) or 12, d.minute, "AM" if d.hour < 12 else "PM"), d.date()


def _size_target(rnd):
    x = rnd.random()
    if x < 0.70:
        return rnd.randint(2, 10)
    if x < 0.95:
        return rnd.randint(10, 35)
    if x < 0.99:
        return rnd.randint(35, 120)
    return rnd.randint(120, 500)


def chat(n, seed=1, heavy=False, per_build=20):
    """-> (msgs, threading, summary): the merged state of a page that has built #0..#n-1, in the old single-document shape."""
    rnd = random.Random(seed)
    start = datetime.datetime(2026, 9, 1, 7, 0)
    msgs = []
    for i in range(n):
        t, d = _time(i, start)
        m = {
            "i": i,
            "t": t,
            "d": d.isoformat(),
            "f": rnd.choice(CAST),
            "b": _words(rnd, 2, 18),
            "m": "mid.$synth%d" % i,
        }
        if rnd.random() < 0.05:
            m["p"] = "att%d" % i
        msgs.append(m)
    convs, active, links = [], [], {}
    for i in range(n):
        if not active or rnd.random() < 1 / 14:
            day = msgs[i]["d"][5:].replace("-", "")
            c = {"id": "%s%s%d" % (rnd.choice(WORDS), day, len(convs)), "title": _words(rnd, 3, 7).capitalize()}
            c["members"], c["_want"] = [], _size_target(rnd)
            convs.append(c)
            active.append(c)
            cv = c
        else:
            cv = active[-1 - min(int(rnd.expovariate(0.35)), len(active) - 1)]  # recent conversations are busier
        if cv["members"] and rnd.random() < 0.9:
            p = rnd.choice(cv["members"][-5:])
            links[str(i)] = [p, rnd.choices(["r", "rq", "rg", "i", "c"], [35, 10, 3, 30, 22])[0]]
        cv["members"].append(i)
        if len(cv["members"]) >= cv["_want"]:
            active.remove(cv)
    for c in convs:
        del c["_want"]
    conv_of = {i: c["id"] for c in convs for i in c["members"]}
    S = {c["id"]: {"id": c["id"], "tag": rnd.choice(TAGS), "synopsis": [], "outcome": "", "key": []} for c in convs}
    mem = {c["id"]: c["members"] for c in convs}
    opens, answered, deals, mentions = [], [], [], []
    nb, bw = (2, (10, 15)) if heavy else (1, (7, 14))
    for b0 in range(0, n, per_build):
        ids = list(range(b0, min(n, b0 + per_build)))
        touched = {}
        for i in ids:
            touched.setdefault(conv_of[i], []).append(i)
        for cid, got in touched.items():
            sc = S[cid]
            for _ in range(rnd.randint(1, nb) if rnd.random() < 0.6 else 1):
                sc["synopsis"].append(
                    {
                        "t": _words(rnd, *bw).capitalize(),
                        "refs": sorted(rnd.sample(got, min(len(got), rnd.randint(1, 3)))),
                    }
                )
            sc["outcome"] = _words(rnd, 4, 11).capitalize()
            sc["key"] = sorted(rnd.sample(mem[cid][: mem[cid].index(got[-1]) + 1], min(len(got), rnd.randint(2, 4))))
        built = {c: [i for i in m if i <= ids[-1]] for c, m in mem.items()}
        cids = list(touched)
        new_ans = []
        if rnd.random() < (0.9 if heavy else 0.66):
            cid = rnd.choice(cids)
            ask = rnd.choice(built[cid])
            refs = [r for r in built[cid] if r >= ask][:2]
            new_ans.append({"conv": cid, "ask": ask, "answer": _words(rnd, 4, 12), "refs": refs})
        close = []
        if opens and rnd.random() < 0.3:
            o = rnd.choice(opens)
            close.append(o["ask"])
            got = [r for r in built[o["conv"]] if r > o["ask"]][:2]
            new_ans.append({"conv": o["conv"], "ask": o["ask"], "answer": _words(rnd, 4, 12), "refs": got})
        new_open = []
        if rnd.random() < 0.35:
            cid = rnd.choice(cids)
            ask = touched[cid][-1]
            if ask not in {o["ask"] for o in opens}:
                new_open.append(
                    {"conv": cid, "ask": ask, "to": rnd.choice(["anyone"] + CAST[:4]), "note": _words(rnd, 3, 9)}
                )
        opens = new_open + [o for o in opens if o["ask"] not in close]
        answered = new_ans + answered
        if rnd.random() < (0.55 if heavy else 0.4):
            cid = rnd.choice(cids)
            deals.append(
                {
                    "kind": rnd.choice(["sale", "deal", "raffle", "ask"]),
                    "tag": rnd.choice(TAGS),
                    "conv": cid,
                    "text": _words(rnd, 6, 14),
                    "refs": touched[cid][:2],
                }
            )
        others = [i for i in ids if msgs[i]["f"] != "You"]
        if others and rnd.random() < 0.5:
            mentions = [
                {"note": _words(rnd, 3, 8), "refs": [[i] for i in rnd.sample(others, min(2, len(others)))]}
            ] + mentions
    last = {c["id"]: max(c["members"]) for c in convs}
    sm = {
        "version": 2,
        "convs": sorted(S.values(), key=lambda c: -last[c["id"]]),
        "open": opens,
        "answered": answered,
        "deals": deals,
        "mentions": mentions,
        "toI": n - 1,
        "generatedAt": "Wed Nov 11, 9:00 AM",
    }
    th = {"convs": convs, "links": links, "to": n - 1, "note": "", "builtAt": "Wed Nov 11, 9:00 AM"}
    return msgs, th, sm


def more(n0, k, seed=9):
    """k new messages after #n0-1, for a build on top of a synthetic chat."""
    rnd = random.Random(seed)
    start = datetime.datetime(2026, 9, 1, 7, 0)
    out = []
    for i in range(n0, n0 + k):
        t, d = _time(i, start)
        out.append(
            {
                "i": i,
                "t": t,
                "d": d.isoformat(),
                "f": rnd.choice(CAST),
                "b": _words(rnd, 2, 18),
                "m": "mid.$synth%d" % i,
            }
        )
    return out


def drop_before(sm, th, from_i):
    """What earlier sessions did to the owner's summary: drop the conversations that ended before from_i and set fromI."""
    last = {c["id"]: max(c["members"]) for c in th["convs"] if c["members"]}
    keep = {c["id"] for c in sm["convs"] if last.get(c["id"], 0) >= from_i}
    out = dict(sm, fromI=from_i, convs=[c for c in sm["convs"] if c["id"] in keep])
    for k in ("open", "answered", "deals"):
        out[k] = [x for x in sm[k] if x["conv"] in keep]
    out["mentions"] = [x for x in sm["mentions"] if all(r[0] >= from_i for r in x["refs"])]
    return out


def chunks(msgs, size=82):
    return {"c%04d" % k: {"start": k, "msgs": msgs[k : k + size]} for k in range(0, len(msgs), size)}


def _catchup():
    import importlib.util

    p = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "plugin",
        "skills",
        "refresh",
        "scripts",
        "catchup.py",
    )
    spec = importlib.util.spec_from_file_location("catchup", p)
    c = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(c)
    return c


if __name__ == "__main__" and sys.argv[1:2] == ["page"]:
    n, block = int(sys.argv[2]), int(sys.argv[3])
    c = _catchup()
    c.BLOCK = block
    msgs, th, sm = chat(n, seed=7, per_build=10)
    old = {"threading/current": json.loads(json.dumps(th)), "summary/current": json.loads(json.dumps(sm))}
    new = c.layout_docs(c._canon_threading(json.loads(json.dumps(th))), json.loads(json.dumps(sm)))
    json.dump({"chunks": chunks(msgs), "old": old, "new": new, "last": n - 1}, sys.stdout)
