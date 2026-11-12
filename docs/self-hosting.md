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
Approving is the exception: the bearer secret alone approves nothing (next section).

## The approval code

Every agent CLI runs as the same user as Totem, so it can read `.env` and with it
`BRIDGE_SECRET`. The approval code is a second credential that a caller holding only the
bearer secret does not have. It stops an agent following an injected instruction from
approving its own proposal with one `curl`. **It does not stop an agent that can write
`data/` or the checkout**: see "What remains open" below.

- **What it guards.** The routes in `auth/approval-routes.mjs`:
  - accepting, denying or saving as a draft an Inbox proposal (`POST /api/inbox/resolve`);
  - activating an MCP approval session (`/api/approvals/approve`);
  - sending from the Messages tab (`/api/apple/send`);
  - accepting a totem change proposed in chat (`/api/totems/proposal`);
  - showing a held proposal after all (`/api/inbox/release`);
  - approving or declining a tool call a Claude chat run is waiting on
    (`/api/chat/approvals`), so the run cannot answer its own request with the bearer;
  - deciding a recommendation or recording its outcome (`/api/recs/<id>/decision`,
    `/outcome`), so an agent cannot accept or grade its own. Recording one
    (`POST /api/recs`) is not gated, but without a session or the code it is recorded as
    an agent's, so a recommendation the owner declined in the last 30 days is refused;
  - adding, changing or removing an away span (`POST /api/away`, `PATCH`/`DELETE
    /api/away/<id>`): an away day holds back nudges, and agents only propose spans.

  A path is normalised first: repeated slashes, a trailing slash and `.`/`..` segments all
  reach the same gate.
- **What each needs.** The bearer secret alone is refused on all of them, always.
  - **High risk** needs the code once one is set: sending an email or message, running a
    command, opening a prompt, filing a GitHub issue,
    activating an MCP session, and any kind the table does not know.
  - **Low risk** needs only a signed-in session (or proxy mode): a local task, a calendar
    event, a goal metric, a totem's own instructions, a chat's tool approval, a recommendation's decision or
    outcome, the owner's own away-span edits, any denial. Accepting an agent's `away`
    proposal is high risk: it is an inference, and it holds back nudges. An agent can make the same
    changes directly through its tools, so a code there would protect nothing.
  - A request carrying the code passes with either the session or the bearer, which is how
    the iPhone app approves.
  - In proxy mode, anything that reaches the port counts as signed in, local agents
    included. There the code is the only thing between an agent and a high-risk approval, so
    set one.
- **Setting it.**
  - In Settings → Security → Approval code, after re-entering the password.
  - Or with `npm run approval-code` in a terminal on the server. The CLI refuses to run
    without a terminal on both ends, and asks for the owner password whenever an owner
    exists. It finds its files from the checkout's `.env` (`AUTH_FILE`,
    `APPROVAL_CODE_FILE`, the way `npm start` does) or the defaults, never from the caller's
    environment, so neither `TOTEM_AUTH` nor an `AUTH_FILE` pointed elsewhere changes whether
    it asks. It skips the password only on an install with no owner that the bridge itself
    recorded as running behind an auth proxy. A bridge whose paths are set only in a
    systemd unit or docker compose needs them in `.env` too for the CLI to find them.
  - A code set by the CLI is loaded at Totem's next start. Until then the running bridge sees
    a file it did not write and treats it as tampering (below), so restart it.

  The code is 20 random characters (`XXXXX-XXXXX-XXXXX-XXXXX`), shown once. Each device keeps
  its own copy: localStorage in a browser, the keychain on the iPhone (bound to the server it
  was entered for). Signing out of a device forgets it there, and setting a new code retires
  the old one everywhere.
