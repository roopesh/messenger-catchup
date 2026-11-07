# Architecture

How the pieces fit together, as the code stands at `c3186da` (Nov 6, 2026). Line numbers point at that commit.

Related docs: [STATUS.md](STATUS.md) (start here) · [BACKLOG.md](BACKLOG.md) · [DECISIONS.md](DECISIONS.md) · [LEARNINGS.md](LEARNINGS.md)

## The four parts

| Part | Runs where | Job |
|---|---|---|
| `SKILL.md` | Claude (cloud) | The procedure: setup, refresh, outbox, scheduling. Claude carries out every step; nothing else orchestrates. |
| `assets/helper.user.js` | The user's Messenger tab (userscript, or injected by Claude) | Scroll back and read messages (scan), confirm them by ID (verify), build the capture JSON (capture), jump links. |
| `assets/page.html` | claude.ai artifact, in the user's browser | The catch-up page. Also the **importer**: checks a pasted capture and writes it to the database. |
| `scripts/cctool.py` | Claude's code sandbox | Builds `threading/current` and `summary/current` from Claude's spec and asserts the rules. |

There is no server. The artifact database (ArtifactData) is the only store, and both Claude and the page read and write it.

## One refresh, end to end

```
 Claude (cloud)                 Messenger tab (user's Chrome)            Catch-up page (artifact)
 ──────────────                 ─────────────────────────────            ────────────────────────
 get meta/chat ───────────────────────────────────────────────────────────▶ (db)
 set refresh/status running
 mc-cmd full{stops,base,run} ─▶ ccScan: scroll up until a STOP id is seen
                                quote-match text replies, click photo replies
                                save window to sessionStorage.__mcsave
                                reload ─▶ resumePipe ─▶ ccVerify (ID-only pass,
                                          fast then slow) ─▶ ccCapture
                                page body replaced by COPY CAPTURE button
 poll mc_result (≤25 s calls) ◀─ {stage:'captured', run}
 click COPY CAPTURE ─────────▶ clipboard ─────────────────────────────────▶ paste anywhere
                                                                           importCore: checksum, numbering,
                                                                           overlap, fields; write chunks,
                                                                           read back, update meta/chat,
                                                                           upload photos, photos/index
 read refresh/lastImport ◀──────────────────────────────────────────────── refresh/lastImport
 get touched chunks + meta/chat into RUN/
 write spec.json; cctool build WORK RUN spec.json
 batch write (if_version): threading, summary, meta/chat, refresh/status
 handle outbox (jump{mid,reply} + insertText + Enter)
```

Why the clipboard: the page can't receive messages from the Messenger tab, can't read the clipboard itself, and can't fetch Facebook images. A user-style paste is the one channel that works (LEARNINGS.md › claude.ai artifacts).

## Helper (`assets/helper.user.js`)

All code sits inside one IIFE guarded by `window.__mcHelper` / `data-mc-helper` (line 11), so a userscript plus an injected copy never run twice.

