# Changelog

One entry per release. Every merged PR is a release: it bumps `VERSION` and adds an entry here (see [CLAUDE.md](CLAUDE.md) › Versioning). Newest first. Component versions (`PAGE_VERSION`, helper) are noted when they change.

## [1.34.0] - 2026-11-22
**A reply check cheap enough to run every few minutes** (BACKLOG F30, option C step 1; the owner chose frequent checks and "measure first"). MINOR: a new skill. Page and helper unchanged (`PAGE_VERSION` 4.0, helper 2.1).

### Added
- **The `reply-check` skill** ("check replies", "reply check", or a message starting "Scheduled reply check"; `/messenger-catchup:reply-check`). Its `SKILL.md` is about 1 KB and names no other file. It finds the page (the URL in the message, the one the conversation uses, or `Artifact list` as the replies skill does), makes one `ArtifactData query outbox` for a `queued` row with `limit` 1, and with none says "No replies waiting." and stops: no other read, file, browser or schedule. With one, it hands over to `messenger-catchup:replies`, which checks approval and the run lock, posts and reports. Rows in `sending` don't count: the replies skill leaves them for the next refresh. Nothing schedules it yet: step 2 measures an empty check's cost on the owner's account and then sets its schedule with the owner.
- The refresh skill's "Which part to follow" sends "check replies" to the new skill (one short line: its `SKILL.md` is within 60 bytes of its 20 KB cap).
- Tests: `test_tools.TestReplyCheck` (under 1,500 bytes and no files of its own, its trigger phrases exactly "check replies", "reply check" and "Scheduled reply check" with no "send replies" or refresh in its description, the one query and its stop, the hand-over, the page found as the replies skill finds it); the shipped-file, ZIP, skill-name and stale-wording tests include it. Sim `S: reply check`: the query its file gives, run against the stand-in database: nothing queued (only `sending`, `sent` and `cancelled` rows) is one read and one line; a queued row goes to the replies skill's run, which posts it and releases the lock.

### Changed
- CLAUDE.md, README.md and docs/STATUS.md list four skills. BACKLOG F30 records step 1 and what step 2 decides with the owner.

## [1.32.0] - 2026-11-22
**Fuller day summaries, kept current by every refresh, with Copy for chat** (BACKLOG F29, decided on the owner's decision board as option A). MINOR: a new page feature and refresh procedure changes. Page **`PAGE_VERSION` 4.0** (from 3.9); helper unchanged (2.1).

### Added
- **One fuller summary per day** (`daySummaries/d<YYYY-MM-DD>`, one document per day): topic sections, each a heading with bullets citing that day's messages, then "Still open" (open questions, unanswered asks, pending deals). No length limit; `catchup.py` keeps only sanity checks (shared helpers for the per-day collections, `_per_day`, and for hashes, `_hash`) (a real day with stored messages, at least one section with a one-line heading and a bullet, each bullet one line citing at least one stored message of that day, the document within the build's byte cap).
- **Kept current by each refresh.** `catchup.py days WORK RUN` lists what's due (3 days at most per refresh, oldest first) and writes what to read to `RUN/out/days/<day>.txt`: an `UPDATE` of the day in progress (its summary so far plus only the messages after it; Claude writes the whole updated summary), a `NEW` one, or a `FINAL` rewrite of a day that has ended (all its messages, as one piece; `final` when a later day was already stored, and never written again). A day that ended in `meta/chat.tz` while the browser still dates messages with it (the chat's zone ahead of the browser's) gets them as updates, so none waits, and its final rewrite once a later day is stored; one that got nothing more is marked final as it is. With no summary yet (the first refresh after the update), the day that ended just before it gets its final summary too, unless an older digest covers it. A query of the newest summaries that may have missed a day asks for a larger one, recorded with the listing (`.limit`; reports too). The build spec's `daySummaries` goes through the manifest, pinned when step 5's query of the newest 5 summaries holds the day. Procedure: the refresh skill's new `references/day-summaries.md`; SKILL.md steps 5 and 6 point at it.
- **Clear words when Claude can't answer.** A declined consent (`not_granted`, the code sample.d.ts gives a decline) now says Claude access wasn't allowed on this page and how to allow it (the page's Permissions in the artifact's menu, then reload), in Ask, Views, automatic view updates and range summaries; every other error code of the contract has its own words, and a failure without a known code shows its code and message ("Something went wrong (…). Try again.") instead of a bare "Something went wrong", so it can be reported. An automatic update's failure keeps its message (`views/*` `autoErr.msg`). Checked on claude.ai: closing claude.ai's "Allow use of Claude" prompt rejects with `upstream_error`, not `not_granted`, so that code's message also says Claude may not be allowed on the page yet and how to allow it.
- **By day shows them:** each day's headings, bullets with every message number a citation that opens the message, and Still open; labelled "In progress · updated 9:04 AM" (with "so far" on the count), "Final · written Mon 1:10 AM", or "Day ended" while its final rewrite is still to come ("rewritten as one piece at a refresh that brings new messages"). The label follows midnight in the chat's time zone without a reload. The refresh runs (F27) fold under the summary. Days without a summary show their older digest.
- **Copy for chat** on each day's card: copies the day as chat-ready plain text (the day as a title, "(so far)" on the day in progress, each heading and its "• " bullets, Still open) without message numbers, and says "Copied.". Where claude.ai's viewer blocks the clipboard, it says so and shows the text selected in a box to copy by hand. No shared links.
- **The backfill of past days**, run only when the user asks (the owner wants to like a few days first). It lists the whole collection a page at a time (a list returns at most 1,000 documents), marked complete with `RUN/daySummaries/.all`, which every backfill command requires: `catchup.py days WORK RUN --backfill` (finished days without their final summary, newest first, 5 days and 2,000 messages a batch), `catchup.py day-summaries WORK RUN SPEC` (backs up what it replaces in `RUN/out/backup/`), the run lock around each write, and `catchup.py check-day-summaries WORK RUN AFTER`.
- Tests: Python `TestDaySummaries` (what's due at a refresh and in a backfill, caps and carry-over, the `UPDATE`/`NEW`/`FINAL` files, every refusal, pins, final and full by the day's end and the chat's zone, a chat zone ahead of the browser's, a day of hourly refreshes on a database with the real limits, document sizes, the backfill with a cut-off listing and with the whole one, its check, digests refused) and `test_tools.TestDaySummaries`; page sections `daySums` (DS1–DS8, DS10, DS12), `askDaySums` (AD1–AD6, AD8) and `askErrors` (E1–E3). Each fix from the PR's review has a test that failed with the fix taken out. F23 and F23 on a phone set their conversations with `convSet` (v1.31.3's helper) instead of `details.open`, which a redraw for new data undid, and B40 also checks that such a redraw keeps what it set. The 13 tests that typed into the Messages filter and then waited a fixed 250–400 ms now wait until the list is drawn for that text (`msgFilter`): F15 O4 failed once in a three-at-a-time run with the machine at a load of 125.

