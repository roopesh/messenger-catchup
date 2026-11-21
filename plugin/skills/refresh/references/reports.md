# Each refresh's report

Read this the first time a refresh in this session reaches step 5 (its query of the reports, then step 6's `report`), and when a `reports` write is refused or a build stops on `report`.

Every refresh that builds new messages ends with a short report in chat (step 8). Its bullets about the messages are also saved on the page, under the day of the messages they cite, and the By day tab shows them: the day in progress lists each refresh's bullets in order, and a finished day keeps its digest and adds a collapsed list of what each refresh found. The bullets are written once, in the build spec; step 8 repeats them in chat. They aren't a second summary.

## Where they're stored
One document per day: `reports/d<YYYY-MM-DD>` `{day, runs:[{at, fromI, toI, n, bullets:[{t, refs}]}], dropped?}` (shape in `references/database.md`). A run is one refresh's part of that day: `at` when it was built (ISO time), its first and last message of the day and how many there were, and the bullets citing them. The day is the messages' `d`, the same rule as digests (`references/digests.md` › Where they're stored), so a refresh that crosses midnight adds a run to both days. Only `catchup.py` writes them, through the build's manifest; never edit them by hand. The page only reads them.

## During a refresh
1. **Step 5:** `ArtifactData query` the `reports` collection with `query: {order_by: {field: "day", direction: "desc"}, limit: 5}` and `out_dir` RUN: the newest five days, with their versions in the result. If that leaves no `RUN/reports/` folder (the collection is empty), create an empty one. `catchup.py` needs the folder to know which days already have a document.
2. **Step 6:** put the report's bullets in the spec's `report`: `[["Ana offered her stove for $40; Ben claimed it", [6120, 6124]], ["Cy asked you about the permit", [6131]]]`. They're the report's content: the new conversations, deals, mentions of the user, open questions, and anything guessed, each citing this run's messages. Use `[]` when nothing stands out: the run is still saved, with its count. Leave out what's about the run rather than the messages (replies posted, helper or capture warnings, the schedule, versions); those go only in chat.
3. **Build** as usual. `catchup.py` checks the bullets, counts each day's messages, splits a run that crosses midnight (each bullet goes to the days it cites, with that day's numbers), and adds the day documents to the manifest's first batch, pinned (`pin:true`, with the version from step 5's query) when the query held that day. `build ok` says what it saved, as `report: 2026-11-21 #6118-#6140, 3 bullets` (`(new)` before a day's first run).
4. **Step 8:** report in chat as SKILL.md says, with these bullets as written.

A run with nothing new saves nothing (it doesn't build). The first build (`references/first-run.md`) has no `report`: setup reports it.

## Writing the bullets
- Up to 8 bullets; fewer on a quiet run. Each is one line of plain text, at most 25 words and 300 bytes, citing 1 to 10 of the messages this build adds (`refs`). An older message can be named in the text, not cited.
- The same naming and wording rules as the spec's bullets (SKILL.md › Writing the spec).

## What catchup.py checks
When `RUN/reports/` exists, a build needs `report` (except the first build). A list of at most 8 bullets; each a non-empty line of at most 25 words and 300 bytes with no line breaks or control characters, citing 1 to 10 message numbers, all among the messages this build adds. A `report` needs the `RUN/reports/` folder, and the query has to reach back to the run's first day: five reports all after it means a larger limit is needed (query again with `limit: 30`). A failed check stops the build before anything is written or WORK moves: fix the spec or RUN and build again.

## Limits
A run at every cap is about 3.5 KB. A day keeps its newest 40 runs within 128 KiB; older runs leave the document and `dropped` counts them (the page says so). A rebuild of the same messages (after a refused or partly applied write) replaces that run, so a run is never saved twice.

## A refused write
A `reports` document changed since step 5's query, or one exists that the query didn't return. Refreshes hold the run lock, so this is rare. Query the reports into RUN again, `catchup.py restore WORK`, and build again (`references/writing-the-build.md` › Refused writes).
