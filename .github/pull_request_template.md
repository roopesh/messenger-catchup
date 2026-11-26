## What and why


## Version
- [ ] `VERSION`, `package.json`, `plugin/.claude-plugin/plugin.json` and a new `CHANGELOG.md` entry all say the same version
- [ ] Bump type matches the change (MAJOR / MINOR / PATCH, see CLAUDE.md)
- [ ] `PAGE_VERSION` bumped if the page (`assets/page.html`) changed in a way users' pages should get
- [ ] Helper version bumped (all four strings) if the helper (`assets/helper.user.js`) changed; `npm run sync` run

## Docs
Docs: <which docs you updated, or none needed — why>

Consider each (CI's docs check needs the line above, and every doc it names must be changed in this PR): `README.md` (what users see and do), `docs/STATUS.md` (handoff; its release line always), `docs/DECISIONS.md` (an owner decision), `docs/ARCHITECTURE.md` (how parts fit), `docs/DEVELOPMENT.md` (how to work on it), `CLAUDE.md` / `AGENTS.md` (how agents work here), a skill's `SKILL.md` or `references/*.md` (what Claude does for users).

## Checks
- [ ] `npm test` passes (paste the summary: Python / sim / page counts)
- [ ] `docs/BACKLOG.md` updated: finished items removed, new ones filed; fixed issues closed (`Closes #N`), every open issue triaged
- [ ] SKILL.md changed? Described above as a behavior change

## After merge
- [ ] `tools/release.sh`: tags `vX.Y.Z` on the merge commit and publishes the release (it carries the plugin ZIP, the userscript and the changelog entry)
