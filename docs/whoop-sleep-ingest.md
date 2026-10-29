# WHOOP sleep sync

Fills the **Sleep** habit with last night's sleep performance, its stage
breakdown and the morning's recovery from WHOOP. Runs at 11:00 by default: late
enough that the band has synced, and that a night edited in the WHOOP app has been
re-scored.

**The grant is Bushido's** (since 2026-10-14). Bushido, the training app, holds the
owner's WHOOP login and OAuth client; Totem holds no WHOOP credentials and asks
Bushido for the nights through `whoop/remote.mjs`. WHOOP rotates the refresh token
on every refresh and voids the old one, so exactly one process may hold it. Never
give Totem a grant of its own again, or two refreshers rotate each other's tokens
away and one of them stops working without a sound.

What stays in Totem: the habit, the job, which date a night is filed under, and the
rule about which entries a sync may rewrite (`syncWhoopSleep` in `bridge.mjs`).

## Where to manage it

- **Settings → Connections → Wearables & fitness**: WHOOP's state as Bushido reports
  it, the granted scopes, and a link to Bushido to connect or reconnect
  (`web/src/components/WhoopConnection.tsx`).
- **Bushido** connects WHOOP (profile → Settings) and shows the nights, workouts and
  recovery. It reads WHOOP itself.

The sleep habit is hidden from Totem's Habits tab and Overview (`isSyncedSleep` in
`HabitsView.tsx`): nobody logs it by hand. The habit, this sync and every night's
history stay in the habit store, so agents and search still read them.

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

1. **In Bushido**: create a WHOOP app at [developer.whoop.com](https://developer.whoop.com)
   (an active WHOOP membership is needed), give Bushido its client ID and secret, and
   connect from profile → Settings → **Connect WHOOP**. Bushido's docs have the scopes
   and the redirect URI.
2. **In Totem**: set `BUSHIDO_URL` and `BUSHIDO_API_TOKEN` (Bushido's own
   `BUSHIDO_API_TOKEN`), the same two Strava uses. When `BUSHIDO_URL` sits behind an auth
   proxy a server cannot pass, set `BUSHIDO_API_URL` to an address the bridge can reach
   directly, such as `http://127.0.0.1:8099` when both run on one machine. Restart the
   bridge.
3. **Turn the job on** in Totems → *WHOOP sleep sync*. `WHOOP_SLEEP_INGEST_ENABLED=true`
   only seeds the default on first boot; after that `data/jobs.json` is authoritative,
   so the toggle in the UI is the one that decides. See `docs/jobs.md`.

**Sync** next to the graph runs it on demand, the quickest way to confirm setup.

Moving an existing install's grant from Totem to Bushido: stop Totem, move (do not
copy) `secrets/whoop-oauth.json` to Bushido's data directory as `whoop-oauth.json` (0600), give
Bushido the same client ID and secret, then start Totem with the settings in step 2.
Remove `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` and `WHOOP_REDIRECT_URI` from Totem's
`.env` and Settings → Integrations; nothing reads them now.

## How it runs

Scheduling is the job engine's (`docs/jobs.md`), not this feature's: it's an
agentless job, so it picks no AI, and a run the box slept through is caught up
within the job's grace window rather than lost.

`syncWhoopSleep` in `bridge.mjs` asks Bushido for the nights over the last
`WHOOP_SLEEP_DAYS` (3) days: `whoop.sleepNights({ start, end, value })`, which is
`POST <BUSHIDO_API_URL or BUSHIDO_URL>/api/whoop/owner` with
`{ method: 'sleepNights', args: [{ start, end, value }] }` and `BUSHIDO_API_TOKEN`.
Bushido pulls the sleep and recovery collections, drops naps and unscored nights,
shapes each night (below), picks the headline number named by `value`
(`WHOOP_SLEEP_VALUE`), and joins recovery to its sleep by `cycle_id` into
`stats.recovery`. Totem then picks each night's date, keeps one night per date, and
writes it through `logHabitRecord`: the same path the dashboard and the agent use,
so there's one writer and one set of guard rails. Explicit API syncs accept up to
90 days for a bounded backfill; scheduled runs keep the 3-day default.

