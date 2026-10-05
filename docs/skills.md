# Skills — every prompt Totem runs, as a file you can edit

There are no built-in prompts. The daily brief, both Plaud ingests, and every
`/command` in chat are Markdown files under
`data/skills/`. You can edit them in **Studio → Skills**, in vim, or by asking
Totem to edit them.

## Why this exists

The instructions that actually decided what Totem did were unreachable.

`plaudMeetingsIngestPrompt()` was a ~60-line template literal inside `bridge.mjs`.
It encoded real judgement — which meetings count as day-job work versus side projects, what a
staged GitHub issue body must contain, which repo each proposal routes to — and
changing any of it meant editing the server and restarting the service. The Skills
tab, meanwhile, showed six hardcoded entries from a frontend array with nothing but
an on/off switch, and saved "user skills" to `localStorage` that the bridge never
read. So:

- the skills that shipped **couldn't be edited**,
- the skills you wrote **couldn't run**,
- and the prompts that mattered **weren't in the tab at all**.

The rule now is that provenance grants no privilege. A skill that shipped with
Totem is edited, renamed, and deleted through exactly the same paths as one you
wrote. The only thing "shipped" buys it is a version to reset back to.

## The file

`data/skills/<id>/SKILL.md`:

```markdown
---
name: Plaud action items ingest
description: Mine work and side-project meetings into confirm-only inbox proposals.
icon: inbox
command: $plaud-meetings
requires: [plaud]
---

Plaud meeting action-item ingest. Now is {{now}}.

STATE FILE (read first, update last): {{stateFile}}
Already-processed Plaud file_ids — do NOT re-read these meetings:
{{processedSummary}}

STEP 1 — find candidate recordings…
```

Markdown-with-frontmatter rather than JSON is deliberate: these bodies are 60-line
prompts, and a prompt stored as an escaped JSON string is unreadable in a diff and
near-impossible to edit outside the app.

| Field | Means |
|---|---|
| `name` | Display name. Renaming does **not** change the id, so jobs keep working |
| `description` | One line, shown on the card and in the chat menu |
| `icon` | Any key from the Studio icon set |
| `command` | Chat command. `/` and `$` are both accepted for any skill |
| `mode` | `send` (default) runs it; `fill` puts the text in the composer to finish |
| `requires` | Connections it needs, e.g. `[plaud]` |
| `enabled` | Only written when `false` |

The parser is deliberately tiny and takes no YAML dependency. A file it can't
understand loads as a body-only skill rather than crashing the bridge on boot —
a hand-edited prompt must never be able to take the service down.

## Variables

`{{name}}` placeholders are filled at run time. They exist because *some* of a
prompt genuinely is code — the current time, a watermark, which meetings were
already processed — and hardcoding those would make the rest un-editable.

| Variable | Is |
|---|---|
| `{{now}}` | Date and time, spelled out, in `MORNING_BRIEFING_TZ` |
| `{{weather}}` / `{{news}}` | Snapshots for the brief. **Each is a network call** |
| `{{inboxFile}}` | Path to the brain's `inbox.md` |
| `{{since}}` / `{{sinceDate}}` | Journal watermark, as an instant and as a whole day |
| `{{stateFile}}` | Path to the Plaud meetings state file |
| `{{processedSummary}}` | Plaud recordings already processed, as a skip list |

Resolution is lazy and driven by what the body actually references. That's
load-bearing, not tidiness: `{{weather}}` and `{{news}}` are outbound HTTP, and
resolving them for a skill that never mentions weather would put two network
round-trips in front of every Plaud ingest.

Two conditionals are supported, and no more:

```
{{#since}}strictly after {{since}}{{/since}}{{^since}}in the last 24 hours{{/since}}
```

`{{#x}}` keeps its block when `x` has a value; `{{^x}}` keeps its block when it
doesn't. Every feature added here is one more way a hand-edited prompt can break.

**A typo'd variable renders as an empty string.** That's the quiet failure worth
knowing about: `{{inboxFle}}` produces a prompt telling an agent to read nothing,
at 08:00, unattended. The editor flags unknown placeholders, the bridge logs them,
and `npm test` fails if a *shipped* skill has one.

### Per-skill variables

