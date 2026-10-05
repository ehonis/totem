# Google Sheet task sync

Totem can mirror one shared Google Sheet of action items with the Ventures tasks on its board, for
work you track with other people in a spreadsheet. It is off until configured.

- Spreadsheet: the one named by `TASK_SHEET_ID` (optionally checked against `TASK_SHEET_TITLE`)
- Tab: `TASK_SHEET_TAB` (default `Action Items`), numeric sheet ID `TASK_SHEET_GID` (default `0`)
- Header row: 4
- Existing columns B:G: `Task Name`, `Who`, `Priority`, `Status`, `Due Date`, `Notes & Links`
- Connector columns H:I: visible `Tag`, hidden `Totem ID`

The connector resolves columns from the exact row-4 header text on every reconciliation. It does not trust letters or row numbers as durable identity. `Totem ID` is the stable identity and must be unique.

## Credentials

Create a Google Cloud service account in a project with the Google Sheets API enabled. Download its JSON key to a gitignored location such as `secrets/google-sheets-service-account.json`, make it readable only by you, and set:

```dotenv
GOOGLE_SHEETS_CREDENTIALS_FILE=/path/to/totem/secrets/google-sheets-service-account.json
TASK_SHEET_ID=<spreadsheet-id>          # the long id in the sheet's URL
TASK_SHEET_TAB=Action Items
TASK_SHEET_ASSIGNEES=Alex,Alex & Sam    # Who values that mean "mine"; the first is used for new rows
# TASK_SHEET_TITLE=Example HQ           # optional: refuse the sheet unless its title matches
# TASK_SHEET_GID=0                      # numeric id of the tab (the #gid= in its URL)
```

All of these can also be entered in Settings -> Integrations; restart the bridge
after changing them.

Share only that spreadsheet with the JSON file's `client_email` as Editor. Totem exchanges a signed assertion for the single `https://www.googleapis.com/auth/spreadsheets` scope and caches the short-lived access token. It never uses the Google Calendar OAuth grant and never logs the private key or bearer token.

## Ownership and eligibility

Auto-tracking requires both an exact assignment (one of `TASK_SHEET_ASSIGNEES`) and one exact tag from the install's venture tags (Settings -> Tasks). Finished rows are not newly imported. Case-folding and fuzzy title matching are intentionally forbidden.

Totem may initialize `Who` to the first configured assignee and `Status = Not Started` only when creating a brand-new explicitly shared row. After the stable link exists, the Sheet owns Who and Status. Totem never writes either field again. Task Name, Priority, Due Date, Notes & Links, and Tag are reconciled independently; note publication appends rather than replaces.

## Schema bootstrap safety

Schema bootstrap is never a startup action. The explicit command/API must re-read metadata, verify the exact spreadsheet ID, tab title, numeric sheet ID, timezone, and untouched six existing headers, then add only H:I. It writes the Tag header and dropdown, writes Totem ID, and hides only the Totem ID column. Any mismatch, duplicate header, or duplicate nonblank Totem ID aborts before a write.

Until the service-account JSON exists and the spreadsheet is shared with its email, Totem keeps the connector unconfigured and does not write to the Sheet.

## Operations

Read-only inspection validates metadata, headers, timezone, and stable-ID uniqueness:

```sh
node todos/cli.mjs sheet-inspect
```

The one-time schema change requires the literal spreadsheet ID; it is never inferred and never runs during bridge startup. The Tag dropdown it adds lists the venture tags configured at that moment:

```sh
node todos/cli.mjs sheet-bootstrap-schema \
  --confirm-sheet-id <spreadsheet-id>
```

After bootstrap, the agentless `task-sheet-sync` job reconciles every 15 minutes. `GET /api/todos/connectors/sheet` returns settings and health; `POST /api/todos/connectors/sheet/refresh` runs the same reconciliation manually; `POST /api/todos/connectors/sheet/bootstrap` requires `{ "confirmSheetId": "<exact id>" }`.

Every shared-field write is narrow: only the changed cell is sent. Local-only and remote-only changes reconcile automatically; divergent changes to the same field become visible conflicts and neither side is overwritten. Totem note appends carry an operation marker so an ambiguous response cannot duplicate text. Create, update, and append intents persist in SQLite before the external attempt, use expiring leases and exponential retry, and stop in visible `exhausted` state after five attempts. Pull and outbox drain are attempted independently in each job run.

Reassignment away from the configured assignees archives the local task without deleting history or touching the Sheet. A missing stable ID marks the retained link missing; unsharing removes only the local link and never deletes the row.
