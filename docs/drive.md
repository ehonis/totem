# Google Drive

Totem connects the owner's Google Drive accounts directly, the same way it connects Gmail.
Agents can find, read, create, copy, rename, move and trash files, edit Google Sheets cell
by cell, and edit Google Docs text. They **cannot share** a file or change who can see it,
and they **cannot delete** a file for good: trash is the only delete.

Code: `drive/index.mjs` (client), `google/accounts.mjs` (sign-in and tokens, shared with
Gmail), the "Google Drive" blocks in `bridge.mjs` (tools, routes, the prompt rule),
`web/src/components/McpSettingsView.tsx` (Settings → Connections › Files).

## Setup

1. Use the same Google OAuth client as Calendar and Gmail
   (`secrets/google-calendar-oauth-client.json`, or `GOOGLE_OAUTH_CREDENTIALS`). The Drive
   tools appear only once that file exists.
2. In that client's Google Cloud project, enable three APIs (APIs & Services → Library):
   **Google Drive API**, **Google Sheets API** and **Google Docs API**. A call to an API that
   is off fails with a message naming it.
3. On the OAuth consent screen (Data access), add the scope
   `https://www.googleapis.com/auth/drive`. It is a restricted scope: in **Testing**, add each
   Google address as a test user. Refresh tokens in Testing expire after 7 days, as for
   Calendar and Gmail. Published but unverified, Google shows an "unverified app" warning at
   sign-in, which the owner can click through.
4. Settings → Connections › Files › Google Drive: type a label (`personal`, `work`) and click
   Add account. Finish Google's sign-in in the new tab and tick the Drive box. The callback is
   `http://localhost:<BRIDGE_PORT>/drive-oauth/callback`. From a phone, swap `localhost` for a
   host the phone can reach, as with Calendar.

Accounts are stored in `data/drive-tokens.json` (0600, override with `DRIVE_TOKENS_FILE`),
apart from Gmail's and Calendar's: each service has its own sign-in, so removing one never
breaks another. Removing an account also asks Google to revoke the grant. Downloads (PDFs,
`.xlsx`, images) are saved under `data/drive-cache/`.

## Tools

On `/mcp` they are `totem_drive_*`; through the gateway they are `drive__*`, so every chat,
job and totem run gets them with nothing to configure per totem.

| Tool | Does |
|---|---|
| `list_accounts` | Connected accounts, their addresses, storage, and whether sign-in still works |
| `search` | Plain words over names and contents, or Drive query syntax in `q`; every account unless one is named; shared drives included |
| `read_file` | A Doc as Markdown, Slides as text, a Sheet as its tabs plus the first tab's cells, a folder as its contents, text as text; anything else saved to a file and its path returned |
| `create_file` | A Doc (from text or Markdown), a Sheet (from CSV), empty Slides, a folder, or a plain file |
| `copy_file` | Copy, rename, put in another folder; `convert: true` turns an uploaded `.xlsx`/`.docx`/`.pptx`/`.csv` into a Google file |
| `update_file` | Rename, describe, star, move; replace a plain file's contents |
| `trash` | Move to Trash, or restore. There is no permanent delete |
| `sheet_info` | A Sheet's tabs (`sheetId`, size, frozen rows) and named ranges |
| `sheet_read` | Cells from A1 ranges, as shown, raw, or as formulas |
| `sheet_write` | Cells in one or more A1 ranges, entered as if typed (formulas and dates parse) |
| `sheet_append` | Rows after the last row of a table |
| `sheet_clear` | Empty ranges, keeping formatting |
| `sheet_batch_update` | The Sheets API's own `batchUpdate`: tabs, rows and columns, formatting, sort, filters, validation |
| `doc_edit` | Find-and-replace, insert at the top, append at the end, in one atomic batch |

Every id is `account:id`. A bare id (the long one in a `docs.google.com` URL) works with one
account connected.

## Office files

A spreadsheet uploaded as `.xlsx` is not a Google Sheet, and the Sheets API refuses it
("This operation is not supported for this document"). `read_file` downloads it so an agent
can read it with its own tools. To edit it in Google, `copy_file` with `convert: true` makes
a native Sheet beside it; the owner decides whether the copy replaces the original.

## Why sharing is not a tool

The `drive` scope allows changing permissions, so the limit is in code: no tool reaches
Drive's permissions endpoints. Sharing hands a file to someone else, and a file's contents
are untrusted text that an agent reads, so the owner does it in Drive himself.
