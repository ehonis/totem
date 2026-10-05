# Totem

Totem is a self-hosted personal assistant that runs on a machine you own. You reach it from a
phone shortcut or a web dashboard; it answers and acts through whichever coding-agent CLI you
already use (Codex, Claude Code, OpenCode or Cursor), against your own data: a local task
board, goals, habits, lists, a Markdown notes repo, Google Calendar, GitHub, and fitness
services. It exists because the agent CLIs already know how to use tools and MCP servers, so a
small bridge around them, plus a dashboard that reads data directly, makes a useful assistant
without a separate API bill or a hosted service in the middle.

This is a personal project, built and run by one person for one user. It is published as a
working example rather than a product: it has one owner account, assumes a private network
or an auth proxy in front of it, and its defaults reflect that. Formerly named Vesper.

## Features

- **Two front doors.** `POST /ask` and `/ask-text` for an iOS Shortcut (plain-text replies,
  a receipt and a summary as push notifications, and a link to finish in the web chat when a
  request needs follow-up), and a React dashboard with streaming chat.
- **Agent-agnostic AI.** Codex, Claude Code, OpenCode and Cursor CLIs, picked per install or
  per chat, with several accounts per CLI (e.g. personal and work), per-account environments,
  live quota meters, and a fallback provider when one hits its usage limit.
- **Productivity data, stored locally.** Tasks in SQLite (recurrence, archive, recycle bin,
  optional sync to GitHub issues or a shared Google Sheet), weekly/monthly/quarterly/yearly
  goals with metrics fed from Strava, habits with contribution grids and cadences, simple
  lists, and Google Calendar.
- **Voice journal.** Record in the dashboard; whisper.cpp transcribes on the box; an agent
  digests the entry into the notes repo, habits and the inbox after a grace period.
- **Confirm-only inbox.** Anything inferred (journal action items, meeting notes, commands
  or agent runs proposed by an MCP client) is staged for a yes/no, with the finished work
  prepared before the question is asked.
- **MCP both ways.** An outbound gateway (`mcp-gateway.mjs`) puts every configured MCP server
  plus Totem's own tasks, goals, lists and Strava tools behind one entry that is synced into
  each CLI's config. An inbound MCP server (`POST /mcp`) lets ChatGPT or Claude read Totem and
  stage work, authenticated by bearer token or a Cloudflare Access JWT, with time-boxed
  approval sessions.
- **Totems.** Standing agents on a schedule: describe one and the builder designs it and
  recommends the cheapest model that can do the job. Each remembers what it has seen, has its
  own chat, and notifies you only when something matters. The built-in jobs (morning brief,
  digests, ingests, syncs; all off until enabled) are totems too.
- **Integrations.** WHOOP (sleep and recovery), Strava (activities, gear, mileage), Plaud
  (voice recorder, via its MCP server), GitHub (App or `gh` CLI), Google Calendar, web push
  notifications, Open-Meteo weather and Google News headlines, and a plug-in-the-camera photo
  sync to Apple Photos.
- **Operational pieces.** An action log of every mutation, approval leases, an optional web
  terminal (off by default), and a usage view of what the assistant is actually used for.

## Architecture

```
iPhone Shortcut / mobile app            Web dashboard (React, served by the bridge)
        │  POST /ask, Bearer secret             │  session cookie
        ▼                                       ▼
bridge.mjs  (one Node process, port 8787)
  ├── /api/*      direct reads and writes: tasks, goals, habits, calendar, notes, usage
  ├── /mcp        inbound MCP server for ChatGPT / Claude
  ├── scheduler   jobs and notification queue (one 30-second tick)
  └── runAgent()  spawns the selected agent CLI per request
         codex exec / claude -p / opencode run / cursor-agent -p
           └── mcp-gateway.mjs → Totem tools + every MCP server in the manifest
```

| Path | What it is |
|---|---|
| `bridge.mjs` | HTTP server, API, prompts, agent backends, scheduler, OAuth clients |
| `auth/` | Owner sign-in: setup token, scrypt password, signed session cookies |
| `ai/` | Settings stored outside `.env` (AI keys, integration credentials) |
| `todos/`, `goals/`, `lists/` | Local task, goal and list services over SQLite, with HTTP and MCP surfaces |
| `journal/`, `notify/`, `jobs/`, `skills/`, `logs/` | Voice journal, notifications and web push, job store, prompt skills, action log and approvals |
| `strava/`, `whoop/`, `camera/`, `ai-usage/`, `providers/`, `terminal/` | Integrations, quota polling, CLI account registry, web terminal |
| `mcp-gateway.mjs` | The stdio MCP aggregator each agent CLI registers |
| `web/` | Vite + React + TypeScript + Tailwind dashboard (PWA) |
| `brain.example/` | Starter layout for the private notes repo kept at `data/brain` |
| `examples/` | Optional personalised skills, never installed automatically |

