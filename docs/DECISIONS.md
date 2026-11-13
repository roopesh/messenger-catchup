# Decisions

Each entry has what was decided, why, and what was rejected.

## Storage and page
| Decision | Why | Rejected |
|---|---|---|
| Store everything in the claude.ai artifact's own DB | Private to the user, no server to run, readable by Claude and the page | Google Sheet; a standalone stack (considered, not built) |
| Chunks of 82 messages (`chunks/cNNNN`) | Keeps each doc small; appends touch one or two chunks | One big doc |
| Every write to an existing document pinned with `if_version` (new block documents have none) | Two refreshes, or the page and Claude, can't overwrite each other | Blind writes |
| Threading and summary are collections of 1,000-message block documents, named by `current` (v1.17.0, B43) | A document holds at most 256 KiB; the owner's single documents reached 185 KB and 249 KB, growing about 20 KB a day each. Splitting by message number bounds every document, whatever the conversations look like (a conversation's bullets split by block too) | A rolling window that drops old summaries (what sessions improvised, losing them); a document per conversation (thousands of tiny documents, and a long conversation still grows); larger blocks (summary blocks reached 124 KB at 2,000 messages before bullets were split) |
| A block's id carries a hash of its content; a changed block is a new document, deleted after `current` stops naming it | A run that stops partway, or a batch the tool applies one write at a time, never changes what the page reads; a retry finds what it already wrote; only the two `current` documents need pins | Updating blocks in place (every block write needs a pin, and an interrupted move of a conversation between documents could lose it) |
| `summary.fromI` is kept, never moved | It records which summaries earlier sessions dropped; the page offers range summaries before it | Removing it (the page would show the dropped stretch as summarized) |
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
| Decision | Why | Rejected |
|---|---|---|
| Hourly by default | Small backlogs are fast (3 messages ≈ 2 min vs 183 ≈ 17 min) | |
| Claude creates and owns the schedule; the skill walks new users through it | The user doesn't want to manage scheduled tasks | |
| A ladder (v1.21.0, R6): a one-time follow-up into this conversation (the chain); otherwise a recurring task tied to this computer; otherwise manual | Refreshes need the computer awake with Chrome open. A chain runs where Claude in Chrome already works; a device-bound task gets paused after one run on a sleeping computer, so it's second | Two fixed options naming `send_later` and `create_trigger` (pre-1.21) |
| Scheduling tools are named only in the refresh skill's `references/scheduling.md`, each by what it does, and Claude uses only a tool it can see (v1.21.0) | The names are undocumented, differ by app and change; one file to update, and a renamed tool can still be recognized by what it does | Names in SKILL.md; probing for tools by calling them |
| Keep a recurring task only if the tool's result confirms it's tied to this computer; otherwise disable it and the user creates it in the app with "Require this computer" on (owner's call, Nov 12) | A task that comes back "cloud only" can't reach Chrome and would fail every run without telling anyone | Only "create it yourself in the app"; dropping recurring tasks (chain or manual only) |
| Each follow-up carries an `armId`; only the one matching `refresh/schedule.armId` continues, and arming writes the new id with `if_version` before calling the tool (v1.21.0) | Only ever one chain: duplicate deliveries, late fires, superseded chains and stopped schedules all find a stale id and stop | Checking the app's list of scheduled tasks (fired one-shots can keep a future run time; the listing differs by app or is missing) |
| Live state in its own document, `refresh/schedule`; the user's choice stays in `meta/chat.schedule` (v1.21.0) | Arming must not bump `meta/chat`'s version under a running build's pinned writes | `meta/chat.schedule.nextAt` |
| A refresh the user asked for that finds the chain dead (more than 30 minutes past `nextAt`, inside the chosen hours) asks before restarting it from that conversation; a scheduled run never asks (owner's call, Nov 12) | The user chooses which conversation the chain lives in. A scheduled run that is running is itself proof the chain is alive | Restarting silently and saying so (the design's recommendation); only reporting it |
| No backoff: runs that can't reach Chrome keep the chosen interval; `misses` and `problem` are recorded and reported by the next refresh the user asks for (owner's call, Nov 12) | Catch up as soon as the computer is back | Doubling the delay per miss up to 4 hours (the design's recommendation); stopping after a day of misses |
| A follow-up is armed `every` minus 5 minutes after a run (v1.21.0) | A user report measured most of a 60-minute chain's cost in prompt-cache rewrites when wakes landed just after the cache expired | Exactly `every` |
| The Claude Code CLI is a supported surface: one-time `CronCreate` follow-ups, with a warning that the session must stay open (owner's call, Nov 12) | The CLI has Claude in Chrome, and it costs one line | Manual only in the CLI |
| `mode` `"A"`, `"loop"` or any unknown value is an old-style chain, converted to `"chain"` the first time the new procedure arms (owner's call, Nov 12) | No re-setup; the owner's own `"loop"` keeps working | A bulk migration; asking users to set up again |
| The page's Desktop requirement waits for the next page change (R10); the setup skill and README say it now (owner's call, Nov 12) | One sentence isn't worth republishing every page | `PAGE_VERSION` 2.6 now |
| A missed run is skipped; the next run catches up | No pile-up | |

## Seen in the code, not written down before
Recorded during the Nov 6 handoff review. The reasons are inferred from the code and earlier docs.

| Decision | Why (inferred) | Where |
|---|---|---|
| The page, not Claude, writes chunks and the import counters in `meta/chat` | The paste lands in the page; the page checks and writes in one place, then Claude reads back | `page.html` `importCore` |
| A first import must start at `#0`; later imports must overlap or continue exactly at `lastI+1` | Numbering is the integrity check; any gap is refused | `importCore` |
| Chunks are read back and compared after writing | Proof the write landed before `meta/chat` moves forward | `importCore` |
| Messages that arrive during a run (`extra`) are left for the next run | Keeps scan and verify windows identical; no extra round | `mcVerify`, SKILL step 3 |
| The page carries its own copy of the helper and a bookmarklet | Install by copy and paste from the page, including on a computer without the repo | `#jump-us`, `#jump-bm`. **Superseded in v1.8.0:** the userscript installs from the GitHub release and updates itself; only the bookmarklet stays on the page |
| The generic page has no in-page Refresh button | It needs a scheduled-trigger id and a connector the generic setup doesn't create; refreshes are asked for in chat | `REFRESH_TASK="__TRIGGER_ID__"`, button `hidden` |
| Dates are stored per message (`d`) instead of deriving them from weekday names | Weekday labels are ambiguous past a week; the old `meta.dates` map is only a fallback | `mcCapture`, `tsOf` |

## Sharing and repo
| Decision | Why |
|---|---|
| A generic skill instead of a second user-specific one | One codebase; the original user switched to it too |
| Shared as a ZIP upload | The skill Share button only works inside Team/Enterprise orgs |
| Private GitHub repo `messenger-catchup` | Source of record; `make-zip.sh` builds the upload |
| Every change via PR, versioned, squash-merged, tagged and released (from v1.1.1) | The owner's rule: a reviewable record of every change and a downloadable ZIP per version |
| One release version (`VERSION`, semver) for the whole skill; `PAGE_VERSION` and the helper version stay separate | Component versions trigger republish or reinstall for users, so they move only when that part changes |
| The userscript installs from `releases/latest/download/helper.user.js` and updates itself (v1.8.0) | No more "reinstall the userscript" on every helper change; the page loses a 30 KB embedded copy | Owner accepted the trust trade-off: whoever controls the repo's releases controls code on facebook.com. Releases come from `tools/release.sh` on protected `main` |
| Component minor versions stay one digit (1.9 → 2.0) | Read as decimals, `1.1` = `1.10`. The live page was at 1.1, so `PAGE_VERSION` 1.10 could have skipped its republish | Test-enforced |
| `SKILL.md` holds only what every refresh needs; the rest lives in `references/*.md` read on demand (v1.9.0) | Claude reads `SKILL.md` on every run, hourly with the loop. Cutting 31.8 KB to 19.4 KB saves about 3k tokens per refresh, more than all page-size costs combined | Text moved verbatim (checked line by line). The outbox rules, the only part that posts, are read in full before any row is handled. Hard rules stay in `SKILL.md` |
| Full names come from each sender's avatar alt text; `f` stays the name Messenger shows (v1.10.0) | Messenger prints only nicknames or first names. The avatar is the one place a full name appears on every message. Replies and the outbox must match what Messenger shows | Display rule set by the owner: first name, full name when a first name is shared, "nickname (name)". Names stay in each user's database (`people/index`, `fn`), never in the repo |
