---
name: reply-check
description: "Checks a Messenger Catch-up page for queued replies, often and cheaply: one database read plus one per active chat; a waiting reply goes to messenger-catchup:replies. Use only for \"check replies\", \"reply check\" or a message starting \"Scheduled reply check\". Scheduling them (\"schedule reply checks\", \"check replies every 10 minutes\") is messenger-catchup:setup."
---

# Messenger Catch-up: reply check

Runs often: 1 read plus one per active chat.

A message starting "Scheduled reply check" (setup's recurring task): the same steps; never ask the user anything.

1. **The page:** the URL in the message, else the one this conversation uses, else `Artifact list`: the artifact titled "… Catch-up" whose `meta/chat` has `kind:"messenger-catchup"` (none or several: say so and stop).
2. **Reads:** `ArtifactData get meta/chat`, then for each chat in `chats` whose `state` is `active` (no `chats`: the one chat), `ArtifactData query` its outbox with `where` `["state","==","queued"]` and `limit` 1: the first chat's (`home:true`) is `outbox`, an added chat KEY's `KEY_outbox`. None anywhere: say "No replies waiting." and stop. These reads (1 plus one per active chat) are the run: no other read, file, browser or schedule.
3. **Replies waiting:** follow `messenger-catchup:replies` on that page, for only the chats with a waiting row. It checks approval and the lock, and posts in each chat's thread. This skill never posts by itself.
