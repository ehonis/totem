# Jobs — scheduled work

Everything Totem does on a timer: the defaults Totem ships with and anything you add.
Every job is also a **totem** and is managed in the Totems tab (`docs/totems.md`);
this file is the scheduler underneath. One store, one scheduler, one place that tells you whether a
job ran.

Nothing here is locked. Every job — including the ones that shipped — can be
renamed, re-described, rescheduled, repointed at a different skill, and deleted.
What each one *says* lives in an editable skill file; see `docs/skills.md`.

## Why this exists

Two failures, both of the same kind — the UI said one thing and the server did
another:

1. **User-authored jobs never ran at all.** The old Workflows tab saved them to
   `localStorage` under `totem_workflows`, and nothing on the bridge read that
   key. You could create a job, see it in the list, and it could not possibly
   fire. Its "When" field was free text (`Every weekday at 9am`) that no code
   ever parsed.
2. **Built-in jobs silently lost runs.** Each had its own copy of the same loop,
   firing only when a formatted `HH:MM` string equalled the current minute:

   ```js
   if (nowTime !== wf.time || lastWhoopSleepIngestDate === today) return
   ```

   Restart across that minute, or block the event loop through it, and the run was
   gone with nothing logged. Worse, "is this on" lived in both
   `data/studio-state.json` and an env-seeded default, so the WHOOP sync showed as
   enabled in the UI while resolving to `false` on the server — and sat dead.

The fix is structural: **one store, one scheduler, and a next-run timestamp you
can see.** An enabled job always has a computed `nextRunAt`; if it doesn't, that's
a bug the UI shows you rather than hides.

## Where things live

| Thing | Location |
|---|---|
| Schedule maths (pure, tested) | `jobs/schedule.mjs` |
| The prompts jobs run | `data/skills/` — see `docs/skills.md` |
| Job store, run history, notifications | `jobs/store.mjs` |
| Tests | `jobs/*.test.mjs` — `npm test` |
| Engine, runners, API routes | `bridge.mjs`, "The job engine" section |
| Jobs UI | `web/src/components/JobsView.tsx` |
| Home-board tile | `web/src/components/OverviewView.tsx`, the `jobs` tile |
| Job state | `data/jobs.json` (gitignored) |
| Run history | `data/job-runs.jsonl` (gitignored, trimmed past ~2MB) |
| Notifications | `data/notifications.json` (gitignored, 100-item ring) |

The agentless `todo-maintenance` default runs daily at 02:15. It reads the persisted
auto-archive and recycle-retention preferences from the task database. A purge always
creates an online SQLite backup in `TODO_BACKUP_DIR` first; with both preferences unset,
the run is a quiet `skipped` no-op.

## Schedule types

Picked in the UI, never typed as text:

| Type | Shape | Reads as |
|---|---|---|
| `daily` | `{type:'daily', time:'07:30'}` | Every day at 7:30 AM |
| `weekly` | `{type:'weekly', time:'09:00', days:[1,3,5]}` | Mon, Wed, Fri at 9:00 AM |
| `interval` | `{type:'interval', everyMinutes:90}` | Every 1h 30m |
| `window` | `{type:'window', from:'07:00', to:'11:30', everyMinutes:30, days:[1,2,3,4,5]}` | Weekdays, every 30 minutes, 7:00 AM–11:30 AM |

`days` is `0`–`6`, Sunday-first, in local time, and applies to `weekly` and
`window`. An empty day set widens to all seven rather than saving a schedule that
can never fire.

Times are wall-clock in `MORNING_BRIEFING_TZ`, so a 07:30 job stays at 07:30
through both DST switches (the absolute gap is 23h once a year and 25h once).
A time inside the spring-forward gap — 02:30 on the switch day — resolves
*forward* to 03:30 rather than backward to 01:30, which is what `zonedToUtc`'s
round-trip check is for. Intervals are measured from the last run, so a restart
doesn't reset the clock and a long outage schedules one next run rather than a
backlog.

### `window` — keep checking inside a stretch of the day

For work whose *answer* arrives at a time nobody controls. The WHOOP sleep sync is
the case that prompted it: the score shows up somewhere between waking and late
morning, so a single 11:00 run was either too early to find anything or hours
later than it needed to be. `{from:'07:00', to:'11:30', everyMinutes:30}` checks
ten times across the morning and has the number as soon as WHOOP does.

