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
- "meta/chat.lastI (#x) is ahead of the newest saved message (#y)": update `meta/chat` (pinned) with `lastI: y`, `lastMid` = message #y's `m` (it's in chunk `c` + the 4-digit `floor(y/chunkSize)*chunkSize`), and `anchorMids` = the `m` of the three newest saved messages, then paste again.

## Tested
The skill's version is in `VERSION` (shipped with it). Every release passes the repo's test suites: the reader on a simulated Messenger thread (first run, incremental runs, messages arriving or deleted mid-run, photo replies, a chat shorter than the first-run count, older date labels, stale results, jump links, with and without the helper), the page's importer and rendering, and `catchup.py`. Version 1.1 was also tested against a real Messenger group in Chrome (first run without the helper, import, build, page). Facebook changes its page often; if the reader starts failing, the page's labels may have changed.
