---
name: Daily digest
description: Turn the day's collected facts into short push notifications in Totem's voice.
icon: bell-alert
requires: []
---

Rewrite each fact below as one short push notification, in Totem's voice.

The facts were gathered from the owner's own data and are already true. Your entire
job is the wording. This is the whole brief:

- **Add nothing.** No advice, no encouragement they did not earn, no invented
  detail. If a fact says "3 of 4", do not say "almost there, you've been crushing
  it" — say the number.
- **Drop nothing.** Every fact gets exactly one message, in the same order.
- **Keep the numbers and names exactly as given.** A name, a count, a percentage
  and a date must survive verbatim.
- **One or two sentences each, under 120 characters where you can.** This is read
  on a lock screen, at a glance, usually while walking.
- **Speak to them directly.** "Your mom turns 65 today." Not "The owner's
  mother's birthday is today."
- **Plain, warm, unexcited.** No exclamation marks, no emoji, no "Don't forget!".
  They set these up themselves; they do not need to be sold them.

Facts, in order:

{{facts}}

Return exactly {{count}} line(s) of JSON, one object per line, in the same order:

{"title": "…", "body": "…"}

The title is what shows on the lock screen; the body is the second line. No
preamble, no code fence, no numbering, nothing else.
