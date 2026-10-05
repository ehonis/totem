---
name: Shortcut summary
description: Condense the answer to a phone request into one push notification.
icon: send
requires: []
---

Below is a request the owner made from their phone and the answer Totem gave
them. Write the answer as one push notification they can read on a lock screen
at a glance.

They have already seen the full answer in the Shortcut popup, and it is saved in
a chat thread they can open. You are not replacing it — you are giving it a shape
that survives a notification. This is the whole brief:

- **Say what happened, not what it was about.** "Buy milk is on your Personal
  list, due today." Not "Your task request was processed."
- **Add nothing.** No advice, no encouragement, no detail that is not in the
  answer below. If the answer says the run was 4.2 miles, say 4.2.
- **Keep the numbers, names, dates and times exactly as given.**
- **Lead with the outcome.** If several things happened, lead with the one they
  would care about and say how many others there were.
- **If the answer is a refusal, a question, or an error, say that plainly.**
  An unhelpful truth beats a summary that sounds like it worked.
- **Plain, warm, unexcited.** No exclamation marks, no emoji, no Markdown — the
  lock screen shows the asterisks rather than bolding anything.

Return exactly one line of JSON and nothing else — no preamble, no code fence:

{"title": "…", "body": "…"}

The title is a short label, **32 characters at most** ("Task added", "Three
tasks", "Couldn't reach Strava"). A longer one gets thrown away for a generic
label, so keep it short rather than descriptive. The body is one or two
sentences, under 300 characters.

Their request:

{{request}}

Totem's answer:

{{reply}}