- **What is stored, in two places.** Only a salted HMAC-SHA256 of the code is kept (a
  32-byte random salt per code), in `data/approval-code.json` (0600, `APPROVAL_CODE_FILE`).
  The code is 100 random bits, so a deliberately slow hash such as scrypt, which a
  password needs, would protect nothing more and only make a flood of wrong codes
  costly to check. A record from a build before this (scrypt) is accepted on its first
  correct code and rewritten. That file also holds the install
  decision and the date it was armed. `data/auth.json` (`approvalCode`) keeps a second copy
  of both, plus the hash record's id.
- **Missing.** Once a code has been set, a missing or emptied hash file refuses every
  high-risk approval until a new code is set. Deleting the file never turns the check off.
- **Tampered.** The record Totem set is held in memory and compared with the file on every
  check, and the two copies are compared at every start. On any difference (the hash
  replaced with someone else's code while Totem runs, a hash file Totem did not write, or
  one copy saying `existing` while the other says `fresh`), every high-risk approval is
  refused, the owner is notified, and an `approval.code.tampered` line goes in the action
  log. This lasts until the owner sets a new code. An edit to the copy in `auth.json` alone
  changes nothing the running bridge uses, so it is put back and reported. The record id is
  an unkeyed hash, not a signature: **a consistent rewrite of both files followed by a
  restart is not detected** (see "What remains open").
- **Wrong codes.**
  - A wrong code is refused (403) and counted, per client and per credential: a signed-in
    session and the bearer secret have separate counts.
  - Past 5 in 15 minutes from one client, or 20 in total, a wrong code gets 429 instead.
  - **A correct code is always checked and always accepted**, from any client: the phone
    behind a local tunnel shares an agent's address and credential, so nothing an agent
    does to "its" count may refuse the owner's code. Checking a code takes microseconds and
    nothing waits in line, so a flood of wrong codes, however large, cannot delay or refuse
    a correct one.
  - The client is the socket address. `X-Forwarded-For`/`CF-Connecting-IP` count only with
    `TOTEM_TRUST_PROXY=true`, because an agent on this machine also reaches the port from
    loopback and could otherwise invent a new client per request.
- **Install states.** Decided once at first boot and recorded in both places:
  - **`fresh`** (state `unset` until a code is set): high-risk approvals wait for a code, and
    the Inbox shows a banner saying so.
  - **`existing`** (state `legacy`): any install with data from before the approval code. A
    signed-in session keeps approving until a code is set, and the owner is notified once
    that this is the weak state. The iPhone app needs the code even then, because it signs in
    with the bearer secret.

  Once a code is set it is enforced, and the state is `armed`.
- **MCP approval sessions.** Their 6-digit one-time code travels in a notification, and the
  notification ledger is a file under `data/` that agents can read. So outside `legacy` the
  6-digit code is neither shown, sent nor accepted. The owner approves the session in
  Settings → Activity, which needs the approval code.

### What remains open

The code closes Totem's own approval routes to a caller holding only `BRIDGE_SECRET`. An
agent running as the same user can still do all of these:

- **Tamper with `data/`.** It can replace the hash, edit the latch or delete both copies.
  Replacing or editing one copy is detected and refuses approvals, as described above. Two
  things are **not** detected: deleting both files and forging the rest, and rewriting
  `data/approval-code.json` with a hash of its own code plus a matching `recordId` in
  `data/auth.json`, then restarting Totem. After that restart the agent's code is armed and
  the owner's is not, with no notice. Both copies, and the id that ties them, are files the
  agents' user can write, so nothing kept there can tell them apart from the owner's own.
- **Forge a session cookie** from the signing key in `data/auth.json`. That is enough for
  low-risk approvals, and on a `legacy` install for all of them.
- **Edit the code that checks**: `bridge.mjs`, `auth/`, or the built dashboard in
  `web/dist`.
- **Create or edit a job or totem** with an arbitrary prompt (`POST`/`PATCH /api/jobs`), and
  run it.
- **Use the web terminal** (`TERMINAL_ENABLED=true`), whose WebSocket checks the bearer and
  an `Origin` header the caller chooses.
- **Use the stored tokens directly**: Gmail and Drive in `data/*-tokens.json`, and
  Messages through `osascript`.
