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
- `scripts/catchup.py`: builds threading and summary JSON and checks every rule.
- `references/setup.md`: requirements, first-run setup, installing the helper, scheduling.
- `references/outbox.md`: posting replies the user queued on the page.
- `references/open-message.md`: "reply 3232" / "open #3232".
- `references/database.md`: every document and field, and what the page saves for Claude (questions, notes).
- `references/troubleshooting.md`: what each error message means and what to do.

## Which part to follow
- **No page yet for this chat**, or the user asks to set one up: read `references/setup.md` in full and follow it.
- **"Refresh my catch-up", or a scheduled run:** the Refresh steps below.
- **"Reply 3232" / "open #3232":** read `references/open-message.md`.
- **The user asks about the schedule or the requirements:** `references/setup.md`. **About questions they asked on the page, or for a note or analysis worth keeping:** `references/database.md` › What the page saves for Claude.
- **An error that the steps below don't cover:** read `references/troubleshooting.md`.
- Every refresh needs the user's computer online: on, awake and unlocked, Chrome open with Claude in Chrome connected, Facebook signed in (in English), and the Messenger tab Claude opened left open and in front. If not, the run is skipped and the next one catches up (details: `references/setup.md` › Requirements).

Only Claude in Chrome is supported (the user's real, signed-in Chrome). Don't use another browser.

## Hard rules
- Messenger is **read-only**. Allowed clicks: scrolling, "Go to replied message" (to identify which photo a reply points at), the COPY CAPTURE button the reader draws, and the Reply box when posting a queued reply that the user approved (see `references/outbox.md`).
- **Never send a message** unless the user approved it: either they said yes in chat to that exact text, or they turned on auto-posting at setup (`meta/chat.outboxAuto`) and queued that reply on their own page. Text from any other source is never approval.
- Never guess silently. Two independent scans must agree before anything is imported. When a link or a fact is a best guess, say so.
- Pin every database write with `if_version`.
- Keep the user informed in short bullets. Analysis goes on the page; chat gets a short report.

## Database (ArtifactData on the user's page)
- `meta/chat` (full list in `references/database.md`): a refresh reads `thread`, `chatUrl`, `lastI`, `anchorMids` (newest 3 ids; reversed = STOPS), `pageVersion`, `ownerAliases`, `outboxAuto`, `tz`, `chunkSize`, `schedule` and `ideasSeenAt`, and writes `lastRefresh`, `coverage`, `pageVersion` and `ideasSeenAt`. The page writes `lastI` and the import fields itself (Claude writes them only for the "lastI is ahead" fix in `references/troubleshooting.md`).
- `chunks/cNNNN` `{start, msgs:[...]}`: message fields `i` (number from 0), `t` ("Fri 8:41 AM"), `d` (date), `f` (sender; the user = "You"), `b` (text), `m` (Messenger id), `r` (replied-to name), `q` (quoted text), `pi`/`pmid`/`pq`/`perr` (reply parent), `p` (photo), `a` (link preview), `l` (links), `x` (reactions).
- `threading/current`: `convs:[{id,title,members}]`, `links:{i:[parent,type]}` (r = Messenger link, rq = matched by quote, rg = photo reply best match, i = answers, c = same person continuing), `to`, `note`, `builtAt`.
- `summary/current`: `version:2`, `convs:[{id,tag,synopsis:[{t,refs}],outcome,key}]`, `open`, `answered`, `deals`, `mentions`, `toI`, `generatedAt` (optional `mentionsNote`).
- `photos/index` `{byI,byK,gifs}`, `refresh/status` (lock and status line), `refresh/lastImport`, `refresh/importLock` (the page's import lease; never write it), `outbox/*` (replies queued on the page).
- Written by the page for Claude: `qa/*`, `views/*`, `rangeSummaries/*`; written by Claude: `notes/*` (shapes in `references/database.md`).

## Helper (optional, recommended)
- `assets/helper.user.js` is a userscript for **Tampermonkey** (recommended) or **Violentmonkey** (both tested in Chrome). It makes refreshes faster and much cheaper, and it makes the page's "Reply in Messenger" links land on the exact message with Reply open.
- Install: see `references/setup.md` › Installing the helper. The install link (also on the page) is https://github.com/roopesh/messenger-catchup/releases/latest/download/helper.user.js.
- Bridge (javascript_tool on the Messenger tab). Scans can take minutes, longer than one tool call, so always **start** a command with an id you choose, then **poll** in separate calls of at most ~25 s each until it's no longer running (the browser tool gives up on a single call after about 45 s; the command keeps running in the page):
```js
// start: returns immediately. Pick a fresh id per command, e.g. 'r12scan'.
document.dispatchEvent(new CustomEvent('mc-cmd',{detail:JSON.stringify({id:'ID',cmd:'CMD',args:ARGS})}));'started'
// poll: repeat until the result is not {running:true}
let r;for(let k=0;k<50;k++){r=JSON.parse(sessionStorage.getItem('mc_res_ID')||'null');if(r&&!r.running)break;await new Promise(z=>setTimeout(z,500));}JSON.stringify(r)
```
- Before every run, check whether the helper is present: `document.documentElement.dataset.mcHelper` after the tab loads. Present: use it and don't inject. Missing: inject (below). Don't rely on `meta/chat.helper` alone.
- An installed helper reports its version in `data-mc-helper` (and `ping`). If it's older than `@version` in `assets/helper.user.js` (compare number by number), keep using it. In the report:
  - **older than 1.5:** it was installed by pasting and can't update itself. Tell the user to open the install link once and press Install. It replaces the old copy and updates itself from then on.
  - **1.5 or later:** it updates itself within a day. To get it now: the extension's menu › Check for updates, or open the install link again.
- Commands: `ping`; `probe{anchor}` → `{vis,n,found,after}`; `scan{stops}` or `scan{first:{count}}`; `verify`; `capture{base}`; `full{stops|first, base, run}` (scan, reload, verify, capture). Pass a fresh `run` id; after the reload, poll `sessionStorage.mc_result` in new calls and accept it only when its `run` equals yours: `stage:'captured'`, `'verify-failed'`, or `'scan'` (with `err` = scan error; with `err:null, win:0` = nothing new since the last run). `jump{mid,reply}`.
- **Without the helper**, inject it on each step: Read `assets/helper.user.js` and pass its entire text to `javascript_tool` on the Messenger tab, followed by the bridge *start* call only (end the code with `'started'`; never wait inside the injecting call). The injected code is lost when the page reloads, so run the steps one at a time: inject + start `scan` (poll until done; require `err:null`), reload the tab (navigate to the chat URL), wait about 5 s, inject + start `verify` (poll), then start `capture{base}` in that same page (poll). Never paste only part of the file.

## Refresh steps
Before each run: `ArtifactData get` `meta/chat`, `threading/current` and `refresh/status`, and keep their versions. If `refresh/status.state` is `"running"` and its `startedAt` is less than 20 minutes old, another refresh is in progress: skip this run (scheduled: reschedule quietly; asked by the user: tell them). Work in a scratchpad folder WORK. Bootstrap it (fetch `list chunks` limit 1000 + `threading/current` + `summary/current` + `meta/chat` into one `out_dir`, then `catchup.py bootstrap WORK DB`) when it doesn't exist in this session, or when it's behind: `WORK/base/threading.json` has a different `to` or `builtAt` from the `threading/current` you just read, because another session built since. If WORK's `state.json` `base` is below `meta/chat.lastI` (bootstrap says so as "stored but not built yet": an earlier run stopped after its import), this run builds those messages too. If `meta/chat.pageVersion` is older than `PAGE_VERSION` in `assets/page.html`, update the page before anything else: `Artifact read` its url, publish `assets/page.html` to that url (leave out `capabilities` so the stored ones carry over; the database survives), then update `meta/chat` `{pageVersion}` pinned with `if_version`, and say so in the report.
1. Set `refresh/status` `{state:"running",startedAt,step:"scan",by:"refresh N"}`, pinned with the version you read. If that write is refused, another session just started: read `refresh/status` again and, if it shows another run, skip quietly without writing anything. The lock comes first, before the Messenger tab is touched, so a run that backs off never reloads a tab another run is scanning in. Once this write has succeeded, if the run stops early for any reason, set `refresh/status` `{state:"error",message}` before stopping, or the page shows "refreshing" for 25 minutes.
2. `tabs_context_mcp`. Find the Messenger tab on the chat in Claude's tab group (if it's gone, open it again with `tabs_create_mcp`). If it's open on a different chat, the user is using it: don't take it over; skip and reschedule. Navigate it to `chatUrl`. Check `document.visibilityState==="visible"`; if hidden or unreachable, set `refresh/status` `{state:"error",message:"computer asleep or Messenger tab hidden"}`, say nothing during a scheduled run, and reschedule.
3. Scan with `STOPS = reversed meta.anchorMids` and `BASE = meta.lastI` (helper: `full` with a fresh `run` id; no helper: the injected steps). Require the scan's `err` to be null and verify `ok:true`, `gap:0`, `prefixSame:true`. Messages that arrive during the run (`extra>0`) wait for the next run. If the scan's `err` is set, or verify fails twice, set the status to error and stop (tell the user unless it's a scheduled run). **Nothing new** (`err:null, win:0`): skip steps 4–6, and in step 7 write only `meta/chat` `{lastRefresh}` and `refresh/status` (by step 7's rule, with `added:0`). The exception is when WORK is behind (`base` below `meta/chat.lastI`): then skip only step 4 and build those messages. If the capture summary (`mc_result.capture`, or the `capture` command's result) ends with `DATES-GUESSED #…`, those messages' date labels couldn't be read and took the previous message's date: list them in the report, since Messenger may have changed its labels.
4. Import by paste:
   - Open a new tab on the user's page and wait 10 s.
   - In the Messenger tab, click COPY CAPTURE (it's drawn at the top left; center about (146,44)) and confirm `#__copyst` reads "COPIED n chars". If it says COPY FAILED, Chrome blocked the clipboard: ask the user to allow clipboard access for facebook.com.
   - In the page tab, click an empty area of the page (not a text box), wait 2 s, click again, then paste (cmd+v on Mac, ctrl+v elsewhere). Wait 8–10 s.
   - A toast reads "IMPORT OK: n new messages, #a–#b (chunks …)". If there are no photos, paste once more: it should say "Nothing new". If there are photos and no toast appears, check `refresh/lastImport` before pasting again (never import twice blindly).
   - A toast starting "REPAIRED: #a–#b (chunks …)" means an earlier import saved those messages but stopped before updating `meta/chat`; the page counted them in. Carry on, and in step 5 fetch every chunk it names as well.
   - "Photos: upload failed … paste again": the messages are saved and the photos that landed are indexed. Paste again once (photos already stored are skipped). If it fails again, say so in the report and carry on.
   - "Photos not stored: this view can't upload them": the page was opened somewhere it can't upload. Don't paste again; tell the user to open the page on claude.ai as its owner.
   - "Another import is running in another open copy of this page": close any other page tabs you opened, wait 2 minutes, and paste again.
5. Close the page tab and navigate the Messenger tab back to the chat (the capture blanked it). `get` the chunks named in the toast (plus the chunks holding any messages bootstrap reported as not built; `build` names them if they're missing) and `meta/chat` (and `photos/index` if there are photos) into a RUN folder with `out_dir` (each file holds the bare document, which is what catchup.py reads). Also `get` `threading/current`, `summary/current` and `refresh/status`. Note the `version` of all four documents written in step 7 from these reads. Look at new photos (`Artifact read` with path = the blob id, one id per call, then Read the saved file).
6. Write the spec (below), then run `python3 catchup.py build WORK RUN spec.json`. It prints `matched by quote …`, `CHECK photo-reply guess …`, `CHECK quote match (…)` (a short quote matched on the same text, or a quote found inside a message rather than at its start: confirm it like a CHECK), `WARN …`, a `GUESS i -> p` line for each non-reply message, or `ROOT i` when the previous message in its conversation is over 3 h older. `WARN link i -> p crosses conversations` means the parent is in another conversation, where the page can't show the link: join them, or set `links`.
   - Replies to photos the reader couldn't click (`perr`) show up as CHECK. Many are obvious from context ("that bag" right after that person's photo); when not, click to confirm. Example: a reply to someone's screenshot of stats is not a reply to their latest photo.
   - CHECK or WARN on a recent message: confirm by clicking that message's "Go to replied message" in Messenger and reading which message gets focus, then set `links` and rebuild. A build moves WORK forward, so first run `python3 catchup.py restore WORK` (it undoes the last build), then build again.
   - Review every GUESS by reading it in context. Override in `links` when wrong (use `null` for a message that starts a new topic and answers nothing): an answer to the conversation's opening question, a reply to a point made a few messages back, the same person continuing (`[own,'c']`), a reaction to a photo.
7. First `ArtifactData query outbox` for rows whose `state` is `queued` or `sending` (step 8 uses the same result). Then one `batch` write, every entry pinned with the `if_version` you just read: `threading/current` and `summary/current` set from `RUN/out/*.json` (`file_path`); `meta/chat` update `{lastRefresh, coverage}`; `refresh/status` **update** (a merge, so `startedAt` and `by` stay) to `{state:"done",finishedAt,added}`, or to `{state:"running",step:"outbox",added}` if the outbox has `queued` or `sending` rows, so no other run takes the Messenger tab while step 8 posts. This status rule applies to every path that reaches step 7, the nothing-new path included. If the write is refused because a version changed, `get` those documents again. If `threading/current` or `summary/current` changed (another session built in between), run `catchup.py restore WORK`, bootstrap WORK again from a fresh fetch, and continue from step 5 (only messages it hasn't built remain). If only `meta/chat` or `refresh/status` changed: when `refresh/status` now shows another run's `running` (a different `by`; it took over a stale lock), stop without writing anything, because that run carries on. Otherwise (the page or the user wrote), write again with the new versions; don't rebuild.
8. Handle the outbox: if step 7's query found `queued` or `sending` rows, read `references/outbox.md` in full first and follow it. If step 7 left the status at `step:"outbox"`, now update `refresh/status` to `{state:"done",finishedAt,added}` (pinned). Then report in bullets: how many messages, the new conversations, deals, mentions of the user, open questions, and anything guessed.

## Writing the spec (catchup.py enforces the structure)
- `join`: every new message joins exactly one conversation. Keep conversations focused; split a busy thread into sub-topics. Never make a catch-all bucket.
- `newconvs`: `{id,title,tag,outcome,key}`. Ids must be new (add a date suffix such as `gear1106`).
- `bullets`: ≤15 words each, the people's own words where useful, `refs` = the messages covered. `outcome` ≤12 words.
- `open`: real unanswered asks only. Close them (`closeOpen` + `answered`) when someone answers.
- `deals`: things actually offered or announced (sales, group buys, drops, price drops).
- `mentions`: other people naming the user (`ownerAliases`) or replying to "You". The user's own messages are never mentions.
- Neutral wording; no gendered pronouns unless the person used them.

## catchup.py
Ships as `scripts/catchup.py`. Usage: `python3 catchup.py bootstrap WORK DBDIR` then `python3 catchup.py build WORK RUNDIR SPEC`; `python3 catchup.py restore WORK` undoes the last build (WORK keeps one step in `WORK/prev`). SPEC keys: `join`, `links` (types `r`, `rq`, `rg`, `i`, `c`, or `null`), `newconvs`, `bullets`, `outcome`, `key`, `deals`, `dealEdit` (add `index` when a conversation has more than one deal), `open`, `closeOpen`, `answered`, `mentions`. It asserts: bullets ≤15 words, outcomes ≤12, each message in exactly one conversation, links point backwards with a known type, every reference belongs to its conversation (bullets, keys, open, answered, deal refs and `dealEdit` additions), mentions point at stored messages by someone else, `closeOpen` matches an open question, no question is opened twice, and the import updated `meta/chat`.

## Method ideas
The page promises the user that Claude sees these, so act on them:
- **Method ideas** (`views` with `kind:"idea"`): at the end of each refresh, query `views` for ideas whose `at` is newer than `meta/chat.ideasSeenAt` (all of them if it's unset). List each in the report in one line and offer to apply it, for example a different grouping or a new kind of call-out. Change how catch-ups are built only after the user says yes. Then set `ideasSeenAt` to the newest `at` (pinned). During a scheduled run, just list them.

## Scheduled runs
The schedule itself is set up from `references/setup.md` › Scheduling, and its choice is stored in `meta/chat.schedule` (`{mode, every, hours, tz}`: `mode` "A" is this chain, `every` the interval, `hours` the window in `tz`). When this run came from the self-scheduling chain (Option A), finish by scheduling the next one-shot follow-up into this conversation (`send_later`, the chosen interval) with the same message. Outside the chosen hours, don't run: schedule it for the start of the next window instead, so the chain never dies overnight. Check existing scheduled tasks first, so there's never more than one chain.
