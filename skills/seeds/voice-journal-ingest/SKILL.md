---
name: Voice journal digest
description: Fold one spoken journal entry into the brain, log the habits it mentions, and stage everything else as inbox proposals.
icon: microphone
requires: []
---

Voice journal digest. Now is {{now}}.

The owner recorded a journal entry in Totem at {{recordedAt}} ({{entryDateLong}}). The transcript is below, already saved verbatim to the brain at {{journalFile}} — do NOT copy the transcript anywhere else. Your job is to digest it: durable facts into memory, habits into the habit file, and every action item, deadline, event, and goal update staged as a CONFIRM-ONLY inbox proposal. This runs unattended a few minutes after they saved it; there is nobody to ask, so use sensible defaults and say what you assumed.

WHEN IS "TODAY". Most entries are recorded in the morning about the PREVIOUS day. Read the transcript for cues ("yesterday", "last night", "this morning", "today"). If they are clearly recapping a day, date those events {{previousDateLong}} ({{previousDate}}); things they say happened "this morning" or that they are about to do belong to {{entryDate}}. When it is genuinely ambiguous, use {{previousDate}} and note the assumption in the event line. Never invent a date more precise than what they said.

STEP 1 — read the schema. Skim the brain's AGENTS.md and index.md so you write in its formats. Search (rg) before adding a fact so nothing is duplicated.

STEP 2 — memory. Write what is worth remembering:
- events/YYYY-MM.md: one dated pipe-format line per thing they did or observed (workouts, rides, runs, people they saw, decisions, purchases, how they felt, what they worked on). Use the date from the WHEN rule above. Category vocabulary: health, habit, exercise, person, project, purchase, decision, preference, home, admin, mood.
- profile/, people/, projects/: fold in durable facts, preferences, routines, and changes (a new person, a project decision, a plan). Append to existing files; create one only for a clearly new long-lived category. Keep index.md's Fast Map and Current High-Value Facts current when a fact there changed.
- Do not store secrets. Do not record things they said they want to forget or explicitly asked you not to keep.

STEP 3 — habits. If they report doing (or skipping) a tracked habit — gym, reading, meditation, sleep score, anything in the habits file — log it directly under the correct LOCAL date using the HABITS rules in your instructions. Never invent a completion or a number they did not give. A habit they did not mention stays untouched.

STEP 4 — stage proposals (DO NOT ACT). Anything that changes the future is a proposal for them to confirm, never something you do yourself:
- Tasks they committed to ("I need to", "I should", "remind me", "tomorrow I'm going to") → `todo`. Default to local Personal tasks, which need no extra field. Only on installs that have configured venture tags, add `project: Ventures` plus exactly one `venture: <tag>` (one of the configured tags) when they clearly mean that venture. Only on installs with a shared action-items sheet, add `sync: sheet` when they explicitly said to share it with that sheet.
- Appointments, plans with people, deadlines with a time → `calendar` with `when:`.
- Progress on a goal ("rode 22 miles", "finished the second chapter", "three gym sessions this week") → `goal`. First resolve the goal with goals__find_goals / goals__get_goals so you can name the exact metric; propose `delta` for a contribution ("22 more miles") and `value` only for a total they stated outright. Never log a goal metric yourself, never complete or postpone a goal.
- Anything they said should become a GitHub issue → `github`, with the finished issue body in inbox-prompts/ as the inbox README describes.
Write them into {{inboxFile}} with the exact line formats below, continuing from the highest existing P-id, keeping every still-open line already there. Skip a proposal if an equivalent open task, event, or open proposal already exists (check tasks__get_tasks and inbox.md). If there is nothing to propose, stage nothing.

```
- [ ] P<N> | todo | <concise item> | when: <YYYY-MM-DD or none> | src: voice journal {{entryDate}}
- [ ] P<N> | calendar | <event title> | when: <YYYY-MM-DD HH:MM or date> | src: voice journal {{entryDate}}
- [ ] P<N> | goal | <what to log, e.g. "22 mi toward Ride 100 mi this month"> | goal: <goal id> | metric: <metric id or exact label> | delta: <number> | src: voice journal {{entryDate}}
- [ ] P<N> | goal | <what to set> | goal: <goal id> | metric: <metric id or exact label> | value: <number> | src: voice journal {{entryDate}}
```

STEP 5 — commit the memory repo (local git; push only if it has a remote and network is available).

STEP 6 — report. Reply with two or three plain sentences for the log, then on its own final line the exact marker JOURNAL_RESULT: followed by one JSON object:

JOURNAL_RESULT: {"title": "<3-7 word title for this entry, e.g. 'Gym, dinner out, client demo'>", "summary": "<one sentence: what the day was and what you filed>", "memory": ["events/2026-09.md", "projects/side-project.md"], "habits": ["gym", "reading"], "proposals": ["P41", "P42"], "goals": ["P42: +22 mi on Ride 100 mi"], "mood": "<one or two words if they said how they felt, else null>"}

`memory` lists every brain file you changed (relative paths). `habits` lists habit ids you logged. `proposals` lists every P-id you staged. Keep the JSON on one line and make it the last line of the reply.

TRANSCRIPT ({{#durationMin}}about {{durationMin}} min, {{/durationMin}}recorded {{recordedAt}}):

{{transcript}}
