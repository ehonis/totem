# Setup

The browser-only quick start (clone, `npm install && npm start`, open the setup link, set up AI
in Settings) is in [README.md](README.md#quick-start) and covers a working install on its own.
This file is the longer runbook for the parts that happen outside the browser: the phone
shortcut, Tailscale, MCP servers, and the scheduled jobs.

Phased so you're never blocked. Phase 1 gets you texting the assistant and managing local Totem tasks.

## 0. Secrets

```bash
cd ~/projects/totem   # your checkout
cp .env.example .env
```

Fill in `.env`:

- `BRIDGE_SECRET` — generate one: `openssl rand -hex 24`. The dashboard signs in with the owner
  password instead; this secret is for machine callers such as the iOS Shortcut below.
- `AGENT_BACKEND` — boot/fallback default (`cursor`, `codex`, `claude`, or `opencode`).
  The web Providers tab can change the live default later.

## 1. Pick & verify the agent backend

The bridge shells out to the default provider selected in the Providers tab, falling back to
`AGENT_BACKEND` until `data/provider-config.json` exists. Confirm at least one provider works
headless first:

```bash
# codex (installed, signed in)
echo "say hello in 3 words" | codex exec -

# cursor (needs `cursor-agent login` once, in a browser)
cursor-agent -p --output-format text "say hello in 3 words"

# Claude Code (requires Claude Code auth on this machine)
claude -p --output-format text "say hello in 3 words"

# OpenCode (install first, then run `opencode auth` for the provider you want)
opencode run "say hello in 3 words"
```

After the bridge is running, open the dashboard's Providers tab to see detected providers,
the auth/smoke-test commands, the enabled-provider toggles, and the default provider + default
model pickers. Use Settings → Connections to import/sync MCP servers across providers. Changing the
default provider affects Shortcut, scheduled jobs, and new web chats without a bridge
restart; web chats can also switch to any enabled provider per-thread, while temporary chats
always use the default.

## 2. Networking (Tailscale)

Tailscale is already installed. Bring it up and note the box's name:

```bash
sudo tailscale up
tailscale status        # note this machine's name, e.g. my-box
tailscale ip -4         # its 100.x.y.z address
```

Install the **Tailscale** app on your iPhone and sign into the same account.

## 3. Run the bridge

```bash
node --env-file=.env bridge.mjs          # foreground, for testing
# health check from another shell:
curl localhost:8787/health
# end-to-end:
curl -s localhost:8787/ask -H "Authorization: Bearer $BRIDGE_SECRET" \
  -H 'content-type: application/json' -d '{"text":"add buy milk to my Totem tasks"}'
```

Once happy, install it as a service (see header of `assistant-bridge.service`).

## 4. iOS Shortcut (the Action-Button trigger)

In the **Shortcuts** app, new shortcut with these actions:

1. **Ask for Input** — Input Type: *Text*, Prompt: "What do you need?"
   (the keyboard's mic key lets you dictate instead of typing — both in one prompt)
2. **Get Contents of URL**
   - URL: `http://<tailscale-name>:8787/ask-text`
   - Method: **POST**
   - Headers: `Authorization` = `Bearer <your BRIDGE_SECRET>`
   - Request Body: **JSON** → key `text` = *Provided Input* (from step 1)
3. **Show Result** (or **Speak Text** for a hands-free voice loop) using the URL response directly

The older `/ask` endpoint still returns JSON as `{ "reply": "..." }`, but `/ask-text`
is preferred for iOS Shortcuts because it avoids dictionary parsing.

Every Shortcut request/response is saved as a temporary web chat. If follow-up is needed, the
Shortcut response includes a direct `/?tab=chat&thread=<id>` link; open it in the dashboard and
continue there.

Once push notifications are set up (see `docs/notifications.md`), every Shortcut request also
gets two of them: "Totem got it" the moment it lands, and a one-line summary of the answer when
it's done, linked to that temporary chat. `SHORTCUT_NOTIFY=false` turns the pair off.

Assign it: **Settings → Action Button → Shortcut** (and/or **Settings →
Accessibility → Touch → Back Tap → Double Tap**).

For a pure voice loop, swap step 1's *Ask for Input* for **Dictate Text**, and end
with **Speak Text** on the reply.

## 5. MCP servers

MCP servers are configured once in Totem's canonical manifest, then synced into Cursor, Codex,
Claude Code, and OpenCode from Settings → Connections. The default manifest path is
`data/mcp-manifest.json` and is gitignored because imported env values can contain API tokens.

To seed from an existing Cursor setup:

```bash
SECRET=$(grep '^BRIDGE_SECRET=' .env | cut -d= -f2-)
curl -s http://localhost:8787/api/mcp/import-cursor \
  -H "Authorization: Bearer $SECRET" -H 'content-type: application/json' -d '{}'
curl -s http://localhost:8787/api/mcp/sync \
  -H "Authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -d '{"providers":["cursor","codex","claude","opencode"]}'
```

The local task service is built into Totem's MCP gateway and is not a configured third-party
connection. Google Calendar (`@cocal/google-calendar-mcp`) and Plaud
(`https://mcp.plaud.ai/mcp`) are typical configured servers. Local stdio servers should
work immediately after sync if their env values are present. Remote/OAuth servers may need a
provider-specific login after sync. Use the action buttons in Settings → Connections first; they can
approve Cursor servers and start URL-based OAuth flows from the dashboard. If a provider CLI does not
emit a browser URL, the UI will show the command result and remaining limitation. If OAuth redirects
to a dead localhost/127.0.0.1/Tailscale callback on another device, paste that full URL into the
Connections tab's callback helper; the bridge will replay it locally on the Linux box.

Verify provider MCP state:

```bash
node mcp-gateway.mjs --status
codex mcp list
claude mcp list
opencode mcp list
```

## 6. Google Calendar MCP

Google Calendar is registered in Cursor's MCP config as `google-calendar` using
`@cocal/google-calendar-mcp`.

Secrets live in the repo-local, gitignored `secrets/` directory:

```bash
mkdir -p secrets
chmod 700 secrets
# copy the OAuth desktop-client JSON from Google Cloud Console to:
# secrets/google-calendar-oauth-client.json
chmod 600 secrets/google-calendar-oauth-client.json
```

Authenticate once on the Linux box:

```bash
cd ~/projects/totem   # your checkout
GOOGLE_OAUTH_CREDENTIALS="$PWD/secrets/google-calendar-oauth-client.json" \
  npx -y @cocal/google-calendar-mcp auth
```

Then verify the MCP server is visible to the active Cursor backend:

```bash
cursor-agent mcp list-tools google-calendar
```

Authenticated MCP accounts:

- `normal` → primary calendar of your personal Google account
- `work` → primary calendar of a second (work) Google account

Both also see US holidays. To add another Google account, first add that email under Google
Auth Platform → Audience → Test users, then run:

```bash
GOOGLE_OAUTH_CREDENTIALS="$PWD/secrets/google-calendar-oauth-client.json" \
  npx -y @cocal/google-calendar-mcp auth <account-alias>
```

Google OAuth apps in External testing mode only work for users listed under
Google Auth Platform → Audience → Test users, and refresh tokens may expire while
the app remains in testing.

## Phase 2+ (later)

- Google Calendar routing rules

## 7. Morning briefing

The bridge can generate the owner's morning overview on demand or on a daily schedule. The scheduled
run records the briefing for on-demand reading via `/morning-text` and the web/mobile app; it no
longer pushes anywhere. It asks the agent to inspect local Totem tasks, every connected Google Calendar account,
GitHub/repo signals, Open-Meteo weather, Google News RSS headlines, and assistant/system health
without modifying anything.

Environment controls:

```bash
MORNING_BRIEFING_ENABLED=true
MORNING_BRIEFING_TIME=07:30
MORNING_BRIEFING_TZ=America/New_York
WEATHER_ENABLED=true
WEATHER_LAT=40.7128
WEATHER_LON=-74.0060
WEATHER_LOCATION=New York, NY
NEWS_ENABLED=true
NEWS_AI_QUERY=artificial intelligence when:1d
NEWS_WORLD_QUERY=world news when:1d
NEWS_MAX_ITEMS=5
```

Weather uses Open-Meteo directly from the bridge, not web search and not an MCP server. Change
`WEATHER_LAT`, `WEATHER_LON`, and `WEATHER_LOCATION` if the default briefing location changes.
News uses Google News RSS directly from the bridge, not an MCP server. `NEWS_AI_QUERY` and
`NEWS_WORLD_QUERY` control the two compact news blocks in the morning briefing.

On-demand options:

```bash
# HTTP / Shortcut
SECRET=$(grep '^BRIDGE_SECRET=' .env | cut -d= -f2)
curl -s http://localhost:8787/morning-text -H "Authorization: Bearer $SECRET" -X POST
```

`/morning-text` returns the briefing as plain text to the caller. The web app can also trigger and
read it on demand via the `/morning` slash command.

## 8. Voice journal (on-device transcription)

Productivity → Journal records a spoken entry in the browser and transcribes it on the box with
whisper.cpp, so nothing leaves the machine and no speech API key can expire. One script installs
everything without sudo (it fetches a portable cmake if the box has none):

```bash
scripts/install-whisper.sh            # builds whisper-cli, downloads ggml-small.en.bin (466 MB)
scripts/install-whisper.sh base.en    # smaller/faster model, worse on names
npm install                           # ffmpeg-static is a root dependency now
systemctl --user restart assistant-bridge
```

The bridge assumes the script's default paths under `~/.local/share/totem/whisper/`; override
with `JOURNAL_WHISPER_BIN` / `JOURNAL_WHISPER_MODEL` if you put them elsewhere. The Journal view's
header pill says whether the engine is ready. Recording needs an HTTPS origin (the same one Web
Push already needs); a bare `http://<tailscale-ip>` can only type entries. The ten-minute
"don't ingest" window and the names whisper should spell right are settings inside the view.
Details, the entry lifecycle and the gotchas: `docs/journal.md`.
