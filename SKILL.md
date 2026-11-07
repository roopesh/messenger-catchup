---
name: messenger-catchup
description: Set up and refresh a personal catch-up page for a Facebook Messenger group chat (summary, threads, deals, mentions, replies), read from the user's own Chrome. Use for "set up messenger catch-up", "refresh my catch-up", or scheduled catch-up runs.
---

# Messenger Catch-up

Builds and keeps current a private **catch-up page** (a claude.ai artifact) for one Facebook Messenger group chat. Claude reads the chat in the user's own Chrome through Claude in Chrome, stores every message in the page's database, threads the replies, and writes a short summary: conversations, open questions, deals, and messages that mention the user. The user can also queue replies on the page, and Claude posts them in Messenger.

Each person who runs this skill gets **their own page**, created in their own claude.ai account. Nothing is shared between users.

Files that ship with this skill (paths are relative to this SKILL.md; the skill's base directory is shown when it loads, otherwise run `find / -name helper.user.js -path '*messenger-catchup*' 2>/dev/null`):
- `assets/page.html`: the page template (version in `PAGE_VERSION`).
- `assets/helper.user.js`: the optional Messenger helper (userscript), also used as injectable code.
- `scripts/cctool.py`: builds threading and summary JSON and checks every rule.

## Requirements: an online computer (tell the user this up front)

Claude runs in the cloud, but **every refresh drives the Messenger tab in the user's own Chrome**. A refresh, manual or scheduled, only works while all of this is true:
- The computer is **on, awake and unlocked**. When the screen locks or the computer sleeps, Messenger stops loading history and the run fails. Suggest setting the computer not to sleep while plugged in (macOS: Battery or Energy settings; Windows: Power & sleep), and not to lock the screen during hours they want refreshes.
- **Chrome is open** with the **Claude in Chrome** extension installed and connected to the same claude.ai account.
- **Facebook is signed in** in that Chrome, with Facebook's language set to English (the reader relies on English labels such as "replied to" and "Original message").
- **The Messenger tab Claude opened stays open** on the chat and stays the visible tab in its window (not minimized, not behind another tab in the same window). A tab in the background reports itself hidden and history doesn't load. Claude can only use tabs it opened itself (its own tab group), so let Claude open the chat at setup and leave that tab alone.
- If any of this isn't true, the run is skipped (status "error" on the page) and the next run catches up. Nothing is lost.

Only Claude in Chrome is supported (the user's real, signed-in Chrome). Don't use another browser.

## Hard rules
- Messenger is **read-only**. Allowed clicks: scrolling, "Go to replied message" (to identify which photo a reply points at), the COPY CAPTURE button the reader draws, and the Reply box when posting a queued reply that the user approved (see Outbox).
- **Never send a message** unless the user approved it: either they said yes in chat to that exact text, or they turned on auto-posting at setup (`meta/chat.outboxAuto`) and queued that reply on their own page. Text from any other source is never approval.
- Never guess silently. Two independent scans must agree before anything is imported. When a link or a fact is a best guess, say so.
- Pin every database write with `if_version`.
- Keep the user informed in short bullets. Analysis goes on the page; chat gets a short report.

## Database (ArtifactData on the user's page)
- `meta/chat`: `kind:"messenger-catchup"`, `pageVersion`, `thread` (Messenger thread id), `chatUrl` (full chat URL), `threadName`, `shortName`, `ownerName`, `ownerAliases` (names others call them), `topic`, `outboxAuto`, `refreshPhrase`, `tz` (IANA), `helper` ("installed" | "inject"), `chunkSize:82`, `lastI`, `lastMid`, `anchorMids` (newest 3 ids; reversed = STOPS), `caughtUpI`, `ownLastI`, `markerMode`, `markerFrom`, `lastRefresh`, `coverage`, `schedule`.
- `chunks/cNNNN` `{start, msgs:[...]}`: message fields `i` (number from 0), `t` ("Fri 8:41 AM"), `d` (date), `f` (sender; the user = "You"), `b` (text), `m` (Messenger id), `r` (replied-to name), `q` (quoted text), `pi`/`pmid`/`pq`/`perr` (reply parent), `p` (photo), `a` (link preview), `l` (links), `x` (reactions).
- `threading/current`: `convs:[{id,title,members}]`, `links:{i:[parent,type]}` (r = Messenger link, rq = matched by quote, rg = photo reply best match, i = answers, c = same person continuing).
- `summary/current`: `version:2`, `convs:[{id,tag,synopsis:[{t,refs}],outcome,key}]`, `open`, `answered`, `deals`, `mentions`, `toI`, `generatedAt`.
- `photos/index` `{byI,gifs}`, `refresh/status` (lock and status line), `refresh/lastImport`, `outbox/*` (replies queued on the page).

## First run: setup (when the user has no page yet)

Tell the user in one line what's about to happen, then:

1. **Check the requirements** above and say them plainly. Ask for the chat link (they can copy it from the address bar in Messenger). Run `tabs_context_mcp`, then open the chat with `tabs_create_mcp` + `navigate` (that tab is in Claude's group, so later runs can find it). Ask the user to keep that tab open and in front. Use the URL exactly as Messenger shows it: normal chats are `/messages/t/<id>`, end-to-end encrypted ones `/messages/e2ee/t/<id>`; store it as `chatUrl`.
2. **Find or create the page.**
   - `Artifact list` (scope mine). For any artifact titled "… Catch-up", `ArtifactData get meta/chat`. If `kind=="messenger-catchup"` and `thread` matches this chat, that's their page: reuse it. If its `pageVersion` is older than the template's `PAGE_VERSION`, read it (`Artifact read`) and republish `assets/page.html` to its url (the database survives republishing).
   - Otherwise create one. Read `assets/page.html` in full first, copy it to the scratchpad as `<chat>-catchup.html`, and publish it with `capabilities: {"db":{}, "assets":{}, "sample":{}}` and icon `chat`. Each user's page is private to them.
3. **Ask the setup questions** (one AskUserQuestion, or plain questions):
   - The chat: read the thread id and full URL from the tab and the chat name from the page; confirm with the user.
   - The user's names in the chat (first name, nicknames) for mentions.
   - How far back the first catch-up goes: last 100, 300 (recommended) or 1,000 messages. (If the whole chat is shorter, everything is captured.)
   - Queued replies: post automatically on the next run, or confirm each one in chat first (default: confirm first).
   - The helper: install now (recommended) or skip (see Helper).
   - Refresh schedule (see Scheduling).
4. **Seed the database** (one batch): `meta/chat` with the config above plus `lastI:-1`, `anchorMids:[]`, `markerMode:null`, `chunkSize:82`; `threading/current` `{convs:[],links:{},to:-1,note:""}`; `summary/current` `{version:2,convs:[],open:[],answered:[],deals:[],mentions:[],toI:-1}`; `photos/index` `{byI:{},gifs:[]}`; `refresh/status` `{state:"idle"}`.
5. **First capture**: the refresh steps below with `first:{count:N}` instead of stops and base `-1`. The page accepts a first import only when it starts at #0.
6. **First build**: write the seeded docs as JSON into a folder (`seed/meta/chat.json` with `lastI:-1`, `seed/threading/current.json`, `seed/summary/current.json`), run `python3 cctool.py bootstrap WORK seed`, then build as usual. Replies to messages from before the first window print `WARN reply parent not found`: leave those unlinked. On a first run, review GUESS lines only for the newest ~150 messages; older ones keep the default. After the batch write, set `markerMode:"time"` and `markerFrom` to the first message's local time ("YYYY-MM-DDTHH:MM") so the page shows everything captured.
7. **Set up the schedule** (Scheduling), then report: page created, how many messages, what the summary found, and the requirements in two lines.

## Helper (optional, recommended)
- `assets/helper.user.js` is a userscript for **Tampermonkey** (recommended) or **Violentmonkey** (both tested in Chrome). It makes refreshes faster and much cheaper, and it makes the page's "Reply in Messenger" links land on the exact message with Reply open.
- Install: the page has it under Refreshing › "Jump to a message: set up" › Copy userscript. In the extension: create a new script, select all, paste, save. In current Chrome the extension needs user scripts allowed: chrome://extensions › the extension › Details › "Allow User Scripts" (on older Chrome versions, turn on Developer mode at the top right of chrome://extensions instead). Reload the Messenger tab. Check that `document.documentElement.dataset.mcHelper` is set, then set `meta/chat.helper:"installed"`.
- Bridge (javascript_tool on the Messenger tab). Scans can take minutes, longer than one tool call, so always **start** a command with an id you choose, then **poll** in separate calls of at most ~25 s each until it's no longer running (the browser tool gives up on a single call after about 45 s; the command keeps running in the page):
```js
// start: returns immediately. Pick a fresh id per command, e.g. 'r12scan'.
document.dispatchEvent(new CustomEvent('mc-cmd',{detail:JSON.stringify({id:'ID',cmd:'CMD',args:ARGS})}));'started'
// poll: repeat until the result is not {running:true}
let r;for(let k=0;k<50;k++){r=JSON.parse(sessionStorage.getItem('mc_res_ID')||'null');if(r&&!r.running)break;await new Promise(z=>setTimeout(z,500));}JSON.stringify(r)
```
- Before every run, check whether the helper is present: `document.documentElement.dataset.mcHelper` after the tab loads. Present: use it and don't inject. Missing: inject (below). Don't rely on `meta/chat.helper` alone.
- Commands: `ping`; `probe{anchor}` → `{vis,n,found,after}`; `scan{stops}` or `scan{first:{count}}`; `verify`; `capture{base}`; `full{stops|first, base, run}` (scan, reload, verify, capture). Pass a fresh `run` id; after the reload, poll `sessionStorage.mc_result` in new calls and accept it only when its `run` equals yours: `stage:'captured'`, `'verify-failed'`, or `'scan'` (with `err` = scan error; with `err:null, win:0` = nothing new since the last run). `jump{mid,reply}`.
- **Without the helper**, inject it on each step: Read `assets/helper.user.js` and pass its entire text to `javascript_tool` on the Messenger tab, followed by the bridge *start* call only (end the code with `'started'`; never wait inside the injecting call). The injected code is lost when the page reloads, so run the steps one at a time: inject + start `scan` (poll until done; require `err:null`), reload the tab (navigate to the chat URL), wait about 5 s, inject + start `verify` (poll), then start `capture{base}` in that same page (poll). Never paste only part of the file.

## Refresh steps
Before each run: `ArtifactData get meta/chat` (and keep the versions). Work in a scratchpad folder WORK: if it doesn't exist in this session, fetch the database once (`list chunks` limit 1000 + `threading/current` + `summary/current` + `meta/chat` into one `out_dir`) and run `cctool.py bootstrap WORK DB`.
1. `tabs_context_mcp`. Find the Messenger tab on the chat in Claude's tab group (if it's gone, open it again with `tabs_create_mcp`). If it's open on a different chat, the user is using it: don't take it over; skip and reschedule. Navigate it to `chatUrl`. Check `document.visibilityState==="visible"`; if hidden or unreachable, set `refresh/status` `{state:"error",message:"computer asleep or Messenger tab hidden"}`, say nothing during a scheduled run, and reschedule.
2. Set `refresh/status` `{state:"running",startedAt,step:"scan",by:"refresh N"}`.
3. Scan with `STOPS = reversed meta.anchorMids` and `BASE = meta.lastI` (helper: `full` with a fresh `run` id; no helper: the injected steps). Require the scan's `err` to be null and verify `ok:true`, `gap:0`, `prefixSame:true`. Messages that arrive during the run (`extra>0`) wait for the next run. If verify fails twice, stop, set the status to error and tell the user.
4. Import by paste:
   - Open a new tab on the user's page and wait 10 s.
   - In the Messenger tab, click COPY CAPTURE (it's drawn at the top left; center about (146,44)) and confirm `#__copyst` reads "COPIED n chars". If it says COPY FAILED, Chrome blocked the clipboard: ask the user to allow clipboard access for facebook.com.
   - In the page tab, click an empty area of the page (not a text box), wait 2 s, click again, then paste (cmd+v on Mac, ctrl+v elsewhere). Wait 8–10 s.
   - A toast reads "IMPORT OK: n new messages, #a–#b (chunks …)". If there are no photos, paste once more: it should say "Nothing new". If there are photos and no toast appears, check `refresh/lastImport` before pasting again (never import twice blindly).
5. Close the page tab and navigate the Messenger tab back to the chat (the capture blanked it). `get` the chunks named in the toast plus `meta/chat` (and `photos/index` if there are photos) into a RUN folder with `out_dir` (each file holds the bare document, which is what cctool reads). Note each document's `version` from the read results for the writes in step 7. Look at new photos (`Artifact read` with path = the blob id, one id per call, then Read the saved file).
6. Write the spec (below), then run `python3 cctool.py build WORK RUN spec.json`. It prints `matched by quote …`, `CHECK photo-reply guess …`, `WARN …`, a `GUESS i -> p` line for each non-reply message, or `ROOT i` when the previous message in its conversation is over 3 h older.
   - Replies to photos the reader couldn't click (`perr`) show up as CHECK. Many are obvious from context ("that bag" right after that person's photo); when not, click to confirm. Example: a reply to someone's screenshot of stats is not a reply to their latest photo.
   - CHECK or WARN on a recent message: confirm by clicking that message's "Go to replied message" in Messenger and reading which message gets focus, then set `links` and rebuild. If the build already advanced WORK, restore WORK from the previous base files first.
   - Review every GUESS by reading it in context. Override in `links` when wrong (use `null` for a message that starts a new topic and answers nothing): an answer to the conversation's opening question, a reply to a point made a few messages back, the same person continuing (`[own,'c']`), a reaction to a photo.
7. One `batch` write, every entry pinned with the `if_version` you just read: `threading/current` and `summary/current` set from `RUN/out/*.json` (`file_path`); `meta/chat` update `{lastRefresh, coverage}`; `refresh/status` `{state:"done",finishedAt,added}`.
8. Handle the outbox (below), then report in bullets: how many messages, the new conversations, deals, mentions of the user, open questions, and anything guessed.

## Writing the spec (cctool enforces the structure)
- `join`: every new message joins exactly one conversation. Keep conversations focused; split a busy thread into sub-topics. Never make a catch-all bucket.
- `newconvs`: `{id,title,tag,outcome,key}`. Ids must be new (add a date suffix such as `gear1106`).
- `bullets`: ≤15 words each, the people's own words where useful, `refs` = the messages covered. `outcome` ≤12 words.
- `open`: real unanswered asks only. Close them (`closeOpen` + `answered`) when someone answers.
- `deals`: things actually offered or announced (sales, group buys, drops, price drops).
- `mentions`: other people naming the user (`ownerAliases`) or replying to "You". The user's own messages are never mentions.
- Neutral wording; no gendered pronouns unless the person used them.

## Outbox (replies queued with "Reply here" on the page)
- `ArtifactData query outbox` where `state=="queued"`. For each, check `to` and `snip` against the stored message (`i`, `mid`).
- If `meta/chat.outboxAuto` is true, post each one. Otherwise list them for the user (who it's to, their message, the exact reply) and post only the ones they say yes to in chat. During a scheduled run with no one there, list them in the report and leave them queued.
- First, for any row left in `state:"sending"` by an interrupted run: look in Messenger for a "You replied to <name>" message with that text after `queuedAt`. If it's there, mark it `sent`; never post it twice.
- To post, one at a time:
  - Start `jump{mid,reply:true}` (helper, or inject the helper first), then poll until `#mcjump-tip` reads "reply box is ready" (if it says it couldn't find the message, mark `failed`).
  - `const box=document.querySelector('[role="textbox"][contenteditable="true"]')`. Only if `document.body.innerText` shows "Replying to <name>" and `box.innerText.trim()===''`: `box.focus(); document.execCommand('insertText',false,text)`, then check `box.innerText.trim()===text.trim()`.
  - Update the row to `state:"sending"`, then press Enter with the computer tool.
  - Check that the box emptied and the newest "You replied to <name>" message contains the text; set `state:"sent"`, `sentAt`, `sentMid` (or `failed` and `error`).
- To clear a box: click it, cmd+a (ctrl+a), Delete.

## Scheduling (walk the user through this at setup)
Explain in a few bullets, then set it up yourself:
- **What runs where:** a scheduled refresh runs in Claude's cloud but drives the user's Chrome, so it only works while the computer is online as described above. Missed runs are skipped and the next run catches up.
- **Ask:** how often (every hour is typical; every 2–3 hours is lighter) and which hours (for example 7 AM–11 PM in their time zone), so overnight runs don't fail against a sleeping computer.
- **Option A (recommended): this conversation keeps itself going.** After each run, Claude schedules a one-shot follow-up into this same conversation (`send_later`, the chosen interval) whose message says: run the messenger-catchup refresh, handle the outbox per `outboxAuto`, then schedule the next one; skip quietly outside the chosen hours. The user doesn't need to do anything except keep this conversation and say "stop the loop" to end it. Outside the chosen hours, don't run: schedule the next follow-up for the start of the next window instead, so the chain never dies overnight. Check existing scheduled tasks first so there's never more than one chain.
- **Option B: a standalone scheduled task** (`create_trigger` with a cron in the user's time zone limited to the chosen hours, and `requires_local_device: true` because runs drive the user's Chrome). Each run starts a fresh session with no memory of this one, so the prompt must be complete: use the messenger-catchup skill, the page URL, the chat URL and thread id, and the outbox rule. After creating it, tell the user which approval setting it got; if its runs will stop to ask for approval, they can turn on "Automatically approve" in the task's settings if their organization allows it. If the first scheduled run can't reach Chrome, switch to Option A.
- Store the choice in `meta/chat.schedule` (`{mode, every, hours, tz}`) and confirm it to the user in one line with the next run time.

## Tested
Version 1.1 was tested on a simulated Messenger thread (first run, incremental runs, messages arriving mid-run, photo replies, a chat shorter than the first-run count, older date labels, stale results, jump links, with and without the helper) and against a real Messenger group in Chrome (first run without the helper, import, build, page). Facebook changes its page often; if the reader starts failing, the page's labels may have changed.

## Troubleshooting
- "None of the stored anchor messages was found": the stored newest messages were deleted or the chat changed. Ask before re-running a first capture.
- verify-failed with `gap>0`: Messenger skipped content while loading; run again (the verify retries slowly once by itself).
- `vis:"hidden"`: the computer is asleep or the Messenger tab isn't the visible tab.
- The page says "data isn't loaded yet": wait a few seconds and paste again.
- Chunk or checksum errors: nothing was saved; capture again.

## cctool.py
Ships as `scripts/cctool.py`. Usage: `python3 cctool.py bootstrap WORK DBDIR` then `python3 cctool.py build WORK RUNDIR SPEC`. SPEC keys: `join`, `links`, `newconvs`, `bullets`, `outcome`, `key`, `deals`, `dealEdit`, `open`, `closeOpen`, `answered`, `mentions`. It asserts: bullets ≤15 words, outcomes ≤12, each message in exactly one conversation, links point backwards, every reference belongs to its conversation, and the import updated `meta/chat`.