Stack: Node 22 (built-in `node:sqlite`, no framework), three runtime npm dependencies (`ws`,
`ffmpeg-static`, optional `node-pty`), React 18, Vite, Tailwind 4, Vitest. Runtime state lives
in `data/` and OAuth tokens in `secrets/`; both are gitignored.

There are no screenshots in the repository yet.

## Quick start

Requirements: Linux or macOS, Node.js 22.16 or newer, and git. For AI, at least one of the
Codex, Claude Code, OpenCode or Cursor CLIs on the same machine, signed in or given an API key.

1. Clone and install. `npm install` also installs the dashboard's dependencies.

   ```sh
   git clone https://github.com/ehonis/Totem.git
   cd Totem
   npm install
   ```

2. Start it. The first start builds the dashboard, then runs the server on port 8787. No
   `.env` is needed.

   ```sh
   npm start
   ```

3. The server prints a one-time setup link:

   ```
   Totem has no owner account yet. Open this link to create it:

     http://localhost:8787/setup?token=...
   ```

   Open it, choose the owner password, and you are signed in. The link works once and only
   until the process restarts; a restart prints a new one.

4. Open **Settings -> AI**. It lists the agent CLIs it can find, whether each is installed and
   signed in, and the command that fixes it (for example `codex login`). Pick the default,
   optionally paste an API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `CURSOR_API_KEY`),
   choose a model, and press **Test**. Until an AI is set up, chat and the phone shortcut say
   so and everything else works.

5. Optional, in any order:
   - **Settings -> Integrations**: set the public URL, add WHOOP or Strava app credentials,
     copy the redirect URI it shows into the provider's console, and press Connect.
   - **Settings -> Connections**: add MCP servers (Google Calendar, Plaud, GitHub, ...) and sync
     them into each CLI.
   - **Totems**: switch on the built-in jobs you want, or build your own. A fresh install has none
     running except local task housekeeping.
   - The iOS Shortcut, Tailscale and the other out-of-browser steps: [SETUP.md](SETUP.md).

Anything set in `.env` (see [.env.example](.env.example)) overrides what was saved in the
dashboard.

### Docker

```sh
git clone https://github.com/ehonis/Totem.git && cd Totem
docker compose up -d --build
docker compose logs totem | grep setup
```

The image includes the Claude Code and Codex CLIs. Sign one in with
`docker compose exec -it totem claude` (or `codex login`), or paste an API key in Settings -> AI.
Data, OAuth tokens and CLI logins are kept in named volumes. The web terminal is not available
in the image.

### Running it permanently

`assistant-bridge.service` is a systemd user unit template; copy it, set your checkout path and
node location, and enable it. Details, auth modes, reverse proxies and backups are in
[docs/self-hosting.md](docs/self-hosting.md).

## Security model

Totem runs agent CLIs with shell access on your machine, so whoever can use it can do what you
can do there. The dashboard needs the owner password (or an auth proxy, with
`TOTEM_AUTH=proxy`); machine callers use `BRIDGE_SECRET` as a bearer token. Keep it on a
private network such as Tailscale, or behind an auth proxy, rather than exposing the port
directly.

## Documentation

- [SETUP.md](SETUP.md): phone shortcut, Tailscale, MCP servers, scheduled jobs
- [docs/self-hosting.md](docs/self-hosting.md): sign-in, settings vs. env, Docker, systemd, data layout
- [AGENTS.md](AGENTS.md): the operating manual (architecture, ops, gotchas, roadmap)
- [TOTEM-OVERVIEW.md](TOTEM-OVERVIEW.md): a design write-up of why it is built this way
- `docs/`: one file per subsystem (providers, jobs, skills, journal, notifications, Strava,
  WHOOP, GitHub App, terminal, inbound MCP server, camera sync, shortcuts)

## License

MIT. See [LICENSE](LICENSE).
