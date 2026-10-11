# Chat

Totem's ChatGPT-style surface: one place to ask, hand off, and talk to the
assistant, with every connected app behind it. This is the spec; AGENTS.md has
the summary.

## Shape

```
browser (web/src/chat/)                bridge.mjs "Web chat" block          chat/*.mjs
───────────────────────                ──────────────────────────           ──────────
store.ts  ── POST /api/chat ────────▶  handleChatSend                        store.mjs   threads on disk
          ◀── SSE events ───────────     ├─ threadStore.update (append turn)   runs.mjs    run registry
          ── GET runs/<id>/stream ──▶    ├─ chatRuns.start ─▶ STREAMERS[driver] turn.mjs   prompt + fold
          ── POST /api/chat/stop ───▶    └─ persists reply, pushes if unwatched tools.mjs  tool naming
Composer ── POST /api/chat/uploads ─▶  chatUploads.save                      uploads.mjs attachments
         ── POST /api/chat/transcribe▶ journalTranscriber (whisper.cpp)
```

The bridge owns threads and messages. The browser renders optimistically while a
turn starts, then takes the bridge's copy: `start` carries the real message ids,
`done` the settled reply. localStorage (`chat_threads_v2`) is a paint cache only.

## Endpoints

| Route | Body / query | Returns |
|---|---|---|
| `POST /api/chat` | `{threadId, text, attachments: [uploadId], preset?, level?, provider?, model?, effort?, kind?, modelSettings?, voice?, regenerate?, editMessageId?}` | SSE stream (below). 409 if the thread is already answering. Older clients' `mode` (`'task'\|'computer'`) and `browser: true` are still accepted: hints, never errors (see What a chat run gets). |
| `GET /api/chat/runs` | | `{runs: [{threadId, status, mode, startedAt, …}]}` — what to re-attach to after a reload. `mode` is always `chat` now. |
| `GET /api/chat/runs/:threadId/stream?since=N` | | SSE: every event after `seq` N, then live ones. |
| `POST /api/chat/stop` | `{threadId}` | `{ok}`. The only way to end a run early. |
| `POST /api/chat/steer` | `{threadId, text}` | `{ok, steer: {id, text, via: 'live'\|'restart'}}`. A message for the running reply (see Steering). 409 if nothing is running, the run is wrapping up, or it is a skill command. |
| `POST /api/chat/uploads?name=&mime=[&kind=text]` | raw bytes, ≤ `CHAT_MAX_UPLOAD_MB` | `{id, name, mime, size, kind, url, preview?}` |
| `GET /api/chat/uploads/:id?sig=` | | The file. Authorised by `sig` (HMAC of the id) **or** the bearer header. |
| `DELETE /api/chat/uploads/:id` | | Removes an attachment nobody has sent yet. |
| `POST /api/chat/transcribe` | raw audio (`audio/webm`, `audio/mp4`, …) | `{text}` |
| `GET /api/chat/capabilities` | | Per enabled account: `{driver, state, fix, images: 'native'\|'file', resume, computerUse}`; `transcription`; `maxUploadBytes`. |
| `POST /api/chat/capabilities/probe` | | Re-asks each Codex account for computer-use tools; caches in `data/chat-capabilities.json`. A chat run on that account gets computer use when its entry says `available`. |

`/api/threads*` is unchanged in shape, but a PUT of an existing thread now merges
only `title`, `kind`, `provider`, `modelSettings`, `pinned`.

## Stream events

Every event has a `seq`. Viewers replay with `since`.

| `type` | Fields | Meaning |
|---|---|---|
| `start` | `userMessage`, `assistantMessage`, `provider` | The turn as the bridge stored it. |
| `delta` | `text` | Reply text. |
| `tool` | `tool: {id, phase: 'start'\|'end', kind, title, detail, server?, tool?, input?, status?, output?}` | A card opens on `start` and settles on `end`. |
| `image` | `uploadId`, `url` | A screenshot from a tool result. |
| `steer` | `steer: {id, text, via, createdAt}` | The owner wrote mid-reply. Becomes a `steer` part where it landed. |
| `activity` | `text` | The current step, one line. Not persisted. |
| `browser` | `tabId`, `url`, `title`, `image` (JPEG data URL), `at` | What the chat's browser shows after a page change. Not persisted; `GET /api/chat/browser?threadId=` returns the latest. |
| `title` | `title`, `icon?` | The AI title (and icon) for a new chat. |
| `done` | `message` | The settled assistant message. |
| `error` | `text` | The run threw. |
| `end` | `status: 'finished'\|'stopped'` | Nothing follows. |

