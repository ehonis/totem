# Self-hosting

How a Totem install is put together once it is past the quick start in the README: sign-in,
where settings live, the ways to run it, and what to back up.

## Sign-in

Totem has exactly one account, the owner. Three things can get a request in, checked in this
order (`auth/owner.mjs`):

1. **The bearer secret.** `Authorization: Bearer <BRIDGE_SECRET>`. Used by machine callers:
   the iOS Shortcut, the MCP gateway, sibling apps. Empty `BRIDGE_SECRET` disables it.
2. **A session cookie.** Set by the setup page or the sign-in page. Signed with a key kept in
   `data/auth.json`, httpOnly, `SameSite=Lax`, `Secure` when the request arrived over https
   (directly or with `X-Forwarded-Proto: https`), valid for 30 days. Changing the password
   signs out every other session.
3. **Proxy mode.** With `TOTEM_AUTH=proxy`, every request is trusted, because an auth proxy in
   front (Cloudflare Access, oauth2-proxy, Tailscale Serve with identity) has already decided.
   There is no setup page and no password. Only use it when nothing can reach `BRIDGE_PORT`
   without passing through that proxy; anything that can reach the port directly is the owner.

The inbound MCP server (`POST /mcp`) does not use cookies or proxy mode. It accepts the bearer
secret or a Cloudflare Access JWT (`ACCESS_TEAM_DOMAIN`, `ACCESS_MCP_AUD`,
`ACCESS_ALLOWED_EMAIL`); see [totem-mcp-server.md](totem-mcp-server.md).

### First run

With no owner and `TOTEM_AUTH` not set to `proxy`, the server prints a setup link containing a
random token. The token lives only in memory: it works once, and a restart prints a new one.
`/setup` without it shows instructions instead of a form. The password is stored as a scrypt
hash in `data/auth.json` (mode 0600). `AUTH_FILE` moves that file.

To reset a forgotten password, stop the server, delete `data/auth.json`, and start it again; a
new setup link is printed. Sessions signed with the old key stop working.

### Existing installs that used only BRIDGE_SECRET

A browser that saved the bridge secret before sign-in existed keeps working: the dashboard
still sends it as a bearer header. The sign-in page also has a "Use the bridge secret instead"
link. The setup link is printed on start until an owner exists, and is harmless to ignore.

## Settings: dashboard or environment

Most configuration can be entered in the dashboard. Each value is stored in a file under
`data/` with mode 0600, and a value set in the real environment (`.env`, the systemd unit,
docker compose) always wins and is shown as read-only.

