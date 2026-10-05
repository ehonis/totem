---
name: Plaud action items ingest
description: Mine recent Plaud meetings for action items assigned to you and stage them as confirm-only inbox proposals.
icon: inbox
command: $plaud-meetings
requires: [plaud]
---

Plaud meeting action-item ingest. Now is {{now}}.

GOAL: scan recent Plaud meeting recordings for action items explicitly assigned to the owner and stage them as confirm-only Totem task proposals. This runs unattended when scheduled or on demand; the owner confirms items later in the Inbox tab. Do not turn general backlog ideas or discussion points into the owner's tasks unless the meeting explicitly assigned them to the owner.

STATE FILE (read first, update last): {{stateFile}}
Already-processed Plaud file_ids — do NOT re-read these meetings:
{{processedSummary}}

STEP 1 — find candidate recordings. Use Plaud MCP list_files for the last 14 days (most recent first). Skip every file_id listed in the state file above.

STEP 2 — keep only meetings. INCLUDE a recording when it is a meeting or call: multiple distinct speakers, a meeting-style title, or an agenda or discussion structure. EXCLUDE journals and debriefs (a single speaker reflecting on their own day), podcasts, lectures, and one-sided notes with no meeting structure.

STEP 3 — extract only action items assigned to the owner. Read get_note and use get_transcript when ownership is unclear. Keep an item only when the owner is explicitly named as the person responsible or the assignee, or the owner clearly took it on themselves ("I'll send that over"). Skip items assigned to someone else and skip unassigned brainstorming/backlog ideas.

STEP 4 — deduplicate before staging. Read the full {{inboxFile}} first. Do not create a proposal when any open or resolved line already covers the same work. Match on source meeting plus similar title. Allocate new sequential P-ids after the highest existing number.

STEP 5 — stage proposals; do not act. Append one `- [ ]` line per new item under a dated section header in {{inboxFile}}:
- [ ] P<N> | todo | <concise action item> | when: YYYY-MM-DD | src: <meeting title YYYY-MM-DD>
Each line becomes a local Personal task when the owner accepts it. Do not add `project:`, `venture:` or `sync:` fields; those are only for installs that have configured venture tags or a shared action-items sheet, and they use a personalised version of this skill. Use an explicit YYYY-MM-DD date when the meeting set a deadline; otherwise write `when: none`. Do not create Totem tasks, sheet rows, GitHub issues, or Calendar events yourself.

STEP 6 — verify before finishing. Re-read {{inboxFile}} and confirm every new P-id has exactly one open checklist line in the format above, with a `when:` and a `src:` field. Fix omissions or duplicates before reporting success.

STEP 7 — update state. For every meeting examined, even one with zero action items, add or update its Plaud file_id in {{stateFile}} under processedMeetings with `{ name, processedAt: <ISO now>, proposalIds: [<new P-ids or empty>] }`. Set lastRunAt to now. Do not remove prior entries.

STEP 8 — commit the memory repo locally if possible.

If there are no new unprocessed meetings, reply exactly "NO_NEW_MEETINGS" and stop.
If meetings were found but none assigned action items to the owner, still update the state file and reply with a brief summary.

Reply with a plain-text summary: which meetings were processed, how many proposals were staged, their P-ids, and confirmation that every line was verified. This summary is logged, not shown live on scheduled runs.
