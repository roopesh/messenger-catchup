# Status and handoff

**Read this first** when picking the project up. Last updated Nov 11, 2026 (US Pacific), after v1.17.0: threading and summary are stored as block documents, so they never hit the database's 256 KiB per-document cap (BACKLOG B43). Before that, Phase 10 (DEVELOPMENT.md): the repo went public, cleanup, names, self-check, relink, faster photo replies, and it became a plugin (v1.15.0) with separate setup and refresh skills (v1.16.0).

## Where things stand
- **Shipped:** release **v1.17.2** (see `VERSION` and [CHANGELOG.md](../CHANGELOG.md)): page `PAGE_VERSION` 2.3, helper 1.9. **It's a plugin** (`messenger-catchup`, skills `setup` and `refresh`), installed from this repo as a marketplace (`rando-tools`); installs update when the plugin's version changes. Every release is a git tag plus a GitHub release with the plugin ZIP and `helper.user.js` attached. Installed helpers (1.5+) update themselves from the latest release.
- **Defects:** four open: B39 (queuing a reply closes the conversation and jumps the page), B40 (a conversation that starts with a reply doesn't show the message it replies to), B41 (full names missing on a live page, so two people with the same first name look alike) and B42 (a text and the photo sent right after it show as two rows, not one block like Messenger). B43 (threading and summary outgrowing the 256 KiB document cap, P1) is fixed in v1.17.0. The 38 bugs before B39 are fixed:
  - B1–B11 came from the handoff review
  - B12–B37 came from three independent reviews run overnight; each round's fixes were checked by the next
  - B38, a silent wrong photo-reply link, was exposed by the F2 test
  - every fix has a test that fails on the code before it
- **Restoring the dropped summary (v1.17.2, F10):** `catchup.py restore-summary` and the refresh skill's `references/restoring-a-summary.md` put back what pre-1.17 sessions dropped, from the copy saved in the page's `backups` collection: a dry run the user confirms, the backup's open questions checked against later messages first, then a pinned write like a build's. Not yet run on the owner's page (it waits for their go-ahead); the backup stays until they decide.
- **Storage (v1.17.0, B43):** `threading` and `summary` are collections of 1,000-message block documents named by their `current` document; the page merges them back. Measured on synthetic chats calibrated to the owner's page: the largest document stays at most 85 KB up to 50,000 messages (EXPERIMENTS.md §13). Old pages convert on their next refresh; nothing is dropped, and `summary.fromI` is kept.
- **Open:** live-only risks (R2, R3, R5, R6, R9), doc gap G6, features F1, F5, F6. F7 is done; its one open question (whether marketplace installs update by themselves in web and Desktop chat) needs a live check. See [BACKLOG.md](BACKLOG.md).
- **Workflow:** every change goes branch → PR → version bump → CI → squash-merge → `tools/release.sh`. Nothing is committed to `main` directly. The steps are in [CLAUDE.md](../CLAUDE.md) and below.
- **Enforcement:** GitHub branch protection on `main` (since Nov 7): changes only through a PR, `test` and `version-bump` must pass, the branch must be up to date, linear history, no force-push or deletion, admins included. CI also flags any commit on `main` that didn't come from a merged PR, and a local `pre-push` hook blocks direct pushes before they reach GitHub.
- **In use:** the original user's page and hourly loop run the generic skill.
  - **As of Nov 11** (read-only): 6,933 messages; `threading/current` 185.6 KB and `summary/current` 215 KB, still the single documents, with `fromI` 2797 from sessions that dropped older summaries (B43). Only 7 messages, all captured Nov 11, carry full names (B41).
  - **Install the plugin** from the marketplace (README › Install), **remove the uploaded skill**, re-point the hourly loop at `messenger-catchup:refresh`, and **install the userscript once from the link**: the 1.1 copy was pasted, so it can't update itself.
  - On the next refresh on v1.17.0, Claude republishes the page (2.3), and that refresh's build converts threading and summary to the block layout in one batch; later it runs the one-time name scan and asks which aliases to add.
- **Repo:** public (since Nov 7), `github.com/roopesh/messenger-catchup`, branch `main`. **Never commit real names or text from a user's chat**: tests use the mock cast (Ana, Ben, Cy, Dee, You).

## Test suites
`npm test` checks formatting, then runs all three (about 3 minutes); CI runs the same on every PR.

| Suite | Command | What it covers | Now |
|---|---|---|---|
| Python | `npm run test:py` | `tests/test_catchup.py`: every link rule and assert, restore, bootstrap edge cases (unbuilt messages, chunks ahead of `meta/chat`), review regressions, and the block layout (`TestLayout`: a fake database with the real limits, migration with `fromI`, builds at 6.4k/25k/50k messages, interrupted migrations and retries, the size check, bootstrap from either layout, exact order through split and merge; `TestReview31`: the PR review's findings: a stale `current` from an older skill, a reused RUN folder, a relink after cleanup, an incomplete listing, a missing block, a half-applied batch and `--rollback`; `TestRestoreSummary`: a trimmed page restored from its backup equals an untrimmed twin given the same builds, with exact dry-run counts, open-question decisions, refusals, pins and undo). `tests/test_tools.py`: formatting-independent source checks: bookmarklet in sync, userscript installed from the release, version strings (minors one digit), `PAGE_VERSION` bumped when the page changed since the last tag, SKILL.md documents every db path, `meta/chat` field and outbox state the page uses, `SKILL.md` under 20 KB and naming every reference file (the restore procedure through `troubleshooting.md`), every `catchup.py` command documented, the plugin (version equals `VERSION`, marketplace entry, skill names match folders, no `bin/`, `plugin/` holds only shipped files, `claude plugin validate --strict` when the CLI is installed), the setup skill (its copies match, the skills name each other correctly, setup hands the first capture to refresh, its seed bootstraps and converts), step 5 and step 7 name the collections and the manifest, the never-drop rule, the page and `catchup.py` merge with the same keys, ZIP contents, release script, pre-push hook. Also `relink`. ResourceWarnings are errors. | 149 pass |
| Sim | `npm run test:sim` | `tests/sim.js`: the helper on a simulated Messenger (first run, incremental, mid-run arrivals and deletions, photo replies, short chat, 20 pinned-date label cases including New Year, follow-on messages that look like status lines, deleted/unsent messages, jump links and the page's bookmarklet, full names from avatars and nicknames, the `people` scan, `selfcheck` against broken hooks, far-up photo-reply parents, injected vs installed) | 60 pass |
| Page | `npm run test:page` | `tests/page.test.js`: the page in Chromium with a stand-in claude.ai runtime. Every importer check, leases, fresh reads, repairs (including across chunks), photo slots and retries, the full pipeline (sim captures → import → `catchup.py` → the manifest written as Claude writes it → render), markers, date entry, outbox states and Dismiss, safe links, Ask, Views, range summaries, the block layout (both layouts render the same text, the old layout exactly as the last release's page, archived conversations shown and searchable, live block changes, a missing block reported after 5 s; the runtime refuses documents over 256 KiB and batches over 50 writes or 1 MiB), names (`people/index`, the display rule) | 154 pass |

When a bug is found, write its test as the *fixed* behavior first. Python can mark it `expectedFailure`, and the page test has `known()`, which prints `KNOWN` without failing the run. Remove the marker in the PR that fixes it.

## Where to start
1. **One live refresh on the real chat** on v1.17.0. The mock can't prove these, and they're the main remaining risk:
   - the page republishes to 2.3, the build converts both collections (its manifest: blocks plus the two `current` documents, one batch), and the page shows the same summary and threads as before
   - `selfcheck` passes; no `DATES-GUESSED`
   - full names arrive (`fn`), and the one-time name scan fills `people/index`
   - the page shows names by the rule
   - a queued reply posts: R9, the "Replying to …" bar
   - Tampermonkey picks up a later helper release by itself (the redirect from `latest/download`)
   - the plugin's skill loads in chat and Desktop, and a later release reaches it by itself
2. **R2:** measure a large capture (many photos) to see whether the clipboard and paste hold up.
3. **G6:** document the `outbox/*` row fields and `coverage`.
4. **Plugin updates:** confirm that a release reaches a marketplace install in Desktop by itself, and how fast.

## Doc map
| Doc | Use it for |
|---|---|
| [README.md](../README.md) | What it is, install, requirements |
| [CLAUDE.md](../CLAUDE.md) | The workflow rules (PR, versioning, release) |
| [CHANGELOG.md](../CHANGELOG.md) | What changed in each release |
| [plugin/skills/refresh/](../plugin/skills/refresh) and [plugin/skills/setup/](../plugin/skills/setup) | The procedures Claude follows: refresh's `SKILL.md` every run and its `references/` when needed; setup's `SKILL.md` once per chat. **Changing them changes behavior.** Setup's `assets/` and `references/` are generated copies. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the parts fit; full database reference; helper functions and bridge; capture format (`fn`); tests; range summaries |
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
npm run setup      # once: Playwright's Chromium, the pre-push hook, .venv with pinned Ruff
npm run fmt        # before committing: Prettier + Ruff, then npm run sync
npm test           # format check, Python suites, sim, page (about 3 minutes)
```
Exit code 0 means everything passed. The page suite reads `tests/out/sim_caps.json`, which the sim writes, so run `test:sim` before `test:page` when you run them separately. `tests/out/` is gitignored.

### Try `catchup.py` locally
```sh
python3 plugin/skills/refresh/scripts/catchup.py bootstrap WORK DBDIR      # DBDIR: chunks/*.json, threading/*.json, summary/*.json, meta/chat.json
python3 plugin/skills/refresh/scripts/catchup.py build WORK RUNDIR spec.json  # writes RUNDIR/out/manifest.json and the documents it names
```
`build` advances WORK in place; `restore WORK` undoes one build. `tests/test_catchup.py` has an `Env` class that builds these folders, and `Live` (with `FakeDB`) runs whole refreshes against a database with the real limits, so it's the quickest way to try a spec. `tests/synth.py` makes large synthetic histories.

### Change the helper
1. Edit `plugin/skills/refresh/assets/helper.user.js`.
2. `npm run fmt` formats and then runs `npm run sync`, which regenerates the page's bookmarklet and the setup skill's copy of the page. `npm test` fails if you forget.
3. To release a new helper version, bump all four version strings (header `@version`, `window.__mcHelper`, `data-mc-helper`, `ping`; a test checks they agree; minor stays one digit, 1.9 → 2.0). Installed copies update themselves from the release, which `tools/release.sh` attaches the userscript to.
4. `npm test`.

### Change the page
1. Edit `plugin/skills/refresh/assets/page.html`. It has no `<!doctype>…<body>` skeleton, because the Artifact tool adds that at publish time (the page test adds the same one). Bump `PAGE_VERSION` whenever the page changes; a test enforces it.
2. Claude republishes a user's page when `meta/chat.pageVersion` is older (SKILL.md, before each run). The database survives a republish.
3. `npm test`. The page suite loads the real file.

### Every change: PR, version, merge, release
1. Branch from an up-to-date `main`.
2. Make the change. Bump `VERSION`, `package.json` (`npm version X.Y.Z --no-git-tag-version` updates the lockfile too) and `plugin/.claude-plugin/plugin.json`, and add a `CHANGELOG.md` entry. MAJOR / MINOR / PATCH rules are in [CLAUDE.md](../CLAUDE.md). `npm test` fails if these disagree.
3. `npm test`, then `gh pr create`. Fill in the template's checklist (`.github/pull_request_template.md`).
4. `gh pr checks --watch` until CI (`test`, `version-bump`) is green, then `gh pr merge --squash --delete-branch` and `git switch main && git pull`.
5. `tools/release.sh`: tags `vX.Y.Z` on the merge commit, builds the plugin ZIP from the tag (the `plugin/` folder), checks its version, and publishes the GitHub release with the changelog entry and the userscript.
6. Marketplace installs update from `main` once the plugin's version changes (step 2). ZIP uploads (Customize › Plugins › Upload plugin) don't update themselves.

## Gotchas worth knowing before you touch anything
- The reader is tied to Messenger's English labels and markup. When a scan suddenly fails, check those first (LEARNINGS.md › Messenger DOM).
- Claude in Chrome tool calls die at about 45 s. Anything long is started and then polled in calls of 25 s or less.
- The capture step **replaces the Messenger tab's page** with the COPY CAPTURE button. Navigate back to the chat afterwards.
- Timestamps in status docs must come from the tool clock, not memory (LEARNINGS.md › Tooling).
- Pin every Claude-side write to an existing document with `if_version`. New block documents have no version; step 7 writes exactly what `RUN/out/manifest.json` lists.
- A database document holds at most 256 KiB, and a batch at most 50 writes and 1 MiB (LEARNINGS.md › Page database). Never store something that grows with the chat in one document.
