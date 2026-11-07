# Names: one-time backfill and aliases

Read this when SKILL.md step 8 sends you here. Messenger shows a nickname or the first name; the full name comes from each sender's avatar (`fn` on messages captured by helper 1.6+, collected in `people/index`).

## One-time name scan (`people/index` has no `scannedAt`)
New messages carry full names from now on. This scan fills in senders from older history, once.
1. Run it after the refresh's report as its own short run: update `refresh/status` (pinned) to `{state:"running",startedAt,step:"names",by:"names scan"}`. If that write is refused, another run started: skip, and try on a later refresh.
2. The Messenger tab must be on `chatUrl` and visible (SKILL.md › Refresh steps, step 2). If the installed helper (`data-mc-helper`) is older than 1.7, it has no `people` command, and an injected copy won't run beside it: set the status back to done and try on a later refresh (it updates itself within a day). With no helper installed, inject `assets/helper.user.js` first.
3. Start `people{count}` with `count` = `meta/chat.lastI` + 1 and poll in calls of 25 s or less until it's done. It reads names only, never clicks, and stops by itself after 8 minutes. The result is `{seen, top, ms, people:[[shown, full, n]]}`.
4. `get` `people/index` (keep its version; it may not exist yet). For each `[shown, full]`, add `shown` to `people[full].shown`, creating `{shown:[shown]}` when it's missing; don't add `firstI`/`lastI`, the page fills those in. Set `scannedAt` (now, ISO) and `scanned:{seen, top}`, then write the document with `set`, pinned when it already existed. Set `scannedAt` even when `top` is false: later messages fill in the rest.
5. Update `refresh/status` (pinned) to `{state:"done",finishedAt}`. If anything failed, set `{state:"error",message}` instead and leave `scannedAt` unset, so a later refresh tries again.
6. Report in one line: how many people now have full names, and how many use a nickname.

## Aliases (`meta/chat.aliasesAskedAt` unset, and the user is in this conversation; never during a scheduled run)
Mentions are found by `meta/chat.ownerAliases`. Ask the user once which of these should also count as them: their full name, their last name, and anything else people in the chat call them. Show the current `ownerAliases`. Their own full name isn't in `people/index`, because Messenger shows the user as "You"; ask for it when it isn't known. Add what they choose to `ownerAliases` and set `aliasesAskedAt` in one pinned `meta/chat` update. If they want none, still set `aliasesAskedAt`.