### Changed
- **Refreshes no longer write per-day digests** (F16): the build refuses the `digests` key, step 5 no longer lists the `digests` collection, and `catchup.py digests` and `check-digests` are gone (`references/digests.md` became `references/day-summaries.md`). Existing `digests/*` stay: the page reads them for days without a summary.
- The Refreshing help no longer mentions an Ask checkbox for older messages (gone since F32): Ask Claude and Views always cover the whole history.
- **Ask and Views read the day summaries:** a day line in the older history carries the day's summary ("Summary: Heading: point [#12]; … | Still open: …", whole points within 4,096 bytes, then how many more), else its digest. Each day first gets a short line no longer than its digest (its summary cut to the digest's size), newest day first, a day that doesn't fit skipped for the older ones, then those their full line the same way, so older history never covers fewer days than the digests did; a day's lines are built only when the swap reaches it, once per prompt, and a line never passes its byte cap; the `day_summaries` tool gives each day's summary, at most 4 KiB a day over several days (a day asked for alone: up to one result's 16 KiB), cut to whole points, and says where to continue when the days don't all fit. The note under an answer says "Day summaries for N days" (the saved row's `sent.digests` keeps its name).
- `references/database.md` (and its copies in setup and replies), `writing-the-build.md` and `reports.md` describe `daySummaries` and the older digests.
- **Windowed loading deferred:** the page reads the whole `daySummaries` collection, as it does its other collections (the owner's page has about 55 days, roughly 0.5 MB), and By day, Ask, Views and the `day_summaries` tool use the summaries in memory. A window (the newest 60 days live, older days read on demand) was built during the review and taken out after three rounds kept finding faults in it; it's BACKLOG F33, for when a page passes about a year of days, with the pitfalls the reviews found.
- **Backlog:** F29 removed (done); its live checks moved to L1; F33 added (windowed loading of day summaries for very long histories); `docs/design/day-summaries.md` marked built. R19 now names the day summary backfill. R12 closed: the owner's schedule now runs 5 AM–10 PM (hourly, no overnight runs; `meta/chat.schedule.hours`), and L1 keeps the check for the chain's first stop at the conversation length limit.
## [1.31.3] - 2026-11-22
**Packing deletes every original it replaces, and removes the ones it left behind** (R13, shipped in v1.30.0). PATCH: a fix. Page **`PAGE_VERSION` 3.9** (from 3.8); helper unchanged (2.1).

### Fixed
- **A packed day kept its originals when its photos sat in more than one block.** After repointing a day's slots, packing decided which originals were still in use block by block, each block merged with the old `photos/index` (pages before v1.22), which still names every original. A day across two or more 500-message blocks therefore saw its own originals "in use" from the other blocks and deleted none of them. On a live page, the originals of only 2 of 12 packed days were deleted (the two that sat in one block), so the file count barely fell: 1,194 files before packing, 1,173 after 12 packed days (24 pack files added, 45 originals deleted), with 542 unused originals left. No photo was lost and packed photos showed fine. Now, once the day's parts are written, the page reads the whole `photos` collection back once and deletes an original only if no slot, preview or pack entry anywhere uses it (`photoRefs`, the same rule as Cleanup, with the old index counted as the page shows it). If that read fails, nothing is deleted. The runtime's listing has no cursor and may come back short (the 0.2.98 `db.d.ts`: `get()` reads the matched set, `limit` 1–1000), so the read lists with `limit(1000)` and then reads on its own every document the page can name that the listing missed: the blocks up to the newest message's, the old index, `photos/packs`, every document the live listener holds and the sweep's documents. The SHA-256 check before anything changes and the read-back before deleting are unchanged.
- **The originals already left behind are removed.** With packing on and no day ready to pack, the page sweeps `photos/packs` entry by entry, in batches of 25 under the same lease and waits as packing (never during a refresh's run lock or while photos upload). An original goes only if (a) nothing in the `photos` documents uses it, (b) it is an item of that entry's full pack, which reads back as a full pack of that day whose every photo matches its SHA-256, (c) its slot shows that very item, and (d) its own bytes, read now, match the item's SHA-256. A pack that fails (b) gives up nothing. What the sweep keeps goes in one document per pack, `photos/swept-<pack>`, never cut short, as `/_blob/<id>` strings, so Cleanup's own rule counts it as in use: `kept` (every original a failed pack holds) and `own` (an original that doesn't match its packed copy). A pack that's missing or unreadable, or a `photos/packs` entry with no pack id, is `lost`: its originals can't be named from the pack, so it keeps those the old index names for the slots showing it, and while any pack is lost Cleanup deletes only duplicates. Progress is in `photos/packs.reclaim` `{n, at, checked, last, clean, swept}`. A pack made now that leaves nothing behind is marked checked, or, while an older entry is still to check, listed in `clean`, so the sweep never reads it. With no unused file at all, every entry is marked checked without reading a pack. A listing that fails or misses files falls back to reading each original.
- **A delete that fails no longer becomes an orphan straight away.** Packing stops deleting at the first failure and leaves the rest to the sweep, which tries again after the error backoff. A delete refused for that file (`not_uploader`, `invalid_request`) counts once in `orphans` and is recorded (`refused`, bare ids, so Cleanup can still remove it) and skipped after. A refusal for the whole view (`not_granted`, a disabled capability) counts nothing: the batch stops with an error.
- **The Photo storage box says what's happening.** "Removing original files left over after packing: 12 packs still to check, 40 removed so far." while it works, "542 original files left over after packing were removed (last …)." when done, "The pack for … didn't pass a check, so the 3 original files it holds are kept." for a pack that failed, "The pack for … is missing or can't be read, so its photos can't show. The page keeps the 2 original files it can name for it, and Cleanup deletes only duplicate files while it's like this." for a lost one, "1 original file is kept because it doesn't match its packed copy.", and the orphans line as before. "Packs still to check" leaves out new packs that left nothing behind, and while a day packs the box says "Packing … now…" without also naming that day as the last packed. When the import lease is held by another open copy of the page that is packing, it says "Waiting: packing is running in another open copy of this page." instead of "another import is running": `refresh/packing` `{tab, at}` is written when a tab starts packing or sweeping, again every minute while it works, and deleted at the end, outside the `photos` collection so open copies don't redraw for it.
- `references/photos.md` › Storage (Leftover originals) and Cleanup (what `photos/swept-<pack>` keeps is in use; a lost pack means duplicates only; the listing is followed with `next_cursor`), and `references/database.md` (`reclaim`, `photos/swept-<key>`, `refresh/packing`, `orphans`), with their copies.
- Tests: page section `packs3`. S1: a day across three blocks and a day across two, their originals in the old index, all deleted, and the file count falls by each day's photos less its 2 packs. S2: an original yesterday's slot still uses stays, and `busy` names the tab while it packs. R1: a page packed by v1.31.2 gets its leftovers removed in batches, while a pack that fails its check, a missing pack, an original still in use and a stray file keep theirs, and the box says so. R2: the sweep waits for a refresh's run lock, and works with a listing that misses files. R3: the waiting wording. R4: no unused file, no pack read, and nothing written to `refresh/packing`. R5: leftovers already removed (by Cleanup, or another copy) are skipped quietly, including one a listing still shows: never passed to delete, and no error, orphan, kept file or failed pack, while each pack checks out from its own bytes. Each fails on v1.31.2. K13 now covers a failed delete retried by the sweep, and a refusal for good. K1 waits for the sweep to finish instead of 600 ms. The stand-in's scripted delete failures can carry a code (`__up.delCode`), its listing can show files that are gone (`listGhosts`), and it logs every delete (`__rt.deletes`) and every collection read (`__rt.colGets`); `getPage` and `snapPage` page the `photos` listings.
- **PR #58's review, each with a test in page section `packs4` that fails on the PR's first version:** V1, refusals counted once and skipped (before, 25 refusals looped for ever and grew `orphans` each time), and a view-wide refusal counting none. V2, a missing and an unreadable pack keep what the old index names and hold Cleanup to duplicates, so an original only the lost pack knew can't be deleted. V3, a failed pack of 1,001 photos keeps all 1,001 (before, the kept list was cut to the last 1,000). V4, a failed listing. V5, broken `photos/packs` entries (before, one stopped the sweep for good). V6, the box counting each cause. V8, one read of the collection per day. V13, a listing in pages of 100 with 153 documents (before, nothing was deleted and the sweep stopped), and both listings in pages, where the old code deleted an original a block it never read still used. V14, one state while a day packs. V15, new clean packs not counted, and passed without a read. `tests/test_tools.py`: one pack check (`fullPackBad`) and one asset-id rule (`isAssetId`, `blobOf`), and Cleanup's rule for swept documents.
- **Page tests that raced real timers, found by running the page suite three at a time.** Each failed once there and passed alone. P6 and P23 timed out an upload: the photos tests shortened the page's upload timeout to 1.5 s, and on a busy runner a slow upload (P3's 1.2 s one too) went past it. The shortened timeout is now 20 s, and only P13, the test of a hung upload, sets a short one (3 s, against a 6 s hang, and it waits for the late answer instead of 1.5 s). F31 ST21 typed into the word box and checked "nothing applies yet" against its 400 ms pause. Every word box test now types with the page's clock paused and then moves it on (`stType`), and Enter is checked while paused. The date entry check in `pipeline` waited a fixed 1.9 s for a save due 1.5 s after the last key. It now runs on Playwright's clock the same way. B40's "Show #30 can be clicked" failed in a later triple run: the test opened and closed conversations by setting `open`, which the page doesn't remember (only a reader's click on the summary is remembered), so a redraw for data that arrived late put them back and hid the button. A new helper (`convSet`) records the change as a click does, used there, in B42's phone case and in `olderByDay`. F23's "opens #… by loading its day" now waits for the day to load instead of a fixed 700 ms. K9's "import lease held by another tab" seeded a real 2.5 s lease, which lapsed before its check on a busy runner (as P5's did, T7). The lease is now held for 2 minutes and the test ends it itself. Views V7's click on New view, with a 2 s timeout, didn't land in a later triple run; the 14 clicks in `savedQuestions` and `viewsTab` that waited 2 s now wait 10 s, as `tryClick` and `until` do. B42 read a bubble's actions 250 ms after a hover, focus or blur, while the page fades them over 0.12 s, and caught one mid-fade (0.94) on a busy runner; its four checks now wait for the opacities they expect (`opacities`).
- **Backlog:** L1 gains the live check after the owner's page gets 3.9.

## [1.31.2] - 2026-11-22
**No release on a red or re-run `main`, and the page tests that raced timers are deterministic** (closes BACKLOG T7). PATCH: tests and tooling. Page and helper unchanged (3.8, 2.1).

### Fixed
- **v1.31.1 was released while `main`'s CI was still running, and that run failed** (B40, "the context line's Show #30 jumps to #30"); its re-run failed too. The code it released passed the same test on its PR, but the release should never have gone out on a red build.
- **`tools/release.sh` now refuses** unless `main`'s CI run for that exact commit finished green on its **first attempt** (`tools/ci-green.sh`, run before anything is tagged). A re-run that goes green doesn't count: the failure gets fixed in a new PR, or raised with the owner. CLAUDE.md says so and adds "A failing test is never ignored".
- **Page tests no longer try to catch the 2.2 s highlight.** Every check that waited for a message's `flash` class (B40, B42, the summary and Ask citations, By day, claims, F23, Stats) could miss it on a slow runner. The stand-in now marks every element that gains the class (`data-flashed`, kept), each check clears the marks just before its click, and B40 says what it saw when it fails.
- **The Undo tests no longer race a shortened timer.** Saved questions and Views shortened the 6 s Undo delay to 0.4 s and then raced it with real clicks; under load, saved Q3's first removal was deleted before its second click (found by running the released tests three at a time). Those pages now run on Playwright's clock with a 60 s delay that a case ends by moving the clock (`undoPass`), in all 14 places.
- **P5 no longer races the clock (T7).** It copied the closed tab's import lease with its real end and then did several slow steps before the paste that should find it held; on a busy runner the lease lapsed first. The test now sets the lease's end itself: held for the first paste, lapsed for the second.
- Tests: `TestReleaseScript` checks release.sh runs the guard before tagging, and runs `ci-green.sh` against a fake `gh` for every case (no run, running, failed, failed on a re-run, green only on a re-run, green first time).

## [1.31.1] - 2026-11-22
**No false "older copy of the skill" notice when one run writes its start and finish times.** PATCH: a fix. Page **`PAGE_VERSION` 3.8** (from 3.7); helper unchanged (2.1).

### Fixed
- The page compared `meta/chat.versions.refresh` with `lastRefresh` exactly, and showed "The last refresh ran an older copy of the Messenger Catch-up skill" when they differed. Scheduled run 599 put its start time (9:09 AM) in one and its finish time (9:16 AM) in the other, so the owner's page showed the notice although the current skill had run. Times less than 45 minutes apart now count as the same run; a run an hour or more apart still shows it. `references/database.md` says so.
- Test: notices U26 (7 minutes apart, 25 minutes across midnight: nothing; an hour apart: still the notice).

## [1.31.0] - 2026-11-22
**Ask and Views cover the whole history and search every message and photo** (BACKLOG F32, decided on the owner's decision board). MINOR: page behavior users notice. Page **`PAGE_VERSION` 3.7** (from 3.6); helper unchanged (2.1).

### Added
- **Claude searches the chat itself.** Where the viewer can run page tools (`sample.limits().tools`; tested on claude.ai, including the 0.2.92 runtime the owner's page uses), Ask and Views hand Claude three of the page's own functions: `search_messages` (every stored message, however old: the text, the sender's names, link previews, quotes and photo captions; every word must appear; optional dates and sender), `read_messages` (a range or a whole day, word for word) and `day_summaries` (a line per day, with digests). Claude retries with other words when a search finds nothing, reads around a hit before citing it, and answers with [#n] citations. Each result is at most 16 KiB and one question's results stay within what its prompt left of the cap, so a call never outgrows it. While Claude works, the answer's place says what it last searched ("Searched “backpack”: 2 matches"); text written before its last search is dropped from the answer.
- **Every match under the answer.** A row of searches with their counts ("“plaid” · 0", "“backpack” · 2") and, when the question's own words all appear somewhere, "Your words". The list, newest first, is the page's own complete search (not just what Claude was shown); a row opens its message. The note adds what was searched and read, and the saved question (`qa/*` `sent.searches`, `sent.reads`) and Earlier questions keep it. Views save and show theirs too.
- Test: page section `askSearch` (AS1–AS17), with the stand-in now playing scripted tool rounds (`window.__toolPlan`, `__rt.toolLog`, `opts.tools`, `opts.toolsUnavailable`).

### Changed
- **Ask and Views always take the whole history:** the newest messages word for word, older ones as summaries, back to the first message. The "Include messages before the catch-up window" box is gone, and Views are no longer limited to the window. With search tools the up-front prompt keeps to 96 KiB (or 60% of a smaller cap), the rest being for what Claude reads, so most questions send less than "include older" did; without them it goes in at the full cap, as "include older" did.
- **Look deeper** shows only where search tools aren't available; with them Claude reads what it needs itself.
- A view where tools turn out unavailable (`tools_unavailable`) asks once more without them, and the page stops offering them.
- `references/database.md` (and its copies): `qa/*` `scope` is `all`; `sent.searches` and `sent.reads`. Tests: H4, H6 and H14 now expect the whole history.
- The Messages tab and its filter stay as they are (the owner: "keep it for now"). Range summaries already read every message of their range.

### Fixed
- **"Summary written undefined."** A summary without a `generatedAt` (seen on a scratch page seeded by hand) showed that on the Summary tab; the clause is now left out.

- **Backlog:** F32 removed (done). Recorded from the decision board: F29 decided (one fuller summary per day, Copy for chat, no links, after F32), F1's answers (designs and test cases before any build), R12 reanalyzed (recommend closing; waits on the owner). L1 gains the photo checks for v1.30.0 and a watch on "Scan didn't start scrolling". T7 filed (page test P5 is timing-sensitive under load).

## [1.30.0] - 2026-11-21
**Day packs end the 5,000-file photo limit, and photos are found by what's in them** (BACKLOG R13, decided on the owner's decision board as "E + S"). MINOR: a new page feature behind a switch, and refresh procedure changes. Page **`PAGE_VERSION` 3.6** (from 3.5); helper unchanged (2.1).

### Added
- **Day packs (R13).** A claude.ai page holds at most 5,000 files and 1 GiB, and every stored photo was one file (the owner's page: 1,131 files but only 66 MB on Nov 21, adding about 70 a day). With the new **Photo storage** switch on (`meta/chat.photoPack`, off until the owner turns it on), the page packs each finished day (the day before yesterday and older, in the chat's time zone, with no photo still owed) into one full pack, the original bytes as they were, and one pack of 320 px previews:
  - It checks every photo in the pack against the original's SHA-256 before anything changes. On a mismatch, it deletes the new packs and keeps the originals.
  - It repoints the slots (`/_blob/<pack>#<n>`, and `pv` for the preview), reads them back, then deletes the originals. About 70 files a day become 2.
  - It packs one day at a time under the import lease, never while a refresh holds the run lock or photos are uploading.
  - The chat shows packed photos from the preview pack, and the photo viewer shows the original from the full pack. A pack that can't load shows a "Photo couldn't load" tile.
  - The Photo storage box (under How it works) shows usage, the switch, the last packed day, days left and any error.
  - `photos/packs` lists every pack for the archive pages still to come. `references/photos.md` covers packs (and how to open one photo from a pack). Cleanup counts pack files and preview packs as in use.
  - Tests: page sections `packs` and `packs2` (K1–K15).
- **Photo captions and photo search (R13 "S").** Each refresh already opens every new photo. It now also writes a one-line caption from the photo and the messages around it ("green Ultra Monolith pack, side view, coyote straps"):
  - Captions go in the build spec (`captions`), which `catchup.py` checks and merges into `captions/b<start>`.
  - The Messages filter matches a message by its text or its photos' captions, and shows "📷 caption: …" when a caption helped.
  - Photos carry their caption as alt text and tooltip, and under the photo in the viewer.
  - Ask, Views and range summaries see captions in each message line.
  - **Captions for older photos:** "caption my old photos" runs `catchup.py captions` in batches of 50 (only when the user asks), reading previews from day packs where they exist.
  - Tests: 11 in `test_catchup.py`, page section `captions`.

### Changed
- **A multi-word Messages filter matches every word, not only the exact phrase.** "green ultra monolith" finds a message whose text names the Monolith and whose photo caption says "green Ultra pack". A message containing the whole phrase still matches as before.
- **The busy-import toast** now also says the page may be packing photos; `references/troubleshooting.md` says how long to wait.
- **Backlog:** R10 and R11 removed (the owner: the Desktop app and Claude in Chrome are both needed, which is known). R13 now covers the archive pages for the 1 GiB, which are still to build.

## [1.29.0] - 2026-11-21
**Stats part 2, a Views list that keeps itself up to date, and each refresh's report on By day** (BACKLOG F31, F28, F27, all decided on the owner's decision board). MINOR: new page features and a refresh procedure change. Page **`PAGE_VERSION` 3.5** (from 3.4); helper unchanged (2.1).

### Added
- **Stats part 2 (F31).** Five more sections, each with its own Show switch, following the timeframe, zoom, day and person views, with no Claude call:
  - **Conversations and topics:** started and active, the busiest 10 (opening the thread), and the summary's tags by count.
  - **Deals:** posted, claims, sold and pending; median time from posted to sold; top sellers and claimers; the deals list.
  - **People:** new voices and who's gone quiet (posted in the 30 days before the span, not in it); first and last seen on a person's chart.
  - **Engagement:** who replies to whom (Messenger replies and threading links), questions asked and answered, and the median wait for a first answer.
  - **Word trends:** a search box charting how often a word or phrase is mentioned (whole words, any case), with who mentions it most; the box keeps its focus while the page redraws.
  - Still no reactions. Tests: page section `stats2` (ST17–ST24) and a 180,000-message speed check (ST15).
- **Views as a list (F28).** One view open at a time (remembered per browser), each with Rename, Rebuild and Remove (with Undo, as saved questions have), and a New view button for the build box. Method ideas and Claude's notes move into collapsed sections at the end. **Keep up to date:** a per-view switch rebuilds the view by itself after a refresh brings new messages, while the page is open, once per import and one view at a time, never during a refresh, another build or a rename; a failed update keeps the earlier version and says so. Rebuilds use the viewer's claude.ai usage, as building does. `references/database.md` documents the new `views/*` fields. Test: page section `viewsTab` (V1–V14).
- **Each refresh's report on By day (F27).** A refresh that stores new messages also saves its report, a few bullets citing message numbers, under its day (`reports/d<YYYY-MM-DD>`), written by `catchup.py` through the build's manifest, which checks every bullet's numbers and splits a run over midnight by message day. By day shows today's runs in a card for the day in progress, and a collapsed "What each refresh found (N)" under each finished day's digest. SKILL.md steps 5, 6 and 8 and the new `references/reports.md` describe it. Tests: 11 in `test_catchup.py`, page section `byDayReports` (BD13–BD17).

### Changed
- **Backlog:** F27, F28 and F31 removed (done). F25 and R13 notes are on the decision board.

## [1.28.0] - 2026-11-21
**Stats gets This week and Last week, typing a custom date works, and Summary threads read in order** (the owner's review of v1.27.0). MINOR: two new timeframes and changed card behavior. Page **`PAGE_VERSION` 3.4** (from 3.3); helper unchanged (2.1).

### Added
- **This week and Last week** on the Stats tab, next to Today. Weeks run Sunday to Saturday, as the week bars do; This week runs through today. Test: `stats` ST2c.

### Changed
- **A Summary card's open thread starts with the message it replies to.** That earlier message showed above the card's summary, and the opened thread began with the reply, without it. It still shows above the summary while the thread is closed, and moves to the top of the thread while it's open. Test: TH3.
- **The earlier message comes with what it answers.** When the message a conversation replies to is itself a Messenger reply (such as "What is it?" asked about a photo), the message it answers shows first, photos included. Before, the card spoke of a photo it didn't show. Test: TH4.
- **The Stats switch "Heatmap" is now "Day and hour"**, the name of the section it shows or hides.

### Fixed
- **Typing a custom date on the Stats tab.** Each typed segment applied the range and redrew the boxes, so a date couldn't be typed (a year passes through 0002, 0020 and 0202 on its way to 2026). The range now applies after a pause, on Enter, or when the box loses focus, and only for dates from 2000 on. A box that has the focus is never rewritten. A From after the To moves the To to match (and a To before the From moves the From), so the boxes always show the range in use; found in the claude.ai check. Test: ST2b (fails on 3.3).
- **"Close the thread" at the end of a long thread left the page wherever the next cards slid to.** It now brings the card back: its top under the tabs, or for a card taller than the screen, its "Show the thread" line part way down. Test: TH5 (fails on 3.3).

## [1.27.0] - 2026-11-19
**A Stats tab, replies sent without a refresh, and threads that open in place** (BACKLOG F31 part 1, F30 part 1). MINOR: a new page tab, a new skill and a refresh procedure change. Page **`PAGE_VERSION` 3.3** (from 3.2); helper unchanged (2.1).

### Added
- **Stats tab (F31, part 1).** Worked out on the page from the stored messages, with no Claude call. Timeframes Today, 30 days and 90 days up front, plus 7 days, All and a custom range, with a line saying where stored history starts. Eleven tiles: messages, messages with text, people posting, photos and GIFs, links, busiest hour, the top 5's share, your messages, conversations started, deals posted and deals sold (no reactions: they're captured once and never updated). A volume chart by hour, day, week or month: drag across it to zoom, Reset zoom to go back, click a day for its own view (its tiles, an hourly chart split by that day's top posters, its top 10). The top 10 by messages and share, with you ranked like everyone and nicknames merged with full names. Click a person for their own chart, busiest hours and whom they reply to most. A weekday-by-hour heatmap. Every chart has "Show as a table", works with mouse, touch and keyboard, and each section can be hidden (remembered per browser). Six tabs fit on a phone (smaller tabs under 420 px). Test: page section `stats` (44 checks), with a 180,000-message speed check.
- **"send replies" (F30, part 1).** A new `replies` skill posts the replies queued on the page and stops: no scan, import or rebuild. It reads only its own short `SKILL.md` (about 6 KB) plus the outbox references it needs, keeps every approval rule, takes the run lock just for the posting, and never touches the Messenger tab while a refresh holds the lock. The page's queued-reply note names the phrase, and its status line says "Claude is posting your replies…" during one. Tests: sim section S (8 cases), `TestSendReplies` (11).
- **Replies first in every refresh (F30).** A refresh, scheduled ones included, posts approved queued replies before its scan, so a reply never waits behind the build, and the same run's capture confirms it. Replies queued during the run still go out at step 8. A refresh waits up to 5 minutes for a reply run's lock instead of skipping its slot.

### Changed
- **Threads open in place.** "Show the thread" on a Summary card opened the thread in a box of its own that scrolled; it now opens at full length in the page, with "Close the thread" at its end as well as at its top (the owner's request). Tests: TH1, TH2.
- **CLAUDE.md:** three skills; `replies` carries copies kept by `tools/sync.py`.
- **Backlog:** F29 (fuller day summaries, with design notes), F30 and F31 filed; the owner's decision-board answers on R13, F27, F30 and F31 recorded.

### Fixed
- **A tab opened from far down a long tab showed only the page's foot** (found in the release check on claude.ai). The new tab's start now comes up under the tab bar; from the top nothing scrolls. Test: `byDay` BD12 (fails on 3.2).
- **The marker radios ignored a click made right after typing a date.** With the From box focused, the 1.5 s save switched to the date range but the radios weren't redrawn, so "Since your last message" still looked picked and clicking it did nothing; and the box's blur rebuilt the controls between mouse down and up, so the click was lost. The radios now follow the mode while a date box has focus, a click on a marker radio from the date box cancels the pending date save, and the rebuild waits until the click has landed. Found because the page test read message dates from the day the simulator last ran; it now uses the captured day. Tests: three date-entry checks (all fail on 3.2).

## [1.26.1] - 2026-11-14
**The tabs switch again in claude.ai's artifact viewer** (found live on the owner's page). PATCH: a page fix. Page **`PAGE_VERSION` 3.2** (from 3.1); helper unchanged (2.1).

### Fixed
- **Tab clicks did nothing.** The tabs switched only on `hashchange`. In claude.ai's artifact viewer, a click on a tab link put the `#hash` on the viewer's own address instead of the page's, so no `hashchange` reached the page and it stayed on Summary, whichever tab was clicked (the owner saw an empty By day tab). The tab links now switch in code, as message jumps already did (`history.pushState`, then `route()`), and Back works through `popstate`. Test: page `byDay` BD11 clicks every tab and goes Back; it fails on 3.1.
- **Why the tests missed it:** the stand-in runtime let `#hash` links navigate the page, which the real viewer doesn't. It now swallows them the way the viewer does, for every page test (`opts.hashLinks` restores the old behavior). Under it, the 3.1 page fails BD1 and BD11, the live bug; 3.2 passes the whole suite.
- **CLAUDE.md:** page releases are checked on claude.ai itself before they're called done (a scratch artifact, every tab and new control), and on the owner's page after it updates.

### Changed
- **Backlog:** F28 filed (rethink Views, to define with the owner). R12's note corrected: refreshes stayed on an old version because an older copy of the skill was uploaded to the owner's account, not because of the chain.

## [1.26.0] - 2026-11-14
**A By day tab for the digests, removing saved questions, a line for replies across conversations, and claims moved in one step** (BACKLOG F24, F26, F23, F21, C8, R9). MINOR: new page features and a refresh procedure change. Page **`PAGE_VERSION` 3.1** (from 3.0); helper unchanged (2.1).

### Added
- **By day tab (F24).** The page shows the per-day digests: one card per finished day, newest first, with its date, message count and bullets. Each bullet's message numbers open the message, as Ask's citations do (loading its day under Show older). Days still waiting for a digest are left out, with one quiet line saying which and why. 30 days at a time, with "Show N more days". Test: page section `byDay` (BD1–BD8, all fail on 3.0).
- **Removing saved questions (F26).** Each question saved on the Ask tab has a quiet Remove link, and Clear all appears from 2 saved questions. Either hides them at once and shows "Removed … · Undo", announced to screen readers, for 6 seconds before deleting `qa/<id>`; a failed delete brings the question back with a short message. No confirm dialogs. `references/database.md` says the user can remove them, so Claude doesn't bring them back. The test stand-in gains `DocumentRef.delete`. Test: page section `savedQuestions` (Q1–Q9, all fail on 3.0).
- **"↩ replying to" line (F23).** In the threaded views, a Messenger reply mid-conversation to a message in another conversation shows a short line above its bubble with the parent's sender and the start of its text (or [photo]). It opens the parent in its own conversation, loading its day under Show older. It replaces that row's reply link and quote. Guessed links (answers, continues), replies within the same conversation, and a conversation's first message (which already shows its parent, B40) get no line. Also in the Summary cards' "Show the thread". Test: page section `crossReply` (11 of 13 fail on 3.0; the other two are no-error checks).
- **Claims moved in one step (F21).** `catchup.py relink` takes `bullets` and `dealEdit` with a `move`, with links, or on their own. A claim moved to its offer at the user's request gets its summary bullet and its deal `claims` entry in the same write, instead of at the next build. They get the build's checks, through the build's own code: refs in the right conversation after the move, the claim and status rules, no `dealEdit` `index` where a move changed that conversation's deals, and one `rev` on both `current` documents. `references/writing-the-build.md` (Claims, Moving a message) tells Claude to pass them together. Builds now refuse a bullet that isn't `[text, [refs]]` with a clear message. Test: `TestRelinkClaims` (5, all fail before).

### Fixed
- **Unclosed files (C8).** `tools/sync.py` and two tests closed their files only when garbage-collected, which printed "Exception ignored … ResourceWarning" in the Python suite. They use `with open(...)` now, and `TestNoUnclosedFiles` fails on any `open(...).read()` or `.write()` one-liner in the repo (it fails before).
- **Release review fixes:**
  - **Closing the page after Clear all deleted only one question.** The deletes ran one after another, and on `pagehide` only the first started before the page unloaded. They all start at once now, and the page going hidden commits pending removals too (a phone may discard a background tab without `pagehide`), never twice. Test: `savedQuestions` Q10 (fails on the release candidate).
  - **`TestNoUnclosedFiles` passed vacuously in a checkout under `.claude/`** (Claude Code worktrees): it skipped any folder whose full path held ".claude", and `.github` with ".git". It skips folders by their name inside the repo now, and it also finds a one-liner the formatter wrapped across lines. Test: `test_scanner_finds_planted_files_under_a_claude_path` (fails before).
  - **The fifth tab hid "Views" on phones.** The tab bar was 505 px wide, so at 390 px "Views" was off-screen with no hint. Under 560 px the five tabs share the width, smaller, with "Ask" for "Ask Claude" (its accessible name stays "Ask Claude"), and are still 43 px tall. Test: `byDay` BD9, which also checks a wide fallback font (fails before).
  - **By day could say "once the chat data loads" forever.** With no database it now says the digests can't load in this view (as the page's header does), and when the digests listener fails, "Couldn't load the day digests. Reload the page to try again." BD5 checks the exact text. The test stand-in's listeners can now fail (`snapFail`). Test: `byDay` BD5 and BD10 (both fail before).

### Changed
- **R9 closed:** the owner's 31 posted replies (8 to multi-word names) all passed the "Replying to …" bar check live.
- **Backlog:** F21, F23, F24, F26, C8 and R9 removed; F27 filed (more digest views: in the Messages day headers, a week as a catch-up); an F23 live check added to L1.

## [1.25.1] - 2026-11-14
**Update notices laid out as text again, and the backlog trimmed to open items** (BACKLOG B52, GitHub issue #43). PATCH: a page fix. Page **`PAGE_VERSION` 3.0** (from 2.9); helper unchanged (2.1).

### Fixed
- **Update notices (B52, #43).** Each notice's text was wrapped in a span with the class `msg`, the message row's grid, so the text was squeezed into a narrow first column and the link into the second. It has its own class now (`upd-msg`). Test: page `notices` U24.
- **False "older copy of the skill" notice (B52, #43).** `references/database.md` showed `versions.refresh` without the weekday that `lastRefresh` has, and a refresh that copied that shape raised notice C. The example now has the weekday, and the page compares the two without a leading weekday. Test: page `notices` U25. U24 and the first two U25 checks fail on 2.9.

### Changed
- **Backlog: open items only.** Finished items were removed from `docs/BACKLOG.md`; this file keeps their history by ID. Checks left open inside finished items (R6, F5, F6, B41, B49, F13) are gathered into a new item, L1. R3 and R10 are kept as their open remainders. New items: R19 (Claude's maintenance writes hold the run lock through slow approvals), B52, F25 (catch up with Facebook group posts too). Updated: R13 (corrected photo counts, the option to reuse a stored copy by fingerprint) and R12 (a scheduled chain seems to keep the skill version it started with).
- **CLAUDE.md, the owner's rules:** a backlog review includes the GitHub issues, every open issue gets triaged (onto the backlog or closed as won't do), and the PR that finishes an item removes it from the backlog and closes its issues. The PR template asks for it.
- **`AGENTS.md`** points other coding agents to CLAUDE.md.

## [1.25.0] - 2026-11-14
**Long histories: older messages a day at a time, per-day digests, Look deeper, and range summaries of any length** (BACKLOG F15 and R4, F16, F17, F18, R10). MINOR: new page features and refresh procedure changes. Page **`PAGE_VERSION` 2.9** (from 2.8); helper unchanged (2.1). No re-setup: Claude republishes your page on its next refresh.

### Added
- **"Show older messages" loads a day at a time (F15, closes R4).**
  - It starts with the catch-up window and the day before it. Scrolling near the top loads one more day, and the message you're reading stays put, like Messenger.
  - **Speed:** it used to draw every stored message at once (25,000 rows at 25,000 messages); now about 1,700, and about 460 per step.
  - **Jumps:** jumping to an older message (links, "Show #n", Ask citations) loads that message's day.
  - **Other cases:**
    - A date range with an end loads newer days at the bottom.
    - The top reads "Start of stored history" at the first message.
    - With Show older on, the Messages toolbar stays under the tabs.
    - A run of bubbles across midnight shows as one block, whether its day loaded by scrolling or with the page.
- **Per-day digests (F16).**
  - **Writing:** each refresh writes a few bullets for each finished day, citing that day's messages, stored one document per month (`digests/m<YYYY-MM>`; only `catchup.py` writes them). At most 3 days per refresh, oldest first. A day is digested at most twice: `final` is set when a later day was already stored.
  - **Ask:** older history uses digests in place of the title-only day lines where a day has one. The prompt, the note under the answer ("Day digests for N days (…)") and `sent.digests` say when they were used.
  - **`catchup.py`:** a `digests` spec key with its checks (finished days only, refs from that day, caps, no control characters, `RUN/digests/` required), and the commands `days`, `digests` and `check-digests`.
  - **New `references/digests.md`:**
    - A one-time backfill, run only on request, in batches that are bounded, backed up and checked after each, and resumable.
    - It takes the run lock just before each write; 2–3 batches per session.
- **Look deeper (F17).** Under an Ask answer that rested partly on summaries, a Look deeper button makes two plain requests:
  1. Claude names the stretches it needs, which are checked, clamped to stored messages and limited to 3.
  2. The page sends them word for word with the question.

  It retries once on `prompt_too_large`, and Stop cancels it. It's saved in `qa/*` with `scope:"deeper"` and `sent:{from,to,stretches,wanted}`.
- **Range summaries of any length (F18).** A span too long for one request is no longer refused. It is read in as many parts as it needs, with "Writing part n of N" and Stop, then merged.
  - **Condensing:** merges from more than 4 parts, or over 64 KB, are condensed by one more request per batch of conversations. They're always saved under the 256 KiB document limit, and a failed save is shown with "Save it again".
  - **Across parts:** later parts can answer earlier parts' open questions.
  - **Never partial:** nothing is saved until every part is done, and "Write the rest" carries on.
  - **New messages during a run:** a run whose window gains new messages is shown with Stop, and the window then uses that summary and says how far it covers.

### Changed
- **The page names the Claude Desktop app (R10).** "Your computer has to be online" now says to keep it open, signed in to the same account, as setup and the README say: Claude in Chrome needs it when a refresh runs from claude.ai, the phone, Cowork or a schedule. The README now names Cowork too. Whether a claude.ai tab in the same Chrome needs it is still unchecked live.
- **Which links answer a question:** only `r`, `rq`, `rg` or `i` links from someone other than the asker count. A "same person continuing" link no longer closes a question.
- **Refresh skill:** `SKILL.md` 18,747 bytes. Step 5 lists `digests`, step 6 runs `catchup.py days`, plus a pointer to the backfill. `references/database.md` (and setup's copy) documents digests, the `deeper` scope and its `sent` shape, `parts` and `condensed`.
- **Tests:**
  - Page sections `olderByDay` (O1–O11), `digests` (D1–D6), `deeper` (D1–D8), `deeperBudget` (D9), `longRanges` (L1–L8) and `longRanges2` (L9–L12).
  - `TestDigests` in `test_catchup.py` and `test_tools.py`.

### Review
- An independent review of the release and a separate adversarial review of the digests found real defects, all fixed before merge, each with a test that fails without the fix. A mutation run then confirmed the tests catch each rule:
  - a long range summary could be shown but silently not saved (over 256 KiB);
  - a refresh during a long run left the button doing nothing;
  - questions answered in a later part stayed open;
  - a day was re-digested every hour when the chat's time zone was ahead of the browser's;
  - a refused backfill write ended the backfill;
  - room held for digests that didn't fit cost Ask its conversation lines;
  - special conversation ids from a model reply crashed a part.
- Filed: F24 (optional views of the digests, such as "By day").

## [1.24.0] - 2026-11-13
**The schedule and deal claims on the page, and photos that are retried and keep their slots** (BACKLOG F14, F19's display, F22, R15, R16). MINOR: new page features and refresh procedure changes. Page **`PAGE_VERSION` 2.8** (from 2.7), helper **2.1** (from 2.0). No re-setup: Claude republishes your page on its next refresh, and installed helpers (1.5+) update themselves from this release.

### Added
- **The schedule on the page (F14).** Under the status line, in the schedule's time zone (labelled when it isn't the browser's), from `meta/chat.schedule`, `refresh/schedule` and `refresh/status`, updated live and as time passes:
  - a summary ("Hourly, 7 AM–11 PM"; a manual schedule reads "Refreshes only when you ask");
  - "Next refresh about …" from `nextAt`, left out when it falls outside the chosen hours;
  - a calm line when scheduled refreshes have stopped, saying to ask Claude for a refresh, which offers to restart them. A chain with no `refresh/schedule` document counts as stopped;
  - a `problem` on its own says Claude reports it on the next refresh you ask for;
  - "The last N scheduled runs couldn't reach Chrome" once a chain's `misses` reaches 2.
- **Claims on the deal card (F19's display).** A deal with `claims` shows "Claimed: Ben, Cy (2), Dee", first come first, with each name opening its message (in the card, or in Messages when it's in another conversation). Names follow the page's people mapping; bad entries are skipped.
- **A deal's status (F22).** "Sold" or "Pending" shows beside the deal, linking to `statusAt`, and replaces the tag in the card's header chip. A claim made after it reads "(after it was sold)" or "(after pending)". Other status values are ignored.
- **Failed photos are retried (R15).** A photo the helper couldn't get (the fetch failed, or the image never loaded during the scan) is now owed like any other, and the next refreshes try it again. Each run that reaches its message without getting it counts one try (`tries` in its block). After 3 runs the page gives it up as `{e:"no-fetch"}`, listed in `gaveUp` and in the report. Photos still being tried are in `refresh/lastImport.retry`.
- **Photos keep their slots (R16):**
  - **Messenger photo ids:** each photo carries Messenger's attachment id (`aid`). The page records it with each new slot and matches by it first, so a photo is never stored twice or in another photo's slot. Photos stored before keep matching by position: no migration.
  - **A content hash for unstable ids:** each slot also keeps the start of the photo's SHA-256 (`h`). A photo whose id changed is found by it, its slot takes the new id, and it isn't uploaded again.
  - **Shared ids:** when photos of one message share an id, the helper drops that message's ids (matching by position, as before 2.1) and the scan warns.
  - **A skip list:** on a backfill Claude passes `skip` to `full` with the photos the page already holds (`photos.md` › Backfill), and the helper doesn't fetch or encode them. A skip naming a slot the page doesn't hold stored is owed again, counted as a try and listed in `refresh/lastImport.skipOwed`.
  - **Skeleton and lazy images keep their slots:** a message's photos are numbered by their photo links in page order, loaded or not, so an image that hasn't loaded (or a placeholder box) keeps its slot and is listed as unloaded, instead of shifting the photos after it.
  - **Per-tile merge:** two reads of a message merge tile by tile (a loaded photo over a GIF or other image over an unloaded tile), so a GIF read before its still loaded leaves no phantom photo, and one loaded read beats unloaded tiles that don't line up.
  - **Run ids:** the capture carries the run id given to `full`, so a failed photo counts once per refresh run, even when the paste is repeated after step 7 or two runs fall in the same minute (falling back to `meta/chat.lastRefresh` for captures without one).

### Changed
- **Helper 2.1:** each photo gains `aid`; the capture gains `phfail` (photos it couldn't get: `{i, k, aid, e}`), `phskip` (photos it skipped) and `run`; `full` takes `skip` and `topMs` (a test option that shortens the 12 s top-of-chat wait). The capture summary adds `FAILED #…` and `skipped n`. An older helper ignores `skip`, and its captures still import as before.
- **Page 2.8:** photo blocks (`photos/b<start>`) gain `aids`, `tries` and `h`; `refresh/lastImport` gains `retry` and `skipOwed`. The page reads `refresh/schedule` by name.
- Refresh skill: step 4 keeps the page tab open for photos or `FAILED` (`SKILL.md` 18,508 bytes). `references/photos.md` covers failed photos, the tries, `no-fetch` and the skip list; `references/helper.md`, `references/database.md` (and setup's copies), ARCHITECTURE and BACKLOG follow.
- Tests: page sections `schedule`, `claims` and `photoKeys` (K1–K14); sim cases H1–H9 in four `sim(...)` cases (`SIM_ONLY=H`), with new mock modes (`lazy`, `skeleton`, `sharedaid`).

### Review
- An independent review of the release and a separate adversarial review of the photo changes found real defects, all fixed before merge, each with a test that fails without the fix:
  - a problem alone offered a restart meant for a stopped chain; "00:00–24:00" didn't read as all day; a chain with no schedule state didn't show as stopped; a next run outside the hours was shown, and the zone label could be wrong across daylight saving; a sold or pending deal's chip kept its tag;
  - a photo whose Messenger id changed opened a new slot and was uploaded again (now the content hash);
  - photos sharing one id kept only the first;
  - a placeholder box shifted the slots after it, and a GIF read before its still loaded left a phantom unloaded photo;
  - a skip naming an owed slot was taken as stored;
  - a repeated paste, or two runs in the same minute, could count a try twice or once.
- In a mutation run of the photo rules, 15 of 16 changes to the page's slot and try rules and all 8 to the helper's tile code were caught; the remaining one changed nothing, so that code was removed.
- R10 (the page's requirements don't mention the Claude Desktop app) stays open: its page wording follows in a later release.
- Filed F23: a Messenger reply mid-conversation to a message in another conversation shows no "replying to…" line.

## [1.23.0] - 2026-11-13
**Claims in buy/sell chats, moving a message to another conversation, scheduled runs that survive a crash, and a test suite 8× faster** (BACKLOG F19, F20, R14, T6; GitHub issue #41). MINOR: refresh procedure changes and new spec keys. Page and helper unchanged (`PAGE_VERSION` 2.7, helper 2.0).

### Added
- **Short reactions and claims (F19, issue #41).** In a chat whose `meta/chat.topic` or name suggests buying, selling or trading, `catchup.py build` flags short messages like "In", "In!!", "in for 2", "In x2", "Dibs", "Mine", "I'll take it", "Sold", "PM'd", "DM sent" and "Interested" with a `REACT?` line. The line lists up to 3 posts by someone else from the 3 days before: photos and open deals first, then text offers (a price, "let me know if you're interested in…"). Claude reads the context and links the message to the post it reacts to (`references/writing-the-build.md` › Claims):
  - **For sale:** it's a claim, with a bullet ("Ben is in for 2") and an entry in the deal's new `claims: [{i, who, n}]`.
  - **Not for sale:** it's appreciation, with a short bullet ("Ben and Cy liked it").
  - **Raffle posts** are marked "(raffle)". Spot claims keep today's threading and get no `claims` entry.
- **The seller's own "Sold", "SPF" or "pending"** (with a short tail such as "Sold to Ben") prints `CLOSE?`. The deal records `status` (`sold`/`pending`) and `statusAt`, and later claims are noted "after it was sold".
- **`dealEdit` gains `addClaims`, `removeClaims`, `status`/`statusAt` (always together) and `ref`** (names a deal by one of its messages). It refuses keys it doesn't know.
- **Setup asks what the chat is about** and stores it as `topic`. A refresh on a page without one sets it once (› The chat's topic).
- **`move` (F20, issue #41).** `move: {"<i>": "<conv id>" | "new"}` puts an already-built message into another conversation, in a build or with `catchup.py relink`:
  - **What moves:** its Messenger replies (`r`/`rq`/`rg`) move with it. Messages linked by a guess stay, re-pointed to its old parent, and are printed as `LEFT` lines so Claude can move the ones that belong with it.
  - **An emptied conversation is dropped,** and its bullets, key, questions, answers and deals go to the target. The `DROP` line prints its title, tag and outcome.
  - **Who uses it:** Claude, when it spots an earlier misfile, and the user, on request ("move #3232 into the bag-sale conversation").
  - **Undo:** `restore WORK` undoes a move until its write lands. After that, the undo is a reverse move.

### Changed
- **Scheduled chains arm early (R14).** A chain run arms the next run right after its stale and hours checks, before refreshing, so a run that dies midway no longer stops the schedule. The run's end only records whether Chrome was reached (`misses`), and only while it still owns the chain. Runs start `every` minus 3 minutes apart (about 57 minutes for hourly), counted from each run's start, so the prompt cache stays warm. An early arm stuck on an approval holds up that refresh; only runs with the user present can meet one.
- **The refresh skill's `SKILL.md` is smaller** (19,847 → 18,496 bytes, with room for what's next). The helper commands, the install link, `DATES-GUESSED`, rare troubleshooting paths and `catchup.py`'s checks moved to `references/helper.md`, `references/troubleshooting.md` and `references/writing-the-build.md`. SKILL.md says where and when to read each.
- **Both `current` documents (threading and summary) share a `rev` per write.** Bootstrap catches a write that only partly landed (below), and a stale WORK is refused even within the same minute. `restore-summary` also writes `threading/current`, but only its `rev` changes.
- **A write that partly landed never leaves a page stuck.** When the two `current` documents come from different writes but still fit together, bootstrap carries on and the next write restamps both. When they don't fit, `catchup.py bootstrap --rollback` files every summary item under the conversation threading has its messages in, dropping nothing, and `relink` with the spec `{}` writes it. The restore procedure now pins `threading/current` too, and `dealEdit` refuses `index` on any conversation a move changed (`ref` instead).
- **Tests run in parallel (T6):** `npm test` takes about 1.5 minutes instead of 12.
  - The sim's 42 cases each run in their own browser context (`SIM_JOBS`), and the page sections each run in their own process (`PAGE_JOBS`).
  - The Python suites run beside the sim.
  - The same 480 checks run, each case's lines print together, and a failure still fails the run.

### Fixed
- A refresh that finds nothing new again builds messages an earlier run imported but didn't build, even when the conversation reuses its working folder without bootstrapping. The SKILL.md trim had briefly narrowed this condition; caught in review.

### Review
- An independent review of the release and a separate adversarial review of `move` found real defects, all fixed before merge, each with a test that fails without the fix:
  - a move followed guessed links and dragged the rest of a conversation along;
  - a partly applied move went undetected;
  - a `dealEdit` index could mark the wrong deal sold after a move;
  - the claims gate depended on a field setup never filled;
  - raffle spots were flagged as claims;
  - there was no way to correct a claim;
  - common closing phrasings were missed;
  - the cadence ran 5 minutes early.
- Filed: R18 (a run still going when the next one fires), F21 (a standalone move takes no bullets), F22 (the page showing a deal's status; built in 1.24.0) and C8 (`tools/sync.py` leaves files open).

## [1.22.0] - 2026-11-12
**Photos stored as they upload, Ask Claude over long histories, and update notices** (BACKLOG R2, F6 and R4, F5; B50). MINOR: new page behavior and refresh procedure changes. Page **`PAGE_VERSION` 2.7** (from 2.6); the helper stays 2.0. No re-setup: Claude republishes your page on its next refresh.

### Added
- **Photos are stored as they upload (R2).** After the messages are saved, the page uploads photos one at a time and indexes each one the moment it lands, so a page tab closed mid-upload loses at most the photo in flight. What's left is recorded as owed (a `null` slot, counted in `meta/chat.photosOwed` `{n, fromI, toI, at}`), and a re-paste uploads only that. Photos stay the original files.
- **`refresh/lastImport` shows progress:** `state:"uploading"` with a heartbeat (`beat`, every 10 s, which also renews a 60 s import lease) and `photos.done` of `photos.todo`, then `done` or `partial` with a `stop` code (`rate_limited`, `unavailable`, `timeout`, `lease`, `index`, `auth`, `quota`, `no_assets`), or `refused`/`failed`. New fields: `photos`, `stored` `[{i,k,id}]`, `owed`, `gaveUp`, `usage`, `backfill`. The toast says "Storing photos n/N… keep this tab open", and a second paste meanwhile says "Still storing photos from the last paste" and changes nothing.
- **Backfill:** the next refresh picks owed photos up by itself, scanning from just before the first one, up to 300 messages behind the newest (an existing `full{stops, base}` scan; no helper change). The page gives up on owed photos older than that and the message and `gaveUp` report them.
- **Photo storage:** each import records the page's asset usage (`refresh/lastImport.usage`, `meta/chat.assetUsage`: files and bytes against claude.ai's 5,000 files and 1 GiB). From 80% of either the page shows a calm warning under the status line (also from a fresh listing when it opens) and the toast repeats it; Claude's report says it too.
- **`references/photos.md`** (refresh skill): Waiting (read `refresh/lastImport`, wait while the heartbeat moves, at most 10 minutes; stall = two of Claude's reads at least 60 s apart with the same beat; never close the page tab while uploads run; a rule for every `state` and `stop`), Backfill, Looking (every new photo is still opened, from the `stored` lists), Storage, and Cleanup: only when the user asks, it lists files no photo document references and copies of stored photos (same SHA-256), reports the counts, deletes only after the user confirms, and never deletes a file any `photos` document references.
- **Ask Claude over long histories (BACKLOG F6; R4 is now done).** Ask, Views and range summaries share one prompt budget, measured in UTF-8 bytes against the runtime's own cap (`sample.limits().maxPromptBytes`, never more than 262,144; 262,144 when `limits` is missing, fails, hangs past a second or answers nonsense), less a 4 KiB margin. What doesn't fit word for word goes in as **older history**: one line per conversation, newest first (its outcome from the summary, from a range summary the page wrote, or "no summary; N messages from …"), then one line per day ("[#a–#b, Oct 3] 460 messages. Busiest: …") for everything the conversation lines leave out, back to the first stored message: every older message is in a day line or its own conversation's line. Every line starts with the stored messages it covers, so a citation of any number opens that message. With "include older" checked, summaries take up to 35% of the prompt (20% otherwise), and what they don't need goes back to messages. If even the day lines don't fit, the prompt says "Nothing before #N is included."
- **A note under each answer and built view** says what Claude read: "Read #6850–#6999 word for word.", "Read #5432–#6999 word for word (Nov 8–12). Older than #5432: summaries only." or "Your window has 3,200 messages: read the newest 1,853 word for word (#5147–#6999), the rest as summaries." `qa/*` and `views/*` save it as `sent: {from, to, sumFrom, afterFrom}` (where older and newer summaries start), so a later Claude reading them knows when an answer rested on summaries. Earlier questions and saved views show it.
- `npm run test:perf` (`tests/perf.js`, not in `npm test` or CI) prints render and Ask timings at 6,400, 25,000 and 50,000 synthetic messages (EXPERIMENTS.md §14): an "include older" Ask packs in under 25 ms at 50,000.
- **"Update available" notices on the page (BACKLOG F5).** The page can't see the helper (it lives in the facebook.com tab) and can't fetch GitHub releases, so Claude now writes **`meta/chat.versions`** with every `lastRefresh`: `page` and `helper` (what that refresh's skill ships), `refresh` (a copy of `lastRefresh`) and `browsers` (one entry per Chrome, by its name: the helper read there, or `"none"` when Claude injected it, and when). The page compares it with its own `PAGE_VERSION` and `pageVersion` and shows at most one calm line per issue under the status line, each with Dismiss:
  - this tab is an older copy of the page (reload it);
  - a newer page is waiting (the last republish didn't land; Claude puts it in place on the next refresh);
  - an older copy of the skill ran the last refresh: it wrote a lower `versions.page`, or `lastRefresh` without `versions` (any copy from before this release, such as an uploaded skill or an old scheduled task); update the plugin (claude.ai or Claude Desktop: Customize › Plugins; Claude Code: `/plugin`) and remove uploaded copies. Not shown while a refresh is running;
  - a Chrome ran a helper below 1.5, which can't update itself (install once from the link); for a Chrome that didn't run the last refresh, the line says the day it was last used;
  - the Chrome of the last refresh ran a self-updating helper (1.5+) that is behind the release, flagged right away (not for a Chrome used before, which has most likely updated itself since).
  - `"Chrome"`, the key a run with no browser name writes, counts only while it's the newest entry, so one browser never gets two lines.
  - Chromes not used for a refresh in 30 days are left out; `"none"` and versions it can't read show nothing.
  - Dismissals stay in that browser's `localStorage`, keyed to the version that would fix it, so the next release brings the notice back; with storage blocked, Dismiss works for that page load. The page writes nothing to the database.

### Changed
- **`photos/index` is split into 500-message block documents `photos/b<start>`** (`byK[i][k]` = `/_blob/<id>`, `null` owed, or `{e}` given up; `gifs`). The old `photos/index` is read, merged under the blocks, and never written again, so nothing needs migrating, and it can no longer outgrow the 256 KiB cap (a block of 500 messages with 4 photos each is about 96 KB).
- **Each upload error code has its own handling:** only `store_unavailable` retries once (`upstream_error`, which includes an unanswered call, `transform_error` and unknown codes stop with "paste again": a retry could store a photo twice); `rate_limited` waits 30 s and retries once, then says "wait 2 minutes, then paste again"; `too_large`, `unsupported_type` and `invalid_request` give that photo up and go on; `quota_or_state` says the page's storage is full (with the usage) or the page is unpublished or being deleted, and never "paste again"; `upstream_auth` says to reload; a hung upload times out after 90 s and its late answer is ignored. Before, the page stopped at the first failure and always said "paste again".
- SKILL.md (refresh): step 3 points at `photos.md` › Backfill when `meta/chat.photosOwed` is set; step 4 says never to close the page tab until `photos.md` › Waiting says so; step 5 closes it unless Waiting says to leave it open, no longer fetches `photos/index`, and looks at photos by `photos.md` › Looking. The database line reads `photos/*`. `troubleshooting.md` › Import toasts sends every photo toast to `photos.md` and now has entries for the refusals ("Nothing saved."), "Import failed: …" and the read-back failure. `references/database.md` documents `photos/b<start>`, the old `photos/index`, `meta/chat.photosOwed`, `meta/chat.assetUsage` and every `refresh/lastImport` field.
- Docs: BACKLOG (R2 done; R13 filed: the 5,000-file limit, the owner's page at 715 files and about 55 a day; R15 filed: photos the helper couldn't fetch aren't recorded as owed; R16 filed: backfill captures can shift a photo's slot and fetch every photo again), ARCHITECTURE, DECISIONS, LEARNINGS, EXPERIMENTS §15, STATUS.
- **"Include older messages" works at any size.** It sent every stored message and failed past about 2,100 messages ("Too much chat to send at once. Uncheck older messages."), as did a window of 3 or more days and Views on it. The prompt now says which numbers are word for word and which are summaries, and asks Claude to say when a point comes from a summary and which messages to open. The checkbox reads "(newest word for word, older as summaries)", and the Ask header says Claude reads as much as fits.
- **Chat turns** sent with a question: the last 9 at most, the oldest pairs dropped while they take more than a quarter of the cap; the instructions always stay. A question over half the cap isn't sent: "That question is too long to send. Shorten it."
- **On `prompt_too_large`** (nothing was sent), Ask and Views retry once with 80% of the bytes just sent, and the note adds "(sent a smaller set: the first was too large)". A second refusal says "Too much to send at once, even trimmed. Tell Claude in chat if this repeats."
- **A range summary too long for one request** (a date range before `summary.fromI`) is refused before any call, with no button: "This span has 2,800 messages, more than Claude can read at once (about 1,990 fit). Pick a shorter span: from Mon Oct 27, 3:10 PM through the same end fits."
- `references/database.md` (and setup's copy): a line for `sent` on `qa/*` and `views/*`. No change to `SKILL.md` or `catchup.py`.
- BACKLOG: F6 and R4 done; deferred with their triggers: F15 (page "Show older messages" by day), F16 (per-day digests written during refresh), F17 (a two-step or tool-using Ask), F18 (splitting long range summaries).
- **The page-version check goes both ways.** SKILL.md sends Claude to `references/updating-the-page.md` whenever `pageVersion` differs from the skill's `PAGE_VERSION`. Older: republish as before, now writing `{pageVersion, versions:{page}}` in one update. Newer (this copy of the skill is older than the one that published the page): never republish or lower `pageVersion`, and say in the report, scheduled runs included, to update the plugin. With the same major it carries on with the run; with a newer major it stops before taking the lock and writes nothing. Setup's reuse of an existing page also writes `{pageVersion, versions:{page}}` in one pinned update.
- **`catchup.py` refuses a threading or summary `layout` it doesn't know** (bootstrap, and the RUN reads of build, relink and restore-summary): "threading/current has layout 3, which this catchup.py doesn't know: a newer copy of the skill wrote it". Before, anything but 2 was read as the old single document, so an older copy could have misread a newer layout and rewritten `current`. `troubleshooting.md` says what to do.
- `references/database.md` (and setup's copy): `meta/chat.versions` on its own line, and a new Versions section with every key and when to write it. `references/helper.md`: the browser and helper named in the report also go into `versions.browsers`. `troubleshooting.md` and `catchup.py`'s "nothing left to build" message write `{lastRefresh, versions}`.
- `SKILL.md` stays under its cap at 19,847 bytes (19,771 in v1.21.0): the `meta/chat` line lists `versions` among the fields a refresh writes, the nothing-new path writes `{lastRefresh, versions}` and step 7 `{lastRefresh, coverage, versions}` (`references/database.md` › Versions) (+61 in all), the database line reads `photos/*` (+2), and step 5 leaves the page tab open when `photos.md` says so (+15).
- **Review of PR #42 (photos):** a page tab that lost its import lease to another tab writes nothing more: photos are indexed slot by slot (`update`, never a whole stale block), a refused block write renews the lease before its retry, and its heartbeat and closing `refresh/lastImport` stop. Photos upload oldest first. One import at a time per tab, from a paste or the Import button. A failed `meta/chat.photosOwed` write no longer turns a saved import into "Import failed". Owed photos on messages #0–#2, which no backfill scan can reach, are given up (`e:"no-backfill"`) and reported. The "Another import is running" time is to the second. The page's "older copy of the skill" notice and `updating-the-page.md`'s older-copy section say new photos aren't stored or seen until the plugin is updated. `photos.md`: a paste is matched by `sha` and `at`, and Cleanup isn't blocked by a dead tab's `uploading` record. Setup no longer seeds `photos/index`.

### Fixed
- **A built view's reply could pose as a method idea (B51).** The model's JSON was saved as `{kind:"view", ...v}`, so a reply with `kind:"idea"` became a method idea, which Claude acts on after each refresh. `kind` is now set last.
- **`troubleshooting.md` said the skill's version is in `VERSION`, "shipped with it" (B50).** `VERSION` is at the repo root, outside the plugin; the line now names what the skill can read (`PAGE_VERSION`, the helper's `@version`).

### Tests
- Page section `photos` (P1–P20 and the usage checks, plus a refused block write and a lab capture): the first record is `uploading`; mid-upload every landed photo is indexed and the rest owed; heartbeats rise during one slow upload and the lease moves; a tab closed after 4 uploads, then a new tab on the same store: "Another import is running" until the lease lapses, then exactly the 6 owed photos upload with no duplicate hash; a second paste; a stolen lease writes nothing more; `rate_limited` and `store_unavailable` once and twice; storage full; `too_large`; a hung upload; photos on #499 and #500 in two blocks, shown, with a live block change; the old index read (byI+byK, byI only) and never written; a full block's size; an old index near the cap (2.6 failed: "Import failed: photos/index is 262159 bytes"); the 300-message give-up; the sim's backfill and multi-photo captures; dry-run counts; no assets; usage recorded and the 80% warning by files and by bytes. `bigPaste` (P23): a 26 MB capture through a real clipboard and keystroke, 200 photos stored. Run against page 2.6 with `PAGE_FILE`, every case of new behavior fails there; only P15a/b (old index still read) passes on both.
- `standIn`: uploads scripted per call (`window.__up`: a code, a hang that answers late, a file or byte quota), 32-hex ids and a SHA-256 per upload, `list()` with usage, `delete()`, `__rt.steal()`, leases seeded from another tab, `__mcImportTune`; `paste()` now waits for a finished import and `pasteFirst()` returns the first record. Existing photo tests (first import, B17, B28, B37, the pipeline's photo #30) read the blocks.
- Sim section G: the backfill scan from before an owed photo (window #30–#54, ids line up, photo included, verify ok) and `mock_photos=N` (messages with 1–3 photos, every slot right); it writes `tests/out/sim_cap_photos.json` for P18.
- Review of PR #42, each failing on the integrated page before its fix: `review 1` (a tab whose refused block write is retried after another tab took the lease never writes its stale block over that tab's slot; slots and GIFs another writer adds survive), P8 (no heartbeat or closing `refresh/lastImport` after the lease is lost), `review 4` (a refused `photosOwed` write), `review 6` (`upstream_error` and `transform_error` not retried), `review 7` (a paste during an Import-button run), `review 8` (oldest first; `no-backfill`), P5 (the lease's time to the second; the photo in flight answers late and is the only one stored twice), P11 (the `quota_or_state` wording), `review 12` (a capture's own owed photo isn't given up). `TestPhotos` adds `test_only_store_unavailable_is_retried`, `test_waiting_and_cleanup_never_trust_a_dead_tabs_record`, `test_every_import_toast_has_a_rule`, `test_an_older_skill_says_photos_wont_be_stored`, `test_setup_seeds_no_photo_index`, and checks the `no-backfill` rule; the stand-in's injected failures can let the first n writes through (`after`).
- `TestPhotos` (tests/test_tools.py): steps 3–5 point at `photos.md`; every `state` and `stop` the page writes has a rule there; the stall (60 s) is at least 3 heartbeats and the lease, and the 10-minute wait exceeds one upload's timeout; the backfill uses the page's 300-message window; every new photo is opened; the cleanup is only on request and never deletes a referenced file; `database.md` documents the photo documents and the page never writes `photos/index`. The `meta/chat` field check also reads `- \`meta/chat.<field>\`` lines.
- New page section `history` (H1–H16): counted reads per render in every marker mode and the 4×-messages ratio (H1), each conversation scanned at most 3 times (H2), the window memo against a count from scratch through marker moves, Mark caught up, a new chunk and own mode (H3); a window that fits is sent whole with the note "Read #a–#b word for word." (H4); "include older" at a 32 KiB cap: one call within the cap, word for word one run ending at the newest, the same cut in the prompt, the note and `qa.sent`, every older message inside some summary line, lines oldest first (H5); window-only Ask and Views on a 700-message window (H6); day lines that count their day and "Nothing before #N" at 9 KiB (H7); every source of a conversation line and the stretch before `fromI` and before threading began, with duplicate range summaries giving one line (H8); turns trimmed and a 40 KiB question never sent (H9); emoji and CJK counted in bytes (H10); `limits()` missing, rejecting or nonsense, and a smaller cap (H11); one retry and never a third call (H12); a citation into the summaries opens the message with older messages on (H13); `sent` saved and listed, old rows still render (H14); a 600-message range summary refused, and the start it suggests fits (H15); 25,000 messages packed within the cap, with `lineFor` called once per line sent plus one and about 1.1 reads of `S.msgs` per message (H16; 50,000 too with `PERF=1`). H4–H16 fail on page 2.6; H1–H3 guard 1.20.1's fix.
- `history`, from the PR review: every older message is in a day line or its own conversation's line, checked by membership with conversations that share blocks and one running #50–#1900 (H5, H5b); no line or Key number reaches into the word-for-word part; an ungrouped run's dates (H7b); a long view request, a prompt with no room for messages, and a double click send nothing (H9b); emoji cut whole (H10b); `limits()` at 1e9, at 100 or never answering, and a retry smaller than what was sent (H11b, H12b); newer summaries saved as `afterFrom`, kept to 10% of the prompt, and "after your catch-up window" (H14b, H13b); B51. Each fails on the page before the fixes.
- `tests/synth.py page` takes `--from-i K` and `--range-summary LO HI`; existing callers are unchanged. `pipeline`'s Ask check follows the new `MESSAGES (oldest first):` heading. `test_tools`: database.md documents `sent` on its own line, and the page saves it.
- New page section `notices` (U1–U20): each notice and its wording, number-by-number comparison (10.0 > 2.x, "2.7.0" = "2.7"), the running-refresh rule (hidden while running, back without a reload when done or stale), the 30-day window, unreadable or malformed versions, the fixed order, Dismiss (writes nothing, survives a reload, returns when the version changes), `localStorage` blocked, live updates, a browser name with markup shown as text, phone width (390 px), dark mode tokens, no database, and the last release's page reading data that has `versions`. The tests read `PAGE_VERSION` from the page. 41 of the section's 42 checks fail on page 2.6; the 42nd is the backward-compatibility check, which runs the old page itself. The stand-in runtime gains a `noDb` switch.
- `test_tools.TestUpdateNotice`: every `versions` key the page reads is documented in `database.md` › Versions (and its 30-day window), `lastRefresh` is always written with `versions`, the page-version check goes both ways, the self-update threshold (1.5) matches `helper.md` and the changelog's first helper with `@updateURL`, one install URL in the page, `helper.md` records the browser, and the page never writes `versions`. `test_catchup`: bootstrap ignores `versions`.

## [1.21.0] - 2026-11-12
**Scheduling without hard-coded tool names, and only ever one schedule** (BACKLOG R6). MINOR: setup and refresh procedure changes. Page and helper unchanged (`PAGE_VERSION` 2.5, helper 2.0). No re-setup: an existing schedule (`mode` `"A"`, `"B"`, `"loop"` or any other older value) keeps running exactly as its own prompt says until the user switches it from a refresh they type. A page with no stored `schedule` (the first setups stored none) counts as an older chain.

### Added
- New `references/scheduling.md` in the refresh skill (setup carries a copy, kept by `npm run sync`): the scheduling tools by what they do, with the names seen in each Claude app as of November 2026. Claude uses only a tool it can see in its tool list, and it's the only file in the plugin that names one.
- `refresh/schedule` `{armId, nextAt, tool, lastRunAt, misses, problem, switchAskedAt}`: the schedule's live state, in its own document so arming never collides with a build's pinned `meta/chat` writes. Writes create it when it's missing; no `nextAt` means no chain is armed. Setup creates it for every choice.
- **A token in every scheduled message.** Chain follow-ups say `Scheduled catch-up run (chain <armId>)` and recurring prompts `Scheduled catch-up run (recurring <armId>)`. Only the message whose token matches `refresh/schedule.armId` runs. Duplicate, late or superseded deliveries, and tasks left over after a stop or change, stop without doing anything. Arming writes the new token with `if_version` before calling the tool. A refused write is read again, and arming stops only if another session's token is there; otherwise it retries. The token is the UTC time plus 4 random characters. A message is scheduled if it starts "Scheduled catch-up run", names the page URL, `chatUrl` or thread id, or asks to schedule a run (a typed request never contains those). A stale run writes nothing; `lastRunAt` is written only after the stale check, which a refused `lastRunAt` write repeats.
- After a refresh the user typed in the conversation (never a stored prompt or follow-up; not on a first run, and not when the refresh lost the lock): scheduling problems and scheduled runs that couldn't reach Chrome are reported (then cleared). A chain found stopped is restarted from that conversation **only if the user says yes**: now inside the chosen hours, `nextAt` missing or more than 30 minutes past, and no run going. A failed arm clears `nextAt` (only if no newer arm has happened) and says so, so the offer comes right away. A recurring task that has gone quiet since the current window opened is checked. A scheduled run never asks.
- **Older schedules** (before v1.21): `"B"` is a recurring task; `"A"`, `"loop"` or anything else is a chain or loop. So is no stored `schedule`. Their scheduled runs do what their own message says ("reschedule" included), with no conversion and no question; only an explicit `"manual"` makes them stale. The first time the user types a refresh request, Claude explains once that scheduling moved to a new scheme and asks whether to switch; `switchAskedAt` is written once they answer. On yes, Claude cancels the old follow-up, task or cron with a visible tool. A recurring task or cron it can't cancel is deleted by the user first; an old chain switches at once and ends at its next follow-up. Then Claude arms the new chain. Arm's last step sets `mode:"chain"` only for an older or missing mode and only while its token is still current, so it never undoes a stop or change. No restart is ever offered from `lastRefresh`.
- The Claude Code CLI is a supported scheduling surface (one-time `CronCreate` follow-ups), with a warning that the session must stay open.
- Requirements (setup skill and README): the Claude Desktop app must be open on the computer when Claude runs from anywhere else. The page's own wording waits for the next page change (BACKLOG R10).

### Changed
- Setup's Scheduling is a ladder:
  1. A one-time follow-up into this conversation.
  2. Otherwise a recurring task tied to this computer, kept only if the tool's result confirms the tie. If it doesn't, Claude disables it (or asks the user to delete it), stores a new token, and the user creates the task in the app with "Require this computer" on.
  3. Otherwise manual.

  `mode` is `"chain"`, `"recurring"` or `"manual"`. Setup seeds `schedule` as manual until its last step sets the real one, does Stop or change first when re-run on a page that has a schedule, and clears a `problem` a failed choice 1 left.
- A follow-up is armed `every` minus 5 minutes after a run, so it lands while the conversation's cached context is warm. An overnight arm is capped at the tool's longest delay; that run lands outside the hours and arms again. Runs that can't reach Chrome keep the chosen interval (no backoff); runs outside the hours keep `misses` as it is.
- `hours` is `{from, to}` (`"HH:MM"` in `tz`): the start is included and the end excluded. A window can wrap past midnight, a run up to 5 minutes early counts as inside, and no `hours` means all day.
- Setup's "Change or stop the schedule" goes to the new Stop or change step. It sets `mode` and clears the token, so every old follow-up and task goes stale, and it cancels them where a tool allows. A recurring task that can't be cancelled is deleted by the user. An older mode's recurring task or cron is cancelled (or deleted by the user) before a new one starts; an old chain ends at its next follow-up. "Stop scheduled refreshes" replaces "stop the loop" (both work).
- The refresh skill's Scheduled runs section names no tools. It sends Claude to the reference before anything else, Before each run included, and after a refresh the user asked for unless the schedule is manual. Step 1: a scheduled run that loses the lock still reschedules. The Database section names `refresh/schedule`. `SKILL.md` is 19,771 bytes.
- `references/database.md` (and setup's copy): `meta/chat.schedule`'s shape and `refresh/schedule`. The outbox line now says `references/outbox.md` is the refresh skill's, since setup's copy can't open it. `references/first-run.md`: the first run skips the schedule check.

### Removed
- The agent-created `requires_local_device` task that could silently run in the cloud only, and the "if the first run can't reach Chrome, switch to Option A" fallback.

### Tests
- `test_tools.TestScheduling` (34 tests). Each asserts the specific rule in its step: tool names only in the reference; the reference shared with setup and every file a setup copy names present there; tokens in both templates; the stale conditions; the re-read in Arm step 1; the pinned write and the refusal re-read; the mode write after the tool call; failed arms visible; outside hours and the longest delay; no backoff; misses counted, reported and cleared; older runs following their prompt; the older-schedule switch; the dead-chain question; a missing `refresh/schedule`; unique tokens; hours, time formats and the quiet check; Stop or change; the CLI; the Desktop requirement; how a scheduled message is recognized and the typed-request guard; `lastRunAt` only after the stale check; setup re-run stops the old schedule first; a refused lock still reschedules; the reference under 8,500 bytes.
- **Mutation check:** each of 72 key rules was removed or broken, one at a time, in both copies of the reference. In every case a named `TestScheduling` test failed. The list is in PR #39.
## [1.20.1] - 2026-11-12
**Date-range mode no longer stalls the page** (BACKLOG R4, first part). PATCH: a fix with no new behavior. Page **`PAGE_VERSION` 2.6** (from 2.5); the helper stays 2.0.

### Fixed
- **Date-range catch-up mode was quadratic.** `inWin()` worked the window out again for every message and every citation, each time looping over every stored message: 5–6 s per update and about 20 s to load at 6,400 messages, and growing with the square of the history. The window is now worked out once per message list and marker (both are only ever replaced, never changed in place), and conversation lookups by id use a map instead of scanning the list.

### Tests
- New page section `speed`: in date-range mode at 1,500 and 6,000 synthetic messages, a full render works the window out at most twice, and moving the marker still moves the window. Counted, not timed, so it can't flake. On 1.20.0's page the same render worked it out 7,292 and 30,817 times.
- New page section `standIn` checks the test runtime itself. Its `update` now merges nested objects and replaces arrays (and drops `{__delete__: true}` fields), in page writes and in Claude's batches, as the real runtime does; it was a shallow merge. Its `sample` gains `limits()` and enforces the prompt cap in UTF-8 bytes (`prompt_too_large`), with switches for a missing, failing or nonsense `limits()`. The whole suite passes on both.

## [1.20.0] - 2026-11-12
**Helper 2.0: Reply on photo-only messages, warnings instead of silent misreads, full names on every message, and an opt-in `post`** (GitHub issue #32 §1, §2 and §5; BACKLOG R3, B41, B48, B49, F12, F13). MINOR: new helper behavior and skill procedure changes. Helper **2.0** (from 1.9), page **`PAGE_VERSION` 2.5** (its jump bookmarklet is generated from the helper). No re-setup; installed helpers (1.5+) update themselves from this release.

### Added
- **Reply on a photo-only message (B48, #32 §2).** Such a message has no "Reply to this message" button on its hover toolbar. `jump{reply:true}` now opens its **More actions** menu and clicks "Reply", so queued replies to photos post, and the page's Reply links open the box on them too. SKILL.md's allowed clicks name More actions › Reply when posting an approved reply.
- **Opt-in `post` (F13, #32 §1, option B).** `post{mid,to,snip,text,helperPost:true}` posts one queued reply in one bridge call: it opens Reply, checks the "Replying to …" bar against `to` and `snip` and that the box is empty, types the text with shift+Enter between lines (Messenger's editor drops newlines from `insertText`), checks the bar again, presses Enter, and waits up to 15 s for the message. It returns `{sent:true, mid, at}` or a precise error. Only `unconfirmed` means some of the reply may have gone out; every other error means the helper checked that nothing was sent. **Off by default:** it refuses without `helperPost:true`, which Claude passes only when `meta/chat.helperPost` is true, and the user turns that on by asking Claude. No link, URL hash or page can reach it. New `references/posting-with-helper.md` maps every result to the outbox states, following v1.18.0's posting steps: `sending` before; then `sent`, `failed`, or left `sending` for the next run's check. It never starts `post` twice for a row, and a lost result counts as `unconfirmed`. `references/outbox.md` › Posting now points there when `helperPost` is on.
- **Warnings (R3, option B).** `selfcheck` and the scan's result (`warn`, also in `mc_result.warn`) now warn instead of misreading silently: reply links without an "X replied to Y" line; "Original message:" quotes without reply links; photo links with no Facebook image; times going backwards or into the future across the window (catches time-only labels that aren't today; one hour back is allowed for clock changes); one shown name with full names that don't share a first name (two Bens are fine); no full names at all; a page language that isn't English (named; reading continues); a 24-hour clock.
- **Scan results report `top`** (reached the start of the chat) and **`scroller`** (how the list was found).
- **Two connected Chromes (F12, #32 §5).** Step 2 picks by `references/helper.md` › Which Chrome: the one this session uses, otherwise ask the user, recommending the newest helper (Claude in Chrome forbids picking for them); every report names the browser and helper version.
- New `references/helper.md`: which Chrome, helper versions, what each warning means, stalls and `top`, and injecting without the helper (moved out of SKILL.md).

### Changed
- **Full names on every message (B41).** Messenger shows the avatar once per run of messages from one sender; the scan gives each avatar's name to its own group (the messages since the previous avatar), so two people shown alike never borrow each other's. `references/people.md`: each refresh reports when full names aren't captured and while the one-time scan is pending, and the scan runs every refresh until it succeeds, so it starts by itself once the helper is 1.7+. Step 8 also sends Claude there when new messages from others carry no `fn`.
- **A reply whose "X replied to Y" line can't be read is never linked** (`perr:"noreplyline"`); helper 1.9 accepted whatever message took focus. `catchup.py` prints it as `CHECK reply with no readable reply line`, not a GUESS.
- **24-hour times are read** ("17:52", "3 Nov 2026 17:52") and stored as 12-hour `t`, with a warning.
- **The scroller is the nearest scrollable ancestor of a message that holds nearly all of the log's messages**; otherwise helper 1.9's rule (the first scrollable element in the chat log), reported as `scroller`.
- **Stalls (B49, #32 §5).** A scan or verify with nothing new for 30 s returns `err:"stalled"`, or `err:"top-spinner"` when a loading spinner stays at the top (retry once: `references/helper.md`), instead of hanging; the people scan stops too. The top of the chat needs 8 tries and 12 s with nothing loaded and no visible loading spinner outside the messages, so a slow load no longer truncates a first run; a scan with stops that reaches the top says so. SKILL.md notes that the first poll after `full` often fails with "Inspected target navigated", which is expected.
- `references/outbox.md` › Posting: call 1 waits after focusing the box and again before checking it (with Lexical, text typed the instant the box gets focus is dropped, and inserted text shows a moment later).
- `SKILL.md` stays under its cap (19,761 bytes, down from 19,865): the helper version notices and the injection steps moved to `references/helper.md`.
- `references/database.md` (and setup's copy): `meta/chat.helperPost`.

### Tests
- The mock Messenger has a hover toolbar ("Reply to this message", or More actions › Reply on photo-only messages), a composer with a "Replying to …" bar where Enter posts, running **Lexical core** (`lexical` 0.52.0, a new devDependency served by `tests/run.js`) with `@lexical/plain-text`'s commands and Messenger's Enter-sends rule, and modes for each failure: another page language, 24-hour times, time-only labels across midnight, a stalled scan, an inner scroller, a photo link with no image, reworded reply lines, runs with one avatar, a wrong avatar, and a composer that ignores synthetic keys.
- Every sim context now starts at 12:00 today, local time (Playwright's clock; time flows on), so the mock's time-only labels (9:25–11:20 AM) are always in the past, whatever time the tests run.
- Sim section E (warnings in their modes, quiet on the normal mock, the `perr` guard, scroller path and a nested scroller, stalls with and without a spinner, progress bars inside messages, people and verify on a spinner, `top`, full names across runs and two Bens back to back) and F (More actions with a missing or stale menu, `post` refusals that close the reply bar, multi-line posting, a shift+Enter taken as Enter, a bar that moves while typing, a concurrent Reply link, a second post, stage records, synthetic keys ignored, outbox.md's call 1 on an unfocused box, URL hashes can't post), plus A1/A4 checks on `warn` and `top`. New mock modes: `shiftsends`, `nested`, `msgbar`, `stall=stuck`, `noreplymenu`, `stalemenu`, `retarget`, `twobens`, `nofocus`; the reply bar has a cancel button and a click outside a menu closes it. `test_catchup`: `test_noreplyline_is_a_check_not_a_guess`. The key ones fail on helper 1.9. `test_tools.TestHelper2`: the opt-in, every `post` result mapped to an outbox state, only `unconfirmed` may have sent and it's never retried (no Return, no second post, a lost result counts the same), the user's draft is never cleared, no `entered:false` after a key, the jump code never types or sends, the allowed click, stall and navigation notes, browsers and warnings reaching the report, and B41's reporting and retry.

### Review of PR #38
An independent review with experiments against the mock found these before merging. Each has a test that failed before its fix:
- **High: `post` could send part of a reply and then report nothing sent.** When Messenger takes a scripted shift+Enter as Enter, the first line goes out. Now `post` checks after each shift+Enter, says `unconfirmed` with `entered:true` whenever something may be out, and the doc never retries or presses Return after such a result.
- A progress bar inside a message (a poll, a voice clip), or a hidden one, no longer blocks finding the top of the chat. A spinner that stays at the top is `top-spinner`.
- `busy` is now `post-running`, `scan-running` or `jump-running`; the post's stage is recorded before each key.
- A message in its own small scrolling box no longer passes for the message list. It had cut a first run of 100 to 25.
- Refusals cancel the reply bar the post opened. A failed More actions menu is closed, and only the menu just opened is searched. The user's draft is left alone.
- `post` refuses while a page Reply link is jumping, and checks the reply bar again just before Enter.
- Each avatar names only its own group of messages.

### Needs a live check
- That Messenger accepts the helper's synthetic Enter and shift+Enter (Lexical itself does in Chromium; Messenger's own handlers are unknown). If not, `post` reports `enter-not-accepted` or `linebreak-not-accepted` and sends nothing.
- That photo-only messages' menu is `[aria-label="More actions"]` › "Reply" as reported, a run's avatar sits on one of its messages, and the loading spinner is a `[role="progressbar"]`.

## [1.19.0] - 2026-11-12
**The Messages view: a person's bubbles as one block, your place kept, and the message a conversation answers** (BACKLOG B39, B40, B42). MINOR: page `PAGE_VERSION` 2.4, so Claude republishes the page on the next refresh. Helper, skills, `catchup.py` and the database layout unchanged.

### Changed
- **A person's bubbles read as one block, as in Messenger (B42).** Messenger stores each bubble as its own message, so a text and the photo sent a minute later showed as two full rows, the second labelled "… continues". Now a run of bubbles from the same sender, each at most 5 minutes after the last and linked as "continues" by threading, is one block: one header (name, time), each bubble's text or photos beneath it, its number kept but quiet.
  - **Every message's actions show only when you want them, as in Messenger.** Each message, and each bubble in a block, keeps its own "Reply in Messenger", "Open photo" and "Reply here". With a mouse they appear in a small bar when you hover it; with a keyboard, when Tab reaches them (with a visible focus ring); on a phone, when you tap it. Link previews, reactions, the "reply queued" chip and an open "Reply here" composer stay visible.
  - Replies to any bubble nest under the block. Search, jumps and `#n` links still find each bubble. It works in the timeline, the threaded layout and the Summary's "Show the thread".
  - The Messages filter takes `#123` to find message 123.

### Fixed
- **Queuing a reply no longer closes the conversation and jumps the page (B39).** Every outbox change used to rebuild the Summary and Messages tabs, and the rebuild reopened only the first four conversations. Now:
  - an outbox change only refills the "reply queued" chips and the "Your replies" list, and closes the composer whose reply was queued
  - the Messages tab remembers which conversations you opened or closed
  - every other rebuild from new data (a refresh's chunks, threading, the summary, photos, names) keeps the message you were replying to, or the row at the top of the screen, where it was. Chromium anchors scrolling itself; Safari doesn't, so this matters most there.
- **A conversation that starts with a reply shows what it replies to (B40).** When threading put a reply in a new conversation, the message it answered was only a "reply to #n" chip. The conversation now opens with that message itself, quoted and set apart (indented, a left rule, a muted background): which conversation it's in and "Show #n →" (a jump), then its sender, time, full text and photos. If it was sent as a run of bubbles, such as a text and the photo after it, the whole run shows as one block. Also when a conversation started before the catch-up window. A parent that isn't stored shows what the reply quotes and says it isn't stored. In the Messages tab and on Summary cards; it works on pages already built, with no change to the refresh.
- A jump made while a typed filter was still waiting to apply could be redrawn over.
- The Summary redraws when photos arrive, so its snippets and context blocks show them.

### Tests
- Page: `messagesView` (30 checks): the block, its single header and quiet numbers; a reply nesting under it; an 8-minute gap and a different sender kept apart; hover and keyboard focus showing only that bubble's actions; "Reply here" on the second bubble queuing a reply to it; the `#n` link and the filter finding each bubble, threaded and in the timeline; the Summary thread; a phone (tap shows the actions, no sideways scroll); every row hiding its actions until hover, Tab or tap (with a visible focus ring), and an open composer staying visible; the context block with the parent's full text, time and photo run, its jump, a parent that isn't stored, and its Summary card; the reader's place through a queued reply, a new chunk and a threading update, with Chromium's own scroll anchoring off. Each fails on v1.17's page, except the ones that guard against regressions: rows kept apart, no context line where none belongs, "Reply here" on the right message, no sideways scroll and no page errors.
- The layout test compares the old layout with the last release's page by what it shows (the header, the Summary cards and every message's number, text and photos) rather than exact text, since rows are now grouped.
- `ONLY=section,...` runs some page-test sections.

## [1.18.1] - 2026-11-12
**Restore what pre-1.17 refreshes dropped from the summary** (BACKLOG F10, GitHub issue #32 §4). PATCH: a tool and a reference file; a normal refresh is unchanged. Page and helper unchanged.

### Added
- **`catchup.py restore-summary WORK RUN BACKUPDIR [DECISIONS] [--dry-run]`** joins the summary copy a session saved in the page's `backups` collection (refusing missing or mismatched parts) and adds back what the stored summary lacks:
  - missing conversations; old string synopses become one bullet per sentence, as the page shows them
  - a conversation that's still there, or was started again because it continued, gets the backup's bullets in front of its own (no duplicates) and its empty tag, outcome or key filled in
  - missing answers, deals and mentions, each back where it was in its list (a deal edited since counts as present)
  - `summary.fromI` moved back to the backup's, or removed when the summary then covers everything
  - `--dry-run` prints only counts. The backup's open questions come back only as DECISIONS says: without it, they're written to `RUN/out/restore-open.json` with the later messages in their conversations, and nothing else is written.
  - it writes through the block layout like a build: manifest, pins, cleanup, size check, WORK advanced and `restore WORK` to undo it. A second run restores nothing.
- **`references/restoring-a-summary.md`** (named from `troubleshooting.md`): the run lock, the fetch, the dry run the user confirms, the open-question decisions, the pinned write, the check afterwards, what to tell the user, and the backup kept until the user decides.
- `references/database.md` documents `backups/*` and what `fromI` means.

### Fixed
- **A build that gave bullets to a conversation with an old string synopsis crashed** (BACKLOG B47): the string is now split into bullets as the page shows it first. Older bullets with no refs (from such strings) no longer fail a build's checks; a new bullet still needs refs.

## [1.18.0] - 2026-11-12
**Queued replies post in about 3 calls instead of 6, multi-line replies post, and `sentAt` is the real time** (issue #32 §1, §3 and §5; BACKLOG F11, B45, B46, and G6). MINOR: Claude follows a new posting procedure. Skill text and tests only: no page or helper change (`PAGE_VERSION` 2.3, helper 1.9).

### Changed
- **`references/outbox.md` › Posting** (F11, issue #32 §1, option A): about 3 calls per reply, every safety check kept.
  1. One JS call starts `jump`, waits for the tip, checks the "Replying to …" bar, the snip and the empty box, then types the first line.
  2. One DB batch writes the earlier rows' outcomes and this row's `sending`, all pinned with `if_version`.
  3. One browser batch types any later lines, runs the check, presses Return and runs the confirm.
  - A row's `sent` lands with the next row's `sending`, and a confirm that can't see the message stops posting for the run, so a crash leaves at most one row in `sending`; the existing settle check handles it.
  - The check throws and takes the focus off the box when the box doesn't match the reply, so Return never sends it. The confirm only accepts a message that wasn't on screen before Return.
  - On the owner's page, replies took about 45–66 s each.
- **Multi-line replies** (B45, issue #32 §3, option A): each later line is typed after shift+Return, since Messenger's editor drops line breaks inside inserted text, and the box is compared with the reply with whitespace collapsed. The page keeps what the user wrote.
- **`sentAt`** (B46, issue #32 §5): the clock time at confirm, or the saved message's time when a row is settled on a later refresh. Every `sent` write sets both `sentAt` and `sentMid`, including when the user says it went out.
- **New rules:** a row with a null `mid` is marked `failed` ("no Messenger id"); a refused `sending` write means the user cancelled it on the page, and their Cancel wins; failed rows aren't retried, so the user queues a new reply.
- **`references/database.md`** (G6; setup's copy too): an `outbox/r<ms>` line with every field, who writes it, and the state transitions; `meta/chat.coverage` defined. `references/open-message.md` says how to queue a reply with the page's fields.

### Tests
- `tests/composer.sim.js` (run by `npm run test:sim` after `sim.js`) runs `outbox.md`'s three code blocks word for word on `tests/mock/composer.html`, a stand-in for Messenger's composer that drops line breaks the way Lexical does, with the real helper's `jump`. It covers a multi-line reply sent with its paragraphs, a box that doesn't match (Return sends nothing), a bar for another message, and a message that can't be found.
- `tests/test_tools.py`: `TestOutboxPosting` (the 3-call order, multi-line steps, `sentAt` and `sentMid`, null `mid`, the pinned `sending` write, no retries); the page's three outbox writes against database.md's outbox line; open-message.md queues with the page's fields; `coverage` is defined; the `meta/chat` fields test starts from each `doc("meta/chat")` write.

## [1.17.1] - 2026-11-12
**Fixes from the first live refresh on 1.17.0** (BACKLOG B44, GitHub issue #33). PATCH: page, helper and database layout unchanged.

### Fixed
- **Conversation ids used twice no longer stop the conversion.** `bootstrap` renames the second conversation (its id plus its first message number) and says so in its output; the summary stays with the first. A summary with an id used twice stops bootstrap with what to do instead of failing later as an "internal error".
- **Chunk names come from the stored chunks.** Bootstrap's "stored but not built yet" line and build's "RUN is missing" line named chunks by arithmetic (`i // chunkSize * chunkSize`), which is wrong on pages whose chunks start where imports landed. `open-message.md` and `troubleshooting.md` now look a message's chunk up by `start`.
- **The refresh skill's full description loads again.** It was unquoted YAML, so ` #123` started a comment and Claude saw it cut off at "open. Both skills' descriptions are quoted, and a test checks them.

### Added
- BACKLOG F10: restore the summary items pre-1.17 refreshes dropped (issue #32 §4), with the owner's decisions.

## [1.17.0] - 2026-11-11
**Threading and summary fit the database at any size, and nothing is dropped** (BACKLOG B43, P1). MINOR: both are now stored as collections of block documents. No re-setup: a page converts on its next refresh, and the page still reads the old layout.

### Why
- An artifact database document holds at most 256 KiB (262,144 bytes). On the owner's page on Nov 11, `threading/current` was 185.6 KB and growing about 20 KB a day, so it would be full in about 3 days, after which every refresh's step-7 write would fail. `summary/current` had reached 249 KB, and refresh sessions had improvised a rolling window: they dropped older conversations and wrote an undocumented `fromI` (2797). Those summaries are lost. `catchup.py` never split or pruned anything.

### Changed
- **Layout:** `threading` and `summary` are collections. Each `current` document names its block documents (`blocks`), one per 1,000 messages:
  - threading links and members go to the block of their message, and a conversation's title to the block of its first message
  - the summary keeps recent items in `current` (`activeFrom`); older conversations, open questions, answers, mentions and deals go to the block of their messages, and a conversation's older bullets to the blocks they cite
  - merged, they are exactly the old single documents, order included. Details: `references/database.md`.
- **Safe to interrupt:** a block's id carries a hash of its content, so a changed block is a new document that `current` switches to in the same batch, and the old one is deleted afterwards. A run that stops partway changes nothing the page reads, and a retry finds the blocks it already wrote. Only documents shaped like blocks are ever deleted.
- **`catchup.py`:**
  - `bootstrap` reads either layout (it now takes the whole `threading` and `summary` collections)
  - `build` writes only the documents that changed, plus `RUN/out/manifest.json`: the batches to send (at most 48 documents and 900 KiB each, inside the tool's 50 writes and 1 MiB), which writes to pin, and which old blocks to delete afterwards. `RUN/out/merged/` holds the merged state for checking.
  - it fails before writing anything if a document would be over 240 KiB, naming the largest conversations and saying never to drop or shorten anything; checks that the documents merge back into the built state; and refuses to build when the database's `current` documents moved on since WORK was bootstrapped
  - `relink` writes a manifest too
  - `fromI` is defined: the first message the stored summary covers (pages from before v1.17). It is kept as is, and the page still offers summaries of spans before it.
  - fixed: continuing a conversation whose summary an earlier session had dropped crashed the build; its summary now starts again
- **Page 2.3:** listens to the `threading` and `summary` collections instead of their single documents and merges them into the same objects every view reads, so it renders exactly as before. Old single documents are used as they are.
- **Refresh skill:**
  - bootstrap and step 5 list both collections
  - step 7 writes what the manifest lists (pins where it says, `meta/chat` and `refresh/status` in the last batch), then deletes what `cleanup` lists
  - new hard rule: never drop, shorten or prune conversations, bullets or other summary items to save space
  - new `references/writing-the-build.md` (the manifest, the cleanup, refused writes, the first build on v1.17, `fromI`)
  - `references/database.md` documents the layout (setup's copy too); `first-run.md` and `troubleshooting.md` updated. `SKILL.md`: 19,859 bytes.
- **Migration:** the first refresh on 1.17.0 republishes the page (2.3), and its build converts both collections, usually in one batch: it creates the blocks, then replaces both `current` documents. If it stops partway, the old documents still stand and the next refresh finishes it. The stray `fromI` (2797 on the owner's page) is kept, so the page keeps offering to summarize spans before it.
- **Measured** on synthetic chats calibrated to the owner's page (`tests/synth.py`, mock cast): from 6,400 to 50,000 messages the largest document is at most 84 KB, or 85 KB with a 1.6× denser summary, at least 3× under the cap. A build writes about 4 documents in one batch (docs/EXPERIMENTS.md §13).
- **Tests:**
  - a fake database in both suites that refuses what the real one refuses: documents over 262,144 bytes, batches over 50 writes or 1 MiB, and unpinned writes to existing documents
  - `catchup.py`:
    - migration from the old layout with `fromI`
    - builds at 6.4k, 25k and 50k messages with every document under half the cap
    - a link correction landing in its block
    - interrupted migrations (mid-batch, between batches, before the cleanup) and their retries
    - the size check
    - bootstrap from either layout giving the same state
    - split and merge keeping every item in order
    - an ordinary build rewriting only the newest block
    - the cleanup never touching unknown documents
  - page:
    - on the old layout it renders exactly what v1.16.2's page renders
    - the same history in both layouts renders the same text (summary, threads, timeline, all threads open)
    - archived conversations show and are searchable
    - a live change to one block re-renders
    - the pipeline writes catchup.py's manifest as Claude does, and the page's merge equals catchup.py's state
  - skill text: step 5 and step 7 name the collections and the manifest, the never-drop rule exists, the page and `catchup.py` merge with the same keys, and setup's seed bootstraps and converts
- **Fixed after an independent review of the PR** (each reproduced first, each with a test that failed before the fix):
  - the cleanup deleted every block document the new `current` didn't name, so a `current` an older version of the skill wrote back could lead to deleting the newer build's blocks. It now deletes only blocks the replaced `current` named; blocks no `current` names are left alone, and bootstrap reports them, with a warning when they hold messages past threading's last one. A 1.16 build's `RUN/out/threading.json` and `summary.json` are removed when a build reuses that RUN folder.
  - a relink after a cleanup could write a `current` naming a block that cleanup had deleted. `relink` now reads a fresh `list threading` (`relink WORK RUN SPEC`, writing `RUN/out/`) and has a cleanup like a build's; WORK records only the blocks its `current` names.
  - a build accepted a RUN holding only the two `current` documents and wrote `current` documents naming blocks it never listed. Build and relink now require the whole collections and say so.
  - the page silently left out a block that `current` names but that isn't there. It now shows a notice when one stays missing for 5 seconds; bootstrap's message for a missing block says not to write anything and to tell the user.
  - `writing-the-build.md` no longer says a refused batch always writes nothing whatever happens: a batch applied one write at a time can stop partway. Bootstrap now stops when threading and summary disagree on the last message built, and `catchup.py bootstrap WORK DBDIR --rollback` recovers by rebuilding threading's extra messages.
- **Backlog:**
  - B43 filed and closed
  - B41 (full names missing on a live page) and B42 (a text and the photo sent right after show as two rows instead of one block; the owner chose to show them like Messenger) filed, not fixed
  - R4 and F6 note that the per-document cap is handled for summary and threading
  - CLAUDE.md: backlog-only edits wait on a branch and ship with the next real change
- **Docs:** STATUS, ARCHITECTURE, BACKLOG, DECISIONS, LEARNINGS, EXPERIMENTS §13, DEVELOPMENT (Phase 11).

Components: `PAGE_VERSION` 2.3 (was 2.2), helper 1.9 (unchanged).

## [1.16.2] - 2026-11-11
**Backlog: B39 and B40 filed.** B39: queuing a reply closes the conversation you're in and jumps the page. B40: a conversation that starts with a reply to an older message doesn't show that message. PATCH: docs only.

## [1.16.1] - 2026-11-08
**The marketplace is renamed `rando-tools`** (was `roopesh`). PATCH: skills, page, helper and database unchanged.

### Changed
- In Claude Code the plugin is now `messenger-catchup@rando-tools`. The repo to add is still `roopesh/messenger-catchup`. If you added the marketplace before this release, remove it and add it again so the new name takes effect.
- The marketplace owner and the plugin author are now "Messenger Catch-up", linking the repo instead of a personal profile.

## [1.16.0] - 2026-11-07
**Setup is its own skill** (BACKLOG F7, part 2). MINOR: "set up" now loads `messenger-catchup:setup`, and refresh no longer carries the setup instructions. Page, helper and database unchanged.

### Changed
- **Two skills:**
  - `messenger-catchup:setup` covers the requirements, finding or creating the page, the setup questions, seeding the database, the helper install and the schedule.
  - `messenger-catchup:refresh` covers everything after that.
  - Each has its own description, so "set up messenger catch-up" and "refresh my catch-up" load the right one.
- **The first capture still runs through refresh:** setup hands over after seeding, and refresh reads its new `references/first-run.md` when `meta/chat.lastI` is -1.
- **Updating the page** (when `PAGE_VERSION` rises) moved to refresh's `references/updating-the-page.md`.
- **Setup carries copies** of the page and `references/database.md`, because a skill can only count on its own folder. `npm run sync` (now `tools/sync.py`, formerly `sync-helper.py`) writes them; `npm test` fails on a stale copy. Edit the refresh skill's files, never the copies.
- **Fixed while splitting** (found by an independent walk-through of the new skills; most were there before):
  - **The first capture's size is saved:** new `meta/chat.firstCount`, seeded by setup. Before, it lived only in the setup conversation, so a first capture retried later had no size.
  - **Setup never reseeds a page that already has messages.** Finding an existing page for the chat used to lead straight into seeding, which would have emptied its threading and summary.
  - **Setup seeds `kind`, `pageVersion` and `tz` explicitly.** Without them, setup couldn't find the page again, and the first refresh would republish it.
  - **A scheduled refresh never starts setup:** with no page, it stops.
  - **The first run reports once:** setup's last step reports, not refresh's step 8. The people check waits for the next refresh.
  - **Setup has a "Which part to follow"** for changing the schedule (find the page, never reseed, replace the existing chain or task).
  - **Setup's copy of the database reference** names the refresh skill's files as the refresh skill's.
- **Refresh `SKILL.md`:** a shorter intro, and the per-user note moved to setup: 19,833 bytes.
- **Tests:**
  - the copies match the refresh skill
  - setup names only files it has
  - the two skills name each other by their real names
  - setup hands the first capture to refresh, and `first-run.md` carries the first-run rules
  - setup stays under 20 KB
  - setup seeds `kind`, `pageVersion`, `tz` and `firstCount`, and never reseeds a page that has messages
  - the ZIP and `plugin/` hold both skills
- **Docs:** README, CLAUDE.md, STATUS, ARCHITECTURE, BACKLOG (F7 done).

Components: `PAGE_VERSION` 2.2, helper 1.9 (unchanged).

## [1.15.0] - 2026-11-07
**Messenger Catch-up is now a plugin** (BACKLOG F7, part 1). MINOR: the install changes and the skill is now invoked as `messenger-catchup:refresh`; the page, the helper and the database are unchanged, so nothing needs setting up again.

### Changed
- **Install from the marketplace:** this repo is a plugin marketplace named `roopesh`.
  - claude.ai or Claude Desktop: Customize › Plugins › Add › Add marketplace › `roopesh/messenger-catchup`
  - Claude Code: `/plugin install messenger-catchup --marketplace roopesh/messenger-catchup`
  - Installs update when the plugin's version changes, which is every release. Plugins added on claude.ai follow your account into Claude Code.
- **Moving from the uploaded skill:** install the plugin, remove the old skill (Customize › Skills), and point a scheduled loop at `messenger-catchup:refresh`. Your page and data stay as they are.
- **Layout:** the skill's files moved to `plugin/skills/refresh/` (the plugin is `plugin/`, its manifest `plugin/.claude-plugin/plugin.json`). `SKILL.md` finds its files through `${CLAUDE_SKILL_DIR}` (in chat, next to `SKILL.md`), replacing the old `find /` fallback.
- **Release asset:** `messenger-catchup-plugin.zip` (for Customize › Plugins › Upload plugin) replaces the skill ZIP; `helper.user.js` is still attached, so installed helpers keep updating themselves.
- **Tests:** the plugin's version equals `VERSION`; the marketplace entry, skill names and folders agree; `plugin/` holds only shipped files and no `bin/`; `claude plugin validate --strict` passes for the plugin and the marketplace (CI installs the Claude Code CLI for it).
- **Docs:** README install, CLAUDE.md versioning (three files now carry the version), STATUS, ARCHITECTURE, BACKLOG F7.

Components: `PAGE_VERSION` 2.2, helper 1.9 (unchanged).

## [1.14.2] - 2026-11-07
Docs only. Follows the owner-approved rewrite of the git history.

### Changed
- **Git history rewritten** so that no commit, commit message or tag names the original chat, its raffle term or its old code names. The old code names now read with a neutral `cc` prefix (`cctool.py`, `ccScan`, …). Every released version's shipped files are unchanged, so the release ZIPs still match their tags. Old commit ids no longer exist.
- **Commit references in the docs** point at the rewritten commits.
- **`docs/DEVELOPMENT.md` › Phase 10** records the rewrite and how it was checked.

Components: `PAGE_VERSION` 2.2, helper 1.9 (unchanged).

## [1.14.1] - 2026-11-07
Docs only.

### Changed
- **`docs/STATUS.md`** is up to date for v1.14:
  - shipped versions; the live page still at 1.1; the one-time userscript reinstall
  - test counts: Python 111, sim 60, page 130
  - where to start
- **`docs/DEVELOPMENT.md` › Phase 10** records this round; the version map is extended.
- **The original chat's name is removed** from the docs and from a test pattern. Real chat names never go in the repo; it's public.

Components: `PAGE_VERSION` 2.2, helper 1.9 (unchanged).

## [1.14.0] - 2026-11-07
Faster, safer photo replies whose parents are far up the chat (BACKLOG F2, B38). MINOR: the reader behaves differently, and a new error can reach Claude as a CHECK. Helper 1.9; installed copies update themselves. Page unchanged.

### Changed (helper 1.9)
- **F2, speed:** after each click on "Go to replied message", the reader jumps back to the bottom before finding the next reply. Before, it stepped down from the far-up parent 0.8 screen at a time, which was slow and could end in `notfound`. It also waits up to 10 s for the parent to take focus, up from 2.5 s.

### Fixed (helper 1.9)
- **B38, wrong link:** a parent that loaded too late could take focus while the next reply was clicked, and be recorded as that reply's parent with no warning. Now the focused message must be from the person the reply names; otherwise the result is `perr:"wrongfocus"`, which `catchup.py` shows as a CHECK.

### Tests
- **Mock:** a reply link whose parent isn't loaded now loads history down to it after a delay, like Messenger (`mock_parent_delay`, 3 s by default). Two photo replies with far-up parents are #130 → #20 and #136 → #23.
- **Sim section D:**
  - both parents are found, in about 9 s. On helper 1.8 this fails: one `nofocus`, and the other linked to the wrong message.
  - with a 12 s delay, both are errors and neither is a wrong link.

Components: `PAGE_VERSION` 2.2 (unchanged), helper 1.9.

## [1.13.0] - 2026-11-07
A self-check that names exactly what changed when Messenger's page changes (BACKLOG F4). MINOR: a new refresh step. Helper 1.8; installed copies update themselves. Page unchanged.

### Added
- **Helper 1.8 `selfcheck`:** read-only and immediate. Returns `{ok, missing, warn, counts}`.
  - **`missing`, the reader can't work:**
    - the chat log, message ids or the scrolling list
    - the `At <time>, <name>: ` labels
    - "Go to replied message" links, when reply lines exist
    - "Original message:" quotes, when reply links exist
  - **`warn`, it works with less:** no sender avatars (no full names), or mostly unreadable date labels.
- **SKILL.md step 2** runs it after the tab is ready, installed or injected. On `ok:false` the status becomes "Messenger changed: …", the run stops, and the user is told even during a scheduled run. Warnings go in the report.
- **`references/troubleshooting.md`:** what to do when `selfcheck` fails.

### Tests
- Sim: `selfcheck` passes on the mock. It then names each hook when that hook is broken: relabelled messages, removed reply links, removed avatars (a warning only) and a renamed chat log.

Components: `PAGE_VERSION` 2.2 (unchanged), helper 1.8.

## [1.12.0] - 2026-11-07
Correct a link on a message that's already built (BACKLOG F3). MINOR: a new spec key, a new `catchup.py` command and a new procedure. Page and helper unchanged.

### Added
- **`relink`:** `{"i": [parent, type]}`, or `null` to remove a link. It works inside a build spec, or on its own with `catchup.py relink WORK OUT SPEC` when nothing new needs building. That writes `OUT/threading.json` for `threading/current` (pinned) and advances WORK's threading; `restore WORK` undoes it.
- **Checks:**
  - only messages already built (otherwise it says to use `links`)
  - the parent must be an earlier stored message
  - the type must be a known one
  - a WARN when the link crosses conversations
- **SKILL.md:** routes "a message linked to the wrong one" to `relink`, with the steps in the `catchup.py` section.

### Changed (SKILL.md, to make room within the 20 KB budget)
Both moves are verbatim:
- The four rare import toasts (REPAIRED, photo upload failed, can't upload, another import running) move to `references/troubleshooting.md` › Import toasts. Step 4 sends any toast other than IMPORT OK or Nothing new there.
- The page-update steps move to `references/setup.md` › Updating the page, with a pointer in "Before each run". They only run when `pageVersion` is behind.

### Tests
- Python 111:
  - relink in a build, relink on its own (including undo with restore), each refusal leaving WORK untouched, and the cross-conversation WARN. These fail on the v1.11.0 script.
  - every `catchup.py` command is documented in `SKILL.md`
  - the rare toasts are reachable from step 4

Components: `PAGE_VERSION` 2.2, helper 1.7 (unchanged).

## [1.11.0] - 2026-11-07
Full names and nicknames, part 2: a one-time backfill of older senders and the alias question (BACKLOG F9). MINOR: new procedure, a new helper command, and the page republishes (`PAGE_VERSION` 2.2). Helper 1.7; installed copies update themselves.

### Added
- **Helper 1.7, `people{count, maxMs}`:**
  - **Read-only:** scrolls back through up to `count` messages (or to the top, or for 8 minutes) reading each sender's shown name and avatar name, with no clicks.
  - Returns `{seen, top, ms, people:[[shown, full, n]]}`.
  - The avatar reader is shared with the scan.
- **`references/people.md`:**
  - **One-time name scan:** runs when `people/index` has no `scannedAt`, as its own short run holding the lock after a refresh's report, and merges the result into `people/index`. It's skipped while the installed helper is older than 1.7, which can't run it; it updates itself within a day.
  - **Alias question:** once, only with the user present, asks which of their full name, last name and other names count as mentions, then sets `meta/chat.aliasesAskedAt`.
- **SKILL.md:** step 8 points there, and the helper's command list includes `people`. It's still under 20 KB.

### Fixed (page 2.2)
- Entries Claude's scan writes have no `firstI`/`lastI`. An import now fills them in. Before, the result would have been `NaN`, saved as null.

### Tests
- Sim: `people` scans the mock back to the top and maps every shown name to its full name: both Bens, the nickname, and nothing for "You".
- Page: an entry without positions gets them on import, and `scannedAt` survives imports. This check fails on page 2.1.
- Python: `references/people.md` is shipped and named in `SKILL.md`.

Components: `PAGE_VERSION` 2.2, helper 1.7.

## [1.10.0] - 2026-11-07
Full names and nicknames, part 1 (BACKLOG F9). MINOR: new data and page behavior. Pages republish (`PAGE_VERSION` 2.1). The helper goes to 1.6 and installed 1.5 copies update themselves.

### Added
- **Helper 1.6:** each captured message carries `fn`, the sender's full name. It comes from the alt text of their avatar (the ~28 px image at the message's left edge), while Messenger's own name line shows only a nickname or the first name. The scan keeps it across the reload. Your own messages carry none.
- **Page 2.1:**
  - keeps `fn` (a string of 80 characters or fewer, never on "You") and writes `people/index`, mapping each full name to the names Messenger showed it as
  - **names people as the owner chose:** the first name; the full name when two or more people share that first name; a nickname as "nickname (first name)", or "nickname (full name)" when the first name is shared
  - uses those names in message rows, snippets, threads, replies, links, photo captions and Ask Claude's prompt
  - the Messages filter also matches full names
  - "people posting" counts people, not displayed names
- **SKILL.md:**
  - documents `fn` and `people/index`
  - a spec rule: name people the way the page does, and tell them apart by `fn`. `f`, `r` and the outbox's `to` stay as Messenger shows them, since replies match on those.
  - the reference-file list is folded into one line to stay under the 20 KB budget

### Live findings (read-only, Nov 7)
- Labels and name lines show a nickname or the first name; the avatar carries the full name.
- In about 150 messages, each displayed name maps to exactly one full name.
- Recorded in LEARNINGS.md › Messenger DOM, using no real names.

### Tests
- **Mock:** senders get avatars with full names, plus a second "Ben" (#101) and a nickname, "Captain Cy" (#108).
- **Sim:** every capture checks `fn`. These checks fail on helper 1.5.
- **Page:** 10 new checks, which fail on page 2.0:
  - the people map, including the nickname
  - the display rule for shared first names and nicknames
  - `fn` filtering
  - the filter by full name
- **Python:** 105; the database lines shared by `SKILL.md` and the reference include `people/index`.

Components: `PAGE_VERSION` 2.1, helper 1.6.

## [1.9.0] - 2026-11-07
`SKILL.md` now holds only what every refresh needs. The rest moved to reference files Claude reads when needed (BACKLOG C7). MINOR: the procedure files change, but no step does.

### Changed
- **Size:** `SKILL.md` is now 19.4 KB, down from 31.8 KB. Claude reads it on every run, so an hourly loop reads about 3k fewer tokens per refresh.
- **New `references/` folder** (ships in the ZIP):
  - `setup.md`: requirements, first run, installing the helper, scheduling
  - `outbox.md`
  - `open-message.md`
  - `database.md`: the full reference, plus questions and notes
  - `troubleshooting.md`: also has the "Tested" note
- **Which part to follow:** a new `SKILL.md` section says when to read each reference file.
- **What stayed in `SKILL.md`:**
  - the hard rules
  - the core database fields
  - the helper bridge
  - the refresh steps
  - spec writing and the `catchup.py` reference
  - method ideas
  - the scheduling chain
- **Outbox:** step 8 now says to read `references/outbox.md` in full before handling any queued or sending row.
- **Review fixes:** an independent review walked five scenarios through the new layout. It found no lost content; these four gaps are fixed:
  - step 7 now queries the outbox itself
  - the scheduled-run section names `schedule`'s fields
  - two troubleshooting entries are self-contained
  - setup points at the field names it seeds
  Also filed G6: outbox row fields and `coverage` were never documented.
- **Verbatim:** text moved unchanged. A line-by-line check against v1.8.0 shows 133 of 143 lines identical; the other 10 are reworded cross-references and headings.

### Tests
- Python 105:
  - `SKILL.md` names every reference file
  - `SKILL.md` stays under 20 KB
  - the outbox rules are read before a reply is posted
  - the ZIP ships `references/`
  - the database and outbox-state tests read the new files
  - setup points at the field names it seeds
  - `SKILL.md`'s database lines match the reference word for word

Components: `PAGE_VERSION` 2.0, helper 1.5 (unchanged).

## [1.8.0] - 2026-11-07
The userscript installs from the GitHub release and updates itself (BACKLOG F8). MINOR: the page's setup steps and SKILL.md's helper instructions change. Pages republish (`PAGE_VERSION` 2.0) and the helper is 1.5.

### Changed
- **Helper 1.5:** `@updateURL`/`@downloadURL` point at `releases/latest/download/helper.user.js`, so Tampermonkey and Violentmonkey keep it current (they check about once a day).
- **Releases:** `tools/release.sh` attaches `helper.user.js` to every release, and stops if the tag has none.
- **Page:** "Jump to a message: set up" links to the install URL instead of embedding a 30 KB copy of the userscript. The bookmarklet stays. The page shrinks from 167 KB to 130 KB.
- **SKILL.md:**
  - The install step is now "open the link, press Install".
  - A helper older than 1.5, installed by pasting, gets a one-time "install from the link" notice. Later ones update themselves.
  - Versions compare number by number.
- **README:** install link, plus a note on what auto-update trusts.
- **Versions:** `PAGE_VERSION` goes 1.9 → **2.0**, not 1.10. The live page is at 1.1, and read as decimals 1.1 = 1.10, so a 1.10 page might never have been republished. A test keeps component minor versions to one digit.

### Tests
- Python 100: the page links the release URL with no embedded copy, the helper's update URLs match it, the release attaches the userscript, and component versions read the same as decimals.

Components: `PAGE_VERSION` 2.0, helper 1.5. Users with a pasted (pre-1.5) userscript reinstall once from the link; after that it updates itself.

## [1.7.4] - 2026-11-07
Formatting (BACKLOG C4). Behavior is unchanged; pages republish (`PAGE_VERSION` 1.9) because the page file changed.

### Changed
- **Code style:** the page, helper, JS tests, mock, `catchup.py`, Python tests and tools are formatted, one statement per line, at 120 columns:
  - Prettier 3.3.3 for HTML and JS, Ruff 0.6.9 for Python, both pinned. Ruff lives in `.venv`, created by `npm run setup`.
  - `npm run fmt` formats (then syncs the helper copies); `npm test` and CI start with `fmt:check`.
- **No skeleton:** `assets/page.html` no longer stores the document skeleton (`<!doctype html>…<body>`). The Artifact tool adds it when publishing, and Prettier would have rewritten it into a shape the tool doesn't recognize. The page test adds the same skeleton. A new test keeps it out of the file.
- **Bookmarklet:** `tools/sync-helper.py` finds the bookmarklet source at any indent. Tests check that the bookmarklet has no `//` comment, which would break a one-line `javascript:` URL.
- **Test regexes:** the ones that read the page and helper source (versions, db paths, `meta/chat` fields, outbox labels) now ignore whitespace.

### Tests
- Sim: new section C runs the page's bookmarklet against the mock. It passes on v1.7.3 too.
- Python: 98 (new: page has no skeleton).

### Backlog
- New items: C7 (shrink what `SKILL.md` makes Claude read per refresh), F7 (ship as a plugin), F8 (userscript from a URL, self-updating).

Components: `PAGE_VERSION` 1.9, helper 1.4 (reformatted; installed copies don't need updating).

## [1.7.3] - 2026-11-07
Cleanup (BACKLOG C1). Pages republish (`PAGE_VERSION` 1.8); nothing users can see changes.

### Removed (page)
- The in-page Refresh trigger, which was hidden and never wired up (`REFRESH_TASK` placeholder, `startRefresh`, `fire_trigger`, `S.mcp`). The status line, which tells you to ask Claude in chat or shows that a refresh is running, is unchanged.
- The summary v1 renderer, since every summary is version 2.
- `dayMap`/`meta.dates`, since every stored message carries its own date. Also removed an unused `DAYS` table.

### Kept
- **Range summaries.** C1 called them unreachable, but the original page's summary has `fromI`, so they're live there. A read-only check of that page's data found `fromI` 1654, two saved span summaries, version-2 summaries, and a date on every one of 3,992 messages.

### Tests
- Page: 9 new checks. Range summaries: offered, written, saved, reused. The status line, and the Refresh button being gone. Apart from the button check, they pass on the v1.7 page too.

Components: `PAGE_VERSION` 1.8, helper 1.4 (unchanged).

## [1.7.2] - 2026-11-07
Repo and docs only.

### Changed
- **R8 closed:** the repo is public, and `main` has GitHub branch protection: PR required, `test` and `version-bump` checks required and up to date, linear history, no force-push or deletion, admins included. Audited first: no chat data in files, history, PR bodies, secrets or CI artifacts.
- CLAUDE.md and STATUS.md: never commit real names or text from a chat; the workflow comment, STATUS and BACKLOG describe the new enforcement.

Components: `PAGE_VERSION` 1.7, helper 1.4 (unchanged).

## [1.7.1] - 2026-11-07
Docs only.

### Changed
- `docs/STATUS.md` brought up to date: release, test counts, enforcement, where to start (a live refresh first). The broken "Where to start" numbering is fixed.
- `docs/DEVELOPMENT.md` › Phase 9 records the overnight defect run (12 releases, three independent reviews, 37 defects fixed).

Components: `PAGE_VERSION` 1.7, helper 1.4 (unchanged).

## [1.7.0] - 2026-11-07
Fixes from a third independent review, aimed at regressions and interactions between the 1.4.2–1.6.0 fixes (BACKLOG B30–B37). MINOR: the refresh order and run-lock rules change. Pages republish (`PAGE_VERSION` 1.7).

### Fixed (SKILL.md)
- **B32, lock first:** the run lock is now step 1 and the Messenger tab step 2. A run that loses the race backs off before it can reload a tab another run is scanning in.
- **B30, lock write:** step 7 *updates* `refresh/status` (a merge), so `startedAt` and `by` survive. A literal "set" could drop them, and the lock then looked stale or eternal.
- **B31, nothing new:** the nothing-new path and the "nothing left to build" path follow step 7's status rule too, keeping the lock (`step:"outbox"`) while replies are posted.
- **B33, retries:** a retried step-7 write stops without writing if `refresh/status` shows another run's lock, instead of overwriting it with "done".
- **B35, unbuilt messages:** they're detected from WORK's `base` versus `meta/chat.lastI`, not only from bootstrap's message, so a reused WORK catches them too.
- **B36, resolving replies:** Claude sets `unconfirmed`/`failed` replies to `sent` or `dismissed` when the user says so. A `sending` row over a day old becomes `unconfirmed`.
- **B37, photo retries:** "Paste again" happens once. A page that can't upload says so and isn't re-pasted.
- **Names:** reply matching tolerates first-name versus full-name differences (`r` prefix match; the reply bar check uses the first name). This was flagged by the review as an unverified risk.

### Fixed (page, `PAGE_VERSION` 1.7)
- **B36:** failed and unconfirmed replies get a Dismiss button. The "Your replies" header says how many need a look, instead of "Sent in the last day".
- **B37:** a view without the assets capability says "Photos not stored: this view can't upload them" without "paste again".

### Fixed (`catchup.py`)
- **B34:** a RUN with no chunks at all (the nothing-new path with unbuilt messages) now gets "RUN is missing #a-#b … fetch chunks/…" instead of a bare gap error. `bootstrap` names those chunks up front.

Components: **`PAGE_VERSION` 1.7** (was 1.6), helper 1.4 (unchanged).

## [1.6.0] - 2026-11-07
The procedure half of the second review. MINOR: SKILL.md's refresh and outbox steps change. No change to the page, helper or `catchup.py`.

### Fixed
- **B25, unconfirmed replies:**
  - a reply left `sending` is now checked against the saved messages (your reply to `to` with that text after `queuedAt`), not against whatever is on screen
  - found → `sent`; not found once the chat has been read past it → `unconfirmed`, and the user is told
  - it's never posted again automatically; the page (since 1.5.1) keeps these listed until resolved
- **B26, run-lock race:** when two sessions start together, the one whose pinned step-2 write is refused re-reads the status and backs off quietly. It used to fall into "stopped early → set error" and overwrite the winner's `running`.
- **B27, lock held while posting:** with replies to post, step 7 leaves the status at `running` (step `outbox`) and step 8 marks it done afterwards. Another run can no longer take the Messenger tab mid-post.
- **B29 (outbox part):** for a reply to your own message, the reply bar check expects "Replying to yourself".

### Tests
- `tests/test_tools.py` checks that the page has a label for every outbox state SKILL.md uses (so `unconfirmed` can't go unrendered).

Components: `PAGE_VERSION` 1.6, helper 1.4 (unchanged).

## [1.5.1] - 2026-11-07
Fixes from a second independent review (BACKLOG B22–B29; the procedure ones follow in 1.6.0). Pages republish on their next refresh (`PAGE_VERSION` 1.6); Claude reports the helper update (1.4).

### Fixed
- **B22, bootstrap after a half-finished import:** `bootstrap` asserted that `meta/chat.lastI` equals the newest saved message. In the state the page's REPAIRED path exists to fix (chunks saved, `meta/chat` not), a fresh session crashed before it could paste, run after run. Now it notes the unsaved range and carries on; the paste repairs it.
- **B23, conflict recovery dead end:** after another session built the same messages, `build` said "restore WORK", but a fresh bootstrap has nothing to restore. It now says "nothing left to build", and SKILL.md says to write only `lastRefresh` and the status.
- **B24, "deleted a message":** any message whose text contained "deleted a message" (or quoted one) was saved as "(deleted a message)", losing its text. Now only Messenger's own "X deleted/unsent a message" line, on its own, counts.
- **B28, duplicate photos:** a re-paste after a failed upload decided "already stored" by position in the display list, so when a capture skipped a photo slot it uploaded a photo twice. `photos/index.byK` now records each stored photo's capture slot.
- **B29, replies to yourself:** "You replied to yourself" wasn't recognized, so these replies were never linked. Fixed in the helper and `catchup.py`.

### Changed
- The page keeps outbox replies that are still `sending`, or the new `unconfirmed` state, listed until they're resolved (they used to vanish after 24 h). SKILL.md starts using `unconfirmed` in 1.6.0.

### Tests
- `catchup.py`: 4 tests (B22 including the reviewer's crash, B23, B29). Mock: Dee's "unsent a message" line and a message of yours saying "who deleted a message lol?". Page: a skipped photo slot with a failed upload and a re-paste, and old unconfirmed/sending replies still shown. All fail on v1.5.0's code.

Components: **`PAGE_VERSION` 1.6** (was 1.5), **helper 1.4** (was 1.3).

## [1.5.0] - 2026-11-07
The rest of the review fixes: `catchup.py` and the refresh and outbox procedures. MINOR because SKILL.md's steps change. No change to the page or the helper.

### Fixed
- **B21, interrupted runs** (found while tracing B15): `bootstrap` assumed every stored message was already threaded. If a run imported and then stopped before building, every later build failed with "message in 0 conversations". `bootstrap` now bases WORK on `threading/current.to` and says which messages still need building. `build` names the chunks to fetch if the RUN lacks them.
- **B13, quote matching:** a short quote ("ok", "Yes") could link to any message containing those letters ("ok" inside "looks"), shown as a plain "matched by quote". Quotes under 12 characters now need the same whole text, and a long quote found inside a message (not at its start) is still matched. Both print `CHECK quote match (…)` for review.
- **B18, validation:** `build` now also refuses:
  - deal refs that are empty or outside the deal's conversation (the page hid such deals)
  - `dealEdit` additions outside the conversation
  - mentions of a missing message or of your own
  - a `closeOpen` that matches no open question
  - a question opened twice
- **B15, refresh procedure:**
  - the versions step 7 pins are now actually read (step 5)
  - WORK is re-bootstrapped when another session has built since
  - a run is skipped while another one is recent
  - a refused write is retried with fresh versions when only `meta/chat` or `refresh/status` changed, and rebuilt from a fresh bootstrap only when another build happened
- **B19, nothing new:** a scan with nothing new skips the import and build and records only `lastRefresh`. Any early stop sets `refresh/status` to error instead of leaving "refreshing" for 25 minutes.
- **B16, outbox:**
  - only "reply box is ready" allows typing
  - the reply bar must quote the queued message's text, which catches a reply box left open from an earlier attempt
  - a send that can't be confirmed in 15 s stays `sending` instead of `failed`, so it isn't queued and posted twice

### Tests
- 15 new `catchup.py` tests, including the reviewer's exact repros ("ok" vs "it looks great", "Yes" vs "Yes please…"). 14 of them fail against v1.4.2's `catchup.py`; the 15th is a control that passes on both. Two fixtures corrected: seeded history now counts as built, and the scenario no longer lists a mention of your own message.

Components: `PAGE_VERSION` 1.5, helper 1.3 (unchanged).

## [1.4.2] - 2026-11-07
Fixes from an independent review of v1.4.1 (BACKLOG B12–B21; the rest follow in 1.5.0). Pages republish on their next refresh (`PAGE_VERSION` 1.5), and Claude reports the helper update (1.3).

### Fixed
- **B12, capture sender:** a follow-on message (no name line) whose text began "Mike replied to …" was captured as a reply *from Mike* with its text lost. One beginning "You sent …" was captured as *your* message, which broke mentions and "since your last message". "Replied to" is now trusted only on real replies, and "You sent" only as Messenger's own status lines.
- **B14, repairs:** the REPAIRED note now names every chunk the repaired range spans. A big first import that stopped early named only the last chunk, and the build then failed.
- **B17, photos:**
  - when one upload failed, the photos that did upload weren't indexed
  - a capture with GIFs but no photos never recorded the GIFs
  - now uploads that land are indexed, a re-paste skips stored photos (no duplicates), and GIFs are always recorded
- **B20, lease:** the page now lets its import lease go after each import, instead of holding it for 2 minutes.

### Tests
- The mock gains the two follow-on messages. The page suite gains a 3-chunk repair, a GIF-only capture, an upload failing partway then a re-paste, and the lease release. All of these fail against the v1.4.1 helper and page.

Components: **`PAGE_VERSION` 1.5** (was 1.4), **helper 1.3** (was 1.2).

## [1.4.1] - 2026-11-07
Tooling only.

### Fixed
- **B10:** `make-zip.sh` works from a clone with any folder name. It stages the files under `messenger-catchup/` in a temp folder and writes `dist/messenger-catchup.zip` (gitignored) instead of the parent folder. `.DS_Store` and `__pycache__` files are no longer swept into the ZIP. `tools/release.sh` uses the new location; the ZIP test now runs from a folder with a different name and with junk files present.

Components: `PAGE_VERSION` 1.4, helper 1.2 (unchanged).

## [1.4.0] - 2026-11-07
SKILL.md now does what the page tells the user it does. MINOR: new procedures. No change to the page or the helper.

### Added
- **G3, open a message:** the page tells the user to say "reply 3232" or "open #3232". SKILL.md now has the procedure: find the message's chunk, start `jump`, report; never type for the user.
- **G2, what the page saves for Claude:**
  - after each refresh, new method ideas (`views` with `kind:"idea"`) are listed in the report with an offer to apply them; `meta/chat.ideasSeenAt` tracks which were seen
  - questions asked on the page (`qa`) are read when the user refers to them
  - analyses worth keeping are saved as `notes/*`, so the page's "Notes from Claude" section finally has a writer

### Fixed
- **G1:** SKILL.md's database section lists every `meta/chat` field the page writes (`lastT`, `ownLastMid`, `caughtUpAt`, `markerSetAt`, `markerTo`) and every collection the page uses (`qa`, `views`, `notes`, `rangeSummaries`).
- Two new tests in `tests/test_tools.py` derive the database paths and the `meta/chat` fields from the page source and fail if SKILL.md is missing any.

Components: `PAGE_VERSION` 1.4, helper 1.2 (unchanged).

## [1.3.0] - 2026-11-06
Helper 1.2: dates read reliably. MINOR because the helper version changes and SKILL.md gains two report steps. Installed userscripts keep working; Claude tells you when an update is available.

### Fixed
- **B6:** capture dates.
  - Short names ("Nov 3, 2026", "Sept 9", "Mon 9:15 AM", "Thurs") used to be dated *today*. They're now read correctly.
  - A year-less date in the future ("December 28" read on Jan 4) is now last year's.
  - A label the helper still can't read takes the previous message's date and is reported (`DATES-GUESSED #…` in the capture summary), instead of silently becoming today.
- **R7 (part):** the scan's link-click guard is registered once per page load, not once per scan.

### Added
- `mcDate(label, now)` in the helper (also `window.__mcDate`), so tests can pin "now". `tests/sim.js` checks 20 fixed-date cases, including the New Year rollback, plus new mock labels end to end (short month, year-less date, unreadable label, short weekday). The sim reads the helper version from the file instead of hard-coding it.
- `tests/test_tools.py` fails when `assets/page.html` changed since the last release tag but `PAGE_VERSION` didn't (it would have caught this release's own first draft). CI now fetches tags for it.
- SKILL.md:
  - mention a userscript update when the installed helper is older than the shipped one
  - list `DATES-GUESSED` messages in the report

Components: **`PAGE_VERSION` 1.4** (was 1.3: the page embeds the helper for "Copy userscript", so pages must be republished to offer 1.2), **helper 1.2** (was 1.1).

## [1.2.2] - 2026-11-06
Page fixes. Claude republishes existing pages on their next refresh (`PAGE_VERSION` 1.3).

### Fixed
- **B8:** one malformed link in a message threw while rendering and blanked the Messages tab and the threads in summary cards. All outside links now go through one helper that never throws.
- **Links:** only `http`/`https` links are clickable. Anything else (`javascript:`, malformed) shows as plain text. This applies to message links, the links table, deal call-outs and the old summary layout.
- **B7:** a mention of message #0 rendered without its text (`r[0]||r` treated 0 as missing).
- **B9:** with auto-posting on, the "Queued" note no longer asks you to confirm in chat.
- **G4:** the Refreshing notes no longer mention a Refresh button the page doesn't show.
- **G5:** the helper install steps name Tampermonkey (recommended) or Violentmonkey and the current Chrome "Allow User Scripts" switch, matching SKILL.md.

Components: **`PAGE_VERSION` 1.3** (was 1.2), helper 1.1 (unchanged).

## [1.2.1] - 2026-11-06
`catchup.py` fixes. No change to the page or the helper.

### Fixed
- **B11:** Messenger's own reply link to message #0 was ignored (`pi = 0` read as "no link"), so a photo reply could be linked to the author's *latest* photo instead.
- **B5:** a reply whose parent can't be found is now left unlinked (WARN), as SKILL.md always said; it used to get an automatic "answers" link.
- **B4:** a link to a parent in another conversation prints `WARN link i -> p crosses conversations`, since the page shows such a message as a new thread; an unknown link type is refused.
- **B3:** `dealEdit` on a conversation with no deal fails with a clear message instead of `IndexError`; with several deals it asks for `index`.
- **B1:** the threading note ("N reply links read straight from Messenger; …") is now written for new pages too; an older custom note is kept after it.
- **C5:** timestamps come from Python's `zoneinfo` instead of shelling out to `date`.
- **C6:** files are closed properly. The Python tests now treat ResourceWarnings as errors (1,356 warnings before, 0 after).

### Added
- `tools/release.sh`: tags the merge commit, builds the ZIP from the tag, checks its `VERSION`, and publishes the GitHub release.

Components: `PAGE_VERSION` 1.2, helper 1.1 (unchanged).

## [1.2.0] - 2026-11-06
Fixes the two P1 issues from the backlog. MINOR because the refresh procedure in SKILL.md changes (page upgrades and `restore`). Claude republishes existing pages automatically on their next refresh.

### Fixed
- **B2:** `catchup.py build` kept no backup, so a refused DB write or a corrected spec meant re-bootstrapping. Now `build` keeps the WORK it started from in `WORK/prev/`, and `catchup.py restore WORK` undoes the last build. Rebuilding a RUN without restoring says exactly that instead of `AssertionError: []`.
- **R1:** the page's database has no version-checked writes or transactions, so the importer now:
  - holds a 2-minute import lease (`refresh/importLock`), so two open copies of the page can't import at once
  - reads `meta/chat` and the newest chunk fresh from the store instead of trusting snapshots
  - **repairs a half-finished import** (chunks saved, `meta/chat` not updated) on the next paste (`REPAIRED: …`) instead of refusing every import from then on
  - refuses, with instructions, when `meta/chat` is ahead of the saved messages
  - writes nothing, not even a repair, unless the capture passes every check
- **G1 (part):** after republishing a page, set `meta/chat.pageVersion`, so it isn't republished on every run.

### Changed
- SKILL.md › Refresh steps:
  - republish the page when `meta/chat.pageVersion` is behind `PAGE_VERSION`
  - the new import messages
  - `catchup.py restore WORK` before a rebuild or after a refused write
  - two new Troubleshooting entries

### Tests
- `tests/test_catchup.py`: 7 restore tests replace the B2 known-bug test.
- `tests/page.test.js`: 17 R1 checks (half-finished import, interrupted chunk rollover, counters ahead, lease held elsewhere, stale snapshot, runtime without `acquire`). Against the v1.1.2 page they fail: it gets stuck at "The newest stored chunk doesn't end at #-1".

Components: **`PAGE_VERSION` 1.2** (was 1.1), helper 1.1 (unchanged).

## [1.1.2] - 2026-11-06
No change to the skill itself. Enforcement for the PR workflow.

### Added
- GitHub Actions (`.github/workflows/test.yml`), three jobs:
  - `test` runs `npm test` on every PR and on `main`.
  - `version-bump` fails a PR whose `VERSION` isn't higher than the base branch, or is already tagged.
  - `pr-only` turns `main` red if a commit lands there without a merged PR.
- `.githooks/pre-push` blocks direct pushes to `main` from a local clone; `npm run setup` installs it (`npm run hooks`).

### Notes
- GitHub branch protection and rulesets aren't available for this private repo on the current plan (GitHub Pro required), so CI and the local hook are the enforcement (BACKLOG R8).

Components: `PAGE_VERSION` 1.1, helper 1.1 (unchanged).

## [1.1.1] - 2026-11-06
No behavior change for users. Re-upload the skill ZIP to pick up the renamed build tool.

### Changed
- Build tool renamed `scripts/cctool.py` → `scripts/catchup.py` (same commands); SKILL.md updated.
- Helper functions renamed `ccScan`/`ccVerify`/`ccCapture` → `mcScan`/`mcVerify`/`mcCapture`; page copy regenerated.
- Page accepts only the `mc-capture` kind (`cc-capture` dropped; the generic skill never produced it).
- The skill ZIP now includes `VERSION`.

### Added
- `npm test`: Python tests for `catchup.py` and the repo, the helper on a simulated Messenger (new case: a message deleted mid-run must abort), and the page in Chromium with a stand-in claude.ai runtime (full capture → import → build → render pipeline).
- `tools/sync-helper.py` (`npm run sync`) keeps the page's copies of the helper in sync.
- Release process: `VERSION`, this changelog, `CLAUDE.md`, a PR template, tags and GitHub releases.
- Handoff docs: `docs/STATUS.md`, `docs/ARCHITECTURE.md`, `docs/BACKLOG.md`.

### Found
- B11: `catchup.py` ignores Messenger's reply link when the parent is message #0 (open, test written).

Components: `PAGE_VERSION` 1.1, helper 1.1 (unchanged).

## [1.1.0] - 2026-11-06
The generic, shareable skill as it stood before the handoff review (commits `45afe28` … `9c353de`, tagged retroactively). History in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) › Phase 6.

Components: `PAGE_VERSION` 1.1, helper 1.1.
