# Totems

A totem is a standing agent: it wakes on a schedule, or when something it watches
changes, to do one job, remembers what it saw between runs, and tells the owner
only what matters. Totems replaced Studio. They live on the Totems page (`/totems`,
on the rail after Chat since 1.1, with a badge for reports waiting), where one is
built or edited, and in each totem's own chat (its gear opens its page). This is the spec; AGENTS.md has the summary.

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

Extra job fields: `taskType`, `browser`, `access`, `effort`, `threadId`, `recommendations`.
`notify` gains `agent`: the totem notifies when its run ends with `NOTIFY:` (and on
errors).

## Where things live

| Thing | Location |
|---|---|
| Prompts, parsers, cost tiers (pure, tested) | `totems/core.mjs`, `totems/core.test.mjs` |
| Engine and routes | `bridge.mjs`, the "Totems" block beside the job engine |
| UI | `web/src/components/TotemsView.tsx` (the list and group picker), `web/src/totems/Builder.tsx`, `web/src/totems/Detail.tsx` (a totem's page), `web/src/totems/fields.tsx` (the settings sections both share), `totems.css`; `web/src/totems/shared.tsx`; a totem's answer in a chat `web/src/chat/totemReply.ts` + `Message.tsx`; proposal card `web/src/chat/TotemProposal.tsx`. iPhone: `mobile/src/features/totems/` (`TotemGroupSheet.tsx` picks a group's totems) |
| Memory | `data/totems/<jobId>/memory.md` (`TOTEMS_DIR`) |
| Chat | thread `totem-<jobId>`, carrying `totemId`; kept out of Recents. Group chats are regular chats with `members` (job ids) |

## A run

`totemRunPrompt` sends the instructions, the memory text and its path, the last five
runs' previews, and the closing rule. The memory stays inline here (and in
`totemAskPrompt`), unlike in chats, where it is only named: a run is a fresh session,
never resumed, so it is sent once per run rather than once per turn, and it is the
totem's state (last values seen, what it already notified), which every run needs to
tell what changed and not notify twice. It is capped at 40,000 characters
(`TOTEM_MEMORY_MAX`). The agent maintains its own memory with its file
tools (Claude gets `--allowedTools Read/Edit/Write` for exactly that file; Codex gets
`sandbox_workspace_write.network_access=true` so a watcher can fetch pages). The reply
ends with one line:

- `NOTIFY: <title> | <body>` → a push with category `totem.notify` that opens the
  totem's chat, and the report is posted there.
- `QUIET` → recorded as `skipped`. Not posted, not a failure, no notification. Most
  polls of a watcher end this way.
- neither → `ok`, posted, notified only under `notify: always`.

A failed run is posted to the chat too, and its push (and a `notify: always` push for a
run that was posted) opens the chat. A skipped run, and a watch that cannot be read,
open the totem's settings (`/totems?totem=<id>`) instead.

The browser is per totem (`browser: true`), off by default. A run gets a fresh grant
for the totem's thread and the session is closed when it ends.

## Access

A run is unattended, so nothing can approve a command while it runs: whatever its
permissions refuse stays refused. By default (`access: null`) a run keeps the standard
job limits: Claude Code in its account's own default permission mode with Edit/Write allowed only on
the totem's memory and files folder (so `ssh`, system stats and reads outside
`AGENT_CWD` are refused), Codex on `AGENT_SANDBOX` with network, Cursor with `--force`
as before. **Full access** (`access: 'full'`, the switch beside Browser in the totem's
settings and the builder's draft) runs it the way a Full access chat runs:
`--permission-mode bypassPermissions` for Claude, `danger-full-access` for Codex. Claude's
secret deny rules still hold. The store also accepts the chat's other modes
(`supervised`, `edits`, `auto`; `normalizeTotemAccess` in `jobs/store.mjs`), but the UI
offers only Full or nothing, because "ask" means "refuse" in a run. The builder may
propose Full (`access` in its draft) only for jobs that ssh, read system state or write
outside the totem's folders; the owner sees the switch before creating it. A run that is
not on Full is told which setting would unblock it (`totemReachLines` in
`totems/core.mjs`), so a refused command ends as one notification naming the fix. Asks
from a chat (`totems__ask`) run with the same access.

Each run and ask may write its files folder, the totem chat's outputs folder
(`CHAT_OUTPUTS_DIR/totem-<id>`, `totemFilesDir`), so a script or report it makes shows in
that chat's Files panel.

An agent holding `BRIDGE_SECRET` can set Full access through `PATCH /api/jobs`. That is
not a new way out: it could already create a job with any prompt on Cursor, which always
runs with `--force` (`docs/self-hosting.md` → What remains open).

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
threshold). The builder page shows them in a chat card beside the draft (above it
on a narrow window); each
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

