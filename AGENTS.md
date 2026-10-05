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
| AI usage meters | `ai-usage/` | Polls each CLI's quota windows. Claude and Cursor polling are opt-in (`AI_USAGE_CLAUDE_OAUTH`, `AI_USAGE_CURSOR`, or Settings → Usage): Claude's refreshes Claude Code's own login, Cursor's calls a private endpoint. See Gotchas. |
| Tasks | `todos/` | SQLite (`data/todos.db`, `node:sqlite`, WAL, foreign keys, ordered migrations). `service.mjs` is the only business-rule boundary; `commands.mjs` routes every mutation (local by default; GitHub or Sheet only with an explicit `syncTarget`); `http.mjs` and `mcp.mjs` are adapters. Personal or Ventures; a Ventures task carries one venture tag from the install's own list (`todo_preferences` key `ventureTags`, edited in Settings → Tasks). |
| Task connectors | `todos/connectors/` | GitHub issues (App or `gh` CLI; `docs/github-app.md`) and a Google Sheet of action items (`task-sheet-*`, configured by `TASK_SHEET_*`; `docs/task-sheet.md`). Both write through a leased SQLite outbox and fail closed when unconfigured. |
| Goals | `goals/` | Weekly/monthly/yearly goals with metrics and one level of steps, in the task database. `docs/goals.md`. |
| Lists | `lists/` | Simple checklists with optional links to tasks. |
| Voice journal | `journal/`, `web/src/journal/` | Record in the browser, transcribe on the box with whisper.cpp, digest into the notes repo after a grace period. `docs/journal.md`. |
| Notifications | `notify/`, `web/public/sw.js` | Web Push (RFC 8291/8292 on `node:crypto`), a due-queue drained on the job tick, digests, feed scan, quota nudges. `docs/notifications.md`. |
| Jobs | `jobs/` | Timezone-aware schedules (`daily`, `weekly`, `interval`, `window`) and `data/jobs.json`. One 30-second tick in `bridge.mjs` runs jobs and drains notifications. `docs/jobs.md`. |
| Skills | `skills/` | Every prompt as an editable `SKILL.md` with `{{variables}}`. Generic seeds in `skills/seeds/` are copied into `data/skills/` once. `docs/skills.md`. |
| Examples | `examples/` | Optional personalised skills, never installed automatically. |
| Action log, approvals, runs | `logs/` | Every mutation is audited; MCP clients act through owner-approved, time-boxed leases. `docs/logs.md`. |
| Inbound MCP server | `POST /mcp` in `bridge.mjs` | For ChatGPT / Claude / Claude Code. Every tool has a title, all four annotation hints and an output schema (`MCP_TOOL_META`); a boot assertion enforces it. A sentence meant for the owner is `tellOwner`; `tellEthan` is sent alongside as a deprecated alias. `docs/totem-mcp-server.md`. |
| Outbound MCP gateway | `mcp-gateway.mjs` | One stdio MCP server each agent CLI registers; exposes built-in `tasks__*`, `goals__*`, `lists__*`, `strava__*` plus every manifest server. Not the same thing as `/mcp`. |
| Integrations | `strava/`, `whoop/`, WHOOP and Calendar blocks in `bridge.mjs`, `camera/` | Strava (`docs/strava.md`), WHOOP sleep (`docs/whoop-sleep-ingest.md`), photo sync from a camera card (`docs/camera-sync.md`). |
| Web terminal | `terminal/` | Optional PTY shell over a WebSocket, off unless `TERMINAL_ENABLED=true`. `docs/terminal.md`. |
| Dashboard | `web/` | Vite + React + TypeScript + Tailwind, built to `web/dist`. Paths are real routes (`web/src/router.ts`). Logo assets are generated by `scripts/build-logo-assets.mjs` from `web/assets-src/`; edit the source, not the outputs. |
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
1. Prefer Studio → Connections. "Import from Cursor" seeds the manifest from an existing Cursor
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
- **`AGENT_TIMEOUT_MS` is a phone-request budget.** Long jobs pass their own `timeoutMs` to
  `runAgent`; Cursor answers a killed run with prose rather than an error, so treat a non-answer
  as a failure.
- **A web terminal counts keystrokes, not commands.** When reconstructing submitted lines, lose
  the label rather than store a secret; the password guard latches once armed. Only the e2e test
  against a real shell catches regressions there.
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
  rotated token back to its credentials file. Cursor polling calls Cursor's private,
  undocumented usage endpoint. Both are off on fresh installs and recorded once in
  `data/ai-usage.json` (`ensureUsageOptIns`); a poller added later inherits the recorded
  decision rather than re-judging whether the install is new.
- **Agents can read what the bridge's user can read.** Every agent CLI runs as the same user as
  Totem, in `AGENT_CWD` (default: the checkout), so `data/auth.json` (password hash and the key
  that signs session cookies), `.env` (`BRIDGE_SECRET`), stored API keys and `secrets/` are
  readable in principle. What each backend does about it:
  - **Claude Code**: Totem passes `--disallowedTools` deny rules for Read/Edit/Write on those
    paths (`claudeSecretDenyRules`). Verified to block the Read tool. It does not stop a
    shell command (`cat`) if Bash is allowed by the account's own settings or launch args.
  - **Codex**: `--sandbox workspace-write` (the default) and `read-only` restrict writes and
    network, not reads; there is no per-path read deny.
  - **Cursor** (`--force`) and **OpenCode**: no per-path deny switch; full user access.
  The only hard boundary is running Totem's data under a different user than the agents, or
  `AGENT_CWD` plus filesystem permissions that keep the agent user out of `data/`. Treat an
  agent as holding the owner's authority, which `BRIDGE_SECRET` in `.env` already implies.
- **Google OAuth apps in Testing mode** only admit listed test users and their refresh tokens
  expire; publish the app once setup is stable.
