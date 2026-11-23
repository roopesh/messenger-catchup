# Fuller day summaries (F29): design notes

Status: **built in v1.32.0** (Nov 22, 2026). Started Nov 15, 2026; decided on the owner's decision board on Nov 22 (option A). What shipped is under "What was built"; the rest is the history of the decision. The procedures Claude follows are in the refresh skill's `references/day-summaries.md`, the page and `catchup.py` in [ARCHITECTURE.md](../ARCHITECTURE.md).

## The problem
- The owner found the By day tab's digests weak. An Ask Claude question like "Give me a summary of yesterday" gave a far better answer than the By day card for the same day, and the two didn't match.
- **Why they differed:**
  - **A digest was capped:** 1–8 bullets of at most 15 words each. That's about 120 words for a day that can hold 1,200+ messages.
  - **It was designed as a compact index for Ask, not as reading.** For days older than its conversation lines reach (about 3 weeks), Ask's single prompt carried only each day's digest, so short digests let months fit. F24 then displayed those index cards as the By day tab.
  - **Ask answers with the whole day word for word** and one task, at any length. In the owner's example it gave about 1,000 words in roughly 40 bullets, grouped by topic, with a "Still open" section.
  - **The digest was written differently:** by a scheduled refresh at about 1 AM, as one step among scanning, importing and rebuilding.

## Options considered
1. **Two levels:** keep the short digest for Ask's long-history prompt, and store a fuller day summary, written by the refresh, for By day and for sharing. The owner's first direction (Nov 15).
2. **Write the day summary when the owner first opens the day,** with the page's Claude, as Ask does, and save it. Rejected: nothing exists until the day is opened, and a summary written once never updates as the day goes on.
3. **Raise the digest cap** (for example 20–25 bullets). Simple, but Ask's long-history questions would fit fewer days, and it's still one compressed list.

## The owner's decision (Nov 22, board option A)
- **One fuller summary per day instead of two levels.** Ask now searches the whole history itself (F32, v1.31.0), so it no longer needs the short digest as its index.
- **Kept current by each refresh,** incrementally, with **one rewrite after the day ends** so it reads as one piece.
- **Layout like the Ask answer the owner liked:** topic sections with bullets citing message numbers, then "Still open". **No length limit** for now.
- **Sharing: "Copy for chat" only.** No shared links ("I'm not opening up the artifact"). Today's summary in progress can be copied too.
- **Backfill later:** past days get fuller summaries only once the owner likes a few days.

## What was built (v1.32.0)
- **Storage:** one document per day, `daySummaries/d<YYYY-MM-DD>` `{day, fromI, toI, n, at, full, final, sections:[{h, bullets:[{t, refs}]}], open:[{t, refs}]}` (a month of fuller summaries could pass the 256 KiB document cap, so not one per month). Only `catchup.py` writes them, through the build's manifest, pinned when step 5's query (the newest 5 by day) holds the day.
- **Refreshes:** `catchup.py days WORK RUN` lists what's due, 3 days at most per refresh, oldest first:
  - `UPDATE`: the day in progress gained messages. Claude gets its summary so far (in the spec's form) and only the messages after its `toI`, and writes the whole updated summary.
  - `NEW`: the day in progress has no summary yet (all its messages so far).
  - `FINAL`: the day has ended (a later day is stored, or it's before today in `meta/chat.tz`, the digests' rule): one rewrite from all its messages, `full` through `fullToI`, and `final` when a later day was already stored. A final day is never written again. A day that ended by the clock alone (the browser's zone behind the chat's) gets the messages still dated with it as updates, then its final rewrite once a later day is stored.
  - The days after the newest summary are due (none yet: only the newest day, so the first refresh after the update starts today, or writes yesterday's final summary just after midnight); earlier days are the backfill's.
- **The spec** `daySummaries` is checked as strictly as digests were: a real day with stored messages, not final, needed, only `sections` and `open`, at least one section with a one-line heading and at least one bullet, each bullet one line citing at least one stored message of that day, the document within the build's byte cap. No word or bullet caps.
- **Digests retired:** refreshes no longer write `digests/*`, and a build refuses the `digests` key. The old documents stay; the page shows a day's digest only while it has no summary (By day and Ask's day lines).
- **The page (`PAGE_VERSION` 4.0):** it reads the whole collection, one document per day (windowed loading for very long histories is BACKLOG F33). By day shows each day's summary (headings, bullets with clickable citations, Still open), labelled "In progress · updated 9:04 AM", "Final · written …" or "Day ended", with the refresh runs (F27) collapsed under it; days without one show their digest. **Copy for chat** copies the day as plain text (the day as a title, "(so far)" in progress, headings, "• " bullets, Still open, no message numbers), says "Copied.", and where the viewer blocks the clipboard shows the text selected in a box to copy by hand.
- **Ask and Views:** a day line in the older history carries the day's summary (a short line no longer than its digest first, the full line, whole points within 4,096 bytes, while room is left), else its digest; the `day_summaries` tool gives each day's summary (up to one result's 16 KiB) and where to continue.
- **Backfill:** built, run only when the user asks: the whole collection listed a page at a time (marked with `.all`), `days --backfill` (finished days, newest first, 5 days and 2,000 messages a batch), `day-summaries` (backs up what it replaces), the run lock around each write, and `check-day-summaries`.

## Still to check (BACKLOG L1)
The first fuller summaries on the owner's page after a refresh, then the final rewrite after midnight; Copy for chat in the artifact viewer; the backfill once the owner likes a few days.
