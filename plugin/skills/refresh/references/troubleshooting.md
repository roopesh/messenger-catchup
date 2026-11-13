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
- `nothing left to build: WORK already covers RUN` (or `nothing to build`): another session already built these messages. Skip the build, and write only `meta/chat` `{lastRefresh, versions}` and `refresh/status` by SKILL.md › Refresh steps, step 7's rule.
- `threading/current changed since WORK was bootstrapped` (or `summary/current`): another session built after this WORK was made. Bootstrap WORK again from a fresh fetch, then build.
- `WORK was made by an older catchup.py`: bootstrap WORK again.
- `threading/current has layout N, which this catchup.py doesn't know` (or `summary/current`): a newer copy of the skill wrote it. Write nothing more (release the lock: `refresh/status` `{state:"error",message}`), and tell the user, scheduled runs included, to update the plugin (`references/updating-the-page.md` › `pageVersion` is newer, its report line).
- `RUN has no threading/current.json` or `RUN/… names b…, which is not in RUN`: step 5 (or a relink) must `list` the whole threading and summary collections into RUN, limit 1000, not `get` their `current` documents. Do that and build again.
- `… would be N bytes, over the 245760-byte limit`, `… names b…, which is not in the folder`, `threading/current is built through #a but summary/current through #b`, a WARN about block documents no current names, or a write refused or stopped partway at step 7: `references/writing-the-build.md`.
- The user asks to put back summary items an earlier session dropped (conversations missing from before `summary.fromI`), or the database has a `backups` collection with a copy of the summary: `references/restoring-a-summary.md`. Only when the user asks, never in a scheduled run.
- "meta/chat.lastI (#x) is ahead of the newest saved message (#y)": update `meta/chat` (pinned) with `lastI: y`, `lastMid` = message #y's `m` (it's in the chunk with the highest `start` at or below y: chunks start where imports landed, not at multiples of `chunkSize`), and `anchorMids` = the `m` of the three newest saved messages, then paste again.

- `selfcheck` says `ok:false` ("Messenger changed: …"): Facebook changed a part of Messenger's page the reader relies on, named in `missing`. Nothing was read or saved, so don't try to scan around it. Tell the user what changed, and that the skill needs an update (github.com/roopesh/messenger-catchup). Each run stops at this check until it passes again. `warn` alone (no full names, unreadable dates) doesn't stop the run: mention it in the report.

## Import toasts (SKILL.md › Refresh steps, step 4)
- A toast starting "REPAIRED: #a–#b (chunks …)" means an earlier import saved those messages but stopped before updating `meta/chat`; the page counted them in. Carry on, and in step 5 fetch every chunk it names as well.
- Any toast about photos ("Storing photos n/N", "Photos: n of N stored …", storage full, too many uploads, sign-in expired, couldn't be stored): `references/photos.md` › Waiting. The messages are saved either way.
- "Photos not stored: this view can't upload them": the page was opened somewhere it can't upload. Don't paste again; tell the user to open the page on claude.ai as its owner.
- "Another import is running in another open copy of this page": close any other page tabs you opened, wait until the time it names (at most 2 minutes), and paste again.

## Tested
The release version is the plugin's, which this skill's folder doesn't carry; the versions it can read are `PAGE_VERSION` in `assets/page.html` and `@version` in `assets/helper.user.js`. Every release passes the repo's test suites: the reader on a simulated Messenger thread (first run, incremental runs, messages arriving or deleted mid-run, photo replies, a chat shorter than the first-run count, older date labels, stale results, jump links, with and without the helper), the page's importer and rendering, and `catchup.py`. Version 1.1 was also tested against a real Messenger group in Chrome (first run without the helper, import, build, page). Facebook changes its page often; if the reader starts failing, the page's labels may have changed.