Three things make it different from `interval`, and each is deliberate:

- **It is a wall-clock grid anchored at `from`, not an offset from the last run.**
  07:00, 07:30, 08:00 … 11:30 are the same ten instants every morning. Ask at
  08:10 and the answer is 08:30, not 08:40. A restart, a late run, or a manual
  **Run now** cannot shift the grid — which is the point, because `interval`
  measuring from the last run means a job nudged once stays nudged.
- **It stops.** The last slot is the final one at or before `to`; a step that
  doesn't divide the span stops short rather than overshooting (`07:00`–`08:00`
  every 25 min is 07:00, 07:25, 07:50 — three runs). Then nothing until the next
  active day.
- **`to` before `from` reads as crossing midnight.** `22:00`–`02:00` is a
  four-hour overnight window, and it belongs to the day it *started* — a
  Friday-only overnight window fires its 00:00 and 01:00 slots on Saturday
  morning and then waits a week. `to === from` is a zero-length window, which is
  one run, i.e. the same as `daily`; it still fires rather than becoming a
  schedule that can never fire.

Each slot is resolved as a wall-clock time in the target zone rather than as
`from + k × step` in milliseconds, so a window spanning a DST switch keeps its
posted times. On spring-forward, 02:00 and 02:30 don't exist and resolve forward
onto 03:00/03:30 — slots that already exist — and the strictly-increasing
contract of `nextRunAfter` collapses the duplicates instead of firing twice.

`windowSlotCount(schedule)` returns how many runs a window really is. The UI shows
it live while you drag the time inputs, because "every 10 minutes from 7:00 to
11:30" being 28 runs is not obvious, and it matters if the job costs an AI call.
The step choices offered in the UI stop at 2 hours for the same reason a 6-hour
step inside a 4-hour window is a single run wearing a poll's clothes.

**On catch-up.** A window plus `catchUpMinutes: 120` does not backfill. The
engine sees one `nextRunAt`; if the box was off from 07:00 to 09:00 the 07:00 slot
runs once, late, and `claim()` then advances to the next slot after *now*. You get
one catch-up run, not four.

