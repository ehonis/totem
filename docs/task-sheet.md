# The task sheet (read-only)

Totem can show the open rows of one shared Google Sheet of action items beside your tasks: the
rows assigned to you that are not done. The task feed reads the sheet through your Google Drive
sign-in and **never writes to it**. The people you share it with keep editing it in Google Sheets
as before. "Read-only" is about the task list: the Drive tools are a separate feature and can
still edit the sheet when you ask (below). It is off until configured.

Code: `todos/connectors/task-sheet-feed.mjs`. Route: `GET /api/todos/sheet` (in `todos/http.mjs`).

## Setting it up

1. Connect the Google account that can open the sheet in **Settings → Connections › Accounts →
   Google Drive** (`docs/drive.md`). The Drive sign-in's `drive` scope also covers the Sheets API,
   which has to be enabled on the OAuth client's Google Cloud project.
2. In **Settings → Tasks › Task sheet**, set:

| Setting | Meaning |
|---|---|
| `TASK_SHEET_ID` | The spreadsheet: the long id in its URL, between `/d/` and `/edit`. Required. |
| `TASK_SHEET_ASSIGNEES` | The Who-column values that mean you, comma-separated, e.g. `Alex, Alex & Sam`. Matched trimmed, case-insensitive, with runs of spaces folded. Required. |
| `TASK_SHEET_TAB` | The tab to read. Default `Action Items`; matched exactly, then case-insensitively. |
| `TASK_SHEET_TITLE` | What Totem calls the sheet. Default: the spreadsheet's own title. |
| `TASK_SHEET_ACCOUNT` | Which Drive account reads it (its label or address). Needed only when more than one Drive account is connected. |

They can also be set in `.env`; a value there wins and shows read-only in Settings. They are read
on every fetch, so no restart is needed. The Status row under them says whether the feed is set
up, when it was last read, how many rows are open for you, and the last error; **Read now** reads
it again.

## What it reads

The tab is read whole, with the values as the sheet shows them ("formatted"). Nothing about the
layout is trusted:

- **The header row** is the first of the first ten rows with a cell that says exactly `Task Name`.
  A title block above it is fine.
- **Columns are matched by header text** (trimmed, case-insensitive), never by letter: `Task Name`,
  `Who`, `Priority`, `Status`, `Due Date`, `Notes & Links`. `Who` and `Status` are required; the
  others may be missing. Any other column (a `Tag`, stray cells past the table) is ignored.
- **A row is shown** when it has a task name, its Who is one of `TASK_SHEET_ASSIGNEES`, and its
  Status is not `Done` (any case). `In Progress`, `Not Started`, a blank or any other status counts
  as open.

Each item:

```json
{ "id": "sheet:<gid>:<row>:<8 hex of the title>", "row": 52, "title": "…", "who": "Alex & Sam",
  "priority": 1, "status": "Not Started", "dueDate": "2026-11-23", "notes": "…",
  "url": "https://docs.google.com/spreadsheets/d/<id>/edit#gid=<gid>&range=B52" }
```

- `priority`: High → 1, Medium → 2, Low → 3, anything else `null`.
- `dueDate`: a `YYYY-MM-DD` day key from `M/D/YYYY` (US) or `YYYY-MM-DD`; a blank, words or an
  impossible date (`2/30/2026`) is `null`.
- `id` is stable while the row keeps its place and its task name: editing the status, date,
  priority or notes keeps it; renaming the task or moving the row changes it.
- `url` opens the sheet at that row's task name.

## The response

`GET /api/todos/sheet` →

```json
{ "configured": true, "title": "Example HQ", "url": "<sheet url>", "fetchedAt": "<iso>",
  "stale": false, "error": null, "items": [ … ] }
```

Not set up (no id or assignees, no Drive account, several accounts and no `TASK_SHEET_ACCOUNT`, or
an account that is not connected): `{ "configured": false, "items": [], "reason": "<what to set>" }`.

- **Cached for 120 seconds.** `?refresh=1` reads the sheet again, at most once every 10 seconds;
  inside that window it answers from the cache. Concurrent requests share one read.
- **A failed read** (an expired Drive sign-in, the Sheets API refusing, a missing tab, a sheet whose
  header row cannot be found) answers the last good items with `stale: true` and the error, scrubbed
  of anything secret-shaped (`sources/scrub.mjs`); `fetchedAt` stays the time of the last good read.
  With no good read yet, `items` is empty.
- **Not ETag-cached** (`http/etag.mjs`): the phone does not keep it on disk.
- Each read is one run of the `task-sheet` source in the source-health log (`docs/source-health.md`);
  a feed that is not set up marks the source "not set up" instead.

## In the iPhone app

The app's Tasks list (`mobile/src/features/productivity/TodosView.tsx`, rows from
`mobile/src/features/todos/list.ts` over the shared `buildList`) mixes the open rows into its
due groups, ordered with the tasks (due day, priority, tasks before rows). A row wears the
sheet's mark and the feed's `title` (else "Task sheet") where a task has its check circle, and
has no swipe or menu that changes anything (`SheetCard.tsx`). Tapping it opens a read-only
detail with Open in sheet (`SheetItemPage.tsx`, on the task route with the row's `sheet:` id).
A failed or stale read is one quiet line under the status line (tap to read again); a sheet
that is set up with nothing assigned says so once at the foot of the list; one that is not set
up adds nothing to the list, and Filter › Show lists it greyed as not set up. The feed is not
ETag-cached, so offline the app keeps the rows it last read in memory.

## What "read-only" covers

**The task feed never writes to the sheet.** It is handed only Drive's read calls (`sheetInfo`,
`sheetRead`; see `taskSheetFeed` in `bridge.mjs`), and only a GET reaches it. Tests check that
every request it makes to Google is a GET to the Sheets API. Nothing in the task list (completing,
snoozing, editing, sharing) changes a sheet row.

**The Drive tools are a separate feature and can still edit the sheet.** An agent asked to add a
note to a row, or to fill in a cell, does it with the `drive__sheet_*` tools (`docs/drive.md`), as
for any other Sheet the Drive account can open. That is unchanged and deliberate; the feed then
shows the edit on its next read.

## Retired: the two-way sync

Totem used to mirror the sheet with Ventures tasks through a Google service account
(`GOOGLE_SHEETS_CREDENTIALS_FILE`, the `task-sheet-sync` job, share-to-sheet, a hidden `Totem ID`
column). That is gone:

- `syncTarget: 'sheet'` (create, share, MCP tools, inbox proposals marked `sync: sheet`) is refused
  with `400 SHEET_SHARING_REMOVED`.
- `/api/todos/connectors/sheet*` and the CLI's `sheet-inspect` and `sheet-bootstrap-schema` are
  removed. `GOOGLE_SHEETS_CREDENTIALS_FILE` and `TASK_SHEET_GID` are no longer read; the
  service-account key and the hidden `Tag`/`Totem ID` columns can be deleted.
- A saved `task-sheet-sync` job (or the same job under its older id) in `data/jobs.json` is dropped on
  read (`retiredIds` in `jobs/store.mjs`).
- Migration 012 (`todos/migrations/012-retire-sheet-sync.mjs`, after a backup) archives every task
  the old sync linked to a sheet row (the feed shows those rows now; restore one from the archive if
  you want it as a task), and deletes the sync's outbox rows and connector state. A restored task is
  a local task: it completes, reopens and edits in Totem, and **Stop syncing** just removes the link.
  A retired connector's leftovers never count toward a task's sync state (`syncStateFor`).
- `TASK_SHEET_TITLE` used to be a guard (refuse a sheet whose title differed); it is now only the
  display name.
