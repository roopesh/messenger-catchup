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
| R10 | P3 | risk | Unchecked live: does a refresh from claude.ai in a browser need the Claude Desktop app open? The page, setup and README say it does |
| R11 | P3 | risk | Desktop local scheduled tasks may reach Claude in Chrome; not checked, so not offered |
| R12 | P3 | risk | A chain conversation's context grows with every run, so its cost rises over weeks; it also hits the conversation length limit |
| R18 | P3 | risk | Now that a chain run arms as it starts, a run still going when the next one fires (`every` minus 3 minutes after it started) has a lock older than 20 minutes for usual settings, which the next run takes over |
| R13 | P2 | risk | A page holds at most 5,000 photo files: the owner's page has 876 (Nov 14) and adds 55–80 a day (to design) |
| R19 | P3 | risk | Claude's own maintenance writes (link cleanup, digest backfill) hold the refresh lock while the user's approval waits, often past the lock's 20 minutes |
| R17 | P3 | risk | Between a merge and its release, the page's "helper is behind" notice points at the old helper: marketplace installs get the new skill at the merge, but `releases/latest` still serves the old userscript |
| F1 | P3 | feature | More than one chat per page |
| F25 | P2 | feature | Catch up with Facebook group posts too, not just Messenger group chats (the owner's request, Nov 14; to design) |
| F26 | P3 | feature | Remove questions asked on the Ask tab: there's no way to delete a saved question (`qa/*`) today (the owner's request, Nov 14) |
| F23 | P3 | feature | A Messenger reply mid-conversation to a message in another conversation shows no "replying to…" line (27 on the owner's page) |
| F24 | P3 | feature | Optional views of the per-day digests (F16), such as a "By day" tab; today only Ask reads them |

---

## Risks

### R3 · P3 · Messenger markup and English labels
- **What:** the helper reads English UI labels, `[role="log"]`, `data-message-id`, "Go to replied message", "Reply to this message" and the `At <time>, <name>: ` aria-label shape. Since v1.20.0 (helper 2.0), a changed label shows as a warning or a `selfcheck` failure instead of wrong data.
- **What remains:** a change to every marker of a feature at once (for example all three reply markers) still reads as "none" rather than a warning. A non-English Messenger warns and continues.

### R10 · P3 · Does claude.ai in a browser need the Desktop app open?
- **What:** since v1.25.0 the page, setup and README all say to keep the Claude Desktop app open, because Claude in Chrome needs it when a refresh runs from claude.ai, the phone, Cowork or a schedule. Whether claude.ai in the same Chrome needs it hasn't been checked live.
- **Check:** run a refresh from claude.ai in Chrome with the Desktop app quit. If it works, drop that case from the wording in all three places.

### R13 · P2 · A page holds at most 5,000 photo files
- **Found (Nov 12, live, read only):** the owner's page has 715 asset files against claude.ai's 5,000-file limit per artifact (bytes: 38.8 MB of 1 GiB), growing about 55 files a day, so it reaches the limit in roughly 11 weeks. There are also more files than indexed photos (715 against 549 in the old `byI`), probably copies from re-pastes before v1.22.
- **Now (v1.22.0):** the page records usage with each import and warns at 80%; `references/photos.md` › Cleanup removes copies and unused files on the user's say-so. That buys time, not a fix.
- **Corrected (Nov 14, full count, read only):** of 855 files, 853 are in use, each by exactly one slot; the 549 above was an undercount. No unused copies: the only unused files are 2 unique ones (163 KB) from one Nov 3 upload, left by the record loss v1.22.0 fixed. 4 pairs of identical files are both in use (the same photo posted twice). 876 files on Nov 14, so at 55–80 a day the limit arrives between early and late January.
- **Option for the design, reuse by fingerprint:** before uploading, reuse an existing asset with the same content (the asset listing gives each file's sha256 of its raw bytes; the page's `h` is a hash of the base64 text, so the two would need aligning). Today it would save 4 files, so it's only worth building if the design moves or re-uploads photos. The owner leans towards having it.
- **To design:** for example keep older photos as links only (Messenger's own, which expire), move older photos to an archive page with its own quota, or store a smaller copy of old photos. Each has costs (lost photos, a second page to maintain, re-encoding the owner ruled out for now).

### R17 · P3 · The helper notice runs ahead of the release
- **Found:** the review of F5 (PR #42). Marketplace installs pick up a merge on `main` at once, so the next refresh writes the new `versions.helper`. Self-updating helpers fetch from `releases/latest`, which `tools/release.sh` publishes only after the merge. In between, notice E tells the user to check for updates or open the install link, and both still give the old helper; the notice stays until the release is out and the helper has updated.
- **Options:** run `tools/release.sh` straight after every merge that bumps the helper (today's practice, so the gap is usually minutes); or have the page hold E until a day after `versions.helper` first appears (a `since` the skill keeps), which the owner turned down for F5 ("flagged right away").

### R5 · P2 · E2EE and messenger.com
- **What:** `/messages/e2ee/t/` URLs are stored and used but untested against a live E2EE chat. The userscript `@match` covers only `www.facebook.com/messages/*`, so `messenger.com` isn't supported.

### R11 · P3 · Desktop local scheduled tasks
- **What:** the Desktop app's local scheduled tasks run on the computer while the app is open, with one catch-up run after waking. If such a task's session has Claude in Chrome, it would be a sturdier recurring option than a device-bound cloud task. Unchecked, so `references/scheduling.md` doesn't list it.
- **Fix:** create one in a Desktop Code-tab session and look for the Claude in Chrome tools in its run; if they're there, add the tool to `references/scheduling.md` › Tools.

### R12 · P3 · A chain conversation keeps growing
- **What:** every hourly run adds tool output to the same conversation, so each run costs more over weeks. Predates v1.21.0. Arming at `every` minus 5 minutes (minus 3 from a run's start since v1.23.0) keeps runs inside the prompt cache, but the context still grows.
- **Also:** a claude.ai conversation has a hard length limit. Once a chain's conversation reaches it, follow-ups can't be delivered and the chain stops (a refresh the user asks for then finds it stopped).
- **Also (seen live, Nov 14):** a chain conversation seems to keep the skill version it started with. The owner's account had 1.25.0 installed (Customize › Plugins), but the hourly runs of the old `"loop"` chain still left the page at 2.7 and wrote no digests. A refresh started in a new conversation gets the installed version. Not yet confirmed how claude.ai loads a skill into a conversation that's already running. If that's how it works, every release only reaches a chain once it moves to a new conversation, so moving the chain now and then also serves updates.
- **Fix:** measure a chain's cost per run after a week or two; if it climbs, or the conversation nears its limit, have a run move the chain to a fresh conversation now and then (setup's Stop or change, then arm from the new one).

### R18 · P3 · A run older than the lock's 20 minutes when the next one fires
- **What:** since R14, a chain run arms as it starts, so the next run fires `every` minus 3 minutes after this one started, not after it ended. If this run is still going then (a large backlog, a long photo wait, a slow outbox) and `every` is 23 minutes or more, its `refresh/status` lock is more than 20 minutes old, and the next run treats it as stale and takes over. That run scans in the same Messenger tab. Pinned writes keep the database whole: a run whose write is refused while the other's `running` is in `refresh/status` stops (writing-the-build.md › Refused writes). But the two can disturb each other's scan, and the first to finish marks the status done while the other is still going. Before R14 this could only happen with a refresh the user asked for. `references/scheduling.md` › A scheduled run, Overlap, describes it.
- **Unverified, check live:** a follow-up that comes due while this conversation is mid-turn (the run it would follow is still going) may be queued until the turn ends, or dropped. If the scheduling tool drops it, the chain stops at that run, and only a refresh the user asks for finds it stopped. Check with each follow-up tool (a short `every` and a run kept busy past it).
- **Fix (if it shows up):** have a run that finds the lock 20+ minutes old check `lastRunAt` and the lock's `step` before taking over, or renew `startedAt` at each step.

### R19 · P3 · Claude's maintenance writes hold the refresh lock through slow approvals
- **Found (Nov 14, live):** the cross-conversation link cleanup and the F16 digest backfill take the `refresh/status` lock, then write, and each write waits for the user's approval in the UI. Approvals took from minutes to 5.5 hours. Once the lock is 20 minutes old, scheduled refreshes treat it as stale and take over. Pinned writes kept the database whole: the cleanup was refused twice (`version_mismatch`) and landed on the third try, and the backfill's digest write landed, but its lock release was refused because a refresh had already replaced the status.
- **Options:** writes that only touch documents refreshes never write (the backfill's `digests/m…` while refreshes run an older skill; a refresh on v1.25+ does write them) could skip the lock and rely on the pin; or the lock, the write and its release go in one batch, so there's one approval and no stale window; or `references/digests.md` and the cleanup procedure say to re-read and re-pin after a slow approval instead of assuming the lock held.

## Features and opportunities

### F1 · P3 · Several chats
- One page and one loop per chat today (LEARNINGS.md › Open issues). Simplest path: one page per chat, keyed by `meta/chat.thread`, and a loop that walks them.

### F25 · P2 · Catch up with Facebook group posts
- **Ask (owner, Nov 14):** besides a Messenger group chat, catch up with the posts in a Facebook group.
- **How it differs:** a group is a feed of posts (text, photos, links), each with its own comment threads and reactions, at `facebook.com/groups/<id>`, not a single message log. The feed's default order isn't by time, posts and comments load lazily, and old posts get new comments, so "what's new since I last looked" means new posts **and** new comments on older ones. Claude in Chrome reads it from the owner's own logged-in Chrome, as for Messenger, read only.
- **To design with the owner:** which groups; what counts as new; one page per group or groups on the chat's page (F1 is related); what the summary covers (posts, comment threads, deals in buy/sell groups, mentions); whether replying is in scope; how capture works (a helper mode for the group feed, sorted by new activity) and its markup risks (like R3).

### F26 · P3 · Remove saved Ask questions
- **Ask (owner, Nov 14):** a way to remove questions asked earlier on the Ask tab.
- **Today:** the page saves every question and answer in `qa/*` (`collection("qa").add`) and lists them all. Nothing deletes them, and the list keeps only `d.data()`, so it doesn't even hold the document ids a delete would need. Only Claude can remove one, with a database delete the user approves.
- **Fix:** keep each row's id; give each saved question a Remove action (undo for a few seconds rather than a confirm dialog), and maybe "Clear all". Claude reads `qa` for context (`database.md` › Questions asked on the page), so removed ones simply stop being read.
- **Test:** a page test that removes one saved question (it's gone from the list and from `qa`), undoes another, and checks markup in a question still shows as text.

### F23 · P3 · Show cross-conversation replies mid-conversation
- **Found:** cleaning up the owner's page (Nov 13). Of 122 links whose parent sat in another conversation, 52 were wrong guesses (fixed live with `relink` and `move`). The 70 left are real Messenger replies where the topic drifted. 43 start a conversation, and the page shows their parent as context (B40). 27 sit mid-conversation, where the page draws no link at all.
- **Fix:** for a message whose link crosses conversations, show a short "replying to Ben: …" line that opens the parent, like B40's context line. Moving these would misfile them, so the page should show them instead.

### F24 · P3 · Optional views of the per-day digests
- **What:** since v1.25.0 (F16) each finished day has a few bullets citing its messages (`digests/m<YYYY-MM>`), but only Ask reads them. The owner wants other ways to use them recorded for later: a "By day" view (one card per day, newest first, each bullet opening its messages), digests in the Messages tab's day headers, or a week's digests as a quick catch-up after time away.
- **Cost:** page only; the data is there (after the backfill, for every day).
- **Trigger:** the owner asks.

## Live checks

### L1 · P3 · Live checks still to do
Gathered from finished items when they were removed (Nov 14). The item each came from is in brackets; CHANGELOG.md has its history.
- **Scheduling (R6):** `send_later` in a Desktop chat with a 2-minute delay, with Desktop open and with it quit; the longest `delay_minutes` it takes (an overnight arm needs 8 h or more; if it's shorter, arm in steps); whether `send_later` from inside a follow-up asks for approval; `create_trigger`'s exact result text under each approval mode; a `CronCreate` chain in the CLI firing twice; a second delivery taking the stale path; the owner's `mode:"loop"` page switching when the owner types a refresh in a new chat (its old chain should then end at its next follow-up).
- **Update notices (F5):** whether an open tab reloads by itself after a republish (notice A's wording), and what `list_connected_browsers` calls a single Chrome. The claude.ai menu path "Customize › Plugins" was confirmed on Nov 14.
- **Ask over long histories (F6, the design's L2–L7):** "include older" answers carry a note like "Read #… word for word. Older than #…: summaries only." and no "(sent a smaller set…)"; answers about things 1 to 3 weeks old cite numbers and say when they rest on summaries or digests; Views on a 5-day window; a long span before `fromI` refused with a start time; what `sample.limits()` returns in the real runtime.
- **Helper (B41, B49, F13):** whether Messenger puts a run's avatar on its last message or its first (either works if each run shows one); whether its loading indicator is a `[role="progressbar"]` at the top of the list; whether it accepts the helper's synthetic Enter and shift+Enter for `post`.
- **Plugin updates (F7):** settled on Nov 14. The owner's account showed the custom-marketplace plugin at 1.25.0 within hours of the merge. A scheduled chain seems to keep its starting version, which is in R12.
