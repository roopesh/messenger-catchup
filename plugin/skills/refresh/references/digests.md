# Per-day digests

Read this the first time you write digests in a session (step 6 of a refresh), when a build says digests are still due, and when the user asks for digests of past days (Backfill, below).

A digest is a few bullets on what happened on one finished day, each citing the messages it covers. The page's Ask Claude sends them for days older than its conversation lines reach (about three weeks back), in place of a bare "460 messages. Busiest: …" line, so questions about older things get real answers with message numbers. The page only reads them; nothing else shows them yet.

## Where they're stored
One document per month: `digests/m<YYYY-MM>` `{month, days:{"<YYYY-MM-DD>": {bullets:[{t, refs}], fromI, toI, n, at}}}` (`fromI`, `toI`, `n`: the day's first and last stored message and how many there were when it was written; `at`: when). A day is a message's date label `d`, as Messenger showed it in the chat's time zone (`meta/chat.tz`). A month at every cap is under 90 KB, well inside the 256 KiB a document holds; years of history are a few dozen documents. Only `catchup.py` writes them, through its manifest; never edit them by hand, and the page never writes them.

## During a refresh
1. Step 5 lists the collection into RUN with the others: `list digests` (limit 1000). An empty collection is fine.
2. Before writing the spec, run `python3 catchup.py days WORK RUN`. It prints a `DIGEST <day> #a-#b (n messages): <file>` line for each day due, and writes that day's messages, one per line, to `RUN/out/days/<day>.txt`. Due: finished days after the newest digest (when there's none yet, only the newest finished day: older days are the backfill's), and any day whose stored messages now reach past its digest's `toI` (written before the day had really finished, say when the browser's time zone differs from `meta/chat.tz`). Oldest first, 3 at most; the next refresh carries on. A day has finished when it's before today in `meta/chat.tz`, or a later day is stored.
3. Read each file and add the day to the spec's `digests`: `{"2026-11-12": [["Ana sold the stove to Ben", [6120, 6131]], ["Cy asked about permits; Dee answered", [6200, 6214]]]}`.
4. Build as usual (a refresh with nothing new skips step 6, so its days wait for the next one that builds). The digests go into the manifest's first batch: a month that exists is pinned (`pin:true`, with its version from step 5's listing), a new one isn't. The build's `build ok` line says how many it wrote, and which days are still due, if any.

## Writing the bullets
- 1 to 8 bullets a day; fewer on a quiet day. Each ≤15 words (and 240 bytes), citing 1 to 10 messages of that day (`refs`).
- What someone would want to find later: what was offered, sold, decided, asked and answered, plans, who did what. Skip greetings and chatter.
- The same naming and wording rules as the spec's bullets (SKILL.md › Writing the spec).

## What catchup.py checks
Each key is a real date with stored messages; the day has finished; it has no digest yet, or its messages now reach past the one it has; 1–8 bullets, each ≤15 words and ≤240 bytes; each bullet cites 1–10 message numbers, all stored messages of that day. A failed check stops the build before anything is written or WORK moves: fix the spec and build again. A refused write of a `digests` document: `list digests` into RUN again, `catchup.py restore WORK`, and build again; a day it then says already has a digest has landed: drop it from the spec.

## Backfill
Only when the user asks (for example after updating to a version with digests): digests for every past day, in batches a session can do one at a time. It's safe to stop between batches and resume later, in this session or another; nothing here changes threading or the summary.
1. Bootstrap WORK if this session has none (SKILL.md › Refresh steps). Don't start while `refresh/status` shows a run in progress.
2. `list digests` (limit 1000) into a fresh folder RUN, then `python3 catchup.py days WORK RUN --backfill`. It picks the finished days without a digest, newest first, up to 10 days and 2,000 messages, writes their files, and says how many days are left. Nothing to digest: the backfill is complete; tell the user.
3. Read each file and write the spec `{"digests": {...}}` (only that key), then `python3 catchup.py digests WORK RUN spec.json`. It checks the spec as a build would and first saves every month document as listed, and which days they held, in `RUN/out/backup/` (the backup). It never changes a day that already has a digest.
4. Write what `RUN/out/manifest.json` lists, one `batch` per entry, `pin:true` entries with their version from step 2's listing.
5. Check it: `list digests` into another fresh folder AFTER and run `python3 catchup.py check-digests WORK RUN AFTER`. "check ok" says how many days were written, how many were kept, and how many are left. Anything else (a day changed or missing since the backup, or not as written): stop, write nothing more, and tell the user; the backup in `RUN/out/backup/digests/` holds the month documents as they were.
6. Tell the user the batch's days in one line. To carry on, AFTER is the next batch's listing: run step 2's `days` on it and go on from there. A batch whose write was refused or never landed is simply found again by the next `days`.
