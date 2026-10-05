---
name: Journal ingest
description: Mine last night's Plaud recording into the brain and propose action items.
icon: moon
command: $journal
requires: [plaud]
---

Nightly journal ingest. Now is {{now}}.

GOAL: turn the owner's spoken nightly journal / daily debrief into durable intelligence in their brain, and stage confirm-able action items. This runs unattended before their morning briefing.

STEP 1 — find new recordings. Use the Plaud MCP list_files{{#sinceDate}} with date_from "{{sinceDate}}"{{/sinceDate}}{{^sinceDate}} (most recent first){{/sinceDate}}. Consider only recordings created{{#since}} strictly after {{since}} (Plaud's date filter is whole-day, so re-check exact created_at and ignore anything at or before that instant){{/since}}{{^since}} in roughly the last 24 hours{{/since}}. If there are none, reply exactly "NO_NEW_RECORDINGS" and stop.

STEP 2 — keep only the journal/debrief. For each new recording decide if it is the owner's personal nightly journal/debrief versus a meeting or call. Journal signals: title cues (journal, debrief, recap, diary, "end of day", EOD); a single dominant speaker (the owner) for essentially the whole recording; first-person reflection on their day ("today I...", "I worked on...", "I feel..."). Meeting signals: multiple distinct speakers, meeting-style titles, agenda/discussion. Pull the transcript (get_transcript) to check speakers when the title is ambiguous. IGNORE meetings and calls entirely. If none of the new recordings is a journal/debrief, reply exactly "NO_JOURNAL" and stop (it is normal for the owner to skip nights — never fabricate one).

STEP 3 — update the brain. For each journal recording, read its note (get_note) and transcript as needed, then write to the memory repo following its AGENTS.md/index.md schema: append what they did and observations to events/YYYY-MM.md (the dated pipe format), and fold durable facts, preferences, routines, people, or project decisions into profile/, people/, and projects/ files. Be factual; do not duplicate facts already present. Do not store secrets.

STEP 4 — stage proposals (DO NOT ACT). Collect concrete action items, commitments, deadlines, and calendar-worthy events they mentioned. Write them as a checklist in {{inboxFile}}, keeping any still-open ("- [ ]") proposals already there and removing ones already checked off ("- [x]"). Use this exact line format with stable sequential ids:
- [ ] P<N> | <todo|calendar> | <concise item> | when: <date/time or none> | src: <recording name/date>
Number ids continuing from the highest existing P-id. Todo proposals default to local Personal tasks; leave out `project:` for those. Only on installs that have configured venture tags, add `project: Ventures` plus exactly one `venture: <tag>` (one of the configured tags) when the journal clearly identifies that venture. Only on installs with a shared action-items sheet, add `sync: sheet` when the owner explicitly said the item should be shared/synced to that sheet; classification alone never implies sharing. Do NOT create any Totem tasks or Calendar events yourself — these are for the owner to confirm in the morning. If there are no action items, leave the proposals section empty.

STEP 5 — commit and push the memory repo if it has a remote and network is available.

Reply with a brief plain-text summary: which journal recording(s) you ingested, what you added to the brain, and how many proposals you staged. This summary is logged, not shown to the owner live.