Some skills get values only their caller has (the digest's facts, say; the voice
journal's `{{transcript}}`, `{{entryDate}}`, `{{previousDate}}` and `{{journalFile}}`). Those
are declared in `SKILL_CONTEXT_VARS` in
`bridge.mjs` and allowed in that skill alone. `skills/seeds.test.mjs` mirrors that
list — if the two drift, the test says so.

## Seeding, editing, deleting

The versions that ship live in `skills/seeds/` and are **copied** into `data/skills/`
on first boot. Three rules make editing safe:

1. **Seeds are copied, never merged.** Once `data/skills/<id>` exists the seed is
   inert. A deploy cannot revert your edit.
2. **Deletes are remembered.** `data/skills/.seeded.json` records every seed ever
   installed, so a built-in you delete stays deleted. Genuinely new seeds still
   arrive on the next boot.
3. **Reset is always available.** "Reset to default" re-copies the seed — including
   for a skill you deleted — so there's no edit you can't undo.

## API

| Route | Does |
|---|---|
| `GET /api/skills` | Skills + which jobs use each + the variable catalog |
| `POST /api/skills` | Create. Needs a name |
| `PATCH /api/skills` | Update by `{id, ...}`. Every field, every skill |
| `DELETE /api/skills` | Delete by `{id}`. Works on built-ins too |
| `POST /api/skills/reset` | Restore the shipped version |
| `POST /api/skills/preview` | Render it now, variables filled. Pass `body` to preview an unsaved edit |
| `POST /api/skills/revise` | Ask an AI to rewrite the instructions. Returns a proposal, saves nothing |
| `GET /api/skills/revise-models` | Providers/models a revision may run on, with reasoning levels and live login state |

## Revising a skill with an AI

The edits you actually want to make to a sixty-line prompt are the awkward kind —
"make step 4 stricter about duplicates", "stop it committing", "say the output
rules in half the words" — and doing them by hand in a textarea is where skills go
stale. **Ask AI to change this** sits under the Instructions box: pick the AI,
model and thinking level, say what should change, and read the diff.

**Nothing is saved.** The route returns `{before, after, changed, note, provider,
model, effort, ms}`. The editor renders a hunked diff with add/remove counts, and
**Apply** only fills the textarea — Save is still Save, and *Reset to default* is
still there for a built-in. It revises the body **currently in the editor**, saved
or not, same as `preview` does, so an AI edit can be stacked on a hand edit.

If the text in the box has moved on since the proposal was built, the editor says
so before you apply it, because applying would throw those edits away.

### Why it runs read-only

A skill body is a document full of imperatives — the Plaud skill tells its reader
to write files under `inbox-prompts/`, renumber proposals, and commit. Handing that
to a model and saying "rewrite this" invites it to *carry the document out*
instead. Two defences, in order:

1. **The prompt says the document is data.** At length, explicitly: do not read
   the files it mentions, do not run the commands it describes, your entire task
   is to return an edited copy. The body is fenced off between markers and the
   revision comes back between its own, so an echo of the input cannot be mistaken
   for the answer (the extractor takes the *last* marked block).
2. **The run genuinely cannot write.** codex gets `--sandbox read-only`, Claude
   Code loses `Bash`/`Edit`/`Write`/`NotebookEdit`, and `runAgent`'s
   usage-limit fallback to opencode is disabled for this channel — a throttled
   provider must not reroute the work to a CLI with no equivalent switch.

That is why only **codex and claude** are offered. Cursor and OpenCode expose no
read-only mode, and "pick any model" is not worth handing a shell to a model that
has just been fed a page of orders. Between them there are six current models and
five or six reasoning levels each.

The revision goes through the `revise` channel, which `buildPrompt` passes
**verbatim** — no persona, no memory or inbox rules. The reason: the contract is
"return this exact text", and Totem's own instructions would only add noise and
temptation.

Each revision is recorded in the action log as `skill.revise` (with the request as
`why`, and the model, level and before/after sizes in `detail`) and in the usage
log under the `skill-revise` channel — it costs an AI call, so it is counted like
one.

## How jobs use skills

A job is a schedule, an AI, and something to run. See `docs/jobs.md` — the short
version is that `plaud-meetings-ingest` (the 08:00 job) has `skillId:
plaud-action-items-ingest`, so editing that one file changes both the scheduled run
and the `$plaud-meetings` chat command. You can also point a second job at the same
skill on a different schedule.

## Gotchas

- **Reads hit disk every time.** No cache, so a file you edit in vim while the
  bridge is running takes effect on the next run, not the next restart.
- **Renaming keeps the id.** The directory name is the stable handle jobs and saved
  chat commands reference. Re-slugging on rename would break them silently.
- **A deleted skill breaks its job loudly**, not quietly: the run fails with
  `skill "x" no longer exists — pick another one for this job, or restore it`.
- **`mode: fill` skills only trigger on a bare command.** `/recall something` has
  already been expanded by the composer and goes through as ordinary chat.
- **An edited skill runs unattended with Totem's full tool access.** It can create
  tasks, edit the brain, and touch repos. Preview before you save something you
  haven't read back.
