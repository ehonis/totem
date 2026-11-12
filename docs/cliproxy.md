# CLIProxy

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) holds Claude and Codex
subscription logins on one machine and serves them to Claude Code and Codex as one API.
When Totem's agent CLIs point at a proxy, the logins on Totem's own machine are not what
gets spent, so Totem's usage limits read the proxy's logins instead.

## Setting it up

Set both, in Settings → Providers › CLIProxy or the environment (the environment wins):

| Variable | What |
|---|---|
| `CLIPROXY_URL` | The proxy's base URL as Totem's machine reaches it, e.g. `http://proxy.example.net:8317`. Its management API must allow remote access (`management.allow-remote: true`) if it is on another machine. |
| `CLIPROXY_MANAGEMENT_KEY` | A management key. Use a scoped one (below). |

Both are read on every call, so no restart is needed. Nothing changes until both are set.

### Use a scoped key

The proxy's own management key can download every login's refresh token and make an
upstream call with any login's token to any URL. Agents run as the same user as Totem and
can read what Totem stores (`AGENTS.md` → Gotchas), so a full key in Totem is every
subscription's tokens in every agent's reach. The CLIProxyAPI fork Totem is developed
against adds `management.scoped-keys`: a key that reaches only the routes Totem uses, whose
`api-call` is limited to the vendors' usage, profile and reset endpoints, and which cannot
download a credential. Totem also refuses, on its own side, to send a login's token to any URL
but those (`UPSTREAM_ALLOWED` in `cliproxy/client.mjs`).

What Totem needs, in the proxy's `config.yaml` under `management:`. Generate the key with
`openssl rand -hex 32`, hash it with `printf %s "$KEY" | sha256sum`, put the hash here and the
key itself in Totem:

```yaml
scoped-keys:
  - name: totem
    key-sha256: "<64 hex characters>"
    routes:
      - "GET /v8/management/credentials"
      - "GET /v8/management/quota/history"
      - "POST /v8/management/quota/history"
      - "GET /v8/management/credentials/models"
      - "PATCH /v8/management/credentials/status"
      - "PATCH /v8/management/credentials/fields"
      - "POST /v8/management/credentials/refresh"
      - "DELETE /v8/management/credentials"
      - "POST /v8/management/routing/cooldown/reset"
      - "POST /v8/management/requests/api-call"
      - "GET /v8/management/oauth/auth-url"
      - "GET /v8/management/oauth/status"
      - "DELETE /v8/management/oauth/session"
    api-call-urls:
      - "https://api.anthropic.com/api/oauth/usage"
      - "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1"
      - "https://api.anthropic.com/api/oauth/profile"
      - "https://api.anthropic.com/api/organizations/*/reset_rate_limits"
      - "https://chatgpt.com/backend-api/wham/usage"
      - "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
      - "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
```

Leave out the `DELETE`, `PATCH .../fields` or `oauth` lines to give Totem less. A route the key
does not list is refused with "scoped key: route not allowed", which the tab reports as a
missing scope rather than a wrong key. Whatever it lists, a scoped key can never read or change
the config, download a credential, read logs, reach a v0 route, set a login's proxy URL or
headers, get a refreshed login's tokens back, or send a token anywhere but the listed URLs'
`Authorization` header.

A key refused with 401 is not retried for half an hour, unless the URL or key changes,
the owner saves the proxy settings again, or presses Retry. Replies from before a save
or Retry cannot change that refusal state. A successful in-flight reply never clears a
newer refusal. A 403 such as remote management being off
shows the proxy's scrubbed reason and does not block retries; only a 401 counts toward
the proxy banning an address after five refusals in a row, the right key included.

## What Totem reads

- **The list**, `GET /v8/management/credentials`, once per poll (90 s idle, 15 s while a
  dashboard is watching, and after each agent turn on Claude or Codex). It is a call to the
  proxy, not to a vendor, and each login in it carries the rate-limit headers of its last
  request (**passive** quota: the 5-hour and weekly windows).
- **A vendor usage read** through the proxy (`POST /v8/management/requests/api-call`:
  Anthropic's `/api/oauth/usage`, ChatGPT's `/backend-api/wham/usage`), which also reports
  model-scoped windows and the plan. Only when the passive reading is over 3 minutes old, a
  window has reset since the last reading, or the owner pressed Refresh; at most once a minute
  per login while watched, once every ten minutes otherwise, and a forced refresh at most every
  20 seconds. These count against the vendor's rate limit for that login. A failed read keeps
  the last good meters at their own time, so a newer passive reading still replaces them. Once a
  known reset passes, current meters show an inferred refill; `beforeRefill` preserves the
  original reading and reset for history reconstruction.
