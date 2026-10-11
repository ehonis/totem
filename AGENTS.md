# AGENTS.md — Totem

Operating manual for any human or AI agent working on this repository. Read it first: it
explains how the system fits together, where things live, the rules the code depends on, and
how to run and test it.

If `AGENTS.local.md` exists, read it too: it holds the owner's deployment-specific notes.
It is gitignored and never part of the public repository.

> **Keep this file accurate.** A change that adds a feature, alters behaviour, adds a setting,
> swaps a backend or changes how Totem is run updates this file in the same change. If you
> learn a gotcha the hard way, add it to "Gotchas". Deployment-specific facts (hostnames,
> accounts, personal workflows) belong in `AGENTS.local.md`, not here.

---

## 1. What this is

Totem is a self-hosted, single-owner personal assistant. One Node process (`bridge.mjs`)
serves a React dashboard and an HTTP API, runs scheduled jobs, and answers requests by spawning
whichever agent CLI is configured (Codex, Claude Code, OpenCode or Cursor). The agent acts on the
owner's local data (tasks, goals, habits, lists, a Markdown notes repo) and on connected services
(Google Calendar, GitHub, Strava, WHOOP, Plaud, MCP servers).

A fresh install is a blank canvas: no account until the owner creates one, no AI until one is
set up, no scheduled jobs running, no personal prompts or data.

Docs, by job:
- `README.md` — what it is, features, quick start.
- `docs/self-hosting.md` — sign-in, settings vs env, Docker, systemd, data and backups.
- `SETUP.md` — the out-of-browser steps: phone shortcut, Tailscale, MCP servers, jobs.
- `mobile/AGENTS.md` — the iPhone app: how it mirrors the web, building and shipping it.
- `docs/*.md` — one file per subsystem (see the map below).
- `TOTEM-OVERVIEW.md` — the design write-up.
- This file — the mental model and the rules for changing the code.

## 2. Request flow

```
Phone shortcut / mobile client        Web dashboard (React, served by the bridge)
  POST /ask, /ask-text                  /api/*  (session cookie or bearer)
  Authorization: Bearer <BRIDGE_SECRET>
                 │                                 │
                 └──────────────► bridge.mjs ◄─────┘   port BRIDGE_PORT (8787)
                                    │
     direct reads/writes: tasks, goals, lists, habits, calendar, notes, usage
                                    │
                            runAgent(): spawn the selected agent CLI
                              codex exec | claude -p | opencode run | cursor-agent -p
                                    └─ mcp-gateway.mjs → Totem tools + manifest MCP servers
```

The dashboard reads data directly; the agent is used for chat, phone requests, jobs and
open-ended work. The default provider and model come from Settings → AI (stored in
`data/provider-config.json`); `AGENT_BACKEND`/`AGENT_MODEL` are only first-run fallbacks.

## 3. Map of the code

