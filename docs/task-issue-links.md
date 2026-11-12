# Task statuses and GitHub issue links

A task is open (`todo`) or `done`. A task may point at one GitHub issue, as a plain link whose
live open/closed state Totem reads; the issue does not decide when the task is done.

This replaced two things in migration 011: the Doing status, and the GitHub task connector
(auto-tracking assigned issues, watched repositories, issue search and link, the write outbox,
the `github-todos-sync` job, sharing a task to GitHub, and the GitHub App behind it).

## Statuses

- The bridge stores and returns `todo` or `done` only.
- Every input still accepts `doing` and stores `todo`: move, create, update, bulk `move`,
  reorder (`status: 'doing'` reorders open tasks), the MCP `totem_*` task tools (a read filter of
  `doing` means open), and an imported status. Older app bundles and the phone's
  cached answers still send it. Anything else is a 400 `INVALID_STATUS`.
- A `doing` row a restore brings back (an export taken before 011) reads as `todo`, and the next
  open of the file runs 011 over it.

## Migration 011

`todos/migrations/011-no-doing.mjs`, with `backupBefore` (an existing database is copied to
`todos.db.pre-migration-11-<stamp>` first). In one transaction it:

1. turns every `doing` row into `todo`, placed above the open tasks in the order it had (new
   positions below the smallest `todo` position; no `todo` row moves, `updated_at` is kept);
2. archives (`archived_at`, `updated_at` = now) every task that is not deleted or already
   archived and has a `github` external link: the tasks the connector imported. They are in the
   archive, restorable like any archived task;
3. deletes the GitHub connector's unsent outbox rows (any status but `completed`). A queued
   `create` was an issue the owner approved that was never filed: each one is named in the action
   log (`todo.github-outbox.drop`, with its title and repo) once the migration commits, and the
   `todos.db.pre-migration-11-*` backup still holds the row and its body. Those lines are written
   only when the bridge or the MCP gateway opens the file first (they pass their action log to
   `openTodoDatabase`); the `todos`, `goals` and `notify` CLIs do not, so a migration they run
   records no lines, and the backup is the only record.

Running it again changes nothing. The GitHub sync's source-health row (`github-tasks`) is
forgotten at every boot (`sourceRuns.forget`), so it never shows in Settings → Connections.

## Issue links

`PUT /api/todos/:id/issue-link` with `{ "url": "https://github.com/<owner>/<repo>/issues/<n>" }`
sets the link, and `{ "url": null }` clears it. Anything else is a 400 `INVALID_ISSUE_LINK`:
another host, `http:`, a port or credentials, a pull request (its own message), a path past the
number, a zero. The query and fragment are dropped. The link replaces any GitHub link the task
had (including one the connector left), is an `external_links` row with connector `github` and
no sync, and is audited as `todo.issue-link.set` / `todo.issue-link.clear`. Two tasks may link
the same issue.

Every task DTO carries `issueLink`: `{ connector: 'github', repo: 'owner/repo', number, url }`,
or `null`. A GitHub link owns nothing: the task completes, reopens and repeats locally (no
connector owns completion since the sheet sync went too), and it has no sync state.

## Live state

`GET /api/todos/issue-states` answers

```json
{ "fetchedAt": "<iso or null>", "states": { "owner/repo#12": { "state": "open", "title": "…", "url": "…" } }, "error": "<only on a failed read>" }
```

for the GitHub links on tasks that are not archived or deleted, at most 50 issues (the most
recently updated tasks first). It reads `gh api repos/<owner>/<repo>/issues/<n>` through the
service user's `gh` (`ghCapture`, the Dev tab's runner), four at a time
(`todos/issue-states.mjs`):

- each issue keeps its own reading and is read again once that is five minutes old, so a link
  added, or a task brought back from the archive, is read on its own; `fetchedAt` is the oldest
  reading behind the answer;
- a failed read keeps that issue's last good state, is not retried for a minute, and `error`
  names the linked issues still failing (in the words `ghErrorMessage` uses for the Dev tab);
- an issue no longer linked is forgotten, and nothing is read while no task has a link.

It is not in `ETAG_PATHS`, and `ETAG_RECORD` excludes it (`http/etag.mjs`), so the phone never
caches it as a task.

## In the iPhone app

A linked task's card carries the issue's number and, once `issue-states` has answered, a
green (open) or purple (closed) dot; the task page's GitHub issue section opens it, sets it
(an issue link or `owner/repo#n`, checked before sending by `features/todos/issueLink.ts`) and
clears it. The app reads the states only while some task on the board links an issue. There is
no Doing anywhere in the app: swiping a card right finishes it like its circle does (the same
beat), and a finished one reopens from its circle, its swipe or its menu.

## Board additions

- `GET /api/todos/board` (any query) adds `counts: { archived, snoozed, deleted }`, counted in
  SQL over the whole database, whatever the query: archived (archived and not deleted), snoozed
  (neither archived nor deleted, snoozed past now, open or done), deleted (the recycle bin).
  A `status` filter of `doing` reads as `todo`; a status that never existed is a 400.
- `POST /api/todos/board` creates a task and answers `{ todo }` in the board's own shape.
  `createBoardTodo` in `web/src/api.ts` and `mobile/src/lib/api.ts` uses it. `POST /api/todos`
  keeps its old (Todoist-like) shape for the phone shortcut and old clients.

## What GitHub sharing became

- One check, `assertSyncTarget` in `todos/errors.mjs`, runs before anything is written on every
  path that takes a `syncTarget`: `POST /api/todos`, `POST /api/todos/board`, `PATCH /api/todos`
  and `PATCH /api/todos/:id`, `share`, MCP `totem_create_task` and `totem_update_task`, and an
  inbox proposal's `sync:` marker. Only `local` (or none) passes. `github`, in any case, answers
  400 `GITHUB_SHARING_REMOVED`; `sheet` answers `SHEET_SHARING_REMOVED` (the two-way sheet sync
  went with migration 012, `docs/task-sheet.md`); anything else is `INVALID_SYNC_TARGET`.
- `POST /api/todos/:id/external-links` refuses connector `github` (400 `USE_ISSUE_LINK_ROUTE`), so
  the validated `PUT /api/todos/:id/issue-link` is the only way a GitHub link is set.
- The `/api/todos/connectors/github*` routes, `POST /api/todos/:id/publish-description` and
  `node todos/cli.mjs github-check` are gone. `GITHUB_APP_*`, `GITHUB_ASSIGNEE_LOGIN` and
  `GITHUB_TODOS_SYNC_ENABLED` are no longer read.
- The `github-todos-sync` job is in the job store's `retiredIds`: a saved entry in
  `data/jobs.json` is dropped on read and never re-seeded.
- A `github` inbox proposal (staged by the journal and meeting ingests) still files its finished
  issue when the owner accepts it, now directly through `gh api` (`todos/inbox-issue.mjs`, every
  field a raw `-f`), and makes no task. Its repo is checked (`isGithubRepo` in
  `todos/issue-link.mjs`) when the proposal is read, so a bad one is unreadable, never a send that
  failed after dispatch. Link the issue to a task by hand if it should be one.
