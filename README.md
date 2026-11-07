# Messenger Catch-up (Claude skill)

A Claude skill that keeps a private **catch-up page** for one Facebook Messenger group chat: conversations, threads, open questions, deals, mentions of you, and replies you can queue from your phone. Claude reads the chat in **your own Chrome** (Claude in Chrome) and stores it in a claude.ai artifact that only you can open.

## Install
1. In Claude: Settings › Capabilities › turn on **Code execution and file creation**.
2. Build the ZIP (`./make-zip.sh`) or download a release, then **Customize › Skills › + › Create skill › Upload a skill** and switch it on.
3. Open your group chat in Chrome and tell Claude: **"set up messenger catch-up"**. Claude creates your page, asks a few questions, loads a first stretch of history and sets up a refresh schedule.

## Requirements (read this)
- Refreshes drive the Messenger tab in your Chrome, so they only run while your **computer is on, awake and unlocked**.
- **Chrome** with the **Claude in Chrome** extension, signed in to the same Claude account.
- **Facebook signed in**, language set to **English**.
- Keep the Messenger tab Claude opens **open and in front** in its window.
- Missed runs are skipped; the next run catches up.

## Optional helper (recommended)
`assets/helper.user.js` is a userscript for Tampermonkey or Violentmonkey. It makes refreshes faster and cheaper, and makes "Reply in Messenger" links land on the exact message. Without it, Claude injects the same code on each run.

## Layout
| Path | What it is |
|---|---|
| `SKILL.md` | Instructions Claude follows (setup, refresh, outbox, scheduling) |
| `assets/page.html` | The catch-up page template (settings come from the page's database) |
| `assets/helper.user.js` | Optional userscript; also injectable |
| `scripts/patool.py` | Builds threading and summary JSON and checks every rule |
| `tests/` | Simulated Messenger thread + Playwright tests for the reader (`run.js` serves the mock and runs `sim.js`) |
| `package.json` | Test tooling only (Playwright); not part of the skill ZIP |

## Tests
```
npm install        # once: Playwright
npm run setup      # once: Playwright's Chromium
npm test
```
35 checks: first run, incremental runs, messages arriving mid-run, photo replies, a chat shorter than the first-run count, older date labels, stale results, jump links, with and without the helper. `tests/run.js` serves the simulated Messenger on a free local port, so nothing else needs to be running.

## Development docs
- [docs/STATUS.md](docs/STATUS.md): **start here**: current state, how to test, change and release
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the parts fit, full database reference
- [docs/BACKLOG.md](docs/BACKLOG.md): open bugs, risks, gaps and ideas, by priority
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): history, phase by phase
- [docs/DECISIONS.md](docs/DECISIONS.md): what was chosen, why, and what was rejected
- [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md): benchmarks, threading evaluations, test results
- [docs/LEARNINGS.md](docs/LEARNINGS.md): platform limits, gotchas, open issues

## Privacy
- Each user's data lives only in their own private claude.ai artifact.
- The skill contains no personal data. Messenger is read-only except for the replies you queue, and those are posted only if you turn on auto-posting at setup or confirm each one in chat.

## Caveat
Facebook changes Messenger's page often. If the reader starts failing, the page labels it relies on may have changed.
