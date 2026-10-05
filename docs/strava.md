# Strava connector

Everything the owner logs on Strava — rides first, but runs, walks, hikes, lifts and
climbs too — readable from Totem, from the agents Totem runs, from ChatGPT and
Claude over the MCP server, and from Bushido. WHOOP knows how hard a session was
(heart rate, strain, recovery); Strava knows what it *was*: distance, speed,
elevation, power, cadence, the route, which bike. Together they are the training
record the AI coach in Bushido reasons from.

Deliberately **unscoped**: this is the whole v3 API behind one OAuth grant, not
the three fields a ride card needs. The bike-mileage goal that will live in the
Productivity center's Goals later reads `gear.distanceMi` — Strava keeps each
bike's odometer itself — so that feature is a consumer of this connector, not a
change to it.

## Where it lives

| Piece | Path | Job |
|---|---|---|
| Shaping | `strava/shape.mjs` | Pure. Every Strava payload → a record carrying **both** unit systems (`distanceMi`/`distanceKm`, `avgMph`/`avgKph`, `elevationFt`/`elevationM`, `movingMin`/`movingSec`), a `family` (ride/run/walk/…), and the athlete's **local** date. Also the mileage roll-up. Tested in `shape.test.mjs`. |
| Cache | `strava/cache.mjs` | The local activity mirror (`data/strava-activities.json`): raw `SummaryActivity` rows keyed by id, incremental and resumable full syncs. Tested in `cache.test.mjs`. |
| Client | `strava/client.mjs` | OAuth (authorize, exchange, refresh, revoke), the API wrapper with rate-limit capture and fix-in-the-message errors, every read, the writes, `status()`, and the `training()` payload Bushido pulls. |
| Agent CLI | `strava/cli.mjs` | `node strava/cli.mjs <command>` — the agent CLIs' way in. Talks to the **bridge** (`/api/strava/*`) with the bridge secret from the environment or `.env`; never holds Strava credentials. |
| Bridge | `bridge.mjs` "Strava" block | Constants, the `strava` client instance, `stravaApi()` route dispatcher, `/strava-oauth/callback`, `STRAVA_RULES` (injected into every agent prompt once configured), the `totem_strava_*` MCP tools and their `MCP_TOOL_META`, the `strava-sync` job. |
| Gateway | `mcp-gateway.mjs` `BUILTIN_SERVERS` | Re-serves the `totem_strava_*` slice of the bridge's `/mcp` to the agent CLIs as `strava__*` (e.g. `strava__get_mileage`). |
| Dashboard | `web/src/components/StravaConnection.tsx` | Settings → Connections → Wearables & fitness: connect/reconnect/disconnect, sync buttons, Strava's own totals, each bike's odometer, API budget, scopes. |
| Bushido | `~/bushido/server/strava.js`, `~/bushido/app/src/strava.jsx` | Attaches a Strava activity to a logged session (the *Other training* card especially) with all its stats; see "Bushido" below. |

## Setup (once)

