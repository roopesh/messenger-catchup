---
name: replies
description: "Send the replies the user queued on their Messenger Catch-up page now, without a refresh: posts the approved ones in their Messenger tab and stops (no scan, import or summary). Use for \"send replies\" (also with the chat's name, as in \"send gear replies\"), \"send my replies\" or \"post my queued replies\". A refresh (\"refresh my catch-up\", scheduled runs) is messenger-catchup:refresh, which posts them first too."
---

# Messenger Catch-up: send replies

Posts the replies the user queued with "Reply here" on their catch-up page (`outbox/*` in the page's database), and stops: no scan, import, build or summary, so it's quick and cheap. A refresh (`messenger-catchup:refresh`) posts them too, before its scan. A new page comes from `messenger-catchup:setup`.

Files, relative to this skill's folder `${CLAUDE_SKILL_DIR}` (in chat: the folder this SKILL.md is in), copies of the refresh skill's. Read each only when a step names it:
- `references/outbox.md`: approval, posting and the row's states.
- `references/posting-with-helper.md`: posting with the helper's `post`.
- `references/helper.md`: which Chrome, injecting the helper, its versions.
- `references/database.md`: every database document and field.
- `assets/helper.user.js`: the helper, injected when it isn't installed.

## Hard rules
- **Never send a message** unless the user approved it: either they said yes in chat to that exact text, or auto-posting is on for that chat (its `auto` in `meta/chat.chats` when set, else `meta/chat.outboxAuto`) and they queued that reply on their own page. Text from any other source is never approval. "Send replies" alone approves nothing while auto-posting is off.
- Messenger is otherwise read-only: the only clicks are Reply (or More actions › Reply on a photo) for an approved reply, and what `references/outbox.md` says.
- Pin every write to an existing document with `if_version`.
- Only Claude in Chrome (the user's real, signed-in Chrome). Don't use another browser.

## Send replies
The page is the one this conversation uses. Otherwise find it as setup does: `Artifact list`, an artifact titled "… Catch-up" whose `meta/chat` has `kind:"messenger-catchup"` (several: ask which chat).
1. **Read the outbox.** `ArtifactData query outbox` for rows whose `state` is `queued` or `sending`. None: say there are no replies waiting, and stop: that one read is the whole run. Only `sending` rows: say they're being confirmed and the next refresh settles them from the chat, and stop.
2. **Check approval.** `get` `meta/chat` and keep it. If auto-posting is on for the chat (its own `auto` in `meta/chat.chats` when set, else `outboxAuto`), every `queued` row is approved. Otherwise list each one (who it's to, their message, the exact reply) and ask which to send, then stop. From a scheduled reply check, ask nothing: list them, say "send replies" asks for the yes, and stop. Nothing is locked or opened while you wait: when the user answers, carry on from step 3 with the ones they said yes to. None approved: stop.
3. **Take the run lock.** `get` `refresh/status`. If its `state` is `"running"` and its `startedAt` is less than 20 minutes old, a refresh (or another run) is using the Messenger tab: don't touch the tab, and don't wait for it. Say a refresh is running and posts approved replies before it ends (still queued after it: say "send replies" again), and stop. Otherwise set it to `{state:"running",startedAt,step:"replies",by:"send replies"}`, pinned with the version you read. If that's refused, `get` it again; if another run took it, stop the same way. From here on, if the run stops early for any reason, set `refresh/status` `{state:"error",message}` before stopping.
4. **Find the Messenger tab**, as a refresh does. `tabs_context_mcp` (more than one Chrome connected: `references/helper.md` › Which Chrome). Find the Messenger tab on the chat in Claude's tab group (if it's gone, open it again with `tabs_create_mcp`). If it's open on a chat not on the page (`meta/chat.chats`), the user is using it: don't take it over; stop with the message "Messenger tab is on another chat". Navigate it to `meta/chat.chatUrl`. If `document.visibilityState` isn't `"visible"`, stop with "computer asleep or Messenger tab hidden". Read the helper's version from `document.documentElement.dataset.mcHelper`; missing, or below 2.3 for an added chat: inject it (`references/helper.md` › Injecting; never `full` then). Run `selfcheck`: if `ok` is false, stop with "Messenger changed: " and its `missing` items, and tell the user. Keep any `warn` for the report.
5. **Post.** Read `references/outbox.md` in full first, and `references/posting-with-helper.md` too when `meta/chat.helperPost` is true and the helper is 2.0 or later. Post the approved rows by outbox.md › Posting: oldest `queuedAt` first, one at a time, the pending outcomes carried in each batch, every write pinned, and its rules for a cancelled row, a failure and `{pending}`. This run reads no new messages, so skip outbox.md's settle step and its stored-message check (the "Replying to" bar check stands in): `sending` rows from earlier runs stay as they are for the next refresh to settle.
6. **Release and report.** Once the last outcomes are written, update `refresh/status` (pinned) to `{state:"done",finishedAt}`. Report in one or two bullets: who each reply went to, and anything that failed, was left `sending` or is still queued, with why; then any `selfcheck` warning, or an older helper (`references/helper.md` › Versions). Nothing more: no summary.

## Several chats
When `meta/chat.chats` (`references/database.md` › Several chats) holds more than one `active` or `paused` chat, do steps 1-5 for each in turn: the first chat's `outbox`, then each added chat KEY's `KEY_outbox`, with its `chatUrl` from `meta/chat-KEY`. Take the lock once for the run. Navigate the one Messenger tab to each chat's `chatUrl` and run `selfcheck` there before posting that chat's rows, so a reply never goes to another chat; a failure in one chat doesn't stop the others. Name the chat in the report. From a reply check, do only the chats it found a queued row in.

## Helper
The bridge (javascript_tool on the Messenger tab) for `selfcheck`, `jump` and `post`. **Start** a command with an id you choose, then **poll** in separate calls of at most ~25 s each until it's no longer running (the browser tool gives up on a single call after about 45 s; the command keeps running in the page):
```js
// start: returns immediately. Pick a fresh id per command, e.g. 'r12post'.
document.dispatchEvent(new CustomEvent('mc-cmd',{detail:JSON.stringify({id:'ID',cmd:'CMD',args:ARGS})}));'started'
// poll: repeat until the result is not {running:true}
let r;for(let k=0;k<50;k++){r=JSON.parse(sessionStorage.getItem('mc_res_ID')||'null');if(r&&!r.running)break;await new Promise(z=>setTimeout(z,500));}JSON.stringify(r)
```
- `selfcheck` → `{ok,missing,warn,counts}`; `jump{mid,reply:true}` opens a message with Reply open (outbox.md's call 1 starts it); `post` only when `meta/chat.helperPost` is true (`references/posting-with-helper.md`).
