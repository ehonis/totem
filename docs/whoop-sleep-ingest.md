# WHOOP sleep sync

Fills the **Sleep** habit with last night's sleep performance *and* its stage
breakdown from the WHOOP API. Runs at 11:00 by default — late enough that the
band has synced, and that a night edited in the WHOOP app has been re-scored.

This replaced a Garmin Connect scrape. WHOOP publishes a real API (OAuth 2.0,
versioned REST, documented schemas), so the whole thing is a few `fetch` calls in
`bridge.mjs` — no Python sidecar, no venv, no TLS impersonation, nothing to break
when a vendor tightens a screw.

## Where to manage it

- **Settings → Connections → Wearables** — status, granted scopes, the redirect URI,
  and Reconnect. This is the home for it.
- **Productivity → Habits**, on the sleep chart — Reconnect sits next to Sync, with
  a one-line health note when the grant needs attention.

Both read the same `state` from the same endpoint, so they cannot disagree.

## What the graph shows

Two panels sharing one x-axis and one crosshair (`web/src/components/MetricChart.tsx`):

1. **Sleep performance + recovery** — two lines on the shared 0–100 scale. Sleep
   performance keeps the area wash; recovery is an unfilled line whose vertical
   stroke color follows the score and fades across WHOOP's official boundaries: red 0–33,
   yellow 34–66, green 67–100. The legend states the thresholds, so the series
   is not color-only.
2. **The night itself** — one bar per night on a labelled clock axis, running from
   bedtime to wake and subdivided into deep/REM/light/awake.

The second panel is a merge of what used to be two strips (a stage stack and a
separate time-in-bed band). Merging works because the numbers agree exactly: the
stage minutes sum to `total_in_bed_time_milli` to the minute, so the stages *are*
the band's contents rather than a parallel measurement. One mark then answers
three questions — position is when, height is how long, color is which stage.

**What the merged bar does and doesn't assert.** Its two ends are the real clock
times and each segment's length is a real count of minutes. The *order* of the
segments is not chronological: WHOOP reports per-stage totals, not a hypnogram,
so nothing in the payload says when deep sleep happened. That's why a caption sits
under the legend saying so — the bar would otherwise imply a sequence it can't
know. If WHOOP ever exposes intra-night stage events, that caption is the thing to
delete.

A night logged before stages were captured has no breakdown, so its bar draws as
one flat band (`w:rest`, legend "In bed, unscored"). The same segment absorbs any
no-data gap, which is what keeps the bar's top edge on the true wake time instead
of stopping short of it.

The strip is what makes bedtime drift visible — the read the score alone can't
give you. Its scale is anchored to noon of each window's *own* evening, never to
the date the night is filed under, so a 23:38 bedtime and a 00:13 bedtime sit 35
minutes apart on it instead of a day apart. It appears for any metric whose
entries carry a `window`, and is skipped on the compact Home tile, which has no
room for a clock axis — that tile still gets the plain stage strip. Time runs
downward (`reversed` on that `YAxis`): bedtime at the top of the bar, wake at the
bottom, the way a calendar draws a night.

The remaining readings (efficiency, consistency, respiratory rate, disturbances,
cycles, sleep debt) are in the hover tooltip, which is where a number belongs when
it has no time series worth drawing. Recovery also appears there as an exact
percentage alongside its colored trend line.

## Setup (once)

