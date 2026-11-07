# Status and handoff

**Read this first** when picking the project up. Last updated Nov 6, 2026 (evening, US Pacific), at commit `c3186da`.

## Where things stand
- **Shipped:** generic skill `messenger-catchup` v1.1: page `PAGE_VERSION` 1.1, helper 1.1. Shared as a ZIP upload (`make-zip.sh`).
- **In use:** the original user's page (v44) and hourly loop moved to the generic skill on Nov 6. Live refreshes 244 (injected helper v1.1) and 245 (old helper v2.2 still installed) both finished cleanly (DEVELOPMENT.md › Phase 6).
- **Repo:** private, `github.com/roopesh/messenger-catchup`, branch `main`.
- **Not done:** live test of an end-to-end encrypted chat, multi-chat, and the backlog.

## What was checked on Nov 6 (handoff review)
| Check | Result |
|---|---|
| Read all code against all docs | Gaps and bugs filed in [BACKLOG.md](BACKLOG.md) |
| `tests/sim.js` (simulated Messenger, headless Chromium) | **35/35 pass** |
| Helper copies: `helper.user.js` vs the page's userscript textarea and bookmarklet | Identical |
| `cctool.py` replay on synthetic data | Builds; confirmed B1, B2, B3, B4, B5 |
| Capture date parser probe | Confirmed B6 |

Details: [EXPERIMENTS.md §10](EXPERIMENTS.md#10-handoff-review-nov-6-evening).

## Where to start
1. **B2** (`cctool` has no WORK backup) and **R1** (unpinned page writes, no recovery for a half-finished import): these are the two places a refresh can get stuck and need hand repair.
2. **T1–T3**: put the tests on a footing where a change can be checked in one command, before larger edits.
3. **B6 + B8**: silent bad dates and the render crash.
4. **G1–G3**: bring SKILL.md in line with what the page does.

## Doc map
| Doc | Use it for |
|---|---|
| [README.md](../README.md) | What it is, install, requirements |
| [SKILL.md](../SKILL.md) | The procedure Claude follows. **Changing it changes behavior.** |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the parts fit; full database reference; helper bridge; capture format; legacy code |
| [BACKLOG.md](BACKLOG.md) | Everything open, by priority |
| [DECISIONS.md](DECISIONS.md) | What was chosen, why, and what was rejected |
| [DEVELOPMENT.md](DEVELOPMENT.md) | History, phase by phase |
| [EXPERIMENTS.md](EXPERIMENTS.md) | Measurements and test results |
| [LEARNINGS.md](LEARNINGS.md) | Platform limits and gotchas |

## Working on it

### Run the simulated-Messenger tests
The repo has no `package.json` yet (BACKLOG T1). Install Playwright anywhere outside the repo and point `NODE_PATH` at it:
```sh
mkdir -p ~/pw && cd ~/pw && npm init -y && npm i playwright@1 && npx playwright install chromium
cd <repo>/tests
python3 -m http.server 8765 &        # serves mock/messenger.html
NODE_PATH=~/pw/node_modules node sim.js
kill %1
```
Expect 35 `PASS` lines and exit code 0. Captures are written to `tests/out/` (gitignored). `sim_caps.json` is a handy input for `cctool` or page-import experiments.

### Try `cctool` locally
```sh
python3 scripts/cctool.py bootstrap WORK DBDIR      # DBDIR: chunks/*.json, threading/current.json, summary/current.json, meta/chat.json
python3 scripts/cctool.py build WORK RUNDIR spec.json
```
`build` advances WORK in place. Copy WORK first if you want to rerun (BACKLOG B2).

### Change the helper
1. Edit `assets/helper.user.js`.
2. Regenerate the page's copies: the HTML-escaped userscript in `#jump-us` and, if `jump()` changed, the URL-encoded bookmarklet in `#jump-bm` (encode `%` as `%25`, `^` as `%5E`, `#` as `%23`). There's no script for this yet (BACKLOG C2). The comparison used on Nov 6 is in EXPERIMENTS.md §10.
3. Bump the version in all four places in the helper (header `@version`, `window.__mcHelper`, `data-mc-helper`, `ping`) and in the copy. `tests/sim.js` checks `1.1` in two places, so update it too.
4. Run the sim tests.

### Change the page
1. Edit `assets/page.html`; bump `PAGE_VERSION` when users' pages should be republished.
2. Claude republishes a user's page when `meta/chat.pageVersion` is older (SKILL.md setup step 2). The database survives a republish.

### Release
1. Run the sim tests.
2. Update SKILL.md › Tested and the version map in DEVELOPMENT.md.
3. `./make-zip.sh` (the repo folder must be named `messenger-catchup`; the ZIP is written to the parent folder, BACKLOG B10).
4. Upload: Customize › Skills › + › Create skill › Upload a skill.

## Gotchas worth knowing before you touch anything
- The reader is tied to Messenger's English labels and markup. When a scan suddenly fails, check those first (LEARNINGS.md › Messenger DOM).
- Claude in Chrome tool calls die at about 45 s. Anything long is started and then polled in calls of 25 s or less.
- The capture step **replaces the Messenger tab's page** with the COPY CAPTURE button. Navigate back to the chat afterwards.
- Timestamps in status docs must come from the tool clock, not memory (LEARNINGS.md › Tooling).
- Pin every Claude-side database write with `if_version`.