| Function | Line | What it does |
|---|---|---|
| `ccScan(STOPS, FIRST)` | 13 | Waits for `[role="log"]`, scrolls the inner scroller up 0.6 screen every 500 ms, merges each batch of `[data-message-id]` into `R.order` (a gap counter rises if a batch shares no id with what's known). Stops 3 steps after the anchor is seen: a STOP id, or for a first run the message before the newest `count`, or `__top__` when the chat is shorter. Then matches text replies by quote (`how:'q'`) and clicks "Go to replied message" only for photo/attachment replies. Saves `{win, info, parents, anchor}` to `sessionStorage.__mcsave`. Blocks link clicks while running. |
| `ccVerify()` | 65 | After a reload: ID-only pass (fast 0.6/500 ms, then slow 0.35/900 ms if needed). OK when `gap==0` and the new window starts with exactly the scanned window (`prefixSame`). `extra` = messages that arrived since the scan; they are *not* captured (next run gets them). |
| `ccCapture(BASE)` | 73 | Turns each saved DOM record into a message object (fields below), numbering from `BASE+1`. Parses sender, body, quote, reactions, links (strips tracking params), attachment title, date (`dOf`) and time. Fetches photos as base64. Builds the capture, then **replaces the page body** with the COPY CAPTURE button (`#__copy`, status `#__copyst`). |
| `jump()` | 113 | Handles `#mcjump=<mid>[&noreply]`: scrolls to bottom, then up until the message exists, outlines it, hovers it and clicks "Reply to this message". Shows status in `#mcjump-tip`. |
| `probe(anchor)` | 140 | Quick check: visibility, loaded count, whether the anchor is on screen. |
| `full(a)` / `resumePipe()` | 145 / 147 | Scan → `mc_pipe` in sessionStorage → reload → (on load) verify → capture → `mc_result`. `full` clears `mc_result` first; results carry `run`. |
| Bridge | 156 | `document` event `mc-cmd` with `{id, cmd, args}`; result in `sessionStorage['mc_res_'+id]` (`{running:true}` until done). |

Browser state it uses: `sessionStorage` keys `__mcsave`, `mc_pipe`, `mc_result`, `mc_res_<id>`; globals `__rf`, `__v`, `__capText`, `__mcHelper`, `__mcJumping`.

### Capture format (`kind: "mc-capture"`)
```
{kind, base, anchor, count, sha, msgs:[...], gifs:[i...], photos:[{i,k,type,b64}], phsha}
sha   = SHA-256 hex of JSON.stringify(msgs)
phsha = SHA-256 hex of JSON.stringify(photos)
```
The page also accepts the old `cc-capture` kind and two optional flags: `dry` (check everything, write nothing) and `lab` (store photos but don't link them).

### Copies of the helper (keep in sync)
The helper exists **three times**: the file itself, an HTML-escaped copy in the page's `#jump-us` textarea (`page.html:306`, used by "Copy userscript"), and the `jump()` body as a URL-encoded bookmarklet in `#jump-bm` (`page.html:473`, `%` → `%25`). They were checked identical on Nov 6 (STATUS.md). The version string `1.1` appears four times in the helper (header, `__mcHelper`, `data-mc-helper`, `ping`). See BACKLOG C2.

## Page (`assets/page.html`)

- **Capabilities:** `db`, `assets` (photo uploads), `sample` (Ask Claude, Views, range summaries). Published by Claude with `capabilities: {"db":{}, "assets":{}, "sample":{}}`.
- **Config:** everything chat-specific comes from `meta/chat` via `applyCfg()` (line 500). `PAGE_VERSION` is at line 493.
- **Boot** (line 1032): subscribes with `onSnapshot` to `meta/chat`, `summary/current`, `chunks`, `qa`, `views`, `notes`, `outbox`, `refresh/status`, `rangeSummaries`, `photos/index`, `threading/current`. Every chunk change rebuilds the full in-memory message list (`rebuild`, line 1029).
- **Tabs:** Summary · Ask Claude · Messages · Views, plus a fixed "Refreshing" section with helper setup and the manual Import box.

### Catch-up window (`winRange`, line 546)
`meta/chat.markerMode` picks the start point:
- `caught`: after `caughtUpI` ("Mark caught up" button sets it to the newest message).
- `own`: after the user's last message (`ownLastI`, kept current by the importer).
- `time`: `markerFrom` / optional `markerTo` (local `YYYY-MM-DDTHH:MM`), compared against each message's `ts` built from `d` + `t`.
Everything (summary cards, counts, mentions, open questions) filters to the window. The date inputs never rebuild while focused and save 1.5 s after the last keystroke, on Enter, or on blur (EXPERIMENTS.md §6).

### Summary (v3 cards, `renderSummaryV2`, line 757)
"Your replies" (outbox) → "Needs you" (mentions) → filter chips (All / Open / Deals / Answered) → one card per conversation (`convCard`, line 724) with open/deal/answered call-outs, outcome, bullets that open the thread at their messages, and a lazily built thread → collapsed "Links shared".

### Threading display (`convTree`, line 703)
One tree for cards and the Messages tab. `r`/`rq`/`rg`/`i` links nest under their parent; `c` (same person continuing) sits right after the earlier message at the same level; depth is capped at 3. **A link only nests when its parent is in the same conversation**; otherwise the message shows as a root.

### Importer (`importCore`, line 948)
Checks, in order: JSON → `kind` → message checksum → photo checksum → data loaded → consecutive numbers → no gap after `lastI` → overlapping messages match stored ids → required fields (`f`, `m`, `t`, `d` as a date) → photo shape. First import must start at `#0`. Appends to the newest chunk, rolling to a new `cNNNN` at `chunkSize` (82). Writes chunks, **reads each back and compares**, then updates `meta/chat` (`lastI`, `lastMid`, `lastT`, `anchorMids`, `ownLastI`, `ownLastMid`), then uploads photos and merges `photos/index`. Every outcome goes to `refresh/lastImport`. These page writes are not version-pinned (BACKLOG R1).

### Outbox
"Reply here" writes `outbox/r<timestamp>` `{i, mid, to, snip, text, state:"queued", queuedAt}`; Cancel sets `state:"cancelled"`. Claude moves rows to `sending` → `sent` (`sentAt`, `sentMid`) or `failed` (`error`).

### Legacy / unreachable code (kept from the user-specific page)
- In-page Refresh button: `#refresh-btn` is `hidden` and never shown; `REFRESH_TASK="__TRIGGER_ID__"`, `S.mcp=null`, so `startRefresh` / `fire_trigger` (line 1015) never run.
- Summary v1 renderer (`renderSummary` non-v2 branch, line 612): the generic skill always writes `version:2`.
- Range summaries (`renderRangeSummary`, line 793): only trigger when `summary.fromI` is set, and `cctool` never sets it.
- `dayMap()` / `meta.dates` (line 544): every message now carries `d`.
- "Notes from Claude" (`notes` collection): nothing writes it.
See BACKLOG C1.

## Build tool (`scripts/cctool.py`)

- `bootstrap WORK DBDIR`: loads all chunks, asserts numbering has no gaps and `meta.lastI` matches, writes `WORK/all.json`, `WORK/base/{threading,summary}.json`, `WORK/state.json` (`base`, `stops`, `tz`).
- `build WORK RUN SPEC`: loads new messages from `RUN/chunks` (must be exactly `base+1…`), applies the spec, picks default links, runs the asserts, writes `RUN/out/{threading,summary}.json`, then **advances WORK in place** (no backup, BACKLOG B2).
- Default link for each new message, in order: Messenger parent in window (`pi` → `r`, or `rq` if quote-matched in the browser) → Messenger parent by id from history (`pmid`) → quote match on stored history (`resolve`: same author, first 20 normalized chars, 300-message window, latest wins → `rq`; empty or "Photo"-type quote → author's latest media → `rg` + CHECK) → previous member of its conversation if ≤3 h older (`c` same author, else `i`, printed as GUESS) → none (ROOT).
- Asserts: conv ids new; every new message joined exactly once; every message from the lowest member up is in exactly one conversation; links point backward; bullets ≤15 words; outcomes ≤12; bullet/key/open/answered refs belong to their conversation; deals name a real conversation; `meta/chat` was updated by the import.
- Timestamps (`builtAt`, `generatedAt`) come from the system clock in `meta.tz` (falls back to America/Los_Angeles).

## Database reference (all writers)

SKILL.md lists the core schema; this is the full set the code touches.

| Doc / collection | Written by | Fields |
|---|---|---|
| `meta/chat` | Claude at setup | `kind`, `pageVersion`, `thread`, `chatUrl`, `threadName`, `shortName`, `ownerName`, `ownerAliases`, `topic`, `outboxAuto`, `refreshPhrase`, `tz`, `helper`, `chunkSize`, `schedule`, initial `lastI:-1`, `anchorMids:[]`, `markerMode`, `markerFrom` |
| | Page importer | `lastI`, `lastMid`, `lastT`*, `anchorMids`, `ownLastI`, `ownLastMid`* |
| | Page UI | `markerMode`, `markerSetAt`*, `markerFrom`, `markerTo`*, `caughtUpI`, `caughtUpAt`* |
| | Claude per refresh | `lastRefresh`, `coverage` |
| | (read only, legacy) | `dates` |
| `chunks/cNNNN` | Page importer | `{start, msgs}` |
| `threading/current` | Claude (from cctool) | `convs[{id,title,members}]`, `links{i:[parent,type]}`, `to`, `note`, `builtAt`* |
| `summary/current` | Claude (from cctool) | `version:2`, `convs[{id,tag,synopsis[{t,refs}],outcome,key}]`, `open[{conv,ask,to,note}]`, `answered[{conv,ask,answer,refs}]`, `deals[{kind,tag,conv,text,links?,refs}]`, `mentions[{note,refs:[[i]]}]`, `toI`, `generatedAt`; optional `mentionsNote`, `fromI` |
| `photos/index` | Page importer | `byI{i:["/_blob/<id>",…]}`, `gifs[i]` |
| `refresh/status` | Claude | `state` (idle/running/done/error), `startedAt`, `step`, `by`, `finishedAt`, `added`, `message` |
| `refresh/lastImport` | Page importer | `at`, `src`, `ok`, `msg`, `dry`, `sha`, `count`, `fresh`, `chunks`, `uploaded` |
| `outbox/*` | Page, then Claude | see Outbox above |
| `qa/*` | Page (Ask) | `q`, `a`, `at`, `scope`, `toI` |
| `views/*` | Page (Views) | `kind:"view"` (title, intro, sections, prompt, at, toI) or `kind:"idea"` (prompt, at) |
| `rangeSummaries/*` | Page (unreachable today) | same shape as summary plus `by:"page"`, `fromI` |
| `notes/*` | nobody (legacy) | `title`, `when`, `at`, `intro`, `table`, `sections`, `footer` |

\* not listed in SKILL.md (BACKLOG G1).

### Message fields
`i` number from 0 · `t` "Fri 8:41 AM" · `d` "YYYY-MM-DD" · `f` sender ("You" = owner) · `b` text · `m` Messenger id · `r` replied-to name · `q` quoted text (≤160) · `pi` parent number in the store · `pq` 1 when the parent was quote-matched · `pmid` / `pl` parent id and label when outside the capture window · `perr` why a photo-reply click failed (`notfound`, `nobtn`, `nofocus`) · `p` attachment id of a photo · `a` link-preview / attachment title (≤220) · `l` outside links · `x` reactions. The page adds `ts` in memory.

### Link types
`r` Messenger's own reply link · `rq` reply matched by quote · `rg` photo reply, best match · `i` answers (Claude's judgment) · `c` same person continuing · `null` in a spec = deliberately no link.

## Versions in play
| Thing | Where | Now |
|---|---|---|
| Skill | `SKILL.md` "Tested" section | 1.1 |
| Page | `PAGE_VERSION` (page.html:493); stored as `meta/chat.pageVersion` | 1.1 |
| Helper | 4 places in `helper.user.js` + the page's embedded copy | 1.1 |
| Summary schema | `summary/current.version` | 2 (the "v3" cards are a display change, same schema) |
