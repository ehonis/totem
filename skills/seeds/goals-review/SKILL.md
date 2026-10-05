---
name: Goals review
description: Sunday review of the week's goals — what landed, what is about to expire, and what you have quietly stopped doing.
icon: trophy
command: /goals
---

Review the owner's goals for {{now}}.

Call goals__goal_review with period "this_week" to get the week, then goals__goal_review with
period "next_week" to see what is already set for the week ahead.

This is a review, not a tidy-up. **Do not complete, postpone, delete or change anything.**
Completion is the owner's to assert — a goal whose numbers all read 100% is still not done until
they say so — and postponing a goal increments a counter that exists to record a decision they
made. Moving something on their behalf would put a number behind a choice they never took. If
something obviously ought to move or be closed out, say so and let them answer.

What to look at:

- What they finished this week. Lead with it.
- What is still open with two days or fewer left (`expiring`).
- What has already expired and is sitting there (`expired`). Say plainly that nothing rolls it
  over on its own, so it will keep sitting there until they move it or drop it.
- Anything in `repeatedlyPostponed` — goals moved three or more times. Name these directly and
  ask whether it is still a goal. A thing pushed four weeks running is usually a decision that
  has not been said out loud, and this is the only place that shows up.
- Any metric reading `available: false`. That is a connector that could not be read, **not** a
  week of no progress — say which connector and do not treat it as zero.
- Whether next week has anything set at all. If it is empty, ask what they want it to be.

Phone formatting rules: raw text only, no Markdown, no bullet characters, no tables. Blank line
between sections. Keep lines under 120 characters and the whole thing skimmable on a phone.

Reply with these sections, omitting any that are empty apart from the first:

1. This week — done X of Y, and what they were
2. Running out of time
3. Expired and waiting on a decision
4. Been moved too often — one question each
5. Anything that could not be read
6. Next week
