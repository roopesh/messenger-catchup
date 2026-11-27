# Reactions: what they mean

Read this when you write a build's `open`, `closeOpen`, `answered` and `mentions` and a message involved has reactions (`x` or `xw`), when the user tells you a reaction means something else (Corrections, below), and for each refresh's scan (Late reactions, below).

This file is the one place the meanings are kept. The page's Ask uses the same table and rules: `npm run sync` copies the part between the two markers below into the page, and a test checks that they match. Change them here, never in the page.

<!-- the page's copy starts here -->
## Meanings
| Reaction | Means | As an answer |
|---|---|---|
| 👍 💯 ✅ 👌 | yes, agree, OK, done | yes |
| 👎 | no, disagree | no |
| ❤️ 😍 | like it, warm thanks; on an item for sale: interest, not a claim | only in context |
| 🔥 | strong approval, "want" | yes |
| 🙏 | thanks | only in context |
| 😂 😆 🤣 | funny | never |
| 😮 😯 | surprised | never |
| 😢 | sympathy | never |
| 😡 | annoyed, objects | no |
| 👀 | interested, watching | never |
| 🤔 | unsure | never |

Skin-tone variants (👍🏽) count as the base emoji. An emoji that isn't in the table is read in context, and never as an answer on its own.

## Reading them in context
- A reaction answers the message it's on, never a later one.
- Your 👍 on a yes/no question to you means yes; on a plan or a time, agreed.
- A reaction on an offer (an item for sale, a spot) is interest, not a claim.
- The asker's 👍 on an answer closes their question; a bystander's doesn't.
- A laugh never closes a question.
- Several 👍 on a proposal: the group agrees.
- A reaction from You on a message addressed to you (a reply to you, or one that names you) counts as your answer.
<!-- the page's copy ends here -->

## Who reacted
- `xw` (helper 4.0 and later): who reacted with what, read from Messenger's "see who reacted" list, for example `[["You","👍🏽"],["Ben Brooks","😂"]]`. "You" is the user. The helper reads it only for the new messages that reply to you, name you (the `me` names given to `full`) or end with "?", at most 30 a run. When it's there, who reacted decides.
- Without `xw` (an older helper, a message the helper didn't choose, the cap reached), `x` has only the count and the emoji ("1 👍🏽"). On a message that asks or names the user (a reply to "You", or one of `ownerAliases`), an answering reaction (yes or no above) is probably theirs: treat the question as probably answered and say "probably" wherever you write it. On any other message, don't guess whose it is.
- Reactions are read when a message is captured, and again by each refresh's recheck (helper 4.1; Late reactions, below), which the page stores in place.

## In the build
- **`open`:** a question that a reaction already answers isn't opened: the person it asks reacted with a yes or no reaction (from `xw`), or, without `xw`, it's addressed to the user and has one (probably answered).
- **Closing:** a reaction that answers an open question closes it: `closeOpen` with its `ask`, and an `answered` entry whose `answer` names the reaction and who ("You: 👍 (reaction)", or "probably You: 👍 (reaction)" from `x`) and whose `refs` is the asking message.
- **`mentions`:** leave out a message the user answered with their own yes or no reaction (`xw`). When the reaction is only probably theirs (`x`), keep the mention with the note "probably answered (a 👍 on it, likely yours)".
- Laughs and the "never" reactions answer nothing: the question stays open.

## Late reactions (B69, helper 4.1)
A reaction often comes after the message was stored: the user reads a question on the page and answers it with a 👍 in Messenger. So each refresh reads reactions again on stored messages, and the page updates them in place.
- **Before the scan:** run `catchup.py recheck WORK --last=LASTI --caught=CAUGHTUPI --from=LASTFROMI --sum=RXSUM` with `meta/chat`'s `lastI`, `caughtUpI`, `lastFromI` and `rxSum` (for an added chat its `meta/chat-KEY`, and `--chat=KEY`; leave out a flag whose field is unset). It prints one JSON object, `{rxBack, rxIds, rxSum}`: add its keys to `full`'s args as they are. `rxBack` reaches back to the last Mark caught up (else to where the last refresh's messages start); `rxIds` are the open questions and Needs you messages of the last 3 days.
- **What the helper does:** after the new messages it goes on up through the `rxBack` stored messages, newest first, reading their reactions as it reads new ones (at most 400 messages and 60 s, `rxMax` and `rxMs`), then finds each `rxIds` message by its id and reads who reacted (`xw`), as `jump` finds one, without Reply (at most 20 and 45 s, `rxIdMax` and `rxIdMs`). The scan result's `rx` says how far it got: `{back, read, cap, ms, n, sum, same, ids:{want, read, none, noopen, empty, notfound, cap}}`. `cap` is `""` when it read all `rxBack`, else why it stopped: `max` (more than 400 asked: the newest 400 read), `time`, `stalled` or `top`. Put a `cap`, and `ids.notfound` or `ids.cap`, in the report in one line ("reactions rechecked on the newest 400 of 950 stored since the marker"); the older ones keep what's stored.
- **The capture** carries them by Messenger id (`rx`: `references/database.md`, Reactions in `chunks/*`), and the import toast adds "Reactions changed on n stored messages (#a, #b; chunks …)" or "Reactions on n stored messages: no changes". Step 5 then gets those chunks too (they're in the toast).
- **Nothing new** (`win:0`): when the reactions differ from the last ones the page stored (`rxSum`), `full` captures them alone, with no reload or verify: `stage:"captured"`, `rxOnly:true`, `capture` "count 0 …". Paste it as in step 4. If the toast names changed messages, `get` their chunks and read them; for an open question one answers (below), `list threading` and `list summary` (limit 1000) into a fresh RUN and run `catchup.py relink WORK RUN spec.json` with `{"closeOpen":[ask], "answered":[...]}`, then write what its manifest lists as in step 7. Otherwise go on as for nothing new. `same:true` (nothing changed) captures nothing.
- **In the build:** for each message the toast says changed, apply the rules above as if it were new: close an open question it answers (`closeOpen`, `answered`), and note in the report what changed. `catchup.py build` prints `RX i (…) reactions changed: …` for a changed message that is still an open question after your spec: if a reaction answers it, `restore` and build again with it closed. A mention stays (summary items are never removed); its message shows the reaction on the page.
- An older helper (before 4.1) ignores these args and reads no reactions again.

## Corrections: `meta/chat.reactionMeanings`
When the user says a reaction means something else (for example "🔥 means I'll take it"), write `meta/chat.reactionMeanings` `{"🔥": "I'll take it"}`: the page's own `meta/chat` (never an added chat's `meta/chat-KEY`), merged with what's there and pinned with `if_version`, the emoji without a skin tone, the meaning one short line. The page and the build both read it over the table above. A meaning that starts with yes, agree, OK or done counts as a yes answer, one that starts with no or disagree as a no, and any other only in context. Tell the user it's saved and that Ask uses it at once.
