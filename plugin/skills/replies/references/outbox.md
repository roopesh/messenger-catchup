# Outbox (replies, reactions and group comments queued on the page)

Read this in full before handling any outbox row. The bridge is in SKILL.md › Helper, and its commands (`jump`) in `references/helper.md` › Commands. The row's fields are in `references/database.md` (the `outbox/r<ms>` line).

Two kinds of run post replies: a refresh, before its scan (its step 2) and for rows queued while it ran (step 8), and a reply-only run (the `messenger-catchup:replies` skill: "send replies"), which reads no new messages.

- `ArtifactData query outbox` where `state=="queued"`. For each, check `to` and `snip` against the stored message (`i`, `mid`). A reply-only run skips this read: call 1 and `post` check the "Replying to" bar against `to` and `snip` before typing.
- A row with `kind:"comment"` is a comment on a Facebook group's post, or a reply to one of its comments (a group's `KEY_outbox`): post and settle it by Group comments below, never by Posting. A row with `kind:"react"` is a reaction (its `emoji`, no `text`): post it by Reactions below. Every other row is a reply. A reply's `mentions` lists the people it tags (Mentions below), and its `photos` the photos that go with it (`text` may be empty then).
- **A reply with `photos`** posts only by helper posting (`references/posting-with-helper.md` › Photos, helper 2.9 or later) and Chrome's file upload. When either is missing (helper posting off, an older helper, or a run without Claude in Chrome's file upload), leave it `queued` and say in the report why it waits. When listing it for a yes, say how many photos it has.
- If auto-posting is on for the chat (its own `auto` in `meta/chat.chats` when set, else `meta/chat.outboxAuto`), post each one. Otherwise list them for the user (who it's to, their message, the exact reply or the emoji) and post only the ones they say yes to in chat. During a scheduled run with no one there, list them in the report and leave them queued.
- Settle any row left in `state:"sending"` (by an earlier run, or by this refresh's posting before its scan) only **after this refresh's import** (its step 8). Check the **saved messages**, not the screen: the chunks are current then, and they hold anything this run posted before its scan. Before the scan, and in a reply-only run, leave `sending` rows as they are: they don't hold up posting the `queued` ones. Look for a message with `f:"You"`, `r` matching the row's `to` (the same name, or one is the start of the other: Messenger may show a first name where the chat shows the full name; "yourself" when `to` is "You"), and `b` equal to the row's `text` (ignoring whitespace, and the "@" before a name in `mentions`: a sent mention may show without it), dated after `queuedAt`. Reactions are never settled this way (Reactions below), nor group comments (Group comments below).
  - Found: mark it `sent` with `sentMid` set to that message's `m` and `sentAt` set to that message's time (its `d` and `t`, in `meta/chat.tz`, as an ISO time).
  - Not found, but the newest saved message is older than `queuedAt`: the chat hasn't been read past the send yet, so leave the row as it is.
  - Not found, and saved messages run past `queuedAt`, or the row is more than a day old: mark it `unconfirmed` with `error:"Not found in the chat after sending; check Messenger before queueing it again"` and tell the user.
  - Never post a `sending` or `unconfirmed` row again on your own. The page keeps both listed until they're resolved.
- Resolving: when the user says an `unconfirmed` or `failed` reply did go out, set it `sent`; when they say to drop it, set it `dismissed`. The page has a Dismiss button for these too.
- Failed rows are never retried, by you or by the page. To try again, the user queues a new reply.
- **`sent` always gets both `sentAt` and `sentMid`** (a group comment: `sentCid`), whichever way it's reached. `sentAt` is a real time, never an estimate or a rounded one (the page shows it): the clock at the confirm below, or the saved message's time when it's settled from the chunks. When the user says it went out, look for it in the saved messages as above: found, use its `m` and time; not found, `sentMid:null` and `sentAt` the time they give, or the current time.
- Every write to a row is pinned with `if_version`. The page's Cancel and Dismiss change a row's version, so a refused write means the user acted: `get` the row and go by its new `state`.

## Posting
When `meta/chat.helperPost` is true and the helper is 2.0 or later, post with `references/posting-with-helper.md` instead: it keeps this section's bookkeeping and replaces calls 1 and 3 with the helper's `post`.

About 3 calls per reply: one JS call types it, one DB batch records it, one browser batch sends and confirms it. Work through the approved rows one at a time, oldest `queuedAt` first. Keep a list of **pending outcomes**: `sent` or `failed` writes not made yet. Each DB batch carries them, so a row's `sent` lands with the next row's `sending`, and at most one row is ever in `sending`.

- **No `mid`** (the row's `mid` is null): don't open Messenger. Add `failed` with `error:"no Messenger id"` to the pending outcomes and go on to the next row.
- **Call 1, javascript_tool on the Messenger tab:** the code below, with `ROW` replaced by the row's `{mid,to,snip,text}` as JSON (copy the values as they are: `text` may hold line breaks). It starts `jump{mid,reply:true}`, waits for `#mcjump-tip`, checks that the "Replying to …" bar names `to` (the first name, since Messenger may shorten it; "yourself" for "You") and shows the start of `snip` (not for "[photo]"), checks the reply box is empty, and types the first line of `text` (it waits a moment after focusing the box, and again before checking it: Messenger's editor drops text typed the instant the box gets focus, and shows inserted text a moment later). Without the helper, inject it and start `jump` in one call first (SKILL.md › Helper), then run this with `START = false`.
```js
await (async () => {
  const R = ROW, START = true;
  const z = ms => new Promise(r => setTimeout(r, ms)), sq = s => (s || '').replace(/\s+/g, ' ').trim();
  const tipEl = () => document.getElementById('mcjump-tip'), done = /ready|found it|couldn|not loaded/;
  if (START) {
    if (tipEl()) tipEl().textContent = '';
    const cmd = { id: 'j' + Date.now(), cmd: 'jump', args: { mid: R.mid, reply: true } };
    document.dispatchEvent(new CustomEvent('mc-cmd', { detail: JSON.stringify(cmd) }));
  }
  let tip = '';
  for (let k = 0; k < 40 && !done.test((tip = tipEl()?.textContent || '')); k++) await z(500);
  if (!done.test(tip)) return { wait: tip };
  if (!/ready/.test(tip)) return { fail: tip };
  const bar = 'Replying to ' + (R.to === 'You' ? 'yourself' : R.to.split(' ')[0]);
  let t = '', k = -1;
  for (let w = 0; w < 10 && k < 0; w++) {
    if (w) await z(300);
    t = document.body.innerText;
    k = t.lastIndexOf(bar);
  }
  if (k < 0 || (R.snip !== '[photo]' && !sq(t.slice(k, k + 300)).includes(sq(R.snip).slice(0, 20))))
    return { fail: 'reply box points at a different message' };
  const box = document.querySelector('[role="textbox"][contenteditable="true"]');
  if (!box) return { fail: 'no reply box' };
  if (sq(box.innerText)) return { fail: 'the reply box already had text in it' };
  const first = R.text.split('\n')[0];
  box.focus();
  await z(150);
  document.execCommand('insertText', false, first);
  await z(100);
  if (sq(box.innerText) !== sq(first)) return { fail: 'the reply box did not take the text', clear: true };
  return { typed: true, lines: R.text.split('\n').length };
})()
```
  - `{wait}`: the helper is still scrolling to the message. Run it again with `START = false`.
  - `{fail}`: nothing was sent (and nothing typed, unless `clear` is set: then clear the box). A reply box left open from an earlier attempt is exactly what the bar check catches. Add `failed` with `fail` as `error` to the pending outcomes, and go on to the next row.
  - `{typed}`: go on.
- **Call 2, ArtifactData `batch`:** the pending outcomes, plus this row updated to `{state:"sending"}`, every write pinned with `if_version` (this row's version from your query). Once it lands, empty the pending list. If it's refused, it wrote nothing: `get` its rows. If this row's `state` is no longer `queued`, the user cancelled it on the page, and their Cancel wins: clear the box, don't post it, and keep the pending outcomes for the next batch. Otherwise send the batch again with the new versions.
- **Call 3, `browser_batch` on the Messenger tab**, in this order:
  1. Only for a reply with line breaks: for each line after the first (`text.split('\n')`), `computer` key `shift+Return`, then javascript_tool `document.execCommand('insertText',false,LINE)` with that line as a JSON string (skip the insert for an empty line, so a blank line stays blank). Messenger's editor drops line breaks inside inserted text, so never insert a `\n`.
  2. javascript_tool, the check: the box must hold `text`, compared with whitespace collapsed. If it doesn't, the check takes the focus off the box and throws, which stops the batch, so Return never reaches the box.
```js
(() => {
  const R = ROW, sq = s => (s || '').replace(/\s+/g, ' ').trim();
  const box = document.querySelector('[role="textbox"][contenteditable="true"]');
  window.__mcSeen = new Set([...document.querySelectorAll('[data-message-id]')].map(e => e.getAttribute('data-message-id')));
  window.__mcAbort = box && sq(box.innerText) === sq(R.text) ? null : 'the reply box did not match the reply';
  if (window.__mcAbort) {
    box?.blur();
    throw new Error(window.__mcAbort);
  }
  box.focus();
  return 'ok';
})()
```
  3. `computer` key `Return`.
  4. javascript_tool, the confirm: for up to 15 s, the box is empty and a new "You replied to <name>" message holds the text.
```js
await (async () => {
  const R = ROW, sq = s => (s || '').replace(/\s+/g, ' ').trim();
  const ab = window.__mcAbort;
  window.__mcAbort = undefined;
  if (ab !== null) return { abort: ab || 'the check did not run' };
  const who = 'You replied to ' + (R.to === 'You' ? 'yourself' : R.to.split(' ')[0]);
  const box = () => document.querySelector('[role="textbox"][contenteditable="true"]');
  const seen = window.__mcSeen || new Set();
  for (let k = 0; k < 30; k++) {
    await new Promise(r => setTimeout(r, 500));
    const m = [...document.querySelectorAll('[data-message-id]')]
      .filter(e => !seen.has(e.getAttribute('data-message-id')) && e.innerText.includes(who))
      .pop();
    if (!sq(box()?.innerText) && m && sq(m.innerText).includes(sq(R.text)))
      return { sent: true, mid: m.getAttribute('data-message-id'), at: new Date().toISOString() };
  }
  return sq(box()?.innerText) ? { held: true } : { pending: true };
})()
```
  - `{sent}`: add `sent` with `sentAt` = its `at` and `sentMid` = its `mid` to the pending outcomes. Next row.
  - The check threw (the batch stopped there), or the confirm returned `{abort}`: nothing was sent. Clear the box, add `failed` ("the reply box did not match the reply"). Next row.
  - `{held}`: the box still holds the text, so it wasn't sent. Clear the box, add `failed` ("Messenger didn't send it"). Next row.
  - `{pending}`: the box is empty but the message hasn't shown up, so it may have gone out. Leave the row in `sending` (the settle check above handles it after the next import: this refresh's step 8 when it posted before its scan) and **stop posting** for this run, so a second row is never left in `sending`. Never mark a reply that may have been sent as `failed`: the user would queue it again.
- After the last row, or when you stop, write the pending outcomes in one batch, pinned. If the run stops between calls, at most one row is left in `sending`, and the settle check above finds it on the next run.
- To clear a box: click it, cmd+a (ctrl+a), Delete.
- These calls type a reply's `mentions` as plain text: nobody is tagged. Say so in the report (Mentions below).

## Mentions
- A reply's `mentions` holds full names that its `text` writes as "@" plus the name (the page's "@" suggestions put them there). Only helper posting (`references/posting-with-helper.md`, helper 2.7 or later) makes them real Messenger mentions: it types "@" and the name, picks that person in Messenger's mention list and presses Tab. A name the list doesn't offer exactly stays plain text, and the result lists it in `missed`.
- In the report, name every person not tagged (in `missed`, or every name when the reply went by the calls above): "@Ana Alvarez went out as plain text: Messenger's list didn't offer that name". On that run, compare the name with `people/index` and the chat's members as Messenger lists them, and tell the user what differs (a nickname, a changed name, someone who left), so their next reply tags them.

## Reactions
A row with `kind:"react"` adds its `emoji` to the message `mid` in Messenger. Approval, the pending outcomes, pinned writes and one row at a time are the same as for replies. Only the helper's `react` (helper 2.7 or later; 2.8 for a removal) posts one; with an older helper leave the row `queued` and say in the report that it waits for the helper's own update (within a day, `references/helper.md` › Versions).
1. No `mid`: add `failed` ("no Messenger id") to the pending outcomes. Next row.
2. **ArtifactData `batch`:** the pending outcomes, plus this row updated to `{state:"sending"}`, pinned (as call 2 above, including a refused write: a cancelled row isn't posted).
3. **Start `react` once** with `{mid, emoji, search, approved:true}` (and `remove:true` for a removal row), and poll until it's no longer running. `search` is the English word Messenger's emoji search knows it by ("fire" for 🔥, "pray" for 🙏), used only when the emoji isn't in the message's reaction menu or the picker's first page. Pass `approved:true` only for a row approved as above. Never start it twice for a row.
4. Settle it:
   - `done:true` (also with `already:true`: your reaction there was already that emoji, so nothing was clicked): add `sent` with `sentAt` = its `at` and `sentMid` = the row's `mid`. `replaced` names the reaction of yours it replaced (Messenger keeps one per person): say so in the report. Next row.
   - `err:"unconfirmed"`, or no result: it clicked the emoji but the message didn't show it, so it may be there. Add `unconfirmed` with `error:"Clicked, but Messenger didn't show it; check the message in Messenger"`. Next row.
   - `post-running`, `scan-running`, `jump-running`: nothing was done. Wait until it ends (about a minute), then start `react` once.
   - Any other `err` (`jump-failed`, `no-react-button`, `no-menu`, `emoji-not-found`, `bad-args`, `not-approved`): nothing was clicked. Add `failed` with the result's `detail` as `error`. Next row.
- **Removing one** (F38): a row with `remove:true` takes the user's `emoji` off the message. Same steps, with `remove:true` in the `react` call (`search` isn't needed). `done:true` with `removed:true`: settle it `sent` as above. `already:true`: their reaction there wasn't that emoji (changed or removed in Messenger meanwhile), so nothing was clicked: settle it `sent` too and say so in the report. `unconfirmed`: as above ("Clicked to remove it, but Messenger still showed it; check the message in Messenger"). `err:"not-in-menu"`: the emoji isn't one of the message's reaction menu emoji, where Messenger marks your reaction, so the helper can't remove it: add `failed` with its `detail`, and tell the user to remove it in Messenger.
- Changing a reaction is a new row with the new emoji: Messenger keeps one per person, so adding it replaces the old one (`replaced`). The page cancels a reaction still `queued` by itself; it writes a `remove:true` row only for one already sent.

## Group comments
A row with `kind:"comment"` in a group's `KEY_outbox` (F25 G3a; queued on the group's Posts) is a comment on the post `pid` (the page's #p`n`), or, with `cid`, a reply to its comment #p`n`/c`c` (`rid` is that comment's own id when it is itself a reply). `to` is the author of what it answers and `snip` its text. Text only: photos come later (G3b).
- **Only the helper's `groupComment` posts one** (helper 4.4 or later), and only with `meta/chat.helperPost` true (`references/posting-with-helper.md`: the user turns it on). With helper posting off or an older helper, leave the row `queued` and say in the report why it waits. There are no manual calls for these.
- **Approval** is the same rule: the group's own `auto` in `meta/chat.chats` when set, else `meta/chat.outboxAuto`, else a yes in chat to that exact text. When listing one for a yes, name the group, #p`n` (or #p`n`/c`c`), `to`, the start of `snip` and the exact text. During a scheduled run with no one there, list them in the report and leave them queued.
- One row at a time, oldest `queuedAt` first, with the pending outcomes, pinned writes and at most one row in `sending`, as for replies.

