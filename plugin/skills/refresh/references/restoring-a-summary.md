# Restoring a summary from a backup

Read this when the user asks to put back summary items that an earlier session dropped, or when the page's database has a `backups` collection holding a copy of `summary/current` from before a drop (`references/database.md`). Sessions before v1.17 dropped conversations, bullets, open questions, answers, deals and mentions to keep `summary/current` under the 256 KiB cap, and moved `summary.fromI` up. Some saved the whole summary first, in parts, as `backups/<name>-a`, `-b`, … Never start a restore on your own or during a scheduled run: only when the user asks.

`catchup.py restore-summary WORK RUN BACKUPDIR [DECISIONS] [--dry-run]` adds back everything the backup has that the stored summary lacks, and writes it in the block layout, the way a build does:
- **Conversations** missing from the summary come back. One the summary still has (or started again because it was continued) gets the backup's bullets in front of its own, with no duplicates, and its empty tag, outcome or key filled from the backup. An old string synopsis becomes one bullet per sentence, as the page shows it.
- **Answers, deals and mentions** that are missing come back where they were in the list. A deal edited since (new text, added refs) counts as present.
- **Open questions** missing from `open` come back only as your decisions say (step 5). One that either summary's `answered` already holds is left alone.
- **`fromI`** goes back to the backup's (or is removed when the summary then covers everything from #0).
- Items that no longer fit threading (a conversation it doesn't have, refs outside their conversation) are skipped and listed in `RUN/out/restore-skipped.json`.

It never removes or changes anything the stored summary has, and running it again restores nothing.

## Steps
1. **Take the run lock**, as a refresh does: `get` `refresh/status`. If its `state` is `"running"` and `startedAt` is under 20 minutes old, a refresh is running: wait for it to finish and try again. Otherwise set `refresh/status` `{state:"running",startedAt,step:"restore",by:"restore-summary"}`, pinned with the version you read. If that write is refused, read it again and wait for the other run. From here on, if you stop for any reason, release the lock: update `refresh/status` (pinned) to `{state:"done",finishedAt}`, or `{state:"error",message}` if something failed.
2. **Fetch into folders** in a scratchpad: `list chunks`, `list threading` and `list summary` (each limit 1000) and `get` `meta/chat` and `refresh/status` into one `out_dir` DB; `list backups` (limit 1000) into another, BK. Note the versions this read shows for `threading/current`, `summary/current`, every summary block and `refresh/status`: the write pins with them.
3. **Bootstrap** a fresh WORK: `python3 catchup.py bootstrap WORK DB`. If it stops, follow what it says (`references/writing-the-build.md`), then start again from step 2.
4. **Dry run:** `python3 catchup.py restore-summary WORK DB BK --dry-run`. It prints only counts: per kind, how many would be restored, merged or skipped, and how many are already present, and how `fromI` moves. Report them to the user in a few bullets, say that nothing the page has now is removed or changed, and ask them to confirm. Without a yes, release the lock and stop.
5. **The open decisions:** run `python3 catchup.py restore-summary WORK DB BK` (no DECISIONS).
   - If it says `Nothing written. N open question(s) to decide`, it wrote `DB/out/restore-open.json` (each question, its conversation, and the stored messages after it) and nothing else. Read each question's later messages and write a DECISIONS file with one entry per question, starting from the file's `template`: `{"<ask>": "open"}` if nobody answered it, or `{"<ask>": {"answer": "<one line>", "refs": [<the answering messages>]}}`. `refs` must be stored messages after the ask in its conversation; use `[]` only when the answer came in another conversation, and name that message (#N) in the answer. Then run `python3 catchup.py restore-summary WORK DB BK DECISIONS`.
   - If it says `restore ok`, the backup had no open questions to decide, and this run did the restore.
6. **Write it:** the run that said `restore ok` wrote the summary documents and `DB/out/manifest.json`, and advanced WORK's summary. Write what the manifest lists exactly as step 7 of a refresh does (`references/writing-the-build.md`): one `ArtifactData batch` per entry of `batches`, in order, with `if_version` from step 2's read on every entry that has `pin` (`threading/current` and `summary/current`: both carry the write's `rev`, so both must land). Add `refresh/status` **update** `{state:"done",finishedAt}` (pinned) to the last batch: that releases the lock. Once every batch has succeeded, delete what `cleanup` lists, pinned with step 2's versions. Threading's blocks don't change; only its `current` document is rewritten.
7. **Verify:** fetch again into a new folder (step 2), bootstrap a new WORK, and run the dry run again. It must say `nothing to restore: 0 restored`. If it doesn't, tell the user what it shows.
8. **Tell the user**, in short bullets: what came back (the counts), which open questions are open again and which were marked answered (with the answering message numbers), how `fromI` moved (the page now covers from #N, and offers span summaries only before it), and anything skipped (`restore-skipped.json`). Say that the backup is still in the page's database.

## Refusals
- **A write refused** (a version changed: the page, a refresh or another session wrote in between): `python3 catchup.py restore WORK`, then start again from step 2. Blocks already written are found and skipped.
- **`summary/current changed since WORK was bootstrapped`**: a refresh built after step 3. Start again from step 2.
- **The backup is incomplete or mismatched** (a part missing, parts from different saves, parts that disagree on how many there are): `list backups` again. If it still says so, write nothing, release the lock, and tell the user. Never restore from part of a backup.
- **`DECISIONS has no decision for #…`** or **`names #…`**: the decisions must cover exactly the questions in `restore-open.json`. Fix the file and run it again (nothing was written).
- **A document over the size limit:** nothing was written; tell the user and report it (`references/writing-the-build.md` › Never drop anything to save space).

## The backup afterwards
Leave `backups/*` in place: the page ignores it, and it costs nothing. Once a restore is verified (step 7), it's no longer needed. Delete it only if the user asks (`ArtifactData delete`, one pinned delete per part); the user decides, never a session on its own.
