---
name: reply-check
description: "A frequent, scheduled check of a Messenger Catch-up page for queued replies: one small database read, and only when a reply is waiting does it hand over to messenger-catchup:replies. Use only for \"check replies\", \"reply check\" or a message starting \"Scheduled reply check\"."
---

# Messenger Catch-up: reply check

Runs often, so it does as little as it can: one read, and nothing else unless a reply is waiting.

1. **The page:** the URL in the message, else the one this conversation uses, else `Artifact list`: the artifact titled "… Catch-up" whose `meta/chat` has `kind:"messenger-catchup"` (none or several: say so and stop).
2. **One read:** `ArtifactData query outbox` with `where` `["state","==","queued"]` and `limit` 1. None: say "No replies waiting." and stop. That read is the whole run: no other read, file, browser or schedule.
3. **A reply is waiting:** follow `messenger-catchup:replies` on that page now. It checks approval and the run lock, posts and reports. This skill never posts by itself.
