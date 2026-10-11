# Screen — this machine's desktop, in Totem

The **Screen** tab shows the desktop of the machine Totem runs on and lets you
drive it with your mouse and keyboard, from any computer you can sign in to
Totem on. Agents get a screenshot tool for the same screen. It is built for a
Mac running macOS Screen Sharing, and works against any VNC server.

Off by default. Set `SCREEN_ENABLED=true` in `.env` and restart.

It is a viewer, not another browser-automation stack. Agents can look
(`screen__screenshot`); they cannot click or type through it. Operating the
desktop is the job of chat's computer use (docs/chat.md).

## Files

| Thing | Location |
|---|---|
| Status and screenshots (`screencapture`, `sips`) | `screen/index.mjs` |
| WebSocket → VNC relay, handshake auth | `screen/relay.mjs` |
| Sealed "remember for" logins | `screen/credentials.mjs` |
| Wiring, MCP tools, agent rule | `bridge.mjs` (search `SCREEN_ENABLED`) |
| Gateway slice (`screen__*`) | `mcp-gateway.mjs` |
| The view (noVNC, login card, toolbar) | `web/src/screen/` |

## How it works

```
browser (noVNC, speaks RFB)
   │  wss://<your-host>/api/screen/ws   (Totem sign-in or bridge secret)
bridge.mjs ── screen/relay.mjs ── TCP 127.0.0.1:5900
                                     │
                              macOS Screen Sharing (asks for the Mac's own login)
```

The bridge relays bytes and never parses RFB, so there are two locks: Totem's
sign-in on the WebSocket, then the Mac's own login inside the VNC protocol.
noVNC handles Apple's login (ARD, type 30: Mac account name and password) and
the classic VNC password (type 2). The login card asks for whichever the Mac
offers. By default what you type is kept in memory for reconnects until the
page reloads, and never stored.

### Remember for 30 minutes to 5 hours

The login card's **Remember** menu keeps the login for 30 minutes, 1, 2 or 5
hours, so reloading or coming back later signs you in to the Mac without
asking again. The browser never stores the password:

- Once the Mac accepts a login, the browser sends it to
  `POST /api/screen/credentials/seal` with the chosen minutes. The bridge
  encrypts `{username, password, expiresAt}` with AES-256-GCM under a key that
  stays on this machine (`data/screen-credentials.key`, 0600, created on first
  use) and answers with the sealed token and its expiry.
- The browser keeps only that token (`localStorage` `totem.screen.login`).
  When the Mac next asks for a login, the browser trades the token for the
  login at `POST /api/screen/credentials/open`, which needs a signed-in
  request and answers 410 once the time is up or the token is not genuine.
- A copy of the browser's storage is useless without this machine, and this
  machine holds nothing to steal without the token. The key survives restarts,
  so a deploy does not sign you out of the Mac.
- **Forget:** the key button in the toolbar drops this browser's token. A login
  the Mac refuses is dropped automatically. Deleting
  `data/screen-credentials.key` forgets every remembered login on every
  browser at once.

The view is desktop only: it is not on the phone drawer, and `/screen` on a
phone says so without opening a connection. noVNC is a separate chunk that
loads only when the tab opens. It uses top-level await, which is why
`web/vite.config.ts` targets es2022 browsers.

## Setup on a Mac

1. **Screen Sharing on.** System Settings → General → Sharing → Screen Sharing.
   Totem connects over loopback, so port 5900 never needs to be reachable from
   anywhere else.
2. `SCREEN_ENABLED=true` in `.env`, then restart Totem.
3. **Screenshots for agents (optional).** Give Screen Recording to the node binary
   running Totem: System Settings → Privacy & Security → Screen & System Audio
   Recording → +, then ⌘⇧G and paste the path `GET /api/screen/status` names
   (`node`). Restart Totem. Like Apple data's Full Disk Access, the grant belongs
   to the binary's real path, so a Homebrew node upgrade drops it silently. The
   Screen tab's toolbar says "Agents can't take screenshots yet" until it works.
   You can do this step from the Screen tab itself.

## .env keys

- `SCREEN_ENABLED`: `true`/`false`. **Default `false`.** With it off there is no
  WebSocket route, no tab and no tools.
- `SCREEN_VNC_HOST`: default `127.0.0.1`.
- `SCREEN_VNC_PORT`: default `5900`.

## API

| Route | Answer |
|---|---|
| `GET /api/screen/status` | `{enabled, state, platform, node, viewer:{state, detail}, screenshots:{state, detail}, wsPath, rememberMinutes}`. 404 with the same shape when off. `state` is `ready`, `partial` or `unavailable`. Checking screenshots takes a real throwaway capture, because trying is the only reliable test of the grant. |
| `POST /api/screen/credentials/seal` | `{username?, password, minutes}` with minutes one of `rememberMinutes` (30, 60, 120, 300) → `{token, expiresAt}`. |
| `POST /api/screen/credentials/open` | `{token}` → `{username?, password, expiresAt}`, or 410 when expired, tampered or sealed under a replaced key. |
| `GET /api/screen/ws` (upgrade) | Raw RFB over binary frames. Subprotocol `binary`, plus `totem.bearer.<base64url(secret)>` for a browser unlocked with the bridge secret. 401 without auth, 429 past 4 viewers, close code 4502 when nothing listens on the VNC port. |

## Agent tools

Registered only with `SCREEN_ENABLED` on: `totem_screen_get_status` and
`totem_screen_screenshot` on `/mcp`, and `screen__get_status` /
`screen__screenshot` through the gateway. Both are `readLocal`. A screenshot is a
PNG under `$TMPDIR/totem-screen/`, scaled so the longest side is `maxSize`
pixels (default 1600). An agent opens `imagePath` to look, and shows the owner
with `![…](imagePath)`, which a chat turns into an attachment (the temp dir is
one of `embedLocalImages`' allowed dirs). Screenshots older than a day are
deleted on the next capture.

## Security

- **This is full control of the machine** for anyone past Totem's sign-in and the
  Mac's login. It is off by default for that reason.
- The relay uses the terminal's handshake (`protocolsAuthorized` in
  `terminal/ws.mjs`): the bridge secret in the subprotocol list, or a cookie
  session whose upgrade comes from this host (`upgradeOriginAllowed`). A cookie
  socket re-checks its session every 30 seconds and closes with 4401 once it has
  been signed out.
- Viewing while a computer-use run is working means two hands on one mouse.
  Switch the view to view-only (the eye button) to watch without interfering.
