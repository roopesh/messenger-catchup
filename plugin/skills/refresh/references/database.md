# Database (ArtifactData on the user's page)

The full reference. The refresh skill's SKILL.md lists what a refresh needs.

- `meta/chat`: `kind:"messenger-catchup"`, `pageVersion`, `thread` (Messenger thread id), `chatUrl` (full chat URL), `threadName`, `shortName`, `ownerName`, `ownerAliases` (names others call them), `topic`, `outboxAuto`, `refreshPhrase`, `tz` (IANA), `firstCount` (the history size chosen at setup: how many messages the first capture reads), `helper` ("installed" | "inject"), `chunkSize:82`, `lastI`, `lastMid`, `lastT`, `anchorMids` (newest 3 ids; reversed = STOPS), `caughtUpI`, `caughtUpAt`, `ownLastI`, `ownLastMid`, `markerMode` (`caught` | `own` | `time`), `markerSetAt`, `markerFrom`, `markerTo`, `lastRefresh`, `coverage`, `schedule`, `ideasSeenAt`, `aliasesAskedAt` (when the user was asked which aliases count; the refresh skill's `references/people.md`). The page writes `lastI` … `ownLastMid` when it imports, and the marker fields when the user picks a catch-up start; Claude writes the rest.
- `chunks/cNNNN` `{start, msgs:[...]}`: message fields `i` (number from 0), `t` ("Fri 8:41 AM"), `d` (date), `f` (sender as Messenger shows them: nickname or first name; the user = "You"), `fn` (full name from their avatar; helper 1.6+), `b` (text), `m` (Messenger id), `r` (replied-to name), `q` (quoted text), `pi`/`pmid`/`pq`/`perr` (reply parent), `p` (photo), `a` (link preview), `l` (links), `x` (reactions).
- `threading/*`: `current` plus the block documents it names; merged: `convs:[{id,title,members}]`, `links:{i:[parent,type]}` (r = Messenger link, rq = matched by quote, rg = photo reply best match, i = answers, c = same person continuing), `to`, `note`, `builtAt`.
- `summary/*`: the same; merged: `version:2`, `convs:[{id,tag,synopsis:[{t,refs}],outcome,key}]`, `open`, `answered`, `deals`, `mentions`, `toI`, `generatedAt` (optional `mentionsNote`, `fromI`).
- `people/index` `{people:{"<full name>":{shown:[...],firstI,lastI}},scannedAt}`: written by the page from `fn`.
- `photos/index` `{byI,byK,gifs}`, `refresh/status` (lock and status line), `refresh/lastImport`, `refresh/importLock` (the page's import lease; never write it), `outbox/*` (replies queued on the page).
- Written by the page: `qa/*` `{q,a,at,scope,toI}` (questions asked on the page's Ask tab), `views/*` (`kind:"view"`: a view the user built; `kind:"idea"`: a method idea left for Claude, `{prompt,at}`), `rangeSummaries/*` (summaries the page wrote for a past span). Written by Claude: `notes/*` `{title, when, at, intro?, table?:{cols,rows}, sections?:[{h,items:[{b?,t}]}], footer?}` (see What the page saves for Claude).

## Threading and summary documents
A document holds at most 256 KiB, so since v1.17 threading and summary are collections. Only `catchup.py` writes them, through the manifest its build prints (the refresh skill's `references/writing-the-build.md`). The page and `catchup.py bootstrap` merge them into the single documents above.
- `threading/current`: `layout:2`, `block` (messages per block, 1000), `blocks` (the ids of its block documents), `to`, `note`, `builtAt`, and `convs` holding only conversations with no messages yet.
- `threading/b<start>-<hash>`: `start`, `convs:[{id,title}]` (conversations whose first message is in the block), `members:{conv:[i,…]}` and `links:{i:[parent,type]}` for the block's messages.
- `summary/current`: `layout:2`, `block`, `blocks`, `activeFrom`, `version`, `toI`, `generatedAt`, `fromI`, `mentionsNote`, and the conversations, `open`, `answered`, `mentions` and `deals` whose messages reach `activeFrom` (recent ones).
- `summary/b<start>-<hash>`: `start`, and the older items by the block of their messages: `convs` (by their last message), `open`, `answered`, `mentions`, `deals`, and `syn:{conv:[bullets]}` (a conversation's bullets from that block).
- Merging: links, members and bullets join in block order; `convs`, `open`, `answered` and `mentions` are `current`'s then the blocks', newest block first; `deals` the blocks' oldest first, then `current`'s.
- A block id carries a hash of its content: a changed block is written as a new document and the old one is deleted after `current` stops naming it. Other documents in these collections are never touched.
- `summary.fromI` (pages from before v1.17): the first message the stored summary covers; earlier sessions dropped older conversations. The page offers summaries of spans before it (`rangeSummaries`). Kept as it is.
- A page set up before v1.17 has one `current` document each with no `layout`; it's still read, and the first build converts it.

## What the page saves for Claude
The page promises the user that Claude sees these, so act on them. (Method ideas are checked after every refresh: the refresh skill's SKILL.md › Method ideas.)
- **Questions asked on the page** (`qa`): when the user refers to something they asked on the page, read `qa` (newest first) for context.
- **Notes from Claude** (`notes`): when the user asks how the page or a refresh works, or for an analysis worth keeping, answer in chat and also save it as `notes/<short-id>` (shape above). It appears under Views › Notes from Claude.
