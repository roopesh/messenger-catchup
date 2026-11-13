# Updating the page

Read this on a refresh when `meta/chat.pageVersion` differs from `PAGE_VERSION` in `assets/page.html`. Compare number by number, never as decimals: 2.0 is newer than 1.9, and 1.10 would be newer than 1.9.

## `pageVersion` is older: update the page
Update the page before anything else: `Artifact read` its url, publish `assets/page.html` to that url (leave out `capabilities` so the stored ones carry over; the database survives), then update `meta/chat` `{pageVersion, versions:{page}}` (both set to this `PAGE_VERSION`, in one update) pinned with `if_version`, and say so in the report. Writing `versions.page` with `pageVersion` keeps the page from saying an older skill ran if this run stops before step 7. If the publish is refused, leave `pageVersion` as it is and carry on; step 7 still writes `versions`, so the page says a newer page is waiting, and the next run tries again.

## `pageVersion` is newer: this copy of the skill is older than the page
The page was published by a newer copy of this skill (the user has the updated plugin somewhere, and this run came from an older copy: an uploaded skill, or an old scheduled task).
- **Never republish** and never lower `pageVersion`: that would put an older page in place of a newer one.
- Carry on with the run as usual. The database layout only changes in a major release, so this copy's writes stay compatible.
- Write `versions` as usual (`references/database.md` › Versions). Its lower `page` is what makes the page tell the user an older skill ran; never write a higher `page` to make that go away.
- In the report, scheduled runs included, add one line: "This copy of the skill is older than the one that published your page (page <pageVersion>, this copy's <PAGE_VERSION>). Update the plugin (Customize › Plugins) and remove any copy of the skill you uploaded yourself."