- **Read the code from a browser profile** on a machine the agents share: localStorage is a
  file in that profile.

The only hard boundary is running Totem's data under a different OS user than the agents.

### Proposals the Inbox refuses, holds or marks uncertain

- **One reading.** A proposal's staged file is read once, through the same reader its accept
  uses. That one reading is previewed, screened, fingerprinted and, on accept, sent or run.
  Scripts anywhere under the notes repo count, not just `inbox-prompts/`. The dashboard sends
  back a digest of the proposal it displayed, and if the file changed since, the accept is
  refused ("this proposal changed since you saw it").
- **Hidden characters.** A proposal is refused if any field it shows or sends (title,
  subject, body, recipient names, the quoted message, prompt, command, labels) holds any of:
  - a direction control: overrides and isolates (U+202A–U+202E, U+2066–U+2069), and marks
    (U+061C, U+200E/F) outside right-to-left text;
  - a tag character (U+E0000–U+E007F);
  - a zero-width character (U+200B–U+200D, U+2060–U+2064, U+FEFF);
  - a soft hyphen (U+00AD);
  - a variation selector (U+FE00–U+FE0F, U+E0100–U+E01EF);
  - any other invisible formatting character (all of `\p{Cf}`), interlinear annotation
    marks (U+FFF9–U+FFFB), musical formatting (U+1D173–U+1D17A), the Mongolian vowel
    separator (U+180E);
  - a character that draws as nothing: Hangul fillers (U+115F, U+1160, U+3164, U+FFA0),
    the combining grapheme joiner (U+034F), line and paragraph separators (U+2028/2029).

  Allowed where they are ordinary writing: direction marks and the zero-width non-joiner in
  right-to-left text, joiners and presentation selectors inside an emoji (❤️, 👨‍👩‍👧), and
  the three recommended subdivision flags (England, Scotland, Wales: 🏴 + `gbeng`/`gbsct`/
  `gbwls` + the cancel tag). Any other run of tags after 🏴 is refused: it is invisible text a
  model reads. Staging such a proposal is refused. If one reaches the inbox another way, its
  card says why and an accept gets 422 with a logged refusal.
- **Unreadable.** A proposal whose staged file could not be read when it was listed (missing,
  malformed, an account removed) shows the reason on its card, and Accept is disabled.
  Accepting it anyway is refused (409); the bridge never reads the file a second time to
  send or run what the owner did not see. Denying it still works.
- **Old clients.** An accept that carries no digest (an app or page from before this check)
  is refused with "update the app"; an accept of a proposal that is no longer open is a 409.
- **Held.** A proposal identical to one the owner denied from the dashboard in the last 7 days
  is held. "Identical" means the same kind, destination and payload, with case and whitespace
  folded. A held proposal:
  - sits under "Held" with a note naming the earlier denial, and is left out of the badge;
  - is reported to the agent that staged it;
  - refuses every accept, including through an MCP session, until the owner chooses "Show
    anyway" (`/api/inbox/release`, which needs a signed-in session or the code).

  Denials made through an MCP session do not hold anything. They are kept in
  `data/approval-denials.json`.
- **Uncertain.** Each accepted action is recorded in `data/approval-inflight.json` before it
  starts. It ends as `uncertain` ("check before retrying"), never failed and never left open,
  in two cases:
  - **A restart cut it off.** This is settled at the next start, before the port opens, and
    each entry is cleared only after its inbox line is stamped. A new accept of a proposal
    still being settled is refused.
  - **The send failed after the request may already have gone out** (Gmail, Messages,
    Calendar, a GitHub issue).

  Either way the action log gets an `uncertain` entry, and after a restart the owner is
  notified.

## Settings: dashboard or environment

Most configuration can be entered in the dashboard. Each value is stored in a file under
`data/` with mode 0600, and a value set in the real environment (`.env`, the systemd unit,
docker compose) always wins and is shown as read-only.