- **Quota history**, recorded by the proxy from passive headers and fresh active readings. Active readings are posted once after a successful usage fetch; missing history support or scope leaves quota polling working.
- **The Claude profile** (`/api/oauth/profile`), for the plan name, every six hours.

Totem never refreshes a proxy login's token: the proxy owns its tokens, and two refreshers of
one Anthropic login sign each other out. Refresh in the limits panel asks for a fresh usage
reading instead.

## What the limits show

While the proxy is set up, its Claude and Codex logins replace this machine's own (ids
`claude:proxy:<credential file>`); Cursor is unaffected. Each account has a state:

| State | When |
|---|---|
| disabled | switched off in the proxy |
| error | could not be read, or its login needs signing in again |
| limited | its 5-hour or weekly all-models window is spent, or the proxy is holding it back (a credential cooldown or a retry time). The proxy keeps an old 429 message on a login until its next success, so that alone does not count. |
| low | under 25% left |
| ok | |

An account's headroom is its tightest all-models window: an account spent for the week
serves nothing even with a fresh 5-hour window. Model-scoped windows (a weekly Fable cap)
only badge it.

Each provider's pill shows what the next request can get: the best usable account's
headroom, or how long until one is back when none can serve, with a dot per account (green,
amber, red, hollow when off). The panel lists every account with its 5-hour and weekly
windows, one full-width bar per line, and a Claude account's weekly Fable tier under them when it reports one
(shown only: like any model-scoped window it never decides headroom). Renames and hiding in Settings → Usage apply to proxy accounts by id: a hidden one
leaves every list but still counts in its pool, because it still serves; hiding the whole
service hides its pill too.

If the proxy stops answering, the limits keep its last readings, marked stale from the second
missed poll, and say so. They never switch back to this machine's logins while the proxy is
set up.

## Notices

