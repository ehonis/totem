# Dev tab

One place to see the CI and review state of the owner's GitHub repos, pause AI code review
per repo, start a review of one PR, and receive production alerts from outside. GitHub stays
the source of truth: Totem reads its state, sets one repo variable and dispatches the review
workflow, nothing else.

Code: `dev/` (`github.mjs` the `gh` calls, `service.mjs` config and cache, `issues.mjs` the
Issues list, `watcher.mjs` the background check, `alerts.mjs` the alert record, `runs.mjs`
the orchestrated runs, `ingest.mjs` the public alert and run routes, `http.mjs` the
`/api/dev` routes), `web/src/components/DevView.tsx` and `web/src/dev/` (the Runs and Issues
cards).

## What it shows

### Runs

The first card: every multi-agent build run by the `orchestrate` skill whose ORCH thread
pushes its status to Totem (see [Runs from orchestrators](#runs-from-orchestrators) for the
route). The ORCH threads run on another machine and keep their state in a playbook there,
so Totem only knows what they push. Nothing shows until a run has reported.

- **One block per active run**, newest-updated first: the run's title (a link to the ORCH
  thread in T3 Code when the body names `environmentId` and `orchThreadId`, built as
  `T3_CODE_URL/<environmentId>/<orchThreadId>`, the route T3 Code's web app opens a thread
  at), the repo, how many threads have merged and how many are blocked, and when it last
  reported. Over two hours since then reads "Stale, updated 3h ago" in amber: the ORCH has
  stopped ticking, or its pushes are failing.
- **Waiting on you**: the run's `waitingOnEthan` lines, in an amber box. **Incidents** in red.
- **Threads**: a table of each SUB thread's issue and title, stage (a review shows its round),
  PR link with a dot for its CI state, Code and UX scores, and skipped council seats. At phone
  width each thread is two lines: its name, then the rest.
- **Archive** moves a run to **Finished**, a folded list under the active runs with each run's
  handoff link and a Restore button (`PUT /api/dev/runs/<slug>` with `{ "archived": bool }`).
  A run that reports its finish line is archived on its own, once; after that only the owner's
  switch moves it, so restoring a finished run sticks, and so does archiving a live one.
- The card asks again every minute while the tab is on screen, and on the page's Refresh
  (`GET /api/dev/runs`, behind the normal sign-in). The last answer is kept in localStorage
  for paint.

### PRs per day

The second card, shown whether or not any repo is watched: every pull request the server's
`gh` login authored and merged, in any repo it can see, as one stacked column per day split by
repo. 14, 30 or 90 days. The line above it gives the total, the daily average, how many days
had a merge and the busiest day.

- **Source**: GitHub search, `is:pr is:merged author:@me merged:<range>`
  (`GET /api/dev/shipped?days=14|30|90`). Search answers at most 1,000 results per query, so
  the range is asked for in two-week slices, each paged 100 at a time; a 90-day range is a
  handful of calls. Results are cached for ten minutes per range (search is rate-limited);
  the card's Refresh asks again. The server fetches a day more than asked, and the browser
  buckets by its own timezone.
- **Colours**: the eight repos with the most PRs in the range get one colour each, in a fixed
  order checked for colour-blind separation on the card surface; every other repo is grey
  ("Other"). Colour follows rank, so it can change with the range.
- **Hiding a repo**: click its chip under the chart. The list is kept as `shippedHidden` in
  the config file (`PUT /api/dev/shipped/hidden` with `{ "repo", "hidden" }`). Use it for a
  public mirror whose PRs repeat a private repo's.
