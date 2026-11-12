# Outbox (replies queued with "Reply here" on the page)

Read this in full before handling any outbox row. The bridge commands (`jump`) are in SKILL.md › Helper. The row's fields are in `references/database.md` (the `outbox/r<ms>` line).

- `ArtifactData query outbox` where `state=="queued"`. For each, check `to` and `snip` against the stored message (`i`, `mid`).
- If `meta/chat.outboxAuto` is true, post each one. Otherwise list them for the user (who it's to, their message, the exact reply) and post only the ones they say yes to in chat. During a scheduled run with no one there, list them in the report and leave them queued.
- First, settle any row left in `state:"sending"` by an earlier run. Check the **saved messages**, not the screen: this run's import is done, so the chunks are current. Look for a message with `f:"You"`, `r` matching the row's `to` (the same name, or one is the start of the other: Messenger may show a first name where the chat shows the full name; "yourself" when `to` is "You"), and `b` equal to the row's `text` (ignoring whitespace), dated after `queuedAt`.
  - Found: mark it `sent` with `sentMid` set to that message's `m` and `sentAt` set to that message's time (its `d` and `t`, in `meta/chat.tz`, as an ISO time).
  - Not found, but the newest saved message is older than `queuedAt`: the chat hasn't been read past the send yet, so leave the row as it is.
  - Not found, and saved messages run past `queuedAt`, or the row is more than a day old: mark it `unconfirmed` with `error:"Not found in the chat after sending; check Messenger before queueing it again"` and tell the user.
  - Never post a `sending` or `unconfirmed` row again on your own. The page keeps both listed until they're resolved.
- Resolving: when the user says an `unconfirmed` or `failed` reply did go out, set it `sent`; when they say to drop it, set it `dismissed`. The page has a Dismiss button for these too.
- Failed rows are never retried, by you or by the page. To try again, the user queues a new reply.
- **`sent` always gets both `sentAt` and `sentMid`**, whichever way it's reached. `sentAt` is a real time, never an estimate or a rounded one (the page shows it): the clock at the confirm below, or the saved message's time when it's settled from the chunks. When the user says it went out, look for it in the saved messages as above: found, use its `m` and time; not found, `sentMid:null` and `sentAt` the time they give, or the current time.
- Every write to a row is pinned with `if_version`. The page's Cancel and Dismiss change a row's version, so a refused write means the user acted: `get` the row and go by its new `state`.

## Posting
About 3 calls per reply: one JS call types it, one DB batch records it, one browser batch sends and confirms it. Work through the approved rows one at a time, oldest `queuedAt` first. Keep a list of **pending outcomes**: `sent` or `failed` writes not made yet. Each DB batch carries them, so a row's `sent` lands with the next row's `sending`, and at most one row is ever in `sending`.

- **No `mid`** (the row's `mid` is null): don't open Messenger. Add `failed` with `error:"no Messenger id"` to the pending outcomes and go on to the next row.
- **Call 1, javascript_tool on the Messenger tab:** the code below, with `ROW` replaced by the row's `{mid,to,snip,text}` as JSON (copy the values as they are: `text` may hold line breaks). It starts `jump{mid,reply:true}`, waits for `#mcjump-tip`, checks that the "Replying to …" bar names `to` (the first name, since Messenger may shorten it; "yourself" for "You") and shows the start of `snip` (not for "[photo]"), checks the reply box is empty, and types the first line of `text`. Without the helper, inject it and start `jump` in one call first (SKILL.md › Helper), then run this with `START = false`.
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
  document.execCommand('insertText', false, first);
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
  - `{pending}`: the box is empty but the message hasn't shown up, so it may have gone out. Leave the row in `sending` (the settle check above handles it on the next run) and **stop posting** for this run, so a second row is never left in `sending`. Never mark a reply that may have been sent as `failed`: the user would queue it again.
- After the last row, or when you stop, write the pending outcomes in one batch, pinned. If the run stops between calls, at most one row is left in `sending`, and the settle check above finds it on the next run.
- To clear a box: click it, cmd+a (ctrl+a), Delete.
