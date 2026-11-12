# Changelog

One entry per release. Every merged PR is a release: it bumps `VERSION` and adds an entry here (see [CLAUDE.md](CLAUDE.md) › Versioning). Newest first. Component versions (`PAGE_VERSION`, helper) are noted when they change.

## [1.20.0] - 2026-11-12
**Helper 2.0: Reply on photo-only messages, warnings instead of silent misreads, full names on every message, and an opt-in `post`** (GitHub issue #32 §1, §2 and §5; BACKLOG R3, B41, B48, B49, F12, F13). MINOR: new helper behavior and skill procedure changes. Helper **2.0** (from 1.9), page **`PAGE_VERSION` 2.5** (its jump bookmarklet is generated from the helper). No re-setup; installed helpers (1.5+) update themselves from this release.

### Added
- **Reply on a photo-only message (B48, #32 §2).** Such a message has no "Reply to this message" button on its hover toolbar. `jump{reply:true}` now opens its **More actions** menu and clicks "Reply", so queued replies to photos post, and the page's Reply links open the box on them too. SKILL.md's allowed clicks name More actions › Reply when posting an approved reply.
- **Opt-in `post` (F13, #32 §1, option B).** `post{mid,to,snip,text,helperPost:true}` posts one queued reply in one bridge call: it opens Reply, checks the "Replying to …" bar against `to` and `snip` and that the box is empty, types the text with shift+Enter between lines (Messenger's editor drops newlines from `insertText`), presses Enter, and waits up to 15 s for the message. It returns `{sent:true, mid}` or a precise error with `entered` (false: nothing can have been sent). **Off by default:** it refuses without `helperPost:true`, which Claude passes only when `meta/chat.helperPost` is true, and the user turns that on by asking Claude. No link, URL hash or page can reach it. New `references/posting-with-helper.md` maps every result to the outbox states (`sending` before; `sent`, `failed`, or left `sending` for the next run's check).
- **Warnings (R3, option B).** `selfcheck` and the scan's result (`warn`, also in `mc_result.warn`) now warn instead of misreading silently: reply links without an "X replied to Y" line; "Original message:" quotes without reply links; photo links with no Facebook image; times going backwards or into the future across the window (catches time-only labels that aren't today; one hour back is allowed for clock changes); one shown name with full names that don't share a first name (two Bens are fine); no full names at all; a page language that isn't English (named; reading continues); a 24-hour clock.
- **Scan results report `top`** (reached the start of the chat) and **`scroller`** (how the list was found).
- **Two connected Chromes (F12, #32 §5).** Step 2 picks by `references/helper.md` › Which Chrome: the one this session uses, otherwise ask the user, recommending the newest helper (Claude in Chrome forbids picking for them); every report names the browser and helper version.
- New `references/helper.md`: which Chrome, helper versions, what each warning means, stalls and `top`, and injecting without the helper (moved out of SKILL.md).

### Changed
- **Full names on every message (B41).** Messenger shows the avatar once per run of messages from one sender; the scan now gives the whole run that avatar's name (only when the run's avatars name one person). `references/people.md`: each refresh reports when full names aren't captured and while the one-time scan is pending, and the scan runs every refresh until it succeeds, so it starts by itself once the helper is 1.7+. Step 8 also sends Claude there when new messages from others carry no `fn`.
- **A reply whose "X replied to Y" line can't be read is never linked** (`perr:"noreplyline"`); helper 1.9 accepted whatever message took focus.
- **24-hour times are read** ("17:52", "3 Nov 2026 17:52") and stored as 12-hour `t`, with a warning.
- **The scroller is the nearest scrollable ancestor of a message**, not the first scrollable element in the chat log.
- **Stalls (B49, #32 §5).** A scan or verify with nothing new for 30 s returns `err:"stalled"` (retry once: `references/helper.md`) instead of hanging; the top of the chat needs 8 tries and 12 s with nothing loaded and no loading spinner, so a slow load no longer truncates a first run; a scan with stops that reaches the top says so. SKILL.md notes that the first poll after `full` often fails with "Inspected target navigated", which is expected.
- `SKILL.md` stays under its cap (19,642 bytes, down from 19,865): the helper version notices and the injection steps moved to `references/helper.md`.
- `references/database.md` (and setup's copy): `meta/chat.helperPost`.

### Tests
- The mock Messenger has a hover toolbar ("Reply to this message", or More actions › Reply on photo-only messages), a composer with a "Replying to …" bar where Enter posts, running **Lexical core** (`lexical` 0.52.0, a new devDependency served by `tests/run.js`) with `@lexical/plain-text`'s commands and Messenger's Enter-sends rule, and modes for each failure: another page language, 24-hour times, time-only labels across midnight, a stalled scan, an inner scroller, a photo link with no image, reworded reply lines, runs with one avatar, a wrong avatar, and a composer that ignores synthetic keys.
- Every sim context now starts at 12:00 today, local time (Playwright's clock; time flows on), so the mock's time-only labels (9:25–11:20 AM) are always in the past, whatever time the tests run.
- Sim section E (16 checks: each warning in its mode, quiet on the normal mock, the `perr` guard, scroller path, stall, `top`, full names across runs) and F (13 checks: More actions, `post` refusals, multi-line posting, synthetic keys ignored, URL hashes can't post), plus A1/A4 checks on `warn` and `top`. The key ones fail on helper 1.9. `test_tools.TestHelper2`: the opt-in, every `post` result mapped to an outbox state, the jump code never types or sends, the allowed click, stall and navigation notes, browsers and warnings reaching the report, and B41's reporting and retry.

### Needs a live check
- That Messenger accepts the helper's synthetic Enter and shift+Enter (Lexical itself does in Chromium; Messenger's own handlers are unknown). If not, `post` reports `enter-not-accepted` or `linebreak-not-accepted` and sends nothing.
- That photo-only messages' menu is `[aria-label="More actions"]` › "Reply" as reported, a run's avatar sits on one of its messages, and the loading spinner is a `[role="progressbar"]`.

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
