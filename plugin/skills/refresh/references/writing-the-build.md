# Writing a build to the page

Read this the first time you write a build or a relink in a session; when a build prints `REACT?` or `CLOSE?` (Claims); before a `move` (Moving a message); when bootstrap says a collection is "in the single-document layout", warns about block documents no current names, or stops; when a write is refused or stops partway; and when `catchup.py` stops on a document's size or a listing.

## The manifest
A page database document holds at most 256 KiB (262,144 bytes), and threading and summary grow with every refresh (about 25 and 50 bytes a message; a busy chat adds hundreds of messages a day). So each is a collection: `threading/current` and `summary/current` name block documents (`blocks`), each covering 1,000 messages (the layout: `references/database.md`). The page merges them back into one and shows everything. `catchup.py build` (and `relink`) reads step 5's listing of the whole collections in RUN (it stops if RUN holds only the `current` documents), writes only the documents that changed into `RUN/out/` and lists them in `RUN/out/manifest.json`:
- `batches`: send each, in order, as one `ArtifactData batch`, its entries as listed (`op`, `collection`, `doc_id`, `file_path`). An entry with `pin:true` (only the `current` documents) gets `if_version` from step 5's read. The others are new documents, so they're written without one. Add `meta/chat` and `refresh/status` (SKILL.md step 7) to the last batch. Nearly every build is one batch. `catchup.py` keeps each batch to 48 documents and 900 KiB, inside the tool's 50 writes and 1 MiB.
- `cleanup`: the blocks the replaced `current` named that the new one doesn't. Only after every batch has succeeded, delete them, one batch per entry, each pinned with its version from step 5's listing. Skip any that listing didn't show. If the cleanup is refused, carry on; those blocks then stay, unused. Blocks no `current` names are never in it (below).
- `sizes`: the bytes of each document written.
- `RUN/out/merged/` holds the whole merged state, for reading only. Never write it to the database.

A changed block gets a new document id (its name carries a hash of its content), and the old one stays until `current` stops naming it. So a run that stops partway changes nothing the page reads. The next run bootstraps from what's there and rebuilds, finds the blocks it already wrote (it doesn't write them again), and finishes.

## Never drop anything to save space
Never delete, shorten or prune conversations, bullets, answers, deals, mentions, links or messages to make a document smaller, and never invent a window or cut-off of your own. Sessions before v1.17 did, and the summaries they dropped are gone unless the page kept a backup (`references/restoring-a-summary.md`, only when the user asks). `catchup.py` splits the documents so each fits, with room to spare. If a build stops with "… would be N bytes, over the 245760-byte limit", nothing was written and WORK didn't move (there's nothing to restore). Do what the message says, usually: start a new conversation for the new messages instead of joining the one it names, then build again. Tell the user. Never edit block documents by hand.

`summary.fromI`, on pages from before v1.17, is the first message the stored summary covers: earlier sessions dropped what came before and moved it. Keep it. The page offers to summarize spans before it, and a build never changes it (only a restore from a backup moves it back). A conversation whose summary was dropped gets a new one when it's continued.

## The first build on v1.17
On a page still in the single-document layout, the first build converts it: its manifest creates the blocks and replaces both `current` documents, usually in one batch. Nothing else changes, and nothing is dropped. Say so in the report in one line.

