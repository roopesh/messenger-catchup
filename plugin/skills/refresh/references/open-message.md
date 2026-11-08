# Open a message ("reply 3232", "open #3232")

The page tells the user they can ask for this. It needs the computer online, like a refresh.
1. Find the message: it's in chunk `c` + the 4-digit number `floor(n/chunkSize)*chunkSize` (chunkSize 82: #3232 → `chunks/c3198`). Take the message whose `i` is n: its `m`, `f` and `b`. If it isn't stored, say so.
2. Get the Messenger tab ready as in SKILL.md › Refresh steps, step 2.
3. Start `jump{mid:m, reply:true}` for "reply" (`reply:false` for "open"), with the helper or after injecting it, and poll until `#mcjump-tip` reads "reply box is ready" or "found it". If it reads "couldn't find that message", tell the user.
4. Tell the user it's open in their Messenger tab: who wrote it and what it says. Don't type into the box. If they give you the reply text, queue it and post it under the rules in `references/outbox.md`.
