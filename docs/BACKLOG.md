# Backlog

Everything open: bugs, risks, gaps between docs and code, cleanup, tests and feature ideas. Started Nov 6, 2026 from a full read of the code at `c3186da`, the simulated-Messenger tests, a `patool.py` (now `catchup.py`) replay and a date-parser probe ([EXPERIMENTS.md §10](EXPERIMENTS.md#10-handoff-review-nov-6-evening)). Updated after the Phase 8 rename and test build-out ([§11](EXPERIMENTS.md#11-rename-and-test-build-out-nov-6-late-evening)).

**Tests for open bugs:** B1–B5 and B11 have `expectedFailure` tests in `tests/test_catchup.py`; B7–B9 have `KNOWN` checks in `tests/page.test.js`. Fix the bug, then remove the marker.

**Priority:** P1 = fix before relying on it more · P2 = next round · P3 = when convenient.
**Status:** open unless marked. When you close an item, change its status to `done (<commit>)` and keep the row, so the history stays readable.

## At a glance

| ID | P | Type | Title |
|---|---|---|---|
| B2 | P1 | bug | `catchup.py build` advances WORK with no backup; a failed DB write can't be retried cleanly |
| R1 | P1 | risk | Page imports aren't version-pinned, and a half-finished import has no documented recovery |
| B6 | P2 | bug | Capture date parser: unknown label forms silently become "today"; year-less dates break at New Year |
| B8 | P2 | bug | One malformed link in a message crashes the Messages tab render |
| B4 | P2 | bug | `catchup.py` accepts links to a parent in another conversation; the page then hides the link |
| G1 | P2 | doc gap | `meta/chat` fields written by the page are missing from SKILL.md; `pageVersion` never updated on republish |
| G2 | P2 | doc gap | Page says Claude reads `views`, ideas and `qa`; SKILL.md never tells it to |
| G3 | P2 | doc gap | Page offers "say reply 3232 to Claude"; SKILL.md has no procedure for it |
| R2 | P2 | risk | Capture size is unbounded (photos travel inline as base64) |
| R5 | P2 | risk | E2EE chats untested live; `messenger.com` not supported |
| R8 | P2 | risk | The PR rule is by convention only: `main` accepts direct pushes and no CI runs on PRs · **mostly done** (no server-side block: plan) |
| R6 | P2 | risk | SKILL.md names scheduling tools (`send_later`, `create_trigger`) that depend on the environment |
| C2 | P2 | cleanup | Helper lives in three copies plus four version strings; sync is manual · **done** |
| T1 | P2 | test | No `package.json`; Playwright must be installed by hand · **done** |
| T2 | P2 | test | No tests for `catchup.py`; the "pipeline replay" isn't in the repo · **done** |
| T3 | P2 | test | No tests for the page (importer, `convTree`, date entry) · **done** |
| F3 | P2 | feature | No way to correct a link on an already-built message |
| F4 | P2 | feature | Self-check command to catch Messenger markup changes early |
| B11 | P3 | bug | `catchup.py` ignores Messenger's reply link when the parent is message #0 |
| B1 | P3 | bug | Threading `note` is never filled in for new pages |
| B3 | P3 | bug | `dealEdit` crashes when the conversation has no deal |
| B5 | P3 | bug | Reply with no parent found gets an auto `i` link, contrary to SKILL.md |
| B7 | P3 | bug | A mention of message #0 renders without its content |
| B9 | P3 | bug | "Queued" confirmation says "and confirm" even with auto-posting on |
| B10 | P3 | bug | `make-zip.sh` only works when the repo folder is named `messenger-catchup` |
| G4 | P3 | doc gap | Page text refers to a Refresh button that is hidden |
| G5 | P3 | doc gap | Page install steps name only Violentmonkey; SKILL.md recommends Tampermonkey |
| R3 | P3 | risk | Reader depends on English labels and Messenger's markup (known) |
| R4 | P3 | risk | Page and Ask Claude hold the whole history in memory / one prompt |
| R7 | P3 | risk | Helper leaks a click listener per scan and polls the URL forever |
| C1 | P3 | cleanup | Unreachable code in the page (Refresh trigger, summary v1, range summaries, notes) |
| C3 | P3 | cleanup | Leftover `pa*` names and chat-specific comments · **done** |
| C4 | P3 | cleanup | Minified one-line style in helper and page |
| C5 | P3 | cleanup | `catchup._ts` shells out to `date` |
| C6 | P3 | cleanup | `catchup.py` opens files without closing them |
| T4 | P3 | test | Sim doesn't cover other date-label forms |
| T5 | P3 | test | No CI · **done** |
| F1 | P3 | feature | More than one chat per page |
| F2 | P3 | feature | Faster distant photo-reply parents |
| F5 | P3 | feature | Page shows "update available" when its version is behind |
| F6 | P3 | feature | Ask Claude over long histories |

---

## Bugs

### B1 · P3 · Threading `note` never filled in for new pages
- **Where:** `scripts/catchup.py:105`
- **What:** the note ("N reply links read straight from Messenger; …") is produced by `re.sub` on the *existing* note. Setup seeds `note:""`, the pattern never matches, and the note stays empty forever. The Messages tab shows it when present (`page.html:896`).
- **Seen:** replay on Nov 6 printed `note= ''` after a successful build.
- **Fix:** if the pattern doesn't match, set the note outright.

### B2 · P1 · `catchup.py build` advances WORK with no backup
- **Where:** `scripts/catchup.py:134-135`; SKILL.md refresh step 6 ("restore WORK from the previous base files first"); LEARNINGS.md ("Restore the workspace from backup before rebuilding")
- **What:** `build` overwrites `WORK/all.json`, `WORK/base/*` and `WORK/state.json` as soon as it succeeds. If the batch write that follows fails (an `if_version` conflict, a dropped call) or Claude needs to fix a link and rebuild, a second `build` fails with a bare `AssertionError: []`. Nothing keeps the previous files, so "restore from backup" means re-running `bootstrap` from a fresh DB fetch.
- **Seen:** replay on Nov 6: the second `build` of the same RUN → `AssertionError: []`.
- **Fix:** copy WORK to `WORK/prev/` before advancing; add `catchup.py restore WORK`; or split into `build` (writes RUN/out only) and `commit` (advances WORK after the DB write succeeds). Give the assert a message ("RUN already built; restore WORK first").

### B3 · P3 · `dealEdit` crashes without a deal
- **Where:** `scripts/catchup.py:116-119`
- **What:** `[d for d in deals if d['conv']==cid][0]` → `IndexError` when the conversation has no deal; with two deals, only the first can ever be edited.
- **Seen:** replay on Nov 6 → `IndexError: list index out of range`.
- **Fix:** assert with a clear message; key edits by deal index or text.

### B4 · P2 · Cross-conversation links accepted silently
- **Where:** `scripts/catchup.py:85-102` (no check), `page.html:704` (`set.has(lk[0])`)
- **What:** a spec `links` entry (or a GUESS/quote default) may point at a message in a different conversation. `catchup.py` only checks that links point backward. The page nests a message only when its parent is in the same conversation, so the link disappears from the card and the Messages tab and the message shows as a root. The link type isn't validated either (`"x"` would be stored).
- **Seen:** replay on Nov 6: link `3 → 2` across conversations built without a warning.
- **Fix:** WARN (or assert) when the parent isn't in the same conversation, and on unknown types.

### B5 · P3 · Reply with no parent found gets an auto `i` link
- **Where:** `scripts/catchup.py:94-99`; SKILL.md setup step 6 ("Replies to messages from before the first window print `WARN reply parent not found`: leave those unlinked")
- **What:** after the WARN, the code falls through to the GUESS step and links the reply to the previous member of its conversation as `i`. On a first run, SKILL.md says to review GUESS lines only for the newest ~150, so older replies keep a wrong "answers" link.
- **Seen:** replay on Nov 6: `WARN reply parent not found 5` then `GUESS 5 -> 3 i`.
- **Fix:** skip the GUESS for messages with `r` set and no parent found (leave unlinked), or make SKILL.md match the code.

### B6 · P2 · Capture date parser fails silently on some labels
- **Where:** `helper.user.js:77-78` (`dOf`)
- **What:**
  - Only full month names ("November 3") and full weekday names ("Monday") are recognized. "Nov 3, 2026" or "Mon 9:15 AM" fall through to **today's date**, with no warning.
  - A year-less date is given the current year, so "December 28" read on Jan 4 becomes Dec 28 of the *new* year, in the future.
  - `d` drives the time-mode catch-up window and `catchup.py`'s 3-hour GUESS/ROOT rule, so a wrong date skews both.
- **Seen:** probe on Nov 6 (EXPERIMENTS.md §10). Whether real Messenger aria-labels ever use short forms is unknown. The mock only uses full names.
- **Fix:** accept 3-letter months and weekdays; if the result is in the future, subtract a year; if nothing matched, report it in the capture summary instead of using today.

### B7 · P3 · Mention of message #0 renders empty
- **Where:** `page.html:765`, `page.html:767` (`r[0]||r`); `page.html:596` uses `r[0]??r` correctly
- **What:** mention refs are `[[i]]`. For `i = 0`, `r[0]||r` returns the array `[0]`, and the snippet shows only "#0".
- **Fix:** use `??` as in the header.

### B8 · P2 · One malformed link crashes the render
- **Where:** `page.html:837` (`msgRow`), and `page.html:639` (legacy v1 summary)
- **What:** `new URL(u).hostname` is not guarded. A single bad entry in any message's `l` throws inside `renderMessages`, and the Messages tab (and the threads inside summary cards) render blank. The "Links shared" table already guards this (`page.html:786`).
- **Fix:** wrap the call in try/catch as at line 786; optionally validate `l` in `importCore`.

### B9 · P3 · Wrong confirmation text with auto-posting
- **Where:** `page.html:680`
- **What:** after "Queue reply", the status always says "Tell Claude “send” in chat (or wait for the next refresh) and confirm", even when `outboxAuto` is on and no confirmation will be asked. The page test also showed that this text only flashes: the outbox snapshot re-renders the row right away and replaces the composer with a "reply queued" chip, so the wrong wording is barely visible.
- **Fix:** branch on `CFG().outboxAuto` like `applyCfg` does, or drop the text and rely on the chip.

### B11 · P3 · Messenger's reply link to #0 is ignored
- **Where:** `scripts/catchup.py:88` (`if m.get('pi')`)
- **What:** `pi` is the parent's message number. When the parent is message #0, `pi` is `0`, which is falsy, so the Messenger link is skipped and the fallbacks run: quote matching, or for a photo reply "the author's latest photo". That can link to the wrong photo, the exact failure clicking photo replies was meant to prevent (EXPERIMENTS.md §4). Only replies to message #0 are affected.
- **Seen:** `tests/test_catchup.py::TestKnownBugs.test_B11_messenger_link_to_message_zero`: a photo reply clicked to #0 was linked to #1, Ana's later photo.
- **Fix:** `if m.get('pi') is not None`.

### B10 · P3 · `make-zip.sh` depends on the folder name
- **Where:** `make-zip.sh:4-6`
- **What:** it `cd`s to the parent folder and zips `messenger-catchup/…`, so a clone under any other name fails, and the ZIP lands outside the repo (the `*.zip` entry in `.gitignore` never applies).
- **Fix:** stage into a temp dir named `messenger-catchup/` and write the ZIP into the repo (or `dist/`).

## Risks

### R1 · P1 · Unpinned page writes; half-finished imports
- **Where:** `page.html:977-990`
- **What:**
  - The importer writes chunks, then `meta/chat`, then `photos/index` (read-modify-write) with no version pins. SKILL.md's "pin every write" rule only covers Claude. The `S.pasting` guard only stops a double paste in the same tab. Two page tabs, or the page and Claude writing `meta/chat` at the same moment, can overwrite each other.
  - If the chunk writes succeed but the `meta/chat` update fails, the next import refuses ("The newest stored chunk doesn't end at #…"). Nothing documents how to recover.
- **Fix:** use version pins if the page database API supports them. Add a Troubleshooting entry: compare the last chunk with `meta/chat.lastI` and either trim the chunk or set `lastI`/`lastMid`/`anchorMids` from it.

### R2 · P2 · Capture size is unbounded
- **Where:** `helper.user.js:103-105`
- **What:** every photo in the window travels base64-encoded inside the clipboard text. A first run of 1,000 messages, or a long gap, can mean many MB on the clipboard and in one paste event. The real limits of clipboard, paste and upload haven't been measured.
- **Fix:** measure; cap photos per capture (send the rest on the next run, or split into several pastes).

### R3 · P3 · Messenger markup dependency (known)
- English UI labels, `[role="log"]`, `data-message-id`, "Go to replied message", "Reply to this message", the `At <time>, <name>: ` aria-label shape. See F4.

### R4 · P3 · Whole history in memory and in one prompt
- **What:** the page rebuilds the full list on every chunk change; Ask Claude with "include older messages" sends every stored message (~3,900 and growing). `prompt_too_large` is handled but makes the option useless.
- **Fix:** see F6.

### R5 · P2 · E2EE and messenger.com
- **What:** `/messages/e2ee/t/` URLs are stored and used but untested against a live E2EE chat. The userscript `@match` covers only `www.facebook.com/messages/*`, so `messenger.com` isn't supported.

### R6 · P2 · Scheduling tool names
- **Where:** SKILL.md › Scheduling
- **What:** Options A and B name `send_later`, `create_trigger` and `requires_local_device: true`. These come from the environment the skill was built in. Check that they still exist under those names wherever the skill is installed, and give a fallback if they don't.

### R8 · P2 · PR rule not enforced
- **What:** from v1.1.1 every change must go through a PR with a version bump (CLAUDE.md), but `main` still accepts direct pushes, and nothing runs `npm test` on a PR. The version-consistency tests only catch a missing bump when someone runs them.
- **Fix:** branch protection on `main` requiring a PR (and, once T5 exists, a passing check). Check whether the plan allows it on a private repo. Then T5: a GitHub Actions job running `npm test` on every PR.
- **Done in v1.1.2, as far as the plan allows:**
  - Branch protection and rulesets return 403 ("Upgrade to GitHub Pro or make this repository public").
  - Instead: CI runs `npm test` and a version-bump check on every PR; a `pr-only` job turns `main` red when a commit arrives without a merged PR (verified that the commit→PR API tells a squash merge from a direct push); a `pre-push` hook blocks direct pushes from local clones.
- **Still open:** nothing stops a push on the server side. Closing that needs GitHub Pro ($4/month) or a public repo (the owner's call).

### R7 · P3 · Helper housekeeping
- **Where:** `helper.user.js:16`, `helper.user.js:162`
- **What:** each `mcScan` adds a capture-phase click listener that is never removed. It goes inert after a scan, but turns on again during the next one. A `setInterval` polls `location.href` every 800 ms for as long as the tab is open. Both are harmless today.

## Doc and instruction gaps (SKILL.md / page text vs code)

### G1 · P2 · `meta/chat` fields not in SKILL.md
- **What:** the page writes `lastT`, `ownLastMid`, `caughtUpAt`, `markerSetAt` and `markerTo`, and catchup.py writes `threading.builtAt`; none are in SKILL.md's schema. The full list is in ARCHITECTURE.md › Database reference. Separately, SKILL.md says to republish the page when `meta/chat.pageVersion` is older than `PAGE_VERSION`, but never says to update `pageVersion` afterwards, so it stays old and every run republishes.
- **Fix:** add the fields; add "then update `meta/chat.pageVersion`" to setup step 2.

### G2 · P2 · Collections Claude is said to read but doesn't
- **What:** the page says saved questions are kept "so Claude can see what you asked" and that views and method ideas are what "Claude reads … when improving how catch-ups are built". SKILL.md never mentions `qa`, `views` or `notes`.
- **Fix:** either add a step (for example, glance at new `views` with `kind:"idea"` after each refresh and mention them in the report) or reword the page.

### G3 · P2 · "Reply 3232" has no procedure
- **Where:** `page.html:475`
- **What:** the page tells the user to say “reply 3232” or “open #3232” to Claude. SKILL.md has the `jump{mid,reply}` command but no section for this request (look up `m` for that `i`, open the tab, start `jump`, report).
- **Fix:** add a short "Open a message" section to SKILL.md.

### G4 · P3 · Hidden Refresh button still mentioned
- **Where:** `page.html:295` ("…and again each time you press Refresh")
- **What:** the button is hidden in the generic page (C1), so the sentence describes something the user can't see.

### G5 · P3 · Helper install wording differs
- **Where:** `page.html:304-305` vs SKILL.md › Helper
- **What:** the page's steps name only Violentmonkey; SKILL.md recommends Tampermonkey (both tested).

## Cleanup

### C1 · P3 · Unreachable code in the page
- **What:** about 80 lines kept from the user-specific page: the Refresh trigger (`REFRESH_TASK`, `startRefresh`, `fire_trigger`, `S.mcp`, and the non-`NO_TASK` branches of `renderRefresh`; its `NO_TASK` branch is live and shows the status line), the summary v1 renderer, range summaries (need `summary.fromI`, which nothing sets), `dayMap`/`meta.dates`, and the "Notes from Claude" section. Details in ARCHITECTURE.md › Legacy.
- **Decide:** remove, or revive. Range summaries could come back if `catchup.py` wrote `fromI`, and the Refresh button if scheduled triggers can be fired from a page again.

### C2 · P2 · Helper copies and version strings · done
- **What:** `helper.user.js`, the HTML-escaped copy in `page.html` `#jump-us`, and the URL-encoded `jump()` bookmarklet in `#jump-bm`; plus `1.1` in four places inside the helper. Nothing enforced the sync.
- **Done Nov 6:** `tools/sync-helper.py` (`npm run sync`) regenerates both page copies from the file. It reproduced the existing page byte for byte before it was first used. `tests/test_tools.py` fails when the copies drift or the four version strings disagree. It lives in `tools/`, not `scripts/`, so it isn't shipped in the skill ZIP.

### C3 · P3 · Leftover names · done
- Were: `paScan`, `paVerify`, `paCapture`, `patool.py`, the `pa-capture` kind still accepted by the page, and the palette comment "pack fabrics … EPX200" (`page.html:6`).
- **Done Nov 6:** helper functions are `mcScan` / `mcVerify` / `mcCapture`; the build tool is `scripts/catchup.py` (SKILL.md updated); the page accepts only `mc-capture`; the comment is neutral. History docs keep the old names where they describe the past. Versions not bumped: no behavior changed, and an already-installed 1.1 helper talks to the skill through the same bridge commands.

### C4 · P3 · Minified style
- The helper and most of the page script are one long line per statement, which makes diffs and reviews hard. Options: keep a readable source and generate the dense copy, or just run a formatter. Watch the userscript copy size if you change it.

### C5 · P3 · `catchup._ts` shells out to `date`
- Use `zoneinfo` instead; also removes the dependency on `%-d` support in `date`.

### C6 · P3 · Unclosed files in `catchup.py`
- `_load` and `_dump` use `json.load(open(p))` / `json.dump(o,open(p,'w'))`. CPython closes and flushes the files right away, so nothing is lost today, but every call raises a `ResourceWarning` (the test runner passes `-W ignore::ResourceWarning`). Use `with open(...)`.

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
- **Still not covered:** range summaries and the legacy v1 renderer (C1), the lightbox, and the "Find in Messenger" panel.

### T4 · P3 · More date-label forms in the mock
- Add short month/weekday labels and a year-boundary case once B6 is fixed.

### T5 · P3 · CI · done
- **Done in v1.1.2:** `.github/workflows/test.yml` runs `npm test` on Ubuntu (Python 3.12, Node 22, Playwright Chromium) for every PR and push to `main`, and uploads `tests/out/` when it fails.

## Features and opportunities

### F1 · P3 · Several chats
- One page and one loop per chat today (LEARNINGS.md › Open issues). Simplest path: one page per chat, keyed by `meta/chat.thread`, and a loop that walks them.

### F2 · P3 · Faster distant photo-reply parents
- Bringing a far-up parent into view is slow and can fail with `notfound` (EXPERIMENTS.md §3, refresh 240). LEARNINGS.md suggests opening the reply through its jump link and clicking from there.

### F3 · P2 · Correct an existing link
- The spec's `links` only applies to messages in the current build, so a wrong link found later can only be fixed by editing `threading/current` by hand. Add a `relink` key (`{i: [parent,type] | null}` for older messages), checked by the same asserts.

### F4 · P2 · Self-check for markup changes
- A helper `selfcheck` command that confirms each selector and label the reader relies on is present, run at the start of every refresh. A clear "Messenger changed: X missing" beats a confusing scan error.

### F5 · P3 · "Update available" on the page
- The page could compare its `PAGE_VERSION` with `meta/chat.pageVersion` and the helper's `data-mc-helper` version, and say when either is behind.

### F6 · P3 · Ask Claude over long histories
- Send summaries for older stretches plus the raw window, or pick messages by keyword first, instead of all stored messages.
