# Experiments and findings

All numbers were measured on the original user's live chat or on the simulated thread in `tests/`. Times are wall-clock unless marked "browser" (in-page work only).

## 1. Where refresh time went (Nov 1, before speed-ups)
A refresh of 183 messages took about 17 min:

| Step | Time | Cause |
|---|---|---|
| Scroll back and read 172 messages | ~1.5 min | Slow scroll (35% of a screen every 0.9 s); faster once skipped 19 messages |
| Click 88 reply links | ~2.5 min | ~1.7 s each |
| Second check scan | ~1.5 min | Reload and scroll again |
| Get data out of Chrome | ~2.5 min | Claude retyped a 40 KB capture, then checksummed it |
| 12 late arrivals | ~2 min | Extra scan and check |
| Photos | ~2.5 min | Separate pass; one screenshot per photo |
| Threading and summary | ~2.5 min | Written per conversation |
| Clash with another refresh | ~2 min | Save refused; re-read and merged |

- **Finding:** backlog size dominates. 3 messages ≈ 2 min, 183 ≈ 17 min, so refresh often.

## 2. Speed-up results (Nov 1–2)
| Change | Result |
|---|---|
| Quote-matched replies (today's 19) | 17 settled in ~2 s vs ~18 s of clicking; the other 2 were clicked. Of the 17, 14 agreed with the clicked answer; the other 3 were replies where clicking had failed |
| Quote match vs 238 stored replies | 236 right, 0 wrong, 2 fell back to clicking |
| Faster check scan | 33 messages in 10 s with no gaps (was 18 s) |
| Paste import, dry run on 55 stored messages | Same checksum, messages, chunk and photos as the old 7-step import |
| Photos via paste | Byte-identical to the originals. Screenshot crops: 26–28 dB, average pixel error ~6, 25–40% larger |

## 3. Helper benchmarks (Nov 6)
| Run | Messages | Time |
|---|---|---|
| Helper v2.0 `full` | 50 | 93 s browser (scan 70 + reload/verify/capture 23) |
| Helper v2.0 `full` | 100 | 143 s browser (scan 108 + 35; 9 photos) |
| Helper v2.1 | 111 | 69 s browser (scan 31 + 38; 11 photos) |
| Live refresh | 13 | 18 s browser; ~2.5 min wall-clock including import and build |
| Live refresh 240 | 130 | 225 s browser; mostly 4 photo replies whose parents were far up the chat |

- **Overall:** about 7–10 min per refresh before, about 2–2.5 min after.
- **Finding:** in v2.0 the scan was the bottleneck, from small scroll steps and reply clicks. v2.1 uses 0.6-screen steps every 500 ms and no clicks.

## 4. Reply matching by quote (Nov 6)
- **Rule:** same author, plus the first 20 characters of the normalized quote; leading emoji stripped; 300-message window; latest wins.
- **Result:** 348/348 correct, including 76/76 checked by clicking.
- **Photo replies:** 46/46 replies with no quote pointed at media.
- **Failure found:** the "author's latest photo" guess was wrong once. Since helper v2.2, photo replies are clicked.

## 5. Threading non-replies (Nov 6)
- **Setup:** 67 hand-labeled non-reply messages, in two batches of 34 and 33. Each was scored on whether its link matched a labeled parent.
- **Re-run on Nov 6 at 8:10 PM**, after more refreshes; the earlier runs gave the same picture.

| Method | Score |
|---|---|
| Current links (Claude's judgment at build time) | 61/67 = 91% |
| Previous message | 53/67 = 79% |
| Previous message by another author | 32/67 = 48% |
| Linker trained on explicit replies | 30/67 = 45% |
| Hand-tuned context linker, batch it was tuned on | 27/34 = 79% (current: 33/34 = 97%) |
| Hand-tuned context linker, held-out batch | 24/33 = 73% (current: 28/33 = 85%) |
| Current + "continuation" rule | 59/67 = 88%; would have changed 441 of 1,784 links |

- **Predicting Messenger's own reply parent from context only:**
  - 1,381 of 1,442 parents fell within the candidate window.
  - On the 690-message test half:
    - trained linker: 33.6%
    - previous message: 16.5%
    - previous message by another author: 20.3%
- **Finding:** reply behavior doesn't transfer to non-replies. Nothing beat the current links, so nothing shipped. The complaint was really about display, fixed with `convTree`.

## 6. Date and time entry
- **Repro:** typing a two-digit month or hour saved a half-typed value, and the list rebuilt under the cursor.
- **Fix:**
  - no rebuild while the field is focused
  - saves 1.5 s after the last keystroke, or on Enter or blur
- **Verified Nov 6, 8:17 PM (Playwright, headless Chromium).** Typed `11/03/2026 09:15 AM` one key every 60 ms into the "from" field, loaded with real chat data:

| Check | Current page (generic, v1.1) | Old page (v42, control) |
|---|---|---|
| Field value after typing | 2026-11-03T09:15 ✓ | 2026-01-02T08:32 ✗ |
| Field rebuilt mid-typing | No | Yes |
| Saves while typing | 0 | 1 (a half-typed value) |
| Saved after 1.5 s pause | 1, correct value | wrong value |
| Enter (checked at 200 ms) | 1 save, correct | — |
| Click outside, i.e. blur (at 200 ms) | 1 save, correct | — |
| Tab | moves to the "to" field, no save yet (by design: the range is still being edited) | — |

## 7. Generic skill validation (Nov 6)
| Test | Result |
|---|---|
| Simulated Messenger thread (`tests/sim.js`): first run, incremental runs, mid-run arrivals, photo replies, short chat, older date labels, stale results, jump links, with and without the helper | 35/35 pass |
| Pipeline replay: capture → page import → `cctool build` | 3 imports, 3 builds OK |
| Live sandbox page, first run, no helper | OK |
| Live switch: refreshes 244 (injected v1.1) and 245 (old v2.2 helper) | Both done, no errors |
| Old vs new page, rendered side by side | Title, header, summary and messages identical; only the "Refreshing" text and jump tag differ |
| Independent cold review of the skill (fresh agent that hadn't seen the work) | 12 issues, all fixed (see section 9) |

## 8. Outbox posting
- **Method:** insert the text into Messenger's Lexical editor with `execCommand('insertText')`, check that the box text equals the stored text and that "Replying to …" is shown, press Enter, then check for a new "You:" message.
- **Finding:** `execCommand('delete')` does not clear the editor. Clear it with a click, then select all, then Delete.

## 9. Cold review of the generic skill (Nov 6)
- **How:** a fresh agent with no context ran a dry first run of `cctool` and read SKILL.md, the page and the helper.
- **Re-checked against the code in this repo on Nov 6 at 8:20 PM:**

| # | Issue found | Status now | Where |
|---|---|---|---|
| 1 | No-helper scan can't finish: one call waits 70 s and loses the id | Fixed: start with your own id, poll in calls ≤ 25 s | SKILL.md "Helper" |
| 2 | Stale `mc_result` can fake a finished capture | Fixed: `full()` clears it; results carry a `run` id | helper `full()` |
| 3 | Stale `__mcsave` can import duplicates | Fixed: scan clears it; SKILL requires `err:null` | helper `mcScan` |
| 4 | `cctool` crashes on dates older than a week | Fixed: `_min` takes the date from `d` and the time by regex | `catchup._min` |
| 5 | Claude may not see a tab the user opened | Fixed: Claude opens the chat tab itself (`tabs_create_mcp`) | SKILL.md setup step 1 |
| 6 | Posting a reply was underspecified; double-post risk | Fixed: box selector, wait for "reply box is ready", `sending` state checked before re-posting | SKILL.md "Outbox" |
| 7 | Scheduled-task option had `requires_local_device:false`; prompt incomplete; overnight chain could die | Fixed: `true`; full prompt; next run at start of the hours window | SKILL.md "Scheduling" |
| 8 | Helper install advice; double-run if injected on top | Fixed: Tampermonkey or Violentmonkey with "Allow User Scripts"; check `data-mc-helper` every run; guard against a second copy | SKILL.md, helper line 11 |
| 9 | End-to-end encrypted chats (`/messages/e2ee/t/`) not handled | Fixed: full `chatUrl` stored and used; still untested live | SKILL.md, page |
| 10 | `out_dir` format and write versions unclear | Fixed: files hold the bare doc; take `if_version` from the read | SKILL.md steps 5 and 7 |
| 11 | Short chat drops its oldest message; GUESS review impractical on a 1,000-message first build | Fixed: `__top__` anchor captures all; first run reviews only the newest ~150 | helper scan, SKILL.md step 6 |
| 12 | Cosmetic leftovers from the original chat | Fixed Nov 6, 8:30 PM: "bags" placeholder and "Pacific" comment removed; a chat-specific deal kind → `raffle`/`group` (chip classes, deal kind, prompt, heading); storage key `ccSumFilter` → `mcSumFilter`. Kept on purpose: `cctool` falls back to America/Los_Angeles only when `meta/chat.tz` is missing. Rendered page text checked identical before and after | page, `cctool` |

## 10. Handoff review (Nov 6, evening)
- **How:** read every file against every doc at `9c353de`, then ran the checks below. Findings are filed in [BACKLOG.md](BACKLOG.md).

| Check | Result |
|---|---|
| `tests/sim.js` on macOS, Node 26, Playwright 1.x in a scratch folder (`NODE_PATH`) | 35/35 pass, exit 0 |
| Page's userscript textarea (HTML-unescaped) vs `assets/helper.user.js` | Identical (21,744 chars) |
| Page's bookmarklet (URL-decoded) vs the helper's `jump()` body | Same code |
| `cctool` replay: seed → bootstrap → build of 6 messages (text reply, photo reply with no photo, a cross-conversation link, a mention of #0) | Build OK. `note` stays `''` (B1). Cross-conversation link accepted silently (B4). Reply with no parent: WARN, then auto `GUESS … i` (B5) |
| Same RUN built a second time (a retry after a failed DB write) | `AssertionError: []`; WORK had already advanced, no backup (B2) |
| `dealEdit` on a conversation with no deal | `IndexError` (B3) |

- **Capture date parser** (`dOf` in the helper), run with "now" set to local noon:

| "Now" | Label | Parsed `d` | |
|---|---|---|---|
| 2026-11-06 | `November 3, 2026 9:15 AM` | 2026-11-03 | ✓ |
| 2026-11-06 | `Monday 9:15 AM` | 2026-11-02 | ✓ |
| 2026-11-06 | `9:15 AM` | 2026-11-06 | ✓ (today) |
| 2026-11-06 | `Nov 3, 2026 9:15 AM` | 2026-11-06 | ✗ falls back to today |
| 2026-11-06 | `Mon 9:15 AM` | 2026-11-06 | ✗ falls back to today |
| 2027-01-04 | `December 28 9:15 AM` | 2027-12-28 | ✗ in the future |

- **Finding:** whether real Messenger labels ever use the short forms is unknown (the mock uses full names only), so B6 is a latent risk rather than an observed failure. The year-boundary case will happen every January for year-less labels.
- **Copy check, for reuse** (run from the repo root):
```python
import html, re
p = open('assets/page.html').read()
us = html.unescape(re.search(r'<textarea id="jump-us"[^>]*>(.*?)</textarea>', p, re.S).group(1))
print(us == open('assets/helper.user.js').read())
```

## 11. Rename and test build-out (Nov 6, late evening)
- **Rename:** `cctool.py` → `catchup.py`, `ccScan`/`ccVerify`/`ccCapture` → `mcScan`/`mcVerify`/`mcCapture`, `cc-capture` no longer accepted, chat-specific palette comment removed. Before the helper was touched, `tools/sync-helper.py --check` confirmed the new sync tool regenerates the existing page copies byte for byte. After the rename, the page copies were regenerated with it.
- **Suites** (`npm test`, from an empty `tests/out/`):

| Suite | Result |
|---|---|
| Python (`test_catchup.py`, `test_tools.py`) | 49 run: 43 pass, 6 expected failures (B1–B5, B11) |
| Sim (`sim.js`) | 37/37 (35 before, plus the new "message deleted mid-run" case) |
| Page (`page.test.js`) | 79/79, plus 3 KNOWN (B7, B8, B9) |

- **Each known-bug test fails for its stated reason**, checked one by one with the marker removed: B1 note `''`; B2 bare `AssertionError: []`; B3 `IndexError`; B4 no WARN; B5 reply linked `[0,'i']`; B11 linked to #1 instead of #0; B7 snippet without text; B8 2 page errors and no rows; B9 "and confirm" with auto-posting on.
- **Mutation check:** deliberately break the code, run the relevant suite, restore.

| Break | Suite | Caught |
|---|---|---|
| One helper call left as `ccScan`, page copy not resynced | Python | ✓ |
| Same, resynced | Sim | ✓ |
| SKILL.md still names `scripts/cctool.py` | Python | ✓ |
| Page accepts `cc-capture` instead of `mc-capture` | Page | ✓ |
| Bullet limit loosened from 15 to 16 words | Python | ✓ |
| `c` and `i` link types swapped | Python | ✓ |
| Importer stops updating `ownLastI` | Page | ✓ |
| `make-zip.sh` drops `scripts/` | Python | ✓ |
| Verify ignores a changed window (`prefixSame` dropped) | Sim | ✗ at first → ✓ after adding test A5 |

- **Found while writing the tests:**
  - **B11 (new):** `catchup.py` ignores Messenger's own reply link when the parent is message #0, because `pi = 0` is falsy.
  - **B9 refined:** the "Queued…" text only flashes; the outbox snapshot re-renders the row into a "reply queued" chip.
  - Two first-run failures were test mistakes, both worth knowing (LEARNINGS.md › Testing): a summary bullet citing the deal's message is hidden by design, and one marker click produces two renders (local, then the database snapshot).

## 12. P1 fixes (v1.2.0, Nov 6)
- **B2:** 7 new `TestRestore` tests: rebuilding without a restore gives a clear message; restore → rebuild with a new spec works; restore undoes exactly one build; bootstrap clears a stale `prev`; a rejected build leaves `prev` alone; the CLI works.
- **R1:** 17 new page checks in `robustness()`. The same checks were run against the v1.1.2 page (`PAGE_FILE=… node tests/page.test.js`):

| Scenario | v1.1.2 page | v1.2.0 page |
|---|---|---|
| `meta/chat` update fails after the chunk is saved; paste again | Stuck for good: "The newest stored chunk doesn't end at #-1" | `REPAIRED: #0–#9`, counters fixed, next capture imports |
| Second chunk write fails during a rollover; paste again | Stuck: "Gap: the capture starts at #80 but the store ends at #-1" | Repairs #80–#81, imports #82–#85 into `c0082` |
| Refused capture while a repair is pending | n/a | Nothing written, repair included |
| `meta/chat.lastI` ahead of the chunks | Refused, no guidance | Refused, says what to set |
| Another copy of the page holds the import lease | No protection | Refused, nothing written; works once the lease is free |
| Page snapshot stale (store moved on silently) | Would refuse or misjudge the overlap | Fresh reads, overlap checked against the store, nothing lost |
| Runtime without `acquire()` | n/a | Imports without a lease |


## 13. Document sizes and the block layout (v1.17.0, Nov 11)
- **On the owner's page (read-only, sizes and counts only):** 6,933 messages; `threading/current` 185.6 KB compact (504 conversations 75 KB, 6,068 links 110 KB); `summary/current` 249 KB in the morning, 215 KB with 315 conversations in the evening after sessions dropped older ones (`fromI` 2797). The cap is 262,144 bytes (BACKLOG B43).
- **Synthetic chats** (`tests/synth.py`, mock cast) calibrated to that page: at 6,933 messages, 519 conversations, 5,794 links, threading 175 KB (25 bytes a message) and a full summary 371 KB (54 bytes a message). "Heavy" has a 1.6× denser summary (more and longer bullets, more answers and deals).
- **Largest document per layout** (compact JSON bytes; blocks of 1,000 messages):

| Messages | Old layout: threading / summary | Threading block (max) | Summary block (max) | `summary/current` | Documents |
|---|---|---|---|---|---|
| 6,400 | 162 KB / 316 KB (over the cap) | 27 KB | 55 KB | 84 KB | 14 |
| 25,000 | 675 KB / 1,404 KB | 31 KB | 63 KB | 61 KB | 51 |
| 50,000 | 1,378 KB / 2,812 KB | 30 KB | 62 KB | 59 KB | 101 |
| 50,000 heavy | 1,378 KB / 3,803 KB | 30 KB | 85 KB | 79 KB | 101 |

- **Why bullets are split too:** with each conversation kept whole in the block of its last message, a long-running conversation (up to 500 messages over many days in the model) carried all its bullets with it: summary blocks reached 124 KB at 50,000 messages, and `summary/current` 174 KB with the heavy summary (1.5× headroom). Putting a conversation's bullets in the blocks they cite brought the worst case to 85 KB (3×).
- **A build** writes the newest threading block and both `current` documents, plus a summary block when conversations are archived (once per 1,000 messages) or come back. The test builds at 6,400, 25,000 and 50,000 messages each wrote 4 documents in one batch: the newest threading block, the summary block a returning conversation left, and both `current` documents.
- **Tests:** `TestLayout` in `tests/test_catchup.py` (a fake database with the real limits) and `layouts()` in `tests/page.test.js` (the same synthetic history in both layouts renders the same text: 24,234 characters of summary and 16,686 of threads with every thread open; the old layout renders exactly as v1.16.2's page did).

## 14. Prompt budget for Ask and Views (v1.22.0, Nov 12)
- **The cap:** `sample()` refuses a prompt over `sample.limits().maxPromptBytes` (262,144 in the runtime contract), counted over every turn's content in UTF-8 bytes. Before v1.22.0, "include older" sent every stored message (about 822 KB at 7,000 messages) and failed past about 2,100 messages, as did a window of 3 or more days and Views on it.
- **Synthetic chats calibrated to the owner's page** (design experiments, mock cast): a prompt line averages 120 bytes, a conversation line 115–120, a day line 160 (17 KB for the whole history at 50,000 messages). With the summaries' share at 35% of an "include older" prompt, about 1,330 messages (about 3 days) go word for word, conversation lines reach 2–3 weeks back, and day lines reach #0 at every size up to 100,000.
- **`npm run test:perf`** (`tests/perf.js`, synth.py data with shorter lines than live; Nov 12, on the owner's laptop): a full render reads `S.msgs` about 6× per message in date-range mode and 5× in caught mode; an "include older" Ask packs in under 25 ms.

| Messages | Render, date range / caught | Ask with older: bytes | Word for word | Summary lines | `lineFor` calls | Pack and send |
|---|---|---|---|---|---|---|
| 6,400 | 63 / 13 ms | 257,304 | 2,540 | 292 | 2,541 | 16 ms |
| 25,000 | 87 / 30 ms | 257,459 | 1,942 | 674 | 1,943 | 17 ms |
| 50,000 | 100 / 45 ms | 257,441 | 1,895 | 666 | 1,896 | 24 ms |

- **Tests:** the page section `history` (H1–H16): counted reads and conversation scans per render, the cut named the same in the prompt, the note and `qa.sent`, every older message inside some summary line, day lines that count their day, the fallbacks for `limits()`, the one retry, UTF-8 not characters, turns trimmed, range summaries refused with a start that fits, and 25,000 messages packed with `lineFor` called once per line sent plus one and about 1.1 reads per message. The key cases fail on page 2.6.

## 15. Photos: capture size, a closed tab, and backfill (R2, v1.22.0, Nov 12)
- **Capture size (local, headless Chromium, M-series Mac):** a capture built as the helper builds it, copied with a real click and pasted into the real page with a real keystroke. 1 MB: paste and import 0.16 s, 0.4 GB peak memory; 20 MB: 0.32 s, 0.6 GB; 100 MB: 0.78 s, 1.3 GB; 400 MB: 2.6 s, 3.8 GB, all imported correctly. At 600 MB the helper fails (`RangeError: Invalid string length`, JavaScript's longest string, about 512 MB). The macOS clipboard itself took 200 MB in 65 ms. Not the limit.
- **A tab closed mid-upload (page 2.5):** 300 messages and 40 photos at 250 ms per upload; 4 s after the paste all messages were saved and 15 photos uploaded, 0 indexed, no `refresh/lastImport` yet. Step 5 closed the tab at 8–10 s, so those 15 were lost, and a re-paste uploaded them again. This is what R2 fixed.
- **Backfill with no helper change (helper 2.0, page 2.5):** a first run with the upload of photo #30 failing, then a scan with `STOPS` = the ids of #29, #28, #27 and `BASE` 29: a window of #30–#54, ids lining up with the stored ones, the photo included; the import added #50–#54 and stored #30 with exactly one upload; a copy whose numbering drifted was refused with nothing saved. Now sim section G and page case P18.
- **Live (owner's page, read only, Nov 12):** about 0.5 s per upload, about 54 KB per photo; 715 asset files (38.8 MB) against limits of 5,000 files and 1 GiB, growing about 55 files a day; 549 messages with photos in the old `photos/index` `byI`, so some files are copies (BACKLOG R13).
- **Block size:** 500 messages with 4 photos each at real id length is 95,919 bytes (P16a), well under 262,144.
- **Tests (page section `photos`, run against page 2.6 with `PAGE_FILE`):** every case that checks the new behavior fails on 2.6 (P1–P3, P5 except the "another import" check, P6–P14, P15c, P16a/b, P17–P20, the usage checks); P15a/b (the old index is still read) passes on both. P23 (a 26 MB capture through a real paste: 200 photos stored in about 1.3 s with the stand-in) imports on both and fails on 2.6 only for the missing `state` and `photos` fields.

## 16. Show older messages by day (F15, v1.25.0, Nov 13)
- **`npm run test:perf`** (`tests/perf.js`, synth.py data, about 460 messages a day; one headless run on the builder's machine, not the owner's laptop): turning Show older on in date-range mode (the last 2 days), threaded, then one more day loaded above. Rows are `.msg[id]` elements; `msgRow` calls include context lines and, for a step, the conversations it redraws.

| Messages | Before: rows, ms | After: rows (`msgRow`), ms | One step: rows (`msgRow`), ms |
|---|---|---|---|
| 6,400 | 6,400, 91 ms | 1,474 (1,476), 49 ms | 460 (587), 28 ms |
| 25,000 | 25,000, 379 ms | 1,674 (1,681), 37 ms | 460 (580), 30 ms |
| 50,000 | 50,000, 757 ms | 1,834 (1,859), 45 ms | 460 (685), 52 ms |

- **Tests:** the page section `olderByDay` (O1–O9) counts rows, never time; every case fails on page 2.8 except the filter check and the no-errors lines.
