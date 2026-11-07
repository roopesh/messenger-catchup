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

## 7. Generic skill validation (Nov 6)
| Test | Result |
|---|---|
| Simulated Messenger thread (`tests/sim.js`): first run, incremental runs, mid-run arrivals, photo replies, short chat, older date labels, stale results, jump links, with and without the helper | 35/35 pass |
| Pipeline replay: capture → page import → `cctool build` | 3 imports, 3 builds OK |
| Live sandbox page, first run, no helper | OK |
| Live switch: refreshes 244 (injected v1.1) and 245 (old v2.2 helper) | Both done, no errors |
| Old vs new page, rendered side by side | Title, header, summary and messages identical; only the "Refreshing" text and jump tag differ |
| Independent cold review of the skill | 12 issues raised; addressed in v1.1 (per-issue log not kept) |

## 8. Outbox posting
- **Method:** insert the text into Messenger's Lexical editor with `execCommand('insertText')`, check that the box text equals the stored text and that "Replying to …" is shown, press Enter, then check for a new "You:" message.
- **Finding:** `execCommand('delete')` does not clear the editor. Clear it with a click, then select all, then Delete.
