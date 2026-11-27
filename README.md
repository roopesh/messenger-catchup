# Messenger Catch-up (Claude plugin)

A Claude plugin that keeps a private **catch-up page** for your Facebook Messenger group chats and Facebook groups. Claude reads them in **your own Chrome** (Claude in Chrome) and stores everything in a claude.ai artifact that only you can open. Needs a paid Claude plan (Claude in Chrome requires one).

## What the page does
- **Several chats and groups on one page.** Setup creates the page for one chat. You add more chats (Settings ⚙ › Add a chat: a Messenger link and how many days back to read) and Facebook groups (Settings › Add a group) yourself. The title is a picker: **All chats** opens with a short summary across your chats, written at the end of each refresh, then a card per chat or group with what's new and what needs you; it also has an **Ask** across every chat and group whose answers say which chat or group each message or post is from, a **By day** with a section per chat, and **Stats** comparing the chats; picking one chat shows its own tabs. In Settings you can also set each chat's order, how often scheduled runs refresh it, and whether its replies post on their own.
- **For a chat:** **Summary** (Needs you, open questions, deals with claims and Sold/Pending, one card per conversation with its thread), **Ask Claude** (questions over the whole history, citing messages; hover or tap a citation to see who wrote it, when, how it starts and its reactions), **Messages** (the chat threaded: each reply nested under the message it answers, with a rail that folds a branch; photos and GIFs), **By day** (a summary of each day with "Copy for chat", plus what each refresh found), **Views** (pages you describe and Claude builds, which can keep themselves up to date) and **Stats**.
- **For a group:** **Summary** (what's new, and Needs you: your name in a comment, a reply to your comment, or a mention from your notifications) **Posts** (newest activity first, new posts and comments marked) and **Ask** (questions about the group: Claude reads its most active posts and searches every post and comment; each citation, like #p12/c3, opens that comment in Posts).
- **Reply from the page.** Each message has **Reply here** (with "@" to tag people and photos you attach) and **React**. Queued replies and reactions go out at the start of every refresh, or right away when you ask Claude to **"send replies"**. Claude posts only what you queued, and only if you turned on auto-posting or confirm it in chat.
- **Reactions count as answers.** A 👍 from you on a question to you answers it, a laugh never does: Ask and the summary read reactions by one meaning table (the plugin's `references/reactions.md`), and you can tell Claude when a reaction means something else in your chat. With the helper (4.0+), Claude also knows who reacted on the messages that ask or name you; without it, a reaction there reads as "probably yours".
- **Photos and GIFs are stored** on the page, packed by day so they fit its storage, and searchable by what they show.

## Install
This repo is a plugin marketplace. Add it once and the plugin updates with each release.
- **claude.ai or Claude Desktop:** Customize › Plugins › Add › Add marketplace › `roopesh/messenger-catchup`, then install **Messenger Catch-up**. Plugins added there follow your account, Claude Code included.
- **Claude Code:** `/plugin install messenger-catchup --marketplace roopesh/messenger-catchup` (or `/plugin marketplace add roopesh/messenger-catchup`, then `/plugin install messenger-catchup@rando-tools`). For updates without asking, turn on auto-update for the marketplace in `/plugin` › Marketplaces.
- **Without a marketplace:** download `messenger-catchup-plugin.zip` from the latest [GitHub release](https://github.com/roopesh/messenger-catchup/releases) (or build it with `./make-zip.sh`) and use Customize › Plugins › Add › Upload plugin. An uploaded copy doesn't update itself.

Code execution must be on (claude.ai: Settings › Capabilities › **Code execution and file creation**). Then open your group chat in Chrome and tell Claude: **"set up messenger catch-up"**. Claude creates your page, asks a few questions, loads a first stretch of history and sets up a refresh schedule.

**Moving from the uploaded skill (before v1.15.0):** install the plugin, then remove the old uploaded skill (Customize › Skills) so Claude doesn't see two copies. Your page and its data stay as they are.

## The four skills
You can ask in plain words; each also runs as a slash command.
| Skill | Ask | What it does |
|---|---|---|
| `setup` (`/messenger-catchup:setup`) | "set up messenger catch-up" | Checks the requirements, creates the page, asks a few questions, loads the first history, sets up the schedule. Also changes or stops the schedule, and schedules reply checks |
| `refresh` (`/messenger-catchup:refresh`) | "refresh my catch-up" (scheduled runs too) | Posts approved queued replies first, then reads every chat and group on the page, stores what's new, threads and summarizes it, and reports. A scheduled run stops after 15 minutes and skips chats that aren't due; one you ask for refreshes everything |
| `replies` (`/messenger-catchup:replies`) | "send replies" | Posts the approved replies and reactions you queued, then stops: no refresh, so it's quick and cheap |
| `reply-check` (`/messenger-catchup:reply-check`) | "check replies" | A cheap check: one read of the page's settings plus one per active chat, handing over to `replies` only when a reply waits. Say **"schedule reply checks"** to have it run by itself every hour (the shortest interval Claude's schedulers allow), as a recurring task tied to your computer; "stop reply checks" ends it. For a reply right away, say **"send replies"** |

## Requirements (read this)
- Refreshes drive a Facebook tab in your Chrome, so they only run while your **computer is on, awake and unlocked**.
- **Chrome** with the **Claude in Chrome** extension, signed in to the same Claude account.
- Keep the **Claude Desktop app** open on that computer, signed in to the same account (Claude in Chrome needs it when Claude runs from claude.ai, the phone, Cowork or a scheduled run).
- **Facebook signed in**, language set to **English**.
- Keep the Messenger tab Claude opens **open and in front** in its window.
- Missed runs are skipped; the next run catches up.

## Optional helper (recommended)
The helper (`helper.user.js`) is a userscript for Tampermonkey or Violentmonkey. It makes refreshes faster and cheaper, and makes "Reply in Messenger" links land on the exact message. Without it, Claude injects the same code on each run, except that GIFs are then kept as links rather than stored.

Install it from [https://github.com/roopesh/messenger-catchup/releases/latest/download/helper.user.js](https://github.com/roopesh/messenger-catchup/releases/latest/download/helper.user.js) (the extension opens its install page). Installed copies update themselves from this repo's latest release, and the page tells you when a Chrome's helper is behind, naming that Chrome.
- It runs on facebook.com's **messages**, **groups** and **notifications** pages with your session, so you're trusting this repo's releases. Only the owner can publish them, and `main` is branch-protected.
- On groups and notifications it only reads: it never clicks inside a post and never opens a notification. Reading the notifications page does clear Facebook's red badge.
- Since helper 4.0 it opens Messenger's "see who reacted" list on new messages that reply to you, name you or ask a question (at most 30 a refresh), reads it and closes it with Escape. It never clicks inside that list, where a click on your own row would remove your reaction. Since helper 4.1 each refresh also reads reactions again on messages already stored, back to your last Mark caught up (at most 400 messages and a minute), and on the open questions and messages to you from the last 3 days, so a 👍 you give a question after it was stored counts as your answer, and a mention you answer with your own 👍 leaves Needs you.
- Since helper 3.7 it asks Tampermonkey for permission to read Facebook's image servers (`fbcdn.net`, `fbsbx.com`), which it uses to store GIFs on the page. Without that permission GIFs stay links to Messenger.
- It posts a reply itself only if you ask Claude to turn on helper posting. Real "@" mentions and photo replies need helper posting; without it, a mention goes out as plain text and a photo reply waits in the queue.

## Layout
| Path | What it is |
|---|---|
| `.claude-plugin/marketplace.json` | Makes this repo a marketplace listing the plugin |
| `plugin/` | The plugin, exactly what users install |
| `plugin/.claude-plugin/plugin.json` | Plugin name and version (always the release version) |
| `plugin/skills/refresh/SKILL.md` | Instructions Claude follows on every run (the refresh) |
| `plugin/skills/refresh/references/` | Instructions Claude reads only when needed: several chats, groups, the first run, updating the page, the outbox and posting, photos, day summaries, reports, people, the database, scheduling, troubleshooting and more |
| `plugin/skills/refresh/assets/page.html` | The catch-up page template (settings come from the page's database) |
| `plugin/skills/refresh/assets/helper.user.js` | Optional userscript; also injectable |
| `plugin/skills/refresh/scripts/catchup.py` | Builds threading, summaries and day summaries, checks every rule, plans runs over several chats and checks the summary across them |
| `plugin/skills/setup/SKILL.md` | First-time setup: requirements, the page, the questions, the schedule; hands the first capture to refresh |
| `plugin/skills/replies/SKILL.md` | "Send replies": posts what you queued and stops |
| `plugin/skills/reply-check/SKILL.md` | "Check replies": the frequent check that hands a waiting reply to replies |
| `plugin/skills/setup/`, `plugin/skills/replies/` `assets/` and `references/` | Copies of shared files, generated by `npm run sync`; edit the refresh skill's files, never these |
| `tests/` | Python tests for `catchup.py` and the repo; Playwright tests for the helper (simulated Messenger and Facebook groups) and the page |
| `tools/` | `sync.py` (`npm run sync`), `release.sh` and `ci-green.sh`; dev only |
| `package.json` | Test tooling (Playwright, Prettier, Lexical for the simulated composer); not part of the plugin |

## Tests
```
npm ci             # once per clone or worktree
npm run setup      # once: Playwright's Chromium, the pre-push hook, .venv with the pinned Ruff
npm test
```
Three suites, about 2 minutes: Python tests for `catchup.py` and the repo; the helper on a simulated Messenger and Facebook group; and the page in Chromium with a stand-in claude.ai runtime, including the full capture → import → build → render pipeline. Details in [docs/STATUS.md](docs/STATUS.md).

## Development docs
Changes go through a PR with a version bump; see [CLAUDE.md](CLAUDE.md) and [CHANGELOG.md](CHANGELOG.md).
- [docs/STATUS.md](docs/STATUS.md): **start here**: current state, how to test, change and release
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the parts fit, full database reference
- [docs/BACKLOG.md](docs/BACKLOG.md): open bugs, risks, checks and features, by priority
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): history, phase by phase, and working in a git worktree
- [docs/DECISIONS.md](docs/DECISIONS.md): what was chosen, why, and what was rejected
- [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md): benchmarks, threading evaluations, test results
- [docs/LEARNINGS.md](docs/LEARNINGS.md): platform limits and gotchas

## Privacy
- Each user's data lives only in their own private claude.ai artifact.
- The plugin contains no personal data. Facebook is read-only except for the replies and reactions you queue, and those are posted only if you turn on auto-posting (for the page or a chat) or confirm each one in chat.

## Caveat
Facebook changes its pages often. If reading starts failing, the labels and markup the helper relies on may have changed; the helper's checks name what it couldn't find.