`applyEvent` folds events into a message the same way on both sides
(`chat/turn.mjs`, `web/src/chat/reduce.ts`). Keep them in step.

## Thread file

```jsonc
{
  "id": "…", "kind": "regular" | "temporary", "title": "Plan the week",
  "provider": "claude", "modelSettings": {"modelId": "…", "effort": "high", …}, "pinned": true,
  "sessions": {"claude": {"id": "<claude session>", "through": 6}},   // native resume
  "messages": [
    {"id": "…", "role": "user", "content": "…", "createdAt": 0,
     "attachments": [{"id": "…", "name": "receipt.pdf", "mime": "application/pdf", "size": 1, "kind": "file"}],
     "voice": true, "mode": "task"},   // mode: only on messages sent with the retired toggles
    {"id": "…", "role": "assistant", "content": "…", "status": "done" | "error" | "stopped" | "streaming",
     "provider": "claude", "model": "opus", "effort": "high", "durationMs": 0, "error": "…",
     "route": "thinking", "level": 3, "power": 4,
     "stats": {"ttftMs": 0, "input": 0, "cached": 0, "output": 0, "reasoning": 0, "apiMs": 0, "tps": 0, "costUsd": 0, "tools": 0},
     "parts": [{"type": "text", "text": "…"},
               {"type": "tool", "id": "…", "kind": "mcp", "title": "Looked up tasks", "server": "tasks",
                "status": "done", "output": "…", "startedAt": 0, "endedAt": 0},
               {"type": "image", "uploadId": "…"},
               {"type": "steer", "id": "…", "text": "use the other repo", "via": "live", "createdAt": 0}]}
  ]
}
```

URLs are never stored; `signThread` adds them on the way out.

`stats` is what the agent CLI reported for the reply, read from its stream by `chat/stats.mjs`
(Claude's and Cursor's `result` event, Codex's `turn.completed`, OpenCode's `step_finish`) and summed
across a steered or retried run. `input` counts every prompt token, `cached` the part read from
cache; `output` every generated token, `reasoning` the thinking among them. `tps` is output over
the CLI's API time when it reports one (Claude, Cursor), else over the run after the first token,
tool waits included. A field the CLI did not report is absent, never zero. The dashboard shows it,
with the turn's setting and effort, when the owner hovers or taps the line under a reply
(`web/src/chat/TurnStats.tsx`).

## Resume

`through` is how many messages the provider's session has seen. On a turn,
`planHistory(thread, provider, userIndex)`:

- session exists and `through ≤ userIndex` → resume it, and replay
  `messages[through:userIndex]` as text (turns another provider answered);
- otherwise → fresh session with the whole transcript (newest-first, 16k chars).

A resumed turn sends only `temporalContext()`, the standing chat rules, the replay, the
attachments and the request. Regenerate and edit delete `sessions`. A resume that
produces nothing is retried once fresh.

| Provider | Resume | Images |
|---|---|---|
| cursor | `--resume <session_id>` | path in prompt (its read tool opens it) |
| claude | `--resume <session_id>` | base64 block via `--input-format stream-json`, plus path |
| codex | `exec resume <thread_id> -c sandbox_mode=…` | `--image=<path>`, plus path |
| opencode | `--session <id>` | `--file <path>`, plus path |

## Steering

Copied from T3 Code: while a reply is running, typing in the composer steers it.
Enter (or the corner-arrow button, with Stop beside it) sends the text into the
run, rather than waiting for a next turn. Files can't go with a steer; they wait
in the box. The message shows inside the reply where it landed, as the owner's
bubble marked "Steered".

