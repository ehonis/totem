# Source health

One place that answers "is this data source actually working?". Every connector writes a row
to one run log for each operation on the thing it reads; health is folded from that log and
shown in Settings → Connections › Data sources (and Settings → Connections in the iPhone app).
A goal metric whose source is failing says so on its card, and the owner is told once per outage.

## In Settings

The list leads with what is wrong and folds the rest (`sortSources` in `web/src/sources/health.ts`,
ported to the app's `lib/sources/health.ts`):

- **Problems** (failing, then erroring) get a full row: the state, how long, the error, and a tag
  for each goal the source feeds. Opening one shows its newest runs.
- **Working** sources fold into one "N working" row naming them; it opens onto compact rows.
- **Not set up or not read yet** fold the same way.

The web leaves MCP servers and the gateway out of this list (`isMcpSource`): its MCP servers
section shows each server's state from the same status check, with the server's newest runs
under "Recent checks" when it is opened (and "failing since" on a server that keeps failing). The
app has no MCP section, so it keeps them. The page's attention line ("Needs you",
`attentionItems` in `web/src/connections/state.ts`) counts failing and erroring sources, a source
log that could not be read or is off, servers that need a sign-in or are not working (built-in tool
sets included), and Accounts rows that need the owner, and jumps to each section. It says
everything works only once the gateway and the source log have both answered.

Nothing to switch on: a source appears the first time it is read. What writes nothing until it
is set up: Strava and WHOOP without `BUSHIDO_URL`/`BUSHIDO_API_TOKEN`, Gmail, Drive and Calendar
with no account connected, the task sheet without `TASK_SHEET_*`, and MCP servers not in the
manifest. What runs without setup and so can appear (and fail) on its own: the feed scan (public
feeds). (The GitHub task sync, `github-tasks`, was removed; the bridge forgets its row at every
boot, `sourceRuns.forget`, so it never shows in Settings → Connections.)

## The run log

`sources/store.mjs`, a SQLite file at `data/source-runs.db` (`SOURCE_RUNS_DB` moves it), WAL with
`synchronous = NORMAL`.

- `source_runs`: one row per run, with `source`, `started_at`, `finished_at`, `ok`, `error`
  and `rows` (how many items came back, where that means something).
- `source_health`: one row per source, the health folded from its runs (`sources/health.mjs`).
  Reading health is one row per source, and pruning old runs never forgets when a source last
  worked. A working run that changes nothing but the time does not rewrite this row within a
  minute, so "last OK" on a busy source is at most a minute behind.

Retention: runs older than 30 days go, and each source keeps at most its newest 500. A source
that has not run at all in 30 days (an account removed, a feed switched off) is forgotten.
Pruning runs on open and then at most hourly.

**The run log never stops the bridge.** `openSourceRuns` opens it; a file SQLite says is not a
database is moved aside (`source-runs.db.corrupt-<time>`) and a fresh one made, and anything
else (a read-only directory, a path through a file) is logged and source health is off for that
process: connectors run untracked, `GET /api/sources` answers `disabled` with the reason, and
the panel says so. Every write and read after opening is caught and logged too, and `track`
returns or throws exactly what the connector did, even for an error object whose `message`
throws.

## Scrubbing

Errors are scrubbed before they are written (`sources/scrub.mjs`). Only the first 8 KB of a
message is read, cut back to the last whitespace so no token is left half in; then, in layers:

1. Percent-escapes are decoded, so `access%5Ftoken%3D…` is seen as `access_token=…`.
2. URLs lose any `user:password@` and the value of any secret-named query or fragment
   param (`?access_token=…&page=2` keeps `page=2`). An MCP server's error keeps only each URL's
   origin, since its path is often the credential (`/s/<secret>/mcp`).
3. PEM blocks (to the end if the message was cut off), `Authorization`/`Proxy-Authorization`
   values, scheme included, in a header line, JSON or a JS object, and `Cookie`/`Set-Cookie`
   lines.
4. Any value whose name contains `token`, `key`, `secret`, `password`, `code`, `sig`, `auth`,
   `credential`, `session`, `cookie`, `assertion` or `jwt`, or is `pass` or ends in `_pass`:
   after `=` or `:`, with or without spaces and quotes (escaped JSON included); a quoted value
   whole, spaces and all (`{"password":"two words"}`); and `<access_token>…</access_token>`.
   So `GITHUB_PERSONAL_ACCESS_TOKEN=`, `PRIVATE-TOKEN:`, `"refreshToken":`, `client_secret =`,
   `?pass=`. A few names are left alone (`error_code`, `grant_type`, `token_type`, …), as is a
   value of up to four digits (`status code: 429`).