| Setting | Where in the UI | Stored in |
|---|---|---|
| Owner password | setup page, Settings -> Security | `data/auth.json` |
| Approval code | Settings -> Security, or `npm run approval-code` | hash in `data/approval-code.json` |
| Default AI provider and model, accounts | Settings -> Providers | `data/provider-config.json` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY` | Settings -> Providers › API keys | `data/ai-settings.json` |
| `PUBLIC_URL`; task sheet ID/tab/assignees/title/account; CLIProxy | Settings -> General; Settings -> Tasks; Settings -> Providers | `data/integrations.json` |
| Venture tags | Settings -> Tasks | `data/todos.db` (`todo_preferences`) |
| MCP servers | Settings -> Connections | `data/mcp-manifest.json` |
| Connection icons | Settings -> Connections, a row's Icon | `data/connection-icons.json` (`CONNECTION_ICONS_FILE`); pictures are chat uploads |
| Scheduled jobs | Totems | `data/jobs.json` |
| Prompt skills | Settings -> Skills | `data/skills/` |

Two exceptions to "env wins": `AGENT_BACKEND` and `AGENT_MODEL` are first-run defaults for the
provider config, and the `*_ENABLED` / `*_TIME` job variables seed `data/jobs.json` once. After
that the saved values rule, so a deploy never overrides a choice made in the UI.

API keys entered in Settings -> Providers are placed in the bridge's environment, which every agent CLI
it spawns inherits. They are never sent back to the browser, and the web terminal does not see
them.

### Optional pieces, all off by default

- Scheduled jobs: every job is created disabled except the two local task-board housekeeping
  jobs, which only apply archive and retention preferences you set.
- Sibling apps: the "Show in Bushido" toggle on goal cards appears only with `BUSHIDO_URL`.
- The web terminal: `TERMINAL_ENABLED=true`, and `node-pty` must have built (it needs a C++
  toolchain; `pnpm install` continues without it).
- Voice journal transcription: run `scripts/install-whisper.sh`.
- Web push: generate VAPID keys with `node notify/cli.mjs keys`.

`OWNER_NAME` sets how prompts and greetings refer to you; without it they say "the owner".

### Settings the dashboard cannot change

Anything that decides what program runs, or which file the server reads secrets from, is
set on the box: agent binary paths, config directories, launch arguments and per-account
environment (`data/provider-config.json`) and usage-tracker profile paths (`data/ai-usage.json`).
Set `TOTEM_ALLOW_UI_EXEC_CONFIG=true` to edit them from the dashboard anyway.

### Cross-site requests and the login throttle

Requests signed in by cookie (or proxy mode) that change something must come from
Totem's own origin and send JSON; another site cannot drive the browser into them. Bearer
callers are not affected. Failed sign-ins are throttled per client address and in total.
The address comes from the socket, or from `X-Forwarded-For`/`CF-Connecting-IP` only with
`TOTEM_TRUST_PROXY=true`. An agent on the same machine connects from loopback too, so a local
proxy is no longer trusted by default. Behind cloudflared or a local nginx, set it, or every
visitor shares the proxy's address.

## Running it

### Foreground

`pnpm start` builds `web/dist` if it is missing, then runs `node --env-file=.env bridge.mjs`
(without `--env-file` when there is no `.env`). After pulling changes to `web/`, rebuild with
`pnpm run build`.

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
version's `bin` directory. So does pnpm (or Corepack, which comes with node 22 and 24) if the
"Deploy Totem" self-update job is on: it checks before pulling and refuses without it. `pnpm run service:restart`, `service:logs` and friends wrap these
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

Set `PUBLIC_URL` to the external origin so the setup link uses it and same-origin checks accept it, and
have the proxy send `X-Forwarded-Proto: https` so session cookies are marked `Secure`. If the
proxy authenticates users itself and the port is not reachable any other way, `TOTEM_AUTH=proxy`
removes the second sign-in.

## Data and backups

Everything a running install creates is under `data/` and `secrets/`:

- `data/todos.db`: tasks, goals, lists (SQLite; backups before purges in `data/todo-backups/`)
- `data/brain/`: the Markdown notes repo, its own local git repository
- `data/*.json`, `data/*.jsonl`: settings, jobs, threads, habits, logs, notification state
- `secrets/`: the Google OAuth client file (WHOOP and Strava tokens are Bushido's)

The agent CLIs keep their own logins and MCP OAuth tokens in your home directory (`~/.codex`,
`~/.claude`, `~/.config/...`); those are not part of a Totem backup.

Back up both directories. Restoring them onto a fresh checkout restores the install, including
the owner account.

## Deploying every merge (optional)

`.github/workflows/deploy.yml` deploys `main` after CI passes on it. It runs on a
[self-hosted GitHub Actions runner](https://docs.github.com/actions/hosting-your-own-runners)
on the machine that serves the app, so nothing has to reach that machine from outside.
Each deploy:

1. stops if the live checkout has uncommitted changes to tracked files or is not on `main`;
2. fast-forwards it to `origin/main` (nothing new, nothing done), runs `pnpm install --frozen-lockfile` only if a
   `package.json`, `pnpm-lock.yaml` or `pnpm-workspace.yaml` changed (or the checkout has no
   pnpm install yet), and builds;
3. restarts the service once no chat or job is running in it (no agent CLI under the
   bridge, checked every 15 seconds, for up to 30 minutes) (`launchctl kickstart -k` on macOS,
   `systemctl --user restart` on Linux), then waits up to a minute for the health URL;
4. if the build, the restart or the health check fails, resets to the commit it started
   from, reinstalls and builds that (with `npm ci` if that commit predates pnpm), and restarts again.

When the iPhone app changed (`mobile/`), a second job ships it. It publishes an over-the-air
update to the `production` channel; installed builds take it only when their native code
matches (the runtime version is a fingerprint). When no App Store build has that
fingerprint yet, it also makes one, waits for it and submits it to TestFlight. Until that
build is installed, no phone takes the new updates, so a submit that fails fails the job
and names the build to submit by hand.

It does nothing until the repository is told where the install is:

```bash
# On the serving machine, as the user the service runs as: a runner for this repository
# with the label the workflow asks for (Settings → Actions → Runners → New self-hosted
# runner gives the download and the token).
./config.sh --url https://github.com/<you>/<repo> --token <token> --labels totem-deploy --no-default-labels
./svc.sh install && ./svc.sh start
# Give it the PATH node and pnpm need, in .env beside config.sh, e.g.:
#   PATH=/opt/homebrew/opt/node/bin:/opt/homebrew/bin:/usr/bin:/bin

# Repository variables (Settings → Secrets and variables → Actions):
gh variable set DEPLOY_DIR -b /path/to/the/live/checkout
gh variable set DEPLOY_SERVICE -b totem            # the launchd label or systemd unit
gh variable set DEPLOY_HEALTH_URL -b http://127.0.0.1:8787/health   # the default

# Optional, for the iPhone app:
gh variable set EAS_PROJECT_ID -b <project id>       # what mobile/app.local.json holds
gh variable set IOS_BUNDLE_ID -b <bundle id>
gh secret set EXPO_TOKEN                             # an Expo access token
# For TestFlight: the app's id in App Store Connect (App Information → Apple ID) and an
# App Store Connect API key (Users and Access → Integrations, App Manager or above).
gh variable set IOS_ASC_APP_ID -b <apple id>
gh variable set ASC_API_KEY_ID -b <key id>
gh variable set ASC_API_KEY_ISSUER_ID -b <issuer id>
gh secret set ASC_API_KEY < AuthKey_<key id>.p8
```

Run one by hand from the Actions tab (Deploy → Run workflow) or with
`gh workflow run deploy.yml`. Only people who can push to the repository can trigger it, so
use it on a private repository you control: a self-hosted runner runs whatever a workflow
on that repository asks of it.