`run.steer(text)` in `handleChatSend` hands it to `chat/steer.mjs`:

| Provider | How | What it costs |
|---|---|---|
| claude | **live**: stdin stays open (`--input-format stream-json --replay-user-messages`) and the steer is written as a `priority: "now"` user line | Nothing. Claude cuts off what it's streaming or the tool in flight and reads it. A command Claude Code won't interrupt finishes first. The cut-short turn's `result` has `terminal_reason: aborted_*` and is skipped; stdin closes after a result once every message written has been echoed back. |
| codex, cursor, opencode | **restart**: the attempt is killed (the whole process tree, `scripts/kill-tree.mjs`) and the same session is resumed with the steer | Any tool card that was running is settled as cut off. The resumed prompt (`steerPrompt`) says it was interrupted, lists the steps and text so far (`progressNote`), and gives the owner's words. If that produces nothing, it is retried fresh with the whole request. |

A steer that arrives as a live attempt is finishing (stdin already closed) waits
and becomes the next attempt, so none are dropped. Each attempt gets its own
abort signal: a steer ends the attempt, Stop ends the run. Tool ids from attempts
after the first get a `~n` suffix because Codex numbers items per process.
Transcripts replay a steered reply in order, with `[Owner, mid-reply: …]` between
the text before and after it.

T3 Code also queues follow-ups (send after the run ends) and steers Codex live
through `codex app-server`'s `turn/steer`; Totem does neither yet.

## Choosing a model

The composer's model picker (`web/src/chat/ModelPicker.tsx`) is the only way a chat picks its
account and model: favourites, then one tab per account, with search. A new chat starts on the
default account's default model (Settings → AI), or a project's default model inside a project.
Once a chat has a reply it stays on that account; the picker then offers only that account's
models. A temporary chat is held to the default account. A model that takes an effort level
shows the effort control beside the picker.

Auto, Instant and Thinking (Totem picking the model from the message, with a power dial) were
retired on 2026-10-07. Settings saved under one of them (`modelSettings.preset` other than
`manual`) never named the model, so they are treated as unset: such a chat carries on with the
model that last answered it, and the bridge drops them on the next write. Older replies keep
their `route`/`level`/`power` fields so their stats still say how they ran.

## What a chat run gets

There are no modes. The composer used to have "Task mode", "Use the browser" and "Use this
computer" toggles; since 2026-10-09 every chat run has what they turned on, and the agent
decides per request whether it needs them. `chatReach` in `chat/reach.mjs` is the one place
that decides:

| Run | Browser | Computer use | Time budget |
|---|---|---|---|
| Dashboard or app chat (`POST /api/chat`) | Offered, when Chromium is installed and `BROWSER_ENABLED` isn't `false` (Cursor and OpenCode also need the gateway on, their only way to it) | When the chat's account is Codex and its probe found desktop tools; any other account simply has none (no error, no switch to Codex) | An hour (`CHAT_TASK_TIMEOUT_MS`) |
| Voice turn (`voice: true`) | No | No | 15 minutes (`CHAT_TIMEOUT_MS`) |
| Phone shortcut (`/ask`, `http` channel) | Never (`limitReach` in `runAgent` drops it) | Never | `AGENT_TIMEOUT_MS` |
| Jobs and totems | Only a totem whose own `browser` switch is on (docs/totems.md) | Never | Their own `timeoutMs` |

The prompt leaves the choice to the agent (`chatPrompt` extras, from `chat/reach.mjs`):

- `WORK_RULES`: a request to do something is a job to carry out end to end; finish with a
  short summary. (This was Task mode's prompt.)
- `reachRules`: only for what the run actually has. Prefer an API, a Totem tool, a connected
  service or a plain search or fetch; drive the browser or the desktop only when the request
  needs it; **if unsure whether the owner wants that, ask one short question first and stop**.
- `BROWSER_RULES` and `COMPUTER_RULES`: how to use each, and never type passwords, cards or
  codes or do anything irreversible without asking.

Older clients still send `mode` and `browser`. They gate nothing. `browser: true`, or
`mode: 'computer'` on an account that has computer use, adds one line saying the owner turned it
on for this message, so the agent uses it without asking. `mode: 'task'` does nothing (every
run already gets the hour). New messages no longer store `mode`; old ones keep their badge.

## Access

The composer's access control (`chat/AccessControl.tsx`, stored as
`modelSettings.access` on the thread or project) sets what the agent may do without
asking. Unset means **Full access**. Every CLI runs in print mode and cannot stop to
ask, so "ask" means "refuse". Only chats pass an access mode; jobs and phone
requests keep each CLI's defaults.

