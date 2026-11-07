# Working in this repo

Start with [docs/STATUS.md](docs/STATUS.md) (current state, how to test, change and release) and [docs/BACKLOG.md](docs/BACKLOG.md).

## Every change: branch → PR → version → merge
The owner's standing rule. No exceptions for "small" changes, docs or tests.
1. **Never commit to `main`.** Branch from an up-to-date `main` (`fix/…`, `feat/…`, `docs/…`, `release/vX.Y.Z`).
2. **Version it in the same PR:** bump `VERSION`, set the same version in `package.json`, and add a `CHANGELOG.md` entry dated today (`## [X.Y.Z] - YYYY-MM-DD`). `npm test` fails if the three disagree.
3. **`npm test` must pass** before opening the PR. Say in the PR what you ran and what it printed. Run `npm run setup` once per clone: it also installs the `pre-push` hook that blocks direct pushes to `main`.
4. **Open the PR** with `gh pr create`. The template's checklist must be filled in honestly.
5. **Wait for CI** (`gh pr checks --watch`): `test` and `version-bump` must pass. Then **merge** with `gh pr merge --squash --delete-branch` and `git switch main && git pull`. After the merge, `pr-only` runs on `main` and should pass too.
6. **Tag and release** the merge commit: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`, build the ZIP (`./make-zip.sh`), then `gh release create vX.Y.Z <zip> --title vX.Y.Z --notes "<the changelog entry>"`.

## Versioning (semver for the skill as a whole)
- **MAJOR:** users must redo setup, or the database layout changes incompatibly.
- **MINOR:** new features, or behavior users or Claude can notice (SKILL.md procedure changes, page features).
- **PATCH:** fixes, docs, tests, tooling, behavior-neutral refactors.
- **Component versions** are separate and bumped only when that part changes:
  - `PAGE_VERSION` in `assets/page.html`: Claude republishes users' pages when it rises.
  - The helper version (four strings in `assets/helper.user.js`; a test checks they agree): users reinstall the userscript.
  - Note either change in the changelog entry.

## Other rules
- After editing `assets/helper.user.js`, run `npm run sync` (the page embeds copies; a test enforces it).
- `SKILL.md` is what Claude executes for users. Treat edits to it as behavior changes.
- Keep `docs/BACKLOG.md` current: close items in the PR that fixes them, and file anything new you find.
