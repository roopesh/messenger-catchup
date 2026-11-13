# Helper: browsers, versions, warnings and stalls

Read the part SKILL.md points you to: Which Chrome (more than one Chrome is connected), Versions (the installed helper is older than `assets/helper.user.js`), Warnings (`selfcheck` or a scan returned `warn`), Scan results (`err:"stalled"`, `top`, `scroller`), or Injecting (no helper installed).

## Which Chrome
- Claude in Chrome's `list_connected_browsers` lists every connected Chrome with its name, and marks the one this session uses (`inUse`). One browser, or one already in use: use it.
- Several and none in use: the Chrome tools ask the user to choose, and you must never pick one yourself. When you ask, recommend the Chrome whose Messenger tab has the newest helper (`data-mc-helper`; older helpers lack checks: `selfcheck` came in 1.8, full names in 1.6, warnings, More actions › Reply and `post` in 2.0). If the user asks you to pick the one with the newest helper, you may select each in turn (`select_browser`), read `data-mc-helper` on its Messenger tab, and keep the newest.
- During a scheduled run with no one to ask: don't choose. Set `refresh/status` `{state:"error",message:"several Chrome browsers connected: choose one"}`, keep the schedule, and say so in the report.
- Every report names the browser used and its helper version, for example "Chrome 'Work Mac', helper 2.0". The same name and version go into `meta/chat.versions.browsers` (`references/database.md` › Versions), with `"none"` when you injected the helper.

## Versions
An installed helper reports its version in `data-mc-helper` (and `ping`). When it's older than `@version` in `assets/helper.user.js` (compare number by number), keep using it, and in the report:
- **older than 1.5:** it was installed by pasting and can't update itself. Tell the user to open the install link (SKILL.md › Helper) once and press Install. It replaces the old copy and updates itself from then on.
- **1.5 or later:** it updates itself within a day. To get it now: the extension's menu › Check for updates, or open the install link again.
- The page shows it too, from `meta/chat.versions.browsers` (`references/database.md` › Versions): below 1.5 until a refresh in that Chrome finds it up to date, 1.5 or later only while that Chrome ran the last refresh; the user can dismiss either.
- What an older helper can't do: before 1.6, no full names (`fn`); before 1.7, no `people` scan; before 1.8, no `selfcheck` (skip that check and say so); before 2.0, no warnings, no `top`, no stall timeout, no More actions › Reply, and no `post`.

## Warnings
`warn` (from `selfcheck`, or a scan: `mc_result.warn`, or the `scan` command's result) never stops a run. Put each in the report in one line, with what it means:
- **`page language is "…"`**: Facebook isn't set to English. Reading goes on, but labels may not be recognized. If `selfcheck` also has `missing` items, tell the user the language is the likely cause (not "Messenger changed") and to switch Facebook to English.
- **`24-hour clock`**: times like 17:52 are read and stored as 12-hour times. Glance at a few new messages' times on the page.
- **`reply link(s) without an "X replied to Y" line`** or **`"Original message:" quote but no reply link`**: Messenger reworded a reply marker. Those replies get no Messenger link (`perr:"noreplyline"`, or nothing), and the build prints a CHECK for each (`CHECK reply with no readable reply line`): read them in context and set `links` by hand.
- **`photo link(s) with no Facebook image`**: those photos are missing from the capture.
- **`time labels go backwards`** or **`dated in the future`**: some dates were read wrong (for example a time-only label that isn't today). Name the messages in the report; check them in Messenger before relying on their dates.
- **`"X" shows as A and B`**: one full name may come from the wrong avatar. Don't use it to tell people apart until a later capture agrees.
- **`no full names`** or **`sender avatars (full names)`**: avatars can't be read, so new messages carry no `fn` (`references/people.md`).
- **`date labels (n of m unreadable)`**: with `DATES-GUESSED` in the capture, Messenger's date labels may have changed.

## Scan results
- **`err:"stalled"`**: nothing new loaded for 30 s (Messenger stopped loading older messages). Navigate the tab to `chatUrl` again, wait about 5 s, and start the scan (`full` with a new `run` id) once more. If it stalls again, stop with `refresh/status` `{state:"error",message:"Messenger stopped loading older messages"}`; the next run tries again.
- **`top:true`**: the scan reached the start of the chat. On a first run that means the chat is shorter than the count asked for, and `win` is all of it. A run with stops that reaches the top fails with "None of the stored anchor messages was found … (reached the top of the chat)" (`references/troubleshooting.md`).
- **`scroller`**: which element was scrolled. `message` (the nearest scrollable ancestor of a message that holds nearly all the messages) is normal. `first-div` (helper 1.9's rule: the first scrollable element in the chat log), `message-short` or `message-outside-log` mean Messenger's layout changed: mention it, and on a first run check that `win` is what you asked for.
- **`err:"top-spinner"`**: at the top of what loaded, Messenger's loading spinner stayed for 30 s and nothing older came. Handle it like `stalled` (reload, retry once), and if it happens again, say so in the report: Messenger may be failing to load that chat's history.
- **`verify.err:"stalled"`** or **`"top-spinner"`**: as for the scan: run the whole `full` once more.
- **`people`** stops early with `stalled` (and `spinner`) when nothing older loads for 30 s; treat it like `top:false` (`references/people.md`).

## Injecting (no helper installed)
Inject it on each step: Read `assets/helper.user.js` and pass its entire text to `javascript_tool` on the Messenger tab, followed by the bridge *start* call only (end the code with `'started'`; never wait inside the injecting call). The injected code is lost when the page reloads, so run the steps one at a time: inject + start `scan` (poll until done; require `err:null`), reload the tab (navigate to the chat URL), wait about 5 s, inject + start `verify` (poll), then start `capture{base}` in that same page (poll). Never paste only part of the file.