| Access | Claude Code | Codex | Cursor |
|---|---|---|---|
| Supervised | default mode (writes only to the paths the prompt names) | `--sandbox read-only` | no `--force` |
| Auto-accept edits | `--permission-mode acceptEdits` | `AGENT_SANDBOX` | `--force` |
| Auto | `--permission-mode auto` (falls back to default where the account lacks it) | `AGENT_SANDBOX` | `--force` |
| Full access | `--permission-mode bypassPermissions` | `--sandbox danger-full-access` | `--force` |

OpenCode has no switch and ignores it.

### Claude tools

Settings → Connections › Claude tools lists the connectors each Claude account
brings with it (claude.ai connectors, its MCP servers, plugins), with a switch per
server and per tool. "Pull tools" spawns Claude Code, reads its `system/init` line
and kills it before any model call (`providers/claude-tools.mjs`). The result and
the owner's choices live in `data/claude-tools.json`. On every Claude run, each
pulled server that is on is allowed as `mcp__<server>` (so a print-mode run may
call it in any access mode, even tools a server only lists once connected) and
anything off is denied. Deny rules hold in every mode, bypassPermissions included.
Until the first pull there are no rules, so a fresh install behaves as before.

## Voice

Dictation: the mic button records until tapped, `POST /api/chat/transcribe`, and
the text lands at the cursor.

Voice mode (`VoiceMode.tsx`):

1. **listening** — `listenForUtterance` measures the room for 500 ms, counts
   anything 3× louder as speech, and ends the turn after 1.1 s of quiet.
2. **thinking** — transcribe on the box; send with `voice: true`, which adds
   `VOICE_RULES` (short, spoken, no Markdown).
3. **speaking** — `createSpeaker` reads complete sentences as they stream, so
   speech starts on the first sentence. The mic is closed meanwhile.
4. Back to listening. Tap the orb to interrupt; the mic button pauses.

Whisper's filler outputs (`(beep)`, `[BLANK_AUDIO]`) are dropped as not-requests.
Speech uses the browser's best local voice (`speech.ts` ranks them; enhanced/Siri
voices first). iOS needs one gesture-initiated utterance, which opening voice
mode provides.

## Realtime voice turn-taking

Server VAD reports pauses (`create_response: false`, 300 ms); `turn/controller.ts` decides whether the
pause ends the turn with Smart Turn v3 in a worker (`turn/worker.ts`, onnxruntime-web, single thread),
then sends `response.create`. Barge-in stays server-side (`interrupt_response: true`). Tapping the orb
while you talk means "I'm done"; while Totem talks it cuts it off. `window.__totemVoiceLog` holds the
turn decisions (`smart-turn p=0.14 in 450ms`, `end of turn: complete (0.97)`) for debugging.

## Browser

Every dashboard or app chat run is offered the browser (see What a chat run gets); the agent
uses it only when a request needs it, and asks first when unsure. Voice turns, the phone
shortcut and jobs never get it; a totem only with its own switch.

**Offering it is free, and must stay that way.** `grantBrowserAccess` only mints a token for
the run. The CLI connects to `/agent-mcp` and lists the tools, answered from static
descriptors. Chromium starts only when a `preview_*` call needs a page
(`browser()` in `browser/manager.mjs`, reached through `session(key, {create: true})`);
`preview_status` reads without starting it. The process closes after 10 idle minutes.

The agents' browser is T3 Code's, rebuilt: the same `preview_*` tools, inputs and
snapshot shape, served per run from `/agent-mcp` with a token bound to the chat.

