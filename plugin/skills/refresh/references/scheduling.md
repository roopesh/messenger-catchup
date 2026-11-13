# Scheduling refreshes

Read this when the refresh skill's SKILL.md › Scheduled runs says to, and when setup sets up, changes or stops the schedule.

Scheduling tools have different names in each Claude app, and the names change. **Use only a tool you can see in your tool list now.** Never call a name from this file that you can't see, and pass only parameters the tool's own description gives.

## Tools (names seen as of November 2026)
- **One-time follow-up into this conversation** (the chain): `send_later` (`delay_minutes`; claude.ai, Cowork and Claude Desktop chats, Claude Code on the web), or `CronCreate` with `recurring:false` (the Claude Code CLI; it fires only while that session stays open: tell the user).
- **Recurring task tied to this computer:** `create_trigger` with a cron and `requires_local_device:true`. Keep it only if its result confirms the tie: "cloud only", "not bound", or nothing about the computer means it can't reach Chrome.
- **Listing and cancelling:** `list_triggers` and `update_trigger` (`enabled:false`); `CronList` and `CronDelete`.
- **Never for this:** `ScheduleWakeup` (it only resumes a `/loop`); anything that runs in a fresh cloud session, such as `create_trigger` without the device requirement; Claude in Chrome's own scheduled tasks (daily at most).

## Where it's stored
- `meta/chat.schedule` `{mode, every, hours, tz}`, the user's choice. `mode`: `"chain"` (one-time follow-ups, each run arming the next), `"recurring"` (a task that fires by itself) or `"manual"`; no `schedule` means `"manual"`. `every`: minutes between runs. `hours`: `{from, to}` as `"HH:MM"` in `tz`, `from` included, `to` excluded; a `to` before `from` wraps past midnight; up to 5 minutes early counts as inside; read older forms as best you can.
- **Older values** (before v1.21): `"B"` is a recurring task; `"A"`, `"loop"` or any other value is a chain or loop.
- `refresh/schedule` `{armId, nextAt, tool, lastRunAt, misses, problem, switchAskedAt}`, the live state. Get it before each write and pin the write (`set` it if it doesn't exist). `armId`: the token of the only follow-up or recurring task allowed to run: UTC time plus 4 random characters, such as `20261112T140512Z-k3f9`; null when none. `nextAt`: when the follow-up is due (ISO, UTC); null or missing means no chain is armed. `tool`: what armed it. `lastRunAt`: when a scheduled run last started (ISO, UTC). `misses`: chain runs in a row that couldn't reach Chrome (only reported). `problem`: the last scheduling failure, one sentence. `switchAskedAt`: when the user was asked to switch an older schedule.

## A scheduled run
A follow-up says `Scheduled catch-up run (chain <armId>): use the messenger-catchup:refresh skill.` A recurring task's prompt says `Scheduled catch-up run (recurring <armId>): use the messenger-catchup:refresh skill on the page <page url> (chat <chatUrl>, thread <thread>).` Do this before anything else, Before each run included. Never ask the user anything about the schedule during a scheduled run: that it runs shows it's alive.
1. Get `meta/chat` and `refresh/schedule`.
2. **Older message** (no token: it asks you to schedule the next run, or it's a task's stored prompt) while `mode` is an older value: do what the message says, the old way, and nothing from this file (no conversion, no question).
3. **Stale run:** the token isn't `refresh/schedule.armId`; a chain run while `mode` is `"recurring"` or `"manual"`; a recurring run while `mode` isn't `"recurring"`; or an older message while `mode` is `"chain"`, `"recurring"` or `"manual"`. Stop without refreshing, arming or writing anything, and say nothing.
4. **Outside the chosen hours:** don't refresh. Chain: Arm (it aims for the window's start). Recurring: stop.
5. Otherwise update `refresh/schedule` `{lastRunAt}` and do the refresh steps. However the run ends (done, nothing new, skipped because another run holds the lock, an error, Chrome unreachable), a chain run then Arms: that's what "reschedule" means in the refresh steps.

## Arm (only ever one chain)
1. Get `refresh/schedule` and keep its version. From a chain run: if `armId` isn't this run's token, another session has armed: stop. From setup or a refresh the user asked for: if `nextAt` is in the future, the chain is alive: stop, unless the user is changing the schedule.
2. Pick a one-time follow-up tool you can see, preferring the one in `tool`. None: write `problem` ("no scheduling tool in this app") and `nextAt:null`, and stop.
3. Delay: `every` minus 5 minutes (keeps the conversation's cache warm), whatever `misses` says: no waiting longer after runs that missed Chrome. If it would end outside the window: the start of the next window. If that's longer than the tool allows, arm for the longest it allows: that run lands outside the window and arms again.
4. Write `{armId, nextAt, tool, misses, problem:null}` with `if_version` from step 1, with a new `armId`. `misses`: from a chain run, its value plus 1 if this run couldn't reach Chrome, otherwise 0 (a run skipped for the lock counts as reaching it); from setup or a refresh the user asked for, 0. If the write is refused, get it again: if `armId` changed (and, from setup or a refresh the user asked for, `nextAt` is now in the future), another session armed first: stop. Otherwise something else wrote it: start again at step 1.
5. Call the tool with the follow-up message carrying the new `armId`. If the call fails, or waits on an approval nobody gives, write `problem` (what happened) and `nextAt:null`, and say it in this run's report.
6. Then, if `meta/chat.schedule.mode` isn't `"chain"`, set it (pinned; keep `every`, `hours` and `tz`, or 60 and `meta/chat.tz`); if refused, get it again and retry once. It never holds up step 5.

## After a refresh the user asked for
Skip this on a first run, and when the refresh was skipped because another run holds the lock. Get `refresh/schedule`, then:
- **Older schedule** (`mode` an older value) and no `switchAskedAt`, only when the user typed the request in this conversation (never for a stored prompt or follow-up): explain once that scheduling moved to a new scheme that can't run twice, and ask whether to switch. Write `switchAskedAt` either way. **On yes:** find the old follow-up, task or cron with a listing tool you can see and cancel it; without one, ask the user to delete it in the app (its Scheduled page, or the Claude Code session running it) and wait until they say it's gone. Only then Arm from this conversation (with no follow-up tool here, send them to a Claude app with scheduling). Without a yes, change nothing. Never offer a restart from `lastRefresh` while `mode` is an older value.
- **`problem` set:** say it in the report, then clear it.
- **`misses` above 0** (chain): say in one line that the last <misses> scheduled runs couldn't reach Chrome (computer asleep, Chrome closed or the tab hidden), then set it to 0.
- **Chain stopped:** `mode` `"chain"`, now inside the chosen hours, `nextAt` missing or over 30 minutes past, and no run going (`refresh/status` isn't `"running"` from the last 20 minutes, and `lastRunAt` isn't from the last 30). **Ask first:** "Scheduled refreshes stopped (the next run was due <time>). Restart them from this conversation? You'd need to keep it." **On yes:** Arm from this conversation and confirm the next run time. Without a yes, arm nothing, and offer "stop scheduled refreshes" (`messenger-catchup:setup`). With no follow-up tool here, don't ask: say it has stopped and that a Claude app with scheduling can restart it.
- **Recurring task quiet:** `mode` `"recurring"`, inside the window, and more than twice `every` plus an hour since the later of `lastRunAt` and the start of today's window (a sleeping computer can pause it). Check it with a listing tool and offer to turn it back on if it's disabled; otherwise ask the user to check the app's Scheduled page.
