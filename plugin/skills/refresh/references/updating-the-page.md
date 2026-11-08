# Updating the page

Read this on a refresh when `meta/chat.pageVersion` is older than `PAGE_VERSION` in `assets/page.html` (compare number by number, never as decimals: 2.0 is newer than 1.9, and 1.10 would be newer than 1.9).

Update the page before anything else: `Artifact read` its url, publish `assets/page.html` to that url (leave out `capabilities` so the stored ones carry over; the database survives), then update `meta/chat` `{pageVersion}` pinned with `if_version`, and say so in the report.
