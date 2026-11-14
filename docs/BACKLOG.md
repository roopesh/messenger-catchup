# Backlog

Everything open: bugs, risks, gaps between docs and code, cleanup, tests and feature ideas. Started Nov 6, 2026 from a full read of the code at `9c353de`, the simulated-Messenger tests, a `cctool.py` (now `catchup.py`) replay and a date-parser probe ([EXPERIMENTS.md §10](EXPERIMENTS.md#10-handoff-review-nov-6-evening)). Updated after the Phase 8 rename and test build-out ([§11](EXPERIMENTS.md#11-rename-and-test-build-out-nov-6-late-evening)).

**Tests for open bugs:** none open; the tests written for B1–B5 and B7–B11 are now regression tests. Fix the bug, then remove the marker.

**Priority:** P1 = fix before relying on it more · P2 = next round · P3 = when convenient.
**Status:** open unless marked. When you close an item, change its status to `done (<commit>)` and keep the row, so the history stays readable.

## At a glance

| ID | P | Type | Title |
|---|---|---|---|
| B2 | P1 | bug | `catchup.py build` advances WORK with no backup; a failed DB write can't be retried cleanly · **done** (v1.2.0) |
| R1 | P1 | risk | Page imports aren't version-pinned, and a half-finished import has no documented recovery · **done** (v1.2.0) |
| B6 | P2 | bug | Capture date parser: unknown label forms silently become "today"; year-less dates break at New Year · **done** (v1.3.0) |
| B8 | P2 | bug | One malformed link in a message crashes the Messages tab render · **done** (v1.2.2) |
| B4 | P2 | bug | `catchup.py` accepts links to a parent in another conversation; the page then hides the link · **done** (v1.2.1) |
| G1 | P2 | doc gap | `meta/chat` fields written by the page are missing from SKILL.md; `pageVersion` never updated on republish · **done** (v1.2.0, v1.4.0) |
| G2 | P2 | doc gap | Page says Claude reads `views`, ideas and `qa`; SKILL.md never tells it to · **done** (v1.4.0) |
| G3 | P2 | doc gap | Page offers "say reply 3232 to Claude"; SKILL.md has no procedure for it · **done** (v1.4.0) |
| R2 | P2 | risk | Photos lost when the page tab closes mid-upload (capture size measured: not the limit) · **done** (v1.22.0) |
| R5 | P2 | risk | E2EE chats untested live; `messenger.com` not supported |
| R8 | P2 | risk | The PR rule is by convention only: `main` accepts direct pushes and no CI runs on PRs · **done** (v1.7.2: repo public, branch protection) |
| R9 | P3 | risk | Outbox name matching assumes Messenger's "Replying to …" and stored sender names agree. Live (Nov 7): labels are the nickname or the first name, and `to` uses the same; the reply bar itself is still unverified |
| R6 | P2 | risk | SKILL.md names scheduling tools (`send_later`, `create_trigger`) that depend on the environment · **done** (v1.21.0) |
| R10 | P3 | risk | The page's requirements text doesn't say the Claude Desktop app must be open |
| R11 | P3 | risk | Desktop local scheduled tasks may reach Claude in Chrome; not checked, so not offered |
| R12 | P3 | risk | A chain conversation's context grows with every run, so its cost rises over weeks; it also hits the conversation length limit |
| R14 | P3 | risk | A chain arms at the end of a run, so a run that dies mid-refresh leaves no follow-up · **done** (v1.23.0) |
| R18 (A3) | P3 | risk | Now that a chain run arms as it starts, a run still going when the next one fires (over `every` minus 5 minutes) has a lock older than 20 minutes, which the next run takes over |
| R13 | P2 | risk | A page holds at most 5,000 photo files: the owner's page has 715 and adds about 55 a day (to design) |
| R15 | P3 | risk | Photos the helper couldn't fetch aren't recorded as owed, so nothing retries them |
| R16 | P3 | risk | Backfill captures: lazy-loaded images can shift photo slots, and every photo in the window is fetched again |
| R17 | P3 | risk | Between a merge and its release, the page's "helper is behind" notice points at the old helper: marketplace installs get the new skill at the merge, but `releases/latest` still serves the old userscript |
| C2 | P2 | cleanup | Helper lives in three copies plus four version strings; sync is manual · **done** |
| T1 | P2 | test | No `package.json`; Playwright must be installed by hand · **done** |
| T2 | P2 | test | No tests for `catchup.py`; the "pipeline replay" isn't in the repo · **done** |
| T3 | P2 | test | No tests for the page (importer, `convTree`, date entry) · **done** |
| F3 | P2 | feature | No way to correct a link on an already-built message · **done** (v1.12.0) |
| F4 | P2 | feature | Self-check command to catch Messenger markup changes early · **done** (v1.13.0) |
| B11 | P3 | bug | `catchup.py` ignores Messenger's reply link when the parent is message #0 · **done** (v1.2.1) |
| B12 | P2 | bug | Capture took a follow-on message starting "X replied to…" / "You sent…" as a reply or as yours · **done** (v1.4.2) |
| B13 | P2 | bug | `catchup.py` quote matching: short quotes match the wrong message silently (substring fallback, no minimum) · **done** (v1.5.0) |
| B14 | P2 | bug | REPAIRED note names only the newest chunk; Claude's build then fails · **done** (v1.4.2) |
| B15 | P1 | bug | SKILL.md refresh: pins versions it never reads, reuses a stale WORK, conflict recovery rebuilds from a stale base, never checks the run lock · **done** (v1.5.0) |
| B16 | P2 | bug | Outbox: can reply to the wrong message ("found it (hover…)" path) or post twice (late confirmation marked failed) · **done** (v1.5.0) |
| B17 | P2 | bug | Photos: a failed upload leaves landed photos unindexed; GIF-only captures never recorded · **done** (v1.4.2) |
| B18 | P2 | bug | `catchup.py` doesn't validate deal refs, mention refs, `closeOpen`, duplicate open questions · **done** (v1.5.0) |
| B19 | P2 | bug | SKILL.md has no "nothing new" path (empty capture → build fails); a scan error leaves the status "running" · **done** (v1.5.0) |
| B20 | P3 | bug | Page never releases its import lease (other tabs wait 2 min) · **done** (v1.4.2) |
| B21 | P1 | bug | `bootstrap` assumes every stored message is threaded: an import whose build never ran breaks every later build · **done** (v1.5.0) |
| B22 | P1 | bug | `bootstrap` crashed when chunks run past `meta/chat.lastI` (the state REPAIRED fixes), so fresh sessions never got to paste · **done** (v1.5.1) |
| B23 | P2 | bug | Conflict recovery dead-ended: "restore WORK" after a fresh bootstrap that has nothing to restore · **done** (v1.5.1) |
| B24 | P2 | bug | Capture replaced any message mentioning "deleted a message" with "(deleted a message)" · **done** (v1.5.1) |
| B25 | P2 | bug | Outbox: a `sending` reply has no rule when it's not found; the check only looks at what's on screen · **done** (v1.6.0) |
| B26 | P2 | bug | A session that loses the race for the run lock overwrites the winner's status with "error" · **done** (v1.6.0) |
| B27 | P2 | bug | Step 7 marks the run done (releasing the lock) before step 8 posts replies in the Messenger tab · **done** (v1.6.0) |
| B28 | P2 | bug | Re-paste after a failed upload could store a photo twice when a capture skipped a photo slot · **done** (v1.5.1) |
| B29 | P3 | bug | "You replied to yourself" not recognized: such replies never linked · **done** (v1.5.1) |
| B30 | P2 | bug | Step 7's lock write could replace `refresh/status`, dropping `startedAt`/`by` · **done** (v1.7.0) |
| B31 | P2 | bug | Nothing-new path released the run lock before posting replies (B27 again) · **done** (v1.7.0) |
| B32 | P2 | bug | Step 1 navigated the shared Messenger tab before step 2 took the lock · **done** (v1.7.0) |
| B33 | P3 | bug | A retried step-7 write could overwrite another run's lock with "done" · **done** (v1.7.0) |
| B34 | P3 | bug | `build` with a RUN holding no chunks gave a bare gap error · **done** (v1.7.0) |
| B35 | P2 | bug | Unbuilt messages went unnoticed when WORK was reused in a session · **done** (v1.7.0) |
| B36 | P3 | bug | `unconfirmed`/`failed` replies could never be resolved or dismissed · **done** (v1.7.0) |
| B37 | P3 | bug | A page that can't upload said "paste again" with no end · **done** (v1.7.0) |
| B38 | P2 | bug | A photo-reply parent that loaded late could be recorded as the next reply's parent: a silent wrong link · **done** (v1.14.0) |
| B39 | P2 | bug | Queuing a reply closes the conversation you're in and jumps the page · **done** (v1.19.0) |
| B40 | P2 | bug | A conversation that starts with a reply to an older message doesn't show that message, so you can't tell what it's about · **done** (v1.19.0) |
| B41 | P2 | bug | Full names are missing on a live page, so people who share a first name aren't told apart · **done** (v1.20.0) |
| B42 | P3 | bug | A person's text and the photo they sent right after show as two separate messages instead of one · **done** (v1.19.0) |
| B43 | P1 | bug | Threading and summary outgrow the database's 256 KiB per-document cap; sessions started dropping summaries · **done** (v1.17.0) |
| B44 | P1 | bug | 1.17.0's first refresh: conversation ids used twice stop the conversion; chunk names worked out by arithmetic; the refresh skill's description cut at `#` · **done** (v1.17.1) |
| B45 | P2 | bug | Multi-line replies can't post: `insertText` drops line breaks and the exact-match check fails (issue #32 §3) · **done** (v1.18.0) |
| B46 | P3 | bug | An outbox row's `sentAt` was an estimate, not the real time at confirm (issue #32 §5) · **done** (v1.18.0) |
| B47 | P2 | bug | A build that gives bullets to a conversation with an old string synopsis crashes (`str` has no `append`) · **done** (v1.18.1) |
| B48 | P2 | bug | Reply on a photo-only message: `jump` finds no Reply button, so the reply is marked failed (#32 §2) · **done** (v1.20.0) |
| B49 | P3 | bug | A scan that stops growing hangs (stops) or reads as the top of the chat (first run) (#32 §5) · **done** (v1.20.0) |
| B50 | P3 | bug | `troubleshooting.md` says the skill's version is in `VERSION`, "shipped with it"; `VERSION` is at the repo root, outside `plugin/` · **done** (v1.22.0) |
| B51 | P3 | bug | A built view's reply could set its own `kind`: `{kind:"view", ...v}` let `kind:"idea"` from the model through, posing as a method idea Claude acts on after a refresh · **done** (v1.22.0) |
| B1 | P3 | bug | Threading `note` is never filled in for new pages · **done** (v1.2.1) |
| B3 | P3 | bug | `dealEdit` crashes when the conversation has no deal · **done** (v1.2.1) |
| B5 | P3 | bug | Reply with no parent found gets an auto `i` link, contrary to SKILL.md · **done** (v1.2.1) |
| B7 | P3 | bug | A mention of message #0 renders without its content · **done** (v1.2.2) |
| B9 | P3 | bug | "Queued" confirmation says "and confirm" even with auto-posting on · **done** (v1.2.2) |
| B10 | P3 | bug | `make-zip.sh` only works when the repo folder is named `messenger-catchup` · **done** (v1.4.1) |
| G4 | P3 | doc gap | Page text refers to a Refresh button that is hidden · **done** (v1.2.2) |
| G5 | P3 | doc gap | Page install steps name only Violentmonkey; SKILL.md recommends Tampermonkey · **done** (v1.2.2) |
| G6 | P3 | doc gap | `outbox/*` row fields and `meta/chat.coverage` aren't defined anywhere Claude reads · **done** (v1.18.0) |
| R3 | P3 | risk | Reader depends on English labels and Messenger's markup (known) · **done** (v1.20.0, option B: silent failures warn; English labels remain) |
| R4 | P3 | risk | Page and Ask Claude hold the whole history in memory / one prompt · **done** (v1.20.1 date-range speed; v1.22.0 prompt size, with F6). Show older paging is F15 |
| R7 | P3 | risk | Helper leaks a click listener per scan and polls the URL forever · **done** (v1.3.0; URL poll kept on purpose) |
| C1 | P3 | cleanup | Unreachable code in the page (Refresh trigger, summary v1, range summaries, notes) · **done** (v1.7.3; range summaries kept, they're live) |
| C3 | P3 | cleanup | Leftover `cc*` names and chat-specific comments · **done** |
| C4 | P3 | cleanup | Minified one-line style in helper and page · **done** (v1.7.4: Prettier + Ruff, enforced) |
| C5 | P3 | cleanup | `catchup._ts` shells out to `date` · **done** (v1.2.1) |
| C6 | P3 | cleanup | `catchup.py` opens files without closing them · **done** (v1.2.1) |
| C7 | P2 | cleanup | `SKILL.md` (31 KB) is read on every refresh; move setup, troubleshooting, outbox and db reference to on-demand references · **done** (v1.9.0) |
| T4 | P3 | test | Sim doesn't cover other date-label forms · **done** (v1.3.0) |
| T5 | P3 | test | No CI · **done** |
| F1 | P3 | feature | More than one chat per page |
| F2 | P3 | feature | Faster distant photo-reply parents · **done** (v1.14.0) |
| F5 | P3 | feature | Page shows "update available" when its version is behind · **done** (v1.22.0) |
| F6 | P3 | feature | Ask Claude over long histories · **done** (v1.22.0: one prompt budget; older history as conversation and day lines) |
| F7 | P3 | feature | Ship as a plugin (marketplace) so claude.ai installs update automatically · **done** (v1.15.0, v1.16.0) |
| F8 | P2 | feature | Userscript installs from the release URL and updates itself; drop the page's 30 KB embedded copy · **done** (v1.8.0) |
| F9 | P2 | feature | Full names and nicknames: capture, store, show (part 1, v1.10.0); one-time backfill scan and alias question (part 2, v1.11.0) · **done** |
| F10 | P2 | feature | Restore the summary items that pre-1.17 refreshes dropped, from the page's `backups` collection · **done** (v1.18.1; run on the owner's page Nov 13) |
| F11 | P2 | perf | Outbox: fewer round trips per reply, about 3 calls instead of 6 (issue #32 §1) · **done** (v1.18.0) |
| F12 | P3 | feature | Two connected Chromes: choose one by the newest helper and name it in the report (#32 §5) · **done** (v1.20.0) |
| F13 | P2 | feature | Opt-in helper `post` command: a queued reply in one bridge call (#32 §1, option B) · **done** (v1.20.0) |
| F14 | P3 | feature | The page shows when the next scheduled refresh is due (`refresh/schedule.nextAt`) |
| F15 | P3 | perf | "Show older messages" renders the whole history at once; page it by day (R4's remainder) |
| F16 | P3 | feature | Per-day digests written during refresh, for Ask about stretches older than the conversation lines reach |
| F17 | P3 | feature | A two-step or tool-using Ask: Claude picks the stretch it needs, then reads it word for word |
| F18 | P3 | feature | Range summaries longer than one request: split into parts and merge |
| F19 | P2 | feature | Short claims ("In", "dibs", "in for 2") in buy/sell chats thread to the latest open offer, not to whatever came before (issue #41) · **done** (v1.23.0: `REACT?` lines, Claude decides; deal `claims` and `status`) |
| F20 | P2 | feature | A `move` spec key: put an already-built message into another conversation (`relink` can only change its link) (issue #41) · **done** (v1.23.0) |
| F21 (A2) | P3 | feature | `catchup.py relink` with a `move` takes no `bullets` or `dealEdit`, so a claim moved at the user's request gets its bullet and `claims` entry only at the next build |
| F22 (A2) | P3 | feature | The page could show a deal's `status` ("sold", "pending"), which v1.23.0 stores; release B shows `claims` only |

---

## Bugs

### B1 · P3 · Threading `note` never filled in for new pages · done (v1.2.1)
- **Where:** `scripts/catchup.py:105`
- **What:** the note ("N reply links read straight from Messenger; …") is produced by `re.sub` on the *existing* note. Setup seeds `note:""`, the pattern never matches, and the note stays empty forever. The Messages tab shows it when present (`page.html:896`).
- **Seen:** replay on Nov 6 printed `note= ''` after a successful build.
- **Fix:** if the pattern doesn't match, set the note outright.

### B2 · P1 · `catchup.py build` advances WORK with no backup · done
- **Where:** `scripts/catchup.py:134-135`; SKILL.md refresh step 6 ("restore WORK from the previous base files first"); LEARNINGS.md ("Restore the workspace from backup before rebuilding")
- **What:** `build` overwrites `WORK/all.json`, `WORK/base/*` and `WORK/state.json` as soon as it succeeds. If the batch write that follows fails (an `if_version` conflict, a dropped call) or Claude needs to fix a link and rebuild, a second `build` fails with a bare `AssertionError: []`. Nothing keeps the previous files, so "restore from backup" means re-running `bootstrap` from a fresh DB fetch.
- **Seen:** replay on Nov 6: the second `build` of the same RUN → `AssertionError: []`.
- **Fix:** copy WORK to `WORK/prev/` before advancing; add `catchup.py restore WORK`; or split into `build` (writes RUN/out only) and `commit` (advances WORK after the DB write succeeds). Give the assert a message ("RUN already built; restore WORK first").
- **Done in v1.2.0:** the first option, which keeps the build call and its output unchanged:
  - `build` snapshots WORK to `WORK/prev/` just before advancing (rejected builds don't touch it).
  - `restore WORK` undoes one build.
  - `bootstrap` clears a stale `prev`.
  - Rebuilding an already-built RUN fails with "RUN already built into WORK … run: catchup.py restore WORK".
  - SKILL.md steps 6–7 and Troubleshooting say when to restore. 7 tests in `TestRestore`.

### B3 · P3 · `dealEdit` crashes without a deal · done (v1.2.1)
- **Where:** `scripts/catchup.py:116-119`
- **What:** `[d for d in deals if d['conv']==cid][0]` → `IndexError` when the conversation has no deal; with two deals, only the first can ever be edited.
- **Seen:** replay on Nov 6 → `IndexError: list index out of range`.
- **Fix:** assert with a clear message; key edits by deal index or text.

### B4 · P2 · Cross-conversation links accepted silently · done (v1.2.1)
- **Where:** `scripts/catchup.py:85-102` (no check), `page.html:704` (`set.has(lk[0])`)
- **What:** a spec `links` entry (or a GUESS/quote default) may point at a message in a different conversation. `catchup.py` only checks that links point backward. The page nests a message only when its parent is in the same conversation, so the link disappears from the card and the Messages tab and the message shows as a root. The link type isn't validated either (`"x"` would be stored).
- **Seen:** replay on Nov 6: link `3 → 2` across conversations built without a warning.
- **Fix:** WARN (or assert) when the parent isn't in the same conversation, and on unknown types.

### B5 · P3 · Reply with no parent found gets an auto `i` link · done (v1.2.1)
- **Where:** `scripts/catchup.py:94-99`; SKILL.md setup step 6 ("Replies to messages from before the first window print `WARN reply parent not found`: leave those unlinked")
- **What:** after the WARN, the code falls through to the GUESS step and links the reply to the previous member of its conversation as `i`. On a first run, SKILL.md says to review GUESS lines only for the newest ~150, so older replies keep a wrong "answers" link.
- **Seen:** replay on Nov 6: `WARN reply parent not found 5` then `GUESS 5 -> 3 i`.
- **Fix:** skip the GUESS for messages with `r` set and no parent found (leave unlinked), or make SKILL.md match the code.

### B6 · P2 · Capture date parser fails silently on some labels · done (v1.3.0)
- **Where:** `helper.user.js:77-78` (`dOf`)
- **What:**
  - Only full month names ("November 3") and full weekday names ("Monday") are recognized. "Nov 3, 2026" or "Mon 9:15 AM" fall through to **today's date**, with no warning.
  - A year-less date is given the current year, so "December 28" read on Jan 4 becomes Dec 28 of the *new* year, in the future.
  - `d` drives the time-mode catch-up window and `catchup.py`'s 3-hour GUESS/ROOT rule, so a wrong date skews both.
- **Seen:** probe on Nov 6 (EXPERIMENTS.md §10). Whether real Messenger aria-labels ever use short forms is unknown. The mock only uses full names.
- **Fix:** accept 3-letter months and weekdays; if the result is in the future, subtract a year; if nothing matched, report it in the capture summary instead of using today.
- **Done in v1.3.0:** exactly that, via `mcDate(label, now)`. Any prefix of 3 or more letters of a month or weekday name is accepted. An unreadable label takes the previous message's date (closer than today) and is listed as `DATES-GUESSED #…`. 20 fixed-date cases in `tests/sim.js`.

### B7 · P3 · Mention of message #0 renders empty · done (v1.2.2)
- **Where:** `page.html:765`, `page.html:767` (`r[0]||r`); `page.html:596` uses `r[0]??r` correctly
- **What:** mention refs are `[[i]]`. For `i = 0`, `r[0]||r` returns the array `[0]`, and the snippet shows only "#0".
- **Fix:** use `??` as in the header.

### B8 · P2 · One malformed link crashes the render · done (v1.2.2)
- **Where:** `page.html:837` (`msgRow`), and `page.html:639` (legacy v1 summary)
- **What:** `new URL(u).hostname` is not guarded. A single bad entry in any message's `l` throws inside `renderMessages`, and the Messages tab (and the threads inside summary cards) render blank. The "Links shared" table already guards this (`page.html:786`).
- **Fix:** wrap the call in try/catch as at line 786; optionally validate `l` in `importCore`.

### B9 · P3 · Wrong confirmation text with auto-posting · done (v1.2.2)
- **Where:** `page.html:680`
- **What:** after "Queue reply", the status always says "Tell Claude “send” in chat (or wait for the next refresh) and confirm", even when `outboxAuto` is on and no confirmation will be asked. The page test also showed that this text only flashes: the outbox snapshot re-renders the row right away and replaces the composer with a "reply queued" chip, so the wrong wording is barely visible.
- **Fix:** branch on `CFG().outboxAuto` like `applyCfg` does, or drop the text and rely on the chip.

### B11 · P3 · Messenger's reply link to #0 is ignored · done (v1.2.1)
- **Where:** `scripts/catchup.py:88` (`if m.get('pi')`)
- **What:** `pi` is the parent's message number. When the parent is message #0, `pi` is `0`, which is falsy, so the Messenger link is skipped and the fallbacks run: quote matching, or for a photo reply "the author's latest photo". That can link to the wrong photo, the exact failure clicking photo replies was meant to prevent (EXPERIMENTS.md §4). Only replies to message #0 are affected.
- **Seen:** `tests/test_catchup.py::TestKnownBugs.test_B11_messenger_link_to_message_zero`: a photo reply clicked to #0 was linked to #1, Ana's later photo.
- **Fix:** `if m.get('pi') is not None`.

### B10 · P3 · `make-zip.sh` depends on the folder name · done (v1.4.1)
- **Where:** `make-zip.sh:4-6`
- **What:** it `cd`s to the parent folder and zips `messenger-catchup/…`, so a clone under any other name fails, and the ZIP lands outside the repo (the `*.zip` entry in `.gitignore` never applies).
- **Fix:** stage into a temp dir named `messenger-catchup/` and write the ZIP into the repo (or `dist/`).

### B12–B21 · found by an independent review of v1.4.1 (Nov 7) · all done (v1.4.2, v1.5.0)
A fresh agent with no context read the code and the procedure (B12–B20; B12 and B13 confirmed by running them). B21 turned up while tracing B15. All fixed: B12, B14, B17, B20 in v1.4.2 and the rest in v1.5.0 (details in CHANGELOG.md). What each one was:
- **B13:** `resolve()` takes a prefix match, else *any substring*, with no minimum length. A quote "ok" matches "it l**ok**s great"; "Yes" matches the latest "Yes…". It's stored as `rq` and printed as "matched by quote", which SKILL.md doesn't ask Claude to review. Fix: prefix only; quotes under 12 characters must equal the message and print as CHECK.
- **B15:** step 7 pins `threading/current`, `summary/current` and `refresh/status` "with the version you just read", but no step reads them. WORK is reused even when another session moved the database on. `refresh/status` is called a lock, but nothing checks it. Fix: read them in step 5; re-bootstrap when WORK is behind; skip a run while another is recent.
- **B16:**
  - the helper can end at "found it (hover it and click Reply)", which the Outbox steps don't handle; a reply box left open from before passes the checks and posts to the wrong message
  - a confirmation that comes late marks a sent reply `failed`, and the user queues it again
  - Fix: anything but "reply box is ready" is a failure; check the reply bar quotes `snip`; leave an unconfirmed send in `sending`.
- **B18:** deal refs (empty or out of the conversation), mention refs (missing, or "You"), `closeOpen` that matches nothing, and an open question listed twice are all accepted. A deal with no refs never shows, and `dealEdit` on it raises `KeyError`.
- **B19:** step 3 notes `win:0` but doesn't skip the rest; without the helper an empty capture reaches `build`, which fails. A scan error never resets `refresh/status`.
- **B21:** `bootstrap` sets WORK's base to the last *stored* message. If a run imported and then died before building, those messages are in no conversation, and every later build fails "message in 0 conversations". Fix: base = `threading/current.to`; the next RUN must carry #to+1 onward.

### B22–B29 · found by a second independent review (Nov 7, of v1.5.0) · all done
A fresh agent reviewed the code after the night's changes; B22 and B23 were confirmed by running them. All fixed: B22, B23, B24, B28, B29 in v1.5.1 and B25–B27 in v1.6.0. What the procedure ones were:
- **B25:** the `sending` check says "look in Messenger", which only sees what's on screen, and nothing says what to do if the reply isn't found. Fix: check the saved chunks (`f:"You"`, `r` = `to`, `b` = text, after `queuedAt`); if it's not there, mark it `unconfirmed`, tell the user, never repost.
- **B26:** step 2's pinned write can be refused when two sessions start together, and the "stopped early → set error" rule then overwrites the winner's `running`. Fix: on a refused step-2 write, re-read and skip quietly.
- **B27:** step 7 writes `refresh/status` done before step 8 drives the Messenger tab, so another run can take the tab mid-post. Fix: keep `running` (step `outbox`) through step 8.

### B30–B37 · third independent review (Nov 7, regressions since v1.4.1) · all done (v1.7.0)
A fresh agent reviewed only what changed since v1.4.1. B34 was confirmed by running it. Most findings were about the run lock's rules interacting across paths. All are fixed in v1.7.0 (details in CHANGELOG.md). It also flagged an unverified risk, that Messenger may show first names where the chat shows full names; reply matching now tolerates that (R9).

### B38 · P2 · A late-loading photo-reply parent became the next reply's parent · done (v1.14.0)
- **Found:** by the F2 test on helper 1.8. Reply #136 timed out waiting for focus. Its parent then loaded and took focus while #130 was being clicked, so #130 was linked to #136's parent with no warning.
- **Fix:** the focused parent must be from the person the reply names ("X replied to Y", including you, themself and a first-name/full-name prefix). Otherwise the result is `perr:"wrongfocus"`, which becomes a CHECK at build time, never a link.
- **Test:** sim section D with a parent slower than the 10 s wait gives `wrongfocus` and `nofocus`, and no link.

### B39 · P2 · Queuing a reply closes the conversation you're in and jumps the page · done (v1.19.0)
- **Found:** by the owner, Nov 11. After "Queue reply", the conversation the reply was written in closes and the page scrolls far down.
- **Cause (from the code, not yet reproduced in a test):** the page listens for changes to `outbox`, and every change runs `renderSummary()` and `renderMessages()`, which rebuild both lists from scratch (`page.html`, the `outbox` `onSnapshot`). The Messages tab opens only the first four conversations on a rebuild (`d.open = n < 4`), and which conversations the reader opened isn't remembered (only the summary's "Show the thread" is, in `S.openThr`). So the conversation closes, the page gets shorter and the scroll position lands somewhere else. The same rebuild runs when a refresh adds chunks or Claude marks a reply sent.
- **Fix:** keep the reader's place across rebuilds: remember open conversations (as `S.openThr` does) and the scroll anchor, and restore them; or have outbox changes update only the reply chips and outbox list instead of rebuilding everything.
- **Test:** page test that opens a conversation past the fourth, queues a reply, and checks that the conversation is still open and the composer's message is still in view; the same after a chunk arrives.
- **Done in v1.19.0 (page 2.4):** all three.
  - An outbox change no longer rebuilds anything: it refills the "reply queued" chips and the Summary's "Your replies" list in place, and closes the composer whose reply was queued (`outboxChanged`).
  - The Messages tab remembers which conversations the reader opened or closed (`S.convOpen`; a jump or "Open thread" counts as opening). Only conversations the reader never touched follow the first-four default.
  - Every other rebuild from new data (chunks, `meta/chat`, threading, summary, photos, names) keeps the reader's place (`keepPlace`): the message whose reply is being written, else the first row or card on screen, stays at the same height, and open summary threads keep their inner scroll. Chromium anchors scrolling by itself, but Safari doesn't, so the test turns Chromium's off.
  - Tests (`messagesView`): queue a reply on #26 in the fifth conversation with another closed by the reader; then a chunk arrives; then a threading update adds lines above the list. Each time the conversations stay as left and #26 stays within 2 px. All three fail on v1.17.

### B40 · P2 · A conversation that starts with a reply to an older message doesn't show that message · done (v1.19.0)
- **Found:** by the owner, Nov 11, and "a common thing". Example shape: a conversation titled after Ana's pack holds one message, #6620, Ben's "↩ reply to #6400 Ana". Ana's #6400 isn't shown, so the card doesn't say what the conversation is about.
- **Cause (from the code):** threading put the reply in a new conversation instead of the parent's. `catchup.py` only warns about a link that crosses conversations ("WARN link … crosses conversations … the page shows … as a new thread", B4), and the page shows only a conversation's own messages, so the parent shows as nothing more than a "reply to #n" chip.
- **Fix options:** (a) the page shows a cross-conversation parent as a quoted context line at the top of the conversation, with a jump to it; (b) the refresh skill joins such replies to the parent's conversation, or starts the new conversation with the parent; (c) both. (a) also fixes pages that were already built.
- **Test:** page test with a conversation whose first message replies to a message in another conversation: the parent's sender and text appear as context, and the jump goes to it.
- **Done in v1.19.0 (page 2.4), option (a):** when a conversation's first shown message replies to (or answers, or continues) a message that isn't shown in it, the conversation opens with a quoted context block: "Replies to a message in “<that conversation>”" (or "an earlier message" when it's in the same conversation, before the catch-up window) and "Show #n →", which jumps to it, above the message itself as the page shows messages: sender, time, full text and photos. When that message starts or continues a run of bubbles (B42), the whole run shows as one block. The block is indented, with a left rule and a muted background, so it reads apart from the conversation's own messages. A parent that isn't stored shows what the reply knows (who, the quoted text) and says it isn't stored on this page, with "Find it in Messenger" when the reply carries its id. It shows in the Messages tab's threaded layout and on the Summary card (owner's review of #36: show the message itself, not a reference to it). Option (b), joining such replies in the refresh skill, is still open if the owner wants it.

### B41 · P2 · Full names are missing on a live page, so people who share a first name aren't told apart · done (v1.20.0)
- **Found:** by the owner, Nov 11: two Bens still both show as "Ben".
- **Measured on the owner's page (counts only):** 7 of 6,933 stored messages carry `fn`, all from #6921 on (captured Nov 11). `people/index` lists 4 people. F9 shipped in v1.10.0 and v1.11.0, but this page captured no full names until tonight, and the one-time backfill scan (`references/people.md`) hasn't filled the index.
- **Likely causes, to confirm:**
  - The installed helper predated `fn` capture and only updated itself on Nov 11; self-update checks about daily.
  - The backfill scan defers when the helper is older than 1.7 ("try on a later refresh"), and nothing retries it or reports that it's still pending.
  - Even now only 7 of the 12 newest messages have `fn`: Messenger shows the avatar once per run of messages from the same sender.
- **Fix:**
  - Each refresh reports when full names aren't being captured, and when the backfill is still pending.
  - Run the backfill once the helper is current.
  - Give a sender's consecutive messages the `fn` read from the one avatar.
- **Test:** a sim with grouped messages and one avatar per run, where every message in the run gets `fn`; and a skill-text test that a pending backfill is retried and reported.
- **Done in v1.20.0 (helper 2.0):**
  - **Runs:** the scan gives every message in a run from one shown sender the full name from that run's avatar, but only when the run's avatars all name one person, so two people who share a shown name never borrow each other's.
  - **Reporting:** `references/people.md` makes each refresh say "Full names: not captured" (with the helper version and why) and "Full names: one-time scan pending" until `scannedAt` is set. SKILL.md step 8 also sends Claude there when this run's messages from others carry no `fn`. The scan runs on every refresh until it succeeds, so it starts by itself once the helper is 1.7+. The scan and `selfcheck` warn when no avatar can be read.
  - **Tests:** sim `E: grouped runs with one avatar each` (fails on helper 1.9); `TestHelper2.test_names_are_reported_until_captured_and_the_backfill_retried`.
  - **Still to see live:** whether Messenger puts a run's avatar on its last message (as in the mock) or its first; either works as long as each run shows one.

### B42 · P3 · A person's text and the photo they sent right after show as two separate messages · done (v1.19.0)
- **Found:** by the owner, Nov 11. Ana's text (#6739) and the photo she sent the same minute (#6740) show as two full rows. The second has its own number, time, name, actions and a "… continues #6739 Ana" line. Messenger shows them as one block.
- **Cause:** Messenger stores each bubble as its own message (`data-message-id`), so the capture is right. Threading links the second with a `c` link ("same person continuing", `catchup.py:348`), and `convTree` already places it right after the first (`page.html` › `convTree`). But the row renderer gives a `c` row the full header and its own actions, labelled "… continues".
- **Fix (owner's call, Nov 11: like Messenger):** render a run of `c` messages from the same sender within a few minutes as one block. One header (name, time), each bubble's text or photo stacked beneath it, and the message numbers kept but quiet. As in Messenger, each bubble keeps its own actions ("Reply in Messenger", "Reply here"), shown when you hover or tap that bubble instead of under every one. Replies to any bubble still nest under the block. Search, jumps and #n links must still find each bubble. The owner expects this to help the Messages view a lot.
- **Test:** a page test where text plus a photo from the same sender within a minute renders as one block with one header, and both #numbers are reachable by jump and search; a gap of more than the window, or a different sender, still makes separate rows.
- **Done in v1.19.0 (page 2.4):**
  - **The rule:** a message joins the block above it when it's from the same sender (same full name when both have one), sent at most 5 minutes after the previous bubble (`RUN_MS`), and threading links it to a bubble in the block with `c`. In the timeline it must also be next in the list; for messages threading doesn't cover yet, any next message from the same sender that isn't a Messenger reply joins.
  - **The block** (`.grp`): one header (name, any reply chip of the first bubble, the first bubble's time), each bubble's text or photos stacked beneath it. Every bubble is still its own row (`#m<i>`, `data-i` in summary threads) with its own number, kept quiet; its time shows on hover. Replies to any bubble nest under the block. It works in the timeline, the threaded layout, "Not grouped yet" and the Summary's "Show the thread".
  - **Actions (every message, owner's review of #36):** each message and each bubble keeps its own "Reply in Messenger", "Open photo" and "Reply here". With a mouse they float in a small bar at its top right while you hover it; with a keyboard they show when one of them has focus (Tab reaches them, focus ring visible); on a phone (no hover) they appear under it when you tap it. Link previews, reactions, the "reply queued" chip and an open "Reply here" composer stay visible.
  - **Search:** `#123` in the filter finds message 123.
  - Tests (`messagesView`): the block and its single header; a reply to the second bubble nests under it; an 8-minute gap and a different sender stay separate; hover and keyboard focus show only that bubble's actions; "Reply here" on the second bubble queues `i:31`; the `#31` link and the filter (`#31`, text) find each bubble, threaded and timeline; the Summary thread shows the same block; on a phone a tap shows the actions and nothing scrolls sideways.

### B43 · P1 · Threading and summary outgrow the 256 KiB per-document cap · done (v1.17.0)
- **Found:** measured on the owner's live page, Nov 11 (sizes and counts only). An artifact database document holds at most 256 KiB (262,144 bytes; runtime contract 0.2.92, which also caps a database at 25,000 documents; the ArtifactData tool takes 50 writes and 1 MiB per batch).
  - `threading/current` was 185.6 KB compact: 504 conversations (75 KB) and 6,068 links (110 KB). It grows about 20 KB a day, so it would be full in about 3 days, and every refresh's step-7 write would fail after that.
  - `summary/current` was 249 KB that morning and 215 KB with 315 conversations by evening. Refresh sessions had improvised a rolling window: they dropped older conversations and wrote an undocumented `fromI` (now 2797). Those summaries are lost.
  - Both only ever grew: `catchup.py` never split or pruned, and the chat adds about 460 messages a day. The design target is 50,000+ messages.
- **Owner's decisions:** archive and keep everything (older conversations move to documents the page still reads and shows; nothing is dropped); no re-setup (pages convert on their next refresh, and the page reads the old layout too); a MINOR release with `PAGE_VERSION` 2.3.
- **Fix (v1.17.0):**
  - **Layout:** `threading` and `summary` are collections. Each `current` names its block documents (`blocks`), one per 1,000 messages. Threading links and members go to the block of their message, and a conversation's title to the block of its first message. Summary items newer than `activeFrom` (the block before the newest) stay in `current`; older conversations, open questions, answers, mentions and deals go to the block of their messages, and a conversation's older bullets to the block they cite (`syn`). Merging gives back the exact old documents, order included.
  - **Safe writes:** a block's id carries a hash of its content, so a changed block is a new document, written before `current` names it. An interrupted run changes nothing the page reads, and a retry finds the blocks it already wrote. Old blocks are deleted after the write succeeds; unknown documents are never touched.
  - **`catchup.py`:** bootstrap reads either layout. Build writes only the changed documents and `RUN/out/manifest.json` (batches within the tool's limits, pins, cleanup). It fails before writing anything if a document would be over 240 KiB, checks that the documents merge back into the built state, and refuses a WORK that the database has moved past. `fromI` is defined (the first message the stored summary covers) and kept as is.
  - **Page 2.3:** subscribes to both collections and merges them. Every view reads the merged objects, so it renders as before.
  - **Refresh skill:** bootstrap and step 5 list both collections; step 7 writes the manifest; a hard rule never to drop or shorten anything to save space; `references/writing-the-build.md`.
  - **Measured** on synthetic chats calibrated to the owner's page (`tests/synth.py`): from 6,400 to 50,000 messages the largest document is at most 84 KB (85 KB with a 1.6× denser summary), at least 3× under the cap; threading blocks stay under 31 KB. A build writes about 4 documents in one batch (EXPERIMENTS.md §13).
  - **Also fixed:** a build that continued a conversation whose summary an earlier session had dropped crashed (`KeyError`); its summary now starts again.
  - **Review of the PR** found five more, all fixed before merging, each with a test that failed first: the cleanup could delete blocks no `current` named (after an older skill wrote back its single documents); a relink after a cleanup could name a deleted block; a build accepted a listing without the blocks; the page silently skipped a missing block; and a batch that stopped partway wasn't covered (bootstrap now stops on it, and `--rollback` recovers).
  - **Tests:** a fake database that refuses what the real one refuses (documents over 262,144 bytes; batches over 50 writes or 1 MiB; unpinned writes to existing documents); migration with `fromI`; builds at 6.4k, 25k and 50k messages; a link correction in its block; interrupted migrations and retries; the size check; bootstrap from either layout; the page rendering both layouts the same, and the old layout as v1.16.2 rendered it.

### B44 · P1 · First refresh on 1.17.0: three problems · done (v1.17.1)
- **Found:** by the owner's first live refresh on 1.17.0 (GitHub issue #33). The conversion was finished by hand that time.
- **Conversation ids used twice:** older sessions created two conversations with one id. The block layout keys members by id, so the build's merge-back check stopped it ("internal error … don't merge back"). `bootstrap` now renames the second one to id + its first message number (the summary stays with the first) and says so; a summary with an id used twice stops bootstrap with what to do.
- **Chunk names:** bootstrap and build named chunks as `i // chunkSize * chunkSize`, but the page starts chunks where imports landed. They now name the chunk from the stored chunks' starts (kept in WORK's `state.json`); `open-message.md` and `troubleshooting.md` look the chunk up by `start` instead of working it out.
- **The refresh skill's description stopped at `"open`:** an unquoted ` #` starts a YAML comment, which dropped the open-message and wrong-link triggers. Both descriptions are quoted now.
- **Tests:** `TestIssue33` (renaming, then a conversion and a build; a summary duplicate; chunk names from stored starts) and `test_descriptions_survive_yaml`; all four fail on 1.17.0.

### B45 · P2 · Multi-line replies can't post · done (v1.18.0)
- **Found:** in the owner's field report (issue #32 §3). Messenger's editor (Lexical) doesn't turn the line breaks inside `execCommand('insertText')` into breaks, so a reply with `\n\n` came out as one line, and `outbox.md`'s check `box.innerText.trim()===text.trim()` failed every multi-line reply.
- **Fix (owner's option A):** type the first line in call 1; in call 3, for each later line press shift+Return and insert that line (an empty line gets only the shift+Return, so blank lines stay). The check compares the box with the reply with whitespace collapsed. The page keeps what the user wrote.
- **Tests:** `tests/composer.sim.js` runs `outbox.md`'s code blocks word for word on a stand-in composer that drops line breaks the way Lexical does (`tests/mock/composer.html`), with the real helper's `jump`: the reply goes out with its paragraphs, blank line included; inserting the whole text at once gives one line; a box that doesn't match makes the check throw and Return sends nothing. `TestOutboxPosting.test_multi_line_replies` checks the text.

### B46 · P3 · `sentAt` was estimated · done (v1.18.0)
- **Found:** in issue #32 §5: several rows had `sentAt` rounded to the minute and later than the row's own last write. The page shows `sentAt`.
- **Fix:** the confirm returns the clock time (`at`), which becomes `sentAt`; a row settled on a later refresh takes the saved message's time (`d` and `t`, in `meta/chat.tz`). Every `sent` write sets both `sentAt` and `sentMid`, including when the user says it went out (`sentMid:null` only if it isn't in the saved messages).
- **Tests:** `TestOutboxPosting.test_sent_always_has_a_real_sent_at_and_sent_mid`; the sim checks the confirm's `at` against the clock.
### B47 · P2 · A build can't add bullets to a conversation with an old string synopsis · done (v1.18.1)
- **Where:** `catchup.py build`, the `bullets` loop: `SC[cid]["synopsis"].append(...)`.
- **What:** pages from before the bullet format still hold some conversations whose `synopsis` is one string (62 of the 91 the trim dropped on the owner's page, issue #32 §4; some kept ones too). A spec giving such a conversation a bullet crashed the build with `AttributeError`. Found while writing F10's restore, which brings those conversations back.
- **Fix:** the build first splits the string into bullets the way the page shows it (`synItems`: one per sentence, no refs). Older bullets with no refs no longer fail the build's ref check; a new bullet still needs refs.
- **Test:** `TestRestoreSummary.test_a_build_adds_bullets_to_an_old_string_synopsis` (fails on 1.17.1); `test_old_string_synopses_split_as_the_page_splits_them` runs the page's `synItems` in node and compares.

### B48 · P2 · Reply on a photo-only message fails · done (v1.20.0)
- **Found:** live field report, GitHub issue #32 §2, on helpers 1.1 and 1.9. A message that is only a photo has no "Reply to this message" button on its hover toolbar, so `jump` ended with "found it (hover it and click Reply)" and outbox.md marked the reply failed.
- **Fix (helper 2.0):** when the toolbar has no Reply button, `jump` clicks `[aria-label="More actions"]`, then the `role="menuitem"` whose text is "Reply" (Escape if the menu has none). The page's Reply links (installed helper and bookmarklet) and `post` get it too. SKILL.md's allowed clicks name More actions › Reply when posting an approved reply; `references/posting-with-helper.md` has the rule.
- **Tests:** sim `F: jump{reply} on a photo-only message opens Reply through More actions` and `F: post replies to a photo-only message through More actions` (both fail on 1.9).
- **Older helpers:** with a helper before 2.0, outbox.md's call 1 still sees "found it (hover it and click Reply)" and marks the row failed; the helper updates itself within a day.

### B49 · P3 · A stalled scan hangs, or truncates a first run · done (v1.20.0)
- **Found:** GitHub issue #32 §5: once, `full`'s scan barely grew for minutes until the tab was reloaded. From the code (R3 review): a scan with stops only ended after 1,500 steps (about 37 minutes at the top of the chat), and a first run called it the top of the chat after 8 tries there, so a slow load truncated the first capture and verify agreed.
- **Fix (helper 2.0):** nothing new for 30 s (`stallMs`) ends the scan (and verify) with `err:"stalled"`; `references/helper.md` › Scan results says to reload and retry once. The top of the chat now needs 8 tries and 12 s with nothing loaded and no loading spinner at the top; a scan with stops that reaches the top ends with "… (reached the top of the chat)"; results carry `top`. SKILL.md: the first poll after `full` may fail with "Inspected target navigated", which is expected.
- **Tests:** sim `E: history stops loading …: err "stalled"`, `E: a first run that stalls is "stalled", not a truncated "top of the chat"`, `E: anchors that are gone …` (the first two fail on 1.9).
- **Still to see live:** whether Messenger's loading indicator is a `[role="progressbar"]` at the top of the list. If it isn't, a stall at the top still reads as the top after 12 s, as before; if one were always there, a short chat's first run would stall instead of finishing.

### B50 · P3 · `troubleshooting.md` says `VERSION` ships with the skill · done (v1.22.0)
- **Found:** writing F5's design. `references/troubleshooting.md` › Tested said "The skill's version is in `VERSION` (shipped with it)". `VERSION` is at the repo root, not in `plugin/`, so an installed skill can't read its release version.
- **Fix:** the line now says the release version is the plugin's and isn't in the skill's folder, and names what the skill can read: `PAGE_VERSION` in `assets/page.html` and `@version` in `assets/helper.user.js`. F5 compares those for the same reason.

### B51 · P3 · A view reply could pose as a method idea · done (v1.22.0)
- **Where:** `page.html`, Views › Build view: the model's JSON was saved as `{ kind: "view", ...v }`, so a reply carrying `kind: "idea"` replaced `kind: "view"`. Method ideas (`views/*` with `kind:"idea"`) are what Claude checks and acts on after each refresh (the refresh skill's SKILL.md › Method ideas). Found in the review of PR #42; it predates F6.
- **Fix:** `{ ...v, kind: "view" }`. Test: page `history` › `B51` (a reply with `kind:"idea"` is saved as a view); it fails on the page before the fix.

## Risks

### R1 · P1 · Unpinned page writes; half-finished imports · done
- **Where:** `page.html:977-990`
- **What:**
  - The importer writes chunks, then `meta/chat`, then `photos/index` (read-modify-write) with no version pins. SKILL.md's "pin every write" rule only covers Claude. The `S.pasting` guard only stops a double paste in the same tab. Two page tabs, or the page and Claude writing `meta/chat` at the same moment, can overwrite each other.
  - If the chunk writes succeed but the `meta/chat` update fails, the next import refuses ("The newest stored chunk doesn't end at #…"). Nothing documents how to recover.
- **Fix:** use version pins if the page database API supports them. Add a Troubleshooting entry: compare the last chunk with `meta/chat.lastI` and either trim the chunk or set `lastI`/`lastMid`/`anchorMids` from it.
- **Done in v1.2.0:** the runtime contract (0.2.96) has no version pins or transactions, only a cooperative lease (`acquire`), so:
  - **Lease:** a 2-minute lease on `refresh/importLock` per import.
  - **Fresh reads:** `meta/chat` and the newest chunk are read from the store (query, falling back to a `get` of the snapshot's newest chunk).
  - **Auto-repair:** when chunks run ahead of `lastI` (they were read back before `meta/chat` was due, so they're trustworthy).
  - **Clear refusal:** when `lastI` runs ahead of the chunks.
  - **No partial writes:** no write of any kind until the capture passes every check.
  - **Delivery:** `PAGE_VERSION` → 1.2, and SKILL.md now republishes behind-version pages on refresh.
  - **Tests:** 17 page checks, shown to fail against the v1.1.2 page (EXPERIMENTS.md §12).
- **Still true:** a page and Claude can both write `meta/chat`. Claude's writes are pinned, and the page only merges its own fields (`update`), so neither side clobbers the other's fields.

### R2 · P2 · Photos lost when the page tab closes mid-upload · done (v1.22.0)
- **Where:** `helper.user.js:103-105`, the page's importer
- **What (first filed):** every photo in the window travels base64-encoded inside the clipboard text, and the real limits of clipboard, paste and upload hadn't been measured.
- **Measured (Nov 12, EXPERIMENTS.md §14):** not the limit. Captures up to 400 MB copy, paste and import locally in under 3 s; the helper fails only at about 512 MB (JavaScript's longest string). Live: about 0.5 s per upload and about 54 KB per photo on the owner's page.
- **The real loss:** the page wrote `photos/index` only after every upload finished, and step 5 closed the page tab 8–10 s after the paste. A tab closed mid-upload left the photos that had landed unindexed (lost), and a re-paste uploaded them again as duplicates. A quota failure said "paste again", which could never work, and `photos/index` would have hit the 256 KiB cap at about 2,500 photos.
- **Done in v1.22.0 (owner's decisions, Nov 12):**
  - The page indexes each photo as it lands, in 500-message block documents `photos/b<start>`; `photos/index` is read, never written. Owed slots are `null` and counted in `meta/chat.photosOwed`.
  - `refresh/lastImport` says `uploading` with a 10 s heartbeat that also renews a 60 s import lease, then `done` or `partial` with a `stop` code; each upload error code has its own handling (retry once, wait and retry, give the photo up, or stop with the right advice).
  - `references/photos.md`: Claude waits while the heartbeat moves, at most 10 minutes (stall: two of its reads at least 60 s apart with the same beat), never closes the page tab while uploads run, and the next run backfills owed photos by scanning from just before them, up to 300 messages behind the newest; older ones are given up and reported. Every new photo is still opened (no cap). No capture splitting.
  - Photos stay the original files. Asset usage is recorded with each import (`meta/chat.assetUsage`), the page warns at 80% of either limit, and `photos.md` › Cleanup removes duplicates and unused files, only when the user asks and confirms (R13 is the long-term fix).
- **Tests:** page section `photos` (P1–P23 and the usage checks; the key ones fail on 2.6), `standIn` (scripted uploads, quota, `list`, `steal`, paste waits), sim section G (the backfill scan and multi-photo captures), `TestPhotos` in `tests/test_tools.py`.

### R13 · P2 · A page holds at most 5,000 photo files
- **Found (Nov 12, live, read only):** the owner's page has 715 asset files against claude.ai's 5,000-file limit per artifact (bytes: 38.8 MB of 1 GiB), growing about 55 files a day, so it reaches the limit in roughly 11 weeks. There are also more files than indexed photos (715 against 549 in the old `byI`), probably copies from re-pastes before v1.22.
- **Now (v1.22.0):** the page records usage with each import and warns at 80%; `references/photos.md` › Cleanup removes copies and unused files on the user's say-so. That buys time, not a fix.
- **To design:** for example keep older photos as links only (Messenger's own, which expire), move older photos to an archive page with its own quota, or store a smaller copy of old photos. Each has costs (lost photos, a second page to maintain, re-encoding the owner ruled out for now).

### R15 · P3 · Photos the helper couldn't fetch aren't recorded as owed
- **What:** when the helper can't fetch a photo (`FAILED #…` in the capture summary), the capture has no slot for it, so the page never marks it owed and no backfill retries it.
- **Fix:** the helper lists them (`phfail:[{i,k}]`, helper 2.1) and the page records them as owed `null` slots, so the next run's backfill retries them like any other owed photo.

### R16 · P3 · Backfill captures can misplace a photo's slot, and fetch every photo again
- **Found:** the review of PR #42 (v1.22.0).
- **Slot shift:** the helper numbers a message's photos `k` = 0, 1, … in the order of the images it finds loaded. On a backfill scan (messages already stored, scrolled past quickly), an image that hasn't loaded yet is skipped, so the photos after it take a lower `k`. The page then stores a photo in another photo's slot: the owed slot stays owed and a stored slot is skipped as "already stored", or a photo lands under the wrong `k`.
- **Refetching:** a backfill window of up to 300 messages fetches and base64-encodes every photo in it, stored ones included, only for the page to skip them. The paste grows with every stored photo in the window.
- **Fix (to design):** key slots by something stable (the photo's Messenger attachment id from its link) instead of position, and let the helper skip photos the page says are stored (for example a `skip:[{i,k}]` or attachment-id list passed to `full`); helper 2.1 with R15.

### R17 · P3 · The helper notice runs ahead of the release
- **Found:** the review of F5 (PR #42). Marketplace installs pick up a merge on `main` at once, so the next refresh writes the new `versions.helper`. Self-updating helpers fetch from `releases/latest`, which `tools/release.sh` publishes only after the merge. In between, notice E tells the user to check for updates or open the install link, and both still give the old helper; the notice stays until the release is out and the helper has updated.
- **Options:** run `tools/release.sh` straight after every merge that bumps the helper (today's practice, so the gap is usually minutes); or have the page hold E until a day after `versions.helper` first appears (a `since` the skill keeps), which the owner turned down for F5 ("flagged right away").

### R3 · P3 · Messenger markup dependency (known) · done (v1.20.0, option B)
- English UI labels, `[role="log"]`, `data-message-id`, "Go to replied message", "Reply to this message", the `At <time>, <name>: ` aria-label shape. See F4.
- **Silent failures found in a review of helper 1.9:** a reply whose "X replied to Y" line can't be read accepted any focused message as a photo-reply parent; both reply markers reworded at once read as no replies; time-only labels became "today" whatever the day; photo selectors (`messenger_media`, `fbcdn`, the GIF size rule); the avatar picking the wrong image; the scroller being the first scrollable div; the top of the chat declared after 8 tries; English label lists.
- **Owner's call (Nov 12):** option B, turn silent failures into warnings; for a non-English page, warn and continue.
- **Done in v1.20.0 (helper 2.0):** `selfcheck` and the scan's result (`warn`, also `mc_result.warn`) warn about reply links without a reply line, quotes without reply links, photo links with no Facebook image, times going backwards or into the future (an hour back is allowed for clock changes; the last stored message is included), one shown name with full names that don't share a first name, no full names at all, a page language that isn't English (named), and a 24-hour clock (now read and converted, with day-first dates). A reply whose reply line can't be read gets `perr:"noreplyline"`, never a link. The scroller is the nearest scrollable ancestor of a message, reported as `scroller`; results report `top`; stalls are B49. `references/helper.md` says what each warning means for the report.
- **Tests:** sim section E: each warning in its mock mode, all quiet on the normal mock and in A1's full run; the `perr` guard; the inner scroller. The key ones fail on 1.9.
- **What remains:** the reader still depends on English labels and this markup. A changed label now shows up as a warning or a `selfcheck` failure instead of wrong data, except when every marker of a feature changes at once (for example all three reply markers). `catchup.py` prints a reply with `perr:"noreplyline"` as `CHECK reply with no readable reply line` and leaves it unlinked (PR #38 review).

### R4 · P3 · Whole history in memory and in one prompt
- **What:** the page rebuilds the full list on every chunk change; Ask Claude with "include older messages" sends every stored message (~3,900 and growing). `prompt_too_large` is handled but makes the option useless.
- **Fix:** see F6.
- **Date-range mode fixed in v1.20.1:** `inWin()` worked the window out once per message and citation (5–6 s per update at 6,400 messages). It's now worked out once per message list and marker; the page section `speed` counts it.
- **The 256 KiB per-document cap is now handled for summary and threading** (B43, v1.17.0): each is a collection of block documents, so no document grows with the history. The page still holds every chunk and block in memory.
- **Prompt size done in v1.22.0** (F6): Ask, Views and range summaries measure their prompt in UTF-8 bytes against `sample.limits()`; "include older" works at any size. The page section `history` counts it (H1–H16).
- **What remains is F15:** "Show older messages" still renders every stored message (0.5 s and 79k elements at 6,400 messages in an earlier bench). The default view is the window only.

### R5 · P2 · E2EE and messenger.com
- **What:** `/messages/e2ee/t/` URLs are stored and used but untested against a live E2EE chat. The userscript `@match` covers only `www.facebook.com/messages/*`, so `messenger.com` isn't supported.

### R6 · P2 · Scheduling tool names · done (v1.21.0)
- **Where:** SKILL.md › Scheduling
- **What:** Options A and B name `send_later`, `create_trigger` and `requires_local_device: true`. These come from the environment the skill was built in. Check that they still exist under those names wherever the skill is installed, and give a fallback if they don't.
- **Found (Nov 12, web):** the names exist only in user bug reports, never in Anthropic's docs, and differ by app (`CronCreate` in Claude Code). `create_trigger` with `requires_local_device:true` can come back "cloud only" without failing; a device-bound task is paused the first time it fires on a sleeping computer; one-shots can be delivered twice or fire again; `ScheduleWakeup` outside `/loop` never fires (LEARNINGS › Scheduling tools).
- **Done in v1.21.0:** new `references/scheduling.md` (refresh skill; setup's copy kept by `npm run sync`), the only file in the plugin that names a tool, each by what it does; Claude uses only a tool it can see. Setup's Scheduling is a ladder (chain, recurring task kept only if bound, manual) plus Stop or change. Live state in a new `refresh/schedule` `{armId, nextAt, tool, lastRunAt, misses, problem, switchAskedAt}`. Every chain follow-up and recurring prompt carries a token (`armId`); only the matching one runs, and arming is a pinned write before the tool call, so there's only ever one schedule. A refresh the user asks for reports `problem` and `misses`, asks before restarting a dead chain, checks a quiet recurring task, and offers once to switch an older schedule.
- **Owner's calls (Nov 12):**
  1. Keep the recurring task as step 2, kept only if the tool's result confirms it's tied to this computer; otherwise the user creates it in the app with "Require this computer" on.
  2. A refresh the user asked for that finds the chain dead (`nextAt` more than 30 minutes past, inside the chosen hours) asks before re-arming. A scheduled run never asks: that it runs shows the chain is alive.
  3. No backoff: runs that can't reach Chrome keep the chosen interval. `misses` and `problem` are still recorded for the next refresh the user asks for.
  4. The Claude Code CLI is supported (one-time `CronCreate`), with a warning that the session must stay open.
  5. The page's own Desktop wording waits (R10); `PAGE_VERSION` stays 2.5.
  6. Older modes (`"A"`, `"loop"` or anything unknown, and `"B"`, which is a recurring task): see the review's H1 below. (The first version converted them on the first arm.)
- **Review of PR #39** (an independent review before merging). Each fix has a test, and a mutation check (each of 49 rules removed one at a time) failed a named test every time:
  - **H1, old schedules that weren't chains** (owner's calls): `"B"` is a recurring task, and `"A"`, `"loop"` or anything else a chain or loop. Their scheduled runs do exactly what their own message says: no conversion and no question. No restart is ever offered from `lastRefresh`. The first time the user types a refresh request, Claude explains once (`switchAskedAt`) that scheduling moved to a new scheme and asks whether to switch. On yes, Claude cancels the old follow-up, task or cron with a visible tool, or the user deletes it in the app and says so. Only then does Claude arm the new chain. Setup's Stop or change cancels an older mode's task before setting up a new one. Two schedules are never left alive.
  - **H2:** recurring prompts carry the token too (`(recurring <armId>)`). Stop or change clears it, so leftover tasks go stale, and a recurring task Claude can't cancel is deleted by the user. An unbound task gets a new token before the user creates theirs.
  - **H3:** an overnight arm is capped at the tool's longest delay; the run it starts lands outside the hours and arms again.
  - **M1:** SKILL.md reads the reference before anything else, Before each run included, so a stale message never bootstraps or republishes.
  - **M2:** a chain isn't dead while a run is going (`refresh/status` running in the last 20 minutes, or `lastRunAt` in the last 30). The check is skipped when the user's refresh lost the lock.
  - **M3:** a refused arm write is read again, and arming stops only if another session's token is there; otherwise it retries. The mode write comes after the tool call, is retried once, and never holds the call up.
  - **M4:** `refresh/schedule` may be missing: writes create it, and a missing `nextAt` means no chain. Setup creates it for every choice and seeds `schedule` as manual until its last step. `first-run.md` skips the schedule check.
  - **M5:** a failed arm sets `nextAt:null` and says so in that run's report, so the next refresh the user asks for offers the restart right away.
  - **L1:** `hours` is `{from, to}` (`"HH:MM"` in `tz`), start included and end excluded, wrapping past midnight, with 5 minutes' early tolerance. Times are ISO, UTC. A recurring task counts as quiet from the window's start.
  - **L2:** tokens get 4 random characters.
  - **L3:** every arm sets `misses`, a lock skip counts as reaching Chrome, and a report clears it.
  - **L4:** no `schedule` counts as manual.
  - The reference's cap rose to 8,000 bytes (7,906). Refresh `SKILL.md` stays at 19,755.
- **Second review of PR #39** (no High). Each fix has a test, and the mutation check (now 72 rules, including three edits the first tests let through) fails a named test every time:
  - **M-a:** a message that names the page URL, `chatUrl` or thread id, or asks to schedule a run, is scheduled (a typed request never contains those). The "typed by the user" guard covers the whole After section, "Chain stopped" included. `switchAskedAt` is written once the user answers, so a misfire doesn't use up the question.
  - **M-b:** Arm step 6 converts only older or missing modes, never `"manual"` or `"recurring"`, and only while `armId` is still the token just written, so it can't undo a stop or change.
  - **M-c:** an old chain with no stored `schedule` (the first setups stored none) keeps running as its prompt says; only an explicit `"manual"` makes older messages stale, and a refresh the user asks for checks the schedule even when `schedule` is missing.
  - **M-d:** switching waits for a delete only for a recurring task (`"B"`) or recurring cron that can't be cancelled; an old chain switches at once and ends at its next follow-up. Setup's Stop or change follows the same rules.
  - **M-e:** re-running setup on a page with a schedule set does Stop or change first.
  - **Lows:** a refused `lastRunAt` write redoes the stale check; Arm step 5's failure write needs `armId` still to be this run's token, and only covers a tool that returns; outside-hours runs keep `misses`; a refused lock write still reschedules a scheduled run (SKILL.md step 1); for an older message "reschedule" means what that message says; "the start of the current window"; no `hours` means all day; R12 notes the conversation length limit; R14 filed. Setup's choice 2 clears a `problem` left by choice 1. The refresh SKILL.md Database section names `refresh/schedule`.
  - Sizes: the reference's cap is 8,500 bytes (8,444); refresh `SKILL.md` is 19,771 (budget 19,780).
- **Tests:** `test_tools.TestScheduling` (34 tests; the first 20 each failed before the change).
- **Still to check live** (none could be run from the repo): the owner's `meta/chat.schedule` and which tool armed their loop; `send_later` in a Desktop chat with a 2-minute delay, with Desktop open and quit; the longest `delay_minutes` it takes (an overnight arm needs 8 h or more; if it's shorter, arm in steps); whether `send_later` from inside a follow-up asks for approval; `create_trigger`'s exact result text under each approval mode; claude.ai in a browser with Desktop closed (settles the Desktop requirement's wording); a `CronCreate` chain in the CLI firing twice; a second delivery taking the stale path; and an end-to-end run on a scratch page, including a `mode:"loop"` page whose old follow-ups keep running as they say until the user types a refresh and switches (an old chain then ends at its next follow-up; a recurring task or cron is cancelled or deleted first).

### R8 · P2 · PR rule not enforced · done (v1.7.2)
- **What:** from v1.1.1 every change must go through a PR with a version bump (CLAUDE.md), but `main` still accepts direct pushes, and nothing runs `npm test` on a PR. The version-consistency tests only catch a missing bump when someone runs them.
- **Fix:** branch protection on `main` requiring a PR (and, once T5 exists, a passing check). Check whether the plan allows it on a private repo. Then T5: a GitHub Actions job running `npm test` on every PR.
- **Done in v1.1.2, as far as the plan allows:**
  - Branch protection and rulesets return 403 ("Upgrade to GitHub Pro or make this repository public").
  - Instead: CI runs `npm test` and a version-bump check on every PR; a `pr-only` job turns `main` red when a commit arrives without a merged PR (verified that the commit→PR API tells a squash merge from a direct push); a `pre-push` hook blocks direct pushes from local clones.
- **Done in v1.7.2:** the owner made the repo public (Nov 7) after an audit found no chat data in the files, history, PR bodies, secrets or CI artifacts. Branch protection on `main`: PR required (no approvals, single maintainer), `test` and `version-bump` required and up to date, linear history, no force-push or deletion, enforced for admins. Tags aren't protected; `tools/release.sh` pushes them.

### R7 · P3 · Helper housekeeping · done (v1.3.0)
- **Where:** `helper.user.js:16`, `helper.user.js:162`
- **What:** each `mcScan` adds a capture-phase click listener that is never removed. It goes inert after a scan, but turns on again during the next one. A `setInterval` polls `location.href` every 800 ms for as long as the tab is open. Both are harmless today.
- **Done in v1.3.0:** the listener is registered once per page load. The 800 ms URL poll stays on purpose: Messenger navigates with `pushState`, which fires no `hashchange`, and the poll is what notices a `#mcjump=` URL arriving that way. It costs one string compare.

### R10 · P3 · The page doesn't mention the Claude Desktop app
- **Where:** `page.html` › "Your computer has to be online…" (about line 1388)
- **What:** v1.21.0 added "the Claude Desktop app is open" to the requirements in the setup skill and README: Claude in Chrome needs it when Claude runs from claude.ai, the phone, Cowork or a scheduled run. The page's own requirements text doesn't say so.
- **Fix:** add the line with the next page change (it bumps `PAGE_VERSION` and republishes every page, too much for one sentence). Check first whether claude.ai in the same Chrome needs Desktop open (R6's live checks); if not, drop that case from the wording everywhere.

### R11 · P3 · Desktop local scheduled tasks
- **What:** the Desktop app's local scheduled tasks run on the computer while the app is open, with one catch-up run after waking. If such a task's session has Claude in Chrome, it would be a sturdier recurring option than a device-bound cloud task. Unchecked, so `references/scheduling.md` doesn't list it.
- **Fix:** create one in a Desktop Code-tab session and look for the Claude in Chrome tools in its run; if they're there, add the tool to `references/scheduling.md` › Tools.

### R12 · P3 · A chain conversation keeps growing
- **What:** every hourly run adds tool output to the same conversation, so each run costs more over weeks. Predates v1.21.0. Arming at `every` minus 5 minutes keeps runs inside the prompt cache, but the context still grows.
- **Also:** a claude.ai conversation has a hard length limit. Once a chain's conversation reaches it, follow-ups can't be delivered and the chain stops (a refresh the user asks for then finds it stopped).
- **Fix:** measure a chain's cost per run after a week or two; if it climbs, or the conversation nears its limit, have a run move the chain to a fresh conversation now and then (setup's Stop or change, then arm from the new one).

### R14 · P3 · Arming at the end of a run · done (v1.23.0)
- **What:** a chain run arms the next one after the refresh steps, however they end. A run that dies mid-refresh (the session is cut off, a tool call never returns) arms nothing, and the chain stops until a refresh the user asks for offers to restart it.
- **Option:** arm early, right after the stale and hours checks, so the next run is already pending; the run would then only update `misses` at the end. Kept at the end for v1.21.0 (owner's call after the second PR #39 review: less churn).
- **Done in v1.23.0** (owner's call: arm early). `references/scheduling.md` › A scheduled run:
  - **Step 5:** after `lastRunAt`, a chain run Arms before the refresh steps. The early arm writes a new `armId` and `nextAt` and leaves `misses` alone (Arm step 4).
  - **Losing or failing the arm:** if Arm stops because another session armed (a duplicate delivery), the run is superseded and stops without refreshing. If Arm fails (no tool, or a tool error), it writes `problem` and `nextAt:null` as before, and the refresh still goes ahead.
  - **Step 6, the end of a chain run** (what "reschedule" means in the refresh steps): get `refresh/schedule`. If `armId` is still the last token this run wrote, set `misses`, pinned: 0 if Chrome was reached (a lock skip counts as reached), otherwise its current value plus 1. `nextAt` and `problem` stay as Arm left them, so a failed early arm is still reported. If `armId` changed, write nothing.
  - **Overlap:** the early-armed next run can fire while this one is going. It arms its own successor, skips for the lock and records `misses:0`. This run's end then finds `armId` changed and writes nothing, so there's one chain and no miss is counted twice.
  - **Other paths:** a run outside the hours arms for the window and stops, skipping step 6. Stale runs, older messages and recurring runs are unchanged.
  - **The dead-chain check** (After a refresh the user asked for) is unchanged. Its "no run going" guards now cover the moments before a run arms, and runs by older copies of the skill. A live chain's `nextAt` is ahead even mid-run.
  - **Delay:** still `every` minus 5 minutes, now counted from a run's start rather than its end. Runs start every 55 minutes for `every` 60, and each wake stays inside the prompt cache, since the cache counts from the end of the last run.
  - **Sizes:** the reference's cap rose to 9,500 bytes (9,444).
- **Also in v1.23.0 (A3), room in the refresh `SKILL.md`** (19,847 → 18,293 bytes) for F19/F20 and release C's per-day digests. Text that only some refreshes need moved out, and SKILL.md names its new place in the step where it was:
  - **To `references/helper.md`:** the command list (new › Commands, read before the first command in each conversation), the install link (› Versions), the `DATES-GUESSED` rule (› Warnings) and `extra>0`.
  - **To `references/troubleshooting.md`:** what to do with nothing new while messages are "stored but not built yet", the `selfcheck` failure message, and COPY FAILED (› Import toasts).
  - **To `references/writing-the-build.md`:** the list of what `catchup.py` checks (new › What catchup.py checks).
  - **Shortened:** the reference list, the quote-match CHECK note (the line prints its reason), and the relink's refused write (step 7's rule covers it).
  - **Tests:** `test_tools.TestSkillRoom`, plus seven new `TestScheduling` tests. Each failed before the change.

### R18 (A3) · P3 · A run older than the lock's 20 minutes when the next one fires
- **What:** since R14, a chain run arms as it starts, so the next run fires `every` minus 5 minutes after this one started, not after it ended. If this run is still going then (a large backlog, a long photo wait, a slow outbox), its `refresh/status` lock is more than 20 minutes old, and the next run treats it as stale and takes over. That run scans in the same Messenger tab. The first run's pinned step 7 writes are then refused, and writing-the-build.md › Refused writes stops it, but the two can disturb each other's scan first. Before R14 this could only happen with a refresh the user asked for.
- **Fix (if it shows up):** have a run that finds the lock 20+ minutes old check `lastRunAt` and the lock's `step` before taking over, or renew `startedAt` at each step.

## Doc and instruction gaps (SKILL.md / page text vs code)

### G1 · P2 · `meta/chat` fields not in SKILL.md · done (v1.4.0)
- **What:** the page writes `lastT`, `ownLastMid`, `caughtUpAt`, `markerSetAt` and `markerTo`, and catchup.py writes `threading.builtAt`; none are in SKILL.md's schema. The full list is in ARCHITECTURE.md › Database reference. Separately, SKILL.md says to republish the page when `meta/chat.pageVersion` is older than `PAGE_VERSION`, but never says to update `pageVersion` afterwards, so it stays old and every run republishes.
- **Fix:** add the fields; add "then update `meta/chat.pageVersion`" to setup step 2.
- **Half done in v1.2.0:** setup step 2 and the new refresh-time upgrade both set `pageVersion`.
- **Done in v1.4.0:** the field list and the page's collections are in SKILL.md, and two tests derive both from the page source so they can't drift again.

### G2 · P2 · Collections Claude is said to read but doesn't · done (v1.4.0)
- **What:** the page says saved questions are kept "so Claude can see what you asked" and that views and method ideas are what "Claude reads … when improving how catch-ups are built". SKILL.md never mentions `qa`, `views` or `notes`.
- **Fix:** either add a step (for example, glance at new `views` with `kind:"idea"` after each refresh and mention them in the report) or reword the page.
- **Done in v1.4.0:** SKILL.md › What the page saves for Claude covers new ideas listed after each refresh (tracked by `ideasSeenAt`, applied only on a yes), `qa` read when the user refers to it, and `notes/*` written for analyses worth keeping.

### G3 · P2 · "Reply 3232" has no procedure · done (v1.4.0)
- **Where:** `page.html:475`
- **What:** the page tells the user to say “reply 3232” or “open #3232” to Claude. SKILL.md has the `jump{mid,reply}` command but no section for this request (look up `m` for that `i`, open the tab, start `jump`, report).
- **Fix:** add a short "Open a message" section to SKILL.md.

### G4 · P3 · Hidden Refresh button still mentioned · done (v1.2.2)
- **Where:** `page.html:295` ("…and again each time you press Refresh")
- **What:** the button is hidden in the generic page (C1), so the sentence describes something the user can't see.

### G5 · P3 · Helper install wording differs · done (v1.2.2)
- **Where:** `page.html:304-305` vs SKILL.md › Helper
- **What:** the page's steps name only Violentmonkey; SKILL.md recommends Tampermonkey (both tested).

### G6 · P3 · `outbox/*` fields and `coverage` undefined · done (v1.18.0)
- **Found:** by the v1.9.0 split review. The fields of an `outbox/*` row as the page writes it (`i`, `mid`, `to`, `snip`, `text`, `state`, `queuedAt`, …) aren't listed anywhere, though `references/open-message.md` tells Claude to queue a reply. `meta/chat.coverage` is written every refresh but never defined.
- **Fix:** list both in `references/database.md`, and derive the outbox fields from the page source in a test, as is done for `meta/chat`.
- **Done (v1.18.0):** `references/database.md` has an `outbox/r<ms>` line (every field, who writes it, and the state transitions) and defines `coverage`. `outbox.md` adds the rules that were missing: a row with a null `mid` is marked `failed` ("no Messenger id"), the `sending` write is pinned so a Cancel on the page wins, and failed rows aren't retried. `open-message.md` says how to queue a reply with the page's fields. `test_database_md_documents_every_outbox_field_and_state` reads the page's three outbox writes (it fails if it finds a different number) and checks every field and state, plus every state `outbox.md` uses. The `meta/chat` fields test now starts from each `doc("meta/chat")` write and traces variables back to their literals.

## Cleanup

### C1 · P3 · Unreachable code in the page · done (v1.7.3)
- **What:** about 80 lines kept from the user-specific page: the Refresh trigger (`REFRESH_TASK`, `startRefresh`, `fire_trigger`, `S.mcp`, and the non-`NO_TASK` branches of `renderRefresh`; its `NO_TASK` branch is live and shows the status line), the summary v1 renderer, range summaries (need `summary.fromI`, which nothing sets), and `dayMap`/`meta.dates`. Details in ARCHITECTURE.md › Legacy. (The "Notes from Claude" section has a writer again since v1.4.0.)
- **Decide:** remove, or revive. Range summaries could come back if `catchup.py` wrote `fromI`, and the Refresh button if scheduled triggers can be fired from a page again.
- **Done in v1.7.3, after checking the original user's live data (read-only) first:**
  - **Range summaries were not dead.** Their stored summary has `fromI` (1654), which `catchup.py` carries forward, and two span summaries are saved. They stay and now have page tests.
  - **Removed:**
    - the Refresh trigger: the live page still has the `__TRIGGER_ID__` placeholder
    - the summary v1 renderer: the live summary is version 2
    - `dayMap`/`meta.dates` and an unused `DAYS`: all 3,992 stored messages carry `d`
  - About 65 lines gone. `PAGE_VERSION` 1.8.

### C2 · P2 · Helper copies and version strings · done
- **What:** `helper.user.js`, the HTML-escaped copy in `page.html` `#jump-us`, and the URL-encoded `jump()` bookmarklet in `#jump-bm`; plus `1.1` in four places inside the helper. Nothing enforced the sync.
- **Done Nov 6:** `tools/sync-helper.py` (`npm run sync`) regenerates both page copies from the file. It reproduced the existing page byte for byte before it was first used. `tests/test_tools.py` fails when the copies drift or the four version strings disagree. It lives in `tools/`, not `scripts/`, so it isn't shipped in the skill ZIP.

### C3 · P3 · Leftover names · done
- Were: `ccScan`, `ccVerify`, `ccCapture`, `cctool.py`, the `cc-capture` kind still accepted by the page, and the palette comment "pack fabrics … EPX200" (`page.html:6`).
- **Done Nov 6:** helper functions are `mcScan` / `mcVerify` / `mcCapture`; the build tool is `scripts/catchup.py` (SKILL.md updated); the page accepts only `mc-capture`; the comment is neutral. History docs keep the old names where they describe the past. Versions not bumped: no behavior changed, and an already-installed 1.1 helper talks to the skill through the same bridge commands.

### C4 · P3 · Minified style · done (v1.7.4)
- The helper and most of the page script are one long line per statement, which makes diffs and reviews hard. Options: keep a readable source and generate the dense copy, or just run a formatter. Watch the userscript copy size if you change it.
- **Done in v1.7.4:**
  - **Formatting:** Prettier 3.3.3 formats the page, helper, JS tests and mock, and Ruff 0.6.9 formats Python, both at 120 columns. `npm run fmt` applies it; `npm test` and CI check it.
  - **Measured first:** the formatted page is about 37% bigger. Claude reads the page only at setup and on a `PAGE_VERSION` bump, while it reads `SKILL.md` on every refresh. So the owner chose to accept the growth, win it back by dropping the embedded userscript copy (F8), and shrink `SKILL.md` (C7).
  - **Skeleton removed:** the page no longer stores the document skeleton. Prettier would have rewritten it, and the Artifact tool only replaces its own exact skeleton.
  - **Bookmarklet:** a new sim check runs the page's bookmarklet against the mock.

### C5 · P3 · `catchup._ts` shells out to `date` · done (v1.2.1)
- Use `zoneinfo` instead; also removes the dependency on `%-d` support in `date`.

### C6 · P3 · Unclosed files in `catchup.py` · done (v1.2.1)
- `_load` and `_dump` use `json.load(open(p))` / `json.dump(o,open(p,'w'))`. CPython closes and flushes the files right away, so nothing is lost today, but every call raises a `ResourceWarning` (the test runner passes `-W ignore::ResourceWarning`). Use `with open(...)`.

### C7 · P2 · `SKILL.md` is read on every refresh · done (v1.9.0)
- **What:** Claude reads all of `SKILL.md` (31 KB, about 8k tokens) on every run, hourly with the loop. Most of it (setup, troubleshooting, the full database reference, outbox details, opening a message) isn't needed on a routine refresh.
- **Fix:** keep the refresh procedure in `SKILL.md`, and move the rest to `references/*.md` that `SKILL.md` names and Claude reads only when needed. Tests check that nothing was lost and that every reference file exists. MINOR (procedure files change). Owner approved Nov 7.
- **Done in v1.9.0:**
  - **Size:** `SKILL.md` went from 31.8 KB to 19.4 KB, about 3k fewer tokens per refresh.
  - **What moved:** five reference files. A new "Which part to follow" section says when to read each.
  - **Verbatim check:** 133 of the 143 lines from v1.8.0 carried over unchanged; the other 10 are reworded cross-references and headings.
  - **Tests:** every reference file is named in `SKILL.md`; `SKILL.md` stays under 20 KB; step 8 reads `references/outbox.md` before any reply; the ZIP ships `references/`; the database and outbox tests read the new files.

## Tests

### T1 · P2 · No `package.json` · done
- `tests/sim.js` did `require('playwright')` with nothing declaring it.
- **Done Nov 6:** a root `package.json` pins `playwright` 1.65.0 (`npm run setup` installs Chromium). `npm run test:sim` runs `tests/run.js`, which serves `tests/` on a free port and runs `sim.js`.

### T2 · P2 · No `catchup.py` tests · done
- EXPERIMENTS.md §7 reported a pipeline replay ("3 imports, 3 builds"), but that harness wasn't committed.
- **Done Nov 6:** `tests/test_catchup.py`: bootstrap, every default-link rule (r, rq from the browser, rq from history, rg, c, i, ROOT, null and explicit overrides, pmid), incremental builds (closeOpen, answered, dealEdit, outcome), every assert (each also checks that WORK and RUN/out are untouched), quote matching (window edge, latest wins, you/themself), normalization, time parsing, CLI usage. Known bugs B1–B5 and B11 are `expectedFailure` tests. The pipeline replay now lives in `tests/page.test.js`.

### T3 · P2 · No page tests · done
- **Done Nov 6:** `tests/page.test.js` loads the real `assets/page.html` with a stand-in `window.claude.use()` (in-memory `db` with snapshots and a write log, `assets` uploads, `sample`). It covers:
  - every importer check, each also checking that nothing was written
  - chunk rollover at 82, photos and GIFs, overlap, dry runs, and the paste and button paths
  - the full pipeline: sim captures → page import → `catchup.py` → page render, including summary cards and filters, threaded nesting, markers, the date-entry fix, outbox, Ask Claude and Views
  - KNOWN checks for B7–B9
- **Still not covered:** the lightbox and the "Find in Messenger" panel. (Range summaries got tests in v1.7.3; the v1 renderer was removed.)

### T4 · P3 · More date-label forms in the mock · done (v1.3.0)
- Add short month/weekday labels and a year-boundary case once B6 is fixed.

### T5 · P3 · CI · done
- **Done in v1.1.2:** `.github/workflows/test.yml` runs `npm test` on Ubuntu (Python 3.12, Node 22, Playwright Chromium) for every PR and push to `main`, and uploads `tests/out/` when it fails.

## Features and opportunities

### F1 · P3 · Several chats
- One page and one loop per chat today (LEARNINGS.md › Open issues). Simplest path: one page per chat, keyed by `meta/chat.thread`, and a loop that walks them.

### F2 · P3 · Faster distant photo-reply parents · done (v1.14.0)
- Bringing a far-up parent into view is slow and can fail with `notfound` (EXPERIMENTS.md §3, refresh 240). LEARNINGS.md suggests opening the reply through its jump link and clicking from there.
- **Done in v1.14.0 (helper 1.9):**
  - **Cause:** after each click on "Go to replied message", the view sat at the parent, far up the chat. Finding the next reply meant stepping back down 0.8 screen at a time, which was slow and could end in `notfound`. Also, focus was awaited for only 2.5 s, so far parents ended in `nofocus`.
  - **Fix:** jump to the bottom before the next reply, and wait up to 10 s for focus.
  - **Tests:** the mock now loads history down to an unloaded parent after a delay, like Messenger. Sim section D (two far-up parents) passes in about 9 s; on helper 1.8 it fails.
  - **Found along the way:** B38.

### F3 · P2 · Correct an existing link · done (v1.12.0)
- The spec's `links` only applies to messages in the current build, so a wrong link found later can only be fixed by editing `threading/current` by hand. Add a `relink` key (`{i: [parent,type] | null}` for older messages), checked by the same asserts.
- **Done in v1.12.0:**
  - **`relink {i: [parent, type] | null}`** in a build spec, or on its own with `catchup.py relink WORK OUT SPEC` when there's nothing new to build. It writes `OUT/threading.json` and advances WORK's threading, which `restore` can undo.
  - **Checks:** only already-built messages; parents must be earlier stored messages; a known type; a WARN when the link crosses conversations.
  - **Routing:** `SKILL.md` sends "a message linked to the wrong one" here.

### F4 · P2 · Self-check for markup changes · done (v1.13.0)
- A helper `selfcheck` command that confirms each selector and label the reader relies on is present, run at the start of every refresh. A clear "Messenger changed: X missing" beats a confusing scan error.
- **Done in v1.13.0:** helper 1.8's `selfcheck` runs at refresh step 2 (installed or injected).
  - **Stops the run:** a missing chat log, message ids, scroller, `At <time>, <name>: ` labels, reply links (when reply lines exist), or "Original message:" quotes (when reply links exist). The status reads "Messenger changed: …", and the user is told even during a scheduled run.
  - **Warns only:** missing avatars (no full names), or mostly unreadable date labels.
  - **Tests:** the sim breaks each hook on the mock and checks that it's named. This covers R3's "fail clearly" half; R3 itself (English labels, markup) remains.

### F5 · P3 · "Update available" on the page · done (v1.22.0)
- The page could compare its `PAGE_VERSION` with `meta/chat.pageVersion` and the helper's `data-mc-helper` version, and say when either is behind.
- **What stood in the way:** the page can't see `data-mc-helper` (it's on the facebook.com tab) and has no way to fetch GitHub releases (no network capability; it would also tell GitHub whenever the user reads their chat). And `pageVersion` equals `PAGE_VERSION` on a healthy page; only the skill knows what it ships.
- **Done in v1.22.0:** Claude writes `meta/chat.versions` with every `lastRefresh`: `page` and `helper` (what this skill ships), `refresh` (a copy of `lastRefresh`) and `browsers` (one entry per Chrome, by name: the helper read there, or `"none"` when injected, and when). A republish writes `versions.page` together with `pageVersion`. The page shows at most one calm, dismissible line per issue under the status line:
  - **A** this tab is older than `pageVersion` (reload);
  - **B** the last refresh's skill ships a newer page than the published one (a republish didn't land);
  - **C** an older copy of the skill ran the last refresh: `versions.page` below `pageVersion`, or `lastRefresh` written without `versions` (a copy from before this release, such as an uploaded skill or an old scheduled task); not while a refresh is running;
  - **D** a Chrome ran a helper below 1.5, which can't update itself; **E** a Chrome ran a self-updating helper (1.5+) that is behind, flagged right away (the owner's call: no grace period). Entries older than 30 days are left out.
  - Dismissals stay in the browser's `localStorage`, keyed to the version that would fix it, so they come back with the next release; with storage blocked, Dismiss works for that page load. The page writes nothing to the database.
  - An older skill that finds a newer `pageVersion` never republishes (that would downgrade the page): it carries on, writes its lower `versions.page` (so C shows) and tells the user to update the plugin (`references/updating-the-page.md`).
- **Tests:** page section `notices` (U1–U20: every notice and its wording, number-by-number comparison, the running-refresh rule, the 30-day window, unreadable versions, order, Dismiss and its return on a new version, blocked storage, live updates, a browser name with markup, phone width, dark mode, no database, and the last release's page reading data that has `versions`); 41 of its 42 checks fail on page 2.6 (the last is the backward-compatibility check, run on the old page itself). `test_tools.TestUpdateNotice`: every `versions` key the page reads is documented, `lastRefresh` is always written with `versions`, the page-version check goes both ways, the self-update threshold matches `helper.md` and the changelog, one install URL. `test_catchup`: bootstrap ignores `versions`.
- **Review fixes (PR #42):**
  - SKILL.md's steps named only `{lastRefresh}` (nothing new) and `{lastRefresh, coverage}` (step 7), so a run that followed them after one that wrote `versions` made every page say "an older copy of the skill ran" on a current plugin. Both now name `versions`, and step 7 points at `references/database.md` › Versions. The test that checked this had skipped SKILL.md.
  - Setup's reuse of an existing page set `pageVersion` alone, which made notice C show (`versions.page` below it); it now writes `{pageVersion, versions:{page}}` in one pinned update.
  - E showed for every Chrome in `browsers`, "at the last refresh", including ones used days before that had most likely updated themselves. Now E is only for the newest `at`; D for an older Chrome says the day it was last used; the unnamed key `"Chrome"` counts only while it's the newest, and when it is, an older entry on the same helper shows nothing (probably the same browser).
  - "The database layout only changes in a major release" (`updating-the-page.md`) wasn't true: R2 changed `photos/*` in this minor release. A newer page with a newer major now means stop before the lock and write nothing; the same major carries on. A 2.9 → 3.0 bump only to keep minors one digit also stops older copies, which is the safe side. `catchup.py` refuses a threading or summary `layout` it doesn't know, instead of reading it as the old single document.
  - C now names Claude Code's `/plugin` as well as claude.ai's menu. `test_page_never_writes_versions` also catches quoted keys, `{versions}` shorthand, dotted paths and bracket assignment; U14b covers a throwing `window.localStorage` getter. Filed R17.
  - Not done: having `catchup.py`'s manifest prefill `versions.page` and `helper`. The nothing-new path and troubleshooting's "nothing left to build" have no manifest, so Claude reads the two versions from the skill's files either way.
- **Live checks still to do:** whether an open tab reloads by itself after a republish (notice A's wording), the claude.ai menu path for plugins ("Customize › Plugins"), and what `list_connected_browsers` calls a single Chrome.

### F6 · P3 · Ask Claude over long histories · done (v1.22.0)
- Send summaries for older stretches plus the raw window, or pick messages by keyword first, instead of all stored messages.
- **The 256 KiB per-document cap is now handled for summary and threading** (B43, v1.17.0), so older summaries are kept and could feed this.
- **Owner's calls (Nov 12, on the R4/F6 design):** summaries take up to 35% of an "include older" prompt; a range summary too long for one call is refused, saying how much fits; `qa` and `views` save `sent`; performance tests count operations in `npm test`, with timings only in `npm run test:perf`; day lines are built on the page now, refresh-written digests later (F16).
- **Done in v1.22.0:**
  - **One budget** for Ask, Views and range summaries: UTF-8 bytes against `sample.limits().maxPromptBytes` (262,144 when it's missing, rejects or answers nonsense), less a 4 KiB margin. `packHistory` sends the newest messages word for word as one run, and the rest as OLDER HISTORY: one line per conversation (newest first: the summary's outcome, a range summary's, or "no summary; N messages from …"), then one line per day back to the first stored message. "Nothing before #N is included" when even the day lines don't fit.
  - **Ask:** "What you have" says which numbers are word for word and which are summaries, and Claude is asked to say when a point comes from a summary. Earlier turns are trimmed oldest pair first past a quarter of the cap; a question over half the cap isn't sent; one free retry at 80% on `prompt_too_large`.
  - **The note** under each answer and built view says what was read, and `qa/*` and `views/*` save it as `sent: {from, to, sumFrom, afterFrom}` (`references/database.md`).
  - **Range summaries** over the cap get no button: the box says how many of the span's newest messages fit and from when.
  - **Tests:** the page section `history` (H1–H16). The key cases fail on page 2.6. `npm run test:perf` prints timings at 6,400, 25,000 and 50,000 messages (EXPERIMENTS.md §14).
- **Still to see live** (the design's L2–L7): "include older" answers with a note like "Read #… word for word. Older than #…: summaries only." and no "(sent a smaller set…)"; answers about things 1 to 3 weeks old cite numbers and say when they rest on summaries (L4, which decides F16 and F17); Views on a 5-day window; a long span before `fromI` refused with a start time; what `sample.limits()` returns in the real runtime.
- **Deferred:** F15 (Show older paging), F16 (refresh-written digests), F17 (a two-step or tool ask), F18 (splitting range summaries).

### F7 · P3 · Ship as a plugin · done (v1.15.0, v1.16.0)
- **What:** plugins (Customize › Plugins, or a marketplace added from a git repo) load their skills in web and Desktop chat, Cowork and Claude Code, and follow the user's account. This replaces "re-upload the ZIP". Plugins need a paid plan, as Claude in Chrome already does.
- **Done in v1.15.0:**
  - the repo is a marketplace (named `roopesh`, renamed `rando-tools` in v1.16.1) listing the plugin in `plugin/`
  - plugin `messenger-catchup` with one skill, `refresh` (`/messenger-catchup:refresh`), whose files refer to each other through `${CLAUDE_SKILL_DIR}`
  - the plugin's version is the release version (tested); `claude plugin validate --strict` runs in CI
  - the release carries a plugin ZIP for Upload plugin
- **Done in v1.16.0 (owner's call, Nov 7):** setup is its own skill, `setup` (`/messenger-catchup:setup`), so "set up" and "refresh" each have a focused description. Setup asks the questions, creates the page and seeds the database, then hands the first capture to refresh, which reads `references/first-run.md`. Updating the page moved to refresh's `references/updating-the-page.md`. Setup carries copies of the page and the database reference (a skill can only count on its own folder); `npm run sync` writes them and a test fails on a stale copy.
- **Not confirmed:** whether a plugin from a custom marketplace updates by itself in web and Desktop chat, and how fast. Check live after the next release.

### F8 · P2 · Userscript installs from a URL and updates itself · done (v1.8.0)
- **What:** the page embeds a 30 KB HTML-escaped copy of the userscript, nearly a quarter of the page, and every helper change means "reinstall the userscript".
- **Fix:** attach `helper.user.js` to each GitHub release. The page links to `releases/latest/download/helper.user.js`, which Tampermonkey and Violentmonkey open as an install, and `@updateURL`/`@downloadURL` make them update themselves. Keep the bookmarklet. The owner accepted the trust trade-off (Nov 7): whoever controls the repo's releases controls code running on facebook.com, which today is the owner, with branch protection.
- **Done in v1.8.0:**
  - **Helper 1.5:** `@updateURL`/`@downloadURL` point at the latest release.
  - **Releases:** `tools/release.sh` attaches the userscript to every release.
  - **Page:** links to it instead of embedding it. The page is 130 KB, back to its pre-format size.
  - **SKILL.md:** a helper older than 1.5 gets one "install from the link" notice; later helpers update themselves.
  - **Tests:** the link, the update URLs and the release asset are checked.
  - **Still to verify live:** that Tampermonkey follows GitHub's redirect from `latest/download` when it checks for updates.

### F9 · P2 · Full names and nicknames · done (v1.10.0, v1.11.0)
- **Why:** Messenger prints a nickname or the first name only, so two members with the same first name were merged, last names never counted as mentions, and nobody's full name was visible.
- **Owner's choices (Nov 7):**
  - **Display:** the first name; the full name when two or more people share that first name; a nickname as "nickname (first name)", or "nickname (full name)" when the first name is shared.
  - **Storage:** a name map plus the full name on each message.
  - **Backfill:** a one-time scan of older senders, then forward.
  - **Mentions:** Claude asks which aliases to add.
  - **Privacy:** real names live only in each user's page database, never in the repo.
- **Part 1, done in v1.10.0:**
  - **Helper 1.6** reads each sender's avatar alt text into `fn`.
  - **Page 2.1** keeps `fn`, writes `people/index`, and names people by the rule above, everywhere a sender is shown, in Ask Claude's prompt, and in the Messages filter.
  - **SKILL.md** has a naming rule for spec writing. `f`, `r` and the outbox's `to` stay as Messenger shows them.
  - **Tests:** the mock gives senders avatars, including a second "Ben" and a nickname. Sim and page tests cover all of it and fail on helper 1.5 and page 2.0.
- **Part 2, done in v1.11.0:**
  - **Helper 1.7 `people{count}`:** scrolls back reading shown names and avatar names only (no clicks; stops after 8 minutes).
  - **`references/people.md`:**
    - runs it once as its own short locked run after a refresh, merging the results into `people/index` and setting `scannedAt`
    - asks the user once (never during a scheduled run) which aliases count as them, setting `meta/chat.aliasesAskedAt`
  - **Page 2.2:** accepts people entries without positions.
- **Still to see live:** the scan on the real chat (about 4,000 messages; it may stop at the 8-minute cap first, and later messages fill in the rest).


### F10 · P2 · Restore the summary items pre-1.17 refreshes dropped · done (v1.18.1)
- **Why:** before v1.17.0, a refresh on the owner's page hit the 256 KiB cap and dropped 91 conversations, 14 open questions, 34 answered, 31 deals, 9 mentions and 132 bullets (GitHub issue #32 §4). That session saved the full summary from before the drop in the page's `backups` collection (two parts; read back and checked).
- **Owner's call (Nov 12):** restore everything into the block layout, with a dry-run count first; the 14 open questions are checked against later messages before they show as open again.
- **Done in v1.18.1:** `catchup.py restore-summary WORK RUN BACKUPDIR [DECISIONS] [--dry-run]` and the procedure in the refresh skill's `references/restoring-a-summary.md` (named from `troubleshooting.md`; SKILL.md has no room).
  - **Identity:** conversations by id; bullets, answers and mentions by their whole content; open questions by conversation and ask (one in `answered` since is left alone); deals by content, or the same conversation with all the old refs (a `dealEdit` since). Each stored item stands for one backup item, so nothing comes back twice.
  - **Placement:** a missing item goes right after the backup item before it, so lists keep the order they'd have had without the trim; restored bullets of a conversation continued since go in front of its new ones.
  - **Open questions:** without DECISIONS, the command writes `restore-open.json` (each question and its conversation's later messages) and nothing else; Claude decides `open` or answered (refs, one line) per question.
  - **fromI** goes back to the backup's (1654 on the owner's page), or is removed when the summary then covers everything.
  - **Tests:** `TestRestoreSummary`: a trimmed page and an untrimmed twin given the same later builds; restored, the trimmed one equals the twin (plus the decisions), with exact dry-run counts, every document at most half the cap, a second run restoring nothing, refusals, pins and undo.
- **Still to do:** run it on the owner's page with their go-ahead. Keep the backup until they decide.

### F11 · P2 · perf · Outbox: fewer round trips per reply · done (v1.18.0)
- **Found:** in issue #32 §1: about 1 minute per reply (gaps of 42–109 s between `sent` writes over 10 replies), because `outbox.md` took about 6 tool calls per reply and each is a full model round trip. The browser work itself takes a few seconds.
- **Fix (owner's option A, every check kept):** about 3 calls per reply.
  1. One JS call starts `jump`, waits for the tip, checks the "Replying to …" bar and the snip, checks the box is empty, and types the first line.
  2. One DB batch writes the earlier rows' outcomes (`sent` or `failed`) and this row's `sending`, all pinned.
  3. One browser batch types any later lines (B45), runs the check (it throws and leaves the box if the box doesn't match, so Return never sends), presses Return, and runs the confirm (up to 15 s).
  - A row's `sent` lands with the next row's `sending`, and a confirm that can't see the message stops posting for the run, so at most one row is ever in `sending`; the existing settle check handles it on the next run. The confirm only accepts a message that wasn't on screen before Return.
- **Tests:** `TestOutboxPosting.test_three_calls_per_reply` (the order of the steps in each call), `test_row_without_mid_fails`, `test_sending_write_is_pinned_and_cancel_wins`, `test_failed_rows_are_never_retried`; `tests/composer.sim.js` runs the three calls end to end.

### F12 · P3 · Two connected Chromes · done (v1.20.0)
- **Found:** GitHub issue #32 §5: two Chromes were connected (helper 1.1 in one, 1.9 in the other), and runs landed on whichever was active, so `selfcheck` and full names came and went.
- **Done in v1.20.0:** SKILL.md step 2 sends Claude to `references/helper.md` › Which Chrome when more than one is connected. Claude in Chrome's own rule is never to pick a browser for the user, so: use the one this session already uses; otherwise ask, recommending the Chrome with the newest helper (Claude may check each one's `data-mc-helper` only when the user asks it to pick); a scheduled run with no one to ask stops with a clear status. Every report names the browser and its helper version.
- **Decision for the owner:** a fully automatic "newest helper wins" would mean Claude selecting browsers itself, which the Chrome tools forbid.

### F13 · P2 · Opt-in helper `post` command · done (v1.20.0)
- **Why:** GitHub issue #32 §1: posting a queued reply took about 6 tool calls and a minute. Option B there: the helper posts.
- **Owner's call (Nov 12):** an opt-in `post`, off by default.
- **Done in v1.20.0 (helper 2.0):** `post{mid,to,snip,text,helperPost:true}` runs `jump` (with B48's fallback), checks the "Replying to …" bar against `to` and `snip` and that the box is empty, types the text (shift+Enter between lines, since Messenger's Lexical editor drops newlines from `insertText`), presses Enter, and waits up to 15 s for the message. It returns `{sent:true, mid}` or a precise error with `entered` (false: nothing can have been sent). It refuses without `helperPost:true`, which Claude passes only when `meta/chat.helperPost` is true; the user turns that on by asking Claude. No link, URL hash or page can reach it. `references/posting-with-helper.md` maps every result to the outbox states.
- **Tests:** sim section F against a mock composer running Lexical core (`lexical` 0.52.0, a devDependency) with the commands `@lexical/plain-text` registers and Messenger's Enter-sends rule: refused without the opt-in; refused on a wrong "Replying to" or quote, and on a box with text; a multi-line reply posted exactly once with its line breaks; a photo-only message through More actions; a composer that ignores synthetic keys (`enter-not-accepted` leaves the text for a real Enter, which then posts; `linebreak-not-accepted` clears the box); a URL hash can't post.
- **Still to see live:** that Messenger accepts the helper's synthetic Enter and shift+Enter. Lexical itself does in Chromium (the mock runs its real keydown handling), but Messenger's own handlers are unknown. If it doesn't, `post` says `enter-not-accepted` or `linebreak-not-accepted`, sends nothing, and the skill falls back to a real Enter or outbox.md's steps.
- **outbox.md** › Posting now sends Claude here when `meta/chat.helperPost` is true (PR #38 review).
- **Review of PR #38** (an independent review with experiments against the mock) found these before merging. Each fix has a sim or unit test that failed first:
  - **High:** a scripted shift+Enter that Messenger takes as Enter sent the first line, and `post` then said `type-mismatch` with `entered:false`, which invited a second send. Now it checks after every shift+Enter that the box still holds the earlier text and nothing new from you appeared. Any result after a key press says `entered:true`, a possible send is always `unconfirmed`, `enter-not-accepted` also requires no new message, and `posting-with-helper.md` never retries or presses Return after a result that may have sent (`F: a shift+Enter taken as Enter sent the first line …`).
  - A progress bar inside a message, or a hidden one, blocked "top of the chat": only a visible one outside messages counts now, and a spinner that stays is its own error, `top-spinner`. The people scan and verify stop on it too (`E: progress bars inside message 0 …`, `E: … top-spinner`, `E: the people scan under a spinner …`, `E: verify under a spinner …`).
  - `busy` is split into `post-running`, `scan-running` and `jump-running`. The post records its stage before each key, and a lost result counts as `unconfirmed` (`F: a second post while one is running …`, `F: post records its stage …`).
  - The scroller must hold nearly all of the log's messages, or the reader falls back to helper 1.9's rule. A message in its own small scrolling box had cut a first run of 100 to 25 (`E: the first message in its own scrolling box …`).
  - Refusals after the jump cancel the reply bar (`barClosed`). A More actions menu without Reply is closed, and only the menu the click opened is searched (`F: a More actions menu with no Reply …`, `F: with another message's menu still open …`). The user's draft is never cleared.
  - `post` refuses while a page Reply link is jumping, and checks the reply bar again just before Enter (`F: a page Reply link still jumping …`, `F: a reply bar that moves while typing …`).
  - Full names: each avatar names only its own group, so two people shown as "Ben" back to back keep their own names (`E: two people shown as "Ben" back to back …`).
  - Also: outbox.md's call 1 now waits after focusing the box and before checking it. With Lexical, text typed the instant the box gets focus is dropped, and inserted text shows a moment later, so the old same-instant check would fail (`F: outbox.md's call 1 types the first line even when Reply leaves the composer unfocused`).

### F14 · P3 · Show the next scheduled refresh on the page
- **What:** `refresh/schedule.nextAt` (v1.21.0) says when the next scheduled run is due, and `problem` why the schedule stopped. The page could show both next to the status line, so a dead schedule is visible without asking Claude.
- **Fix:** read `refresh/schedule` by name (the page lists no `refresh` collection today); ship with the next page change.

### F15 · P3 · perf · Page "Show older messages" by day
- **What:** with "Show older messages" on, the Messages tab renders every stored message. An earlier bench: 0.5 s and 79k elements at 6,400 messages, 2.0 s and 307k at 25,000, 4.2 s and 2.9 GB at 50,000. The default view (the window only) is unaffected. This is what remains of R4.
- **Fix:** load the previous day on demand ("Load the previous day"), the smaller change. Virtualizing threaded rows of varying height isn't worth it.
- **Trigger:** about 15,000 stored messages (roughly 17 days after 6,933 at 460 a day), or Show older taking over 1 s on the owner's machine.

### F16 · P3 · Per-day digests written during refresh
- **What:** older than the conversation lines reach (2–3 weeks at every size), F6's prompt has one line per day built on the page from threading titles. A refresh could write a real digest per day (`digests/dYYYY-MM-DD`) for those lines to use.
- **Cost:** a spec key, `catchup.py` checks, a new collection and a backfill: a MINOR with a skill change.
- **Also here:** older open questions, answers and deals as their own lines (the design's "level 1b"); they're mostly in conversation outcomes today.
- **Trigger:** live answers about things older than 3 weeks turn out poor (F6's live check L4), or the owner asks.

### F17 · P3 · A two-step or tool-using Ask
- **What:** Claude first sees the digest, names the stretch it needs, and the page sends that stretch word for word in a second call (or a tool call does it).
- **Cost:** about twice the time and usage (30–90 s on the default model); `limits().tools` isn't guaranteed; more ways to fail. Today the manual version works: pick the stretch as a date range and ask with it as the window.
- **Also considered:** a keyword prefilter (an earlier live sample: common words matched 30–93 KB, "?" 480 KB); it still needs the budget and misses synonyms.
- **Trigger:** L4 shows answers saying "only summarized" often for questions people care about.

### F18 · P3 · Split long range summaries
- **What:** a span before `summary.fromI` too long for one request (about 1,990 live-sized messages, 4.3 days) is refused since v1.22.0. Splitting it into parts and merging (conversations joined by id, bullets concatenated, lists joined) would let any span work, at k× the usage and time, with a merge to test.
- **Trigger:** the owner wants long spans summarized and `catchup.py restore-summary` (which moves `fromI` back on the owner's page) hasn't removed the need.

### F19 · P2 · Short claims thread to the latest open offer · done (v1.23.0)
- **Found:** GitHub issue #41, a field report from a buy/sell/trade chat. A short message is often a claim on an item just offered ("In", "I'm in", "in for 1", "Dibs", "Mine", "I'll take it", "PM'd", "Interested", a raffle spot like "In for 2" or "#7"). These are rarely sent as Messenger replies, so the build links them by position (usually `i` to the message before), or Claude files them as a new conversation. Either way the page shows them with no context.
- **Proposed rule** (SKILL.md step 6's GUESS review and `writing-the-spec.md`):
  - In a chat whose `meta/chat.topic` suggests buying, selling or trading, a short claim-type message (any case, optionally with a count) is a claim on the most recent open offer by someone else.
  - An open offer is a for-sale post, a raffle, a group buy or an "anyone want…" offer not yet marked sold or closed.
  - Join the claim to that offer's conversation, linked `i` to the offer, and mention it in the bullets ("Ben is in"). On a deal it's deal activity.
  - If there's no open offer in about the last day, or two are equally likely, keep the build's guess and list it in the report as a possible claim. Never invent an offer.
- **Meanwhile:** the owner's scheduled refresh prompt carries the rule.
- **Design questions:** the word list (fixed list, or Claude's judgment with examples); how "open" is decided (deals' state, or "sold" in later messages); whether the page shows claims on a deal.
- **Owner's calls (Nov 13):** a fixed word list in the tool, but the tool only flags and Claude decides, because "In" often just means "I like that bag" and the bag may not be for sale. A window of 3 days, not 1. Raffle spot claims ("#7", "in for 2 spots") stay as they are. The page shows claims on a deal (release B).
- **Done in v1.23.0:**
  - `catchup.py build`, only when `meta/chat.topic` suggests buying, selling or trading (read from RUN's `meta/chat`), prints `REACT? i (who: "text") -> a, b, c` for each new short claim: up to 3 posts by someone else in the 3 days before it (by timestamp), newest first, that are photo posts, look like offers (`looks_like_offer`: offer words, "let me know if you're interested…", a price) or belong to an open deal. The seller's own "Sold", "SPF" or "pending" prints `CLOSE?`. The lines link nothing.
  - The rules for Claude are in the refresh skill's `references/writing-the-build.md` › Claims (a pointer in SKILL.md step 6): link to the post; on an offer or deal it's a claim (a bullet and the deal's `claims`), otherwise appreciation; the seller's close sets the deal's `status`; no candidate or a tie: keep the guess and list it in the report.
  - A deal gains optional `claims: [{i, who, n}]` (ordered by `i`, one per message, `who` as `f` on the message, `n` a positive whole number, default 1) and `status` (`sold` | `pending`) with `statusAt`. `dealEdit` takes `addClaims`, `status` (`null` reopens) and `statusAt`, and now refuses keys it doesn't know.
- **Review fixes (v1.23.0, before release; two independent reviews):**
  - The gate also reads `meta/chat.threadName`, because setup never asked for `topic`. Setup now asks what the chat is about and stores `topic`; a build on a page without one prints a NOTE, and the refresh fills it in once (`references/writing-the-build.md` › The chat's topic).
  - Raffle and paffle posts (by text, or a deal of kind `raffle`) are marked "(raffle)" in the candidates rather than dropped: Claude sees the post, and › Claims says a reaction to it is a spot claim, threaded as before, with no `claims` entry.
  - `dealEdit.removeClaims: [i]` takes a claim back ("he just liked it"), and removing then re-adding corrects a count.
  - More phrasings: closes with a short tail ("Sold to Ben", "SPF Ben", "pending pickup", "sold ppu"; never "sold out"), and claims with a count ("In x2", "In (2)", "in 2", "in for 2 please") or "I'm interested".
  - Fewer noisy candidates: loose phrases ("let me know if you are coming", "who wants to hike", "dm me when…", bare "shipped", what someone paid) no longer count as offers; photos and open deals rank before text offers; "someone else" compares full names (`fn`) when both messages have one.
  - `dealEdit` refuses non-list `addClaims`/`removeClaims`, `statusAt` without `status`, `status` without `statusAt`, and a boolean `statusAt`.

### F20 · P2 · `move` an already-built message to another conversation · done (v1.23.0)
- **Found:** GitHub issue #41. `relink` (F3) changes a built message's link, but its conversation stays the same, so fixing a misfiled claim gives `WARN link … crosses conversations` and the page still shows the message as its own thread.
- **Proposed:** a spec key `{"move": {"i": "convId"}}` for messages already built. It updates membership in the threading blocks, keeps summary refs valid (a conversation left empty is dropped or merged, its summary items moved), lands through the manifest like any build, and `restore` can undo it.
- **Pairs with F19:** F19 stops new misfiles; `move` fixes the ones already on pages.
- **Done in v1.23.0:** `move: {"<i>": "<conv id>" | "new"}` in a build spec, or on its own through `catchup.py relink` (which takes `relink`, `move` and `newconvs`; with a move it reads the summary listing too and writes both collections). The target is an existing conversation, one in the same spec's `newconvs` (title and tag), or `"new"` (`mv<i>`, titled with the message's text). The message moves with everything threaded under it in its old conversation; its own link must end up in the target or be null (a `relink` in the same spec), or the move is refused. A conversation left empty is dropped and its summary items (bullets merged in message order, key messages, open, answered, deals; tag and outcome where the target has none) go to the target; otherwise items whose refs all moved go along (questions follow their ask) and the rest lose the moved refs. It prints `MOVE`, `DROP` and what moved, goes through `layout_docs`, `_roundtrip`, `_plan` and the manifest like a build, and `restore` undoes it. Routed from SKILL.md (next to relink) and `references/writing-the-build.md` › Moving a message.
- **Review fixes (v1.23.0, before release; two independent reviews):**
  - A move follows only Messenger reply links (`r`, `rq`, `rg`). A message linked by a guess (`i`, `c`) stays, re-pointed to the moved message's old parent, and prints `LEFT 5 (i -> 4), now -> 3`, so a misfiled "In" in a guessed chain no longer drags everything after it along. Claude moves the answers that belong with it.
  - Both `current` documents carry one revision token, `rev`, per write (a relink with no move writes threading only, with `summaryRev`). Bootstrap refuses a pair from different writes (a move that only partly landed used to pass, then crash the next build), and `_fresh` compares `rev`, so a WORK restored after its write landed is refused even within the same minute. After a move's write lands, the undo is a reverse move.
  - A `dealEdit` with `index` on a conversation the same spec moves or adds deals to is refused; `ref` (one of the deal's messages) names it instead, and the MOVE output and the "add index" refusal list the deals with their indexes.
  - The DROP line prints the dropped conversation's title, tag and outcome, and an outcome the target already has its own of is kept as a bullet.
  - Bullets, outcome, key, join, deals, open or answered naming a conversation the same spec drops get a clear refusal (before: a raw KeyError); unknown conversations in bullets, outcome or key too.
  - The crosses-conversations WARN runs after the move; a standalone move refuses a `newconvs` entry no move fills; "new" ids avoid summary ids too; the printout no longer says "block lists".
  - `restore-summary` now also writes `threading/current` (unchanged but for `rev`).

