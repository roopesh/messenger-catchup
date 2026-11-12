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
| R2 | P2 | risk | Capture size is unbounded (photos travel inline as base64) |
| R5 | P2 | risk | E2EE chats untested live; `messenger.com` not supported |
| R8 | P2 | risk | The PR rule is by convention only: `main` accepts direct pushes and no CI runs on PRs · **done** (v1.7.2: repo public, branch protection) |
| R9 | P3 | risk | Outbox name matching assumes Messenger's "Replying to …" and stored sender names agree. Live (Nov 7): labels are the nickname or the first name, and `to` uses the same; the reply bar itself is still unverified |
| R6 | P2 | risk | SKILL.md names scheduling tools (`send_later`, `create_trigger`) that depend on the environment |
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
| B39 | P2 | bug | Queuing a reply closes the conversation you're in and jumps the page |
| B40 | P2 | bug | A conversation that starts with a reply to an older message doesn't show that message, so you can't tell what it's about |
| B41 | P2 | bug | Full names are missing on a live page, so people who share a first name aren't told apart |
| B42 | P3 | bug | A person's text and the photo they sent right after show as two separate messages instead of one |
| B43 | P1 | bug | Threading and summary outgrow the database's 256 KiB per-document cap; sessions started dropping summaries · **done** (v1.17.0) |
| B44 | P2 | bug | Multi-line replies can't post: `insertText` drops line breaks and the exact-match check fails (issue #32 §3) · **done** (v1.18.1) |
| B45 | P3 | bug | An outbox row's `sentAt` was an estimate, not the real time at confirm (issue #32 §5) · **done** (v1.18.1) |
| B1 | P3 | bug | Threading `note` is never filled in for new pages · **done** (v1.2.1) |
| B3 | P3 | bug | `dealEdit` crashes when the conversation has no deal · **done** (v1.2.1) |
| B5 | P3 | bug | Reply with no parent found gets an auto `i` link, contrary to SKILL.md · **done** (v1.2.1) |
| B7 | P3 | bug | A mention of message #0 renders without its content · **done** (v1.2.2) |
| B9 | P3 | bug | "Queued" confirmation says "and confirm" even with auto-posting on · **done** (v1.2.2) |
| B10 | P3 | bug | `make-zip.sh` only works when the repo folder is named `messenger-catchup` · **done** (v1.4.1) |
| G4 | P3 | doc gap | Page text refers to a Refresh button that is hidden · **done** (v1.2.2) |
| G5 | P3 | doc gap | Page install steps name only Violentmonkey; SKILL.md recommends Tampermonkey · **done** (v1.2.2) |
| G6 | P3 | doc gap | `outbox/*` row fields and `meta/chat.coverage` aren't defined anywhere Claude reads · **done** (v1.18.1) |
| R3 | P3 | risk | Reader depends on English labels and Messenger's markup (known) |
| R4 | P3 | risk | Page and Ask Claude hold the whole history in memory / one prompt |
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
| F5 | P3 | feature | Page shows "update available" when its version is behind |
| F6 | P3 | feature | Ask Claude over long histories |
| F7 | P3 | feature | Ship as a plugin (marketplace) so claude.ai installs update automatically · **done** (v1.15.0, v1.16.0) |
| F8 | P2 | feature | Userscript installs from the release URL and updates itself; drop the page's 30 KB embedded copy · **done** (v1.8.0) |
| F9 | P2 | feature | Full names and nicknames: capture, store, show (part 1, v1.10.0); one-time backfill scan and alias question (part 2, v1.11.0) · **done** |
| F10 | P2 | perf | Outbox: fewer round trips per reply, about 3 calls instead of 6 (issue #32 §1) · **done** (v1.18.1) |

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

### B39 · P2 · Queuing a reply closes the conversation you're in and jumps the page
- **Found:** by the owner, Nov 11. After "Queue reply", the conversation the reply was written in closes and the page scrolls far down.
- **Cause (from the code, not yet reproduced in a test):** the page listens for changes to `outbox`, and every change runs `renderSummary()` and `renderMessages()`, which rebuild both lists from scratch (`page.html`, the `outbox` `onSnapshot`). The Messages tab opens only the first four conversations on a rebuild (`d.open = n < 4`), and which conversations the reader opened isn't remembered (only the summary's "Show the thread" is, in `S.openThr`). So the conversation closes, the page gets shorter and the scroll position lands somewhere else. The same rebuild runs when a refresh adds chunks or Claude marks a reply sent.
- **Fix:** keep the reader's place across rebuilds: remember open conversations (as `S.openThr` does) and the scroll anchor, and restore them; or have outbox changes update only the reply chips and outbox list instead of rebuilding everything.
- **Test:** page test that opens a conversation past the fourth, queues a reply, and checks that the conversation is still open and the composer's message is still in view; the same after a chunk arrives.

