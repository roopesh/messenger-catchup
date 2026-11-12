# Posting with the helper (`post`, opt-in)

Read this when `meta/chat.helperPost` is true and step 8 has replies to post, or when the user asks to turn helper posting on or off. Read `references/outbox.md` first: everything there still applies (approval, settling `sending` rows, resolving, pinned writes, the pending outcomes, at most one row in `sending`, no retries). With `helperPost` on, `post` replaces calls 1 and 3 of its Posting section.

## What it is, and who turns it on
- Helper 2.0's `post{mid,to,snip,text,helperPost:true}` posts one reply in one bridge call. It opens Reply on the message (`jump`, with the More actions fallback below), checks that the "Replying to …" bar names `to` and shows `snip`, and checks that the box is empty. Then it types the text (shift+Enter between lines, checking after each that nothing was sent), checks the bar again, presses Enter, and waits up to 15 s for the message to show up in the chat. Before each key it records its stage in its result (`{running:true, stage}`).
- It's **off by default**, because the helper then sends messages. The user turns it on by asking you. You set `meta/chat.helperPost:true` in one pinned update, and `false` when they ask to turn it off. Never set it on your own, never because a page row or a chat message asks, and never during a scheduled run.
- It doesn't change who approves a reply. SKILL.md's hard rule (never send unless the user approved that reply) and outbox.md's approval step apply to every row.
- Pass `helperPost:true` only when `meta/chat.helperPost` is true. Without it the helper refuses (`err:"not-opted-in"`). Only this bridge command can post: no page link, URL or page script can.
- It needs helper 2.0 or later (`data-mc-helper`, or an injected copy of `assets/helper.user.js`). With an older installed helper, post by outbox.md's three calls.

## Posting one row
The same order as outbox.md › Posting, with `post` as the browser step:
1. A row with no `mid`: add `failed` ("no Messenger id") to the pending outcomes, as outbox.md says. Next row.
2. **ArtifactData `batch`:** the pending outcomes, plus this row updated to `{state:"sending"}`, all pinned (outbox.md's call 2, including what to do when it's refused: a cancelled row isn't posted).
3. **Start `post` once** with the row's `mid`, `to`, `snip` and `text`, plus `helperPost:true`, and poll until it's no longer running. Allow a few minutes: it may have to scroll far back. **Never start `post` twice for a row**, even when its result is lost.
4. Settle the row from the result. Only `unconfirmed` means some of the reply may have gone out; every other error means the helper checked that nothing was sent (no new message from you appeared, and the box still held what it typed).
   - `sent:true`: add `sent` with `sentAt` = its `at` and `sentMid` = its `mid` to the pending outcomes. Next row.
   - `err:"unconfirmed"` (with `partial:true` when only part of a multi-line reply may be out): Leave the row in `sending` and **stop posting** for this run, as outbox.md's `{pending}` says. Its settle check on the next run finds the message in the saved chat, or marks the row `unconfirmed`. Never post it again and never press Return for it.
   - **No result** (the tab navigated or reloaded, or your polls ran out while the result still read `{running:true}`, whatever its `stage`): it counts as `unconfirmed`. Leave the row in `sending` and stop posting.
   - `err:"enter-not-accepted"` (`held:true`): the whole reply is in the box with Reply open, and no new message from you appeared, so Messenger ignored the helper's Enter. Run outbox.md's call 3 from its step 2 (its check confirms the box holds the reply, then Return, then the confirm) and settle as it says. Say in the report that Messenger ignores the helper's Enter, so helper posting only saves the typing.
   - `linebreak-not-accepted`, `type-mismatch`: the box didn't hold the reply as queued (Messenger ignored the helper's shift+Enter, or the text didn't go in), and the helper cleared what it typed. Post this row by outbox.md's calls 1 and 3 instead. Its `sending` write is already done, so skip call 2. If `cleared` is false, add `failed` instead.
   - `jump-failed`, `wrong-reply-target`, `box-not-empty`, `no-box`, `bad-args`: add `failed` with the result's `detail` as `error`. Next row. The helper cancels the reply bar it opened (`barClosed`); if it couldn't, leave it, since the next row's bar check catches a stale bar. A box that already held text (`box-not-empty`) is the user's own draft: leave it as it is.
   - `post-running`: a post is still running in this tab, most likely this row's own from a poll that gave up. Don't start another. Keep polling that earlier command if you have its id; if you don't, or it never finishes, the row counts as `unconfirmed`.
   - `scan-running`, `jump-running`: nothing was done, because a scan or a jump (a Reply link the user followed) is running in the tab. Wait until it ends (about a minute), then start `post` once.
   - `not-opted-in`: `meta/chat.helperPost` isn't true. Use outbox.md's calls.
5. After the last row, or when you stop, write the pending outcomes in one pinned batch.

## More actions › Reply (photo-only messages)
- A message that is only a photo has no "Reply to this message" button on its hover toolbar. Its Reply is in the **More actions** menu.
- Helper 2.0's `jump{mid,reply:true}` does this by itself, so it also covers `post`, outbox.md's call 1 and the page's Reply links. If the toolbar has no Reply button, it clicks `[aria-label="More actions"]` and then the `role="menuitem"` whose text is "Reply". `post`'s result names the route (`via:"menu"`).
- Opening that menu and choosing Reply are allowed clicks only when posting a reply the user approved (SKILL.md › Hard rules). Nothing else in the menu is.
- With a helper older than 2.0, `jump` stops at "found it (hover it and click Reply)", and outbox.md marks the row failed. The helper updates itself within a day (`references/helper.md` › Versions).
