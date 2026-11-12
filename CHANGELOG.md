# Changelog

One entry per release. Every merged PR is a release: it bumps `VERSION` and adds an entry here (see [CLAUDE.md](CLAUDE.md) › Versioning). Newest first. Component versions (`PAGE_VERSION`, helper) are noted when they change.

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
  - `references/database.md` documents the layout (setup's copy too); `first-run.md` and `troubleshooting.md` updated. `SKILL.md`: 19,836 bytes.
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
