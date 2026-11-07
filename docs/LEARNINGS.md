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

## Messenger DOM
- Messages carry `data-message-id`, and the log is `[role="log"]`.
- **Reply links** are labeled "Go to replied message". Photo replies have no "Original message:" text, or their first quote line is Attachment/Photo/GIF/Video/Sticker.
- **Status labels** ("Sent", "Seen", "Delivered") leak into message text and are stripped.
- **Emoji at the start of a quote** broke matching; normalization strips them.
- **Date labels** change with age ("Yesterday", weekday, full date). The generic helper derives the weekday from the date and pulls the time out with a regex.
- **Fast scrolling skips messages.** Verify with a second pass and a gap detector.
- **Bringing a far-up photo reply's parent into view is slow** and can fail ("notfound"). Open the reply with its jump link and click from there.
- **English UI only.** The labels above are English.

## Userscript and injection
- **Injecting a nonce preload** to bypass page security was refused by the safety system. Dropped in favor of a userscript the user installs.
- **Bookmarklet:** `%` must be encoded as `%25` (`n%10` broke).
- **Jump scrolling:** scroll to the bottom first; otherwise the jump only searches upward.
- **Guard against double install:** `window.__mcHelper` or `data-mc-helper`.
- **The old and new helpers can run side by side** because their names differ (`pa-*` vs `mc-*`).

## Build tool (`patool.py`)
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
- **The helper exists three times:** the file, an HTML-escaped copy inside the page (for "Copy userscript"), and its `jump()` as a URL-encoded bookmarklet. An edit to one must be carried to the others by hand (BACKLOG C2; check in EXPERIMENTS.md §10).
- **The page writes `meta/chat` too** (import counters, marker choice), not only Claude. Read it fresh before every write and pin the write.

## Open issues
All open issues now live in [BACKLOG.md](BACKLOG.md). The long-standing ones:
- Facebook changes Messenger's markup often; the reader depends on the labels above (R3, F4).
- End-to-end encrypted chats are untested (R5).
- Distant photo-reply parents are slow to reach (F2).
- One chat per page and loop; multi-chat is not built (F1).