5. `Bearer`/`Basic` values in prose, tokens with a provider's prefix (`ghp_`, `github_pat_`,
   `glpat-`, `sk-`, `xoxb-`, `ya29.`, `AIza`, `1//0`, `eyJ`, AWS `AKIA`/`ASIA`, …), Slack and
   Discord webhook paths and Telegram bot tokens.
6. The fallback: any run of 24 or more characters that mixes letters and digits, which is what
   an unnamed token looks like (a Strava hex token in an unnamed field). A UUID, a commit SHA or
   a Drive file id in an error goes too; that is the price of catching tokens nothing names.
   They are not exempted: a Strava token is 40 hex characters, exactly a SHA's shape, and some
   services issue UUIDs as API keys.

Not caught: a secret with no name and no prefix that contains `/` (an AWS secret access key in
prose). Treating `/` as part of a token would redact ordinary URL paths.

The scrubber runs on the bridge's main thread on text a remote server chose, so it must stay
linear: no pattern may backtrack over a run (a name is captured atomically and tested after
the match, a URL scheme and a quoted value are bounded). `sources/scrub.test.mjs` times 100 KB
inputs and every pattern's worst case at the cap. An earlier `[\w-]*(?:token|…)[\w-]*` took
25 s on 100 KB of one letter.

Messages are cut to 500 characters. The notification never carries the error at all (below).

## Source ids

`<kind>` or `<kind>:<instance>`. `describeSourceId` in `sources/health.mjs` names them.

| Id | Written by | One run is |
|---|---|---|
| `strava` | `strava/remote.mjs` | one call that reaches Strava through Bushido (sync, activities, gear, …) |
| `whoop` | `whoop/remote.mjs` | one call that reaches WHOOP through Bushido (the sleep nights) |
| `calendar:<account>` | `fetchCalendar` in `bridge.mjs` | one account's event read |
| `gmail:<account>` | `gmail/index.mjs` | one operation (a search with its message reads, a thread read, a trash), token refresh included |
| `drive:<account>` | `drive/index.mjs` | one operation (a file read with its export or download, a trash), token refresh included |
| `task-sheet` | `todos/connectors/task-sheet-feed.mjs` | one read of the shared task sheet (cache misses only); not set up until `TASK_SHEET_*` and a Drive account are. `sheet-tasks`, the retired two-way sync's id, is marked not set up at boot and pruned with age |
| `feed:<id>` | `runFeedScan` in `bridge.mjs` | one feed read in a feed scan |
| `mcp:<server>` | `sources/gateway.mjs`, from the bridge's gateway status check | one server in a check (Connections open) |
| `mcp-gateway` | the same | the status check itself |

Not tracked: Bushido's answers from its own copy of the activity history (`readCache`,
`cachedList`, `cachedMileage`). They say Bushido is up, not that the Strava grant works, and the
cache reads behind a page of goals would otherwise reset the streak of a sync that has failed
all day. Goal metrics read that cache, so goal reads are not runs; the sync that fills it is.
Calendar's single-event read, update and create (the dashboard's event editor) are not tracked
either: the event list is read far more often and says the same thing.

Bushido's `status` (polled by the Connections rows) is noted, not run: a grant it reports as
`needs-reauth` (or any state but `ready`) is a failed run, `disconnected`/`unconfigured` marks the
source not set up, and `ready` records nothing, because only a call that reaches the provider
proves the grant works.

## Wiring a connector

A connector takes `runs` (the store) and wraps each operation on what it reads:

```js
import { tracker } from '../sources/track.mjs'
const track = tracker(runs)  // a pass-through when built without a run log
return track('mysource', () => fetchTheThing(), { rows: (r) => r.items.length })
```

A run is an operation, not a request. A tracked call made inside another tracked call for the
same source joins it (AsyncLocalStorage carries the operation through awaits and `mapLimit`), so
wrap the operation and the requests it makes are one run. Gmail and Drive do this with
`accountOperations(runs, kind)`.