Each night Bushido returns is `{ id, updatedAt, date, wakeDate, value, parts, stats,
window, totalMin }`, from these WHOOP fields:

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
  default, uses the local date of `start`. Bushido applies the record's
  `timezone_offset` when it computes `date` and `wakeDate`, because habit days are
  local days.

  **`night` is wrong if you go to bed after midnight.** A 00:13 bedtime and the
  *following* night's 22:36 bedtime share a local start date, so two nights collapse
  onto one — and because an already-logged night is left alone, the second one is
  silently dropped rather than overwriting the first. Observed 2026-08-19: five
  nights reduced to three dates (`checked: 3`), last night's 79 discarded because
  the date already held the night before's 70. `wake` gives every night its own
  date and is what a year of this habit's history was already filed under.
- **Naps are skipped** (`nap: true`) by Bushido, as are records that aren't `SCORED` yet. If
  two sleeps land on the same local day, the longer one wins.
- **Already-logged nights are left alone**, so a number you typed yourself is
  never overwritten. `{"force": true}` overrides. That rule guards the *value*,
  not the metadata: a night that already has a number still gets its `window` and
  `stats` backfilled if they're missing (reported as `enriched`), because
  "don't clobber what I typed" was never a reason to withhold readings WHOOP owns
  and nobody enters by hand. Those calls pass neither `value` nor `parts`.
- **A night the sync wrote is rewritten when WHOOP revises it** (`whoopOwnsEntry`):
  a different record won the day, the record's `updatedAt` moved, or recovery was
  scored after the sleep was.
- **Three nights every run**, so a morning the box was asleep for heals itself.
- **Logging a number ticks the habit off**: sleep data only exists if you wore
  the band.

## API surface

- `GET /api/habits/whoop/status` → Bushido's status plus `source: 'bushido'`,
  `bushidoUrl` (the address the owner opens) and `valueField`:
  `{configured, connected, needsReauth, state, detail, lastError, lastErrorAt,
  connectedAt, scopes, missingScopes, source, bushidoUrl, valueField}`

  **`connected` is not a health check.** It only means a refresh token is on disk in
  Bushido, and stays `true` after WHOOP rotates that token away. Switch on `state`:

  | `state` | Means |
  |---|---|
  | `ready` | As far as Bushido knows, working |
  | `needs-reauth` | A refresh was rejected outright. Reconnecting in Bushido is the only fix |
  | `missing-scopes` | Grant is live but predates a scope now needed |
  | `disconnected` | Not connected in Bushido |
  | `unconfigured` | Totem has no `BUSHIDO_URL`/`BUSHIDO_API_TOKEN` |
  | `unreachable` | Bushido did not answer, refused the token, or has no WHOOP app set up; `detail` says which |

  `needs-reauth` is latched by Bushido, not probed, so the status can read `ready`
  for a grant that is already dead. That is why the link to Bushido is shown
  unconditionally on the Connections row rather than only when something looks wrong.
- `POST /api/habits/sync-sleep` `{days?, force?}` → `{updated, revised, enriched, skipped, errors, checked, habits}`;
  `days` is clamped to 1–90, while omission uses the routine 3-day default. A failure
  from Bushido answers 502 (429 for a rate limit) with `{error, needsReauth?,
  missingScope?, rateLimited?}`.

  `checked` is the number of distinct dates the run resolved, which is worth
  watching: fewer than the nights fetched means two nights collapsed onto one
  date, and one of them is being dropped. See "Which date" above.

Totem no longer serves WHOOP to anyone: `GET /api/whoop/training`,
`POST /api/habits/whoop/connect` and `/whoop-oauth/callback` are gone. Bushido and
Krakatoa read WHOOP from Bushido.

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

- **`unreachable`**: Bushido is down, `BUSHIDO_API_TOKEN` does not match Bushido's, or
  Bushido has no WHOOP app configured (it answers 409). `detail` carries Bushido's
  words. When `BUSHIDO_URL` is behind Cloudflare Access, set `BUSHIDO_API_URL`.
- **`needs-reauth` / "reconnect WHOOP"**: the refresh token was invalidated (password
  change, revoked app, or a second holder rotated it). Reconnect in Bushido.
- **429**: WHOOP's rate limit (100/min, 10k/day), passed through from Bushido. Nothing
  here comes close unless the Sync button is mashed.
- **Nothing written, no error**: the night may be `PENDING_SCORE`, or it was a nap,
  or the number was already there (check `skipped`).

Worth knowing about the terms: WHOOP's API Terms of Use say not to "create
permanent copies of WHOOP Data," and reserve the right to limit or revoke access
at their discretion. Storing your own nightly history in `habits.json` is the
normal thing every personal dashboard does, but it isn't blessed in writing.