- One quota nudge per provider when no pooled account can serve ("All 2 Claude accounts
  are at their limit. The first one is back at 12:50 AM."), instead of a 5-hour one per seat.
  Weekly nudges stay per account. Only proxy pools: two local logins of one provider still
  get their own.
- Source health records `cliproxy` (the proxy answering) and `cliproxy:<email>` (a login that
  needs signing in again), so an outage reaches Settings → Connections and the
  once-per-outage notice.

## The CLIProxy tab

`/cliproxy`, on the rail once the proxy is set up (and reachable from the usage panel's
"Manage accounts"). One card per login, grouped by provider, showing every window it reports,
its cooldowns, its last 200 minutes of requests and whether the proxy has used it recently.

The graphs above the login cards reuse CLI Proxy API Management Center's pool chart and
projection model: weekly, 5-hour and combined; separate or together providers; remaining or
drain rate; 1/3/6-hour burn windows; future usage, quiet hours, off days and account stacks.
`GET /api/cliproxy/history` reads the proxy's last 21 days, maps current credential IDs and
returns only numeric quota windows. It needs `GET /v8/management/quota/history` in the scoped
key; active sample recording also needs `POST /v8/management/quota/history`. Older proxies
without history show a forecast, and a refused history scope has its own Retry message.

Claude's card also draws its weekly Fable cap as a blue line in the weekly and combined
views (remaining only): the seats' Fable windows pooled with the same plan weights, so it
reads on the card's own scale, recorded solid and projected dashed at Fable's own burn rate,
with its current value in the legend and the hover. History has it under two ids: the proxy
records the passive `anthropic-ratelimit-unified-7d_oi-*` headers as `seven_day_oi` (checked
against the live Fable reading: same percent, same reset), and active readings (Totem's own,
from the `weekly_scoped:Fable` meter, and the Management Center's) as `seven_day_fable`. The
history route returns both as `seven_day_fable`. Fable's projection ignores the weekly cap,
so after the weekly limit runs out it can still show Fable falling.

Every chart zooms and pans along time, all cards together (one view held by the page,
`web/src/cliproxy/pool/poolZoom.ts`): drag across a chart to zoom to that stretch, Ctrl/⌘ +
scroll or a trackpad pinch to zoom under the pointer, two fingers on a phone, a sideways
scroll to pan, double-click (or the reset button, or `0`) to see the whole page again. `+`/`-`
zoom from the keyboard. While zoomed a scrubber under the range row pans and resizes the view,
and the arrows slide by one view, moving on to the next page at its edge. The view stays
inside the page's range, so zooming never rebuilds the projection, and it is no narrower
than 30 minutes. Zoomed to three days or less, the axis counts hours.

An account exhausted for the week adds zero usable 5-hour capacity, both in the recorded
period when it was blocked and in the forecast until its weekly reset. In the forecast a
5-hour window starts on the first use after the last one ended, not on a fixed cadence, and
a window the API reports with no reset time (one that has not started, common on a seat that
is locked out for the week) starts when the projection first draws on it. On the combined
chart the hover lists each account's usable level beside its own weekly and 5-hour remaining
(`windowsByAccount` on the combined model), with the limit that sets the usable level
underlined and a dash before an account's first reading. The headline,
account stacks, reset labels and forecast agree at Now. Lockouts are not measured as token
consumption: burn still comes from the raw window readings. Claude plans are weighted by
price, not by the "Nx" in the tier name: Pro 1, Max 5x 5, Max 20x 10 (`claudePlanWeight` in
`web/src/cliproxy/pool/poolInputs.ts`), and the most expensive plan present counts as 100%.
A Team seat whose profile exposes a Max tier is weighted as that tier, so Max 20x plus a
Max 5x seat is a 150% pool. Codex logins all count 100%. The capacity denominator still
includes every plan's full share, so two equal seats remain a 200% pool.

Recorded capacity starts at each account/window's first observation. Adding a seat does
not fill earlier history or create a reset marker. Inferred refills retain the original
reading and reset, so a failed fetch after reset cannot erase a past weekly lockout.
Limit markers (weekly out, 5-hour out, weekly reset) are drawn for the past as well as the
forecast: dashed after Now from the projection, solid and fainter before it from each
account's history (`recordedLimitEvents` in `web/src/cliproxy/pool/poolLinked.ts`). A
recorded run-out is the first reading at zero after one above it; a recorded weekly reset is
a known reset the track jumps at, or a rise of 5 points or more to at least 95%. A 5-hour
run-out while that account's weekly limit is already out gets no marker of its own. Forecast
markers claim label room first; a marker without a label still names itself on hover.
If a contributing provider has no history, Together mode shows current readings and the
forecast without a partial recorded total, stacks, rates, past reset labels or past limit
markers. Separate
mode still shows each provider's available history.

The graph's toolbar keeps the view switches (limit, separate or together, remaining or
drain rate). The forecast tuning (projection routing, burn rate, future usage, quiet hours,
off days and the account bands) folds under Forecast settings, whose button counts what
differs from the defaults and offers Reset to defaults. Refresh login tokens is in the
header's ⋯ menu.

Projection routing is a forecast control (soonest reset by default, fill first or round
robin); it does not change the proxy's routing configuration. Match it to your proxy.
Forecasts and weekly-to-5-hour ratios are estimates; quiet hours and off days use the
viewer's local time. The MIT notice for the chart port is in
`web/src/cliproxy/pool/LICENSE` and shipped in `/third-party-notices.txt`.

| Action | Route (`POST`, body names the login) | Gate |
|---|---|---|
| Switch on or off | `/api/cliproxy/accounts/status` | session |
| Edit name (the proxy's note), priority, weight, Codex websockets | `/api/cliproxy/accounts/fields` | session |
| Ask the proxy to refresh one or every login token | `/api/cliproxy/accounts/refresh` | session |
| Clear the proxy's cooldown | `/api/cliproxy/accounts/cooldown` | session |
| Delete | `/api/cliproxy/accounts/delete` | session |
| Add a login, or sign one in again | `/api/cliproxy/login`, `/login/callback`, `/login/cancel` | session |
| Use a Claude reset grant | `/api/cliproxy/grants/claim` | approval code |
| Use a Codex reset credit | `/api/cliproxy/credits/consume` | approval code |

All of them are in `APPROVAL_ROUTES`, so the bridge bearer alone (any agent) is refused.
The login is looked up in a fresh proxy list for every action: its auth index, account id and
organisation come from the proxy, never from the request. Proxy URLs and credential headers
cannot be edited here, and credential files are never downloaded or uploaded.

**Signing in.** Totem asks the proxy for a sign-in URL and keeps its `state` for ten minutes,
one at a time. The owner opens the URL, signs in, and the browser lands on a page that does
not load (`http://localhost:54545/callback?…` for Claude, `http://localhost:1455/auth/callback?…`
for Codex): that whole address, or just its `code=…&state=…`, is pasted back. Totem accepts it
only for the sign-in it started (same provider, port, path and `state`), sends it once, never
logs it, and polls the proxy until the login appears, then says whether it added a new
account or signed an existing one in again. A sign-in left open shows a "Continue" banner
after a reload; an abandoned one is cancelled at the proxy when the next starts.

**Reset grants and credits** spend something scarce at the vendor. A Claude claim is only
offered when Anthropic says the grant is usable now; its request id is kept in
`data/cliproxy.json` (0600, `CLIPROXY_STATE_FILE`) so a claim that got no answer is retried
with the same id and grant within ten minutes, and cannot be spent twice. A Codex credit is
spent the same way: its redeem id is kept for ten minutes after an attempt with no answer, and
only one spend per login runs at a time.
