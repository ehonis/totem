# Terminal — a real shell in the dashboard, one keystroke away

Press <kbd>Ctrl</kbd>+<kbd>`</kbd> anywhere in Totem (or click the terminal button
bottom-right) and a right-docked panel slides in with a real login shell on the box.
Tabs for multiple shells, drag the left edge to resize, and every command you run
counts on the **Totem activity** card.

Off by default. Set `TERMINAL_ENABLED=true` in `.env` and restart.

## Why it looks like this

Modelled on [t3code](https://github.com/pingdotgg/t3code)'s terminal — `node-pty` on
the server, `@xterm/xterm` in the browser, sessions owned by the server and streamed
over a WebSocket. t3code hosts terminals as tabbed surfaces in its right panel, which
is the shape copied here. Its split-pane layout is not; tabs only.

The property worth protecting is that **the shell is not in the browser**. The PTY
lives in the bridge process. Closing the panel, switching tabs, navigating to
Overview, or reloading the page detaches a viewer — it does not kill the shell. A
`npm run build` you kicked off keeps running, and when you come back the scrollback
replays and you are where you left off. That is the whole reason there is a session
manager rather than one PTY per socket.

## Files

| Thing | Location |
|---|---|
| Session manager (PTY lifecycle, scrollback, attach/detach) | `terminal/sessions.mjs` |
| Command detection for the activity metric | `terminal/commands.mjs` |
| WebSocket transport + handshake auth | `terminal/ws.mjs` |
| Wiring, config, and the activity hook | `bridge.mjs` (search `TERMINAL_ENABLED`) |
| Panel UI (tabs, resize, xterm instances) | `web/src/components/TerminalPanel.tsx` |
| Browser socket client (reconnect, multiplexing) | `web/src/terminal/client.ts` |
| Toggle, hotkey, layout column | `web/src/App.tsx`, `.app.term-open` in `styles.css` |

## .env keys

- `TERMINAL_ENABLED` — `true`/`false`. **Default `false`.** Nothing is spawned, and no
  WebSocket route exists, when this is off.
- `TERMINAL_SHELL` — shell to run. Default `$SHELL`, then `/bin/bash`. Started with
  `-l` so it sources your real profile (PATH, aliases, prompt).
- `TERMINAL_CWD` — working directory for new sessions. Default: your home directory.
- `TERMINAL_MAX_SESSIONS` — concurrent live shells. Default `8`.
- `TERMINAL_SCROLLBACK_BYTES` — replay buffer per session. Default 512KB, so the
  worst case is this times `TERMINAL_MAX_SESSIONS` held in memory.

## Security

**This is not a new capability.** The bridge already spawns `cursor-agent`, `codex`,
and `claude` with full shell access behind the same `BRIDGE_SECRET`. The terminal is
the same authority with a direct interface rather than an agent in front of it. It is
still gated off by default, and it is still worth understanding the three controls:

1. **Bearer auth on the handshake.** Browsers cannot set an `Authorization` header on
   a WebSocket, and a bearer in the query string ends up in every access log between
   here and the browser. So the secret rides in the subprotocol list as
   `totem.bearer.<base64url(secret)>` — the trick the Kubernetes API server uses.
   Compared timing-safely; the upgrade is refused before any PTY exists.
2. **Cloudflare Access**, in front of `<your-host>`, unchanged.
3. **Attach-before-write.** A socket may only send input to a session it attached to,
   so knowing (or guessing) a session id is not enough to type into someone's shell.

Cross-site WebSocket hijacking does not apply: a malicious page can open a socket, but
authentication is a secret it cannot read, and there is no cookie or other ambient
authority to ride on. The origin check in `ws.mjs` is defense in depth, not the
load-bearing control.

**The shell does not inherit the bridge's secrets.** The bridge runs with
`node --env-file=.env`, so its own environment is full of credentials a shell you open
on this box would never normally see. `readEnvFileKeys()` reads the *key names* back
off `.env` and subtracts exactly those, so the terminal gets a normal login
environment. Essentials (`PATH`, `HOME`, `SSH_AUTH_SOCK`, …) are never stripped even
if you put them in `.env`.

## The command metric

Every command you submit is logged as a `terminal.command` productivity event, so it
lands on the Overview's **Totem activity** card alongside todos, habits, and events.
It counts toward the daily total and gets its own band in the chart, but is
deliberately excluded from `created` and `completed` — running `ls` is activity, not
an accomplishment.

### How a keystroke stream becomes a command

A PTY carries keystrokes, not commands, so `terminal/commands.mjs` reconstructs the
submitted line from the input stream. It models printable characters, backspace,
<kbd>Ctrl</kbd>+<kbd>U</kbd>, <kbd>Ctrl</kbd>+<kbd>W</kbd>, and
<kbd>Ctrl</kbd>+<kbd>C</kbd> — and nothing else, because emulating readline is a
losing game.

Two rules keep it honest:

- **Full-screen programs do not generate commands.** vim, less, htop, and agent TUIs
  announce themselves by switching to the alternate screen buffer, so tracking
  `ESC [ ? 1049 h` / `l` in the *output* stream gates the detector off for their
  lifetime. Without this, every <kbd>Enter</kbd> inside vim would be a "command".
- **When the reconstruction is not trustworthy, the command is counted but not
  labeled.** Recall a line with the up arrow, or complete it with <kbd>Tab</kbd>, and
  the text we reconstructed is wrong — so we record the event with an empty label
  rather than a misleading one. Counting is the metric; the label is a convenience.

### Secrets are counted, never labeled

The keystrokes reach us whether or not the terminal is echoing them, so a `sudo`
password would otherwise land in a label. Two guards:

1. The detector arms a **sensitive** flag when the last line of output ends in `:` or
   `?` and mentions a password/passphrase/token/secret. The submitted line is then
   counted with an empty label. The flag **latches** — only submitting or abandoning
   the line clears it. This matters: `read -p "Enter API token: "` echoes what you
   type, so recomputing the flag per output chunk disarmed it after the first
   keystroke and leaked the secret. Only echo-off prompts like `sudo` survived that
   version, which the unit tests happily agreed was correct;
   `terminal/e2e.test.mjs` driving a real shell is what caught it.
2. `redact()` runs over every label that does get stored, scrubbing inline
   `FOO_TOKEN=…` assignments, bearers, `sk-…` keys, and any value this process holds
   as a secret.

Neither is a guarantee against a determined mistake — if you paste a password as a
bare command at a normal shell prompt, it is a command and gets labeled. The failure
mode is biased toward losing a label, not toward storing a secret.

## Protocol

JSON text frames over `/api/terminal/ws`, one message per frame, multiplexed by
session id.

| Direction | Message |
|---|---|
| → | `{ t: 'open', cols, rows, title? }` |
| → | `{ t: 'attach', id, cols, rows }` |
| → | `{ t: 'input', id, data }` |
| → | `{ t: 'resize', id, cols, rows }` |
| → | `{ t: 'clear', id }` · `{ t: 'close', id }` · `{ t: 'list' }` |
| ← | `{ t: 'ready', sessions, maxSessions }` — sent on connect |
| ← | `{ t: 'attached', session, replay, truncated }` — `replay` is the scrollback |
| ← | `{ t: 'data', id, data }` · `{ t: 'exit', id, exitCode, signal }` |
| ← | `{ t: 'opened', session }` · `{ t: 'sessions', … }` · `{ t: 'closed', id }` |
| ← | `{ t: 'error', message, id? }` |

`GET /api/terminal/status` (bearer-authed) reports `{ enabled, reason, wsPath,
maxSessions, sessions }`. The dashboard asks before rendering its toggle, so a bridge
with the terminal off simply has no terminal button rather than one that fails.

Output is batched over an 8ms window before framing — a build spewing lines would
otherwise cost one frame per PTY read. A client that stops draining (>4MB buffered)
has its output dropped rather than the server growing without bound; reattaching
replays from the server-side scrollback.

## Lifecycle

- Sessions outlive sockets. Detaching is not killing.
- A shell that exits is kept for 5 minutes so a client that was away still sees the
  final output and exit code, then reaped. **Live sessions are never reaped** — a
  long build is the point.
- `SIGINT`/`SIGTERM` kills every session, so a bridge restart leaves no orphan shells
  reparented to init.

## Testing

`npm test` covers the pure logic — the command detector's awkward cases (backspace,
vim, password prompts) and the handshake rules — with no shell required.

The integration test is opt-in because it boots a bridge and spawns real shells:

```
TERMINAL_E2E=1 node --test terminal/e2e.test.mjs
```

It asserts the things unit tests cannot: that it is a real tty, that reattach replays,
that an unattached socket cannot type into your shell, and that a secret typed at an
echoing prompt is counted but never written to the activity log.

## Gotchas

- **`node-pty` is this repo's only native module.** On Linux it compiles from source
  at `npm install` (the shipped prebuilds are macOS/Windows only), so the box needs a
  C++ toolchain. It uses N-API, so the built binary survives Node major upgrades —
  verified working on both Node 22 and 24. It is loaded with a dynamic `import()` and
  a `catch`, so if it ever fails to load you lose the terminal panel, not the bridge.
- **`npm install` at the repo root is now part of deploy.** The bridge is no longer
  dependency-free. `git pull && npm install && systemctl --user restart
  assistant-bridge`.
- **Dev mode needs `ws: true`** on the Vite `/api` proxy, or the socket 404s under
  `npm run dev` while every other `/api` call works fine. Already set in
  `web/vite.config.ts`.
- **Tab labels track the last command**, which the bridge reports on the session
  rather than in the data stream, so they update on a 1.5s debounce after output
  settles rather than instantly.
