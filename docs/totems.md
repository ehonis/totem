# Totems

A totem is a standing agent: it wakes on a schedule, or when something it watches
changes, to do one job, remembers what it saw between runs, and tells the owner
only what matters. The Totems tab replaced
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
| **Built-in** (a `runner`) or **skill** job | Exactly what it ran before | A chat (runs that did something are posted to it) and the Totems UI. When it runs a skill (`skillId`), its instructions are edited in the totem's own settings (the skill's body, with preview, reset to the shipped version, and a note naming other totems that share it); a runner with no skill says there is nothing to edit. Nothing sends the owner to Settings → Skills. |

Extra job fields: `taskType`, `browser`, `effort`, `threadId`, `recommendations`.
`notify` gains `agent`: the totem notifies when its run ends with `NOTIFY:` (and on
errors).

## Where things live

| Thing | Location |
|---|---|
| Prompts, parsers, cost tiers (pure, tested) | `totems/core.mjs`, `totems/core.test.mjs` |
| Engine and routes | `bridge.mjs`, the "Totems" block beside the job engine |
| UI | `web/src/components/TotemsView.tsx` (list, group picker, builder, settings), `totems.css`; `web/src/totems/shared.tsx`; a totem's answer in a chat `web/src/chat/totemReply.ts` + `Message.tsx`; proposal card `web/src/chat/TotemProposal.tsx`. iPhone: `mobile/src/features/totems/` (`TotemGroupSheet.tsx` picks a group's totems) |
| Memory | `data/totems/<jobId>/memory.md` (`TOTEMS_DIR`) |
| Chat | thread `totem-<jobId>`, carrying `totemId`; kept out of Recents. Group chats are regular chats with `members` (job ids) |

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

## Waking on a change

A totem can carry a watch trigger instead of a schedule (`docs/jobs.md` → Watch
triggers): any number of git branches and web pages (up to 20), checked without AI.
The editor lists them with "Watch another"; each shows the state it last saw. The run
it wakes gets a `WHAT WOKE YOU` section with every change that check saw (the new
commits, for a local checkout), so several repos merging at once is one run; a
hand-started run of a watcher is told to check the current state anyway. Creating a
watcher does not run it: its first check only records a baseline.

This is the cheap way to "wait for X": the polling costs nothing, and the model is
only paid when X happens. An agent totem polling on a schedule (with QUIET) is
still the right tool when deciding whether something changed takes judgement.

