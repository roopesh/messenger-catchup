# Messenger Catch-up (Claude plugin)

A Claude plugin that keeps a private **catch-up page** for one Facebook Messenger group chat: conversations, threads, open questions, deals, mentions of you, and replies you can queue from your phone. Claude reads the chat in **your own Chrome** (Claude in Chrome) and stores it in a claude.ai artifact that only you can open. Needs a paid Claude plan (Claude in Chrome requires one).

## Install
This repo is a plugin marketplace. Add it once and the plugin updates with each release.
- **claude.ai or Claude Desktop:** Customize › Plugins › Add › Add marketplace › `roopesh/messenger-catchup`, then install **Messenger Catch-up**. Plugins added there follow your account, Claude Code included.
- **Claude Code:** `/plugin install messenger-catchup --marketplace roopesh/messenger-catchup` (or `/plugin marketplace add roopesh/messenger-catchup`, then `/plugin install messenger-catchup@roopesh`). For updates without asking, turn on auto-update for the marketplace in `/plugin` › Marketplaces.
- **Without a marketplace:** download `messenger-catchup-plugin.zip` from the latest [GitHub release](https://github.com/roopesh/messenger-catchup/releases) (or build it with `./make-zip.sh`) and use Customize › Plugins › Add › Upload plugin. An uploaded copy doesn't update itself.

Code execution must be on (claude.ai: Settings › Capabilities › **Code execution and file creation**). Then open your group chat in Chrome and tell Claude: **"set up messenger catch-up"**. Claude creates your page, asks a few questions, loads a first stretch of history and sets up a refresh schedule. Refreshes run as `/messenger-catchup:refresh`.

**Moving from the uploaded skill (before v1.15.0):** install the plugin, then remove the old uploaded skill (Customize › Skills) so Claude doesn't see two copies. Your page and its data stay as they are.

## Requirements (read this)
- Refreshes drive the Messenger tab in your Chrome, so they only run while your **computer is on, awake and unlocked**.
- **Chrome** with the **Claude in Chrome** extension, signed in to the same Claude account.
- **Facebook signed in**, language set to **English**.
- Keep the Messenger tab Claude opens **open and in front** in its window.
- Missed runs are skipped; the next run catches up.

## Optional helper (recommended)
The helper (`helper.user.js`) is a userscript for Tampermonkey or Violentmonkey. It makes refreshes faster and cheaper, and makes "Reply in Messenger" links land on the exact message. Without it, Claude injects the same code on each run.

Install it from [https://github.com/roopesh/messenger-catchup/releases/latest/download/helper.user.js](https://github.com/roopesh/messenger-catchup/releases/latest/download/helper.user.js) (the extension opens its install page). It updates itself from this repo's latest release. It runs on facebook.com/messages with your session, so you're trusting this repo's releases. Only the owner can publish them, and `main` is branch-protected.

## Layout
| Path | What it is |
|---|---|
| `.claude-plugin/marketplace.json` | Makes this repo a marketplace listing the plugin |
| `plugin/` | The plugin, exactly what users install |
| `plugin/.claude-plugin/plugin.json` | Plugin name and version (always the release version) |
| `plugin/skills/refresh/SKILL.md` | Instructions Claude follows on every run (the refresh) |
| `plugin/skills/refresh/references/` | Instructions Claude reads only when needed: setup, outbox, opening a message, people, database, troubleshooting |
| `plugin/skills/refresh/assets/page.html` | The catch-up page template (settings come from the page's database) |
| `plugin/skills/refresh/assets/helper.user.js` | Optional userscript; also injectable |
| `plugin/skills/refresh/scripts/catchup.py` | Builds threading and summary JSON and checks every rule |
| `tests/` | Python tests for `catchup.py` and the repo; Playwright tests for the helper (simulated Messenger) and the page |
| `tools/` | `sync-helper.py` (the page's bookmarklet, `npm run sync`) and `release.sh`; dev only |
| `package.json` | Test tooling (Playwright, Prettier); not part of the plugin |

## Tests
```
npm install        # once: Playwright
npm run setup      # once: Playwright's Chromium
npm test
```
Three suites, about 3 minutes: Python tests for `catchup.py` and the repo (helper copies in sync, the plugin manifests and ZIP, SKILL.md references); the helper on a simulated Messenger; and the page in Chromium with a stand-in claude.ai runtime, including the full capture → import → build → render pipeline. Known bugs from [docs/BACKLOG.md](docs/BACKLOG.md) are tests that are expected to fail until fixed. Details in [docs/STATUS.md](docs/STATUS.md).

## Development docs
Changes go through a PR with a version bump; see [CLAUDE.md](CLAUDE.md) and [CHANGELOG.md](CHANGELOG.md).
- [docs/STATUS.md](docs/STATUS.md): **start here**: current state, how to test, change and release
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the parts fit, full database reference
- [docs/BACKLOG.md](docs/BACKLOG.md): open bugs, risks, gaps and ideas, by priority
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): history, phase by phase
- [docs/DECISIONS.md](docs/DECISIONS.md): what was chosen, why, and what was rejected
- [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md): benchmarks, threading evaluations, test results
- [docs/LEARNINGS.md](docs/LEARNINGS.md): platform limits, gotchas, open issues

## Privacy
- Each user's data lives only in their own private claude.ai artifact.
- The plugin contains no personal data. Messenger is read-only except for the replies you queue, and those are posted only if you turn on auto-posting at setup or confirm each one in chat.

## Caveat
Facebook changes Messenger's page often. If the reader starts failing, the page labels it relies on may have changed.