1. **Create an API application** at [strava.com/settings/api](https://www.strava.com/settings/api)
   (Strava may require a subscription for API access). Category anything.

   **Authorization Callback Domain: `<your-host>`** — a bare hostname, no
   `https://`, no path, no port. That field is a *domain*, not a URL, and Strava allows
   exactly **one** per application.

   Use the tunnel host rather than `localhost`, because **this box is never driven
   directly**: Totem is used from a phone and other machines over
   `<your-host>`, and a consent screen that redirects to `localhost:8787` lands
   on whatever is on port 8787 of *the device holding the browser* — usually nothing. Same
   reasoning as `WHOOP_REDIRECT_URI`, which has pointed at the tunnel since it was set up.
   Strava does whitelist `localhost`/`127.0.0.1`, so keep that in mind only if you ever want
   to authorize while sitting at the box.

   **Cloudflare Access is in front of that hostname and does not need an exception.** The
   callback is a top-level browser redirect, so it carries the `CF_Authorization` cookie the
   browser already holds from signing into the dashboard, and Access passes it through to the
   bridge, where the unguessable `state` is the real guard. (A bare `curl` of the callback
   path answers `401` for exactly that reason — no cookie. That is Access working, not a
   misconfiguration.)
2. **Put the credentials in `.env`** (gitignored): `STRAVA_CLIENT_ID=…`, `STRAVA_CLIENT_SECRET=…`,
   (or Settings -> Integrations). With `PUBLIC_URL=https://<your-host>` set, the redirect URI defaults to `https://<your-host>/strava-oauth/callback`; `STRAVA_REDIRECT_URI` overrides it. It must match the
   domain above. The `Your Access Token` / `Your Refresh Token` values Strava shows on that
   settings page are **not** used by any of this and do not belong in `.env` — they are a
   six-hour `read`-only sample pair for curl experiments, while the connector runs the real
   OAuth flow and stores its own rotating pair in `secrets/strava-oauth.json`.
3. **Restart the bridge:** `systemctl --user restart assistant-bridge`.
4. **Authorize.** Settings → Connections → Wearables & fitness → Strava → **Connect Strava**.
   The consent screen lists every requested scope; leave them all ticked. The callback
   stores the token pair (and who you are) in `secrets/strava-oauth.json`. From a phone,
   if `localhost` fails to load, swap it for the box's Tailscale IP with the same port —
   the callback route is unauthenticated (a browser redirect cannot carry the bearer) and
   guarded by the unguessable `state`.
5. **Sync history** once (the button, or `node strava/cli.mjs sync --full`). A fresh app has
   a read budget of 100 requests per 15 minutes; each 200 activities is one request, so
   years of history is a handful. Turn on **Studio → Jobs → Strava sync** to keep the
   mirror current (every 3 h by default).

New Strava apps are in "single-player mode" — only your own account can authorize —
which is exactly right here.

### Scopes

Requested by default (`STRAVA_SCOPES` overrides):

| Scope | Why |
|---|---|
| `read`, `read_all` | Public + private segments, routes, profile basics |
| `profile:read_all` | `/athlete/zones` and `/athletes/{id}/stats` — the zone boundaries and Strava's own totals |
| `profile:write` | Setting weight (`totem_strava_update_athlete`) |
| `activity:read_all` | Activities including those marked Only You, and privacy-zone data |
| `activity:write` | Renaming/describing/re-gearing a ride, logging a manual activity |

`activity:read_all` implies `activity:read`, and `read_all` implies `read`; the client
knows that when checking a grant. **The granted scope arrives on the callback URL**
(`?scope=read,activity:read_all,…`), not in the token response, and a refresh never
widens it — reconnect (the authorize URL uses `approval_prompt=force`, so the consent
screen always shows) to add one. `status.missingScopes` says which are absent.

## The surface

### HTTP — `/api/strava/*` (bearer-authed, same secret as the dashboard)

| Method / path | Does |
|---|---|
| `GET status` | configured / connected / state / athlete / scopes / rate limit / cache |
| `POST connect` → `{authUrl}` · `POST disconnect` | OAuth start; revoke + forget |
| `POST sync` `{full?, pages?}` | Refresh the activity mirror |
| `GET athlete?stats=1&zones=1` · `GET stats` · `GET zones` | Profile with bikes/shoes; recent/YTD/all-time totals; HR & power zones |
| `GET activities?days=&after=&before=&sport=&limit=&page=&source=live\|cache` | The list, shaped |
| `GET activity?id=&laps=1&zones=1&efforts=1&streams=heartrate,watts&comments=1&kudos=1` | One activity in full |
| `PUT activity` `{id, name?, description?, sportType?, gearId?, commute?, trainer?, hideFromHome?}` | Edit |
| `POST activity` `{name, sportType, startDateLocal, elapsedSec, description?, distanceMeter?, trainer?, commute?}` | Manual activity |
| `GET gear?id=` | One item, or all bikes + shoes with detail |
| `GET mileage?group=week\|month\|year\|day\|sport\|family\|gear\|all&days=&from=&to=&sport=&gear=&sync=0` | Roll-up from the cache (refreshes first if > 30 min old) |
| `GET routes?id=&streams=1` · `GET segments?mode=starred\|detail\|efforts\|effort\|explore&id=&bounds=` · `GET clubs?id=` | The rest of the API |
| `PUT athlete` `{weightKg\|weightLb}` | Profile weight |
| `GET training?days=N` | **Bushido's pull**: activities in the window + `gear` map + athlete constants |

Errors are `{error, needsReauth?, missingScope?, rateLimited?}` with status 502 (Strava
said no), 429 (rate limit), 404 (no such activity/route/endpoint). The message carries the
fix — "reconnect Strava to grant activity:read_all" — because it surfaces two processes
away in Bushido and in a model's reply, where a bare status code helps nobody.

### MCP — `totem_strava_*` on `POST /mcp` (ChatGPT, Claude.ai, Claude Code)

Thirteen tools, all annotated (`MCP_TOOL_META`) and with output schemas:
`get_status`, `get_athlete` (profile + totals, `includeZones`), `get_activities`,
`get_activity` (laps / zones / efforts / streams / comments / kudos on request),
`get_gear`, `get_mileage`, `get_routes`, `get_segments`, `get_clubs` — read-only,
open-world; `update_activity` (destructive, idempotent), `create_activity` (additive),
`update_athlete` (destructive, idempotent); `sync` (writes the local cache, idempotent).
The `initialize` instructions carry a FITNESS paragraph so a cloud model knows "how many
miles are on my bike" is `get_gear` and that quantities come in both units;
`totem://state` gains a `fitness` block.

### Gateway — `strava__*` for the agent CLIs

`mcp-gateway.mjs` dials `http://127.0.0.1:${BRIDGE_PORT}/mcp` with `BRIDGE_SECRET` (from
the environment the bridge exports to the CLIs it spawns, or from the repo's `.env` for a
terminal session) and re-serves only the `totem_strava_*` tools, renamed by stripping
the prefix. Nothing else on `/mcp` is re-served — local tasks are a separate in-process gateway
built-in, Calendar is configured directly, and an agent staging prompts for another agent is a loop. The bridge's
in-process gateway (`totem_call_connection`) is built with `{ builtins: false }` so it
never dials itself. `node mcp-gateway.mjs --status` lists `strava` with `builtin: true`.

### Prompt — `STRAVA_RULES`

Appended to every agent prompt (web, Shortcut, jobs) **once `STRAVA_CLIENT_ID`/`SECRET`
are set**. It names the CLI, lists the commands, says which questions are Strava's rather
than WHOOP's, and fixes the unit convention (quote miles/mph/feet unless asked). Where the
gateway is on, the agent may use `strava__*` instead; both are the same reads.

### CLI — `node strava/cli.mjs`

```
status | athlete [--zones] | stats | zones
activities [--days 30] [--sport ride|run|…] [--limit 50] [--after YYYY-MM-DD] [--before …] [--source cache]
activity <id> [--laps] [--zones] [--efforts] [--streams heartrate,watts,altitude,velocity_smooth]
gear [id]
mileage [--group week|month|year|day|sport|family|gear|all] [--days N] [--sport ride] [--gear bXXXX] [--from …] [--to …]
routes [id] [--streams] | segments [starred|detail|efforts|effort|explore] [--id N] [--bounds …] | clubs [id]
sync [--full] [--pages N]
update-activity <id> [--name …] [--description …] [--sport-type …] [--gear-id …] [--commute true|false] [--trainer …]
```

`--compact` prints one-line JSON. `BRIDGE_URL` overrides the host for a bridge on another port.

## Shapes worth knowing

- **Both units, always.** `distanceMi` + `distanceKm` + raw `distanceMeter`; `avgMph` +
  `avgKph` + `avgSpeedMps`; `elevationFt` + `elevationM`; `movingMin` + `movingSec`;
  `weightLb` + `weightKg`. Foot sports (run/walk/hike) also get `paceMinPerMi`,
  `paceMinPerKm` and a `paceLabel` like `8:36 /mi`; wheeled sports get speed only.
- **`date` is the athlete's local date.** Strava's `start_date_local` is a wall-clock time
  with a spurious `Z`; it is read as text. `start`/`end` are the real UTC instants
  (`end` = start + elapsed). A 23:30 ride is filed under the day it started.
- **`family`** groups the ~50 `sport_type` values: `ride` covers Ride, VirtualRide,
  GravelRide, MountainBikeRide, EBikeRide…; `run` covers Run, TrailRun, VirtualRun; then
  walk, hike, swim, lift, climbing, mobility, ski, water, sport, other. Filters accept a
  family, an exact type, a comma list, and `bike` as a synonym for `ride`.
- **Summaries have no `calories`** — only the detail endpoint reports them, and deriving
  kcal from `kilojoules` is right for cycling and wrong for everything else.
- **Mileage buckets** carry `count`, `distanceMi/Km`, `movingMin`, `elevationFt` and a
  **distance-weighted** `avgMph` (total distance over total time, not a mean of per-ride
  averages). Weeks are Sunday-start and labelled by the Sunday, like the habit tracker.
- **Gear odometer.** `gear.distanceMi` is Strava's own running total for that bike. It is
  the number for a "replace the bike at N miles" goal — not a sum over rides, which misses
  anything logged before the bike was tagged or on another account.

## The cache

`data/strava-activities.json`: `{ version, athleteId, updatedAt, oldestStart, newestStart,
complete, activities: { [id]: SummaryActivity } }`. Raw rows, so a shaping fix applies to
history without a resync.

- **Incremental** (the job, the Sync button, and any mileage read older than 30 min):
  `after = newestStart − 3 days`, forward until a short page. The overlap catches an
  activity uploaded late or edited, which is why `updated` is usually non-zero.
- **Full** (`{full:true}`): walks backward with `before` from `oldestStart`, 200 per
  request, bounded by `pages` (25 by default). Hits the cap → `complete: false`; run it
  again and it continues. A full sync on an already-complete cache just re-reads the
  newest page.
- A different athlete connecting empties it. Deleting the file is safe; the next read
  rebuilds it.

## Bushido

Bushido reads Strava the way it reads WHOOP: through the bridge, holding no credentials.
`GET /api/strava/training?days=N` returns the recent activities (shaped, with `date`,
`start`, `end`, and every stat), a `gear` map for their gear ids, and the athlete's
weight/FTP. Bushido caches that in `data/strava.json` (disposable), offers the day's
activities on each session's log card, and on attach copies a **snapshot** onto the entry
(`out.strava`) — distance, moving/elapsed minutes, speed, elevation, heart rate, power,
cadence, relative effort, gear name, and the ride's laps and splits from
`GET /api/strava/activity?id=&laps=1`. On the *Other training* card the snapshot also
fills any blank numeric fields (activity, duration, distance, speed, elevation) and remembers
which it filled, so detaching clears exactly those. Full detail in `~/bushido/AGENTS.md` §6.

## Rate limits and gotchas

- **Budget:** 100 reads / 15 min and 1,000 / day (200 / 2,000 overall) on a new app.
  Windows reset at :00/:15/:30/:45 and midnight UTC. Every response's
  `X-RateLimit-*` / `X-ReadRateLimit-*` headers are captured; `status.rateLimit` and the
  Connections card show them. A 429 comes back as a `StravaError` with `rateLimited: true`
  and a "resets in about N min" message. Nothing here comes close unless a model loops.
- **Token lifetime.** Access tokens live 6 h; the client refreshes at T−5 min and persists
  whatever comes back, because a rotated refresh token kills its predecessor immediately.
  Refreshes are serialised (one in flight) for the same reason.
- **`needsReauth` is latched**, WHOOP-style: only a token-endpoint 400 naming the refresh
  token flips it; a 5xx or a bare 400 during an outage does not. Reconnect is always
  offered in the UI regardless.
- **A missing scope is a 401**, not a 403: Strava answers
  `{"errors":[{"resource":"AccessToken","field":"activity:read_permission","code":"missing"}]}`.
  The client turns that into "the grant lacks activity:read — click Reconnect Strava".
- **Disconnect** posts to `/oauth/revoke` (Basic auth with client id/secret; Strava's
  recommended endpoint since June 2026) and falls back to the legacy `/oauth/deauthorize`,
  then forgets the file either way. Cached activities are left alone.
- **Terms.** Strava's API agreement forbids using its data to train AI models and limits
  what may be shown to other users. A single-athlete personal dashboard and an assistant
  reading your own rides is the intended use; do not point this at anyone else's account.