**Deploying Totem itself is a built-in, not an agent.** An agent that restarts the
bridge kills its own run. "Deploy Totem" (`self-update` runner) watches this
checkout's upstream `main`, pulls, rebuilds and restarts; see `docs/jobs.md` → The
defaults. Deploying another app (a sibling service) can be an agent totem with a
git watch, but the agent needs a backend allowed to write outside `AGENT_CWD` and
run the restart (Codex's sandbox and `claude -p` without allowed Bash will refuse).

## Builder and model recommendations

`POST /api/totems/build {description}` runs one read-only `builderPrompt` on the
default account. The builder may read this machine (find a repository he names,
check a path) but never change it. The prompt lists every enabled account that passes the same health
check a scheduled run's preflight does, with its models and a cost tier from
`costTier` (1 small/fast, 2 standard, 3 frontier). The reply (`parseBuilderReply`) is
validated before anything is created:

- recommendations must name a listed account and model; they're sorted cheapest first,
  and an empty list falls back to the cheapest model in the catalog;
- schedules are clamped to at most once every 15 minutes;
- `notify` defaults to `agent`.

The builder may also return a `trigger` (a watch) when the job is "when X changes,
do Y" and he named X, with one source per repo or page he listed; unusable sources
are dropped, and if none is left the schedule applies.

**The builder is a conversation.** Its reply carries a `reply` sentence and up to
three `questions` about scope it would otherwise guess (a host, a path, a
threshold). The builder page shows them in a chat panel beside the draft; each
message he sends is one more builder turn (`POST /api/totems/build {draftId,
draft, message}`) that gets the conversation, the draft as it stands (his own
edits included, so a rename or rewritten instructions survive) and his message,
and returns the whole draft revised. The form is locked while a turn runs.

**Drafts.** A designed totem he has not created is a draft in
`data/totem-drafts/<id>.json` (`totems/drafts.mjs`): description, draft, model
choice and conversation. The bridge writes each builder turn into the draft
itself, with `pending` while it runs, so leaving the page mid-turn loses nothing;
the page polls a pending draft until it finishes (a turn older than six minutes
counts as dead). The page autosaves his edits with `PUT`, which never creates a
draft, so a late autosave cannot revive a discarded one. Drafts are listed above
the totems; creating one (`POST /api/totems {draftId}`) deletes its draft.

The owner edits the draft and picks a recommendation, or any model through the
chat model picker (`ModelPicker`: concrete models across every account) plus an
effort. `POST /api/totems` creates the job, its memory file and its
chat, posts an intro, and starts the first run (not for a watcher). A totem's
settings offer the same picker.
`POST /api/totems/:id/recommend` re-asks for models for an existing totem.

## The list

The tab reads like the chats list. Each totem is a row with the newest thing in
its chat (a run's report, or the last thing said), how long ago, an unread dot,
and its status line; clicking the row opens that chat, so reading what its runs
found is one click. The switch pauses it; the gear opens its settings, memory and
runs (`/totems?totem=<id>`), which the gear in the totem's chat header also opens.
Group chats are listed above the totems, drafts between. There is no 3D lobby any
more (it was removed in favour of the list).

**The chats panel has a Totems face.** A Chats | Totems switch at the top of the
desktop panel and the phone drawer (`totem.panel.mode`, kept per device) turns it
from your chats to your totems: group chats first (with "+" for a new one), then
every totem, the one that ran last on top, each opening its own chat. The right of
each row says what it is doing (`totemNavRows` in `web/src/chat/totemNav.ts`,
ported to `mobile/src/lib/chat/`): running now, a report waiting, the last run
failed, or paused (dimmed), and how long ago it last ran. A waiting report puts a
dot on the Totems tab while the panel shows Chats.

## Group chats and totems in any chat

Any chat can bring totems in. Its agent (the host) gets `totemsChatRule`
(`totems/core.mjs`) and four gateway tools, `totems__*` (`totem_totems_*` on `/mcp`):

| Tool | Does |
|---|---|
| `totems__list {query?, chat?}` | Every totem: what it does, whether it can be asked (agent totems only), whether it is in the chat, its last run. |
| `totems__ask {chat, totem, message}` | Runs that totem on its own account and model (`preflightJobProvider`) with `totemAskPrompt`: its job, memory, last runs, the chat's last ten messages and the question. It may use its tools and write its memory. Joins it to the chat. |
| `totems__wait {askId}` | An ask waits at most 45 s and otherwise returns `working`, because some CLIs drop a tool call after a minute (Codex's default). The host waits again. Answers are kept an hour. |
| `totems__invite {chat, totems}` | Joins totems without asking them anything. |

A chat with `members` is a **group chat**. The host is told who is in it, to ask a
member when the owner addresses it by name or `@name` or the request is its job,
to pass one member's answer to the next so they build on each other, and not to
repeat their answers. At most three asks run at once per chat; an ask run has no
chat id, which keeps totems from asking each other in a loop.

**Catch-all, on by default.** Every chat (not voice, gateway mode only) is told how
many totems exist and to bring one in when a request is plainly its job.
Settings → Chat → "Let chats bring in totems" (`totemsInChat` in
`data/chat-settings.json`) turns that off; group chats work either way.

The dashboard draws each ask (and its waits) as one message from the totem, under
its name and icon (`foldTotemCalls` in `web/src/chat/totemReply.ts`, ported to
`mobile/src/lib/chat/`), instead of a tool row. "Group chat" on the Totems tab, or
the people button in a chat's header, picks the members (`POST /api/totems/groups
{members, title}` makes one; editing is a thread `PUT` of `members`). A totem's own
chat stays one-to-one and takes no members.

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
| `POST /api/totems/build` | `{description, draftId?, draft?, message?, choice?}`; with `draft` and `message` it revises | `{draft, messages, draftId}`; 409 while that draft has a turn running |
| `GET /api/totems/drafts` | | `{drafts}`, newest first |
| `GET/PUT/DELETE /api/totems/drafts/:id` | PUT: `{description?, draft?, choice?}` | `{draft}`; PUT is 404 for a draft that is gone |
| `POST /api/totems` | `{draft, choice?: {provider, model, effort, label}, recommendation?, enabled?, runNow?, draftId?}` (`choice` wins) | `{job, threadId}` |
| `POST /api/totems/proposal` | `{threadId, messageId, partId, action: 'accept'\|'dismiss'}` | `{ok, status}`; 409 if already handled |
| `GET/PUT /api/totems/:id/memory` | `{memory}` | `{memory}` |
| `POST /api/totems/:id/thread` | | `{threadId}` |
| `POST /api/totems/:id/recommend` | | `{job}` |
| `POST /api/totems/groups` | `{members, title?}` (agent totem ids) | `{thread}` |

Editing, pausing, running and deleting go through `/api/jobs` as before. Deleting a
totem also deletes its memory and its chat.

## Not yet

- Event sources beyond git branches and web pages (a new email, a calendar
  change, a GitHub release), and a non-AI "run this command" action.
- Proposals that create a new totem from a chat.
