# Dev tab

One place to see the CI and review state of the owner's GitHub repos, pause AI code review
per repo, start a review of one PR, and receive production alerts from outside. GitHub stays
the source of truth: Totem reads its state, sets one repo variable and dispatches the review
workflow, nothing else.

Code: `dev/` (`github.mjs` the `gh` calls, `service.mjs` config and cache, `watcher.mjs` the
background check, `alerts.mjs` the alert record, `ingest.mjs` the public alert route,
`http.mjs` the `/api/dev` routes) and `web/src/components/DevView.tsx`.

## What it shows

### PRs per day

The first card, shown whether or not any repo is watched: every pull request the server's
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