1. **ArtifactData `batch`:** the pending outcomes, plus this row updated to `{state:"sending"}`, pinned (as Posting's call 2, including a refused write: a cancelled row isn't posted).
2. **Open the post:** in the Messenger tab (Claude's one facebook.com tab; never another of the user's tabs), navigate to `https://www.facebook.com/groups/<group>/posts/<pid>/` with the entry's `group` (a refresh has it as `postUrl` from `catchup.py chats`), and wait for it to load. Read `data-mc-helper` there: none, or older than 4.4, inject the helper (`references/helper.md` › Injecting) and start the command in that same call.
3. **Start `groupComment` once** with `{group, pid, cid, rid, to, text, me, helperPost:true}`: `group` the entry's `group` (a list with its `slug` too when it has one), `cid`, `rid` and `to` only for a reply, `me` the user's names (`ownerName` and `ownerAliases`). Poll until it's no longer running. **Never start it twice for a row**, even when its result is lost. It checks the tab is on that group and post before typing anything, finds the comment by its ids and opens its Reply (checking the reply box names `to`), or uses the post's own comment box, types, presses Enter, and confirms the new comment by its `comment_id`.
4. **Settle it from the result.** Only `unconfirmed` means the comment may have gone out; every other error means nothing was posted.
   - `sent:true`: add `sent` with `sentAt` = its `at` and `sentCid` = its `id` (the new comment's own id) to the pending outcomes. Next row.
   - `err:"unconfirmed"`, or no result (the tab navigated, or your polls ran out while it still read `{running:true}`): leave the row in `sending` and **stop posting** group comments for this run. The group's next read settles it (below). Never post it again.
   - `err:"enter-not-accepted"` (`held:true`): the whole comment is in the box and nothing was posted, so Facebook ignored the helper's Enter. Click into that box (`find` it by the comment's text), press `computer` key `Return` once, then leave the row in `sending` and stop posting group comments: the next read settles it. Say in the report that Facebook ignores the helper's Enter.
   - `post-running`, `scan-running`, `jump-running`: nothing was done. Wait until it ends (about a minute), then start `groupComment` once.
   - `not-opted-in`, `bad-args`, `wrong-group`, `wrong-post`, `no-post`, `comment-not-found`, `no-reply-button`, `no-box`, `wrong-reply-target`, `box-not-empty`, `type-mismatch`: nothing was posted. Add `failed` with the result's `detail` as `error`. Next row. A reply box the helper opened stays open with only the person's name in it; a box that already held text is the user's draft: leave both as they are.
5. After the last row, or when you stop, write the pending outcomes in one pinned batch.

- **Settling a `sending` group row** happens only after that group's next read (the import of a group refresh, which opens the row's post), never in a reply-only run. `get` `KEY_comments/p<pid>` and look for a comment with `byYou` true, stored after `queuedAt` (its `firstSeen`), whose `text` equals the row's `text` ignoring whitespace, or is that text after the name of `to` (Facebook starts a reply with the person's name); for a reply also with a `rid` and the row's `cid`.
  - Found: `sent` with `sentCid` its `rid` (a reply) or `cid`, and `sentAt` its `firstSeen` (a comment's own time is only estimated from its age).
  - Not found, and this run didn't read the post: leave the row as it is.
  - Not found, and the post was read after `queuedAt`, or the row is more than a day old: `unconfirmed` with `error:"Not found on the post after posting; check Facebook before queueing it again"`, and tell the user.
- Resolving, failed rows and pinned writes are as for replies above; a group row's `sent` carries `sentCid` (with `sentAt`) where a reply's carries `sentMid`. When the user says one went out and it isn't stored, `sentCid:null`.
