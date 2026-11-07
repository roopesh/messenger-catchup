## What and why


## Version
- [ ] `VERSION`, `package.json` and a new `CHANGELOG.md` entry all say the same version
- [ ] Bump type matches the change (MAJOR / MINOR / PATCH, see CLAUDE.md)
- [ ] `PAGE_VERSION` bumped if `assets/page.html` changed in a way users' pages should get
- [ ] Helper version bumped (all four strings) if `assets/helper.user.js` behavior changed; `npm run sync` run

## Checks
- [ ] `npm test` passes (paste the summary: Python / sim / page counts)
- [ ] `docs/BACKLOG.md` updated (items closed or filed)
- [ ] SKILL.md changed? Described above as a behavior change

## After merge
- [ ] Tag `vX.Y.Z` on the merge commit and push it
- [ ] `gh release create vX.Y.Z` with the skill ZIP and the changelog entry