- **Groups**: Edit groups names sets of repos (Work, Side projects) and puts each repo in
  at most one. Once a group exists, a switch picks how the chart splits: **Repos** (one colour
  per repo, as above), **Groups** (one colour per group; an ungrouped repo keeps its own) or
  **Both** (one segment per repo, shaded in its group's colour). In the group views the chips
  sit under their group's name, the eight busiest groups or loose repos get a colour, and a
  day's list prefixes each PR with its group. Groups are kept as `shippedGroups` in the config
  file (`PUT /api/dev/shipped/groups` with `{ "groups": [{ "name", "repos" }] }`, replacing
  the list); the switch is per browser.
- **A day's PRs**: click a column to list that day's PRs (title, repo, number, time merged).
  Under the title goes the PR's one-liner when its body has one: orchestrated PRs open with
  one plain sentence ("Adds X so Y can Z"). It is the body's first non-empty line, with
  links and emphasis reduced to text, and nothing when that line is a heading, list item,
  quote, table, comment, picture or code fence (an older body's `## Summary`), or under eight
  characters; cut at 240. Search results already carry each PR's `body`, so this costs no
  extra call and keeps the ten-minute cache; only the one-liner is kept, not the body.

### Issues

The third card: GitHub issues (never pull requests) in the watched repos plus every issue
assigned to the server's `gh` login, in any repo it can see, in one list, newest-updated first.
GitHub issues left the task list (the GitHub task connector was removed), so this is where they
are seen now. Shown whether or not any repo is watched, as long as `gh` is signed in.

- **Source**: `GET /api/dev/issues?state=open|closed|all&scope=mine|watched|all[&repo=owner/name][&refresh=1]`.
  Read through `gh api graphql`, which lists issues only: each watched repo's
  `repository.issues(states, orderBy: UPDATED_AT DESC)` and, for the assigned ones, a
  `search(type: ISSUE)` for `is:issue assignee:@me archived:false sort:updated-desc`
  (`archived:false` on purpose: an archived repo is read-only, so its issues are not
  something to act on). Up to 100 labels per issue. (REST's
  issue listings mix PRs in, so a repo with many PRs once spent every page on them and showed
  no issues.) Each source is paged 100 at a time by cursor, up to 1,000 issues; a source cut
  there is listed in `capped` with how many it has, and the card names it ("Showing the 1,000
  most recently updated closed issues in owner/repo (of 1,240)."). An issue found by both (a
  watched repo's issue assigned to the login) is listed once. `mine` reads only the assigned
  search, `watched` only the repos, `all` both (the default); `repo` reads and keeps one
  repo, matched without case. The card does not send `repo` (it filters what it has, so
  switching repos asks nothing); it is there for other callers.
- **Answer**: `{ enabled, state, scope, repo, login, repos, fetchedAt, issues, capped, errors, warnings, error? }`,
  each issue `{ repo, number, title, state, stateReason, url, labels: [{ name, color }],
  assignees: [login], author, comments, createdAt, updatedAt, milestone }`. `fetchedAt` is the
  oldest read the list is built from. `errors` is `[{ source, error, stale }]`: `stale` means
  the source's last good list is in the answer; otherwise it has never been read and nothing
  of it is shown. `error` joins them in one line. `warnings` is `[{ source, warning }]` for a
  source read in part: GitHub answered with data and `errors` both (an issue in an org that
  blocks the token, by SAML or an OAuth app policy), `gh` exited 1, and the issues it could
  read are kept (`ghCapture` puts stdout on its error for this). A source counts as `capped`
  when pages were left at 1,000 or its total is above what came back (search stops at 1,000
  results with no next page). With no watched repos and `gh` missing or
  signed out it answers `enabled: false` with a `reason` and an empty list, and reads nothing;
  any other `gh` failure is an error to show, not "sign in".
- **Caching**: each source (one repo, or the assigned search) is cached for five minutes per
  state, so switching Mine/All or the repo filter re-reads nothing fresh. Refresh re-reads a
  source only if its last read is a minute old. A failed read is retried after a minute. Not
  in `ETAG_PATHS`: the phone would keep it on disk, and nothing on the app reads it.
- **The card**: Open / Closed / All and Mine / Watched / All are asked of the bridge; only an
  answer for the view on screen is drawn, so a view with no saved answer shows the spinner
  (or its own error), never the last view's rows. The repo and label menus and the search box
  filter what is loaded; a picked repo or label stays in its menu, at 0, when the new view has
  none. Search matches every word against the title, repo, labels, author, assignees and
  milestone; `#12` is issue 12; `/` focuses it. Each row shows open or closed (completed, or
  not planned), a repo mark (the repo's name, with its owner only when two repos share one),
  `#number`, the title, up to three labels and a `+N` for the rest, assignee initials (the
  login's own ringed), the comment count and when it was last updated. Labels are drawn in
  their own colours, tinted over the card and with text moved toward white or black until it
  reads at 4.5:1, re-read when the palette changes; a click filters by that label. The title
  is the link to the issue on GitHub. The list is one tab stop: the active row, named
  ("owner/repo #12: Title (open)") and described by the rest of what it shows (labels,
  assignees, comments, when it was updated); ↑/↓, Home and End move between rows, and Tab
  goes on to that row's label buttons. Enter opens the issue, and right-click, long press,
  the menu key or Shift+F10 on the row offer Chat about this (`dev.issue`), which names the issue
  and tells the agent to read the body with `gh issue view`. Fifty rows at a time, then Show
  more. The page's Refresh re-reads it too, and watching or unwatching a repo asks it again.
  The last state and scope, and each one's last answer up to 500 issues, are kept in
  localStorage (`web/src/devCache.ts`) for paint.

### Repo cards

Per configured repo, one card:

- **CI on the default branch**: the newest run of each workflow, with its result, age and link.
- **Open pull requests** (up to 20): checks on the head commit summed up as passing, failing,
  pending or none; the Claude review's state (queued, running, passed, failed or none) with a
  link to its run; whether Codex reviewed (any comment or review by a login starting
  `chatgpt-codex-connector`). The Claude state comes from the newest run of `review.yml` whose
  run name is exactly `Review PR #<n>` (the workflow sets that `run-name` for both triggers);
  older runs without it fall back to a check run on the head commit named `Review` or
  containing `claude`.
- **Review button** on each PR: starts `review.yml` for that PR now, whatever the AI review
  switch says (`POST /api/dev/repos/:owner/:repo/pulls/:n/review`, which runs
  `gh api -X POST repos/<repo>/actions/workflows/review.yml/dispatches -f ref=<default branch>
  -f inputs[pr]=<n>`). The button says "Queued" for a moment; the run shows on the next
  refresh. Only for watched repos that have the workflow.
- **Runners**: the repo's self-hosted runners, idle, busy or offline. Listing them needs admin
  on the repo; without it the card says so and shows the rest.
- **AI review switch**: on means the repo variable `AI_REVIEW` is unset; off sets it to `off`.
  The repo's own review workflows must check it, for example
  `if: vars.AI_REVIEW != 'off'` on the job. The switch and the Review buttons only appear once
  the repo has the review workflow.
- **Setup status**: whether the repo has the review workflow (a workflow whose path ends in
  `/review.yml`), at least one self-hosted runner, and the `CLIPROXY_API_KEY` Actions secret
  (names only; an unreadable secret list counts as unknown, not missing). If anything is
  missing the card says "Not set up for AI review", lists it, and offers
  `/review-ci-setup owner/repo` to copy and run in a T3 thread on the dev box (the
  `review-ci-setup` skill does the setup; Totem does not).
- **Unwatch**, in the card head, after a confirm.

Above the cards, the health checks; below them, the last alerts. GitHub results are cached in
memory for 60 seconds; Refresh bypasses the cache.
The browser keeps the last status and each range's PRs in localStorage (`web/src/devCache.ts`),
so opening the tab paints them at once and swaps in the fresh answer when it arrives.

## Watching repos

"All repositories", at the bottom of the tab, has a Watch / Watching toggle on every repo.
It calls `PUT /api/dev/repos` with `{ "repo": "owner/name", "watch": true | false }`, which
rewrites `repos` in the config file (creating it if needed, keeping every other key, written
atomically) and clears the 60-second cache. A repo is only added if `gh api repos/<repo>`
succeeds, so a typo or a repo the login cannot see is refused with a 400.

## Configuration

`data/dev.json` (or the path in `DEV_CONFIG_FILE`), re-read on every request, so no restart is
needed. The tab maintains `repos`; health checks and the poll interval are edited by hand. See
`examples/dev.example.json`:

```json
{
  "repos": ["owner/repo"],
  "health": [{ "name": "LLM proxy", "url": "http://host:port/v1/models", "expect": [200, 401] }],
  "pollMinutes": 5
}
```

- `repos`: `owner/name` strings, normally set from the tab. No file, or no repos, turns the feature off: `/api/dev`
  answers `{ enabled: false }`, the tab explains this setup, and nothing calls GitHub.
- `health`: optional. Each URL gets a GET with a 5-second timeout; it is healthy when the status
  is in `expect` (default `[200]`). Redirects are not followed, so list a 3xx if one is fine.
- `pollMinutes`: how often the watcher looks, default 5.
- `shippedHidden`: repos left out of PRs per day, normally set by clicking a chip.
- `shippedGroups`: `[{ "name": "Work", "repos": ["owner/name"] }]`, normally set from Edit groups.

GitHub is read with the `gh` CLI as the user Totem runs as (`gh auth login` there). Its token
needs repo and workflow scope to read runs and set variables, and admin on a repo to list its
runners. A missing or signed-out `gh` shows as an error on each card.

## The watcher

Every `pollMinutes`, for each repo, the watcher reads CI on the default branch and the runners.
It notifies when the newest finished run of a workflow failed and is a run it has not seen, and
when a runner that was online is offline. Last-seen run ids and runner states live in
`data/dev-alerts.json`, so a restart does not repeat an alert; the first look at a repo only
records. It does not run on a bridge started with `BRIDGE_NO_SCHEDULER=1`.

## Runs from orchestrators

`POST /api/dev/runs/<slug>`, where `<slug>` is 1 to 64 of `a-z`, `0-9` and `-` and names
the run (one slug per ORCH; the playbook's project name is a good one). Its token is
`DEV_RUNS_TOKEN` in `.env`, or the alert route's `ALERT_INGEST_TOKEN` when that is unset;
with neither the route is a 404. Send it as `Authorization: Bearer <token>` or
`X-Alert-Token: <token>`. A missing or wrong token is a 401. Only `POST` is matched ahead of the sign-in gate; `GET /api/dev/runs` and
`PUT /api/dev/runs/<slug>` are the dashboard's and need the owner's sign-in, never this token.

The body is JSON, at most 64 KB (413 above that). Each push replaces what Totem holds for the
slug:

```json
{
  "run": "totem-tasks",
  "title": "Totem tasks ORCH",
  "repo": "owner/name",
  "orchThreadId": "<T3 thread id>",
  "environmentId": "<T3 environment id>",
  "updatedAt": "2026-11-10T20:30:00Z",
  "waitingOnEthan": ["Merge PR #212"],
  "incidents": ["SUB #14 made a live API call; reverted"],
  "threads": [
    { "issue": "#12", "title": "Kanban board", "stage": "review", "round": 2,
      "lastReportAt": "2026-11-10T20:28:00Z", "pr": 212, "ci": "passing",
      "codeScore": 9, "uxScore": 8.5, "skippedSeats": ["Fable"] }
  ],
  "finished": false,
  "handoffUrl": null
}
```

- `title` is required; everything else is optional. Unknown fields are ignored.
- `stage` is one of `building`, `pr`, `review`, `fixing`, `ready`, `merged`, `blocked`. A
  review's round can be its own `round` field or part of the stage (`"review 2"`,
  `"review r2"`, `"review:2"`).
- `pr` is a number (`212` or `"#212"`, linked through `repo`) or a pull request URL. `ci` is
  `passing`, `failing`, `pending` or `none` (`success`, `failure`, `running` and `queued` are
  read as those). Scores are 0 to 10 (`"9/10"` reads as 9).
- `waitingOnEthan`, `incidents` and `skippedSeats` are arrays of strings, at most 50 each
  (20 seats); `threads` at most 100.
- `"finished": true` reports the finish line and archives the run once. A `handoffUrl` counts
  as a finish too, since the handoff is written there. Only a web link is kept and linked; a
  file path (a `HANDOFF.md` on the machine the ORCH runs on) still finishes the run.
- `updatedAt` defaults to when Totem received the push, and a time ahead of Totem's clock is
  read as now.
- A body that breaks any of these is a 400 naming the field (`threads[2].stage must be one of
  …`), and nothing is stored.

Kept in `data/dev-runs.json` (`DEV_RUNS_FILE`), written to a temporary file and renamed into
place, so a crash leaves the last good file; pushes are applied one at a time. The newest 100
runs are kept. Nothing about runs goes in git.

```sh
curl -X POST https://totem.example.com/api/dev/runs/totem-tasks \
  -H "Authorization: Bearer $DEV_RUNS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"Totem tasks ORCH","waitingOnEthan":["Merge PR #212"],"threads":[]}'
```

The answer is `{ ok, slug, archived, notified }`, where `notified` lists what was pushed
(`waiting`, `incident`).

### The run alert

The owner is pushed (category `dev.run`, "Orchestrated runs", which can be muted on its own in
Settings → Notifications and waits out quiet hours) when a run's `waitingOnEthan` goes from
empty to non-empty ("Totem tasks ORCH: waiting on you", the lines as the body), and when it
reports an incident it did not report in its last push. The same item (the run's waiting
lines as a whole, or one incident's text) is not pushed again within the hour, even if it
drops off and comes back; a push that did not reach a device is tried again on the next
change. The push opens the Dev tab.

## Alerts from outside

`POST /api/alerts/<source>`, where `<source>` is 1 to 32 of `a-z`, `0-9` and `-` (for example
`posthog`). Set `ALERT_INGEST_TOKEN` in `.env` to turn it on; without it the route is a 404.
The sender passes the token as `Authorization: Bearer <token>` or `X-Alert-Token: <token>`.

The body is JSON, at most 64 KB:

- Any sender: `{ "title": "...", "body": "...", "url": "https://...", "key": "..." }`. `key`
  names the thing alerting; it defaults to the title.
- PostHog webhook destinations are understood as sent: the event name (or, for `$exception`,
  the exception type and message) becomes the title and body, and the event's link the URL.
- Anything else becomes "Alert from <source>" with the start of the JSON as the body.

```sh
curl -X POST https://totem.example.com/api/alerts/cron \
  -H "Authorization: Bearer $ALERT_INGEST_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"Nightly backup missed","key":"backup"}'
```

For PostHog: Data pipeline → Destinations → Webhook, URL
`https://totem.example.com/api/alerts/posthog`, method POST, and a header
`Authorization: Bearer <token>`.

Every alert is kept (the last 200) and shown in the tab. It is pushed to the owner's devices
(category `alert.external`, "External alerts", which overrides quiet hours) unless the same
source and key was pushed within the last hour.

### Behind an auth proxy

If the dashboard sits behind Cloudflare Access or another auth proxy, senders cannot pass it.
Add a bypass for exactly `/api/alerts/*` (in Cloudflare Access, a separate application on that
path with a Bypass policy). The handler's own token check is what protects the route; never
widen the bypass to the rest of `/api/`.

The `orchestrate` skill's `post-status` needs no bypass: it sends from the Totem machine's
own localhost over ssh, reading the token from that machine's `.env`, so it never meets the
proxy. Only a sender that must come through the proxy needs a second bypass application, on
exactly `/api/dev/runs/*`, the same way. Access matches paths, not methods, so that bypass also lets
`PUT /api/dev/runs/<slug>` (archiving) reach Totem without Access. Totem's own sign-in still
guards it, so this is safe with the normal password sign-in. With `TOTEM_AUTH=proxy` Totem
trusts every request that reaches it, so do not add the `/api/dev/runs/*` bypass in that mode.
Never bypass `/api/dev/runs` itself (the list) or `/api/dev/*`.
