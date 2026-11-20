# Fuller day summaries (F29): design notes

Status: **to define with the owner, not ready to build.** Goes with F28 (rethink Views), since By day and Views should be designed together. Started Nov 15, 2026.

## The problem
- The owner finds the By day tab's digests weak. An Ask Claude question like "Give me a summary of yesterday" gives a far better answer than the By day card for the same day, and the two don't match.
- **Why they differ:**
  - **A digest is capped:** 1–8 bullets of at most 15 words each (`DIGEST_BULLETS`, `DIGEST_WORDS` in `catchup.py`). That's about 120 words for a day that can hold 1,200+ messages.
  - **It was designed as a compact index for Ask, not as reading.** For days older than its conversation lines reach (about 3 weeks), Ask's single prompt carries only each day's digest, so short digests let months fit. F24 then displayed those index cards as the By day tab.
  - **Ask answers with the whole day word for word** and one task, at any length. In the owner's example it gave about 1,000 words in roughly 40 bullets, grouped by topic, with a "Still open" section.
  - **The digest was written differently:** by a scheduled refresh at about 1 AM, as one step among scanning, importing and rebuilding, reading the same full messages. The older days were written by backfill batches of about 1,700 messages each.

## Options considered
1. **Two levels (chosen direction):**
   - Keep the short digest for Ask's long-history prompt.
   - Store a fuller day summary, written by the refresh, for By day and for sharing.
2. **Write the day summary when the owner first opens the day,** with the page's Claude, as Ask does, and save it.
   - Repeat visits cost nothing.
   - **Rejected,** because nothing exists until the day is opened (nothing ready to share), and a summary written once never updates as the day goes on.
3. **Raise the digest cap** (for example 20–25 bullets).
   - Simple.
   - But Ask's long-history questions would fit fewer days, and it's still one compressed list.

## The owner's direction (Nov 15)
- **Option 1.** The owner pointed out that an on-demand summary (option 2) wastes nothing on repeat visits only if it's saved, and that it isn't refreshed.
- **The fuller summary is refreshed at every refresh**, so it's current and ready to share with others if the owner chooses.

## Proposed shape (Claude's thoughts, for the design conversation)
- **Incremental during the day:** each refresh folds only its new messages into today's summary (new threads, updates to existing ones, answers to open questions), at about the cost of the summary work a refresh already does.
  - **Not** a rewrite from scratch every hour. That would re-read the whole day each run: over 1,000 messages by evening, about 24 times a day.
- **A final rewrite after the day ends:** once a later day is stored, one full rewrite of the finished day from all its messages, marked `final`, so it reads as one piece rather than an hour-by-hour patchwork.
  - The short digest Ask uses is written from it in the same step, so it's almost free.
- **Reuse the refresh's work:** the refresh already groups messages into conversations and writes bullets for the Summary tab. A day summary is mostly a different cut of that work (by day instead of since the marker).
- **Layout:** like the Ask answer the owner liked: topic sections with bullets citing message numbers, then "Still open".
- **Storage:** probably alongside the digests (`digests/m<YYYY-MM>`, or its own collection).
  - Mind the 256 KiB per-document cap: a month of fuller summaries at roughly 5–8 KB a day is 150–250 KB, so it may need one document per day or per week.
- **Quality:** every line keeps its message numbers on the page, so the owner can check a line before sharing. A recap the owner posted earlier was called out in the chat for errors.

## Sharing
Sharing publishes other people's messages, so it's the owner's decision each time.
- **"Copy for chat":** a button on each day that copies chat-ready text for the owner to paste into Messenger themselves, without message numbers (they only mean something on the page). The owner already posts Claude recaps into the group. Cheapest and safest.
- **A shared link:** a separate page showing just that day's summary.
  - Easy to pass around, but anyone with the link can read what people said in the group.
  - Only with the owner's explicit say-so each time, and never by sharing the whole catch-up page.

## Open questions for the owner
- Can today's in-progress summary be shared, or only finished days?
- Copy-to-paste, a shared link, or both?
- The same layout as the Ask answer (topics, then "Still open")? Any length limit?
- Should the By day card show the fuller summary by default, with the short digest only for Ask?
- Should days before the feature ships get fuller summaries too (a backfill, as F16 had), or only new days?
- How does this fit with Views (F28)? Is a day summary one kind of view, or does By day stay its own tab?