The page reads like a project's page, after T3 Code: a title, a composer to
describe a new totem (Enter hands the words to the builder, which starts designing
at once; three example chips fill it), then sections of flush rows: Drafts, Group
chats (with "New group chat"), Totems (his own and every built-in that is on, the
ones that are on first, then whichever spoke last), and a folded "More built in"
shelf for the built-ins that are off (`isBuiltIn`: a runner, a skill or a seeded
job), with deleted built-ins to restore at its end (open or folded is kept per
device, `totem.totems.builtInOpen`). Pausing a built-in moves it there, so the
toast says where it went (`setTotemEnabled`). Each totem's row has the newest
thing in its chat (a run's report, or the last thing said), how long ago, an
unread dot, and a short status beside its name: its schedule or "Watching", and a
dot only for trouble (last run failed, can't check), a pause or a run in progress
(`totemBrief` in `web/src/totems/shared.tsx`). Clicking the row opens that chat,
so reading what its runs found is one click. On hover the row shows a gear for its
page and a "…" menu: Open chat, Run now (the row says "Running now" until it ends),
Pause/Turn on, and its page; on a touch screen only the "…" shows, always.

A totem's page (`/totems?totem=<id>`, also the gear in its chat header) has a
header (icon, name, kind, status; Open chat, Run now and an On switch), a red note
when the last run failed, and Settings / Memory / Runs tabs. Settings is drawn with
the Settings dialog's sections and rows (`components/settings/ui.tsx`;
`settings.css` scopes them to `.tm-view` too): Totem (name, description, icon from
the chat icon set), Instructions, When it runs, Model, Behaviour (notify, browser,
full access) and Delete. Name, description, icon, schedule, model and switches
save at once; instructions, memory and a watch wait for Save, whose bar appears
once there is something to save. The builder's draft uses the same sections
(`web/src/totems/fields.tsx`) with a Create bar under them (on a phone, Create
also sits under the name).
Beside that gear, a play button runs the totem now (`POST /api/jobs/run`, the same
manual run as its settings page) instead of waiting for its schedule or watch; it spins
until the run ends and its report lands in the chat (`TotemRunButton` in
`web/src/totems/shared.tsx`, mirrored in `mobile/src/features/totems/shared.tsx`).
Group chats are listed above the totems, drafts between. There is no 3D lobby any
more (it was removed in favour of the list).

**On the rail, not in the chats panel.** Until 1.1 the web's chats panel had a
Chats | Totems switch; since then the panel lists only the owner's chats (group chats
included, a totem's own chat not), and Totems is a rail item after Chat whose badge
counts totem chats with a report he hasn't read. The iPhone drawer is the same: its
chats list leaves totems' chats out, and Totems is a drawer row under Overview with a dot
for a report waiting.

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
`mobile/src/lib/chat/`), instead of a tool row. "Group chat" on the Totems page, or
the people button in a chat's header, picks the members (`POST /api/totems/groups
{members, title}` makes one; editing is a thread `PUT` of `members`). A totem's own
chat stays one-to-one and takes no members.

## Chats and proposals

- **Its own chat** (`POST /api/totems/:id/thread` makes it): every turn carries
  `totemChatBlock`, so the agent answers as the totem from its memory and recent runs,
  and may write that memory ("also ignore Ollama stories"). The block names the memory
  file with a one-line summary and the agent reads it when the question depends on it;
  it is not pasted into every turn of the resumed chat (`chat/memory-ref.mjs`).
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