Whether a thrown error counts against the source is `isFault`, by default `isSourceFault`: no
status (unreachable), 401, 403, 407, 408, 409, 429 and 5xx do; 400, 404 and 422 mean the source
answered and the request was wrong (a file that is not there, a bad query an agent wrote), and
are recorded as a working run. `isFault` may also return `null`: the failure was not the
source's at all, and nothing is recorded. The task syncs use that: `remoteClient(client)` tags
every error their remote client throws and `remoteFault` counts only those, so a SQLite error in
the local half of a reconcile shows in the sync's own health (the connector's `getHealth`) and
not as GitHub or the sheet failing. The two can therefore differ: the run log says whether the
source answers, the connector's health whether the sync as a whole worked.

`runs.record({ source, ok, error, rows })` writes a result that arrives another way (a feed
scan's per-feed state), and `runs.markUnconfigured(source, reason)` says the source answered that
it is not set up. Keep source ids stable, and only track a source that is configured.

## Health

A fold over a source's runs, in the order they finished:

- `ok`: the newest run worked.
- `degraded` ("Erroring"): the newest run failed, but not yet three in a row over ten minutes.
- `failing`: three or more failures in a row, the first at least ten minutes before the newest.
  `failingSince` is the start of the first.
- `unconfigured` ("Not set up"): the source answered that it is not set up (an MCP server waiting
  for its sign-in, Strava disconnected in Bushido). Ends any streak.
- `unknown` ("Not read"): a goal names the source and nothing has read it yet.

Failing needs a count and a duration, so a burst (three Connections refreshes a few seconds
apart, a rate limit across one fan-out) is never an outage.

Flapping (fail, fail, ok, repeated) stays `degraded` and is never announced. A failure ratio over
the last N runs would catch it, but it would also keep a source that has just recovered marked
failing for several runs, and the notice is for outages. A flapping source shows as Erroring in
Settings with its newest error.

Each source also carries `lastOkAt`, `lastRunAt`, `lastErrorAt`, `failures` (in a row), the
newest `error` and the newest working run's `rows`.

## Telling the owner

When a source is failing and the owner has not been told about this outage, the bridge queues
one notification (`sources/notice.mjs`): category `job.failed` ("Something broke"), title
"<source> is failing", a body with how many failures over how long and the goals it feeds, and a
link to `/settings/connections`. **The body never carries the error**; a push lands on a lock
screen, and the error is in Settings.

- **Once per outage.** The dedupe key is `source:<id>:failing:<failingSince>`, so each outage
  is its own notice and a later one is never held back as a repeat of an earlier one.
- **Marked only once queued.** `notifiedAt` is written after `notifyStore.enqueue` resolves. If
  it throws (the queue is down, or the run happened during boot before the queue existed), the
  next failure tries again.
- **Cool-down.** An outage that starts within six hours of the last notice is usually the same
  problem; it is announced when six hours have passed, if it is still failing then. This is
  checked on every failing run, not just the one that crossed the threshold.
- **Still true at delivery.** The notice carries a revalidation fact key, and the bridge adds one
  fact per still-failing source to what the notification revalidator reads at delivery
  (`failingFacts`, added in the revalidator's collector, not in `collectNotifyFacts`, which the
  digest plans from). A notice held by quiet hours for a source that has since recovered is
  dropped.
- A restart mid-outage does not announce it again: `notifiedAt` is stored with the health.

## Goals

`GOAL_SOURCE_IDS` in `goals/sources.mjs` maps a metric's source kind to the source id it reads
(`strava_distance` and `strava_gear_odometer` → `strava`). `sourcedGoals()` on the goal service
lists open goals in a window that covers today whose metrics (or their steps' metrics) read a
connector, without resolving any metric. The API names those goals on each source (`goals`), lists a
goal's source that has never run as `unknown`, and hands the mapping to the client, which marks a
metric whose source is `failing` (`web/src/sources/MetricSourceWarning.tsx`, the app's
`features/goals/MetricSourceWarning.tsx`). A goal list that cannot be read leaves the sources
ungrouped rather than failing the page.

## API

Behind the `/api/*` auth gate (`sources/http.mjs`):

- `GET /api/sources`: `{ generatedAt, disabled, sources: [health + label, kind, instance, via,
  goals], goals: [{ id, title, periodType, sources, failing }], metricSources }`. `disabled` is
  null, or why the run log could not be opened.
- `GET /api/sources/runs?source=<id>&limit=<n>`: that source's newest runs, newest first.
