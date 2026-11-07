# Decisions

Each entry has what was decided, why, and what was rejected.

## Storage and page
| Decision | Why | Rejected |
|---|---|---|
| Store everything in the claude.ai artifact's own DB | Private to the user, no server to run, readable by Claude and the page | Google Sheet; a standalone stack (considered, not built) |
| Chunks of 82 messages (`chunks/cNNNN`) | Keeps each doc small; appends touch one or two chunks | One big doc |
| Every write pinned with `if_version` | Two refreshes, or the page and Claude, can't overwrite each other | Blind writes |
| Settings live in `meta/chat`, not in the skill | One skill serves any user and any chat | Hard-coded chat URL and names (the original skill) |
| Keep full history; the summary covers only messages after the start point | Old context stays searchable; the summary stays short | Pruning old messages |

## Reading Messenger
| Decision | Why | Rejected |
|---|---|---|
| Read in the user's real Chrome (Claude in Chrome) | Uses the user's own Facebook sign-in; nothing to set up | The built-in app browser; any Facebook API |
| Messenger is read-only, except allowed clicks | Safety; the user's account | Typing or sending anything not queued by the user |
| Two passes: scan, then reload and verify by ID | Fast scrolling once skipped 19 messages; verify catches gaps | A single pass |
| No catch-up round for late arrivals | Saves up to 2 × 30 s per run; the next hourly run gets them | Up to 2 extra rounds (used Nov 1–5) |
| Don't take over the Messenger tab when it's open on another chat | The user is using it | Navigating it away |

## Moving data
| Decision | Why | Rejected |
|---|---|---|
| Clipboard → paste into the page | The only bridge that doesn't put chat text in a URL; the page checks checksum, overlap and gaps | Claude retyping captures (slow, error-prone); URL hand-off |
| Photos travel inside the paste as original files | Byte-identical, and smaller than screenshot crops | Screenshot, crop, re-upload |
| Import outcome written to `refresh/lastImport` | Claude confirms the import without a screenshot | Reading the toast from a screenshot |

## Threading
| Decision | Why | Rejected |
|---|---|---|
| Messenger's own reply link first (`r`) | Ground truth | — |
| Text replies matched by quote (`rq`): same author + first 20 normalized characters, emoji stripped, latest wins | 348/348 correct; no clicking | Full-text match; clicking every reply |
| Photo replies are clicked or verified (`rg`) | Quotes are empty, and a "latest photo" guess was wrong once | Guessing from the author's latest photo |
| Non-replies are linked by Claude's judgment (`i` answers, `c` continues), and `catchup.py` flags GUESS lines for review | Every scorer tried scored worse than this on hand labels | Shipping the context linker or the continuation rule |
| Fix "loose" messages through display (`convTree`) | The links were mostly right; the page hid them | More link heuristics |
| Big threads are split into focused sub-conversations | Easier to scan | One card per long thread |

## Summary
| Decision | Why |
|---|---|
| One card per conversation; open, deal and answered call-outs inside the card | The old summary tab repeated the thread |
| Bullets ≤ 15 words, outcome ≤ 12, enforced by `catchup.py` | The user hates walls of text |
| Open-question notes add context, never paraphrase the question | Avoids repetition |
| Every message in exactly one conversation; links point backward (asserted) | Nothing is lost or double-counted |

## Helper userscript
| Decision | Why | Rejected |
|---|---|---|
| Optional but recommended | Works without it (Claude injects the same code each run) but is faster, and jump links land exactly | Required install |
| Event bridge plus `sessionStorage` results; start, then poll in calls ≤ 25 s | The tool's JS call times out at 45 s | One long call |
| Generic helper uses new names (`mc-*`) | Can run beside the old `cc-*` helper without clashing | Reusing the old names |

## Outbox (posting replies)
| Decision | Why |
|---|---|
| A reply queued with "Reply here" on the private page is the user's authorization to post it | The page is only accessible to the user; they asked not to re-confirm in chat |
| Post exactly the stored text, then verify "Replying to …" and the new "You:" message | No paraphrase; proof it landed |
| Generic skill: auto-posting is a setup choice (`outboxAuto`); otherwise confirm each one in chat | Other users may want the extra check |

## Scheduling
| Decision | Why |
|---|---|
| Hourly by default | Small backlogs are fast (3 messages ≈ 2 min vs 183 ≈ 17 min) |
| Claude creates and owns the schedule; the skill walks new users through it | The user doesn't want to manage scheduled tasks |
| Two options in the skill: an in-session loop, or a scheduled task that requires the local computer | Refreshes need the computer awake with Chrome open |
| A missed run is skipped; the next run catches up | No pile-up |

## Seen in the code, not written down before
Recorded during the Nov 6 handoff review. The reasons are inferred from the code and earlier docs.

| Decision | Why (inferred) | Where |
|---|---|---|
| The page, not Claude, writes chunks and the import counters in `meta/chat` | The paste lands in the page; the page checks and writes in one place, then Claude reads back | `page.html` `importCore` |
| A first import must start at `#0`; later imports must overlap or continue exactly at `lastI+1` | Numbering is the integrity check; any gap is refused | `importCore` |
| Chunks are read back and compared after writing | Proof the write landed before `meta/chat` moves forward | `importCore` |
| Messages that arrive during a run (`extra`) are left for the next run | Keeps scan and verify windows identical; no extra round | `mcVerify`, SKILL step 3 |
| The page carries its own copy of the helper and a bookmarklet | Install by copy and paste from the page, including on a computer without the repo | `#jump-us`, `#jump-bm` |
| The generic page has no in-page Refresh button | It needs a scheduled-trigger id and a connector the generic setup doesn't create; refreshes are asked for in chat | `REFRESH_TASK="__TRIGGER_ID__"`, button `hidden` |
| Dates are stored per message (`d`) instead of deriving them from weekday names | Weekday labels are ambiguous past a week; the old `meta.dates` map is only a fallback | `mcCapture`, `tsOf` |

## Sharing and repo
| Decision | Why |
|---|---|
| A generic skill instead of a second user-specific one | One codebase; the original user switched to it too |
| Shared as a ZIP upload | The skill Share button only works inside Team/Enterprise orgs |
| Private GitHub repo `messenger-catchup` | Source of record; `make-zip.sh` builds the upload |