| Area | Where | Notes |
|---|---|---|
| Server | `bridge.mjs` | HTTP routes, prompts, agent backends, scheduler tick, OAuth clients for WHOOP/Strava/Calendar. Large on purpose; new subsystems go in their own directory and are composed here. |
| Sign-in | `auth/owner.mjs`, `auth/http.mjs`, `web/src/components/AuthGate.tsx` | One owner. First run prints a one-time `/setup?token=…` link; scrypt password in `data/auth.json` (0600); signed httpOnly `SameSite=Lax` cookies, `Secure` behind https; change password bumps a session version. `BRIDGE_SECRET` bearer always works. `TOTEM_AUTH=proxy` trusts an auth proxy. `/mcp` accepts only the bearer or a Cloudflare Access JWT. |
| Settings stored outside `.env` | `ai/settings.mjs` | `createEnvBackedSettings`: values entered in the dashboard, kept in a 0600 file, applied to `process.env` unless the real environment already sets them. Used for Settings → AI (`data/ai-settings.json`: agent CLI API keys) and Settings → Integrations (`data/integrations.json`: `PUBLIC_URL`, WHOOP/Strava client credentials, task sheet settings). Secrets are never returned unmasked. |
| Agent accounts | `providers/instances.mjs`, `web/src/components/ProvidersView.tsx` | An account is an instance id (`codex`, `codex_work`, …) over a driver. Claude isolates logins with `CLAUDE_CONFIG_DIR`, Codex with a shadow `CODEX_HOME`. See `docs/providers.md`. |
| Chat access and Claude tools | `providers/claude-tools.mjs`, `web/src/chat/AccessControl.tsx`, `web/src/components/ClaudeToolsPanel.tsx` | A chat's access (Supervised / Auto-accept edits / Auto / Full access, default Full) maps to each CLI's permission mode or sandbox. Settings → Connections › Claude tools pulls the connectors each Claude account has and switches servers and tools on or off (`data/claude-tools.json`); on means allowed, off means denied on every Claude run. `docs/chat.md` → Access. |
| AI usage meters | `ai-usage/` | Polls each CLI's quota windows. Claude and Cursor polling are opt-in (`AI_USAGE_CLAUDE_OAUTH`, `AI_USAGE_CURSOR`, or Settings → Usage): Claude's refreshes Claude Code's own login, Cursor's calls a private endpoint. See Gotchas. |
| Tasks | `todos/` | SQLite (`data/todos.db`, `node:sqlite`, WAL, foreign keys, ordered migrations). `service.mjs` is the only business-rule boundary; `commands.mjs` routes every mutation (local by default; GitHub or Sheet only with an explicit `syncTarget`); `http.mjs` and `mcp.mjs` are adapters. Personal or Ventures; a Ventures task carries one venture tag from the install's own list (`todo_preferences` key `ventureTags`, edited in Settings → Tasks). |
| Task connectors | `todos/connectors/` | GitHub issues (App or `gh` CLI; `docs/github-app.md`) and a Google Sheet of action items (`task-sheet-*`, configured by `TASK_SHEET_*`; `docs/task-sheet.md`). Both write through a leased SQLite outbox and fail closed when unconfigured. |
| Goals | `goals/` | Weekly/monthly/yearly goals with metrics and one level of steps, in the task database. `docs/goals.md`. |
| Search | `search/`, the "Search" block in `bridge.mjs`, `web/src/components/SearchView.tsx` | Keyword search (in-memory SQLite FTS5, no model) over notes, journal, chats, tasks, goals, lists and project/totem memory, rebuilt lazily when 30 s stale. The Search tab's "Add to chat" saves a result as a text upload and drops it into the composer (`web/src/chat/pendingContext.ts`). Agents get `totem_search_everything`/`totem_search_read` (`search__*` in the gateway). `docs/search.md`. |
| Lists | `lists/` | Simple checklists with optional links to tasks. |
| Voice journal | `journal/`, `web/src/journal/` | Record in the browser, transcribe on the box with whisper.cpp, digest into the notes repo after a grace period. `docs/journal.md`. |
| Notifications | `notify/`, `web/public/sw.js` | Web Push (RFC 8291/8292 on `node:crypto`) and APNs for the native iPhone app (`notify/apns.mjs`, `APNS_*`), a due-queue drained on the job tick, digests, feed scan, quota nudges. `docs/notifications.md`. |
| Totems | `totems/`, the "Totems" block in `bridge.mjs`, `web/src/components/TotemsView.tsx`, `web/src/totems/` | Desktop shows a three.js lobby (lazy chunk; phones and no-WebGL get the list). Standing agents over the job store: every job is a totem (no second scheduler). Agent totems keep `data/totems/<id>/memory.md`, end runs with `NOTIFY:`/`QUIET`, post runs to their chat `totem-<id>`, and get cheapest-first model recommendations from the builder or any model from the chat picker (`modelsOnly`). The builder asks scoping questions in a chat beside the draft and revises it on each reply; an unfinished design is a draft (`totems/drafts.mjs`, `data/totem-drafts/`). A totem can wake on a watch (git branch or web page) instead of a schedule; the built-in "Deploy Totem" pulls, rebuilds and restarts the bridge when main moves. Any chat can propose a change (Accept card). Replaced Studio. `docs/totems.md`. |
| Jobs | `jobs/` | Timezone-aware schedules (`daily`, `weekly`, `interval`, `window`), watch triggers over one or more git branches or pages, checked without AI (`jobs/triggers.mjs`), and `data/jobs.json`. One 30-second tick in `bridge.mjs` runs jobs, checks watches and drains notifications. `docs/jobs.md`. |
| Skills | `skills/` | Every prompt as an editable `SKILL.md` with `{{variables}}`. Generic seeds in `skills/seeds/` are copied into `data/skills/` once. Chat cites a skill with `/name` anywhere in a message; the owner's Claude Code/Codex/Cursor skills are found read-only by `skills/agent-skills.mjs` and cited the same way. `docs/skills.md`. |
| Examples | `examples/` | Optional personalised skills, never installed automatically. |
| Action log, approvals, runs | `logs/` | Every mutation is audited; MCP clients act through owner-approved, time-boxed leases. `docs/logs.md`. |
| Inbound MCP server | `POST /mcp` in `bridge.mjs` | For ChatGPT / Claude / Claude Code. Every tool has a title, all four annotation hints and an output schema (`MCP_TOOL_META`); a boot assertion enforces it. A sentence meant for the owner is `tellOwner`; `tellEthan` is sent alongside as a deprecated alias. `docs/totem-mcp-server.md`. |
| Outbound MCP gateway | `mcp-gateway.mjs` | One stdio MCP server each agent CLI registers; exposes built-in `tasks__*`, `goals__*`, `lists__*`, `strava__*` plus every manifest server. Not the same thing as `/mcp`. |
| Integrations | `strava/`, `whoop/`, WHOOP and Calendar blocks in `bridge.mjs`, `camera/` | Strava (`docs/strava.md`), WHOOP sleep (`docs/whoop-sleep-ingest.md`; filled into a habit hidden from the dashboard and shown in Bushido via `/api/whoop/training`), photo sync from a camera card (`docs/camera-sync.md`). |
| Apple data | `apple/`, the "Apple" block in `bridge.mjs`, the Messages view in `web/src/messages/` | macOS only, off unless `APPLE_ENABLED=true`. Reads Messages (`chat.db`), Contacts and Photos (`Photos.sqlite` plus Photos' own search index) read-only; sends through the Messages app with `osascript`. The owner sends from the Messages tab (not on the phone drawer; `/messages` still opens); agents only stage an `imessage` inbox proposal (`totem_apple_propose_message`), which only the dashboard can accept. `docs/apple.md`. |
| Chat | `chat/`, the "Web chat" block in `bridge.mjs`, `web/src/chat/` | Server-owned threads and runs that outlive the browser (`POST /api/chat` streams SSE; `GET /api/chat/runs/<thread>/stream?since=` re-attaches; only `POST /api/chat/stop` ends a run early; `POST /api/chat/steer` sends the owner's words into a running reply, live for Claude, interrupt-and-resume for the rest, `chat/steer.mjs`). Native per-provider session resume, attachments, named tool cards, per-reply stats (setting, effort, tokens, tok/s, cost; `chat/stats.mjs`, shown on hover by `TurnStats.tsx`), no modes (every chat run gets the browser, computer use where the account has it, and an hour; the agent decides, `chat/reach.mjs`), the model picker (`ModelPicker.tsx`; no automatic routing since Auto/Instant/Thinking were retired), thread titles and icons, local whisper.cpp dictation and an optional OpenAI Realtime voice mode. `docs/chat.md`. |
| Chat projects | `chat/projects.mjs`, `web/src/chat/Project*.tsx` | Chats grouped with a shared default model, owner-written instructions, an agent-kept `memory.md` and shared files (`data/chat-projects/`). One level of folders (`parentId`) that read the parent read-only and keep their own memory; a chat can turn project context off (`projectContextOff`); finished chats wait on the owner (`needsReply`) until the owner opens one, replies or marks it read; "Mark as unread" sets `keepUnread`, which opening does not clear. Every list (Home, project, folder) ends with its own Snoozed and Settled shelves, T3 Code style (`web/src/chat/settle.ts`; auto-settle and wake-up are computed on read, never written). The chats panel is scoped to Home or one project; chats drag onto folders and projects. `docs/chat.md` → Projects. |
| Sub-agents | `chat/subagents.mjs`, `web/src/chat/AgentsPanel.tsx` | Agents a chat's agent starts: Claude's Agent/Task sub-agents (events tagged `parent_tool_use_id`), Codex collab children, and another CLI run from a shell (`codex exec`, `claude -p`, …), whose own session log is found by start time and prompt and tailed. Each folds into its tool card as `part.agent` (status, model, tokens, steps). The Agents panel beside the chat lists them and opens each one's live log. Each writes an `agent.delegate` line to the action log. `docs/chat.md` → Agents panel. |
| Running chats | `web/src/chat/RunningChats.tsx`, `web/src/chat/onScreen.ts` | Bottom-right panel of chats answering or finished-but-unread (`needsReply`) out of sight, grouped by project and folder, with open, stop, snooze, settle and mark as read; finished replies also toast. "Out of sight" means not open and no row at least half on screen; a new list of chats should give its rows `useRowOnScreen`. `docs/chat.md` → Running chats panel. |
| Other chats, for agents | `chat/thread-tools.mjs`, `totem_threads_*` in `bridge.mjs` | `totem_threads_list`/`totem_threads_read` (`threads__*` in the gateway) let an agent list and read the owner's other chats (running, waiting, settled, by project or keyword). Every chat turn with the gateway on is told its own chat id and to use them only when the owner points at another chat or the turn truly needs one (`threadsRule`); keep that restraint in any change. `docs/chat.md` → Other chats. |
| Agent browser | `browser/`, `web/src/chat/BrowserPanel.tsx` | A headless Chromium driven by `playwright-core` behind T3 Code's `preview_*` tool names, served to each chat run over a per-run loopback MCP endpoint (`/agent-mcp`). **Offered to every dashboard or app chat run** (not voice turns); the prompt has the agent use it only when a request needs it and ask first when unsure (`chat/reach.mjs`). Never give it, or computer use, to the phone path (`limitReach` in `runAgent` enforces it) or to jobs; a totem gets the browser only through its own `browser` switch. |
| Gmail | `gmail/`, the "Gmail" blocks in `bridge.mjs`, Settings → Connections › Mail | The owner's Gmail accounts over the Calendar OAuth client (`gmail.modify`; tokens in `data/gmail-tokens.json`, 0600). Agents get `totem_gmail_*`/`gmail__*`: search, read, labels, archive, trash, drafts. No send tool: `propose_email` stages an `email` inbox item that only the dashboard sends or saves as a draft, and the card shows the email as it will arrive. Tools register only when the OAuth client exists. `docs/gmail.md`. |
| Dev tab | `dev/`, `web/src/components/DevView.tsx` | CI on each repo's default branch, open PRs with check and AI review state, self-hosted runners, a per-repo AI review switch (the repo variable `AI_REVIEW`), a one-off Review button per PR (dispatches `review.yml`), and per-repo setup status (review workflow, self-hosted runner, `CLIPROXY_API_KEY` secret) pointing at `/review-ci-setup` when something is missing. Totem reads GitHub through the service user's `gh`; it writes only that variable and the dispatch. Watched repos are picked from "All repositories" in the tab and kept in `data/dev.json` (`DEV_CONFIG_FILE`); none means off. A watcher notifies when CI on a default branch newly fails or a runner goes offline. `POST /api/alerts/:source` takes alerts from outside (PostHog and others) before the auth gate, guarded by `ALERT_INGEST_TOKEN` (404 without it), and pushes them as `alert.external`, collapsing repeats within the hour (`dev/alerts.mjs`). `docs/dev-tab.md`. |
| Web terminal | `terminal/` | Optional PTY shell over a WebSocket, off unless `TERMINAL_ENABLED=true`. `docs/terminal.md`. |
| Screen | `screen/`, `web/src/screen/` | The machine's desktop in a desktop-only tab: noVNC in the browser, a byte relay at `/api/screen/ws` to the VNC server (macOS Screen Sharing on 127.0.0.1:5900) with the terminal's handshake auth, and the Mac's own login inside VNC, which "Remember for" (30 min to 5 h) seals server-side under `data/screen-credentials.key` so the browser holds only an expiring token (`screen/credentials.mjs`). Agents get `screen__screenshot`/`screen__get_status` (look only; `screencapture` needs Screen Recording for the node binary). Off unless `SCREEN_ENABLED=true`. `docs/screen.md`. |
| Dashboard | `web/` | Vite + React + TypeScript + Tailwind, built to `web/dist`. Paths are real routes (`web/src/router.ts`). The shell (`components/Shell.tsx`, `shell.css`) is an icon rail plus a collapsible chats panel on desktop and a top bar with a swipe-in drawer on a phone (Settings is an icon pinned at the bottom of both: the rail's foot, the drawer's bottom right); the Overview (`components/OverviewView.tsx`, `components/overview/`) is a single page of today's schedule, tasks, goals and habits. Pages in `GLOW_TABS` (`App.tsx`) sit over a slow-drifting colour glow, one pair of colours per page (`glow.css`; the iPhone app's `PageGlow` mirrors it). Logo assets are generated by `scripts/build-logo-assets.mjs` from `web/assets-src/`; edit the source, not the outputs. |
| iPhone app | `mobile/` | Expo / React Native rebuild of the dashboard's phone layout, with native sheets, menus, swipes and push. Its own `package.json`, not a workspace: the bridge's install and build never touch it. Ports `web/src` logic into `mobile/src/lib/` at the same paths, so a change to `web/src/api.ts` or `chat/store.ts` is ported there too. Read `mobile/AGENTS.md` before changing it. |
| Notes repo | `data/brain` (gitignored) | The owner's Markdown second brain, its own local git repo. `brain.example/` is the starter layout. |

## 4. Defaults and settings

- **Everything optional is off on a fresh install.** Every seeded job is created disabled except
  the two local task-board housekeeping jobs, which only apply archive/retention preferences.
  The GitHub task sync turns on only with a configured GitHub App or
  `GITHUB_TODOS_SYNC_ENABLED=true`. `jobs/defaults.test.mjs` enforces this.
- **Existing installs keep their behaviour.** When a default changes, the new value applies to
  fresh installs only. Detect an existing install from data that predates the process
  (`EXISTING_INSTALL` in `bridge.mjs`, rows already in a table) and record the decision once.
  `data/jobs.json`, `data/provider-config.json` and seeded skills are never re-seeded over.
- **Env wins over dashboard settings**, except `AGENT_BACKEND`/`AGENT_MODEL` and the
  `*_ENABLED`/`*_TIME` job seeds, which only apply before the stored config exists.
- **Sibling apps are optional.** The Bushido goal toggle appears only with `BUSHIDO_URL`.
- **Who the owner is** comes from `OWNER_NAME`; prompts otherwise say "the owner".
- `.env.example` documents every variable.

## 5. Rules the code depends on

- **Direct reads, agent writes.** Dashboard data comes from the bridge reading its own stores
  or APIs, never from an agent round-trip.
- **Confirm-only for anything inferred.** Journal and meeting ingests, MCP-proposed commands and
  agent runs are staged in the inbox. Prepare the finished work before asking, so accepting is
  one call with nothing left to interpret.
- **Channels.** A request carries a channel. `http` (phone) replies are plain text with no
  Markdown and must not ask follow-up questions (they emit one `NEED_INPUT:` line instead);
  `web` may use Markdown and ask. Pick the channel deliberately when adding a front door.
- **Date grounding.** Every prompt carries the local date, a 14-day date table and an
  instruction to verify weekday/date pairs.
- **Memory is not the task list.** Completed actions and facts go to the notes repo; future
  obligations go to tasks or the calendar.
- **Tasks are local unless explicitly shared.** Only `syncTarget: 'github' | 'sheet'` reaches a
  connector. A connector that owns completion (GitHub, Sheet) is the only thing that may
  complete or reopen its tasks.
- **Nothing scheduled completes or postpones a goal.** `postponed_count` records the owner's
  decisions; automation reports and asks.
- **An unreadable metric is not zero.** A connector-fed goal metric that cannot be read is
  `available:false` and drops out of the progress mean.
- **Route every agent spawn through `runAgent`**, and give slow callers their own `timeoutMs`.
- **Audit once.** Domain services write the action log after a committed mutation; adapters do
  not log the same write again.

## 6. Running, building, testing

```sh
npm install                 # root deps, then the dashboard's (postinstall)
npm start                   # builds web/dist if missing, runs the bridge with .env if present
npm run build               # rebuild the dashboard after changing web/
npm test                    # bridge test suite (node --test)
cd web && npm test          # dashboard unit + vitest suites
cd web && npm run build     # typecheck (tsc --noEmit) + vite build, as CI does
```

The systemd user unit template is `assistant-bridge.service` (`npm run service:restart`,
`service:logs`, …). Docker: `docker compose up -d --build`. CI (`.github/workflows/ci.yml`)
runs the dashboard build and tests, and the bridge test suite with `npm ci --ignore-scripts`.

Useful focused commands:
- `node --test todos/*.test.mjs todos/connectors/*.test.mjs` — tasks, migrations, connectors
- `node --test goals/*.test.mjs`, `node goals/cli.mjs list|review`
- `node todos/cli.mjs sheet-inspect`, `node todos/cli.mjs github-check`
- `node mcp-gateway.mjs --status`
- `TERMINAL_E2E=1 node --test terminal/e2e.test.mjs` — drives a real shell
- `curl -s localhost:8787/health`

### Adding or syncing MCP servers
1. Prefer Settings → Connections. "Import from Cursor" seeds the manifest from an existing Cursor
   config.
2. The manifest is `data/mcp-manifest.json` (gitignored; env values can hold tokens). Local servers
   are `{ "transport": "stdio", "command", "args", "env" }`, remote ones
   `{ "transport": "http", "url" }`.
3. Sync writes each provider's native config (backing up what it replaces) and only touches
   servers whose ids are in the manifest.
4. Remote OAuth servers still need each CLI's own login after sync.

### Database migrations
Ordered modules in `todos/migrations/`, recorded by version in `schema_migrations`; each runs in
its own transaction. A migration may declare `foreignKeysOff` (the runner turns foreign keys off
around it and runs `foreign_key_check` before commit — required for any table rebuild, or the
DROP fires every `ON DELETE CASCADE`) and `backupBefore` (an existing database is copied with
`VACUUM INTO` first). Test a migration against a fixture built by the earlier migrations, check
row counts, ids and foreign keys, and run it twice.

## 7. Gotchas

- **Never hand-draw an icon.** The dashboard uses Heroicons (`web/src/icons.tsx`) and Tabler for
  what Heroicons lacks. Confirm a name exists
  (`ls node_modules/@tabler/icons-react/dist/esm/icons | grep -i <term>`) and import it deep and
  per-icon as a default export so the package tree-shakes. See `web/src/goals/sportIcons.tsx`.
- **Entry checks compare real paths.** Node resolves symlinks in `import.meta.url` but not in
  `process.argv[1]`, so a script launched through a symlinked checkout must use
  `isEntry(import.meta.url)` from `scripts/is-entry.mjs`. Otherwise it loads, decides it was
  imported, and exits 0 silently (an MCP client reports the gateway as "connection closed").
- **The bridge has dependencies.** After pulling changes to `package.json`, run `npm install` at
  the root or the service will not boot. `node-pty` is optional (it needs a C++ toolchain) and
  only the web terminal uses it.
- **systemd's PATH is not your shell's.** The bridge spawns agent CLIs by name; a unit without
  `~/.local/bin` and the node bin dir on `Environment=PATH` starts fine and then fails every
  request with "command not found".
- **MCP sync is config, not shared OAuth.** Each CLI keeps its own MCP tokens. Browser redirects
  to `127.0.0.1` must complete on the machine that owns the CLI's token store; the Connections
  tab has a callback-replay helper for redirects that landed elsewhere.
- **A retired model does not fail loudly.** Codex answers an unsupported model with a 400 and no
  assistant message, and exits 0. Model choices go through `resolveModelChoice()` against the
  live catalog, and a run with no assistant message throws.
- **Claude's model list is written by hand.** Claude Code has no model-list command, so a new
  Claude model appears in Totem's pickers only once it is added to `MODEL_SEEDS` in `bridge.mjs`
  (with a `note`), however recent the CLI is. Retire a model by moving its id to
  `CLAUDE_SUCCESSORS`, never by just deleting it, or a saved choice falls back to Opus.
- **`AGENT_TIMEOUT_MS` is a phone-request budget.** Long jobs pass their own `timeoutMs` to
  `runAgent`; Cursor answers a killed run with prose rather than an error, so treat a non-answer
  as a failure.
- **A web terminal counts keystrokes, not commands.** When reconstructing submitted lines, lose
  the label rather than store a secret; the password guard latches once armed. Only the e2e test
  against a real shell catches regressions there.
- **WHOOP refresh tokens rotate.** Every refresh voids the old refresh token, so two refreshes
  at once means one fails with a 400 (Bushido, Krakatoa and jobs all read through the bridge at
  the same moments). `whoopAccessToken` shares one in-flight refresh (`whoopRefreshing`); never
  spend the refresh token anywhere else, and never hold WHOOP credentials in a sibling app.
- **Strava's `start_date_local` is not an instant**: it is local wall-clock time with a `Z`
  appended. A missing scope is a 401 carrying `<scope>_permission missing`.
- **Web Push `Topic` must be ≤32 URL-safe base64 characters** or Apple drops the push with
  `400 BadWebPushTopic`.
- **Recording needs HTTPS.** `getUserMedia` is unavailable on plain-http origins other than
  localhost. Never pass a `timeslice` to `MediaRecorder.start()`; Safari's fragments do not
  concatenate reliably.
- **Journal entries are files, not rows**, so the task-database export format does not change.
- **The task export format is versioned** (`formatVersion` in `todos/db.mjs`); a restore refuses
  an older format rather than restoring with tables silently missing.
- **GitHub tracking is a union.** Assigned issues and watched repositories are searched
  separately and merged by numeric issue id. Only a 404 marks a link missing.
- **Claude quota polling uses Claude Code's credentials.** `ai-usage/providers/claude.mjs`
  refreshes the stored Claude Code login with the client id built into Claude Code and writes the
  rotated token back to wherever it read it: the credentials file on Linux, or on macOS the
  `Claude Code-credentials` login-Keychain item (`ai-usage/keychain.mjs`; default home only, the
  Keychain is only unlocked in the desktop session, and values go to `security` on stdin, never
  argv). Cursor reads `cursor-access-token` the same way on macOS. Cursor polling calls Cursor's private,
  undocumented usage endpoint. Both are off on fresh installs and recorded once in
  `data/ai-usage.json` (`ensureUsageOptIns`); a poller added later inherits the recorded
  decision rather than re-judging whether the install is new.
- **Never write a Keychain secret through `security`'s `-w` prompt.** It reads at most 128
  characters and stores the truncated value with exit 0; it destroyed the Mac's Claude login on
  the first token refresh. `ai-usage/keychain.mjs` feeds `add-generic-password -X <hex>` to
  `security -i` on stdin (a line over ~4 KB fails there too, so long values are refused before
  the refresh token is spent) and reads the item back to confirm.
- **Agents can read what the bridge's user can read.** Every agent CLI runs as the same user as
  Totem, in `AGENT_CWD` (default: the checkout), so `data/auth.json` (password hash and the key
  that signs session cookies), `.env` (`BRIDGE_SECRET`), stored API keys and `secrets/` are
  readable in principle. What each backend does about it:
  - **Claude Code**: Totem passes `--disallowedTools` deny rules for Read/Edit/Write on those
    paths (`claudeSecretDenyRules`). Verified to block the Read tool. It does not stop a
    shell command (`cat`) if Bash is allowed, which it is in a chat on Full access
    (`bypassPermissions`), or by the account's own settings or launch args.
  - **Codex**: `--sandbox workspace-write` (the default) and `read-only` restrict writes and
    network, not reads; there is no per-path read deny.
  - **Cursor** (`--force`) and **OpenCode**: no per-path deny switch; full user access.
  The only hard boundary is running Totem's data under a different user than the agents, or
  `AGENT_CWD` plus filesystem permissions that keep the agent user out of `data/`. Treat an
  agent as holding the owner's authority, which `BRIDGE_SECRET` in `.env` already implies.
- **A chat run is not its HTTP request.** Closing the browser only detaches a viewer; the agent
  keeps going and the reply is saved. Do not kill a run on `req.on('close')`. A message is not
  safe until the bridge sends `start`; `web/src/chat/store.ts` keeps an outbox in localStorage
  for sends that never reached it.
- **Offering the browser must stay free.** Every chat run is offered it, so `grantBrowserAccess` only mints a token and `/agent-mcp`'s `initialize`/`tools/list` answer from static descriptors; Chromium starts on the first `preview_*` call that needs a page. Anything added to the grant or the handshake that touches Playwright launches a browser on every chat turn (`chat/reach.test.mjs` checks the launch count).
- **Killing an agent CLI does not kill its tools.** Cursor runs each shell command in its own session, so a SIGKILLed `cursor-agent` leaves the command running under init. And the CLI on `PATH` may only be a launcher: npm's `codex` is a Node script that starts the native binary with inherited stdio, and SIGKILL cannot be forwarded, so killing the launcher left codex running with the run's pipes open (the chat stuck on "streaming", Stop doing nothing). Agent CLIs spawn in their own process group (`AGENT_SPAWN`, `trackAgent`), and Stop, steering and timeouts go through `killTree` (`scripts/kill-tree.mjs`), which kills the group plus the tree read from `/proc` (or `ps` on macOS) before killing. Tracked agents are killed when the bridge gets SIGTERM/SIGINT, since they no longer share its group.
- **A Codex turn can fail after it has started talking.** `codex exec --json` exits 0 and ends a failed turn with `turn.failed` (a usage limit arrives as `429 Too Many Requests`), often after a commentary message ("I'll check…"). That is a failed reply, not a finished one (`turnFailed` in `spawnCodexStream`). `error` events alone are not a verdict: codex also uses them for retries it recovers from ("Reconnecting... 2/5").
- **A sub-agent's events are not the reply's.** Claude Code streams a sub-agent's text, tool calls and prompt with `parent_tool_use_id` set. Treated as top-level, they leak into the reply's text and tool list and throw off the steering echo count, so `spawnClaudeStream` routes them to `onAgent` before anything else. A background Agent call's tool_result only means "launched"; it finishes on `task_notification`.
- **A message part type the thread store does not know is dropped on save.** `normalizePart` in `chat/store.mjs` lists them; a new part type goes there as well as in both `applyEvent`s.
- **`claude -p` cannot ask for permission.** A write the prompt asks for is refused unless the bridge allows that path (`allowWrite` → `--allowedTools Edit(…)`), and a small model may still tell the owner it saved. Any new "keep this file updated" rule needs its path added there.
- **Codex's sandbox has no network.** `workspace-write` blocks it, so a Codex run that must fetch the web (a totem watching a page) needs `network: true` on `runAgent`, which adds `sandbox_workspace_write.network_access=true`. Without it the run reports a DNS failure rather than erroring.
- **`codex exec` refuses MCP writes.** Its approval policy is `never`, so any tool without
  `readOnlyHint` fails with "requires approval". `spawnCodexStream` adds
  `default_tools_approval_mode="approve"` for the gateway (`codexGatewayApprovalArgs`), but only
  when `config.toml` defines it and the run is not read-only, because a `-c` override on an
  undefined server stops Codex starting with "invalid transport".
- **The address bar is normalised on boot.** `buildPath` keeps only the query params it knows (`?thread=`/`?project=` on chat, `?totem=` on totems, `?q=` on search, `?chat=` on messages). A new deep-link param must be added there, or anything that reads it after sign-in finds it gone; read one-time params at module load (see `AuthGate.tsx`).
- **`INVOCATION_ID` does not mean "I am the service".** A process started from a shell inside
  any systemd unit (T3 Code's, for one) inherits it. A test bridge that trusted it restarted
  the live `assistant-bridge`. Anything that restarts the unit must first check that
  `systemctl --user show -p MainPID --value <unit>` is its own pid, as `restartBridgeSoon` does.
  On macOS launchd's `XPC_SERVICE_NAME` is inherited the same way; `scripts/service-manager.mjs`
  checks the pid in `launchctl print` before `launchctl kickstart -k`.
- **Apple data needs grants on the node binary, by real path.** Reading `chat.db`, Contacts and
  Photos needs Full Disk Access, and sending needs Automation (node → Messages). Both belong to
  the resolved binary (`/opt/homebrew/Cellar/node@…/bin/node`), so a Homebrew node upgrade drops
  them silently. `GET /api/apple/status` names the path. An ssh session can read these files
  when the service cannot, so test access from a launchd-run process, not from a terminal.
- **Never select a raw date from `chat.db`.** Message dates are nanoseconds since 2001, past
  `Number.MAX_SAFE_INTEGER`, and `node:sqlite` throws a RangeError rather than rounding. Convert
  in SQL (`APPLE_MS` in `apple/messages.mjs`), or bind a BigInt when comparing.
- **An agent never sends a message.** `imessage` proposals are refused by `totem_resolve_inbox`
  even under an approval session (`doResolveInboxItem` checks `approvedVia === 'dashboard'`).
  Keep it that way for any new front door that can accept inbox items.
- **An agent never sends an email either.** `gmail.modify` lets the grant send, so the limit is
  code: `gmail.send()` is reachable only from accepting an `email` inbox item, and both its `accept`
  and `draft` actions need `approvedVia === 'dashboard'`. Never add a send tool; email bodies are
  untrusted input an agent reads.
- **noVNC needs an es2022 build target.** It uses top-level await, which Vite's default target
  cannot emit ("Top-level await is not available in the configured target environment").
  `web/vite.config.ts` sets the target; lowering it breaks the build, not just the Screen tab.
- **Screen Recording is per binary, like Full Disk Access.** `screencapture` from a process
  without it fails with "could not create image from display", not a permission error;
  `screen/index.mjs` maps that to the fix. Test it from a launchd-run node, not over ssh.
- **Google OAuth apps in Testing mode** only admit listed test users and their refresh tokens
  expire; publish the app once setup is stable.