### B40 · P2 · A conversation that starts with a reply to an older message doesn't show that message
- **Found:** by the owner, Nov 11, and "a common thing". Example shape: a conversation titled after Ana's pack holds one message, #6620, Ben's "↩ reply to #6400 Ana". Ana's #6400 isn't shown, so the card doesn't say what the conversation is about.
- **Cause (from the code):** threading put the reply in a new conversation instead of the parent's. `catchup.py` only warns about a link that crosses conversations ("WARN link … crosses conversations … the page shows … as a new thread", B4), and the page shows only a conversation's own messages, so the parent shows as nothing more than a "reply to #n" chip.
- **Fix options:** (a) the page shows a cross-conversation parent as a quoted context line at the top of the conversation, with a jump to it; (b) the refresh skill joins such replies to the parent's conversation, or starts the new conversation with the parent; (c) both. (a) also fixes pages that were already built.
- **Test:** page test with a conversation whose first message replies to a message in another conversation: the parent's sender and text appear as context, and the jump goes to it.

### B41 · P2 · Full names are missing on a live page, so people who share a first name aren't told apart
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

### B42 · P3 · A person's text and the photo they sent right after show as two separate messages
- **Found:** by the owner, Nov 11. Ana's text (#6739) and the photo she sent the same minute (#6740) show as two full rows. The second has its own number, time, name, actions and a "… continues #6739 Ana" line. Messenger shows them as one block.
- **Cause:** Messenger stores each bubble as its own message (`data-message-id`), so the capture is right. Threading links the second with a `c` link ("same person continuing", `catchup.py:348`), and `convTree` already places it right after the first (`page.html` › `convTree`). But the row renderer gives a `c` row the full header and its own actions, labelled "… continues".
- **Fix (owner's call, Nov 11: like Messenger):** render a run of `c` messages from the same sender within a few minutes as one block. One header (name, time), each bubble's text or photo stacked beneath it, and the message numbers kept but quiet. As in Messenger, each bubble keeps its own actions ("Reply in Messenger", "Reply here"), shown when you hover or tap that bubble instead of under every one. Replies to any bubble still nest under the block. Search, jumps and #n links must still find each bubble. The owner expects this to help the Messages view a lot.
- **Test:** a page test where text plus a photo from the same sender within a minute renders as one block with one header, and both #numbers are reachable by jump and search; a gap of more than the window, or a different sender, still makes separate rows.

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

### B44 · P2 · Multi-line replies can't post · done (v1.18.1)
- **Found:** in the owner's field report (issue #32 §3). Messenger's editor (Lexical) doesn't turn the line breaks inside `execCommand('insertText')` into breaks, so a reply with `\n\n` came out as one line, and `outbox.md`'s check `box.innerText.trim()===text.trim()` failed every multi-line reply.
- **Fix (owner's option A):** type the first line in call 1; in call 3, for each later line press shift+Return and insert that line (an empty line gets only the shift+Return, so blank lines stay). The check compares the box with the reply with whitespace collapsed. The page keeps what the user wrote.
- **Tests:** `tests/composer.sim.js` runs `outbox.md`'s code blocks word for word on a stand-in composer that drops line breaks the way Lexical does (`tests/mock/composer.html`), with the real helper's `jump`: the reply goes out with its paragraphs, blank line included; inserting the whole text at once gives one line; a box that doesn't match makes the check throw and Return sends nothing. `TestOutboxPosting.test_multi_line_replies` checks the text.

### B45 · P3 · `sentAt` was estimated · done (v1.18.1)
- **Found:** in issue #32 §5: several rows had `sentAt` rounded to the minute and later than the row's own last write. The page shows `sentAt`.
- **Fix:** the confirm returns the clock time (`at`), which becomes `sentAt`; a row settled on a later refresh takes the saved message's time (`d` and `t`, in `meta/chat.tz`). Every `sent` write sets both `sentAt` and `sentMid`, including when the user says it went out (`sentMid:null` only if it isn't in the saved messages).
- **Tests:** `TestOutboxPosting.test_sent_always_has_a_real_sent_at_and_sent_mid`; the sim checks the confirm's `at` against the clock.

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

### R2 · P2 · Capture size is unbounded
- **Where:** `helper.user.js:103-105`
- **What:** every photo in the window travels base64-encoded inside the clipboard text. A first run of 1,000 messages, or a long gap, can mean many MB on the clipboard and in one paste event. The real limits of clipboard, paste and upload haven't been measured.
- **Fix:** measure; cap photos per capture (send the rest on the next run, or split into several pastes).

### R3 · P3 · Messenger markup dependency (known)
- English UI labels, `[role="log"]`, `data-message-id`, "Go to replied message", "Reply to this message", the `At <time>, <name>: ` aria-label shape. See F4.

### R4 · P3 · Whole history in memory and in one prompt
- **What:** the page rebuilds the full list on every chunk change; Ask Claude with "include older messages" sends every stored message (~3,900 and growing). `prompt_too_large` is handled but makes the option useless.
- **Fix:** see F6.
- **The 256 KiB per-document cap is now handled for summary and threading** (B43, v1.17.0): each is a collection of block documents, so no document grows with the history. The page still holds every chunk and block in memory, and Ask Claude's prompt still grows.

### R5 · P2 · E2EE and messenger.com
- **What:** `/messages/e2ee/t/` URLs are stored and used but untested against a live E2EE chat. The userscript `@match` covers only `www.facebook.com/messages/*`, so `messenger.com` isn't supported.

### R6 · P2 · Scheduling tool names
- **Where:** SKILL.md › Scheduling
- **What:** Options A and B name `send_later`, `create_trigger` and `requires_local_device: true`. These come from the environment the skill was built in. Check that they still exist under those names wherever the skill is installed, and give a fallback if they don't.

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

### G6 · P3 · `outbox/*` fields and `coverage` undefined · done (v1.18.1)
- **Found:** by the v1.9.0 split review. The fields of an `outbox/*` row as the page writes it (`i`, `mid`, `to`, `snip`, `text`, `state`, `queuedAt`, …) aren't listed anywhere, though `references/open-message.md` tells Claude to queue a reply. `meta/chat.coverage` is written every refresh but never defined.
- **Fix:** list both in `references/database.md`, and derive the outbox fields from the page source in a test, as is done for `meta/chat`.
- **Done (v1.18.1):** `references/database.md` has an `outbox/r<ms>` line (every field, who writes it, and the state transitions) and defines `coverage`. `outbox.md` adds the rules that were missing: a row with a null `mid` is marked `failed` ("no Messenger id"), the `sending` write is pinned so a Cancel on the page wins, and failed rows aren't retried. `open-message.md` says how to queue a reply with the page's fields. `test_database_md_documents_every_outbox_field_and_state` reads the page's three outbox writes (it fails if it finds a different number) and checks every field and state, plus every state `outbox.md` uses. The `meta/chat` fields test now starts from each `doc("meta/chat")` write and traces variables back to their literals.

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

### F5 · P3 · "Update available" on the page
- The page could compare its `PAGE_VERSION` with `meta/chat.pageVersion` and the helper's `data-mc-helper` version, and say when either is behind.

### F6 · P3 · Ask Claude over long histories
- Send summaries for older stretches plus the raw window, or pick messages by keyword first, instead of all stored messages.
- **The 256 KiB per-document cap is now handled for summary and threading** (B43, v1.17.0), so older summaries are kept and could feed this. The prompt size itself is still open.

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

### F10 · P2 · perf · Outbox: fewer round trips per reply · done (v1.18.1)
- **Found:** in issue #32 §1: about 1 minute per reply (gaps of 42–109 s between `sent` writes over 10 replies), because `outbox.md` took about 6 tool calls per reply and each is a full model round trip. The browser work itself takes a few seconds.
- **Fix (owner's option A, every check kept):** about 3 calls per reply.
  1. One JS call starts `jump`, waits for the tip, checks the "Replying to …" bar and the snip, checks the box is empty, and types the first line.
  2. One DB batch writes the earlier rows' outcomes (`sent` or `failed`) and this row's `sending`, all pinned.
  3. One browser batch types any later lines (B44), runs the check (it throws and leaves the box if the box doesn't match, so Return never sends), presses Return, and runs the confirm (up to 15 s).
  - A row's `sent` lands with the next row's `sending`, and a confirm that can't see the message stops posting for the run, so at most one row is ever in `sending`; the existing settle check handles it on the next run. The confirm only accepts a message that wasn't on screen before Return.
- **Tests:** `TestOutboxPosting.test_three_calls_per_reply` (the order of the steps in each call), `test_row_without_mid_fails`, `test_sending_write_is_pinned_and_cancel_wins`, `test_failed_rows_are_never_retried`; `tests/composer.sim.js` runs the three calls end to end.
