# Working in this repo

Start with [docs/STATUS.md](docs/STATUS.md) (current state, how to test, change and release) and [docs/BACKLOG.md](docs/BACKLOG.md).

## Every change: branch → PR → version → merge
The owner's standing rule. No exceptions for "small" changes, docs or tests.
1. **Never commit to `main`.** Branch from an up-to-date `main` (`fix/…`, `feat/…`, `docs/…`, `release/vX.Y.Z`).
2. **Version it in the same PR:** bump `VERSION`, set the same version in `package.json` (`npm version X.Y.Z --no-git-tag-version`) and in `plugin/.claude-plugin/plugin.json`, and add a `CHANGELOG.md` entry dated today (`## [X.Y.Z] - YYYY-MM-DD`). `npm test` fails if they disagree. Installed plugins update only when the plugin's version changes.
3. **`npm test` must pass** before opening the PR. Say in the PR what you ran and what it printed. Run `npm run setup` once per clone: it installs Chromium, the `pre-push` hook that blocks direct pushes to `main`, and a `.venv` with the pinned Ruff.
4. **Open the PR** with `gh pr create`. The template's checklist must be filled in honestly.
5. **Wait for CI** (`gh pr checks --watch`): `test` and `version-bump` must pass. Then **merge** with `gh pr merge --squash --delete-branch` and `git switch main && git pull`. After the merge, `pr-only` runs on `main` and should pass too.
6. **Tag and release** the merge commit: `tools/release.sh` on an up-to-date `main` (it tags `vX.Y.Z`, builds the plugin ZIP from the tag, checks its version, and publishes the GitHub release with the changelog entry and the userscript). Marketplace installs pick up the merge on `main` itself; the release serves the userscript's self-update and ZIP uploads.

## Versioning (semver for the skill as a whole)
- **MAJOR:** users must redo setup, or the database layout changes incompatibly.
- **MINOR:** new features, or behavior users or Claude can notice (SKILL.md procedure changes, page features, skill names).
- **PATCH:** fixes, docs, tests, tooling, behavior-neutral refactors.
- **Component versions** are separate and bumped only when that part changes:
  - `PAGE_VERSION` in `plugin/skills/refresh/assets/page.html`: Claude republishes users' pages when it rises.
  - The helper version (four strings in `plugin/skills/refresh/assets/helper.user.js`; a test checks they agree). Installed copies (1.5+) update themselves from the latest release, which `tools/release.sh` attaches the userscript to.
  - Keep both minor parts one digit (1.9 → 2.0, never 1.10). Read as decimals, 1.1 and 1.10 look equal. A test enforces it.
  - Note either change in the changelog entry.

## Other rules
- The repo is **public**. Never commit real names, nicknames or message text from anyone's chat (code, tests, docs, commit messages, PR bodies). Use the mock cast (Ana, Ben, Cy, Dee, You).
- Run `npm run fmt` before committing: Prettier for the page, helper and JS tests, and Ruff for Python. It also runs `npm run sync`, which regenerates the page's embedded copies of the helper. `npm test` starts with `fmt:check` and fails on unformatted files. One statement per line keeps merge conflicts down to edits that really overlap.
- **The repo is a plugin marketplace.** `.claude-plugin/marketplace.json` lists the plugin in `plugin/`, and everything under `plugin/` reaches users, so dev files stay outside it (a test lists what's allowed). No top-level `plugin/bin/`: claude.ai refuses plugins that have one. Two skills, `setup` and `refresh`; a skill can only count on its own folder, so setup carries copies of the page and `references/database.md`. Edit the refresh skill's files and run `npm run sync`; `npm test` fails on a stale copy. Skill files refer to each other relative to the skill's folder (`${CLAUDE_SKILL_DIR}` in Claude Code and Cowork; the folder holding `SKILL.md` in chat).
- `plugin/skills/refresh/assets/page.html` holds the page **without** the document skeleton (`<!doctype html>…<body>`): the Artifact tool adds it at publish time. A test enforces this.
- A skill's `SKILL.md` and `references/*.md` (under `plugin/skills/<name>/`) are what Claude executes for users. Treat edits to them as behavior changes. `SKILL.md` is read on **every** refresh, so keep it to what a refresh needs (a test caps it at 20 KB), and put anything needed only sometimes in a reference file that `SKILL.md` names, saying when to read it.
- Keep `docs/BACKLOG.md` current: close items in the PR that fixes them, and file anything new you find.
