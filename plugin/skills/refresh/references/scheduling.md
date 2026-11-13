# Scheduling refreshes

Read this before step 1 of a run that came from the schedule, after a refresh the user asked for unless `meta/chat.schedule.mode` is `"manual"` (the refresh skill's SKILL.md › Scheduled runs), and whenever the setup skill sets up, changes or stops the schedule.

Scheduling tools have different names in each Claude app, and the names change. **Use only a tool you can see in your tool list now.** Never call a name from this file that you can't see, and pass only parameters the tool's own description gives.

## Tools (names seen as of November 2026)
- **One-time follow-up into this conversation** (the chain): `send_later` (`delay_minutes`; claude.ai, Cowork and Claude Desktop chats, Claude Code on the web), or `CronCreate` with `recurring:false` (the Claude Code CLI; it fires only while that session stays open, so tell the user to keep it open).
- **Recurring task tied to this computer:** `create_trigger` with a cron and `requires_local_device:true`. Keep it only if its result confirms the tie: "cloud only", "not bound", or nothing about the computer means it can't reach Chrome.
- **Listing and cancelling:** `list_triggers` and `update_trigger` (`enabled:false`); `CronList` and `CronDelete`.
- **Never for this:** `ScheduleWakeup` (it only resumes a Claude Code `/loop`; outside one it names a time and never fires); `create_trigger` without the device requirement, or anything else that starts a fresh session in the cloud (it can't reach Chrome); Claude in Chrome's own scheduled tasks (daily at most).

## Where it's stored
- `meta/chat.schedule` `{mode, every, hours, tz}`, the user's choice. `mode`: `"chain"` (a one-time follow-up into one conversation, armed again by each run), `"recurring"` (a task that fires by itself; Claude never arms it) or `"manual"` (refreshes only when asked). `"A"`, `"loop"` or any other value comes from before v1.21: read it as a chain armed the old way, which the first Arm converts to `"chain"`. No `schedule` at all means `"manual"`. `every`: minutes between runs; `hours`: the daily window in `tz`.
- `refresh/schedule` `{armId, nextAt, tool, lastRunAt, misses, problem}`, the live state, in its own document so arming never collides with a build's pinned `meta/chat` writes. `armId`: the only follow-up allowed to continue the chain. `nextAt`: when it's due. `tool`: what armed it. `lastRunAt`: when a scheduled run last started. `misses`: chain runs in a row that couldn't reach Chrome (only reported). `problem`: the last scheduling failure in one sentence, or null.

## A scheduled run
A follow-up says `Scheduled catch-up run (chain <armId>): use the messenger-catchup:refresh skill.` A recurring task's prompt says `Scheduled catch-up run (recurring): use the messenger-catchup:refresh skill on the page <page url> (chat <chatUrl>, thread <thread>).` Never ask the user anything about the schedule during one: that it runs shows the schedule is alive.
1. Get `meta/chat` and `refresh/schedule`.
2. **Stale run:** a chain run whose `armId` isn't the one in `refresh/schedule`, or whose `schedule.mode` isn't `"chain"` (or an older value), or a recurring run whose `mode` isn't `"recurring"`: the schedule was stopped or changed, or another run already armed the next one. Stop without refreshing, arming or writing anything, and say nothing. An older message with no id (it asks you to schedule the next run) belongs to the chain only while `armId` is unset.
3. **Outside the chosen hours:** don't refresh. Chain: Arm for the start of the next window. Recurring: stop.
4. Otherwise update `refresh/schedule` `{lastRunAt}` and do the refresh steps. However the run ends (done, nothing new, skipped because another run holds the lock, an error, Chrome unreachable), a chain run then Arms: that's what "reschedule" means in the refresh steps. `misses` becomes its value plus 1 if this run couldn't reach Chrome (computer asleep, tab hidden or gone), otherwise 0.

## Arm (only ever one chain)
1. Get `refresh/schedule` again and keep its version. From a chain run: if `armId` is no longer this run's, another session has armed: stop. Otherwise (setup, or a refresh the user asked for): if `nextAt` is in the future, the chain is alive: stop, unless the user is changing the schedule.
2. Pick a one-time follow-up tool you can see, preferring the one in `tool`. None: update `refresh/schedule.problem` ("no scheduling tool in this app") and stop.
3. Delay: `every` minus 5 minutes, so the next run starts while this conversation's cached context is still warm. Keep it whatever `misses` says: no waiting longer after runs that missed Chrome. If the delay would end outside the window: the start of the next window.
4. Write `refresh/schedule` `{armId, nextAt, tool, misses, problem:null}` with `if_version` from step 1 (`set` when it doesn't exist yet). The new `armId` is the current UTC time, such as `20261112T140512Z`. If the write is refused, another session armed first: stop. If `schedule.mode` is an older value, then also set it to `"chain"` (get `meta/chat` for its version; write the whole `schedule`, keeping `every`, `hours` and `tz`, or 60 and the user's `tz` if missing).
5. Call the tool with the follow-up message carrying the new `armId`. If the call fails, or waits on an approval nobody gives, update `refresh/schedule.problem` with what happened. `nextAt` then passes with nothing due, and the next refresh the user asks for offers to restart it.

## After a refresh the user asked for
Get `refresh/schedule`, then:
- **`problem` set:** say it in the report, then clear it.
- **`misses` above 0** (chain): say in one line that the last <misses> scheduled runs couldn't reach Chrome (computer asleep, Chrome closed, or the Messenger tab hidden or gone).
- **Chain stopped:** now inside the chosen hours, and `mode` `"chain"` with `nextAt` over 30 minutes past, or an older `mode` with no `refresh/schedule` and `lastRefresh` (from before this run) older than twice `every`. **Ask first:** "Scheduled refreshes have stopped (the next run was due <time>). Restart them from this conversation? You'd need to keep it." On yes, Arm from this conversation and confirm the next run time; a late follow-up from the old chain then finds its id stale and stops. Without a yes, arm nothing, and offer "stop scheduled refreshes" (`messenger-catchup:setup`) so the question doesn't come back. With no follow-up tool here, don't ask: say the schedule has stopped and that a Claude app with scheduling can restart it ("change my catch-up schedule").
- **Recurring task quiet:** `mode` `"recurring"`, inside the window, and `lastRunAt` older than twice `every` plus an hour. A task tied to a computer can be paused after a run that found the computer asleep. With a listing tool, check it, and if it's disabled offer to turn it back on; otherwise ask the user to check it on the app's Scheduled page.
