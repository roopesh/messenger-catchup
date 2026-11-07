# Status and handoff

**Read this first** when picking the project up. Last updated Nov 7, 2026 (early morning, US Pacific), after the overnight defect run (DEVELOPMENT.md › Phase 9).

## Where things stand
- **Shipped:** release **v1.7.1** (see `VERSION` and [CHANGELOG.md](../CHANGELOG.md)): page `PAGE_VERSION` 1.7, helper 1.4. Every release is a git tag plus a GitHub release with the skill ZIP attached.
- **Defects:** none open. All 37 bugs found so far are fixed, plus the doc gaps (G1–G5) and P1 risks (R1, R8, mostly):
  - B1–B11 came from the handoff review
  - B12–B37 came from three independent reviews run overnight; each round's fixes were checked by the next
  - every fix has a test that fails on the code before it
- **Workflow:** every change goes branch → PR → version bump → CI → squash-merge → `tools/release.sh`. Nothing is committed to `main` directly. The steps are in [CLAUDE.md](../CLAUDE.md) and below.
- **Enforcement:** GitHub branch protection on `main` (since Nov 7): changes only through a PR, `test` and `version-bump` must pass, the branch must be up to date, linear history, no force-push or deletion, admins included. CI also flags any commit on `main` that didn't come from a merged PR, and a local `pre-push` hook blocks direct pushes before they reach GitHub.
- **In use:** the original user's page and hourly loop run the generic skill. **Re-upload the skill ZIP from the latest release.** On the next refresh, Claude republishes the page to `PAGE_VERSION` 1.7 by itself and reports that the userscript has an update (1.4).
- **Repo:** public (since Nov 7), `github.com/roopesh/messenger-catchup`, branch `main`. **Never commit real names or text from a user's chat**: tests use the mock cast (Ana, Ben, Cy, Dee, You).

## Test suites
`npm test` runs all three (about 3 minutes); CI runs the same on every PR.

| Suite | Command | What it covers | Now |
|---|---|---|---|
| Python | `npm run test:py` | `tests/test_catchup.py`: every link rule and assert, restore, bootstrap edge cases (unbuilt messages, chunks ahead of `meta/chat`), review regressions. `tests/test_tools.py`: helper copies in sync, version strings, `PAGE_VERSION` bumped when the page changed since the last tag, SKILL.md documents every db path, `meta/chat` field and outbox state the page uses, ZIP contents, release script, pre-push hook. ResourceWarnings are errors. | 97 pass |
| Sim | `npm run test:sim` | `tests/sim.js`: the helper on a simulated Messenger (first run, incremental, mid-run arrivals and deletions, photo replies, short chat, 20 pinned-date label cases including New Year, follow-on messages that look like status lines, deleted/unsent messages, jump links, injected vs installed) | 46 pass |
| Page | `npm run test:page` | `tests/page.test.js`: the page in Chromium with a stand-in claude.ai runtime. Every importer check, leases, fresh reads, repairs (including across chunks), photo slots and retries, the full pipeline (sim captures → import → `catchup.py` → render), markers, date entry, outbox states and Dismiss, safe links, Ask, Views | 112 pass |

When a bug is found, write its test as the *fixed* behavior first. Python can mark it `expectedFailure`, and the page test has `known()`, which prints `KNOWN` without failing the run. Remove the marker in the PR that fixes it.

## Where to start
1. **Run one live refresh on the real chat with v1.7.x.** The mock can't prove these, and they're the main remaining risk:
   - Messenger's real labels still parse: no `DATES-GUESSED`, senders right on follow-on messages
   - outbox name matching works (R9)
   - the page republishes cleanly
2. **R2:** measure a large capture (many photos) to see whether the clipboard and paste hold up.
3. **F4:** a helper self-check that names exactly which Messenger selector or label vanished, to catch markup changes early.

## Doc map
| Doc | Use it for |
|---|---|
| [README.md](../README.md) | What it is, install, requirements |
| [CLAUDE.md](../CLAUDE.md) | The workflow rules (PR, versioning, release) |
| [CHANGELOG.md](../CHANGELOG.md) | What changed in each release |
| [SKILL.md](../SKILL.md) | The procedure Claude follows. **Changing it changes behavior.** |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the parts fit; full database reference; helper bridge; capture format; tests; range summaries |
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
npm run setup      # once: Playwright's Chromium + the pre-push hook
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
4. `gh pr checks --watch` until CI (`test`, `version-bump`) is green, then `gh pr merge --squash --delete-branch` and `git switch main && git pull`.
5. `tools/release.sh`: tags `vX.Y.Z` on the merge commit, builds the ZIP from the tag (`SKILL.md`, `VERSION`, `assets/`, `scripts/`), checks its `VERSION`, and publishes the GitHub release with the changelog entry.
6. Users install or update from the release ZIP: Customize › Skills › + › Create skill › Upload a skill.

## Gotchas worth knowing before you touch anything
- The reader is tied to Messenger's English labels and markup. When a scan suddenly fails, check those first (LEARNINGS.md › Messenger DOM).
- Claude in Chrome tool calls die at about 45 s. Anything long is started and then polled in calls of 25 s or less.
- The capture step **replaces the Messenger tab's page** with the COPY CAPTURE button. Navigate back to the chat afterwards.
- Timestamps in status docs must come from the tool clock, not memory (LEARNINGS.md › Tooling).
- Pin every Claude-side database write with `if_version`.
