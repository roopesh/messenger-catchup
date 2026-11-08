# Database (ArtifactData on the user's page)

The full reference. SKILL.md lists what a refresh needs.

- `meta/chat`: `kind:"messenger-catchup"`, `pageVersion`, `thread` (Messenger thread id), `chatUrl` (full chat URL), `threadName`, `shortName`, `ownerName`, `ownerAliases` (names others call them), `topic`, `outboxAuto`, `refreshPhrase`, `tz` (IANA), `helper` ("installed" | "inject"), `chunkSize:82`, `lastI`, `lastMid`, `lastT`, `anchorMids` (newest 3 ids; reversed = STOPS), `caughtUpI`, `caughtUpAt`, `ownLastI`, `ownLastMid`, `markerMode` (`caught` | `own` | `time`), `markerSetAt`, `markerFrom`, `markerTo`, `lastRefresh`, `coverage`, `schedule`, `ideasSeenAt`, `aliasesAskedAt` (when the user was asked which aliases count; `references/people.md`). The page writes `lastI` … `ownLastMid` when it imports, and the marker fields when the user picks a catch-up start; Claude writes the rest.
- `chunks/cNNNN` `{start, msgs:[...]}`: message fields `i` (number from 0), `t` ("Fri 8:41 AM"), `d` (date), `f` (sender as Messenger shows them: nickname or first name; the user = "You"), `fn` (full name from their avatar; helper 1.6+), `b` (text), `m` (Messenger id), `r` (replied-to name), `q` (quoted text), `pi`/`pmid`/`pq`/`perr` (reply parent), `p` (photo), `a` (link preview), `l` (links), `x` (reactions).
- `threading/current`: `convs:[{id,title,members}]`, `links:{i:[parent,type]}` (r = Messenger link, rq = matched by quote, rg = photo reply best match, i = answers, c = same person continuing), `to`, `note`, `builtAt`.
- `summary/current`: `version:2`, `convs:[{id,tag,synopsis:[{t,refs}],outcome,key}]`, `open`, `answered`, `deals`, `mentions`, `toI`, `generatedAt` (optional `mentionsNote`).
- `people/index` `{people:{"<full name>":{shown:[...],firstI,lastI}},scannedAt}`: written by the page from `fn`.
- `photos/index` `{byI,byK,gifs}`, `refresh/status` (lock and status line), `refresh/lastImport`, `refresh/importLock` (the page's import lease; never write it), `outbox/*` (replies queued on the page).
- Written by the page: `qa/*` `{q,a,at,scope,toI}` (questions asked on the page's Ask tab), `views/*` (`kind:"view"`: a view the user built; `kind:"idea"`: a method idea left for Claude, `{prompt,at}`), `rangeSummaries/*` (summaries the page wrote for a past span). Written by Claude: `notes/*` `{title, when, at, intro?, table?:{cols,rows}, sections?:[{h,items:[{b?,t}]}], footer?}` (see What the page saves for Claude).

## What the page saves for Claude
The page promises the user that Claude sees these, so act on them. (Method ideas are checked after every refresh: SKILL.md › Method ideas.)
- **Questions asked on the page** (`qa`): when the user refers to something they asked on the page, read `qa` (newest first) for context.
- **Notes from Claude** (`notes`): when the user asks how the page or a refresh works, or for an analysis worth keeping, answer in chat and also save it as `notes/<short-id>` (shape above). It appears under Views › Notes from Claude.