**On noise.** Most runs of a poll find nothing, and that is the normal case, not a
failure — the WHOOP runner reports `skipped` ("0 nights written, 5 already
logged") until the score appears. `skipped` does not increment
`consecutiveFailures` and does not notify, so a window with the default
`notify: 'errors'` is silent until something actually happens. `notify: 'always'`
on a window means one notification per slot, so the editor warns and names the
number when those two settings are combined.

## How a run happens

The tick runs every **30 seconds** and asks each enabled job whether its
`nextRunAt` has arrived — it does not compare clock strings.

- **due** — within the catch-up window (`catchUpMinutes`, default 120). Runs, and
  is tagged `late` if it's more than a minute behind. *This is the case the old
  code dropped.*
- **missed** — past the catch-up window. Deliberately abandoned, but recorded as
  `skipped` with the reason, so a box that slept for a week doesn't wake up and
  fire a week of backlogged agent prompts in silence.
- **pending** — not yet.

`claim()` is exclusive and advances `nextRunAt` *before* running, so a long agent
prompt can't have its slot re-fired by the next tick. Runs are started
concurrently: one slow job never blocks another.

**Preflight.** Before a run spends anything, the chosen AI is health-checked. A
logged-out or missing provider fails the run immediately with a typed error and
the fix attached (`errorKind: 'provider-auth'`, "Run: `cursor-agent login`")
instead of surfacing a raw CLI string nobody reads.

Every attempt appends to `data/job-runs.jsonl` and updates the job's `lastRun`
with status, duration, provider, and error. `consecutiveFailures` counts a streak
and resets on success.

## Watch triggers

A job can wake when something changes instead of on its schedule:
`trigger: { type: 'watch', source, everyMinutes }` (`jobs/triggers.mjs`, pure and
tested). Sources:

| `source` | Check | Fingerprint |
|---|---|---|
| `{ kind: 'git', repo, ref }` | `git ls-remote`. A local checkout path watches its `origin`, so it wakes on what was merged upstream, not local commits. Min 1 minute. | branch SHA |
| `{ kind: 'url', url, contains? }` | One GET, scripts/styles/tags stripped. Min 5 minutes. | with `contains`: whether the text is there; without: a hash of the visible text |

Every tick, each enabled watch job that is due and not running gets a background
check (`startDueWatches` in `bridge.mjs`, one at a time per job). The first check
only records a baseline in the job's `watch` field; a later change of fingerprint
runs the job once with `trigger: 'watch'` and an `event` describing the change
(for a local checkout, the new commits from `git log`), which agent totems get in
their prompt and the run record keeps. Three failed checks in a row notify once.

Hardening: a repo or ref starting with `-` is refused (git would read it as an
option such as `--upload-pack`), commands run without a shell, and git runs with
`GIT_TERMINAL_PROMPT=0` and `protocol.ext.allow=never`. Changing what a job
watches resets its baseline; `trigger: null` puts it back on its schedule.

## AI selection and health

Each job picks an AI, or `default` to follow the Providers tab. Two exceptions,
both flagged in the payload so the UI shows a note instead of a dead knob:

- `agentless` — the WHOOP sync is two HTTP calls; there is no AI to choose.
- `fixedProvider` — a runner whose internals take no provider override always
  uses the default. No shipped runner sets this today.

Both are properties of the **runner**, read from `JOB_RUNNER_DEFS` rather than from
a job's saved state — otherwise a stale `jobs.json` could claim the WHOOP sync takes
a model override. Detach the runner and the job becomes an ordinary prompt job that
can pick an AI like any other.

Health is a real check, not a file-existence test (which is what fooled us —
the auth file is present, the login behind it isn't):

| Provider | Check |
|---|---|
| cursor | `cursor-agent status` |
| codex | `codex login status` |
| claude | `claudeAiOauth.refreshTokenExpiresAt` in `~/.claude/.credentials.json` |
| opencode | `opencode auth list` |

Claude is read from the credentials file on purpose: `claude doctor` is an
interactive TUI, and `expiresAt` is a ~40-minute access token, so reading *that*
would report "logged out" for most of every hour. The refresh token is the one
that means anything.

Results are cached for 10 minutes. `?recheck=1` (the **Re-check** button, and
every preflight) bypasses the cache.

States: `ready`, `logged-out`, `missing`, `error`, `unknown`.

## Notifications

A failed run raises a notification; `notify` per job is `errors` (default),
`always`, or `never`. They're stored server-side, so they reach every device, and
surface in the app.

Set **`NOTIFY_WEBHOOK_URL`** in `.env` for off-box delivery. The body is the
message and the title rides in a `Title` header — ntfy and Pushover both accept
this shape:

```
NOTIFY_WEBHOOK_URL=https://ntfy.sh/your-private-topic
```

Delivery is best effort: a dead webhook is logged and never fails the run that
raised it.

## API

| Route | Does |
|---|---|
| `GET /api/jobs` | Jobs + AI health + recent runs + notifications. `?recheck=1` forces a health check |
| `POST /api/jobs` | Create. Requires a name and either a `skillId` or a `prompt` |
| `PATCH /api/jobs` | Update by `{id, ...}`. Every field, every job |
| `DELETE /api/jobs` | Delete by `{id}`. Works on the defaults too |
| `POST /api/jobs/restore` | Put back a default you deleted |
| `POST /api/jobs/run` | Run now. **Does not consume the next slot** |
| `GET /api/jobs/runs` | History, newest first. `?id=` per job, `?limit=` |
| `GET /api/providers/health` | Per-AI health. `?recheck=1` skips the cache |
| `GET /api/notifications` | Feed + unread count |
| `POST /api/notifications/read` | Mark read (`{ids}`, or all) |

`GET /api/studio` still returns its old `workflows` array, but it's now a
*projection* of the job store rather than separate state — the two-stores problem
is what caused the original bug.

Every mutation returns the full refreshed payload, so the UI can't end up
rendering a toggle the scheduler disagrees with.

## What a job runs

Three possibilities, in precedence order:

1. **`runner`** — names a code entrypoint in `JOB_RUNNERS`. Used where the work
   genuinely isn't a prompt (the WHOOP sync is two HTTP calls) or where a run needs
   bookkeeping a prompt can't be trusted with (a watermark that must not advance on
   failure). The name is *data*, so a job with a runner is still renameable and
   deletable like any other.
2. **`skillId`** — renders an editable skill from `data/skills/` and runs it. This
   is how the daily brief and both ingests work.
3. **`prompt`** — an inline prompt typed straight into the job.

A job with a runner *and* a skill runs the runner, which renders the skill. That's
the common shape: the instructions are yours to edit, the state handling isn't.

| Runner | Is |
|---|---|
| `morning-brief` | Runs the job's skill, files it on the morning channel |
| `journal-ingest` | Runs the job's skill, then advances the journal watermark — only on success |
| `plaud-meetings-ingest` | Runs the job's skill, stamps the processed-meetings ledger |
| `whoop-sleep` | Two HTTP calls and a file write. Agentless — no AI to pick |

A job pointing at a runner the bridge no longer defines is flagged `runnerMissing`
and fails with a message saying so, rather than silently falling through.

## The defaults

| id | Default | Runs |
|---|---|---|
| `daily-brief` | 07:30 | `morning-brief` + the `daily-brief` skill |
| `journal-ingest` | 07:00 | `journal-ingest` + the `journal-ingest` skill. Needs Plaud |
| `plaud-meetings-ingest` | 08:00 | `plaud-meetings-ingest` + the `plaud-action-items-ingest` skill. Needs Plaud |
| `whoop-sleep-ingest` | 11:00 | `whoop-sleep`. See `docs/whoop-sleep-ingest.md` |
| `self-update` ("Deploy Totem") | watch: this checkout's `main`, every 2 min | `self-update`: refuse a dirty tree or another branch, `pull --ff-only`, `npm install` if a `package*.json` changed, `npm run build`, then restart `TOTEM_SERVICE_NAME` once no chat or job is running. Off unless `TOTEM_SELF_UPDATE_ENABLED` |

These are **seeds, not built-ins**. `SEED_JOB_DEFS` is read on first boot and when
a genuinely new id ships; it is never re-applied to a job that already exists, so
an edit or a delete can't be overruled by a deploy. The `*_ENABLED` / `*_TIME` env
vars seed the first boot only.

Deleting one is allowed and is remembered in `deletedSeeds`, so it stays gone
across restarts. **Defaults you deleted** at the bottom of the Jobs tab offers them
back (`POST /api/jobs/restore`).

## Gotchas

- **Delete `data/jobs.json` and every job returns to its env-seeded default**,
  including being switched off, and every deletion you made is forgotten. Run
  history survives (separate file), and your *skills* are untouched — they live in
  `data/skills/`.
- **`Run now` deliberately doesn't move the schedule.** Testing a job at 09:00
  must not cancel its real 11:00 run.
- **The old `lastRunDate` day-guards are gone.** The store's persisted `nextRunAt`
  plus an exclusive `claim()` replaced them, which is also what makes `Run now`
  work rather than being swallowed as already-ran-today. The date is still written
  to those state files for continuity.
- **A watch job has no `nextRunAt`.** A job with a `trigger` is checked by the
  tick instead of scheduled (see "Watch triggers" below). `reschedule()`,
  `create()`, `update()` and `finish()` all leave its `nextRunAt` null; an enabled
  job with no next run is only a bug for schedule jobs.
- **A restart mid-run used to wedge the job.** `claim()` refuses a job whose
  `lastRun` is `running`, and nothing cleared that. `recoverInterrupted()` now runs
  at boot (only on the bridge that runs the scheduler) and records those runs as
  `error`/`interrupted`.
- **A job's prompt runs with Totem's full tool access**, unattended, on whatever
  schedule you set. It can create tasks, edit the brain, and touch repos. That now
  includes a skill you edited — preview it before it runs at 07:00.
- **Deleting a skill a job uses doesn't delete the job.** The job fails with
  `skill "x" no longer exists`, which is the honest outcome; repoint or restore it.
- **`kind` is provenance, not privilege.** `seeded` means "shipped with Totem" and
  nothing else — it grants the job no protection.
