# Status and handoff

**Read this first** when picking the project up. Last updated Nov 6, 2026 (late evening, US Pacific), after the rename and test build-out (Phase 8).

## Where things stand
- **Shipped:** release **v1.1.1** (see `VERSION` and [CHANGELOG.md](../CHANGELOG.md)): page `PAGE_VERSION` 1.1, helper 1.1. Each release is a git tag plus a GitHub release with the skill ZIP attached.
- **Workflow:** every change goes branch → PR → version bump → squash-merge → tag → release. Nothing is committed to `main` directly. The steps are in [CLAUDE.md](../CLAUDE.md) and below.
- **In use:** the original user's page (v44) and hourly loop moved to the generic skill on Nov 6. Live refreshes 244 (injected helper v1.1) and 245 (old helper v2.2 still installed) both finished cleanly (DEVELOPMENT.md › Phase 6).
- **Renamed (Phase 8):** the build tool is now `scripts/catchup.py` (was `patool.py`), the helper functions are `mcScan` / `mcVerify` / `mcCapture`, and the page accepts only `mc-capture`. Same commands and behavior. **Re-upload the skill ZIP** so installed copies pick up `catchup.py`; until then the old ZIP keeps working with its own `patool.py`.
- **Tests:** `npm test` runs three suites, 165 checks (below). A mutation run confirmed they catch real breakage.
- **Repo:** private, `github.com/roopesh/messenger-catchup`, branch `main`.
- **Not done:** live test of an end-to-end encrypted chat, multi-chat, and the backlog.

## Test suites
| Suite | Command | What it covers | Now |
|---|---|---|---|
| Python | `npm run test:py` | `tests/test_catchup.py`: every default-link rule, every assert, and a check that a rejected build never advances WORK. `tests/test_tools.py`: helper copies in sync, the sync tool, helper version strings agree, no `pa*` names in shipped files, every file SKILL.md names exists, ZIP contents | 43 pass + 6 expected failures (known bugs B1–B5, B11) |
| Sim | `npm run test:sim` | `tests/sim.js`: the helper on a simulated Messenger (first run, incremental, mid-run arrivals, a message deleted mid-run, photo replies, short chat, date labels, stale results, jump links, injected vs installed) | 37 pass |
| Page | `npm run test:page` | `tests/page.test.js`: the page in Chromium with a stand-in claude.ai runtime. Every importer check, the full pipeline (sim captures → page import → `catchup.py` → render), summary cards, threaded view, markers, the date-entry fix, outbox, Ask Claude, Views | 79 pass + 3 KNOWN (B7, B8, B9) |

Known bugs are written as tests of the *fixed* behavior: Python marks them `expectedFailure` and the page test prints `KNOWN`. When one starts passing you'll see "unexpected success" or `FIXED?`. Remove the marker and close the backlog item.

## Where to start
1. **B2** (`catchup.py` has no WORK backup) and **R1** (unpinned page writes, no recovery for a half-finished import): the two places a refresh can get stuck and need hand repair.
2. **B6 + B8**: silent bad dates and the render crash. B8 already has a page test waiting to flip.
3. **B11 + B1–B5**: small `catchup.py` fixes, each with a test already written.
4. **G1–G3**: bring SKILL.md in line with what the page does.

## Doc map
| Doc | Use it for |
|---|---|
| [README.md](../README.md) | What it is, install, requirements |
| [CLAUDE.md](../CLAUDE.md) | The workflow rules (PR, versioning, release) |
| [CHANGELOG.md](../CHANGELOG.md) | What changed in each release |
| [SKILL.md](../SKILL.md) | The procedure Claude follows. **Changing it changes behavior.** |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the parts fit; full database reference; helper bridge; capture format; tests; legacy code |
| [BACKLOG.md](BACKLOG.md) | Everything open, by priority |
| [DECISIONS.md](DECISIONS.md) | What was chosen, why, and what was rejected |
| [DEVELOPMENT.md](DEVELOPMENT.md) | History, phase by phase |
| [EXPERIMENTS.md](EXPERIMENTS.md) | Measurements and test results |
| [LEARNINGS.md](LEARNINGS.md) | Platform limits and gotchas |

## Working on it

### Run the tests
From the repo root:
```sh
npm install        # once: Playwright (pinned in package.json)
npm run setup      # once: Playwright's Chromium
npm test           # Python suites, then sim, then page (about 3 minutes)
```
Exit code 0 means everything passed. The page suite reads `tests/out/sim_caps.json`, which the sim writes, so run `test:sim` before `test:page` when you run them separately. `tests/out/` is gitignored.

### Try `catchup.py` locally
```sh
python3 scripts/catchup.py bootstrap WORK DBDIR      # DBDIR: chunks/*.json, threading/current.json, summary/current.json, meta/chat.json
python3 scripts/catchup.py build WORK RUNDIR spec.json
```
`build` advances WORK in place. Copy WORK first if you want to rerun (BACKLOG B2). `tests/test_catchup.py` has an `Env` class that builds these folders, so it's the quickest way to try a spec.

### Change the helper
1. Edit `assets/helper.user.js`.
2. `npm run sync` regenerates the page's userscript copy and bookmarklet. `npm test` fails if you forget.
3. To release a new helper version, bump all four version strings (header `@version`, `window.__mcHelper`, `data-mc-helper`, `ping`; a test checks they agree), run `npm run sync`, and update the `1.1` checks in `tests/sim.js`.
4. `npm test`.

### Change the page
1. Edit `assets/page.html`; bump `PAGE_VERSION` when users' pages should be republished.
2. Claude republishes a user's page when `meta/chat.pageVersion` is older (SKILL.md setup step 2). The database survives a republish.
3. `npm test`. The page suite loads the real file.

### Every change: PR, version, merge, release
1. Branch from an up-to-date `main`.
2. Make the change. Bump `VERSION`, `package.json` (`npm install --package-lock-only` updates the lockfile) and add a `CHANGELOG.md` entry. MAJOR / MINOR / PATCH rules are in [CLAUDE.md](../CLAUDE.md). `npm test` fails if these disagree.
3. `npm test`, then `gh pr create`. Fill in the template's checklist (`.github/pull_request_template.md`).
4. `gh pr merge --squash --delete-branch`, then `git switch main && git pull`.
5. `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
6. `./make-zip.sh` (the repo folder must be named `messenger-catchup`; the ZIP is written to the parent folder, BACKLOG B10). The ZIP holds `SKILL.md`, `VERSION`, `assets/` and `scripts/`, which `test_tools.py` checks.
7. `gh release create vX.Y.Z ../messenger-catchup.zip --title vX.Y.Z --notes "<changelog entry>"`.
8. Users install or update from the release ZIP: Customize › Skills › + › Create skill › Upload a skill.

## Gotchas worth knowing before you touch anything
- The reader is tied to Messenger's English labels and markup. When a scan suddenly fails, check those first (LEARNINGS.md › Messenger DOM).
- Claude in Chrome tool calls die at about 45 s. Anything long is started and then polled in calls of 25 s or less.
- The capture step **replaces the Messenger tab's page** with the COPY CAPTURE button. Navigate back to the chat afterwards.
- Timestamps in status docs must come from the tool clock, not memory (LEARNINGS.md › Tooling).
- Pin every Claude-side database write with `if_version`.
