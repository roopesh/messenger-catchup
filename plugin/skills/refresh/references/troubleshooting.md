# Troubleshooting

Read this when the page, the reader or catchup.py reports an error that SKILL.md's steps don't cover.

- "None of the stored anchor messages was found": the stored newest messages were deleted or the chat changed. Ask before re-running a first capture.
- verify-failed with `gap>0`: Messenger skipped content while loading; run again (the verify retries slowly once by itself).
- `vis:"hidden"`: the computer is asleep or the Messenger tab isn't the visible tab.
- The page says "data isn't loaded yet": wait a few seconds and paste again.
- Chunk or checksum errors: nothing was saved; capture again.
- `RUN already built into WORK`: run `python3 catchup.py restore WORK`, then build again.
- `RUN is missing #a-#b (stored, not built yet): fetch chunks/… into RUN too`: fetch the chunks it names into RUN and build again.
- bootstrap says "#a-#b are saved but not counted in meta/chat yet": an earlier import stopped before updating `meta/chat`. Carry on: this run's paste repairs it (the toast starts with REPAIRED), and the build then covers those messages too.
- `nothing left to build: WORK already covers RUN` (or `nothing to build`): another session already built these messages. Skip the build, and write only `meta/chat` `{lastRefresh}` and `refresh/status` by SKILL.md › Refresh steps, step 7's rule.
- `threading/current changed since WORK was bootstrapped` (or `summary/current`): another session built after this WORK was made. Bootstrap WORK again from a fresh fetch, then build.
- `WORK was made by an older catchup.py`: bootstrap WORK again.
- `RUN has no threading/current.json` or `RUN/… names b…, which is not in RUN`: step 5 (or a relink) must `list` the whole threading and summary collections into RUN, limit 1000, not `get` their `current` documents. Do that and build again.
- `… would be N bytes, over the 245760-byte limit`, `… names b…, which is not in the folder`, `threading/current is built through #a but summary/current through #b`, a WARN about block documents no current names, or a write refused or stopped partway at step 7: `references/writing-the-build.md`.
- "meta/chat.lastI (#x) is ahead of the newest saved message (#y)": update `meta/chat` (pinned) with `lastI: y`, `lastMid` = message #y's `m` (it's in chunk `c` + the 4-digit `floor(y/chunkSize)*chunkSize`), and `anchorMids` = the `m` of the three newest saved messages, then paste again.

- `selfcheck` says `ok:false` ("Messenger changed: …"): Facebook changed a part of Messenger's page the reader relies on, named in `missing`. Nothing was read or saved, so don't try to scan around it. Tell the user what changed, and that the skill needs an update (github.com/roopesh/messenger-catchup). Each run stops at this check until it passes again. `warn` alone (no full names, unreadable dates) doesn't stop the run: mention it in the report.

## Import toasts (SKILL.md › Refresh steps, step 4)
- A toast starting "REPAIRED: #a–#b (chunks …)" means an earlier import saved those messages but stopped before updating `meta/chat`; the page counted them in. Carry on, and in step 5 fetch every chunk it names as well.
- "Photos: upload failed … paste again": the messages are saved and the photos that landed are indexed. Paste again once (photos already stored are skipped). If it fails again, say so in the report and carry on.
- "Photos not stored: this view can't upload them": the page was opened somewhere it can't upload. Don't paste again; tell the user to open the page on claude.ai as its owner.
- "Another import is running in another open copy of this page": close any other page tabs you opened, wait 2 minutes, and paste again.

## Tested
The skill's version is in `VERSION` (shipped with it). Every release passes the repo's test suites: the reader on a simulated Messenger thread (first run, incremental runs, messages arriving or deleted mid-run, photo replies, a chat shorter than the first-run count, older date labels, stale results, jump links, with and without the helper), the page's importer and rendering, and `catchup.py`. Version 1.1 was also tested against a real Messenger group in Chrome (first run without the helper, import, build, page). Facebook changes its page often; if the reader starts failing, the page's labels may have changed.
