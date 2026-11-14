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

## The header

The chat's top bar (`web/src/chat/ChatHeader.tsx`, handed everything by ChatView):
breadcrumbs (parent project, project, Totems), the chat's icon and title, then on the
right the project-context switch, a totem's run and settings buttons or the totems in a
group chat, a chip for each side panel the chat has something in (Files, Agents,
Browser; `HeaderPanels.tsx`), the AI usage pills (`UsageChips.tsx`), and Keep or
Temporary. A side panel can leave the chat column any width (down to about 180px with
three open), and what the header holds varies, so no fixed width can say when to fold.
`headerFold.ts` measures instead: on every width or content change it takes the fewest
steps of `FOLD_STEPS`, in order, that let the title keep its floor (all of it, up to 55%
of the header and at most 300px; it rises smoothly with the width, so the header never
unfolds as it narrows) with nothing past the header's edge. It starts from the level it is
at and steps up or down, so a frame of a drag costs a measurement or two. The steps:
the browser chip drops its host; chips keep their icon and count; breadcrumbs keep their
icons, avatars become a count and the hover-only retitle button goes; the usage pills
fold into the tightest provider with "+N"; the chips, the add-totems button, the project
switch, a totem's run and settings, Keep, Temporary and the parent-project and Totems
crumbs go into one "…" menu; "+N" goes; padding tightens; Show chats and New chat go into
"…"; the usage pill goes into "…"; the project's crumb goes into "…". The steps taken are
written to `data-fold` on `.vc-top` (never by React), and `chat.css` has one rule set per
step; a control marked `data-fold-into="<step>"` hides once that step is taken and has a
row in "…", so every control stays reachable at any width. Two things only shrink: the
avatars become a count on the add-totems button (its picker lists them), and the hover-only
retitle button goes (it is in the chat's own menu too). The phone's New chat never folds.
The right side never shrinks and the title's side is clipped, so the two cannot overlap.

"…" is portalled to `<body>`. Arrow keys, Home and End move; Escape and Tab close it and
give focus back to "…"; a row that opened a side panel moves focus into it. The side
panels close on Escape through `usePanelEscape` (`chat/escape.ts`), only for an Escape
nothing has handled: "…", the totem picker (`MembersPop`: `useDismiss` with its button,
first control focused however it opens, focus back to the button or "…"), the usage
panel, the Lightbox, a message being edited and every `useDismiss` popover mark the
Escape they take. The usage panel hangs left from the pills, so on opening it measures
the chat column to their left and stacks its providers in one column when the grid
would not fit.
When the agent waits on the owner in the browser, its chip, row and the dot on "…" are amber.

`scripts/web-layout.test.mjs` bundles `ChatHeader.harness.tsx`, which draws the real header
in each of its shapes (plain, waiting, group, a project folder's group chat, a totem's chat,
temporary, a project's home, a new chat, the phone) with five titles from long to short,
and sweeps it from 1400px to 180px (4px at a time below 480px) beside a side panel, under
the Windows caption buttons and at phone width, with one usage provider and with three. It
fails on any overlap, anything past the header's edge, a title under the code's own floor,
a usage pill gone before its step, a folded control with no "…" or no row in it, or a
header that unfolds as it narrows. `HEADER_SHOTS=<dir>` keeps a picture of each. It needs Chromium and the web
install, so CI's bridge job skips it. A new control in the header gets a `data-fold-into`,
a row in ChatHeader's list, and a place in a harness variant.

## Endpoints

| Route | Body / query | Returns |
|---|---|---|
| `POST /api/chat` | `{threadId, text, attachments: [uploadId], preset?, level?, provider?, model?, effort?, kind?, modelSettings?, voice?, regenerate?, editMessageId?}` | SSE stream (below). 409 if the thread is already answering. Older clients' `mode` (`'task'\|'computer'`) and `browser: true` are still accepted: hints, never errors (see What a chat run gets). |
| `GET /api/chat/runs` | | `{runs: [{threadId, status, mode, startedAt, …}]}` — what to re-attach to after a reload. `mode` is always `chat` now. |
| `GET /api/chat/runs/:threadId/stream?since=N` | | SSE: every event after `seq` N, then live ones. |
| `POST /api/chat/stop` | `{threadId}` | `{ok}`. The only way to end a run early. |
| `POST /api/chat/questions` | `{threadId, messageId, partId, action: 'answer'\|'dismiss', answers?: {questionId: string[]}, attachments?: {questionId: uploadId[]}}` | `{status, live, message, attachments}`. The owner's answers to the agent's questions (see Questions). `live: false` means the run that asked had ended; `message` is the answers as text and `attachments` the upload ids sent with them, for the client to send as the next message. 409 if already answered. |
| `POST /api/chat/approvals` | `{threadId, messageId, partId, decision: 'accept'\|'acceptForSession'\|'decline'\|'cancel', feedback?}` | `{status, live: true}`. The owner's decision on a tool call waiting for approval (see Approvals). `feedback` goes with a decline. 409 once the run that asked has ended or the request was already answered. |
| `POST /api/inbox/reply` | `{id, text}` | `{ok, id, via: 'start'\|'queue'\|'steer', threadId}`. The approval card's Reply: the owner's words go to the chat that staged the open proposal `id`, which stays open (see Approval cards). 409 if it is not open, 404 if no chat staged it. Decides nothing, so it is not an approval route. |
| `POST /api/chat/steer` | `{threadId, text, attachments?: [uploadId]}` | `{ok, steer: {id, text, via: 'live'\|'restart', attachments?}}`. A message (words, files or both) for the running reply (see Steering). 409 if nothing is running, the run is wrapping up, or it is a skill command. |
| `POST /api/chat/queue` | `{threadId, action, …}`: `add` `{text, attachments, provider?, model?, effort?, modelSettings?}`, `edit` `{id, text, attachments}`, `remove` `{id}`, `move` `{id, beforeId\|null}`, `steer` `{id}`, `resume` | `{queue, queueHeld}` as they now stand (`steer` adds `steer`). The thread's queue (see Queue). 404 when the message is no longer queued; 409 for `steer` with nothing running. |
| `POST /api/chat/uploads?name=&mime=[&kind=text]` | raw bytes, ≤ `CHAT_MAX_UPLOAD_MB` | `{id, name, mime, size, kind, url, preview?}` |
| `GET /api/chat/uploads/:id?sig=` | | The file. Authorised by `sig` (HMAC of the id) **or** the bearer header. |
| `DELETE /api/chat/uploads/:id` | | Removes an attachment nobody has sent yet. |
| `GET /api/chat/files?thread=<id>` (or `?path=<abs dir>`) | | `{root, entries: [{path, rel, name, dir, size?, mtime?, mime?}], truncated}`: the chat's outputs folder as a tree (see Files panel). A chat with no folder yet lists empty. |
| `GET /api/chat/files/link?path=<abs>` | | `{path, name, mime, size, url}`: the file checked, and its signed link (see Files panel). 403 outside the shared folders, 404 when missing. |
| `GET /api/chat/files/raw?path=<abs>[&download]` | | The file, streamed: signed in, the bearer, or `&exp=&sig=` from its signed link. 403 outside the shared folders, 404 when missing. |
| `POST /api/chat/transcribe` | raw audio (`audio/webm`, `audio/mp4`, …) | `{text}` |
| `GET /api/chat/capabilities` | | Per enabled account: `{driver, state, fix, images: 'native'\|'file', resume, computerUse}`; `transcription`; `maxUploadBytes`. |
| `POST /api/chat/capabilities/probe` | | Re-asks each Codex account for computer-use tools; caches in `data/chat-capabilities.json`. A chat run on that account gets computer use when its entry says `available`. |

`/api/threads*` is unchanged in shape, but a PUT of an existing thread now merges
only `title`, `kind`, `provider`, `modelSettings`, `pinned`.

## Stream events

Every event has a `seq`. Viewers replay with `since`.

| `type` | Fields | Meaning |
|---|---|---|
| `start` | `userMessage`, `assistantMessage`, `provider`, `queuedId?` | The turn as the bridge stored it. `queuedId`: it was that queued message. |
| `queue` | `queue`, `queueHeld` | The thread's queue changed while this reply runs. |
| `delta` | `text` | Reply text. |
| `tool` | `tool: {id, phase: 'start'\|'end', kind, title, detail, server?, tool?, app?, logo?, input?, status?, output?}` | A card opens on `start` and settles on `end`. `app`/`logo` are a connector's own name and https logo (see Steps and connectors). |
| `image` | `uploadId`, `url` | A screenshot from a tool result. |
| `steer` | `steer: {id, text, via, createdAt, attachments?}` | The owner wrote mid-reply. Becomes a `steer` part where it landed. |
| `questions` | `questions: {id, questions?, status, answers?, askedAt?, answeredAt?}` | The agent asked the owner questions (a `questions` part, added where asked), or they were answered or dismissed (the same part, updated by id). |
| `approval` | `approval: {id, tool, title, detail, app?, logo?, reason?, path?, input?, toolUseId?, subagent?, once?, status, decision?, feedback?, askedAt?, decidedAt?}` | Claude asked to run a tool call (an `approval` part, added where asked), or the owner decided, or it expired (the same part, updated by id). |
| `inbox` | `inbox: {id, kind?, title?, status, note?, result?, stagedAt?, decidedAt?}` | The reply staged an inbox proposal (an `inbox` part, added where it was staged), or the owner decided it while the reply still ran (the same part, updated by id). See Approval cards. |
| `visual` | `visual: {id, uploadId, title, height, url}` | The agent showed a chart with `html_render` (a `visual` part, added where it was called, once per id). `url` is signed for viewers and not saved. See Charts in replies. |
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

### Switching accounts

A chat can start on Codex and carry on with Claude, the way T3 Code hands a thread between
providers. The picker offers every account on a started chat; the thread's `provider` is
whichever account the last message was sent on, and each account keeps its own entry in
`sessions`, so Codex → Claude → Codex resumes Codex's own session and replays only the Claude
turns.

When the replay holds replies from another account (`handoffReplay` in `bridge.mjs`), it is
rendered as a handoff (`renderTranscript` options in `chat/turn.mjs`): each reply's steps, one
line per tool call (last 12) with failures marked; the owner's first message kept however far
back it was, with `(…)` where the middle was cut; a heading naming the account it came from and
saying it is context, not a new request, and that the agent did not take those steps itself;
and, with the gateway on, how many messages did not fit and that `threads__read` on this chat's
own id from 0 reads them. Attachments are named, not re-sent. No summary model runs.

In the log, `providerSwitches` (`web/src/chat/handoff.ts`, ported to `mobile/src/lib/chat/`)
puts a "Context handed off" divider above the owner message that started the first turn on the
new account. Once another account is picked, a "Handoff with your next message" row sits over
the composer until that message is sent. Switching while a reply runs leaves that reply on its
account; the switch applies to the next message.

## Steering

Copied from T3 Code: a message sent while a reply is running either steers it
(the agent takes it in mid-turn) or waits in the queue for the reply to finish
(see Queue). Settings → Chat › Follow-up behaviour picks which one Enter and the
send button do (`followUp`, `queue` or `steer`; fresh installs queue, as T3
does, and installs that had steering before the queue keep steering). Ctrl/⌘ +
Enter, or Ctrl/⌘-click on send, does the other for one message, and holding
Ctrl/⌘ swaps the button's glyph (list-plus for queue, corner arrow for steer).
With the box empty the button is Stop. In the iPhone app a long press on send
does the other.

A steer carries files as a message does: images and files added by the + menu,
paste or drop go with it. The message shows inside the reply where it landed,
the owner's files and bubble under T3's small "Steer" label.

`run.steer(text, {files, images})` in `startChatTurn` hands it to `chat/steer.mjs`
(`steerRun` loads the uploads first; `steerText` lists their paths before the
words). Claude gets the images as image blocks in the stdin line; a restarted
attempt passes them as its images (`--image=` for Codex), and the rest read the
paths:

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

T3 Code also steers Codex live through `codex app-server`'s `turn/steer`;
Totem restarts it instead.

## Queue

T3 Code's follow-up queue (`chat/queue.mjs`). A queued message waits on the
thread (`thread.queue`, written only by the bridge; a client's copy of a thread
never sets it), so like a run it outlives the browser. It keeps the model the
composer showed when it was queued. When a run ends (`chatRuns`' `onEnd`,
`drainChatQueue`) the bridge starts the first one itself through
`startChatTurn`, the same path a send takes, and the next one after that reply,
one at a time. A reply that was stopped or failed holds the queue
(`thread.queueHeld`): nothing starts until Resume (the ▶ button an empty
composer shows) or any new message of the owner's. A message that cannot start
goes back at the front and the queue holds.

The queue is a drawer on the composer's top edge (`QueuedMessages.tsx`):
"Queued" and a count, collapsible, then one row per message, first in line
first: image thumbnails, the text on one line, Edit (the message goes into the
composer, the draft there is put aside and comes back after; send shows a check,
the row Cancel), Steer (send it into the running reply instead; off with nothing
running) and remove. Rows drag by their grip to reorder, or move with the arrow
keys on it; the app has no reordering. If an edited message starts meanwhile,
the edit is kept as the draft when the box had none, otherwise dropped, with a
toast either way. Viewers of the running reply hear changes as `queue` events,
and a client that sees a reply end with messages queued looks for the next run
(`watchQueue`).

## Questions

Copied from T3 Code: the agent can stop and ask the owner questions, and the
chat waits for the answers. The questions show above the composer one at a
time: a header chip, `N/M`, the question, and its options (click, or keys 1–9
when the caret is not in a text box; multi-select toggles). The composer's box
is the typed answer for the question on screen, and typed words win over a
pick. Single-select moves to the next question by itself; the last one's button
submits them all. Previous goes back, X dismisses. The chat list shows "Awaiting
input", the running-chats panel lists the chat, and the phone gets a
`chat.question` push when nobody is looking. Answered questions stay in the
reply as a row that opens to each answer. The app has the same panel.

**Images and files.** A photo or file added in the composer (the + menu, paste
or drop) while a question is on screen goes with that question's answer, with or
without words; it shows under the question and can be removed there. The agent
gets each file's path on the box in the tool's result and opens it with its own
file tools, as it does a message's attachments. Answered late, the files go as
the next message's attachments, or into the steer when a reply is running
(`POST /api/chat/steer` takes `attachments` for this). The part keeps them as
`attachments` by question id, and a deleted chat deletes them. The iPhone app's
panel does not attach files yet.

**No cap.** T3 catches the CLIs' own question tools, and those set the limits:
Claude Code's AskUserQuestion takes at most 4 questions of 2–4 options, Codex's
`request_user_input` at most 3 and only in Plan mode (which `codex exec` never
reaches). Totem serves its own `ask_questions` instead (`chat/questions.mjs`),
with no limit on questions or options, on each run's `/agent-mcp` endpoint
beside the browser. Claude and Codex get it directly; Cursor and OpenCode as
`browser__ask_questions` through the gateway (only with the gateway on). Claude
Code's own AskUserQuestion is denied on those runs. Voice turns, the phone
shortcut, jobs and totems don't get it.

**Live, then as a message.** The call holds its HTTP request open as an SSE
stream (headers at once, a comment every 15 s) until the owner answers, and
the run's clock stops while it waits (`createHolds`/`holdableTimeout`), so an
hour deciding is not an hour off the reply's budget. The answers come back as
the tool's result and the reply carries on. Each CLI is told to wait up to a
day for the call (Claude's per-server `timeout`, Codex's `tool_timeout_sec`).
If the run ends first (Stop, a steer that cut the call off, a bridge restart,
a CLI giving up on the call), the questions stay pending on the reply; answering
them then sends the answers as the next message (T3's "message mode"), which
resumes the session. A double submit is refused with 409.

## Approvals

T3 Code's pending approvals, for Claude Code (`chat/approvals.mjs`,
`web/src/chat/ApprovalRow.tsx`, `web/src/chat/approvals.ts`). A Claude chat run
starts `claude -p` with `--permission-prompt-tool stdio`: a tool call its
permission mode would ask about arrives on stdout as a `can_use_tool` control
request instead of being refused, and the answer goes back on stdin as a
`control_response` (the same protocol the Agent SDK's `canUseTool` uses). Even
Full access forwards the asks bypass will not skip: ask rules, connector tools
that require a person, safety checks.

The request becomes an `approval` part in the reply, where it was asked: what the
agent wants to run (the tool card's own title and detail), Claude's reason, and
"Waiting for approval · Decline · Approve · More". More holds "Always allow in
this chat" (left out when Claude marks the request `suppress_always_allow_rule`)
and "Cancel turn". While one waits, the run's clock is held, the chat row says
"Awaiting approval", and a push goes out if nobody is viewing. A message sent from
the composer declines it, and its words reach the agent as the reason (T3's "send
feedback to decline"); files with it go on as a steer.

| Decision | Claude gets |
|---|---|
| Approve | `allow` with the input unchanged |
| Always allow in this chat | `allow` plus Claude's suggested rules as session updates (never `setMode`: the mode is the composer's). The rules (`Bash(npm test:*)`, or the tool by name) are saved on the thread as `allowedTools` and passed as `--allowedTools` on every later run in that chat. |
| Decline | `deny`, with the owner's words as the message |
| Cancel turn | `deny` with `interrupt`, which ends the turn |

A request lives only as long as the process that asked. When the run ends (Stop,
a bridge restart) or Claude withdraws it (`control_cancel_request`, after a steer
cut the turn short), the part is `expired` and has no buttons. Voice turns, phone
requests and jobs never get approvals: they keep refusing as before.

## Approval cards

An inbox proposal remembers the chat that raised it, and its outcome goes back into
that chat (`chat/inbox-outcome.mjs`, `web/src/chat/InboxCardRow.tsx`,
`web/src/chat/inboxCards.ts`; the app's copies under `mobile/src/`).

- **Which chat.** Every chat run's `/agent-mcp` token is also given to its CLI as
  `TOTEM_RUN_TOKEN` (Codex is told to pass it to the gateway with `env_vars`; Cursor
  only has `TOTEM_BROWSER_TOKEN`, the same token). The gateway sends it as
  `x-totem-run` on its calls to `/mcp`, and the bridge maps a live token to its
  thread and run (`session.chat`). The stagers a chat can reach (email, message,
  command, prompt, away) then write `thread: <id> | run: <id>` on the inbox line
  (`thread` and `run` are reserved meta keys). Nothing else changes about a line:
  ingests and older proposals have no `thread:` and resolve exactly as before.
  `GET /api/inbox` returns each item's `chat: {threadId, runId}` or null.
- **The card.** Staging posts an `inbox` part into the running reply. Pending, it
  is the Inbox card in the chat's approval style: what accepting does, Show details
  (the Inbox's own details view), held and refused notices, a note for the agent,
  and Deny, Accept (Send for email and messages, Open in T3 Code for a prompt),
  Save as draft for an email, and Reply. It reads the live item from `GET /api/inbox`
  and accepts through the unchanged `POST /api/inbox/resolve` with the item's
  `digest` and this device's approval code, so every rule there (risk, the code,
  holds, hidden characters, a changed proposal) applies; the bearer alone is
  refused as everywhere else. A proposal decided elsewhere shows as "Not in the
  Inbox any more". Decided, the card is one line: Accepted (with the result),
  Saved as a draft, Denied, or uncertain, and the owner's note.
- **The outcome.** Every resolve updates the card (the live reply's own copy until
  that reply's final save, the thread file after). When the owner decided it in the
  dashboard (the Inbox tab or the card; not an agent under an approval session,
  which already knows what it did), the bridge also tells the chat, as the owner's
  message marked `inbox: {id, status}`:
  `[Inbox P12 · email: …] The owner accepted it. Result: sent from … to ….`, with
  `The owner's note: …` when he wrote one (`note` on the resolve body, up to 2,000
  characters). With no reply running it starts a turn through `startChatTurn` on the
  chat's account and model; while one runs it follows Settings → Chat › Follow-up
  behaviour: queued (`chat/queue.mjs`), or steered (queued if the steer cannot land).
  **A denial without a note starts nothing**: the message is added to the thread,
  and the agent reads it with the next message the owner sends (a reply's session
  counts as seen only through that reply, so an outcome recorded while it ran is
  replayed). So is an uncertain send with no note.
- **Reply** sends the note alone (`POST /api/inbox/reply`), as
  `[About inbox P12 …, still waiting for the owner's decision] …`, the same way; the
  proposal stays open.
- The chat shows a marked message as a label ("P12 · Denied") with only the owner's
  own words under it. The running-chats panel keeps a chat with a pending card in
  view, marked "Waiting on your approval".

## Choosing a model

The composer's model picker (`web/src/chat/ModelPicker.tsx`) is the only way a chat picks its
account and model: favourites, then one tab per account, with search. A new chat starts on the
default account's default model (Settings → Providers), or a project's default model inside a project.
A chat that has started can still move to another account: pick one of its models and the next
message hands the chat over (see "Switching accounts" below). A temporary chat is held to the
default account.

The chip at the composer's right names the model and its effort as one control ("GPT 6.1 Sol ·
Low", with a lock when the chat is off Full access), and it opens one panel, after T3 Code's: the
accounts down the left (favourites first), search and the models in the middle (⌘/Ctrl+1–9,
arrows and Enter, stars, "Legacy models" for the ones the Providers tab hides), a Reasoning
column on the right with the current model's effort levels (its default marked, the one in use
checked), and a footer with Standard/Fast on the left and the chat's access (below) as a
dropdown on the right. The Reasoning column shows only for a model with effort levels, and the
speed toggle only where Totem can send a speed, which today is Cursor's Composer
(`[fast=true|false]`); Codex and Claude Code runs are sent no speed. Picking a model or an effort
closes the panel; speed and access apply and leave it open. On a phone-width screen the panel is
full width and the effort levels become a row under the list. The rules are in
`web/src/chat/traits.ts`. A project's and a totem's default model use the same picker without
the reasoning column and footer.

The panel is rendered into `<body>` and placed against the window (`usePopoverPlacement` in
`web/src/chat/ui.tsx`): it opens upward from the chip unless there is more room below (a new chat
or a project's home, where the composer sits high), shrinks to the room it has, and never leaves
the window. Inside the chat it could not be placed reliably: the chat's scroller is a size
container and on a project's home carries a mask, so a fixed box in it was placed against the
wrong frame (shifted by the scroller's offset) and clipped to it. Any new popover in the chat
that must escape the scroller should be portalled the same way.

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

The access dropdown in the footer of the composer's model picker (`chat/ModelPicker.tsx`, modes
in `chat/traits.ts`, stored as `modelSettings.access` on the thread or project) sets what the agent may do without
asking. Unset means **Full access**. A Claude chat stops to ask the owner (see
Approvals); every other CLI runs in print mode and cannot, so for them "ask" means
"refuse". Only chats pass an access mode; jobs and phone requests keep each CLI's
defaults.

| Access | Claude Code | Codex | Cursor |
|---|---|---|---|
| Supervised | `--permission-mode default`, named outright so the account's own `defaultMode` cannot turn it into Auto (writes outside the paths the prompt names ask first) | `--sandbox read-only` | no `--force` |
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
| Playwright sessions, one BrowserContext per chat; the live screencast and the owner's input | `browser/manager.mjs` |
| Which Chromium, and launch options (user agent, screen, headed) | `browser/pick.mjs` |
| The owner's input: what the panel may send, as CDP events | `browser/input.mjs` |
| The panel's socket (`/api/chat/browser/ws`) | `browser/socket.mjs` |
| MCP tool descriptors and results (text + PNG) | `browser/tools.mjs` |
| `![…](/path.png)` in a reply → upload | `browser/shots.mjs` |
| Endpoint, tokens, CLI flags | "Agent browser" block in `bridge.mjs` |
| Who gets it, and the prompt rules (`browserRules`, `reachRules`) | `chat/reach.mjs` |
| Gateway path for Cursor / OpenCode | `browser` builtin in `mcp-gateway.mjs` |
| Live panel | `web/src/chat/BrowserPanel.tsx`, `browserStream.ts`, `browserInput.ts` |
| Header chip and its "…" row | `web/src/chat/HeaderPanels.tsx` |

A snapshot always carries the screenshot, so the model sees every page it reads.
The owner sees what it's doing in the Browser panel, and sees a screenshot in the reply
only when the model chooses to share one (`save: true`, then the path as a Markdown
image). The browser's own images are kept out of the reply on Claude, which would
otherwise post every snapshot.

**Which browser.** `browser/pick.mjs` takes, in order: `BROWSER_EXECUTABLE`, an installed
Google Chrome (`/Applications/Google Chrome.app`, `/opt/google/chrome/chrome`, …), Playwright's
full Chromium (`npx playwright install chromium`; Chrome for Testing on a Mac), a system
Chromium, and Playwright's headless shell only as a last resort. Installed Chrome is found by
path rather than Playwright's `channel: 'chrome'` (the same binary), so one `executablePath`
serves the chat's pages, `renderPage` (charts) and `readPage` (the LinkedIn reader). A full
build runs in Chrome's new headless mode. The old headless shell names itself
"HeadlessChrome" in its client hints and can sit on Cloudflare's "Just a moment..." for good;
LinkedIn's `/login` did.

**What a site sees.** Every chat context and `readPage` context (`contextOptions` in
`browser/manager.mjs`) carries the browser's own user agent with "HeadlessChrome" replaced by
"Chrome" (read once from `Browser.getVersion`), a 1920×1080 screen with a window that size,
`en-US` languages, and the bridge's time zone (`MORNING_BRIEFING_TZ`, else the host's).
`--disable-blink-features=AutomationControlled` keeps `navigator.webdriver` false, and
Playwright's `--hide-scrollbars` is dropped. On a Linux box, full Chromium in new headless
mode with only the user-agent change cleared LinkedIn's check at once; without that change it
waited on "Just a moment..." indefinitely. WebGL still reports SwiftShader where there is no
GPU; nothing spoofs it, since a faked renderer that disagrees with the real one is a louder
tell. If a host's checks still refuse headless, `BROWSER_HEADED=true` runs a real window
instead. It needs a display (on macOS, Totem under launchd in the owner's GUI session has
one) and shows a Chrome window on that screen. It is off by default.

**Live view.** While the panel is open and the dashboard is visible, it holds one WebSocket
per chat, `/api/chat/browser/ws?threadId=` (`browser/socket.mjs`). The bridge then runs CDP's
`Page.startScreencast` on the chat's current tab (`watch` in `browser/manager.mjs`) and sends
each frame down as a binary message: a JSON header (tab, URL, title, the page's CSS viewport
size) and the JPEG. The panel draws it on a canvas, so a spinner, a redirect or a challenge
widget moves without anyone touching it. Frames are acked at most 24 a second and never wait
on a viewer: a socket whose send buffer is over 1.5 MB keeps only the newest frame and sends
it once the buffer drains, so a slow link skips frames without queueing them or slowing
anyone else's. The frame is sized to the widest viewer (its width × device pixel ratio,
never above the page's own pixels), and a frame shown at under three quarters of full size
gets a coarser JPEG. A new viewer gets the page as it stands at once, since a page that is
not painting sends nothing. The last viewer leaving (hiding the panel, the tab going to the
background, switching chats) stops the screencast. Watching never opens a browser or a
context, and never keeps one alive: only the agent's actions and the owner's input touch the
30-minute idle timer, and a context closing tells every viewer (`closed`). The newest
streamed frame also answers `GET /api/chat/browser`, which is all the iPhone app reads:
stills, no live view there yet.

Why a socket rather than the chat run's SSE stream: the browser outlives the run (the owner
signs in after a reply ended), a viewer's arrival and departure is exactly what starts and
stops the screencast, and a drag is dozens of events a second, which one POST each would
queue behind each other. It is the terminal's pattern, on the same port and origin.

**The owner drives it.** On the frame: mouse moves, presses and releases with their button
(left, middle, right) and click count (double and triple clicks), drags (a drag that leaves
the picture holds its edge), the wheel, right-click, and keys down and up with their
modifiers. Pointer positions map from the shown picture to the page's CSS pixels whatever
size it is drawn at (`toPagePoint` in `web/src/chat/browserInput.ts`). Keys go through a
hidden textarea so a phone raises its keyboard: a real key goes as a key (Playwright's
keyboard, which knows its code and text, with the modifiers the owner held), while composed
text (IME, a phone keyboard, dead keys) and a paste arrive whole as `text`. On a touch screen
a tap is a click and a drag scrolls the page. On the bridge, `browser/input.mjs` checks every
event (coordinates clamped to the viewport, the four real modifiers only, text up to 4,000
characters) and turns mouse and wheel into `Input.dispatchMouseEvent`. Events run in order
per chat; moves or wheel turns waiting behind a slow one fold into one. What is held down is
kept per tab as entry (a key, a modifier, a mouse button) → the panels holding it. Each panel
is one owner, named by an id it makes when it mounts and sends on its socket (`?owner=`) and
in its POSTs (`owner`), so a press made by POST while the socket was still connecting is let
go by the socket's up, release or close (a socket with no valid id is its own owner; the id
only groups one panel's presses, and driving still takes a session or the code). Driving
taken away mid-socket releases what it holds at once. An owner is recorded before its down is sent, and an up goes to the page
only when the last owner lets go, so one socket never lifts what another holds, and an up
for something the tab does not hold is dropped. A modifier pressed because a key-down
listed it belongs to that socket, and its next key-up that no longer lists it lets go.
When the current tab changes (a link opens a tab, the agent switches), one job behind the
queued input releases everything the old tab holds, read when it runs, so a press still in
flight is caught. A socket closing, or the panel's keys losing focus (`{ t: 'release' }`),
releases what that socket holds. Every release waits at most a second, so a busy or hung
old tab never holds up input to the one on screen. Typed text is never written to the tab's action
timeline or the log.

The same events go to `POST /api/chat/browser/input` (`kind: 'mouse' | 'wheel' | 'key' |
'text'`, or `look` for a fresh frame) when the socket cannot connect, without bare moves;
that route answers with the latest frame.

**Only the owner drives.** `POST /api/chat/browser/input` is an approval route
(`APPROVAL_ROUTES`, low): a signed-in session or the approval code, never `BRIDGE_SECRET`
alone, since the run that opened the browser is an agent holding the bearer, and it could
otherwise click through what it handed the owner. The socket asks the same: watching takes a
signed-in same-origin upgrade or the bearer subprotocol (`totem.bearer.<base64url>`), what
reading a frame over GET takes; driving takes a session or the approval code, offered as
`totem.approval.<base64url>` because a browser cannot set a header on a WebSocket. A
bearer-only socket gets `ready` with `drive: false` and the panel says so. A cookie socket is
re-checked on every message and heartbeat, so signing out ends it.

That is how the owner signs in to something: the prompt tells the agent to ask him to sign in
there and stop, never to type a password. While a run is live the page is look-only, so the
owner and the agent don't fight over it.

The agent hands the page over with `preview_handoff({ reason })` (`browser/handoff.mjs`,
served on `/agent-mcp` beside the browser tools, so the gateway's `preview_*` filter
passes it to Cursor and OpenCode too). The panel opens, phone included, with a "Your
turn" banner and Done / Skip; the owner gets a push if he isn't looking. The call waits
like `ask_questions`: it holds the run's clock, Done or Skip answers it
(`POST /api/chat/browser/handoff`), and it gives up after Codex's live window or when
the CLI drops the call. Then the banner stays, and Done sends "I'm done in the browser"
as his next message. Any new message settles a leftover handoff. Totems with the
browser switch don't get the tool, since nobody is watching their runs.

The sessions live in memory: a bridge restart closes every chat's browser, and the
next `preview_open` starts a fresh one.

## Steps and connectors

A reply's working steps fold into one line above its answer, as T3 Code does
(`web/src/chat/workFold.ts`, `WorkLog.tsx`; the app's `features/chat/` mirrors them). The fold
takes every tool call and the commentary the agent said before its last call ("Let me check your
inbox…"); the text after the last call is the answer. Only commentary folds (`isCommentary`: under
280 characters, one paragraph, no heading, list, table or code): agents often answer first and then
save a note or file a task, so a longer or answer-shaped text before the last call stays in the
reply and the fold splits around it, keeping the order. A proposal, a file, a picture, a
sub-agent's card, a question or a steer stays outside it, in place. Only a settled reply folds:
while it runs, what the agent says between calls stays in the reply and each run of calls is its
own line showing the running call, so the owner can follow along; when the answer is in, they
close into one line, "Used Microsoft 365, Tasks and 1 more · 7 steps", led by those sources'
marks stacked (three, then +N). A stopped or failed reply has no answer and stays unfolded. Open,
the fold reads in order: what the agent said, and each call as a card.

A connector's mark is its own logo when the CLI sent one: Claude Code's assistant events carry
`tool_use_meta` (`display_name`, `server_display_name`, `icon_url`) for connector tools, and a
Codex `mcp_tool_call` may carry `app_context`. `connectorLook` (`chat/tools.mjs`) turns that into
the card's `title`, `app` and `logo`; Totem's own gateway and browser keep their names and glyphs.
Only an https logo is kept, it loads without a referrer, and a broken one falls back to a glyph
(`APPS` in `web/src/chat/ui.tsx`). A claude.ai connector's server is `claude_ai_<Name>`, read as
`<name>`.

## Pictures in replies

`IMAGE_RULES` asks for a real picture of each thing worth seeing, linked to its page. `layoutImages`
(`web/src/components/Markdown.tsx`) lays them out by where they sit in the Markdown:

| Markdown | Shows as |
|---|---|
| Several images (or `[![alt](img)](page)`) in one paragraph, one per line | A row of captioned cards; wraps, two across on a phone |
| One image per paragraph | Full width, so several stack as a column |
| An image in a table cell | A fixed-size card, so the table keeps its shape |

Images load without a referrer; a broken one removes itself.

## Charts in replies

T3 Code's `html_preview` / `html_render`, on each chat run's `/agent-mcp` beside the browser
and `ask_questions` (`browser__html_preview` / `browser__html_render` through the gateway).
`chat/visuals.mjs` holds the tools, the prompt rule and the page policy. When the answer is
data with a trend or a comparison, or the owner asks for a chart, graph or diagram, the
agent writes one self-contained HTML page and:

1. `html_preview` loads it in the box's Chromium (`renderPage` in `browser/manager.mjs`: a
   fresh context, no chat's cookies or tabs, at most two at once, 20 s from launch to picture) under the same
   policy the chat serves it with, and returns a PNG on the chat's background, the page's
   `contentHeight` and its console (blocked requests show there). The agent fixes what looks
   wrong and previews again. It starts Chromium only when called.
2. `html_render` (title, and the previewed height) stores the page as a chat upload marked
   `visual`, with Totem's theme variables, base sheet and a small bootstrap put first in
   `<head>`, and adds a `visual` part to the reply where it was called. The agent is told
   not to describe it. Pages that size from the viewport (`vh` units) are refused, because
   the frame fits the page and would grow without end; so are `vb`, `vmax` (and their
   small/large/dynamic forms) and the container units `cqh`/`cqb`/`cqmax`. Every scan
   over the page reads a tag's attributes to a bound, because it runs on the bridge's one
   thread (the timing test feeds it 512k of unclosed tags).

Who gets them: a dashboard or app chat run that is offered the agent browser (Chromium
installed, `BROWSER_ENABLED` not `false`) and can reach `/agent-mcp` (Claude and Codex
directly; Cursor and OpenCode with the gateway on). Never one without the browser (next
section says why), voice turns, the phone shortcut, jobs or totems. `filesRule` tells the
agent a chart to look at is not a file.

**The page never runs as Totem.** The uploads route serves a `visual` upload (only those;
an HTML file the owner uploads is still a download) inline with `VISUAL_CSP`:
`sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox` (no `allow-same-origin`,
so an opaque origin even when opened on its own), scripts, styles and fonts only from
cdnjs.cloudflare.com, cdn.jsdelivr.net and unpkg.com (and Google Fonts for CSS), images only
as `data:`/`blob:`, and `connect-src 'none'`, `frame-src 'none'`, `form-action 'none'`. So a
page cannot read Totem's storage or call its API as the owner, and fetch, WebSockets,
remote images and forms go nowhere. The dashboard's frame is sandboxed too, without popups
(`allow-scripts` only).

What CSP cannot stop: a page navigating itself (`location = 'https://…?data'`) or opening
a WebRTC connection, either of which can carry data out in a request. The preview answers
every navigation itself (a 204, so it never leaves the box) and logs it to the page's
console for the agent, without waiting out a load that will now never come; the dashboard
closes a frame that loads a second time ("reloaded or tried to open another page"), but
only after the request has gone. So the tools are offered only beside the agent browser:
that run already reaches any URL through `preview_navigate`, and a chart is no new way out.
A run with no network of its own and no browser (a Codex sandbox on a box with the browser
off) would gain one, so it gets no charts (`grantChatAccess`).

Every other inline upload (images, plain text) is served under `content-security-policy:
sandbox` as well, so an SVG with script opened on its own never runs as Totem. PDFs are
not, because a sandbox blocks the browser's PDF viewer. `servedHeaders` in
`chat/uploads.mjs` makes the call; `chat/visuals.test.mjs` checks each case.

**Dashboard** (`web/src/chat/VisualFrame.tsx`): the page loads from its signed URL into a
transparent frame on the chat's own background, its 8px gutter pulled out so it lines up
with the text. It starts at the agent's height, then fits the height the page reports
(`totem-visual:size`, up to 8,000 px). The frame's sandbox is `allow-scripts` only: a link
(an `<a href>` click, or `window.open` from a chart's click handler, which the bootstrap
replaces) asks the host to open it (`totem-visual:open`), and the corner button opens the
page on its own. The `html_render`
tool card is hidden (the chart stands for it); `html_preview` folds into the steps as
"Checked the chart". The theme is Totem's dark palette under T3's variable names
(`--foreground`, `--muted-foreground`, `--card`, `--border`, `--accent`, `--chart-1`…`6`,
`--radius`, `--font-sans`), so a page written for one reads right in the other.

At phone width the frame is the reply's width (about 360 px) and fits the page's height the
same way; nothing in it depends on the viewport.

**iPhone app** (`mobile/src/features/chat/VisualCard.tsx`): drawn inline in
`BridgeWebView` (`mobile/src/ui/BridgeWebView.tsx`, a `react-native-webview` WebView; rules in
`mobile/src/lib/bridgePage.ts`), on the chat's background, fitted to the page's height (8,000
px at most), with a corner button that opens it full screen (its own page load, scrolling
inside). It used to be a card that opened the page in the in-app browser
(SFSafariViewController), which cannot send the app's Cloudflare Access token
(`cf-access-token`): behind Access the chart URL answered with Access's sign-in page, so the
chart never showed (#260).

`BridgeWebView` is the app's one way to show a page the bridge serves, so another screen can
reuse it. It keeps the web frame's contract:

- **What it loads.** A bridge path or a URL under the bridge's base (`bridgePageUrl`), read
  once per mount; anything else renders nothing and fails. A chart narrows that to
  `/api/chat/uploads/<id>?sig=…` (`visualPagePath` in `features/chat/visualPage.ts`), so
  anything else gets the plain card and is never loaded.
- **Credentials on the first request only.** `bridgeSource` builds the source once per mount:
  the URL plus the Access token as a header. Never the bridge secret: the page may be
  agent-written, and a page the bridge serves to a WebView is signed.
  react-native-webview sends a source's headers with that load and never with a navigation,
  a subresource or a page's request. A target off the bridge gets no source, so no header is
  ever built for another origin, and the navigation rule below refuses every later top-level
  load, the bridge URL included, so nothing re-sends them. A page's script cannot read
  request headers. The bridge's `VISUAL_CSP` `sandbox` still gives a chart an opaque origin.
- **No shared state.** `incognito` (a non-persistent data store: whatever cookie Access sets
  lasts as long as the view and never reaches the app's jar), `sharedCookiesEnabled` and
  third-party cookies off, no cache, no link previews, no data detectors, no file access.
- **No script unless asked; one message.** With `onHeight` (charts), the view injects
  `PAGE_HEIGHT_SCRIPT`, because a page opened at the top level never posts its height (its
  bootstrap only does that framed). The script measures the page the way the bootstrap does
  and posts `totem-visual:size`, which is the only message read (`pageHeightFrom`); a page's
  own `totem-visual:open` is dropped. Without `onHeight` no script is injected and no message
  is read (react-native-webview still registers its own history shim). A link opens through `window.open`, which WebKit allows only on a tap
  (`javaScriptCanOpenWindowsAutomatically` off), in the in-app browser, and only to another
  site (`linkOpensOutside`).
- **Navigation.** Every request reaches `bridgeNavigation` (`originWhitelist={['*']}`;
  with the library's default, a `tel:` or app link would go to `Linking.openURL` without
  asking it). The source URL loads once. While it is loading, another URL is a redirect
  (Access's sign-in), a failure: for a chart, a card with "Couldn't load the chart · tap to
  retry". The source URL again, while loading (an inline `location.reload()` running as the
  page parses) or after, closes the view, and so does any other page once it has loaded; a
  chart shows the web's "reloaded or tried to open another page" line. Only a `#hash` jump
  within the page is let through.

The app's web preview (`BridgeWebView.web.tsx`) uses the dashboard's sandboxed frame, which
sends no headers. The WebView is a native module, so the change shipped with an App Store
build; a binary without it never gets the JS that needs it (the fingerprint runtime keeps OTA
updates apart).

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

### Files panel

T3 Code's files viewer, for a chat (`chat/files.mjs`, `web/src/chat/FilesPanel.tsx`). The
owner reads chats from other devices, so a path on the box means nothing to him until the
bridge lists and serves it. The panel shows the chat's outputs folder
(`data/chat-outputs/<thread>/`) as a tree; a file opens in the canvas, and every row
downloads. Office files, images and zips become file cards too (`ARTIFACT_EXT`); the
canvas shows those that it cannot render as a download.

- **What it may serve.** Anything under `CHAT_OUTPUTS_DIR` plus each folder in
  `FILES_ROOTS` (colon-separated, off by default), compared by real path so a symlink
  cannot lead out. Never Totem's `data/`, `secrets/`, `.env` or `.git`, whatever the roots
  say; only a root inside `data/` (the outputs folder) is let through.
- **One way to open a file: its signed link.** A reply's path link, a row in the tree and a
  `?file=` redirect all call `openFile(path)` (`web/src/chat/store.ts`), which asks
  `GET /api/chat/files/link?path=` (signed in or the bearer) and opens what comes back: the
  file's real path, an expiry 12 hours out and an HMAC of both
  (`/api/chat/files/raw?path=…&exp=…&sig=…`). The canvas's fetch, its PDF frame and image,
  and the desktop app's native download read that URL without the bearer, so a dashboard
  unlocked with `BRIDGE_SECRET` (no session cookie) opens files like a signed-in one. Before
  this the canvas read the bare raw URL with a plain `fetch()`, which answered such a window
  401, and showed `{"error":"unauthorized"}` as the page. A row's Download signs its file
  on the click too (`downloadFile` in `web/src/links.ts`), so a list left open past a
  restart or the expiry still downloads; the listing itself carries no links.
- **What a signature allows.** That one path, until it expires, on exactly the spelling
  `/api/chat/files/raw?…` (any other spelling goes through the sign-in gate); the roots and
  deny list are checked again on every read, and a signed read refuses a path that is no
  longer its own real path. The key is random per bridge process, never `BRIDGE_SECRET`
  (which may be empty), so a restart retires every link. HTML is still always a download
  from Totem's origin; the canvas fetches it and shows it in an opaque-origin `srcdoc`
  frame. An inline file shown on its own (text, an image) carries `CSP: sandbox`, a PDF not.
- **The canvas never shows an error body as the file.** A refusal is said in words (sign in
  again, not shared, gone) in place of the file.
- **Path links.** A link to an absolute path (`/Users/…`, `/home/…`, `file://…`, Totem's
  raw-file URL) opens in the canvas: `web/src/links.ts` routes the click (`totem:open-file`,
  handled by ChatView; outside a chat it downloads through the signed link). Opened as a URL,
  a path under the outputs folder is redirected to `/chat?thread=<id>&file=<path>`
  (`chatFileRedirect`), decided from its shape alone so the redirect says nothing about which
  files exist; the store reads `?file=` at load.
- **In the desktop app nothing on the server leaves the window.** The app's link shim
  (`desktop/src-tauri/src/lib.rs`) sends any link that opens a new tab to the system browser,
  and every reply link opens a new tab, so a file link went out too. `installLinkRouting`
  listens in the window's capture phase, ahead of the shim, and takes over: files and
  anything else Totem serves (uploads, a chart's "open on its own", attachments) open in the
  canvas (`totem:open-resource`, `openResource`: a HEAD says what it is, and a chart page
  served under `VISUAL_CSP` is framed by its URL so that sandbox still holds), or download in
  the app outside a chat; any other path on the server (a dashboard page; the bridge answers
  an unknown one with the dashboard) navigates in the window. Only other sites go to the
  system browser, as in T3 Code. `window.open` follows the same rule only during the owner's
  own click (`navigator.userActivation`); otherwise it goes to the shim, so a chart that posts
  `totem-visual:open` on load cannot drive the app, and VisualFrame passes on only other
  sites' URLs anyway (`visualOpensOutside`). A browser keeps
  its own behaviour for everything but a plain click on a file link. No desktop rebuild is
  needed: the shim already skips a click whose default was prevented.
- **Not in the iPhone app yet.**

### Side panel widths

The canvas, Files, Browser and Agents panels open in one slot beside the chat. Each one
resizes from its left edge with the handle that every docked panel shares, the chats panel
and the terminal included. The handle is `web/src/components/ResizeHandle.tsx`, with its
arithmetic in `panelResize.ts`.

**One model.** Two cases, and only these two:
- **When the window changes size,** the stylesheet alone lays the panels out from their saved
  widths, squeezing them toward their minimums. Nothing is saved, so the saved widths come back
  when the window widens again.
- **A drag or a key press is one gesture with one rule** (VS Code's sashes):
  - Every open panel (chats panel, terminal, side panel) is pinned where it is drawn.
  - Widening takes room first from the page, which is the chat when a side panel is open, down
    to its minimum. Then it takes from the other panels in a fixed order, each down to its own
    (`TAKES_FROM`, `shareWidth`):
    - the side panel takes from the terminal, then the chats panel;
    - the chats panel takes from the side panel, then the terminal;
    - the terminal takes from the side panel, then the chats panel.
  - Narrowing gives the room to the page, never to another panel.
  - On release only what moved is saved. The dragged panel is saved at its new width. A panel
    that gave room is saved at its saved width (or its default) less what it gave, not at the
    width it was drawn at, which the window may have squeezed. A panel that gave nothing keeps
    its saved width.
  - Escape puts every panel's inline width and saved width back exactly.

**Holds.** A drag holds the other panels where they are until the window or the set of open
panels changes; only the panels that moved are remembered. Without the hold, a panel the
stylesheet had squeezed would take back the room the drag just made. The holds (`dropHolds`)
drop when the window's width changes (not its height: docked devtools or an infobar change
nothing), on a reload (inline widths are never saved), and whenever a docked panel opens or
closes: the chats panel, the terminal, or the side panel opening, closing, or going full width.

**After a hold drops,** the stylesheet lays the panels out from their saved widths, and the
side panel's saved width is part of the page's minimum. The handle publishes it on the shell
as `--side-saved`, so a narrower window squeezes the chats panel and the terminal before the
side panel. A side panel widened at a laptop size keeps its width after a resize or a reload.
The chats panel and the terminal share whatever squeeze is left the way the grid shares free
space: equally, each up to its saved width. That has one known edge. When the window squeezes
both of them, a drag of one taking room from the other holds until the window's width or the
open panels change, but after a resize or a reload the grid shares the squeeze equally again.
For example, at 1366px with the defaults, the chats panel widened 247 → 273 by the terminal
(saved 494, its 520 less the 26 it gave) comes back at 247 / 354. No saved width can keep an
uneven split between two squeezed tracks. Saving the terminal at the 328 it was drawn at would,
but then it would stay at 328 on a wide screen too. The saved widths come back as soon as the
window is wide enough for them.

- **Controls.**
  - Double-click or Enter restores the default width (the chat at `min(46%, 640px)`, as before).
  - The arrow keys move the edge 16 px, or 64 px with Shift.
  - Home and End go to the limits.
  - A drag gives the handle focus, so the keys work straight after one. The focus line shows
    only for the keyboard (`data-pointer` marks a pointer focus until a key is used).
  - At a limit the cursor points the only way the edge can go (`e-resize`/`w-resize`). With
    nowhere to go, it is `not-allowed` and there is no line (`data-limit`).
- **Saved widths.** Each panel keeps its own width on the device, under
  `totem.panel.<chats|canvas|files|browser|agents>.width`. The terminal keeps its older key,
  `totem.terminal.width`.
- **The limits live in CSS.** The chats panel (`--sh-panel-w`) and the terminal (`--term-w`)
  are grid tracks in `shell.css`. Each grows from its own minimum (220px, and
  `min(340px, 24vw)`) up to its saved width, after the page column has its minimum.
  - That minimum is what the page needs: 420px, or the chat's minimum plus the side panel's
    saved width (`--chat-min` + `max(--side-min, --side-saved)`) while a side panel is open. It is cut down only to what the open panels' minimums leave of
    the window.
  - The side panel's width is `--vc-side-w`, set on the panel itself. `chat.css` reads it as a
    flex basis, with the chat at least `min(--chat-min, 55%)` and the panel at least
    `min(--side-min, 45%)`.
  - The handle measures the limits rather than restating them (`measure`): every panel at its
    minimum, then this one as wide as the stylesheet allows. It measures again when the panel
    or the page beside it changes size.
  - `scripts/web-layout.test.mjs` checks the layout from 721 to 1920 px, with the default
    widths and with widths saved on a big monitor, plus the 1366 hold.
- **Dragging over an iframe.** A drag captures the pointer and sets `panel-resizing` on the
  body. That turns pointer events off for the app and every iframe, so the canvas or a chart
  never takes the moves. Widths go straight to the CSS variables once a frame, and React does
  not re-render during a drag.
- **Keeping a drag cheap.**
  - Each variable is set where it is read: on the side panel itself, and on `.app.shell` for
    the chats panel and terminal. All three are registered with `@property` as non-inherited,
    so a drag restyles that one element rather than everything under it.
  - The terminal publishes its real width (`--term-width`, for the launcher) only once a drag
    ends, and the other handles measure their limits again only then (`PANEL_RESIZE_END`).
    Either would otherwise force layouts on every frame of someone else's drag.
  - The `var()` fallbacks repeat the initial values for engines without `@property` (Safari
    before 16.4, Firefox before 128).
- **The grab strip.** It is 12px wide and lies on the panel's side of the edge, reaching only
  2px over it, so the neighbouring page's or chat's scrollbar still scrolls.
- **The canvas header** fits its panel down to the 320px minimum. It is a container query on
  the canvas (`vc-canvas`).
  - The file name gives way to an ellipsis inside its pill first. The pill is never narrower
    than its icon, and nothing spills out of it.
  - Then the buttons get smaller.
  - Below the minimum, Show in Files goes, then Copy.
  - On the Windows desktop app, whose header also leaves room for the window buttons, those two
    go at 420px and 380px.
- **Phones.** Every panel is a full-screen sheet and has no handle.

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
| Default account and model | `project.json` → `provider`, `modelSettings` | The owner (Settings tab). A new chat in the project starts on it; any one chat can still pick another. Optional: see Which model a new chat starts on. |
| Instructions | `project.json` → `instructions` | The owner. |
| Memory | `<CHAT_PROJECTS_DIR>/<id>/memory.md` | The agent, with its own file tools; the owner can edit it on the Memory tab. |
| Files | `project.json` → `files` (upload ids) | Uploaded on the Files tab, attached in any of the project's chats, or made by the agent in one (`source`: `upload`, `chat`, `agent`). |

### Which model a new chat starts on

Most specific first, the same in the dashboard, the app and the bridge
(`threadChoice` and `projectDefault` in `web/src/chat/store.ts`, the app's copy,
`projectModelDefault` in `chat/projects.mjs`):

1. The chat's own choice: what is stored on the thread (`provider`, `modelSettings`),
   or for an older chat the model that last answered it.
2. For a chat not yet sent, a model picked in its composer. The pick belongs to the
   place it was made in (Home, that project or that folder) and is dropped once the
   chat is sent, so it never becomes the next chat's model.
3. The folder's own default.
4. Its project's default (a folder with none of its own follows its project).
5. Settings → Providers.

A project's or folder's `modelSettings` only apply on its own account. A new project
or folder has no default of its own, so it follows its project or Settings → Providers until
the owner picks one; "Use …" on the Settings tab clears a picked one back to that.
(One made from the dashboard before 2026-11 holds a copy of the global default taken
when it was made, which reads as its own pick until cleared.) An account that is no longer enabled is passed
over. An existing chat never takes a model picked in another chat. A chat an agent
makes with `threads__create` is stored with the resolved account and model before
anything runs, the model always named (`newChatChoice` in `chat/route.mjs`: a default
that names none gets the one a run on that account would use), so the composer shows
it, a `start` run uses it, and a later change in Settings → Providers does not move it.

Home's new chat shows a "Start in" row under the composer: the six most recently
updated top-level projects, each with its icon. Picking one opens that project's
home for a new chat and carries over anything already typed.

Every turn of a project chat, resumed or not, carries `projectBlock` (`chat/turn.mjs`):
the instructions, the memory file's path with a one-line summary (size, entries, last
updated to the minute, section headings; `memoryFileStats` in `chat/memory-ref.mjs`) and
the rule for keeping it, and
every file's path. Chats never read each other's transcripts; the memory is how one
chat's conclusions reach the next.

- **Memory is read on demand, never pasted.** The memory used to be pasted into every
  turn (up to 12,000 characters, the parent's too), and a resumed session keeps every
  earlier turn, so a long chat carried one more copy per turn. Now the prompt names the
  file and tells the agent to read it when the request may depend on earlier decisions,
  facts or preferences, to read it before changing it, and to read it again when the
  summary has changed since it last did (another chat or a totem run wrote it; the
  resumed session's copy is stale). Codex's sandbox limits writes, not reads, and Cursor
  reads anywhere. Claude gets `Read(…)` allow rules for every path it may write and for
  the parent's memory, so a Supervised chat does not stop to ask. OpenCode asks before
  touching a path outside its working folder (`external_directory`) and `opencode run`
  cannot ask, so when the memory is outside `AGENT_CWD` an OpenCode turn gets the file's
  first 4,000 characters instead (`memoryStatsFor` in `bridge.mjs`). Paths are made
  absolute, so a relative `CHAT_PROJECTS_DIR`/`TOTEMS_DIR` names the bridge's file, not
  one under the agent's folder. Owner-written instructions stay inline. Totem runs and
  asks are the exception (`docs/totems.md` → A run).

- **The panel is scoped.** Home shows the project list and chats in no project. Opening
  a project (or one of its chats) swaps the panel to that project's chats. The URL
  carries `?project=<id>` alongside `?thread=`.
- **A project chat is never temporary.** `projectId` is fixed when the chat is created
  (`POST /api/chat` with `projectId`); afterwards only `PUT /api/threads/:id {projectId}`
  moves it, and a chat moved in brings its attachments and documents into the files.
- **Claude needs explicit write paths.** A `claude -p` run cannot ask for permission, so
  the chat passes `--allowedTools Read(…)/Edit(…)/Write(…)` for exactly the chat's outputs
  folder, the owner's memory repo (`MEMORY_ROOT`) and the project's `memory.md`
  (`allowWrite` in `spawnClaudeStream`), and `Read(…)` plus an Edit/Write deny for a
  folder chat's parent memory (`readOnlyPaths`). Without it the
  memory write is refused and Haiku still tells the owner it saved the note.
- **Removing a file** drops it from the project; the bytes go only when no chat message
  still shows it. **Deleting a project** deletes its files, instructions and memory (and
  its folders') and moves its chats to Home. Thread deletion and the orphan sweep leave
  project files alone.
- **A picture instead of an icon.** Settings → Icon also takes an uploaded image or a
  website's own icon (`image`, an upload id; the bridge adds a signed `imageUrl`). "Use
  site icon" has the bridge read the page's `<link rel=icon>`/apple-touch-icon tags, then
  `/apple-touch-icon.png` and `/favicon.ico`, and keep the first that is really a PNG,
  JPEG, GIF, WebP or ICO (`chat/favicon.mjs`; SVG is refused because uploads are served
  inline from the bridge's origin). Picking an icon, or replacing the picture, drops the
  old upload; the orphan sweep leaves a project's picture alone.
- **Project context can be off for one chat.** `projectContextOff` on the thread (the
  folder button in the top bar, or the chat's menu) leaves out `projectBlock`, keeps the
  chat's attachments and documents out of the project's files, and drops the memory from
  `allowWrite`. It still starts on the project's default model. It can be switched either
  way at any turn.

### Folders

A folder is a project with a `parentId`: one level only, inside a top-level project
(the API refuses a folder in a folder). It has its own instructions, memory and files.
Its chats get the parent's instructions, files and the path of its memory as read-only
context (`projectBlock(..., { parent })`; the parent memory is named only when it has
entries, and Claude is denied writing it) and keep only the folder's memory, so a side topic
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
pages of 25. The open chat always shows, even on a folded shelf. The chat lists have no
search box of their own: the Search tab finds any chat, parked or not.

The iPhone app draws no shelves in its drawer, which has one scroll: each list's
Snoozed and Settled are a button with a count (a dot when the open chat is on it), Home's
or the open project's in the drawer's foot beside Settings and a folder's under its
chats, and a button opens a three-quarter sheet of those chats with a switch between
the two (`mobile/src/features/chat/ShelfSheet.tsx`). The app shows no toasts but errors,
so its settle has no Undo toast; Un-settle in the sheet puts a chat back.

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
| `POST /api/chat/projects` | `{name, icon?, image?, instructions?, provider?, modelSettings?, parentId?}` (`image`: an image upload id) | `{project}` (with `parentId`, a folder) |
| `GET /api/chat/projects/:id` | | `{project}` with signed `files` and `memory` |
| `PATCH /api/chat/projects/:id` | any of the create fields (`null` clears) | `{project}` |
| `DELETE /api/chat/projects/:id` | | `{ok, movedChats, removedFolders}` |
| `POST /api/chat/projects/:id/memory/move` | `{entries}` (entry texts; folder only) | `{moved, project}` |
| `POST /api/chat/projects/:id/files/move` | `{ids}` (folder only) | `{moved, project}` |
| `POST /api/chat/projects/:id/favicon` | `{site}` (a domain or URL) | `{project}` wearing the site's icon |
| `PUT /api/chat/projects/:id/memory` | `{memory}` | `{memory}` |
| `POST /api/chat/projects/:id/files` | `{uploadIds}` (uploaded via `/api/chat/uploads` first) | `{added, project}` |
| `DELETE /api/chat/projects/:id/files[/:uploadId]` | `{ids}` without a path id | `{removed, project}` |

### Agents panel

When a chat's agent hands work to another agent, the reply shows the call outside the step
list, in a group T3 Code style (`AgentGroup`): agents started back to back share one group
headed "N subagents · N working" with their avatars and the time since the first started,
folding open (open by default) to one row per agent with its status and what it is doing
now. The chat header gets an Agents chip. A row or the chip opens the Agents panel (`web/src/chat/AgentsPanel.tsx`)
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
replies, marks it read (the row's Mark as read button), settles or snoozes it. A chat whose
agent staged an inbox proposal still waiting on him stays, read or not, as "Waiting on your
approval: <title>" (see Approval cards), and the pill counts it as "waiting on you". Totem chats
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

| `totem_threads_projects` (`threads__projects`) | Every chat project with its folders: id, name, chat count, the project's instructions clipped. |
| `totem_threads_create` (`threads__create`) | Makes a chat. `project` is a project or folder by id or name (`home` or nothing for none); `folder` is a folder inside it, made when none there has that name (folders stay one level deep). `message` is the Markdown the chat opens with, as an assistant message, and marks it waiting on the owner (`needsReply`). The chat is stored with the folder's default account and model, else its project's, else Settings → Providers (see Projects → Which model a new chat starts on), so the composer shows it from the first message. `start` also sends a first request and starts a run in the new chat through `startChatTurn`, on that model. There is no model argument: the owner sets the model per folder. `key` (a ticket number, an email id) is stored as `sourceKey`, and a second call with the same key returns the chat already made (`created: false`). Logged as `chat.create`. |

List, read and projects are read-only and local (`ANN.readLocal`), so ChatGPT and Claude on `/mcp` get them too. Create is a local write; it exists so a totem that finds new work (a ticket, an email) can open a chat for it where the owner will look.

## Chat about this

Any card can start a chat that already knows what the card shows. On the dashboard and
the desktop app there is no button on the card: right-click opens a menu (Chat about
this, Copy card as text). Text selected on the card goes with the chat, quoted above the
card's facts, and the menu then reads Chat about the selection and adds Copy, so taking
over right-click on a selection loses nothing. The selection is read when the right
button goes down, because macOS selects the word under the pointer before it sends
`contextmenu`; that word is not a selection and is cleared again. Shift+right-click, a link
or a field keep the browser's own menu. On a phone a long press opens the same menu when the finger
lifts; the lift's touchend is cancelled so it is not also a tap on the card, and only the
click that follows within 400 ms is swallowed. In the iPhone app a long press opens an
action sheet (Overview cards, habit and Fleet cards, a machine's header); tasks and goals
have the item in their own menus instead.

The context is a short Markdown attachment, not a message: the card's facts as text,
then where it lives (page, route, the dashboard, app and bridge files that draw it). It
goes up as a text upload, waits in `chat/pendingContext.ts` as Search's "Add to chat"
does, and lands in a new chat's composer as a chip on Home. Nothing is sent until the
owner sends it.

- `web/src/chat/about/context.ts`: one serializer per card (`scheduleContext`,
  `tasksContext`, `goalContext`, `todoContext`, `habitContext`, `systemContext`,
  `fleetDeviceContext`, `devRepoContext`, …). `contextMarkdown` clips every line to 300
  characters and the route to 200, and stops at 40 lines or 3,000 characters.
- Known token formats are redacted from everything a card shows, before it is cut, so a
  token at the edge of a clipped field leaves no prefix behind: GitHub, OpenAI/Anthropic,
  AWS key ids, Google (`AIza…`, `ya29.…`) and Slack tokens, JWTs, private-key PEM blocks
  (to the END line, or to the end of a cut), `Authorization:` headers of any scheme,
  bearer and base64-looking basic credentials, URL `user:password@`, query and signed-URL
  values whose parameter name is a secret word (`?token=`, `api_key=`, `X-Amz-Signature=`,
  `?code=`; matched as whole `_`/`-` words, so `monkey=` stays), `"accessToken": "…"`-style
  quoted pairs, `UPPER_SNAKE_KEY=value` pairs, and any other run of 40+ base64 characters
  with at least two capitals, two small letters and two digits (a commit SHA, a UUID or a
  date does not qualify). A route is redacted, decoded run by run, then redacted again,
  so `%26` cannot split a secret and `%3D` cannot hide one.
- The patterns live in `chat/redact.mjs`, which the bridge's own `redact()` uses too;
  `web/src/chat/about/redact.ts` and the app's copy are byte-for-byte the same
  (`places.test.ts`). Every pattern is linear (a name starts only at the start of its run,
  with a bounded length), because command output passes through it; text past 200,000
  characters is cut, not passed on unchecked. `chat/redact.corpus.mjs` holds the shapes
  and the ordinary text both test suites run. A token in a shape none of them knows still
  gets through.
- `web/src/chat/about/places.ts`: each place's route and files. `places.test.ts` fails
  when a listed file is gone, when a route does not survive `parseLocation`/`buildPath`,
  and when the app's copies of `places.ts` and `context.ts` (`mobile/src/lib/chat/about/`)
  differ from the web's.
- `web/src/chat/about/ChatAbout.tsx`: dropped inside a card, it adopts the card (its
  parent, or `host`) and adds the button and both menus; a nested card answers first.
  `of` receives the card's element. App installs the router and the sign-out
  (`installChatAbout`); without them `startChatAbout` throws before uploading anything.
- A card gets it with one line: `<ChatAbout of={() => goalContext(goal)} host=".goal-card" />`.
  A new card adds a serializer, a place, and that line.

**Settings.** Offered on General, Appearance, Chat, Voice, Notifications, Keyboard,
Providers, Tasks and Security (`SETTINGS_ABOUT`). Activity, Connections, Skills and Usage
are left out: they show tool output, server addresses, sign-in links and prompts. A pane is read
by allowlist (`settingsOutline.ts`): headings, each `.setting-row` label, and the state of
a switch, checkbox or select. Text fields, textareas, `<pre>` and `<code>` are never read.
The iPhone app's Settings panes have no entry point on purpose: they have no DOM to read
by allowlist, and each would need its own serializer.

No screenshot is attached: the dashboard has no DOM-to-image library, and the text is
what the agent can act on.

## Testing

```bash
node --test chat/chat.test.mjs chat/projects.test.mjs
node --test chat/visuals.test.mjs   # renders a real page in Chromium when the box has one
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
