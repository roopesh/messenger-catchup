# Development history

How this skill got here, in order. Built late Oct – Nov 6, 2026 (US Pacific time) against one real, busy group chat: roughly 3,900 messages by the end.

Related docs:
- [STATUS.md](STATUS.md): where things stand now, and how to work on it (start here)
- [ARCHITECTURE.md](ARCHITECTURE.md): how the parts fit, full database reference
- [BACKLOG.md](BACKLOG.md): everything open
- [DECISIONS.md](DECISIONS.md): what was chosen and why
- [EXPERIMENTS.md](EXPERIMENTS.md): what was measured, with the numbers
- [LEARNINGS.md](LEARNINGS.md): platform limits and gotchas found along the way

## Phase 1: a catch-up page for one chat (late Oct)
- **Goal:** catch up on a busy Messenger group chat without re-reading it, and without answering questions that are already resolved.
- **Built:**
  - a private claude.ai artifact page, with its database as the store
  - summaries of mentions, topics, open questions and deals
- **Catch-up start point:** the user chooses each time: their last message, or a "mark caught up" marker.
- **Rewind:** a date/time picker rewinds the catch-up to any point.
- **History:** the full history stays stored; the summary covers only what came after the start point.

## Phase 2: incremental refresh (late Oct – Nov 1)
- **Refresh button:** pulls only what's new since the last refresh.
- **Reading:** a script scrolls back in the user's own Chrome, through Claude in Chrome, and reads messages from the DOM.
- **Two-pass verify:** a second, ID-only scan has to confirm the same messages in the same order before anything is saved.
- **Reply parents:** found by clicking each "Go to replied message" link.
- **Speed:** slow. One refresh of 183 messages took about 17 min (breakdown in EXPERIMENTS.md).

## Phase 3: speed-ups (Nov 1–2)
- **Data transfer:** Claude used to retype the capture; now it uses the clipboard plus a paste import on the page, which checksums the capture and refuses gaps or tampering.
- **Reply parents by quote:** matched from the quoted text; clicks only when unclear.
- **Photos:** come from the first scan, as the original files, carried in the same paste.
- **Run lock:** a refresh marks itself running, so two refreshes never collide.
- **Faster check scan:** the gap detector stays as the guard.
- **Paste anywhere:** a paste anywhere on the page imports, and the outcome is recorded in the DB, so Claude confirms without a screenshot.

## Phase 4: helper userscript, outbox, summary v3 (Nov 2–6)
- **Jump links:** "Reply in Messenger" deep links (`#pajump=`, later `#mcjump=`) open the exact message and its Reply box.
- **Outbox:** "Reply here" on the page queues a reply; Claude posts it in Messenger.
- **Helper userscript** (Violentmonkey/Tampermonkey):
  - runs scan, verify and capture inside the page
  - Claude talks to it through a tiny event bridge
- **Helper versions:**
  - v2.1: no reply clicks; faster scroll.
  - v2.2: clicks only photo replies.
- **Summary v3:** one card per conversation, with open, deal and answered call-outs inside the card.
- **Build tool:** `patool.py` (renamed `catchup.py` in Phase 8) builds threading and summary from a small spec and enforces the rules (see DECISIONS.md).
- **Hourly loop:** refreshes became an hourly scheduled loop.

## Phase 5: threading and date entry (Nov 6)
- **Problem:** many non-reply messages belonged to a conversation but looked loose on the page.
- **Experiments:** four ways to link non-replies were measured against hand labels. None beat the existing links, so none shipped (EXPERIMENTS.md).
- **Real fix: display.**
  - `convTree` nests answers under their question.
  - Continuations sit right after the person's own earlier message.
  - Nesting is capped at depth 3.
- **Date entry:** typing a date or time saved a half-typed value, and the page rebuilt mid-typing.
  - Fixed: no rebuild while the field is focused.
  - The value saves after a 1.5 s pause, or on Enter or blur.

## Phase 6: generic, shareable skill (Nov 6)
- **Before:** the user-specific skill had the chat, names and IDs hard-coded.
- **Generic skill:**
  - creates or updates the page for whoever is signed in
  - keeps all settings in the page DB (`meta/chat`)
  - makes the helper optional but recommended
  - spells out the online-computer requirement
  - walks the user through scheduling
- **Helper v1.1** (generic): new names `mc-cmd`, `mc_result`, `data-mc-helper`, `#mcjump=`.
  - Fixes: accepts verify with extra arrivals; handles a chat shorter than the first-run count; parses dates and times reliably.
- **Testing:**
  - simulated Messenger thread: 35/35 checks
  - pipeline replay: 3 imports, 3 builds
  - live sandbox first run without the helper
- **Switch:** the original user's page and loop moved to the generic skill (page v44). The rendered old and new pages were compared, and the only differences were the "Refreshing" text and the jump-link tag.
  - live refresh 244: injected helper v1.1
  - live refresh 245: old helper v2.2 still installed
- **Repo:** published to GitHub.

## Phase 7: handoff review (Nov 6, evening)
- **Goal:** make the project easy to pick up later.
- **Done:**
  - read all code against all docs
  - re-ran the sim tests (35/35)
  - replayed `patool` on synthetic data and probed the capture date parser
- **Added docs:** STATUS.md (start here), ARCHITECTURE.md (structure, full database reference), BACKLOG.md (10 bugs, 7 risks, 5 doc gaps, plus cleanup, test and feature items).
- **No code changed.** Fixes are queued in the backlog.

## Phase 8: rename and test build-out (Nov 6, late evening)
- **Rename:**
  - `patool.py` → `catchup.py`
  - helper `pa*` functions → `mc*`
  - `pa-capture` dropped
  - chat-specific comment removed
  - versions not bumped: no behavior changed
- **Sync tool:** `tools/sync-helper.py` (`npm run sync`) regenerates the page's helper copies.
- **Tests:** `npm test` now runs three suites, 165 checks:
  - Python: `catchup.py` plus repo checks
  - sim: the helper, now including a message deleted mid-run
  - page: in Chromium with a stand-in claude.ai runtime, including the full capture → import → build → render pipeline
- **Mutation check:** 9 deliberate breaks, all caught (one only after adding the missing test).
- **Found:** B11 (a reply link to #0 is ignored).

## Version map
| Thing | Versions |
|---|---|
| Helper (user-specific) | 2.0 → 2.1 → 2.2 (`pa-cmd`, `pa_result`) |
| Helper (generic) | 1.0 → 1.1 (`mc-cmd`, `mc_result`) |
| Page | v1 … v43 user-specific → v44 generic (`PAGE_VERSION` 1.1) |
| Skill | user-specific `packaholics-catchup` → generic `messenger-catchup` v1.1 |
| Build tool | `patool.py` → `catchup.py` (Phase 8, same commands and behavior) |
| Release (`VERSION`) | v1.1.0 (tagged retroactively at `c3186da`) → v1.1.1 (Phases 7–8 plus the release process) → v1.1.2 (CI) → v1.2.0 (P1 fixes, page 1.2). From here on, see CHANGELOG.md |
