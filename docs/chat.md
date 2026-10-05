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
| `POST /api/chat` | `{threadId, text, attachments: [uploadId], preset?, level?, provider?, model?, effort?, kind?, modelSettings?, mode?: 'chat'\|'task'\|'computer', voice?, regenerate?, editMessageId?}` | SSE stream (below). 409 if the thread is already answering. |
| `GET /api/chat/runs` | | `{runs: [{threadId, status, mode, startedAt, …}]}` — what to re-attach to after a reload. |
| `GET /api/chat/runs/:threadId/stream?since=N` | | SSE: every event after `seq` N, then live ones. |
| `POST /api/chat/stop` | `{threadId}` | `{ok}`. The only way to end a run early. |
| `POST /api/chat/steer` | `{threadId, text}` | `{ok, steer: {id, text, via: 'live'\|'restart'}}`. A message for the running reply (see Steering). 409 if nothing is running, the run is wrapping up, or it is a skill command. |
| `POST /api/chat/uploads?name=&mime=[&kind=text]` | raw bytes, ≤ `CHAT_MAX_UPLOAD_MB` | `{id, name, mime, size, kind, url, preview?}` |
| `GET /api/chat/uploads/:id?sig=` | | The file. Authorised by `sig` (HMAC of the id) **or** the bearer header. |
| `DELETE /api/chat/uploads/:id` | | Removes an attachment nobody has sent yet. |
| `POST /api/chat/transcribe` | raw audio (`audio/webm`, `audio/mp4`, …) | `{text}` |
| `GET /api/chat/capabilities` | | Per enabled account: `{driver, state, fix, images: 'native'\|'file', resume, computerUse}`; `transcription`; `maxUploadBytes`. |
| `POST /api/chat/capabilities/probe` | | Re-asks each Codex account for computer-use tools; caches in `data/chat-capabilities.json`. |

`/api/threads*` is unchanged in shape, but a PUT of an existing thread now merges
only `title`, `kind`, `provider`, `modelSettings`, `pinned`.

## Stream events

Every event has a `seq`. Viewers replay with `since`.

| `type` | Fields | Meaning |
|---|---|---|
| `start` | `userMessage`, `assistantMessage`, `provider`, `mode` | The turn as the bridge stored it. |
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
     "mode": "task", "voice": true},
    {"id": "…", "role": "assistant", "content": "…", "status": "done" | "error" | "stopped" | "streaming",
     "provider": "claude", "model": "opus", "durationMs": 0, "error": "…",
     "parts": [{"type": "text", "text": "…"},
               {"type": "tool", "id": "…", "kind": "mcp", "title": "Looked up tasks", "server": "tasks",
                "status": "done", "output": "…", "startedAt": 0, "endedAt": 0},
               {"type": "image", "uploadId": "…"},
               {"type": "steer", "id": "…", "text": "use the other repo", "via": "live", "createdAt": 0}]}
  ]
}
```

URLs are never stored; `signThread` adds them on the way out.

## Resume

`through` is how many messages the provider's session has seen. On a turn,
`planHistory(thread, provider, userIndex)`:

- session exists and `through ≤ userIndex` → resume it, and replay
  `messages[through:userIndex]` as text (turns another provider answered);
- otherwise → fresh session with the whole transcript (newest-first, 16k chars).

A resumed turn sends only `temporalContext()`, the mode rules, the replay, the
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

## Power (Auto)

In Auto the composer offers one dial, Quick → Max, that moves the model and its effort together
(`LADDER` in `chat/route.mjs`). `POST /api/chat/route` `{threadId?, text, power?}` answers what a
send would do right now (`provider`, `modelName`, `effort`, `power`, `powerAuto`, `reason`); the
composer calls it as you type. The first message's power is stored on the thread
(`modelSettings.power`) and reused until changed.

## Auto / Instant / Thinking

`modelSettings.preset` is `auto` (default), `instant`, `thinking` or `manual`; `level` is the
Thinking effort slider, 1–5 (Low, Medium, High, Extra high, Max). The browser sends `{preset, level}` and the bridge's `pickRoute`
(`chat/route.mjs`) chooses the account, model and effort for that one turn, skipping accounts
whose health is `missing`/`logged-out`/`error`:

| Preset | Account | Model / effort |
|---|---|---|
| instant | first of claude → cursor → codex → opencode | sonnet at `low` / `composer-2.5[fast=true]` / default at `low` |
| thinking | default if codex/claude, else first codex/claude | the account's default model at low/medium/high/xhigh/max (slider 1–5) |
| auto | `wantsThinking(text, attachments, mode)` picks one of the two | thinking level 2, or 3 for tasks and very long messages |
| manual | the thread's own provider and model | as chosen |

A routed turn does not overwrite the thread's hand-picked `provider`. Temporary chats route like
any other; only a manual choice on a temporary chat is held to the default account.

## Modes

- **chat** — 15 minutes (`CHAT_TIMEOUT_MS`).
- **task** — `TASK_RULES`, an hour (`CHAT_TASK_TIMEOUT_MS`). For "go do this".
- **computer** — `COMPUTER_RULES`, an hour, codex `--enable computer_use`. Moves the
  turn to the first enabled Codex account. Never types passwords, cards or codes;
  confirms anything irreversible.

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

**Opt-in only.** A run is handed the browser only when the message asks for it (the + menu's "Use the browser", or words
like "use the browser", "browse to", "screenshot" — `BROWSER_ASK`), or the chat already has one open from an earlier ask.
It is groundwork for computer use on the Mac mini, not a default way to look things up.

The agents' browser is T3 Code's, rebuilt: the same `preview_*` tools, inputs and
snapshot shape, served per run from `/agent-mcp` with a token bound to the chat.

| Piece | Where |
|---|---|
| Playwright sessions, one BrowserContext per chat | `browser/manager.mjs` |
| MCP tool descriptors and results (text + PNG) | `browser/tools.mjs` |
| `![…](/path.png)` in a reply → upload | `browser/shots.mjs` |
| Endpoint, tokens, CLI flags, `BROWSER_RULES` | "Agent browser" block in `bridge.mjs` |
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
2. Run the probe: `curl -X POST …/api/chat/capabilities/probe` (or reopen Chat —
   the composer's + menu shows the reason while it is unavailable).
3. "Use this computer" in the composer's + menu then turns on.

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
regenerate, an edit) clears it, and so does "Mark as done" in the chat's menu
(`PUT /api/threads/:id {needsReply:false}`). Opening the chat does not.

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