| Piece | Where |
|---|---|
| Playwright sessions, one BrowserContext per chat | `browser/manager.mjs` |
| MCP tool descriptors and results (text + PNG) | `browser/tools.mjs` |
| `![…](/path.png)` in a reply → upload | `browser/shots.mjs` |
| Endpoint, tokens, CLI flags | "Agent browser" block in `bridge.mjs` |
| Who gets it, and the prompt rules (`browserRules`, `reachRules`) | `chat/reach.mjs` |
| Gateway path for Cursor / OpenCode | `browser` builtin in `mcp-gateway.mjs` |
| Live panel and header chip | `web/src/chat/BrowserPanel.tsx` |

A snapshot always carries the screenshot, so the model sees every page it reads.
The owner sees what it's doing in the Browser panel, and sees a screenshot in the reply
only when the model chooses to share one (`save: true`, then the path as a Markdown
image). The browser's own images are kept out of the reply on Claude, which would
otherwise post every snapshot.

The sessions live in memory: a bridge restart closes every chat's browser, and the
next `preview_open` starts a fresh one.

## Pictures in replies

`IMAGE_RULES` asks for a real picture of each thing worth seeing, linked to its page. `layoutImages`
(`web/src/components/Markdown.tsx`) lays them out by where they sit in the Markdown:

| Markdown | Shows as |
|---|---|
| Several images (or `[![alt](img)](page)`) in one paragraph, one per line | A row of captioned cards; wraps, two across on a phone |
| One image per paragraph | Full width, so several stack as a column |
| An image in a table cell | A fixed-size card, so the table keeps its shape |

Images load without a referrer; a broken one removes itself.

## Files and memory

Two standing rules ride every chat turn (`extras` in `chatPrompt`, so resumed sessions
get them too):

- **Files are opt-in** (`filesRule`). The agent answers in the chat; plans, summaries
  and write-ups are replies, not `.md` files. It saves a file to the chat's outputs
  folder (shown as a card) only when the owner asks for one, or when the deliverable only
  works as a file: something visual or interactive, a downloadable table, a long document
  meant to be kept.
- **Memory is eager** (`CHAT_MEMORY_RULES`). Without being asked, the agent records
  durable things the turn reveals (preferences, facts, decisions, finished work,
  corrections) as short dated notes in the memory repo, or in the project memory when
  only that project needs them. It ends the reply with one "Noted in memory: …" line so
  a wrong guess is easy to correct. Writes to memory and project memory are never
  snapshotted as file cards (`collectArtifacts`).

## Mac mini

Computer use only exists where Codex has a signed-in desktop to drive. Once
Totem runs on the Mac mini:

1. Install the Codex app and its Computer Use plugin, and grant Screen Recording
   and Accessibility to it.
2. Run the probe: `curl -X POST …/api/chat/capabilities/probe`. `GET
   /api/chat/capabilities` shows the reason while it is unavailable.
3. Every chat on that Codex account then has computer use (`--enable computer_use`), and
   uses it when a request needs the desktop.

The probe asks Codex for its desktop tool names and treats "NONE" as unavailable;
it never guesses from the platform.

## Projects

A project groups chats that share four things, the way Claude and ChatGPT projects
do (`chat/projects.mjs`, `web/src/chat/Project*.tsx`):

| Shared | Where | Who writes it |
|---|---|---|
| Default account and model | `project.json` → `provider`, `modelSettings` | The owner (Settings tab). A new chat in the project starts on it; any one chat can still pick another. |
| Instructions | `project.json` → `instructions` | The owner. |
| Memory | `<CHAT_PROJECTS_DIR>/<id>/memory.md` | The agent, with its own file tools; the owner can edit it on the Memory tab. |
| Files | `project.json` → `files` (upload ids) | Uploaded on the Files tab, attached in any of the project's chats, or made by the agent in one (`source`: `upload`, `chat`, `agent`). |

Every turn of a project chat, resumed or not, carries `projectBlock` (`chat/turn.mjs`):
the instructions, the memory text with its path and the rule for keeping it, and every
file's path. Chats never read each other's transcripts; the memory is how one chat's
conclusions reach the next.

