# Totems

A totem is a standing agent: it wakes on a schedule to do one job, remembers what
it saw between runs, and tells the owner only what matters. The Totems tab replaced
Studio. This is the spec; AGENTS.md has the summary.

## Every job is a totem

Totems are not a second scheduler. They are the job store (`jobs/store.mjs`,
`docs/jobs.md`) with a few more fields, so every existing job became a totem with no
migration: same schedule, same history, same settings. Studio's old links redirect:
`/studio/workflows` → `/totems`, `/studio/skills` and `/studio/connections` →
Settings.

| Kind | What it runs | What it gains as a totem |
|---|---|---|
| **Agent totem** (an inline `prompt`, which is what the builder makes) | `runAgentTotem` in `bridge.mjs` | Memory, the NOTIFY/QUIET protocol, runs posted to its chat, model recommendations, optional browser. |
| **Built-in** (a `runner`) or **skill** job | Exactly what it ran before | A chat (runs that did something are posted to it) and the Totems UI. |

Extra job fields: `taskType`, `browser`, `effort`, `threadId`, `recommendations`.
`notify` gains `agent`: the totem notifies when its run ends with `NOTIFY:` (and on
errors).

## Where things live

| Thing | Location |
|---|---|
| Prompts, parsers, cost tiers (pure, tested) | `totems/core.mjs`, `totems/core.test.mjs` |
| Engine and routes | `bridge.mjs`, the "Totems" block beside the job engine |
| UI | `web/src/components/TotemsView.tsx`, `totems.css`; proposal card `web/src/chat/TotemProposal.tsx` |
| Memory | `data/totems/<jobId>/memory.md` (`TOTEMS_DIR`) |
| Chat | thread `totem-<jobId>`, carrying `totemId`; kept out of Recents |

## A run

`totemRunPrompt` sends the instructions, the memory text and its path, the last five
runs' previews, and the closing rule. The agent maintains its own memory with its file
tools (Claude gets `--allowedTools Edit/Write` for exactly that file; Codex gets
`sandbox_workspace_write.network_access=true` so a watcher can fetch pages). The reply
ends with one line:

- `NOTIFY: <title> | <body>` → a push with category `totem.notify` that opens the
  totem's chat, and the report is posted there.
- `QUIET` → recorded as `skipped`. Not posted, not a failure, no notification. Most
  polls of a watcher end this way.
- neither → `ok`, posted, notified only under `notify: always`.

The browser is per totem (`browser: true`), off by default. A run gets a fresh grant
for the totem's thread and the session is closed when it ends.

## Builder and model recommendations

`POST /api/totems/build {description}` runs one read-only `builderPrompt` on the
default account. The prompt lists every enabled account that passes the same health
check a scheduled run's preflight does, with its models and a cost tier from
`costTier` (1 small/fast, 2 standard, 3 frontier). The reply (`parseBuilderReply`) is
validated before anything is created:

- recommendations must name a listed account and model; they're sorted cheapest first,
  and an empty list falls back to the cheapest model in the catalog;
- schedules are clamped to at most once every 15 minutes;
- `notify` defaults to `agent`.

The owner edits the draft, picks a recommendation, and `POST /api/totems` creates the
job, its memory file and its chat, posts an intro, and starts the first run.
`POST /api/totems/:id/recommend` re-asks for models for an existing totem.

## Chats and proposals

- **Its own chat** (`POST /api/totems/:id/thread` makes it): every turn carries
  `totemChatBlock`, so the agent answers as the totem from its memory and recent runs,
  and may write that memory ("also ignore Ollama stories").
- **Any chat** carries `totemsRule` (the totem list) when totems exist. The agent may
  end a reply with a fenced `totem-proposal` block; the bridge strips it into a
  `totem-proposal` part (`memoryNote` and/or new `instructions`). Nothing changes until
  the owner taps Accept (`POST /api/totems/proposal`); a second Accept is refused.

| Route | Body | Returns |
|---|---|---|
| `POST /api/totems/build` | `{description}` | `{draft}` |
| `POST /api/totems` | `{draft, recommendation, enabled?, runNow?}` | `{job, threadId}` |
| `POST /api/totems/proposal` | `{threadId, messageId, partId, action: 'accept'\|'dismiss'}` | `{ok, status}`; 409 if already handled |
| `GET/PUT /api/totems/:id/memory` | `{memory}` | `{memory}` |
| `POST /api/totems/:id/thread` | | `{threadId}` |
| `POST /api/totems/:id/recommend` | | `{job}` |

Editing, pausing, running and deleting go through `/api/jobs` as before. Deleting a
totem also deletes its memory and its chat.

## Not yet

- Event triggers (a new email, a calendar change) instead of schedules.
- Proposals that create a new totem from a chat.
