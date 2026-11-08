# Outbox (replies queued with "Reply here" on the page)

Read this in full before handling any outbox row. The bridge commands (`jump`) are in SKILL.md › Helper.

- `ArtifactData query outbox` where `state=="queued"`. For each, check `to` and `snip` against the stored message (`i`, `mid`).
- If `meta/chat.outboxAuto` is true, post each one. Otherwise list them for the user (who it's to, their message, the exact reply) and post only the ones they say yes to in chat. During a scheduled run with no one there, list them in the report and leave them queued.
- First, settle any row left in `state:"sending"` by an earlier run. Check the **saved messages**, not the screen: this run's import is done, so the chunks are current. Look for a message with `f:"You"`, `r` matching the row's `to` (the same name, or one is the start of the other: Messenger may show a first name where the chat shows the full name; "yourself" when `to` is "You"), and `b` equal to the row's `text` (ignoring whitespace), dated after `queuedAt`.
  - Found: mark it `sent` with `sentMid` set to that message's `m`.
  - Not found, but the newest saved message is older than `queuedAt`: the chat hasn't been read past the send yet, so leave the row as it is.
  - Not found, and saved messages run past `queuedAt`, or the row is more than a day old: mark it `unconfirmed` with `error:"Not found in the chat after sending; check Messenger before queueing it again"` and tell the user.
  - Never post a `sending` or `unconfirmed` row again on your own. The page keeps both listed until they're resolved.
- Resolving: when the user says an `unconfirmed` or `failed` reply did go out, set it `sent`; when they say to drop it, set it `dismissed`. The page has a Dismiss button for these too.
- To post, one at a time:
  - Start `jump{mid,reply:true}` (helper, or inject the helper first), then poll until `#mcjump-tip` shows its final text. Only "reply box is ready" lets you go on. Anything else ("found it (hover it and click Reply)", "couldn't find that message"): don't type; mark the row `failed` with the tip's text as `error`.
  - Check the reply points at this message: `const t=document.body.innerText,k=t.lastIndexOf('Replying to '+(to==='You'?'yourself':to.split(' ')[0]))` (the first name, since Messenger may shorten it). Require `k>=0`, and that `t.slice(k,k+300)` (whitespace collapsed) contains the first 20 characters of `snip` (skip that text check when `snip` is "[photo]"). Otherwise mark `failed` ("reply box points at a different message"). A reply box left open from an earlier attempt is exactly what this catches.
  - `const box=document.querySelector('[role="textbox"][contenteditable="true"]')`. Only if `box.innerText.trim()===''`: `box.focus(); document.execCommand('insertText',false,text)`, then check `box.innerText.trim()===text.trim()`.
  - Update the row to `state:"sending"`, then press Enter with the computer tool.
  - Confirm, checking for up to 15 s: the box is empty and the newest "You replied to <name>" message contains the text → `state:"sent"`, `sentAt`, `sentMid`. If the box still holds the text, it wasn't sent: clear the box and mark `failed`. If the box is empty but the message hasn't shown up yet, leave the row in `sending`; the check above settles it on the next run. Never mark a reply that may have been sent as `failed`: the user would queue it again.
- To clear a box: click it, cmd+a (ctrl+a), Delete.
