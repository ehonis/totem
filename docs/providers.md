# Providers — several accounts per CLI

Totem used to know four agents: `cursor`, `codex`, `claude`, `opencode`. That identifier did two
jobs at once — it named the CLI to spawn *and* the login that CLI would use — which was fine until
one CLI needed two logins: a personal ChatGPT plan and a work one, a personal Claude subscription
and the team's.

The identifier is now split in two:

| | what it is | examples |
|---|---|---|
| **driver** | which CLI and protocol | `cursor`, `codex`, `claude`, `opencode` |
| **account** (instance id) | the routing key everything stores | `codex`, `codex_work`, `claude_personal` |

Chats, jobs, `defaultProvider`, `enabledProviders`, the curated model lists and the Usage cards all
hold **account ids**. The migration is free because **the default account of a driver has the
driver's own id** — a `provider-config.json` that says `"defaultProvider": "codex"` is already
naming a valid account, so nothing is rewritten on upgrade.

Only **claude** and **codex** take extra accounts. Cursor and OpenCode are one login each on this
box and the UI doesn't offer to add a second.

## How a login is isolated

Neither CLI takes a "use this account" flag; both read whichever credentials live in their config
directory. So an account is isolated by pointing that directory somewhere else.

**Claude** — `CLAUDE_CONFIG_DIR`, set per spawn. Deliberately *not* `HOME`: overriding HOME also
moves the macOS keychain lookup, and the CLI then reports "not logged in" while staring straight at
its own credentials.

**Codex** — `CODEX_HOME`, pointed at a **shadow home**: a directory where `auth.json` and
`models_cache.json` are real files and every other entry is a symlink back to the shared `~/.codex`.

```
~/.codex/                     ~/.codex-totem/work/
  auth.json      (personal)     auth.json     → a real file, the work login
  models_cache.json             models_cache.json → real, this plan's catalog
  config.toml    ←───────────── config.toml   → symlink
  sessions/      ←───────────── sessions/     → symlink
  skills/        ←───────────── skills/       → symlink
```

The login is per-account; sessions, skills, `config.toml` and the MCP servers Totem syncs into it
are shared by all of them. Without this, adding a second account would fork the MCP config and every
synced server would have to be written twice.

The shadow home is rebuilt (idempotently) before every Codex spawn and after every provider-config
write, so a directory added to the shared home since last time — a new `skills/`, say — shows up.
Two things are refused rather than papered over: a real file where a symlink belongs (it holds data
we'd have to delete), and a symlinked `auth.json` (it would hand this account the other one's login,
and write this account's refreshed token into it).

## Adding an account

Settings → Providers → **+ Codex** / **+ Claude Code**, then a name. The bridge fills in the paths:

- Claude → `~/.claude-<name>`
- Codex → shared `~/.codex` plus shadow `~/.codex-totem/<name>`

Both stay editable — pointing a Claude account at an existing isolated home (`~/.t3-claude-work`,
say) is a supported and common case.

Signing in has to happen in a terminal on the box: the CLI opens a browser and writes its own
credentials. The pane prints the exact line, home override included —

```
CLAUDE_CONFIG_DIR=~/.claude-work claude setup-token
CODEX_HOME=~/.codex-totem/work codex login
```

— because without the prefix you sign the *default* account in for a second time.

## What each account carries

`data/provider-config.json`:

```jsonc
{
  "defaultProvider": "codex",           // an account id
  "enabledProviders": ["codex", "claude_work"],
  "models":    { "claude_work": [{ "id": "opus", "favorite": true }] },
  "streaming": { "claude_work": true },
  "instances": {
    "claude_work": {
      "driver": "claude",
      "displayName": "Claude (Work)",
      "accentColor": "#d97757",
      "config": { "binaryPath": "", "homePath": "~/.t3-claude-work", "shadowHomePath": "", "launchArgs": "" },
      "env": [{ "name": "ANTHROPIC_LOG", "value": "debug", "sensitive": false }]
    }
  }
}
```

- **binaryPath** — which binary to spawn (empty = the driver's own, off PATH).
- **launchArgs** — extra argv, split like a shell would but *not* a shell: quotes are honoured, no
  expansion, no operators.
- **env** — applied before the home override, so a stray `CLAUDE_CONFIG_DIR` entry can't take an
  account off its own login. `sensitive` only stops the value being sent back to the browser; it is
  stored in the clear like every other secret on this box.
- Deleting an account drops its curated models and streaming preference too, so reusing the id later
  doesn't resurrect them. **The config directory and the login are left on disk** — deleting
  someone's credentials because they tidied a list is not a trade this makes.

## Where accounts show up

- **Chat** — the provider picker lists accounts, each with its driver's logo and its own name.
- **Usage** — one card per metered account, with its own plan, renewal and quota. Extra accounts are
  registered with the quota poller (`data/ai-usage.json`, `managedBy: "totem"`), which reads each
  home's own credentials. The default homes (`~/.claude`, `~/.codex`) are found by the poller's own
  discovery, so they aren't written twice. For a Codex overlay account the shared session log
  belongs to whoever ran last, so its live quota comes from the poller rather than that log.
- **Delegation** (`totem_pick_provider` and friends) ranks *accounts*: the driver order
  (`codex → claude → cursor → opencode`), each driver's default account first, extras after. "Codex
  is out of room" is only ever true of one login.
- **MCP** — a sync writes into each enabled account: Claude's user-scope servers are per config
  directory, so every Claude account is synced in its own environment; Codex accounts share one
  `config.toml` through the shadow home and are synced once.

## Endpoints

| | |
|---|---|
| `GET /api/connections` | one row per account: identity, plan, paths, env (sensitive values redacted), capabilities, plus a `drivers` list saying which CLIs accept another account |
| `PUT /api/providers/config` | `{ defaultProvider, defaultModel, enabledProviders, models, streaming, instances }` — `instances` patches one account's own settings; an account can't change driver |
| `POST /api/providers/instances` | `{ driver, displayName }` → creates an account (paths filled in) |
| `POST /api/providers/instances/remove` | `{ id }` — refuses the built-in account of a driver, and the current default |
| `GET /api/chat-models?provider=<accountId>` | that account's catalog, plus the enabled-account roster |

## Tests

`node --test providers/instances.test.mjs` — id rules, ordering, the environment each account is
spawned with, and the shadow home against a real filesystem (shared config visible, `auth.json`
private, symlinked `auth.json` refused, real file never deleted).
