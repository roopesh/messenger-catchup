# Learnings and adjustments

Platform limits, gotchas, and what was changed because of them.

## claude.ai artifacts
- **No tab → page messaging:** a page opened from a Messenger tab can't receive messages from it. The clipboard plus a user-style paste is the bridge.
- **The page can't read the clipboard** (blocked by its frame), but a paste event (cmd+v) does reach it.
- **The page can't fetch Facebook images** (content security rules), so photos travel inside the paste.
- **The first paste after the page loads often doesn't land.** Click, wait 2 s, click again, then paste.
- **Clipboard race:** if the user copies something between Claude's copy and paste, the page refuses it as invalid. Copy and paste back to back.
- **Skill sharing:** the Share button works only within Team/Enterprise orgs. Elsewhere, upload the ZIP: Customize › Skills › + › Create skill › Upload a skill (needs code execution turned on).

## Claude in Chrome
- **Calls die at 45 s.** Start long work, then poll in separate calls of 25 s or less.
- **A hidden tab** (`visibilityState: hidden`) stalls scrolling. Mark the run as an error and retry next hour.
- **Tab IDs change.** Look them up fresh each run.

## Scheduling tools (checked on the web, Nov 12, 2026; R6)
- **No Anthropic doc names `send_later`, `create_trigger` or `requires_local_device`.** They appear only in user bug reports, and the names differ by app. Hence `references/scheduling.md`: the tools by what they do, used only when visible.
- **Claude Code** ([scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)): `CronCreate` (recurring or one-shot), `CronList`, `CronDelete`. Tasks fire only while the session is open and idle; one-shots delete themselves after firing and can fire up to 90 s early at :00 or :30; recurring ones expire after 7 days.
- **`ScheduleWakeup` only resumes a self-paced `/loop`.** Outside one it returns a wake time and never fires ([#82633](https://github.com/anthropics/claude-code/issues/82633)).
- **A device-bound task can silently run in the cloud only:** `create_trigger` with `requires_local_device:true` returned "not bound: no_signed_approval — this task will run in the cloud only" ([#92268](https://github.com/anthropics/claude-code/issues/92268)). Check the result text, never assume the tie.
- **A device-bound task is paused for good** (`device_absent`, no notice) the first time it fires while the computer sleeps ([#94415](https://github.com/anthropics/claude-code/issues/94415)).
- **One-shots aren't exactly once:** a fired `send_later` can keep a future `next_run_at` and fire again ([#86903](https://github.com/anthropics/claude-code/issues/86903)); a task's prompt has been delivered twice into one session ([#109016](https://github.com/anthropics/claude-code/issues/109016)); `send_later` can report success while nothing runs when the session's sign-in has expired ([#103724](https://github.com/anthropics/claude-code/issues/103724)). Hence the `armId`.
- **Unattended arms can stall:** for a few days `send_later` and `create_trigger` raised an approval card even in auto mode ([#107454](https://github.com/anthropics/claude-code/issues/107454)).
- **Cost:** a 60-minute `send_later` chain cost about $285 over 9.5 days, mostly prompt-cache rewrites, because wakes at 61–62 minutes always missed the cache ([#104736](https://github.com/anthropics/claude-code/issues/104736)). Hence arming at `every` minus 5 minutes.
- **Cowork scheduled tasks now run remotely** unless they need local apps ([help](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)). **Claude in Chrome from another surface** needs the Claude Desktop app open and connected ([help](https://support.claude.com/en/articles/12012173)).

## Messenger DOM
- Messages carry `data-message-id`, and the log is `[role="log"]`.
- **Names (checked live Nov 7):** the name line and the `At <time>, <name>: ` label show what Messenger displays: the member's nickname in that chat if one is set, otherwise the **first name only**. The **full name** is the alt text of the sender's avatar, a 28×28 image at the message's left edge, present on nearly every message. Reaction emoji (14–16 px) and "seen" faces are smaller. In about 150 messages, each displayed name mapped to exactly one full name. A nickname shows up as a label that isn't the start of the full name.
- **Reply links** are labeled "Go to replied message". Photo replies have no "Original message:" text, or their first quote line is Attachment/Photo/GIF/Video/Sticker.
- **Status labels** ("Sent", "Seen", "Delivered") leak into message text and are stripped.
- **Emoji at the start of a quote** broke matching; normalization strips them.
- **Date labels** change with age ("Yesterday", weekday, full date). The generic helper derives the weekday from the date and pulls the time out with a regex.
- **Fast scrolling skips messages.** Verify with a second pass and a gap detector.
- **Bringing a far-up photo reply's parent into view was slow** and could fail ("notfound"). The cause was stepping back down from wherever the last click left the view, plus a 2.5 s focus wait. Since helper 1.9: jump to the bottom between replies, and wait up to 10 s.
- **A late focus is not an answer:** a parent that loads after the wait can take focus during the next reply's click. Check that the focused message is from the person the reply names (B38).
- **English UI only.** The labels above are English.

## Userscript and injection
- **Injecting a nonce preload** to bypass page security was refused by the safety system. Dropped in favor of a userscript the user installs.
- **Bookmarklet:** `%` must be encoded as `%25` (`n%10` broke).
- **Jump scrolling:** scroll to the bottom first; otherwise the jump only searches upward.
- **Guard against double install:** `window.__mcHelper` or `data-mc-helper`.
- **The old and new helpers can run side by side** because their names differ (`cc-*` vs `mc-*`).

## Build tool (`catchup.py`)
- **Asserts catch mistakes before any write:** bullet and outcome length, every message in one conversation, backward links, a meta check first.
- **Conversation ID collisions** came up as topics recurred. Use date suffixes (e.g. `weather1106`).
- **Running `build` twice** fails the second assert harmlessly (a bare `AssertionError: []`). `build` advances WORK as soon as it succeeds and keeps no backup, so copy WORK yourself before a build you may need to redo, or re-run `bootstrap` from a fresh database fetch (BACKLOG B2).
- **`links` value `null`** means "no link" (start of a new topic).

## Tooling and process
- **Some actions were blocked by safety checks:**
  - adding auto-send to a scheduled task's stored prompt (handled in-session instead)
  - local folder access, at one point
  - repo creation through the CLI proxy
- **The session's git proxy is repo-scoped.** It can push to an attached repo but not create one, so the repo was created in the browser, then attached for push.
- **Status timestamps** were sometimes written wrong by hand. Take times from the tool clock, not memory.
- **Measure before shipping:** hand labels showed that clever linkers scored worse than the existing judgment, and saved a regression.

## Keeping copies in sync
- **The helper existed three times:** the file, an HTML-escaped copy inside the page (for "Copy userscript"), and its `jump()` as a URL-encoded bookmarklet. Edits had to be carried by hand until `tools/sync-helper.py` (C2). Since v1.8.0 the page links to the release instead of embedding the userscript (F8), so only the bookmarklet is generated.
- **A userscript pasted into Tampermonkey/Violentmonkey can't update itself:** it has no source URL. Installed from a URL with `@updateURL`/`@downloadURL`, the extension checks for a newer `@version` about once a day. Helpers installed before 1.5 need one manual reinstall from the link.
- **The page writes `meta/chat` too** (import counters, marker choice), not only Claude. Read it fresh before every write and pin the write.

## Page database (runtime contract 0.2.96)
- **No version-checked writes and no transactions:** page writes are last-writer-wins. The only coordination primitive is `doc.acquire({holder, ttlMs})`, a cooperative lease that other callers must also use to respect it.
- **Snapshots can lag or come from cache** (`metadata.fromCache`). Anything that decides *what to write* should `get()` fresh first; snapshots are for display.
- **`update` merges nested objects and replaces arrays**, so the page updating its own `meta/chat` fields doesn't clobber Claude's (and Claude's pinned writes notice the page's).
- **Size limits (contract 0.2.92, checked Nov 11):** a document holds at most 256 KiB of serialized JSON (262,144 bytes; over that the write fails with `invalid_argument`), and a database at most 25,000 documents. Claude's ArtifactData `batch` takes 1–50 writes, each document once, at most 1 MiB in all, and needs `if_version` on every write to an existing document. Anything that grows with the chat must be split across documents: `threading` and `summary` are block collections since v1.17.0 (B43), after the owner's single documents reached 185 KB and 249 KB.
- **Listen to the collection, merge what `current` names.** The page subscribes to the `threading` and `summary` collections, not to their `current` documents, and merges `current` with the blocks it names. A block written before its `current` is ignored until `current` names it, and an old block stays readable until it's deleted, so no snapshot shows a half-written build.

## Testing
- **The page can be tested without claude.ai:** give it a stand-in `window.claude.use()` before its script runs (`tests/page.test.js`). The page only needs `db.doc/collection` with `get`, `set`, `update`, `add` and `onSnapshot`, plus `assets.upload` and `sample`.
- **Every page write renders twice:** once locally, then again when the database snapshot comes back. Wait for the second render before grabbing elements, or the handle goes stale.
- **Bullets that repeat a call-out are hidden on purpose:** a summary bullet citing the message an open question, answer or deal already shows doesn't appear in the card.
- **`0` is a real message number:** checks like `if m.get('pi')` or `r[0]||r` treat #0 as missing (B7, B11). Compare with `None`/`null` instead.
- **Break things to test the tests:** a mutation pass found a missing test for verify's main guarantee (two passes must agree); see EXPERIMENTS.md §11.

## Open issues
All open issues now live in [BACKLOG.md](BACKLOG.md). The long-standing ones:
- Facebook changes Messenger's markup often; the reader depends on the labels above (R3, F4).
- End-to-end encrypted chats are untested (R5).
- Distant photo-reply parents are slow to reach (F2).
- One chat per page and loop; multi-chat is not built (F1).
