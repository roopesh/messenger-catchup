# Facebook groups (F25)

Read this when `meta/chat.chats` holds an entry with `kind:"group"` and a run reaches it (`catchup.py run-plan`), or when the user asks about groups. A group lives on the page next to the chats: its own key, tag and collections (`KEY_posts/p<postId>`, `KEY_comments/p<postId>`, `meta/chat-KEY`, `refresh/lastImport-KEY`). Everything here is read-only on Facebook.

## Hard rules for groups
- Never click inside a post: polls vote on a click, and like, react, comment and share buttons sit next to everything. The helper only scrolls, sends pointer events to a post's time link (that fills in its address), opens "View N replies", and uses a post's own comment-sort menu (which changes only your view).
- Never open a notification (a click marks it read). Reading the notifications page clears the user's red badge on Facebook; the user accepted that (every refresh).
- Groups need the helper 3.1 or later (`data-mc-helper`), installed or injected (SKILL.md › Helper).

## The entry (`meta/chat.chats.KEY`)
`{kind:"group", name, tag, color, order, state, url, group (the id or name in its address), chat? (a chat key it goes with), start:{days} (the first read, 3, 7 or 30), read:"all"|"mine", rollup (Show in All), addedAt, reason?}`. The page writes it (Settings › Add a group) as `pending`.

## A refresh of a group
Use one run id (`run`, e.g. `g` + the current time in ms) for every command of this group's refresh, and the bridge from SKILL.md › Helper. Navigation ends a running command, so start each command after its page has loaded.
1. **Known posts:** `ArtifactData query KEY_posts` (fields `pid`, `count`) into a map `{pid: count}`. None (the first read): see First read.
2. **Notifications (once per run, for all groups):** navigate the Messenger tab to `https://www.facebook.com/notifications/`, start `notifs{since: meta/chat.notifSeenTo, more: 3, run}`. Its `byGroup` lists posts to open in each group. Keep its `newest` to write as `meta/chat.notifSeenTo` at the end of the run (pinned).
3. **New posts:** navigate to the group's `url` + `?sorting_setting=CHRONOLOGICAL`, start `groupFeed{known, cap: 50, run}`. It stops at the first known post.
4. **New comments on older posts:** navigate to `url` + `?sorting_setting=RECENT_ACTIVITY`, start `groupFeed{known, cap: 50, run}` again. It stops two cards after the first unchanged post.
5. **Each changed post** (in either feed result's `changed`, plus the notification posts for this group), at most 50: navigate to `https://www.facebook.com/groups/<group>/posts/<pid>/`, start `groupPost{run, known: the post's stored comment ids}`. Each answer carries `buf` (the run buffer's counts; `store:"gm"` with helper 4.2+): if `buf.posts` ever drops below the feed's, stop and report it (the buffer was lost, #103) rather than capture.
6. **Capture:** start `groupCapture{run, group}`, click COPY CAPTURE, then paste on the page with that group picked (as for a chat, SKILL.md step 4). The page stores new posts (their `p` numbers) and new comments (their `c` numbers within the post) and says "IMPORT OK: N new posts and M new comments".
7. **Write** `meta/chat-KEY` `{lastRefresh, coverage, versions}` (pinned; `versions` as in `references/database.md` › Versions), and for a `pending` group `state:"active"` in `meta/chat.chats` (one pinned update).
8. **Report** in a bullet named for the group: new posts, threads that moved, deals (item, price, sold or not), questions to the user.

## First read and big groups
- A pending group's first read covers its `start.days` (by New posts, up to 300 posts per run): `groupFeed{cap: 300, maxDays: start.days, run}` with no `known` (helper 3.2; it stops at the first post older than that, `stop:"age"`). Comments: up to the 50 newest per post. If it stopped at the cap (`stop:"cap"`), write `catchingUp:true` in `meta/chat-KEY` (the page says "Catching up"); the next runs read on with `groupFeed{known, through: true, maxDays: start.days, cap: 300, run}` (helper 3.3: known posts don't stop it or count toward the cap) until it stops by age or at the end (`stop:"age"` or `"end"`), then write `catchingUp:false`.
- After that, 50 changed posts per run; the rest wait for the next run.
- "Read: only mine" (`read:"mine"`): open only posts the user wrote or commented on, and the notification posts.