1. **Create an app** at [developer.whoop.com](https://developer.whoop.com) →
   Dashboard. You need an active WHOOP membership. Set:
   - **Scopes:** `read:sleep` and `offline` for this sync (offline is what makes
     WHOOP return a refresh token — without it the sync dies after an hour,
     permanently), plus `read:workout`, `read:recovery`, `read:cycles` and
     `read:body_measurement`, which are what Bushido reads through this bridge. See
     "Training data for Bushido" below.
   - **Redirect URI:** `http://localhost:8787/whoop-oauth/callback`, exactly.
     If WHOOP rejects a loopback URL, use the tunnel hostname instead and set
     `WHOOP_REDIRECT_URI` to the same string — it must match byte for byte.
2. **Put the credentials in `.env`** (gitignored):
   ```
   WHOOP_CLIENT_ID=…
   WHOOP_CLIENT_SECRET=…
   ```
3. **Restart the bridge** so it reads them: `systemctl --user restart assistant-bridge`
4. **Authorize.** Habits tab → the Sleep graph → **Connect WHOOP**. That opens
   WHOOP's consent screen and lands back on `/whoop-oauth/callback`, which stores
   the token pair in `secrets/whoop-oauth.json`. Click it again any time WHOOP
   invalidates the session.
5. **Turn the job on** in Totems → *WHOOP sleep sync*. `WHOOP_SLEEP_INGEST_ENABLED=true`
   only seeds the default on first boot — after that `data/jobs.json` is authoritative,
   so the toggle in the UI is the one that decides. See `docs/jobs.md`.

**Sync** next to the graph runs it on demand — the quickest way to confirm setup.

## How it runs

Scheduling is the job engine's (`docs/jobs.md`), not this feature's: it's an
agentless job, so it picks no AI, and a run the box slept through is caught up
within the job's grace window rather than lost.

`syncWhoopSleep` in `bridge.mjs` pulls `GET /developer/v2/activity/sleep` and
`GET /developer/v2/recovery` for the last `WHOOP_SLEEP_DAYS` (3) nights, following
`next_token`. A recovery is joined to its sleep by `cycle_id` before the sleep's
local wake date is chosen; dating the recovery independently would put it on the
previous evening. Each merged night is written through `logHabitRecord` — the
same path the dashboard and the agent use, so there's one writer and one set of
guard rails. Explicit API syncs accept up to 90 days for a bounded backfill;
scheduled runs keep the 3-day default.

| What | Where it lands |
|---|---|
| `score.sleep_performance_percentage` | the habit's `value` (the line on the graph) |
| matching recovery `score.recovery_score` via `cycle_id` | `stats.recovery` (the dynamic-color line) |
| `total_slow_wave_sleep_time_milli` | `parts.deep`, in minutes |
| `score.stage_summary.total_rem_sleep_time_milli` | `parts.rem` |
| `total_light_sleep_time_milli` | `parts.light` |
| `total_awake_time_milli` | `parts.awake` |
| `start` / `end` + `timezone_offset` | `window.start` / `window.end` — the band strip |
| `sleep_efficiency_percentage` | `stats.efficiency` |
| `sleep_consistency_percentage` | `stats.consistency` |
| `respiratory_rate` | `stats.respiratory-rate` |
| `stage_summary.sleep_cycle_count` | `stats.cycles` |
| `stage_summary.disturbance_count` | `stats.disturbances` |
| `total_in_bed_time_milli` | `stats.in-bed`, in minutes |
| `sleep_needed.*` summed | `stats.needed` |
| `need_from_sleep_debt_milli` | `stats.debt` |
| `need_from_recent_strain_milli` | `stats.strain-need` |

**`parts` vs. `stats`.** parts are a breakdown that sums to a total and draws as
one stacked bar; stats are standalone readings that share no unit and are never
added up. Keeping them in separate fields is what stops the chart from stacking a
percentage on top of minutes. Both merge key by key, so a writer that sends one
reading doesn't blank the others.

**`window` is a wall clock, not an instant** — `"2026-08-18T22:36"`, no offset. A
bedtime is the time the wearer saw on the clock; storing an instant and rendering
it in the viewer's zone would move a night slept in another timezone. WHOOP's
`start`/`end` bound the *in-bed* window (they equal `total_in_bed_time_milli` to
the millisecond), so the band is time in bed, and the stage parts are the asleep
portion of it. There is no sleep-onset field in the v2 payload — "fell asleep at"
is not something this API answers, and `start` is the closest honest reading.

Details worth knowing:

- **Which habit.** Whichever active habit has `metric.source: "whoop-sleep"` (set
  in the habit editor under "Filled by"). `WHOOP_SLEEP_HABIT_ID` is a fallback.
  The habit's id is still `wear-garmin-to-sleep` — renaming it would orphan a
  year of history, and ids are never shown in the UI.
- **Which number.** WHOOP has no single Garmin-style sleep score. Performance
  (slept vs. needed) is the closest analogue and what its own app leads with;
  `WHOOP_SLEEP_VALUE=efficiency|consistency` switches it.
- **Which date.** WHOOP timestamps a sleep at its *start*. `WHOOP_SLEEP_DATE_MODE=wake`
  (what this box uses) files a night under the morning you woke; `night`, the code
  default, uses the local date of `start`. The record's `timezone_offset` is applied
  before taking the date, because habit days are local days.

  **`night` is wrong if you go to bed after midnight.** A 00:13 bedtime and the
  *following* night's 22:36 bedtime share a local start date, so two nights collapse
  onto one — and because an already-logged night is left alone, the second one is
  silently dropped rather than overwriting the first. Observed 2026-08-19: five
  nights reduced to three dates (`checked: 3`), last night's 79 discarded because
  the date already held the night before's 70. `wake` gives every night its own
  date and is what a year of this habit's history was already filed under.
- **Naps are skipped** (`nap: true`), as are records that aren't `SCORED` yet. If
  two sleeps land on the same local day, the longer one wins.
- **Already-logged nights are left alone**, so a number you typed yourself is
  never overwritten. `{"force": true}` overrides. That rule guards the *value*,
  not the metadata: a night that already has a number still gets its `window` and
  `stats` backfilled if they're missing (reported as `enriched`), because
  "don't clobber what I typed" was never a reason to withhold readings WHOOP owns
  and nobody enters by hand. Those calls pass neither `value` nor `parts`.
- **Three nights every run**, so a morning the box was asleep for heals itself.
- **Logging a number ticks the habit off** — sleep data only exists if you wore
  the band.
- **Refresh tokens rotate.** WHOOP invalidates the old pair on every refresh, so
  the new one is persisted immediately. Nothing else may write that file — which
  is why Bushido asks this bridge for WHOOP data rather than holding its own copy of
  the credentials.
- **A refresh cannot widen a grant.** `whoopAccessToken` refreshes with the scope
  the stored token actually has, not with `WHOOP_SCOPES`. Asking for more than was
  authorized is how a working 11:00 job turns into `invalid_scope`, and widening
  the constant only affects the NEXT authorization.

## Training data for Bushido

Bushido (`~/bushido`, the training app) shows per-session heart rate and daily recovery,
and it gets both from here rather than from WHOOP directly. That is not tidiness:
the refresh token rotates and invalidates its predecessor, so exactly one process
may hold it. A second copy of the credentials would mean two grants for one member
and one of them dying silently — and for this sync, dying silently means a quiet
gap in a habit rather than an error anybody sees.

- `GET /api/whoop/training?days=N` → `{ok, fetchedAt, days, maxHeartRate, workouts[], recovery[]}`

`whoopTraining` in `bridge.mjs` fans out over four collections — workouts, cycles,
recoveries and the body measurement — and normalizes them: milliseconds become
minutes, kilojoules also come back as calories, and every record carries the LOCAL
date derived from WHOOP's own `timezone_offset`, because a 9pm session belongs to
that evening and a naive UTC date gets that wrong.

**Recovery is dated by the morning you woke up, via a two-hop join.** It's scored
against a physiological cycle rather than a calendar day, so a recovery is joined
`cycle_id` → cycle → the cycle's sleep → that sleep's local *wake* date. The last
hop is the one that matters and the one this got wrong at first: WHOOP opens a
cycle at sleep onset, so the cycle's own `start` is the evening *before* the day it
describes. A cycle beginning 22:36 on the 18th is the 19th's day.

Dating by `start` failed exactly the way the sleep sync's `night` mode does. On
2026-08-19 it filed this morning's recovery of 74 under the 18th, where it was
overwritten by the 18th's own 72 — so Bushido was handed yesterday's recovery, HRV and
resting HR as if they were this morning's, told there was "no reading for today",
and reasoned about a workout off the wrong day. The 17th's recovery of 62 was lost
the same way, and the missing days skewed the HRV/RHR baselines on top of it. Any
bedtime either side of midnight collapses two cycles onto one date.

Joining through the sleep also keeps this endpoint and the sleep habit on one
calendar, since the sync files a night by its wake date too. A cycle with no sleep
to join (still `PENDING_SCORE`, or clipped by the fetch window) falls back to its
start date, plus a day if that start is 18:00 or later — see the comment on
`cycleDate` for why the cutoff isn't noon.

Read-only, and it writes no habit. Bushido keeps its own disposable cache in
`data/whoop.json` and its own log; this endpoint is a window, not a second store.

**Scopes are checked before the request goes out.** `requireWhoopScopes` reads the
stored grant and fails with the fix — "authorized without read:workout — click
Connect WHOOP again to grant it" — because a 403 from inside a fetch surfaces two
processes away as "something went wrong". `GET /api/habits/whoop/status` reports
`scopes` and `missingScopes` for the same reason: **connected** and **can read
workouts** are different questions, and a grant older than a scope change answers
yes to the first and no to the second.

## API surface

- `GET /api/habits/whoop/status` → `{configured, connected, needsReauth, state, detail,
  lastError, lastErrorAt, redirectUri, valueField, connectedAt, scopes, missingScopes}`

  **`connected` is not a health check.** It only means a refresh token is on disk,
  and stays `true` after WHOOP rotates that token away. Switch on `state` instead:

  | `state` | Means |
  |---|---|
  | `ready` | As far as we know, working |
  | `needs-reauth` | A refresh was rejected outright. Reconnect is the only fix |
  | `missing-scopes` | Grant is live but predates a scope you now need |
  | `disconnected` | Never connected, or the token file is gone |
  | `unconfigured` | No `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` |

  `needs-reauth` is *latched*, not probed: the first call that gets a 400 writes
  the flag into the token file, and any successful exchange clears it by writing a
  fresh object. So the status can read `ready` for a grant that is already dead —
  nothing short of spending a rotation can tell the difference, which is why
  **Reconnect is offered unconditionally in the UI** rather than only when the
  server thinks something is wrong.
- `POST /api/habits/whoop/connect` → `{authUrl}` to open
- `GET /whoop-oauth/callback` — unauthenticated by necessity (a browser redirect
  can't carry the bearer); the unguessable `state` is the guard
- `POST /api/habits/sync-sleep` `{days?, force?}` → `{updated, enriched, skipped, errors, checked, habits}`;
  `days` is clamped to 1–90, while omission uses the routine 3-day default

  `checked` is the number of distinct dates the run resolved, which is worth
  watching: fewer than the nights fetched means two nights collapsed onto one
  date, and one of them is being dropped. See "Which date" above.

Any importer can write a habit metric the same way the sync does:

```sh
curl -X POST http://localhost:8787/api/habits/log \
  -H "authorization: Bearer $BRIDGE_SECRET" \
  -H 'content-type: application/json' \
  -d '{"id":"wear-garmin-to-sleep","date":"2026-08-09","value":84,
       "parts":{"deep":72,"rem":95,"light":240,"awake":18},
       "stats":{"efficiency":93.9,"disturbances":9},
       "window":{"start":"2026-08-08T22:36","end":"2026-08-09T06:47"},
       "complete":true}'
```

## When it breaks

Far less likely than the Garmin path, but not impossible:

- **401 / "reconnect WHOOP"** — the refresh token was invalidated (password
  change, revoked app, or something else overwrote `secrets/whoop-oauth.json`).
  Click Connect WHOOP again.
- **502s and generic 400s from the token endpoint are usually a WHOOP outage, not
  your grant.** Observed 2026-08-18: a Cloudflare `502 Bad gateway` in front of
  `api.prod.whoop.com`, then several minutes of `400 invalid_request` on refreshes,
  then full recovery with the *same* refresh token. Don't reconnect on the first
  failure — check whether it's still failing 20 minutes later.

  A 5xx is retried once automatically. That's deliberate: WHOOP rotates the refresh
  token on every exchange, so a gateway error is ambiguous about whether the origin
  already rotated. Retrying is still strictly better — if it didn't rotate the retry
  fixes it, and if it did we were broken either way.
- **`invalid_grant` is the one that means reconnect.** Only that error latches
  `needsReauth` and turns the UI red. A bare 400 (`invalid_request`) does not,
  because an outage produces those in bulk and telling you to re-authorize a
  perfectly good connection is worse than saying nothing.
- **Refreshes send the grant's full scope, not `scope=offline`.** WHOOP's docs show
  `offline` in their refresh example, and this was briefly changed to match — don't.
  RFC 6749 §6 treats the scope on a refresh as *the scope being requested*, so
  asking for `offline` alone can hand back an access token that can't read sleep.
  The full-grant form is observed to work against the live API. Separately,
  `whoopTokenExchange` takes a `grantedScope` and persists that rather than the
  response's echo, so a narrower echo can never shrink a five-scope grant to
  `offline` and make every Bushido workout call fail with "authorized without
  read:workout".
- **429** — rate limit (100/min, 10k/day). Nothing here comes close unless the
  Sync button is mashed.
- **No refresh token after connecting** — the app is missing the `offline` scope.
- **Nothing written, no error** — the night may be `PENDING_SCORE`, or it was a
  nap, or the number was already there (check `skipped`).

Worth knowing about the terms: WHOOP's API Terms of Use say not to "create
permanent copies of WHOOP Data," and reserve the right to limit or revoke access
at their discretion. Storing your own nightly history in `habits.json` is the
normal thing every personal dashboard does, but it isn't blessed in writing.
