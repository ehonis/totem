---
name: Daily brief
description: Summarise today's calendar, due tasks, and overnight inbox.
icon: sun
command: $morning
requires: [google-calendar]
---

Create the owner's morning overview for {{now}}.

Weather snapshot:
{{weather}}

News snapshot:
{{news}}

Look at everything useful, but do not create, update, delete, reschedule, or modify anything.
Use the weather snapshot directly; do not search the web for weather unless the snapshot says weather is unavailable.
Use the news snapshot directly; do not search the web for news unless the snapshot says news is unavailable. Summarize only what the headlines support; do not add unsupported details.
Use tasks__get_tasks to check Totem for overdue tasks, today tasks, high-priority tasks, and workload. This is a read-only briefing; do not change or share tasks.
Check every connected Google Calendar account for today and tomorrow, including conflicts and open blocks.
Check assistant memory for relevant recent events, routines, preferences, and watchouts.
Read {{inboxFile}} for action items mined from last night's journal. Only surface proposals still open ("- [ ]"); ignore ones already checked off ("- [x]"). If the file is missing or has no open proposals, omit section 8 entirely (do not invent items, and do not nag about a missing journal).
Check GitHub/repo signals if available, such as assigned PRs, failing checks, or obvious work needing attention.
Check local assistant/system health if useful. For the bridge, use systemctl --user status assistant-bridge; do not infer service management from process names.
Do not warn about normal short-lived OAuth access-token expiry if refresh tokens are present and calendar calls are succeeding.

Phone formatting rules: raw text only, no Markdown, no bullet characters, no tables, no long paragraphs. Use a blank line between sections. Keep most lines under 120 characters. Omit empty sections except the required headings below. Keep the entire briefing compact enough to skim on a phone.

Reply as a concise, actionable briefing with these numbered sections only:
1. Today
2. Calendar
3. Tasks
4. News
5. Work signals
6. Suggested plan
7. Watchouts
8. From last night's journal (include ONLY if there are open proposals): list each open proposal with its id and a one-line summary, then tell the owner they can reply to confirm or skip them by id, e.g. "confirm P1, P3" or "skip P2". Do not create or modify anything here; these are confirm-only.

Section 4 must be especially tight: 2 short AI news lines and 2 short world news lines; use a third line for either only if genuinely important. Include source names in parentheses when helpful.
For every other section, use 1 to 3 short lines. Include exact times when relevant. If a source is unavailable, say that briefly.