- **The panel is scoped.** Home shows the project list and chats in no project. Opening
  a project (or one of its chats) swaps the panel to that project's chats. The URL
  carries `?project=<id>` alongside `?thread=`.
- **A project chat is never temporary.** `projectId` is fixed when the chat is created
  (`POST /api/chat` with `projectId`); afterwards only `PUT /api/threads/:id {projectId}`
  moves it, and a chat moved in brings its attachments and documents into the files.
- **Claude needs explicit write paths.** A `claude -p` run cannot ask for permission, so
  the chat passes `--allowedTools Edit(…)/Write(…)` for exactly the chat's outputs folder,
  the owner's memory repo (`MEMORY_ROOT`) and the project's `memory.md` (`allowWrite` in
  `spawnClaudeStream`). Without it the
  memory write is refused and Haiku still tells the owner it saved the note.
- **Removing a file** drops it from the project; the bytes go only when no chat message
  still shows it. **Deleting a project** deletes its files, instructions and memory (and
  its folders') and moves its chats to Home. Thread deletion and the orphan sweep leave
  project files alone.
- **Project context can be off for one chat.** `projectContextOff` on the thread (the
  folder button in the top bar, or the chat's menu) leaves out `projectBlock`, keeps the
  chat's attachments and documents out of the project's files, and drops the memory from
  `allowWrite`. It still starts on the project's default model. It can be switched either
  way at any turn.

### Folders

A folder is a project with a `parentId`: one level only, inside a top-level project
(the API refuses a folder in a folder). It has its own instructions, memory and files.
Its chats get the parent's instructions, memory and files as read-only context
(`projectBlock(..., { parent })`) and keep only the folder's memory, so a side topic
never leaks into the project. The owner moves what should be shared up by hand:

- **Memory:** the folder's Memory tab → "Move to <project>" lists entries (top-level
  bullets with their indented lines, or paragraphs, under their heading:
  `memoryEntries` in `chat/projects.mjs`, twinned in `web/src/chat/memoryEntries.ts`).
  Picked entries land under the same heading in the parent and leave the folder.
- **Files:** pick files on the folder's Files tab → "Move to <project>".
- **Deleting a folder** moves its chats up to its project.

In the panel, a project's folders sit above its own chats and unfold in place. Dragging
a chat (desktop only) onto a folder, the project's title, a project on Home, or the
back arrow (Home) moves it there; on a phone the chat menu's "Move to…" does the same.

### Waiting on you

A finished or failed run sets `needsReply` on the thread (not a stopped one, and never
a totem's chat). The panel shows a steady dot and a bold title, and project and folder
rows show a dot when a chat inside is waiting. Sending in the chat (a reply, a
regenerate, an edit) clears it, so does "Mark as read" in the chat's menu
(`PUT /api/threads/:id {needsReply:false}`), and so does opening the chat while the tab is
visible (a reply that finishes while the chat is open is read on arrival).

"Mark as unread" in the menu puts the mark back with `keepUnread`, for a chat to come back
to. Opening it then leaves it unread; only replying, Mark as read or Settle clear it. The
bridge drops `keepUnread` whenever `needsReply` is cleared.

### Settled and snoozed

T3 Code's way of parking threads; the rules are in `web/src/chat/settle.ts`. Every chat
list (Home, a project, each folder) ends with its own folding **Snoozed** and **Settled**
shelves, so a parked chat stays where it lives. The shelves start folded (which are open
is remembered per list in localStorage). Settled shows 10 chats, then "Show N more" in
pages of 25. The open chat always shows, even on a folded shelf.

- **Settle** (✓ on hover, the chat menu, or the leader shortcut `c s`) shelves a chat
  until the owner writes in it. Settling unpins it, ends its snooze, and clears
  "waiting on you". A toast offers Undo. A running chat can't be settled.
- **Auto-settle**: a chat with no activity for `autoSettleDays` (Settings → Chat, default
  3, 0 = never) is shown as settled at its last activity. This is worked out on read and
  never written, so changing the setting re-sorts every list. Pinned chats, running
  chats, and chats the owner un-settled by hand (`settledOverride: 'active'`, which lasts
  until his next message) are left alone.
- **Snooze** (the clock on hover, or the menu) offers In 1 hour, In 3 hours, This evening
  (18:00, while that is over an hour away), Tomorrow (9:00), Next week (Monday 9:00,
  left out on Sundays) and Custom… (a date and time, or a duration). Snoozed rows show
  the time left. Waking is also worked out on read: a chat whose time has passed is back
  in its list with a **Woke** mark until it is opened. A reply that finishes while the
  chat is snoozed wakes it early (the bridge sets `snoozedUntil` to that moment).
- Sending a message in a settled or snoozed chat brings it back, on the bridge and in
  the browser. Pinning does too.

The thread fields are `settledOverride` (`'settled'` | `'active'`), `settledAt`,
`unsettledAt` (coming off the shelf counts as activity), `snoozedUntil` and `snoozedAt`.
The browser sends every field a change touches (`null` clears one), and `PUT
/api/threads/:id` stores them as given, with no side effects, so Undo can put back
exactly what was there.

| Route | Body | Returns |
|---|---|---|
| `GET /api/chat/projects` | | `{projects}` with `fileCount`, `chatCount` (no files or memory) |
| `POST /api/chat/projects` | `{name, icon?, instructions?, provider?, modelSettings?, parentId?}` | `{project}` (with `parentId`, a folder) |
| `GET /api/chat/projects/:id` | | `{project}` with signed `files` and `memory` |
| `PATCH /api/chat/projects/:id` | any of the create fields (`null` clears) | `{project}` |
| `DELETE /api/chat/projects/:id` | | `{ok, movedChats, removedFolders}` |
| `POST /api/chat/projects/:id/memory/move` | `{entries}` (entry texts; folder only) | `{moved, project}` |
| `POST /api/chat/projects/:id/files/move` | `{ids}` (folder only) | `{moved, project}` |
| `PUT /api/chat/projects/:id/memory` | `{memory}` | `{memory}` |
| `POST /api/chat/projects/:id/files` | `{uploadIds}` (uploaded via `/api/chat/uploads` first) | `{added, project}` |
| `DELETE /api/chat/projects/:id/files[/:uploadId]` | `{ids}` without a path id | `{removed, project}` |

### Agents panel

When a chat's agent hands work to another agent, the reply shows the call as its own card
("Claude sub-agent · …", "Asked Codex · …"), never folded into the step list, and the chat
header gets an Agents chip. Either opens the Agents panel (`web/src/chat/AgentsPanel.tsx`)
in the canvas slot beside the chat, full screen on a phone. It lists every agent the chat
started, in order, with its status, model, elapsed time, tokens and step count, and what it
is doing right now. A row opens into that agent's own log: the prompt it was given, its
visible thinking, what it said, each tool call with input and output, and what it handed
back. The log is live while the agent runs and is saved with the reply.

`chat/subagents.mjs` does the work, in two cases:

- **The agent's own sub-agents.** Claude Code's Agent/Task tool: every stream event the
  sub-agent produces carries `parent_tool_use_id`, so `spawnClaudeStream` routes it to the
  card that started it instead of the reply. A background launch (`async_launched`) keeps the
  card open until Claude's `task_notification`. `task_progress` gives the progress line and
  token count. Codex's collab tools (`spawn_agent`, …) name the child thread, and its rollout
  file is tailed by thread id.
- **Another CLI run from a shell.** For example, Claude running `codex exec "make an icon"` to
  use Codex's image generation. Every command card is checked with `detectAgentCli` (`codex
  exec`, `claude -p`, `cursor-agent`, `opencode run`, `gemini -p`, including inside
  `zsh -lc '…'`). For Codex and Claude, `watchSessionLog` finds the child's own session log
  (a `~/.codex/sessions/<date>/rollout-*.jsonl` or `~/.claude/projects/<cwd>/*.jsonl` created
  after the command started whose first prompt matches the command's) and tails it. It reads
  `CODEX_HOME`/`CLAUDE_CONFIG_DIR` from the parent account's environment, the same one the
  child inherits. Cursor, OpenCode and Gemini keep no log Totem reads, so their card shows only
  what they printed.

Each part is a tool part with an `agent` field (steps capped at 400). `agent` stream events
fold into it through `foldAgent`, which has a browser twin in `web/src/chat/reduce.ts`. Each
delegation writes one `agent.delegate` line to the action log when it ends.

### Running chats panel

A panel in the bottom-right corner (`web/src/chat/RunningChats.tsx`, mounted once in
`App.tsx`) lists the chats that are answering, and the finished ones not yet read
(`needsReply`), where the owner can't see them, grouped by where they live (Home, a project,
"Project › Folder"). A chat counts as seen when it is open in the chat view, or when at least half of its row is on screen in the
chats panel or on a project page (`web/src/chat/onScreen.ts`, one IntersectionObserver over
every row). So with a folder unfolded in the panel, its running chats stay out of the
corner; open another project and they appear there. A chat joins after 500 ms, so a row
still mounting doesn't flash in. The panel starts as a pill showing the counts, on every
load, and stays folded until the owner opens it; Minimise folds it again.

Each row shows the elapsed time and the run's activity, and offers Stop, Snooze and Settle
(Settle once the reply finishes). Clicking a row opens the chat, shows the chats panel and
switches it to the chat's project and folder, which takes the row out of the corner. An
unread chat shows as a "Done" or "Failed" row whenever it is out of sight, until the owner
replies, marks it read (the row's Mark as read button), settles or snoozes it. Totem chats
are left out.

On a phone, a project or folder page (a new chat in that place) lists the place's own
recent chats, and the panel would cover them. While one is showing (`useProjectPage` in
`onScreen.ts`), the panel leaves out unread chats from elsewhere and folds to its pill;
running chats still count in the pill.

A finished or failed reply also raises a toast with an Open button, unless that chat is
open in front of the owner. A stopped run does not. Every timed toast has a bar along its
top edge counting down its time on screen, and hovering it holds both the bar and the
timer (`pauseToast`/`resumeToast` in `web/src/toast.ts`).

## Other chats

An agent can look at the owner's other chats, for the turn where he says "another thread
is working on this" or "we sorted that out in the other chat". It is deliberately not a
habit: with the gateway on, every chat turn gets one line (`threadsRule` in
`chat/thread-tools.mjs`) giving the chat its own id and project and telling it to use
these tools only when the owner points at another chat, or when the turn cannot be done
well without context that clearly lives in one. The tool descriptions say the same.

| Tool (gateway name) | Does |
|---|---|
| `totem_threads_list` (`threads__list`) | Other chats with title, `project` ("Work / Hiring"), `running`, `waitingOnOwner`, `shelf` (active/snoozed/settled, auto-settle included), last request and reply. Filters: `project` (an id, its folders included, or `home`), `status` (`running`, `waiting`, `active`), `query` (titles plus the search index's chat messages, best first, with `matches` snippets), `exclude` (the calling chat), `limit`. |
| `totem_threads_read` (`threads__read`) | One chat's last `last` messages (default 12) or a page from `from`, each clipped to `maxChars`, with one line per tool call so a running chat shows what it is doing. |

Both are read-only and local (`ANN.readLocal`), so ChatGPT and Claude on `/mcp` get them too.

## Testing

```bash
node --test chat/chat.test.mjs chat/projects.test.mjs
# A throwaway bridge that won't run jobs or touch real threads. Data dirs outside
# the checkout are outside the agent's working directory, so Claude can't read
# uploads or write project memory there; test those with the checkout's own data/
# in a worktree instead.
BRIDGE_PORT=8797 BRIDGE_NO_SCHEDULER=1 THREADS_DIR=/tmp/t CHAT_UPLOADS_DIR=/tmp/u CHAT_PROJECTS_DIR=/tmp/p \
  WEB_DIR=/tmp/dist node --env-file=.env bridge.mjs
```

Voice mode can be driven headless with Chrome's
`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>`; pad
the WAV with silence so the pause detector fires.
