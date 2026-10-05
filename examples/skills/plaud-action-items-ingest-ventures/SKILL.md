---
name: Plaud action items ingest (ventures example)
description: Mine Acme, Globex, and Initech meetings into confirm-only inbox proposals.
icon: inbox
command: $plaud-meetings
requires: [plaud]
---

<!--
Example of a personalised version of the plaud-action-items-ingest seed. It only
mines meetings about three venture tags (Acme, Globex and Initech, used here as
illustrations), files accepted items under project: Ventures, and marks every
proposal sync: sheet so acceptance also writes a row to a shared Action Items
sheet. It is never installed automatically. To use it, copy this directory to
data/skills/<id>/ on purpose and replace the venture names and matching rules
with your own.
-->

Plaud meeting action-item ingest. Now is {{now}}.

GOAL: scan recent Plaud meetings for the owner's Acme, Globex, and Initech action items and stage them as confirm-only Totem task proposals. This runs unattended when scheduled or on demand; the owner confirms items later in the Inbox tab. Do not track day-job work, and do not turn general product backlog ideas into the owner's tasks unless the meeting explicitly assigned them to the owner.

STATE FILE (read first, update last): {{stateFile}}
Already-processed Plaud file_ids — do NOT re-read these meetings:
{{processedSummary}}

STEP 1 — find candidate recordings. Use Plaud MCP list_files for the last 14 days (most recent first). Skip every file_id listed in the state file above.

STEP 2 — keep only Ventures meetings. INCLUDE a recording only when its title or content clearly identifies one of these ventures:
- Acme: "acme" or a clearly identified Acme partner discussion.
- Globex: "globex" or a clearly identified Globex discussion.
- Initech: "Initech", "the Initech product", or a clearly identified Initech offering discussion.
EXCLUDE day-job meetings, journals/debriefs, unrelated personal recordings, podcasts, and one-sided notes with no meeting structure.

STEP 3 — extract only action items assigned to the owner. Read get_note and use get_transcript when ownership is unclear. Keep an item only when the owner is explicitly named as the person responsible or the assignee. Skip items assigned to someone else and skip unassigned brainstorming/backlog ideas.

STEP 4 — deduplicate before staging. Read the full {{inboxFile}} first. Do not create a proposal when any open or resolved line already covers the same work. Match on source meeting plus similar title. Allocate new sequential P-ids after the highest existing number.

STEP 5 — stage proposals; do not act. Append one matching `- [ ]` line per new item under a dated section header in {{inboxFile}}:
- [ ] P<N> | todo | <concise action item> | project: Ventures | venture: Acme | sync: sheet | when: YYYY-MM-DD | src: <meeting title YYYY-MM-DD>
- [ ] P<N> | todo | <concise action item> | project: Ventures | venture: Globex | sync: sheet | when: YYYY-MM-DD | src: <meeting title YYYY-MM-DD>
- [ ] P<N> | todo | <concise action item> | project: Ventures | venture: Initech | sync: sheet | when: YYYY-MM-DD | src: <meeting title YYYY-MM-DD>
Use the one venture actually established by the meeting. `sync: sheet` is the exact explicit sharing marker: it means acceptance creates the Totem task and its Action Items Sheet row. Never infer sharing merely from the Ventures area or venture name. Use an explicit YYYY-MM-DD date when the meeting set a deadline; otherwise write `when: none`. Do not create Totem tasks, Sheet rows, GitHub issues, or Calendar events yourself.

STEP 6 — verify before finishing. Re-read {{inboxFile}} and confirm every new P-id has exactly one open checklist line, a valid venture, and exactly one `sync: sheet` marker. Fix omissions or duplicates before reporting success.

STEP 7 — update state. For every meeting examined, even one with zero action items, add or update its Plaud file_id in {{stateFile}} under processedMeetings with `{ name, processedAt: <ISO now>, proposalIds: [<new P-ids or empty>] }`. Set lastRunAt to now. Do not remove prior entries.

STEP 8 — commit the memory repo locally if possible.

If there are no new unprocessed Ventures meetings, reply exactly "NO_NEW_MEETINGS" and stop.
If meetings were found but none assigned action items to the owner, still update the state file and reply with a brief summary.

Reply with a plain-text summary: which meetings were processed, how many proposals were staged, their P-ids, and confirmation that every line was verified. This summary is logged, not shown live on scheduled runs.
