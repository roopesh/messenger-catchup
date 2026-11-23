# Several chats on one page

Read this when `meta/chat.chats` lists more than one chat, when the user names a chat ("refresh Tea Room", "refresh tea"), or when `meta/chat` has no `chats` yet (the upgrade below, once).

The owner manages their chats on the page (title ▾ › Add a chat, and Settings ⚙ › Your chats): adding, tags, pausing, removing and each chat's reply setting all work without Claude. Don't add, remove, pause or retag a chat yourself unless the user asks; the page writes what they choose and the next refresh of that chat does the rest.

## The data
- `meta/chat.chats` (written by the page, and once by the upgrade): `{<key>: {name, tag, color, order, state, home?, url?, thread?, start?, photos?, auto?, addedAt, reason?, deletedAt?}}`. The key is fixed for life (1-6 lowercase letters and digits); `tag` is what the owner sees in citations and can rename. `state`: `active`, `pending` (added on the page, not read yet), `paused` (refreshes skip it), `hidden` (removed, kept; it can come back) or `deleted` (removed, its documents and photos deleted by the page; the key is never reused).
- The **first chat** (`home:true`) keeps the page's own documents: `meta/chat`, `chunks/*`, `threading/*`, `summary/*` and the rest, exactly as a one-chat page. A page without `chats` is that one chat.
- An **added chat** `KEY` has its own: collections `KEY_chunks`, `KEY_threading`, `KEY_summary`, `KEY_digests`, `KEY_reports`, `KEY_photos`, `KEY_captions`, `KEY_people`, `KEY_outbox`, `KEY_rangeSummaries`; `meta/chat-KEY` (that chat's own fields: `key`, `thread`, `chatUrl`, `threadName`, `shortName`, `topic`, `firstCount`, `chunkSize`, `lastI` … `markerTo`, `lastRefresh`, `coverage`, `photosOwed`); `refresh/lastImport-KEY`.
- Shared by every chat: `meta/chat`'s page-wide fields (`ownerName`, `ownerAliases`, `tz`, `refreshPhrase`, `outboxAuto`, `helperPost`, `schedule`, `versions`, `pageVersion`, `assetUsage`, `photoPack`, `ideasSeenAt`), `refresh/status` (the one run lock), `refresh/importLock`, `refresh/schedule`, `refresh/packing`, `notes/*`, and `qa/*` and `views/*` (an added chat's rows carry `chat: KEY`; the first chat's have none).
- `python3 catchup.py chats META.json KEY` (META.json: `meta/chat` as you read it) prints where chat KEY's documents live, its `--chat` argument (empty for the first chat), `auto` (below) and, for a pending chat, the `meta/chat-KEY` to seed.

## The upgrade (once per page)
If `meta/chat` has no `chats`: `python3 catchup.py chats META.json` prints the one write that adds it (`{}` when there's nothing to do). Write it as a `meta/chat` update pinned with the version you read. Refused: read `meta/chat` again and retry once. If that fails too, say so in the report and go on: the page reads a page without `chats` as one chat, so nothing is lost and the next refresh tries again. It changes nothing else.

## Which chat a refresh is for
- A **scheduled run** and "refresh my catch-up" (`refreshPhrase`): the first chat only, exactly as SKILL.md says, unless it's `paused` (then skip it quietly and reschedule). Added chats aren't in the schedule yet: the page says so.
- "**Refresh** <name or tag>": that chat only, under the same lock. `paused` or `hidden`: say so and ask before refreshing it. `pending`: its first refresh (below). Several named: one after another, one at a time.
- Never two chats at once: one Messenger tab, one clipboard, one paste at a time.

## Refreshing an added chat KEY
Follow SKILL.md's Refresh steps with these changes. Everything not named here is as written there.
- **Names.** Every collection and document is chat KEY's (`catchup.py chats` prints them): read `meta/chat` (page-wide fields, `chats`) **and** `meta/chat-KEY` (the chat's `thread`, `chatUrl`, `lastI`, `anchorMids`, `firstCount`, `photosOwed`); step 1's lock is the shared `refresh/status` with `by:"refresh KEY"`; list `KEY_chunks`, `KEY_threading`, `KEY_summary`, `KEY_digests` and query `KEY_reports` and `KEY_outbox`.
- **catchup.py**: add `--chat=KEY` to every command, and keep a separate WORK for each chat (`WORK-KEY`). The out_dirs hold the chat's documents under their own names (`KEY_chunks/`, `meta/chat-KEY.json`), which is what `--chat=KEY` reads; manifests name KEY's collections. catchup.py refuses a WORK or RUN of another chat.
- **The Messenger tab (step 2).** One Messenger tab in Claude's tab group serves every chat of the page: navigate it to the chat's `chatUrl` and wait only for the helper to load, never for the tab to be on a chat by itself. A tab on one of the page's chats is Claude's to move; a tab on a chat that isn't on the page is the user's (SKILL.md step 2). Run `selfcheck` once per chat per run.
- **The scan (step 3).** The helper's results carry `thread` (helper 2.3 and later): accept a result only when it equals the chat's `thread`. An added chat refuses a capture without it, so with an older installed helper (`data-mc-helper` 2.2 or lower) inject the current one for that chat's steps (`references/helper.md` › Injecting: it takes over from the installed copy until the tab reloads, so never run `full` then; run the injected steps one at a time), and tell the user to update the helper (`references/helper.md` › Versions). The first chat takes a capture without `thread`, as before several chats, so its refreshes (scheduled ones too) work with any helper. `full` returning `stage:"wrong-thread"` means the tab was moved to another chat mid-scan: navigate back to `chatUrl` and start again with a fresh `run` id.
- **The paste (step 4).** The page opens on All chats, with the first chat loaded under it. Before pasting, click the title (it reads "All chats") and pick the chat (a pending chat opens too, saying it waits for its first refresh), then paste. The picker doesn't switch while the page tab is still storing photos or packing: wait, as photos.md › Waiting says. The page refuses a capture from another chat ("This capture is from …, not …"): pick the right chat and paste again. A chat whose `photos` is false stores no photos: skip the photo steps.
- **Writes (step 7).** `lastRefresh` and `coverage` go to `meta/chat-KEY` (pinned). `versions` belongs to the first chat (the page compares it with `meta/chat.lastRefresh`): don't write it for an added chat. **Nothing new:** only `meta/chat-KEY`'s `lastRefresh`, and `refresh/status`.
- **Report:** name the chat in the first bullet ("Tea Room: 12 new messages").

## A pending chat's first refresh
1. `python3 catchup.py chats META.json KEY` for its seed. Take the lock as step 1 does.
2. Navigate the Messenger tab to its `url`. Check it opens a group chat the user is in (a message box, the chat's name in the header; no "not available", no PIN prompt). If not, update `meta/chat` (pinned) `{chats:{KEY:{reason:"<what you saw, one short sentence>"}}}`, leave it `pending`, release the lock with `{state:"done",finishedAt,added:0}`, and tell the user. Other chats are unaffected.
3. Seed in one batch: `meta/chat-KEY` from the seed with `threadName` (the header's name), `shortName` and `topic` (a few words, from the messages you see); `KEY_threading/current` `{convs:[],links:{},to:-1,note:""}`; `KEY_summary/current` `{version:2,convs:[],open:[],answered:[],deals:[],mentions:[],toI:-1}`.
4. Run the first refresh for it by `references/first-run.md`, with the changes above (`firstCount` is its `start`).
5. Then update `meta/chat` (pinned) `{chats:{KEY:{state:"active", name:"<threadName>", reason:null}}}`, keeping the tag the owner chose.

## Replies in several chats
- Whether a queued reply goes out without asking follows the chat's own `auto` when it's `true` or `false`, else the page default `meta/chat.outboxAuto` (`catchup.py chats` prints the result as `auto`). The rest of the approval rule is SKILL.md's.
- Step 2's "Replies first" and step 8 handle the chat being refreshed: its `KEY_outbox`. A reply is posted only with the tab on that chat's `chatUrl`, after `selfcheck` and outbox.md's checks, so it never lands in another chat.
- "Send replies" (`messenger-catchup:replies`) covers every live chat; its SKILL.md says how.
