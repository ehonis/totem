# AGENTS.md - second brain

This repo is the user's local, private, agent-facing second brain. It is optimized for fast
lookup and safe appends by CLI agents, while still being readable in Obsidian.

It lives at `data/brain` inside the Totem repo, gitignored there, with its own
nested local git repo for history. There is no remote — commits stay on this machine.

## Rules

- This is memory, not a task manager. Use local Totem tasks for future commitments and reminders. Use
  this repo for durable facts, preferences, completed activity, observations, decisions, and
  recallable context.
- Before answering a personal-context, recall, preference, habit, project-context, or "when did
  I last..." request, search this repo with `rg`.
- When the user says "remember", "log", "note", "track", "record", or reports completed
  activity that should be remembered, append it here.
- Do not store secrets, passwords, API tokens, private keys, or full payment details.
- Keep entries factual and dated. If uncertain, mark the uncertainty in the note.
- Prefer appending to existing files over creating new files. Create a new file only when it
  clearly creates a long-lived category.
- After meaningful memory changes, commit locally. This is a local-only git repo (no remote).

## Query Order

1. `index.md` - map of the vault and high-value current facts.
2. `events/YYYY-MM.md` - chronological logs of completed actions and observations.
3. `profile/*.md` - durable personal facts, preferences, routines, defaults.
4. `people/*.md` - people-related memory.
5. `projects/*.md` - project decisions and context.
6. `reference/*.md` - stable reference info such as home inventory or device notes.

Use commands like:

```bash
rg -n "plant|watered|preference" data/brain
```

## Event Log Format

Append completed actions and observations to `events/YYYY-MM.md` using this format:

```text
YYYY-MM-DD HH:MM TZ | category | subject | action | notes
```

Examples:

```text
2026-01-04 07:51 EST | plant-care | fern | watered | User reported completion.
2026-01-04 08:10 EST | preference | scheduling | updated | Prefers no calls before 10:00 unless urgent.
```

Useful categories include `plant-care`, `home`, `health`, `habit`, `preference`, `person`,
`project`, `purchase`, `decision`, `admin`, and `system`.

## Profile Format

Durable facts live in short Markdown sections. Keep each bullet independently searchable and
date it when helpful:

```text
- 2026-01-04 | scheduling | Prefers no calls before 10:00 unless urgent.
```

## Git (local history, no remote)

This is a local-only git repo — history is kept on this machine; there is no remote to push to.

```bash
git status --short
git add .
git commit -m "Update memory"
```
