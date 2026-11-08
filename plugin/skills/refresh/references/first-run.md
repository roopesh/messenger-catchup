# First run (right after setup)

Read this when `meta/chat.lastI` is `-1`: the `messenger-catchup:setup` skill has just seeded the database and handed over for the first capture and build. Follow the refresh steps in SKILL.md with these changes.

- **Capture:** scan with `first:{count:N}` instead of stops, where N is `meta/chat.firstCount` (the history size chosen at setup; 300 if it's missing), and base `-1`. The page accepts a first import only when it starts at #0.
- **Bootstrap** (instead of the normal one): write the seeded docs as JSON into a folder (`seed/meta/chat.json` with `lastI:-1`, `seed/threading/current.json`, `seed/summary/current.json`), run `python3 ${CLAUDE_SKILL_DIR}/scripts/catchup.py bootstrap WORK seed`, then build as usual.
- **Build:** replies to messages from before the first window print `WARN reply parent not found … left unlinked`: that's expected. Review GUESS lines only for the newest ~150 messages; older ones keep the default.
- **After the batch write:** set `markerMode:"time"` and `markerFrom` to the first message's local time ("YYYY-MM-DDTHH:MM") so the page shows everything captured.
- **Step 8:** skip its report and the people check: setup's last step reports, and the next refresh runs the people check.
- **Then** go back to the setup skill's last step (the schedule and the report). If this run came from a later retry (setup already finished, for example a scheduled run), report as usual instead.
