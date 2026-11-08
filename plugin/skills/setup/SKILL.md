---
name: setup
description: Set up a private catch-up page for a Facebook Messenger group chat (summary, threads, deals, mentions, replies), read from the user's own Chrome through Claude in Chrome. Use for "set up messenger catch-up", a first catch-up page for a chat, changing the refresh schedule, or what refreshes need to work.
---

# Messenger Catch-up: setup

Creates the user's private **catch-up page** (a claude.ai artifact) for one Facebook Messenger group chat, loads a first stretch of history and sets up the refresh schedule. Each user gets their own page in their own claude.ai account; nothing is shared between users. Refreshes, queued replies and everything after setup belong to the `messenger-catchup:refresh` skill.

Use this skill when the user has no catch-up page for the chat yet, asks to change the schedule, or asks what a refresh needs. Setup writes most `meta/chat` fields, so also read `references/database.md`.

Files that ship with this skill, relative to its folder `${CLAUDE_SKILL_DIR}` (in chat: the folder this SKILL.md is in):
- `assets/page.html`: the page template (version in `PAGE_VERSION`).
- `references/database.md`: every database document and field.

## Which part to follow
- **No page yet for this chat**, or "set up messenger catch-up": the First run below.
- **Change the schedule:** find the page (step 2's lookup only; never reseed it), then Scheduling. Replace the existing chain or task, so there's only ever one.
- **What a refresh needs:** Requirements.

## Requirements: an online computer (tell the user this up front)

Claude runs in the cloud, but **every refresh drives the Messenger tab in the user's own Chrome**. A refresh, manual or scheduled, only works while all of this is true:
- The computer is **on, awake and unlocked**. When the screen locks or the computer sleeps, Messenger stops loading history and the run fails. Suggest setting the computer not to sleep while plugged in (macOS: Battery or Energy settings; Windows: Power & sleep), and not to lock the screen during hours they want refreshes.
- **Chrome is open** with the **Claude in Chrome** extension installed and connected to the same claude.ai account.
- **Facebook is signed in** in that Chrome, with Facebook's language set to English (the reader relies on English labels such as "replied to" and "Original message").
- **The Messenger tab Claude opened stays open** on the chat and stays the visible tab in its window (not minimized, not behind another tab in the same window). A tab in the background reports itself hidden and history doesn't load. Claude can only use tabs it opened itself (its own tab group), so let Claude open the chat at setup and leave that tab alone.
- If any of this isn't true, the run is skipped (status "error" on the page) and the next run catches up. Nothing is lost.

Only Claude in Chrome is supported (the user's real, signed-in Chrome). Don't use another browser.

## First run: setup (when the user has no page yet)

Tell the user in one line what's about to happen, then:

1. **Check the requirements** above (Requirements) and say them plainly. Ask for the chat link (they can copy it from the address bar in Messenger). Run `tabs_context_mcp`, then open the chat with `tabs_create_mcp` + `navigate` (that tab is in Claude's group, so later runs can find it). Ask the user to keep that tab open and in front. Use the URL exactly as Messenger shows it: normal chats are `/messages/t/<id>`, end-to-end encrypted ones `/messages/e2ee/t/<id>`; store it as `chatUrl`.
2. **Find or create the page.**
   - `Artifact list` (scope mine). For any artifact titled "… Catch-up", `ArtifactData get meta/chat`. If `kind=="messenger-catchup"` and `thread` matches this chat, that's their page: reuse it. If its `pageVersion` is older than the template's `PAGE_VERSION` (compare number by number, never as decimals: 2.0 is newer than 1.9, and 1.10 would be newer than 1.9), read it (`Artifact read`) and republish `assets/page.html` to its url (the database survives republishing), then set `meta/chat.pageVersion` to that `PAGE_VERSION`. If its `meta/chat.lastI` is 0 or more, it already holds messages: **never reseed it**. Ask only what's missing, update those `meta/chat` fields (pinned), and go to step 6; refreshes carry on with `messenger-catchup:refresh`.
   - Otherwise create one. Read `assets/page.html` in full first, copy it to the scratchpad as `<chat>-catchup.html`, and publish it with `capabilities: {"db":{}, "assets":{}, "sample":{}}` and icon `chat`. Each user's page is private to them.
3. **Ask the setup questions** (one AskUserQuestion, or plain questions):
   - The chat: read the thread id and full URL from the tab and the chat name from the page; confirm with the user.
   - The user's names in the chat (first name, nicknames) for mentions.
   - How far back the first catch-up goes: last 100, 300 (recommended) or 1,000 messages. (If the whole chat is shorter, everything is captured.)
   - Queued replies: post automatically on the next run, or confirm each one in chat first (default: confirm first).
   - The helper: install now (recommended) or skip (see Installing the helper).
   - Refresh schedule (see Scheduling).
4. **Seed the database** (one batch): `meta/chat` with the config above (field names: `references/database.md` › `meta/chat`; read it before this step) plus `kind:"messenger-catchup"`, `pageVersion` (the template's `PAGE_VERSION`), `tz` (the user's time zone), `firstCount` (the history size they chose), `lastI:-1`, `anchorMids:[]`, `markerMode:null`, `chunkSize:82`; `threading/current` `{convs:[],links:{},to:-1,note:""}`; `summary/current` `{version:2,convs:[],open:[],answered:[],deals:[],mentions:[],toI:-1}`; `photos/index` `{byI:{},gifs:[]}`; `refresh/status` `{state:"idle"}`.
5. **First capture and build:** follow the `messenger-catchup:refresh` skill's refresh steps now. It sees `meta/chat.lastI:-1` and reads its own first-run notes (a first window of `firstCount` messages, a seeded bootstrap, then a time marker so the page shows everything captured). It leaves the report to step 6.
6. **Set up the schedule** (Scheduling), then report: page created, how many messages, what the summary found, and the requirements in two lines.


## Installing the helper
- Install: with Tampermonkey or Violentmonkey in Chrome, open the install link (https://github.com/roopesh/messenger-catchup/releases/latest/download/helper.user.js, also on the page under Refreshing › "Jump to a message: set up") and press **Install** on the extension's install page. From helper 1.5 on it **updates itself** from the latest GitHub release (the extension checks about once a day). In current Chrome the extension needs user scripts allowed: chrome://extensions › the extension › Details › "Allow User Scripts" (on older Chrome versions, turn on Developer mode at the top right of chrome://extensions instead). Reload the Messenger tab. Check that `document.documentElement.dataset.mcHelper` is set, then set `meta/chat.helper:"installed"`.

## Scheduling (walk the user through this at setup)
Explain in a few bullets, then set it up yourself:
- **What runs where:** a scheduled refresh runs in Claude's cloud but drives the user's Chrome, so it only works while the computer is online as described above. Missed runs are skipped and the next run catches up.
- **Ask:** how often (every hour is typical; every 2–3 hours is lighter) and which hours (for example 7 AM–11 PM in their time zone), so overnight runs don't fail against a sleeping computer.
- **Option A (recommended): this conversation keeps itself going.** After each run, Claude schedules a one-shot follow-up into this same conversation (`send_later`, the chosen interval) whose message says: run the `messenger-catchup:refresh` skill, handle the outbox per `outboxAuto`, then schedule the next one; skip quietly outside the chosen hours. The user doesn't need to do anything except keep this conversation and say "stop the loop" to end it. Outside the chosen hours, don't run: schedule the next follow-up for the start of the next window instead, so the chain never dies overnight. Check existing scheduled tasks first so there's never more than one chain.
- **Option B: a standalone scheduled task** (`create_trigger` with a cron in the user's time zone limited to the chosen hours, and `requires_local_device: true` because runs drive the user's Chrome). Each run starts a fresh session with no memory of this one, so the prompt must be complete: use the `messenger-catchup:refresh` skill, the page URL, the chat URL and thread id, and the outbox rule. After creating it, tell the user which approval setting it got; if its runs will stop to ask for approval, they can turn on "Automatically approve" in the task's settings if their organization allows it. If the first scheduled run can't reach Chrome, switch to Option A.
- Store the choice in `meta/chat.schedule` (`{mode, every, hours, tz}`) and confirm it to the user in one line with the next run time.