## Refused writes
A batch the tool refuses (a changed version, a missing pin, an existing document written as new) writes nothing; the result says so. A batch the tool applies one write at a time and that stops partway is different: see A partly applied write. After a refusal, `get` the documents it names again, then:
- **`threading/current` or `summary/current` changed** (another session built in between): `catchup.py restore WORK`, bootstrap WORK again from a fresh fetch, and continue from step 5 (only messages it hasn't built remain).
- **Only `meta/chat` or `refresh/status` changed:** if `refresh/status` now shows another run's `running` (a different `by`; it took over a stale lock), stop without writing anything, because that run carries on. Otherwise (the page or the user wrote), send the same batch again with the new versions. Don't rebuild.
- **A new block already exists** (a run that stopped partway wrote it after your bootstrap): `catchup.py restore WORK`, bootstrap again from a fresh fetch, and build again. The rebuild skips it.
- **An earlier batch of the same manifest succeeded and a later one was refused:** the same rules. Blocks already written are found and skipped when you build again.
- **A relink:** `catchup.py restore WORK` and bootstrap again.

## A partly applied write
If the tool applied a batch one write at a time and stopped partway (its result says which writes landed), `threading/current` may name the new build while `summary/current` doesn't. The next bootstrap stops with "threading/current is built through #a but summary/current through #b". If this session still has that build's `RUN/out/manifest.json`, send the rest of its last batch again (fresh versions from a new `get`) and bootstrap again. Otherwise run `catchup.py bootstrap WORK DBDIR --rollback`: threading's messages after #b count as not built yet (their links and conversation joins are dropped from WORK), and the next build threads and summarizes them again; its RUN must include their chunks, which bootstrap names. Say so in the report. If it says summary is ahead of threading, write nothing and tell the user.

## Blocks no current names
Bootstrap counts block documents that no `current` names and leaves them alone. Usually they're from a run that stopped before its `current` documents (the next build adopts the ones it rebuilds identically). If bootstrap warns that they hold messages past threading/current's last one, `current` may instead have been replaced by an older version of the skill, and those blocks hold the newer build. Never delete them; mention it in the report, so the user can ask for help restoring them.

## A missing block
If bootstrap says a `current` names a block that isn't in the folder after you listed the whole collection, that block was deleted, and part of the history can't be merged. Write nothing, set `refresh/status` to error, and tell the user. Don't try to rebuild around it. The page shows a notice when it can't load a block.

## Claims
In a chat whose `meta/chat.topic` suggests buying, selling or trading, `catchup.py build` prints a line for each new short message such as "In", "I'm in", "in for 2", "Dibs", "Mine", "I'll take it", "Sold", "PM'd", "DM sent" or "Interested":
`REACT? 3232 (Ben: "In!!") -> 3228, 3219, 3201`
The numbers are up to three posts it may react to, newest first: photo posts, offers and messages of open deals, by someone else, in the 3 days before it. The line links nothing: you decide. A raffle spot claim ("#7", "in for 2 spots") gets no line; handle it as any other message.
- "In" often just means someone likes what was just posted, and that may not be for sale. Read the candidates and the messages around them.
- **Link it to the post it reacts to** (`links`: `[post, "i"]`) and join it to that post's conversation, so it shows up there. If an earlier build filed it elsewhere, `move` it (below).
- **The post is for sale** (an offer or a deal): it's a claim. Add a bullet, "Ben is in" (or "Ben is in for 2"), and add it to that deal's `claims` with `dealEdit` `{"addClaims": [{"i": 3232, "who": "Ben", "n": 2}]}`: `who` exactly as `f` on the message, `n` the count (1 when none is given). A new deal takes `claims` directly. `catchup.py` keeps them in message order and refuses a message that claims twice.
- **The post isn't for sale:** it's appreciation. Add a short bullet ("Ben and Cy liked it") and no claim.
- **The seller's own "Sold", "SPF" or "pending"** closes the offer. The build prints `CLOSE? i (…) -> own <posts>`, or ends a seller's `REACT?` "Sold" line with "own posts …: the seller closing?". Mark the deal with `dealEdit` `{"status": "sold"}` (or `"pending"`) and `"statusAt": i`; `"status": null` reopens it. A claim after that still links to the post, and its bullet says "after it was sold". "Sold" from anyone else is a claim.
- **No candidate ("none within 3 days"), or two equally likely:** keep the build's guess, and list the message in the report as a possible claim. Never invent an offer.

## Moving a message
`move` `{"<i>": "<conv id>" | "new"}` puts a message an earlier build threaded into another conversation, together with everything threaded under it in its old one (its replies, and theirs). Use it when you spot an earlier misfile during a refresh (say so in the report), or when the user asks ("move #3232 into the bag-sale conversation").
- **The target:** an existing conversation's id; a new conversation listed in the same spec's `newconvs` (its title and tag go there); or `"new"`, which makes `mv<i>`, titled with the message's text.
- **Its link:** the moved message's own link must end up in the target, or be null. Add a `relink` for it in the same spec (`[post, "i"]`, or `null`); `catchup.py` refuses the move otherwise and says so.
- **The summary follows.** A conversation left with no messages is dropped: its bullets, key messages, open questions, answers and deals go to the target, and its tag and outcome too where the target has none. Otherwise only the items whose messages all moved go along (a question goes with the message that asks it); the rest stay and lose the refs that moved.
- `catchup.py` prints each `MOVE`, `DROP` and what moved or lost refs. Put it in the report.
- **During a refresh:** put `move` in the build spec. New messages can then join the target and link to the moved message.
- **With nothing new to build:** write `{"move": {...}, "relink": {...}}` (with `newconvs` if needed; nothing else), `list threading` and `list summary` (limit 1000) into a fresh RUN, run `python3 catchup.py relink WORK RUN spec.json`, and write what `RUN/out/manifest.json` lists, as in step 7. `catchup.py restore WORK` undoes it; if the write is refused, restore and bootstrap again. Bullets and claims for it wait for the next build. Tell the user what moved.