| Setting | Where in the UI | Stored in |
|---|---|---|
| Owner password | setup page, Settings -> General | `data/auth.json` |
| Default AI provider and model, accounts | Settings -> AI, Settings -> Providers | `data/provider-config.json` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY` | Settings -> AI | `data/ai-settings.json` |
| `PUBLIC_URL`, WHOOP and Strava client ID/secret, task sheet ID/tab/assignees | Settings -> Integrations | `data/integrations.json` |
| Venture tags | Settings -> Tasks | `data/todos.db` (`todo_preferences`) |
| MCP servers | Studio -> Connections | `data/mcp-manifest.json` |
| Scheduled jobs | Studio -> Jobs | `data/jobs.json` |
| Prompt skills | Studio -> Skills | `data/skills/` |

Two exceptions to "env wins": `AGENT_BACKEND` and `AGENT_MODEL` are first-run defaults for the
provider config, and the `*_ENABLED` / `*_TIME` job variables seed `data/jobs.json` once. After
that the saved values rule, so a deploy never overrides a choice made in the UI.

API keys entered in Settings -> AI are placed in the bridge's environment, which every agent CLI
it spawns inherits. They are never sent back to the browser, and the web terminal does not see
them.

### Optional pieces, all off by default

- Scheduled jobs: every job is created disabled except the two local task-board housekeeping
  jobs, which only apply archive and retention preferences you set. The GitHub task sync turns
  on by itself only when a GitHub App is configured (`GITHUB_APP_ID`); set
  `GITHUB_TODOS_SYNC_ENABLED=true` to let it use the `gh` CLI's login instead.
- Sibling apps: the "Show in Bushido" toggle on goal cards appears only with `BUSHIDO_URL`.
- The web terminal: `TERMINAL_ENABLED=true`, and `node-pty` must have built (it needs a C++
  toolchain; `npm install` continues without it).
- Voice journal transcription: run `scripts/install-whisper.sh`.
- Web push: generate VAPID keys with `node notify/cli.mjs keys`.

`OWNER_NAME` sets how prompts and greetings refer to you; without it they say "the owner".

### Settings the dashboard cannot change

Anything that decides what program runs, or which file the server reads secrets from, is
set on the box: agent binary paths, config directories, launch arguments and per-account
environment (`data/provider-config.json`), usage-tracker profile paths (`data/ai-usage.json`)
and `GOOGLE_SHEETS_CREDENTIALS_FILE` (environment only). Set
`TOTEM_ALLOW_UI_EXEC_CONFIG=true` to edit the first two from the dashboard anyway.

### Cross-site requests and the login throttle

Requests signed in by cookie (or proxy mode) that change something must come from
Totem's own origin and send JSON; another site cannot drive the browser into them. Bearer
callers are not affected. Failed sign-ins are throttled per client address and in total.
The address comes from the socket, or from `X-Forwarded-For`/`CF-Connecting-IP` when the
peer is a proxy on the same machine or `TOTEM_TRUST_PROXY=true`.

## Running it

### Foreground

`npm start` builds `web/dist` if it is missing, then runs `node --env-file=.env bridge.mjs`
(without `--env-file` when there is no `.env`). After pulling changes to `web/`, rebuild with
`npm run build`.

### systemd (user service)

```sh
mkdir -p ~/.config/systemd/user
cp assistant-bridge.service ~/.config/systemd/user/
$EDITOR ~/.config/systemd/user/assistant-bridge.service   # WorkingDirectory, PATH
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now assistant-bridge
journalctl --user -u assistant-bridge -f                  # the setup link is printed here
```

The agent CLIs have to be on the unit's `PATH`; if node or a CLI comes from nvm, add that exact
version's `bin` directory. `npm run service:restart`, `service:logs` and friends wrap these
commands.

The camera sync has its own root-run units, installed by `camera/install.sh`; see
[camera-sync.md](camera-sync.md). Nothing else needs a unit.

### Docker

`docker compose up -d --build` builds an image with the bridge, the built dashboard, and the
Claude Code and Codex CLIs (override with `--build-arg AGENT_CLIS=...`). Three named volumes
hold `data/`, `secrets/` and the container user's home, where the CLIs keep their logins.
`.env` is read if present. `docker compose logs totem` shows the setup link.

The image leaves out `node-pty`, so the web terminal is unavailable, and has no whisper.cpp, so
voice journal transcription is unavailable.

### Behind a reverse proxy

Set `PUBLIC_URL` to the external origin so the setup link and OAuth redirect URIs use it, and
have the proxy send `X-Forwarded-Proto: https` so session cookies are marked `Secure`. If the
proxy authenticates users itself and the port is not reachable any other way, `TOTEM_AUTH=proxy`
removes the second sign-in.

## Data and backups

Everything a running install creates is under `data/` and `secrets/`:

- `data/todos.db`: tasks, goals, lists (SQLite; backups before purges in `data/todo-backups/`)
- `data/brain/`: the Markdown notes repo, its own local git repository
- `data/*.json`, `data/*.jsonl`: settings, jobs, threads, habits, logs, notification state
- `secrets/`: WHOOP and Strava OAuth tokens, the Google OAuth client file, a GitHub App key if used

The agent CLIs keep their own logins and MCP OAuth tokens in your home directory (`~/.codex`,
`~/.claude`, `~/.config/...`); those are not part of a Totem backup.

Back up both directories. Restoring them onto a fresh checkout restores the install, including
the owner account.
