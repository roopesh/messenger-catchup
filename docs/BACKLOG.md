# Backlog

Everything open: bugs, risks, gaps between docs and code, cleanup, tests and feature ideas. Started Nov 6, 2026 from a full read of the code at `9c353de`, the simulated-Messenger tests, a `cctool.py` (now `catchup.py`) replay and a date-parser probe ([EXPERIMENTS.md §10](EXPERIMENTS.md#10-handoff-review-nov-6-evening)). Updated after the Phase 8 rename and test build-out ([§11](EXPERIMENTS.md#11-rename-and-test-build-out-nov-6-late-evening)).

**Tests for open bugs:** none open. A test for an open bug is marked as known (`expectedFailure`, `known()`); when the bug is fixed, remove the marker.

**Priority:** P1 = fix before relying on it more · P2 = next round · P3 = when convenient.
**Open items only.** When an item is finished, remove its row and its section in the PR that finishes it, and close its GitHub issue (`Closes #N` in the PR). CHANGELOG.md keeps the history, by ID. Every open GitHub issue is triaged: it gets a row here with its issue number, or is closed as won't do with a reason. Finished items were removed on Nov 14, 2026; earlier versions of this file have them.

## At a glance

| ID | P | Type | Title |
|---|---|---|---|
| B53 | P2 | bug | A first scan with a count can stop at a false "top of chat" and store a short history as the whole chat |
| B55 | P3 | bug | Chrome names ("Browser 1", "Browser 2") swap when the extension reconnects, so helper notices can name the wrong Chrome |
| B56 | P3 | bug | Several-chats page oddities: a pending chat shows the first chat's stats; All chats' "need you" count disagrees with the rows |
| B57 | P3 | bug | All chats: chat names in the cards are misaligned (one centered, one right-aligned, the tag pill at the left) instead of lining up left, right after the tag |
| L1 | P3 | check | Live checks still to do, gathered from finished items |
| R3 | P3 | risk | The helper reads Messenger's English labels and markup; a change shows as a warning, except when every marker of a feature changes at once |
| R5 | P2 | risk | E2EE chats untested live; `messenger.com` not supported |
| R18 | P3 | risk | Now that a chain run arms as it starts, a run still going when the next one fires (`every` minus 3 minutes after it started) has a lock older than 20 minutes for usual settings, which the next run takes over |
| R20 | P3 | risk | Archive pages before the 1 GB fills: move old photo packs to archive pages, byte for byte and checked, before a page reaches 1 GiB |
| R19 | P3 | risk | Claude's own maintenance writes (link cleanup, a backfill) hold the refresh lock while the user's approval waits, often past the lock's 20 minutes |
| R17 | P3 | risk | Between a merge and its release, the page's "helper is behind" notice points at the old helper: marketplace installs get the new skill at the merge, but `releases/latest` still serves the old userscript |
| F1 | P3 | feature | Several chats per page: stage A shipped (v1.35.0); B (one schedule) and C (across chats) left |
| F25 | P2 | feature | Catch up with Facebook group posts too, not just Messenger group chats (the owner's request, Nov 14; to design) |
| F30 | P2 | feature | Send queued replies without a full refresh: part 1 ("send replies", replies first) in v1.27.0; option C step 1 (the `reply-check` skill) in v1.34.0; measured (0.2% of a 5-hour session per check); scheduling it ("schedule reply checks") in v1.37.0; left: arm it on the owner's account (every 10 minutes, 5 AM–10 PM) and check it, then make the interval and hours changeable in the page |
| F34 | P2 | feature | Add a chat by name, with suggestions: type a name in Settings › Add a chat (or tell Claude "add <name>") and pick from matching chats, instead of pasting the Messenger link, and history chosen in days rather than messages (the owner's requests, Nov 23; to design) |
| F33 | P3 | feature | Windowed loading of day summaries for very long histories (deferred from F29; only past about a year of days, or a measured threshold) |

## Bugs

### B53 · P2 · False "top of chat" on a first scan
- **Seen (Nov 23, the owner's test chat's first refresh):** a `full` scan with `first:{count:400}` returned `top:true` with 90 messages, although a 200-message scan minutes earlier had read further back. The retry was fine.
- **Why it matters:** `helper.md` says `top:true` on a first run means the chat is shorter than asked, so a refresh following it would store 90 messages as the chat's whole history.
- **Likely cause:** the helper takes a short pause at the top (no new messages, no spinner) as the chat's start when the scan asks for a count. Fix: confirm the top (the chat's start marker, or a second longer wait) before reporting `top:true`; add a sim case with a slow load at the top.

### B55 · P3 · Chrome names swap on reconnect
- **Seen (Nov 23):** when the Claude in Chrome extension reconnected, the Chrome named "Browser 1" became "Browser 2" and the other took "Browser 1". `versions.browsers` is keyed by these names, so the page's helper notices can name the wrong Chrome.
- **To do:** key by something stable (the extension's device id, with the display name alongside) or tell the user the names can change.

### B56 · P3 · Several-chats page oddities
- **Seen (Nov 23, owner's page 4.2):** while the owner's test chat was pending its view showed the first chat's stat row; one load after activation opened on the first chat instead of All chats (a reload fixed it); All chats in the picker said "6 need you" while the rows said 5 and 3.
- **To do:** reproduce each in the page tests (pending chat view, opening view, picker total) and fix.

### B57 · P3 · All chats: chat names misaligned in the cards
- **Seen (Nov 23, owner's page 4.3):** in All chats, each card's title sits in a different spot (for example Book Club centered, Camera Club right-aligned) while the tag pill sits at the left. They should line up left, right after the tag.
- **Likely cause:** the `.chathead` flex layout, or `text-wrap: balance` on `h2`/`h3`.
- **To do:** a page test that each card's title starts just right of its tag, then the fix.

---

## Risks

### R3 · P3 · Messenger markup and English labels
- **What:** the helper reads English UI labels, `[role="log"]`, `data-message-id`, "Go to replied message", "Reply to this message" and the `At <time>, <name>: ` aria-label shape. Since v1.20.0 (helper 2.0), a changed label shows as a warning or a `selfcheck` failure instead of wrong data.
- **What remains:** a change to every marker of a feature at once (for example all three reply markers) still reads as "none" rather than a warning. A non-English Messenger warns and continues.

### R20 · P3 · Archive pages before the 1 GB fills
What's left of R13 (closed in v1.35.1): the owner's decided option E + S (Nov 21). Its release 1 shipped in v1.30.0 (day packs, previews, captions, photo search) with v1.31.3's leftover-originals fix, and was verified on the owner's page on Nov 22 (1,194 files → 151, 149 MB → 111 MB, no photo lost). Day packs ended the 5,000-file limit; the 1 GiB is left.
- **Start when:** a page passes about 600 MB (`meta/chat.assetUsage.bytes`), or a few months before its estimated fill. The owner's page: estimated May–October 2027 at 40–80 photos a day, about 60 KB each (a full pack holds the photos as base64, a third bigger than the files, plus about 8 KB of preview per photo: roughly 6 MB a day). Sooner with each added chat that stores photos (F1: `meta/chat.assetUsage.byChat` shows each chat's share).
- **The plan (option E):** move the oldest full packs (`photos/packs`) to archive pages by server-side copy, byte for byte, checked by sha256 from the asset listings before the main page deletes its copy; previews stay on the main page, so old photos still show inline as previews, full size one click away in the archive.
- **What's known:** a page can't show another page's images (blocked for image tags and fetches; tested Nov 15), and claude.ai copies assets between pages server-side, byte for byte, 10 per call. Unknown: whether a link can open an archive page at a given photo.
- **The owner's rules (Nov 17):** keep every photo (no rolling window), findable by search; it must work for other users at volumes we can't predict. Re-encoding photos was ruled out.
- **Reuse by fingerprint (option, the owner leans towards it):** before uploading, reuse an existing asset with the same content (the asset listing gives each file's sha256 of its raw bytes; the page's `h` is a hash of the base64 text, so the two would need aligning). Only worth building if this work moves or re-uploads photos.
- **Also:** packing runs only while the owner has the page open on claude.ai (Claude's page tab holds the run lock); if it lags, give it time in the refresh, or have setup offer the switch for new pages.

### R17 · P3 · The helper notice runs ahead of the release
- **Found:** the review of F5 (PR #42). Marketplace installs pick up a merge on `main` at once, so the next refresh writes the new `versions.helper`. Self-updating helpers fetch from `releases/latest`, which `tools/release.sh` publishes only after the merge. In between, notice E tells the user to check for updates or open the install link, and both still give the old helper; the notice stays until the release is out and the helper has updated.
- **Wider since v1.35.1:** the page carries the helper version it shipped with (`HELPER_VERSION`) and flags any Chrome behind it, so every page republish between a merge that bumps the helper and its release asks users for a helper `releases/latest` doesn't serve yet (minutes, until `tools/release.sh` runs), not only after a refresh writes the new `versions.helper`.
- **Options:** run `tools/release.sh` straight after every merge that bumps the helper (today's practice, so the gap is usually minutes); or have the page hold E until a day after `versions.helper` first appears (a `since` the skill keeps), which the owner turned down for F5 ("flagged right away").

### R5 · P2 · E2EE and messenger.com
- **What:** `/messages/e2ee/t/` URLs are stored and used but untested against a live E2EE chat. The userscript `@match` covers only `www.facebook.com/messages/*`, so `messenger.com` isn't supported.

### R18 · P3 · A run older than the lock's 20 minutes when the next one fires
- **What:** since R14, a chain run arms as it starts, so the next run fires `every` minus 3 minutes after this one started, not after it ended. If this run is still going then (a large backlog, a long photo wait, a slow outbox) and `every` is 23 minutes or more, its `refresh/status` lock is more than 20 minutes old, and the next run treats it as stale and takes over. That run scans in the same Messenger tab. Pinned writes keep the database whole: a run whose write is refused while the other's `running` is in `refresh/status` stops (writing-the-build.md › Refused writes). But the two can disturb each other's scan, and the first to finish marks the status done while the other is still going. Before R14 this could only happen with a refresh the user asked for. `references/scheduling.md` › A scheduled run, Overlap, describes it.
- **Unverified, check live:** a follow-up that comes due while this conversation is mid-turn (the run it would follow is still going) may be queued until the turn ends, or dropped. If the scheduling tool drops it, the chain stops at that run, and only a refresh the user asks for finds it stopped. Check with each follow-up tool (a short `every` and a run kept busy past it).
- **Fix (if it shows up):** have a run that finds the lock 20+ minutes old check `lastRunAt` and the lock's `step` before taking over, or renew `startedAt` at each step.

### R19 · P3 · Claude's maintenance writes hold the refresh lock through slow approvals
- **Found (Nov 14, live):** the cross-conversation link cleanup and the F16 digest backfill take the `refresh/status` lock, then write, and each write waits for the user's approval in the UI. Approvals took from minutes to 5.5 hours. Once the lock is 20 minutes old, scheduled refreshes treat it as stale and take over. Pinned writes kept the database whole: the cleanup was refused twice (`version_mismatch`) and landed on the third try, and the backfill's digest write landed, but its lock release was refused because a refresh had already replaced the status.
- **Options:** writes that only touch documents refreshes never write could skip the lock and rely on the pin (since v1.32.0 the backfill writes `daySummaries/d…` of past days, which refreshes write only for the newest days); or the lock, the write and its release go in one batch, so there's one approval and no stale window; or `references/day-summaries.md` › Backfill and the cleanup procedure say to re-read and re-pin after a slow approval instead of assuming the lock held.

## Features and opportunities

### F1 · P3 · Several chats
- **Decided Nov 22 (option A):** one page, Messenger Catch-up, holds several chats; the title is the picker and a fresh load opens on All chats; each chat has a fixed key and a tag the owner can rename; people stay separate per chat; the owner manages chats on the page. The prototype, the decisions and the 130-case test plan were reviewed by the owner before the build.
- **Stage A shipped in v1.35.0:** chats in one page with the first chat's documents untouched, added chats in collections under their key, the picker, All chats, each chat's tabs, Needs you and Mark caught up per chat plus Mark all caught up, Settings › Your chats (add, tag, pause, remove with delete or keep hidden, replies per chat), the paste guard and helper 2.3's chat check, `catchup.py --chat`. Not automated from stage A's cases: the claude.ai spikes and checks (SPK1's characters were settled from the runtime contract: letters, digits and `_ - . ~ : @ +`, so `cam_chunks` is valid; SPK3's tab move is covered by sim HP1 only; SPK4: the contract's `assets.list()` gives `sizeBytes`), MIG7 and the end-to-end add (SET4, SET13: a test chat on a scratch page), HP4–HP6 and HP8–HP10 (Claude's own steps in the real Messenger; the sim has one thread), RF8/RF9/OB3/OB5/OB6/LK7 (Claude's steps, in `references/chats.md`, checked live), CT8 and SET10 (nothing across chats shows saved answers until stage C; setup's add is documented to write the page's entry), STO3/STO4/STO7 (packing and quota run per chat on the chat open on the page, as before; no estimate exists yet), PH7 (the phone on claude.ai).
- **Stage B, one schedule across chats:** one scheduled run refreshes every chat one after another in the order dragged in Settings › Schedule, with the 15-minute cap and its "Not refreshed this run — time limit" flag, failures kept to their chat (`refresh/status.chats.<key>`, a beat-based lock), "How often" per chat, and photo packing for every chat (stage A packs the chat open on the page; under All chats, the first chat). Also `reply-check`'s one query covers the first chat's `outbox` only: add each chat's `KEY_outbox` with the schedule. Page 4.2. Tests RF (but RF8, RF9, RF11, RF12), LK, SET8, SET9, SPK5.
- **Stage C, across chats:** one Ask over every chat with keyed citations (`[book#412]`) and the match list (newest first or by chat, a chip per chat), full names across chats, Stats comparing the chats, By day on All chats and the summary across chats (`allchats/summary`). Tests SR, SD, CT2, CT3, PH5, SPK2.
- Related: F25 (a Facebook group on the same page).
- **Polish noticed in stage A's claude.ai check (Nov 22), for stage B:** a pending chat's kicker shows no chat name and an empty "Show messages" box; on wide screens a chat's name on its All chats card sits centred rather than beside its tag; removing a chat with no documents says "frees 0 files, 1 KB"; the URL keeps the last tab's hash on All chats; Settings' "Saved." notes linger after reopening.


### F25 · P2 · Catch up with Facebook group posts
- **Ask (owner, Nov 14):** besides a Messenger group chat, catch up with the posts in a Facebook group.
- **How it differs:** a group is a feed of posts (text, photos, links), each with its own comment threads and reactions, at `facebook.com/groups/<id>`, not a single message log. The feed's default order isn't by time, posts and comments load lazily, and old posts get new comments, so "what's new since I last looked" means new posts **and** new comments on older ones. Claude in Chrome reads it from the owner's own logged-in Chrome, as for Messenger, read only.
- **To design with the owner:** which groups; what counts as new; one page per group or groups on the chat's page (F1 is related); what the summary covers (posts, comment threads, deals in buy/sell groups, mentions); whether replying is in scope; how capture works (a helper mode for the group feed, sorted by new activity) and its markup risks (like R3).

### F33 · P3 · Windowed loading of day summaries for very long histories
- **Today (v1.32.0):** the page listens to the whole `daySummaries` collection, as it does its other collections, and By day, Ask, Views and the `day_summaries` tool use the summaries in memory. The owner's page has about 55 days, roughly 0.5 MB. F29 built a window (the newest days live, older ones read on demand) and dropped it after three reviews kept finding faults in it; this item is that work, done in small pieces when it's needed.
- **Trigger:** only when a page's day summaries pass about a year of days, or a load time or size threshold measured on the real runtime. Measure first; don't build ahead of it.
- **Pieces, each its own PR with its own claude.ai check:**
  - **(a) Measure:** load time and size of the collection on the real runtime at a few sizes; set the trigger from that.
  - **(b) By day's live window:** an ordered, limited `onSnapshot` of the newest days, falling back to a plain listener when the runtime refuses it (its error callback); which days the window covers recomputed from every snapshot.
  - **(c) "Show more" on demand:** `where("day","in",…)` reads, at most 30 values a query; the cards already drawn stay while a read runs (no flicker); only confirmed misses are cached.
  - **(d) Ask's and Views' older history:** read the days a prompt would carry with a timeout, then send with what's known while late answers still land in memory; concurrent reads of the same days deduped, judged by whether the summary is in memory, not by who started the read; a note in the answer when days couldn't be read.
  - **(e) The `day_summaries` tool reading older days:** first confirm the real runtime awaits an async `execute` (sample.d.ts 0.2.98 says "May be async"; the owner's page may run an older runtime).
  - **(f) Tests per piece, plus the real-runtime checks:** an ordered snapshot, an `in` read, an async tool, and the consent code.
- **Pitfalls the F29 reviews found in the removed code:**
  - A day found to have no summary was asked again after an expiry, so cards flickered and reads repeated.
  - A read answering after its timeout was dropped instead of landing.
  - Whether a read brought summaries was judged by who started it, so a caller joining a read already running sent without them.
  - The coverage stuck after the collection grew past the window (a backfill), so a day leaving the window looked like it had no summary.
  - No fallback when the ordered snapshot was refused, and at first no timeout on reads, so Ask or the tool could hang.
  - Packing a prompt to learn which days to read, then again after the read, doubled the packing work (H16); reuse the first pack when nothing came in.
  - "Loading older days…" stopped the list at each unread day, and a redraw dropped cards already drawn.

### F30 · P2 · Send queued replies without a full refresh
- **Ask (owner, Nov 16):** be able to send replies queued on the page without a full refresh, if possible.
- **Today:** a reply queued on the page (`outbox/*`) goes out only at step 8 of a refresh (SKILL.md › Refresh steps; `references/outbox.md`), after the scan, import, build and write. With hourly refreshes, a queued reply can wait up to about an hour, and sending one costs a whole refresh.
- **Limits:** only Claude can reach the Messenger tab (through Claude in Chrome). The page can't, and the helper in the Messenger tab can't read the page's database. So something still has to start Claude. The change is how little that run does.
- **Options to weigh:**
  - **A "send my replies" request:** reads the outbox, posts each approved reply (`outbox.md`), and confirms it with a short scan of the newest messages. No import, build or summary. Much cheaper and faster than a refresh.
  - **Scheduled runs send first:** every scheduled run handles the outbox before (or instead of) the rest when the scan finds nothing new. Pairs with a cheap "nothing new" exit.
  - **A sooner follow-up:** queuing a reply on the page arms a run a few minutes out instead of waiting for the hour. Needs a way for the page to wake Claude, which it may not have; check what the runtime allows.
- **To settle:** how soon a reply should go out; whether a reply-only run confirms by its own short scan or leaves that to the next refresh (`sentAt` and `sentMid` today come from the confirm and the next capture, B46); and the approval rules, which stay as they are (`outboxAuto`, or a yes in chat to that exact text).
- **Related:** B45 and F13 (how posting works).
- **Owner's answers (Nov 17):** decide in the moment, or else within a few minutes; at the Mac or on the phone; the phrase "send replies"; picked frequent checks and asked to keep tokens down.
- **Revised recommendation:** frequent checks stay costly however small the skill (each is a whole session), so: a "Send now" button per queued reply that copies it and opens the message in Messenger with Reply open (the existing Reply link); the owner pastes and presses Enter, and the next refresh marks it sent. Plus scheduled runs posting queued replies first, and the "send replies" phrase for the phone. A later step: the helper types the reply in so only Enter is left. Option E, the page handing replies to the helper directly, would change the rule that only Claude's bridge command can make the helper post; it needs a probe.
- **Part 1 in v1.27.0 (Nov 19):** the `replies` skill ("send replies" posts queued replies with no refresh) and replies first in every refresh. Left: measure what an empty reply run costs, then set C's interval with the owner (or not); option F (Send now opens the message in Messenger with the reply ready) if the owner wants it; a live check of the routing and a reply run end to end (L1). A reply run skips outbox.md's stored-message check (it would read a chunk); call 1 and `post` still check the live "Replying to" bar.
- **Option C, step 1 in v1.34.0 (Nov 22; the owner chose C and "measure first"):** the `reply-check` skill ("check replies", "reply check", or a message starting "Scheduled reply check"): one `ArtifactData query outbox` for a `queued` row (`limit` 1); none: one line and stop; one: it hands over to `messenger-catchup:replies`, which checks approval and the lock and posts. Rows in `sending` don't count (replies leaves them for the next refresh). Nothing schedules it yet. **Step 2, with the owner:** measure what an empty check costs on the owner's account (tokens and time per run), then choose the schedule: every 5, 10 or 15 minutes, 5 AM–10 PM like refreshes (`meta/chat.schedule.hours`), and how it's armed (`references/scheduling.md`; its "A scheduled run" rule must not take a "Scheduled reply check" message for a refresh). Also to weigh then: with `outboxAuto` off, a queued row makes each check hand over and replies lists it for a yes, so an unapproved reply is listed at every check until answered.

- **Owner's choice (Nov 23, after the measurement):** every 10 minutes, only 5 AM–10 PM. Measured: about 16 s and 0.2% of a 5-hour session per empty check (10 checks moved the session meter 30% → 32%, the week not at all).
- **Step 2 in v1.37.0 (Nov 23):** setup arms the checks on request ("schedule reply checks", "check replies every 10 minutes", "change reply checks to every 15 minutes", "stop reply checks"; `references/scheduling.md` › Reply checks): a recurring task tied to this computer whose cron carries the interval and the hours (`*/10 5-21 * * *` in `tz`), prompt `Scheduled reply check (recurring <armId>): …`, the choice in `meta/chat.replyCheck` `{every, hours, tz, armId}` (hours default to the refresh schedule's). A check stays one read: no token or settings read; changing arms a new task and disables the old one by its `armId`. A scheduled check never asks: with auto-posting off, replies lists the waiting rows and stops (each check lists them again until the owner answers with "send replies").
- **Left:**
  - **Arm it on the owner's account and check it:** in a Claude app whose tool list has the recurring tool with the device requirement (see `references/scheduling.md` › Tools), say "schedule reply checks"; confirm the result says it's tied to this computer, the approval mode, that an empty check costs about what was measured, and that a reply queued on the page goes out within 10 minutes. Watch for the task pausing after a check finds the computer asleep (LEARNINGS: a device-bound task pauses for good on `device_absent`).
  - **Added chats aren't checked:** a check reads only the first chat's `outbox`, not an added chat's `KEY_outbox` (F1); covering them costs a read per chat per check. Decide with the owner.
- **Later (owner, Nov 23): change the interval and hours in the page,** picked up at the next check with no re-arming. A fixed recurring task can't change its own cron, and a check that reads its settings costs a second read on every run, so this needs a design: for example a chain (each check arms the next from `meta/chat`), or a recurring task at the shortest interval offered whose checks skip cheaply when not due. Measure the skip's cost first.

### F34 · P2 · Add a chat by name, with suggestions
- **Asked (owner, Nov 23):** type a chat's name and have it found, or similar matches recommended: the owner remembered a chat by an old name. "The UI should be able to search my chats and find similar ones and suggest them as options. Getting the link is a shitty user experience."
- **Today:** Settings › Your chats › Add a chat needs the chat's Messenger link (v1.35.0, F1 stage A).
- **The constraint:** the page can't read Messenger (separate origins), so the search has to run where Messenger is: through the helper in the Messenger tab, or through Claude (Claude in Chrome).
- **Likely flow, to design:** the owner types a name in Settings › Add a chat → the page saves a find request → the next Claude run (or a Claude chat "add <name>") searches the owner's Messenger chat list and search for exact and similar names (old names, partial matches) and writes candidates back (name, member count, last activity, link) → the page shows them as options; picking one adds the chat as today. For example, "Camera" offers Camera Club and Camera Swap. Claude in chat accepts "add <name>" with the same suggestions.
- **History as days, not messages (owner, Nov 23):** Add a chat asks how far back to read as a number of days (for example 1, 7, 30, everything), not a message count. Today the helper's first scan stops at `first:{count}`; add a date bound (stop at the first message older than the cutoff, or the top of the chat) and store `start` as days. The owner's test chat's first refresh (1 day) used a count picked to cover 24 hours as a stopgap.
- **Open questions for the owner (later):** how fast suggestions should appear (at the next refresh, or on demand), and how many to show.

### L1 · P3 · Live checks still to do
Gathered from finished items when they were removed (Nov 14). The item each came from is in brackets; CHANGELOG.md has its history.
- **Scheduling (R6):** `send_later` in a Desktop chat with a 2-minute delay, with Desktop open and with it quit; the longest `delay_minutes` it takes (an overnight arm needs 8 h or more; if it's shorter, arm in steps); whether `send_later` from inside a follow-up asks for approval; `create_trigger`'s exact result text under each approval mode; a `CronCreate` chain in the CLI firing twice; a second delivery taking the stale path; the owner's `mode:"loop"` page switching when the owner types a refresh in a new chat (its old chain should then end at its next follow-up).
- **Day-summary backfill (F29):** before running the backfill of past days (only when the owner asks), estimate its cost from the number of stored days and messages and tell the owner first.
- **Update notices (F5):** whether an open tab reloads by itself after a republish (notice A's wording), and what `list_connected_browsers` calls a single Chrome. The claude.ai menu path "Customize › Plugins" was confirmed on Nov 14.
- **Ask over long histories (F6, the design's L2–L7):** "include older" answers carry a note like "Read #… word for word. Older than #…: summaries only." and no "(sent a smaller set…)"; answers about things 1 to 3 weeks old cite numbers and say when they rest on summaries or digests; Views on a 5-day window; a long span before `fromI` refused with a start time; what `sample.limits()` returns in the real runtime.
- **Replies across conversations (F23):** on the owner's page, the 27 mid-conversation Messenger replies whose parent sits in another conversation each show "↩ replying to …" above the bubble, and a few of them open their parent, one on a day Show older hasn't loaded.
- **Helper (B41, B49, F13):** whether Messenger puts a run's avatar on its last message or its first (either works if each run shows one); whether its loading indicator is a `[role="progressbar"]` at the top of the list; whether it accepts the helper's synthetic Enter and shift+Enter for `post`.
- **Plugin updates (F7):** settled on Nov 14. The owner's account showed the custom-marketplace plugin at 1.25.0 within hours of the merge. The skills stayed old because of an uploaded copy of the skill (Customize › Skills), not the chain.
- **Photos and captions (R13, v1.30.0):** the owner's page reached page 3.6 on Nov 22. Still to check there: captions on hover and in the photo viewer, caption search, the Photo storage box; after the owner turns packing on, `photos/packs` growing and `assetUsage.files` falling.
- **Leftover originals (v1.31.3):** after the owner's page gets 3.9: leftover originals reclaimed (`photos/packs.reclaim.n` rising to about the count left behind, `reclaim.checked` reaching the list's length, no `photos/swept-*` documents, or any there explained), the Photo storage box saying how many were removed, and the file count falling by each packed day's photos less 2 from then on. With two copies of the page open, the one that waits says "Waiting: packing is running in another open copy of this page."
- **Chain length (R12, closed Nov 22):** the owner's schedule now runs hourly 5 AM–10 PM with no overnight runs (`meta/chat.schedule.hours`), so the chain conversation grows more slowly. When it first stops at claude.ai's conversation length limit: the page flags the stopped chain, and the refresh phrase in a new chat restarts it in a fresh conversation.
- **Several chats, stage A (F1, v1.35.0):** on a scratch artifact on claude.ai before merging: the picker, All chats, each chat's tabs, Settings (add, tag, pause, remove both ways, replies), a citation from All chats switching the chat (the viewer handles navigation its own way, CT9), reload opening on All chats (PG1), at phone width (PH7); collection names like `cam_chunks` in the real store (SPK1) and `assets.list()` sizes (SPK4). After release, on the owner's page: the upgrade wrote only `meta/chat.chats` (list every collection before and after: MIG7), the page reads 4.1 and shows the same counts. Then Claude adds one test chat through the page and checks its first refresh end to end (SET4, SET13), and nothing more.
- **Scan start (Nov 21):** one scheduled refresh failed with "Scan didn't start scrolling…"; the next runs were fine. If it happens again, file it as a bug with the run's report.
