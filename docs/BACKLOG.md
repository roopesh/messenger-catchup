# Backlog

Everything open: bugs, risks, gaps between docs and code, cleanup, tests and feature ideas. Started Nov 6, 2026 from a full read of the code at `9c353de`, the simulated-Messenger tests, a `cctool.py` (now `catchup.py`) replay and a date-parser probe ([EXPERIMENTS.md §10](EXPERIMENTS.md#10-handoff-review-nov-6-evening)). Updated after the Phase 8 rename and test build-out ([§11](EXPERIMENTS.md#11-rename-and-test-build-out-nov-6-late-evening)).

**Tests for open bugs:** none open. A test for an open bug is marked as known (`expectedFailure`, `known()`); when the bug is fixed, remove the marker.

**Priority:** P1 = fix before relying on it more · P2 = next round · P3 = when convenient.
**Open items only.** When an item is finished, remove its row and its section in the PR that finishes it, and close its GitHub issue (`Closes #N` in the PR). CHANGELOG.md keeps the history, by ID. Every open GitHub issue is triaged: it gets a row here with its issue number, or is closed as won't do with a reason. Finished items were removed on Nov 14, 2026; earlier versions of this file have them.

## At a glance

| ID | P | Type | Title |
|---|---|---|---|
| L1 | P3 | check | Live checks still to do, gathered from finished items |
| R3 | P3 | risk | The helper reads Messenger's English labels and markup; a change shows as a warning, except when every marker of a feature changes at once |
| R5 | P2 | risk | E2EE chats untested live; `messenger.com` not supported |
| R12 | P3 | risk | A chain conversation's context grows with every run, so its cost rises over weeks; it also hits the conversation length limit |
| R18 | P3 | risk | Now that a chain run arms as it starts, a run still going when the next one fires (`every` minus 3 minutes after it started) has a lock older than 20 minutes for usual settings, which the next run takes over |
| R13 | P2 | risk | A page holds at most 5,000 photo files and 1 GiB: day packs (v1.30.0) end the file problem; archive pages for the 1 GiB are left |
| R19 | P3 | risk | Claude's own maintenance writes (link cleanup, digest backfill) hold the refresh lock while the user's approval waits, often past the lock's 20 minutes |
| R17 | P3 | risk | Between a merge and its release, the page's "helper is behind" notice points at the old helper: marketplace installs get the new skill at the merge, but `releases/latest` still serves the old userscript |
| T7 | P3 | test | Page test P5 (an import lease lapsing after a tab closes) failed twice in one full parallel run on Nov 22 and passed alone 3 times: timing under load |
| F1 | P3 | feature | More than one chat per page |
| F25 | P2 | feature | Catch up with Facebook group posts too, not just Messenger group chats (the owner's request, Nov 14; to design) |
| F29 | P2 | feature | Fuller day summaries for By day, kept current at every refresh and shareable; the short digest stays for Ask (builds on the refresh reports from F27, v1.29.0; notes in [design/day-summaries.md](design/day-summaries.md)) |
| F30 | P2 | feature | Send queued replies without a full refresh: part 1 ("send replies", replies first) in v1.27.0; the schedule for frequent checks is left |

---

## Risks

### R3 · P3 · Messenger markup and English labels
- **What:** the helper reads English UI labels, `[role="log"]`, `data-message-id`, "Go to replied message", "Reply to this message" and the `At <time>, <name>: ` aria-label shape. Since v1.20.0 (helper 2.0), a changed label shows as a warning or a `selfcheck` failure instead of wrong data.
- **What remains:** a change to every marker of a feature at once (for example all three reply markers) still reads as "none" rather than a warning. A non-English Messenger warns and continues.

### R13 · P2 · A page holds at most 5,000 photo files and 1 GiB
- **Found (Nov 12, live, read only):** the owner's page has 715 asset files against claude.ai's 5,000-file limit per artifact (bytes: 38.8 MB of 1 GiB), growing about 55 files a day, so it reaches the limit in roughly 11 weeks. There are also more files than indexed photos (715 against 549 in the old `byI`), probably copies from re-pastes before v1.22.
- **Now (v1.22.0):** the page records usage with each import and warns at 80%; `references/photos.md` › Cleanup removes copies and unused files on the user's say-so. That buys time, not a fix.
- **Corrected (Nov 14, full count, read only):** of 855 files, 853 are in use, each by exactly one slot; the 549 above was an undercount. No unused copies: the only unused files are 2 unique ones (163 KB) from one Nov 3 upload, left by the record loss v1.22.0 fixed. 4 pairs of identical files are both in use (the same photo posted twice). 876 files on Nov 14, so at 55–80 a day the limit arrives between early and late January.
- **Option for the design, reuse by fingerprint:** before uploading, reuse an existing asset with the same content (the asset listing gives each file's sha256 of its raw bytes; the page's `h` is a hash of the base64 text, so the two would need aligning). Today it would save 4 files, so it's only worth building if the design moves or re-uploads photos. The owner leans towards having it.
- **To design:** for example keep older photos as links only (Messenger's own, which expire), move older photos to an archive page with its own quota, or store a smaller copy of old photos. Each has costs (lost photos, a second page to maintain, re-encoding the owner ruled out for now).
- **Owner's answers (Nov 17, decision board):** keep every photo (no rolling window), findable by search such as "green ultra monolith"; it must work for other users at volumes we can't predict. Tested Nov 15: a page can't show another page's images (blocked for image tags and fetches), and claude.ai copies assets between pages server-side, byte for byte, 10 per call. 987 files and 56.6 MB on Nov 17.
- **Recommended (option E on the board):** the page makes a small preview of each photo (about 240 px) and packs each day's previews into one file; originals stay on the main page for about two months, then move to archive pages (copied server-side, checked by fingerprint before the main page deletes its copy). Old photos still show inline as previews, full size one click away in the archive. Two releases, both before the 4,000-file warning in late December. Unknown: whether a link can open an archive page at a given photo.
- **Add-on, photo search:** Claude captions each photo once from its preview, and search matches the caption together with the message and its conversation. About 30k tokens a day plus about 400k once (estimates); waiting on the owner.

- **Owner decided (Nov 21): E + S.** Built differently from the plan above, because files run out first (about 60 KB a photo; 1,131 files and 66 MB on Nov 21): **day packs (v1.30.0)** put each finished day's photos, byte for byte, into one pack plus one preview pack, checked by SHA-256 before the originals are deleted, behind the page's Photo storage switch. Photo captions and caption search (S) shipped in the same release.
- **Left (release 2): archive pages** for the 1 GiB, about 5 months out at the owner's pace (a full pack holds the photos as base64, a third bigger than the files, plus about 8 KB of preview per photo: roughly 6 MB a day): move the oldest full packs (`photos/packs`) to archive pages by server-side copy, checked by sha256 from the asset listings; previews stay on the main page. Also: packing runs only while the owner has the page open on claude.ai (Claude's page tab holds the run lock); if it lags, give it time in the refresh, or have setup offer the switch for new pages.

### R17 · P3 · The helper notice runs ahead of the release
- **Found:** the review of F5 (PR #42). Marketplace installs pick up a merge on `main` at once, so the next refresh writes the new `versions.helper`. Self-updating helpers fetch from `releases/latest`, which `tools/release.sh` publishes only after the merge. In between, notice E tells the user to check for updates or open the install link, and both still give the old helper; the notice stays until the release is out and the helper has updated.
- **Options:** run `tools/release.sh` straight after every merge that bumps the helper (today's practice, so the gap is usually minutes); or have the page hold E until a day after `versions.helper` first appears (a `since` the skill keeps), which the owner turned down for F5 ("flagged right away").

### R5 · P2 · E2EE and messenger.com
- **What:** `/messages/e2ee/t/` URLs are stored and used but untested against a live E2EE chat. The userscript `@match` covers only `www.facebook.com/messages/*`, so `messenger.com` isn't supported.

### R12 · P3 · A chain conversation keeps growing
- **What:** every hourly run adds tool output to the same conversation, so each run costs more over weeks. Predates v1.21.0. Arming at `every` minus 5 minutes (minus 3 from a run's start since v1.23.0) keeps runs inside the prompt cache, but the context still grows.
- **Also:** a claude.ai conversation has a hard length limit. Once a chain's conversation reaches it, follow-ups can't be delivered and the chain stops (a refresh the user asks for then finds it stopped).
- **Corrected (Nov 14):** a note here said a chain seems to keep the skill version it started with. The real cause was an older copy of the skill uploaded to the owner's account (Customize › Skills), which refreshes used instead of the 1.25.0 plugin; a refresh the owner started by hand ran it too. Nothing on the page could flag it, since that copy wrote a matching `versions.page`.
- **Fix:** measure a chain's cost per run after a week or two; if it climbs, or the conversation nears its limit, have a run move the chain to a fresh conversation now and then (setup's Stop or change, then arm from the new one).
- **Reanalyzed (Nov 22):** a fresh session per run (Desktop scheduled tasks) didn't work right for the owner, and R10/R11 are closed, so the chain stays. What's left: runs slowly cost more, and at the length limit the chain stops; the page flags a stopped chain (v1.24.0) and the refresh phrase in a new chat restarts it in a fresh conversation. Recommended on the board: close R12 and keep a live check for the first stop (L1). Waits on the owner.

### R18 · P3 · A run older than the lock's 20 minutes when the next one fires
- **What:** since R14, a chain run arms as it starts, so the next run fires `every` minus 3 minutes after this one started, not after it ended. If this run is still going then (a large backlog, a long photo wait, a slow outbox) and `every` is 23 minutes or more, its `refresh/status` lock is more than 20 minutes old, and the next run treats it as stale and takes over. That run scans in the same Messenger tab. Pinned writes keep the database whole: a run whose write is refused while the other's `running` is in `refresh/status` stops (writing-the-build.md › Refused writes). But the two can disturb each other's scan, and the first to finish marks the status done while the other is still going. Before R14 this could only happen with a refresh the user asked for. `references/scheduling.md` › A scheduled run, Overlap, describes it.
- **Unverified, check live:** a follow-up that comes due while this conversation is mid-turn (the run it would follow is still going) may be queued until the turn ends, or dropped. If the scheduling tool drops it, the chain stops at that run, and only a refresh the user asks for finds it stopped. Check with each follow-up tool (a short `every` and a run kept busy past it).
- **Fix (if it shows up):** have a run that finds the lock 20+ minutes old check `lastRunAt` and the lock's `step` before taking over, or renew `startedAt` at each step.

### R19 · P3 · Claude's maintenance writes hold the refresh lock through slow approvals
- **Found (Nov 14, live):** the cross-conversation link cleanup and the F16 digest backfill take the `refresh/status` lock, then write, and each write waits for the user's approval in the UI. Approvals took from minutes to 5.5 hours. Once the lock is 20 minutes old, scheduled refreshes treat it as stale and take over. Pinned writes kept the database whole: the cleanup was refused twice (`version_mismatch`) and landed on the third try, and the backfill's digest write landed, but its lock release was refused because a refresh had already replaced the status.
- **Options:** writes that only touch documents refreshes never write (the backfill's `digests/m…` while refreshes run an older skill; a refresh on v1.25+ does write them) could skip the lock and rely on the pin; or the lock, the write and its release go in one batch, so there's one approval and no stale window; or `references/digests.md` and the cleanup procedure say to re-read and re-pin after a slow approval instead of assuming the lock held.

### T7 · P3 · P5 is timing-sensitive under load
- **Found (Nov 22, v1.31.0 work):** in one full `npm test` (36 sections, 10 at a time), both P5 checks in `photos` failed ("Nothing new … 6 photos stored" where "Another import is running" was expected): the closed tab's lease seems to have lapsed before the second paste. The section passed alone 3 times, and the next full run passed.
- **Fix:** make the case independent of wall-clock time (move the stand-in's clock, or lengthen the lease the test sets) rather than retrying.

## Features and opportunities

### F1 · P3 · Several chats
- One page and one loop per chat today (LEARNINGS.md › Open issues). Simplest path: one page per chat, keyed by `meta/chat.thread`, and a loop that walks them.
- **Owner's answers (Nov 22, board):** chats to start with: two more groups, more later (count unknown); one Ask across chats with results clearly labeled by chat, and filters by chat ("if search is cheap, focus on result filters"); the same schedule for all, parallel if possible. Leans to option A (chats inside this page). **Before any build:** designs or prototypes and written test cases, reviewed by the owner.
- **Not on the decision board until Nov 22**, so it had no options or questions for the owner. To design: one page per chat or several chats on one page (tabs, a picker); one scheduled loop for all chats or one per chat, and what that does to cost and R12; how setup adds a second chat; whether search (F32) and Stats span chats. Related: F25 (a Facebook group on the same page).

### F25 · P2 · Catch up with Facebook group posts
- **Ask (owner, Nov 14):** besides a Messenger group chat, catch up with the posts in a Facebook group.
- **How it differs:** a group is a feed of posts (text, photos, links), each with its own comment threads and reactions, at `facebook.com/groups/<id>`, not a single message log. The feed's default order isn't by time, posts and comments load lazily, and old posts get new comments, so "what's new since I last looked" means new posts **and** new comments on older ones. Claude in Chrome reads it from the owner's own logged-in Chrome, as for Messenger, read only.
- **To design with the owner:** which groups; what counts as new; one page per group or groups on the chat's page (F1 is related); what the summary covers (posts, comment threads, deals in buy/sell groups, mentions); whether replying is in scope; how capture works (a helper mode for the group feed, sorted by new activity) and its markup risks (like R3).

### F29 · P2 · Fuller day summaries (to define)
- **The owner (Nov 15):**
  - The By day digests are weak.
  - Ask Claude's "summary of yesterday" is far better and doesn't match them.
  - Wants a fuller day summary, refreshed at every refresh, that they can choose to share.
- **Why:** a digest is capped at 8 bullets of 15 words, as a compact index for Ask's long-history prompt; By day shows those index cards.
- **Direction:** two levels.
  - Keep the short digest for Ask.
  - Add a fuller summary written by the refresh: incremental during the day, then one final rewrite after the day ends.
  - Sharing by "Copy for chat" and/or a shared link, the owner's call.
- **Everything discussed:** options, the owner's decisions, Claude's proposed shape and the open questions are in [design/day-summaries.md](design/day-summaries.md).
- **Builds on F27 (v1.29.0):** merge each day's saved refresh reports into its fuller summary at the day's end.
- **Owner decided (Nov 22, board option A):** one fuller summary per day instead of two levels, since Ask now searches the whole history (F32, v1.31.0) and no longer needs the short digest as its index. Kept current by each refresh, with one rewrite after the day ends. Sharing by "Copy for chat" only: no links ("I'm not opening up the artifact"). Today's summary in progress can be copied too. No length limit for now. Backfill past days once the owner likes the output of a few. Next to build.

### F30 · P2 · Send queued replies without a full refresh
- **Ask (owner, Nov 16):** be able to send replies queued on the page without a full refresh, if possible.
- **Today:** a reply queued on the page (`outbox/*`) goes out only at step 8 of a refresh (SKILL.md › Refresh steps; `references/outbox.md`), after the scan, import, build and write. With hourly refreshes, a queued reply can wait up to about an hour, and sending one costs a whole refresh.
- **Limits:** only Claude can reach the Messenger tab (through Claude in Chrome). The page can't, and the helper in the Messenger tab can't read the page's database. So something still has to start Claude. The change is how little that run does.
- **Options to weigh:**
  - **A "send my replies" request:** reads the outbox, posts each approved reply (`outbox.md`), and confirms it with a short scan of the newest messages. No import, build or summary. Much cheaper and faster than a refresh.
  - **Scheduled runs send first:** every scheduled run handles the outbox before (or instead of) the rest when the scan finds nothing new. Pairs with R12's cheap "nothing new" exit.
  - **A sooner follow-up:** queuing a reply on the page arms a run a few minutes out instead of waiting for the hour. Needs a way for the page to wake Claude, which it may not have; check what the runtime allows.
- **To settle:** how soon a reply should go out; whether a reply-only run confirms by its own short scan or leaves that to the next refresh (`sentAt` and `sentMid` today come from the confirm and the next capture, B46); and the approval rules, which stay as they are (`outboxAuto`, or a yes in chat to that exact text).
- **Related:** R12 (cheap runs), B45 and F13 (how posting works).
- **Owner's answers (Nov 17):** decide in the moment, or else within a few minutes; at the Mac or on the phone; the phrase "send replies"; picked frequent checks and asked to keep tokens down.
- **Revised recommendation:** frequent checks stay costly however small the skill (each is a whole session), so: a "Send now" button per queued reply that copies it and opens the message in Messenger with Reply open (the existing Reply link); the owner pastes and presses Enter, and the next refresh marks it sent. Plus scheduled runs posting queued replies first, and the "send replies" phrase for the phone. A later step: the helper types the reply in so only Enter is left. Option E, the page handing replies to the helper directly, would change the rule that only Claude's bridge command can make the helper post; it needs a probe.
- **Part 1 in v1.27.0 (Nov 19):** the `replies` skill ("send replies" posts queued replies with no refresh) and replies first in every refresh. Left: measure what an empty reply run costs, then set C's interval with the owner (or not); option F (Send now opens the message in Messenger with the reply ready) if the owner wants it; a live check of the routing and a reply run end to end (L1). A reply run skips outbox.md's stored-message check (it would read a chunk); call 1 and `post` still check the live "Replying to" bar.

### L1 · P3 · Live checks still to do
Gathered from finished items when they were removed (Nov 14). The item each came from is in brackets; CHANGELOG.md has its history.
- **Scheduling (R6):** `send_later` in a Desktop chat with a 2-minute delay, with Desktop open and with it quit; the longest `delay_minutes` it takes (an overnight arm needs 8 h or more; if it's shorter, arm in steps); whether `send_later` from inside a follow-up asks for approval; `create_trigger`'s exact result text under each approval mode; a `CronCreate` chain in the CLI firing twice; a second delivery taking the stale path; the owner's `mode:"loop"` page switching when the owner types a refresh in a new chat (its old chain should then end at its next follow-up).
- **Update notices (F5):** whether an open tab reloads by itself after a republish (notice A's wording), and what `list_connected_browsers` calls a single Chrome. The claude.ai menu path "Customize › Plugins" was confirmed on Nov 14.
- **Ask over long histories (F6, the design's L2–L7):** "include older" answers carry a note like "Read #… word for word. Older than #…: summaries only." and no "(sent a smaller set…)"; answers about things 1 to 3 weeks old cite numbers and say when they rest on summaries or digests; Views on a 5-day window; a long span before `fromI` refused with a start time; what `sample.limits()` returns in the real runtime.
- **Replies across conversations (F23):** on the owner's page, the 27 mid-conversation Messenger replies whose parent sits in another conversation each show "↩ replying to …" above the bubble, and a few of them open their parent, one on a day Show older hasn't loaded.
- **Helper (B41, B49, F13):** whether Messenger puts a run's avatar on its last message or its first (either works if each run shows one); whether its loading indicator is a `[role="progressbar"]` at the top of the list; whether it accepts the helper's synthetic Enter and shift+Enter for `post`.
- **Plugin updates (F7):** settled on Nov 14. The owner's account showed the custom-marketplace plugin at 1.25.0 within hours of the merge. The skills stayed old because of an uploaded copy of the skill, not the chain (see R12).
- **Photos and captions (R13, v1.30.0):** the owner's page reached page 3.6 on Nov 22. Still to check there: captions on hover and in the photo viewer, caption search, the Photo storage box; after the owner turns packing on, `photos/packs` growing and `assetUsage.files` falling.
- **Scan start (Nov 21):** one scheduled refresh failed with "Scan didn't start scrolling…"; the next runs were fine. If it happens again, file it as a bug with the run's report.
