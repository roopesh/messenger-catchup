# Reactions: what they mean

Read this when you write a build's `open`, `closeOpen`, `answered` and `mentions` and a message involved has reactions (`x` or `xw`), and when the user tells you a reaction means something else (Corrections, below).

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
- Reactions are read when a message is captured. One added later isn't seen.

## In the build
- **`open`:** a question that a reaction already answers isn't opened: the person it asks reacted with a yes or no reaction (from `xw`), or, without `xw`, it's addressed to the user and has one (probably answered).
- **Closing:** a reaction that answers an open question closes it: `closeOpen` with its `ask`, and an `answered` entry whose `answer` names the reaction and who ("You: 👍 (reaction)", or "probably You: 👍 (reaction)" from `x`) and whose `refs` is the asking message.
- **`mentions`:** leave out a message the user answered with their own yes or no reaction (`xw`). When the reaction is only probably theirs (`x`), keep the mention with the note "probably answered (a 👍 on it, likely yours)".
- Laughs and the "never" reactions answer nothing: the question stays open.

## Corrections: `meta/chat.reactionMeanings`
When the user says a reaction means something else (for example "🔥 means I'll take it"), write `meta/chat.reactionMeanings` `{"🔥": "I'll take it"}`: the page's own `meta/chat` (never an added chat's `meta/chat-KEY`), merged with what's there and pinned with `if_version`, the emoji without a skin tone, the meaning one short line. The page and the build both read it over the table above. A meaning that starts with yes, agree, OK or done counts as a yes answer, one that starts with no or disagree as a no, and any other only in context. Tell the user it's saved and that Ask uses it at once.
