## What and why


## Version
- [ ] `VERSION`, `package.json`, `plugin/.claude-plugin/plugin.json` and a new `CHANGELOG.md` entry all say the same version
- [ ] Bump type matches the change (MAJOR / MINOR / PATCH, see CLAUDE.md)
- [ ] `PAGE_VERSION` bumped if the page (`assets/page.html`) changed in a way users' pages should get
- [ ] Helper version bumped (all four strings) if the helper (`assets/helper.user.js`) changed; `npm run sync` run

## Checks
- [ ] `npm test` passes (paste the summary: Python / sim / page counts)
- [ ] `docs/BACKLOG.md` updated (items closed or filed)
- [ ] SKILL.md changed? Described above as a behavior change

## After merge
- [ ] `tools/release.sh`: tags `vX.Y.Z` on the merge commit and publishes the release (it carries the plugin ZIP, the userscript and the changelog entry)
