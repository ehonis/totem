# Gmail

Totem connects the owner's Gmail accounts directly, without a Claude connector or a
third-party MCP server. Agents can search, read, label, archive, trash and draft. They
**cannot send**. An email an agent wants sent goes into the Totem inbox, shown the way it
will arrive, and the owner picks **Send**, **Save as draft** or **Skip** there.

Code: `gmail/` (client and MIME), the "Gmail" blocks in `bridge.mjs` (tools, routes,
the `email` inbox kind), `web/src/components/McpSettingsView.tsx` (Settings → Connections
› Mail), `web/src/components/InboxView.tsx` (the email card).

## Setup

1. Use the same Google OAuth client as Calendar (`secrets/google-calendar-oauth-client.json`,
   or `GOOGLE_OAUTH_CREDENTIALS`). Gmail tools appear only once that file exists.
2. In that client's Google Cloud project, enable the **Gmail API** (APIs & Services →
   Library). Without it every call fails with a message saying so.
3. On the OAuth consent screen, add the scope `https://www.googleapis.com/auth/gmail.modify`.
   While the app is in **Testing**, add each Gmail address as a test user. Refresh tokens in
   Testing expire after 7 days, the same as Calendar's.
4. Settings → Connections › Mail › Gmail: type a label (`personal`, `side`) and click Add
   account. Finish Google's sign-in in the new tab. The callback is
   `http://localhost:<BRIDGE_PORT>/gmail-oauth/callback`. From a phone, swap `localhost` for
   a host the phone can reach, as with Calendar.

The same sign-in asks for Calendar too, and the account's calendar is added under the same
label (Settings → Connections › Calendar), unless that address already has a calendar
connected. Removing the Gmail account leaves the calendar working: the grant is revoked at
Google only when no calendar still uses it.

Accounts are stored in `data/gmail-tokens.json` (0600, override with `GMAIL_TOKENS_FILE`),
kept apart from Calendar's tokens. Removing an account also asks Google to revoke the grant.

## Tools

On `/mcp` they are `totem_gmail_*`; through the gateway they are `gmail__*`.

| Tool | Does |
|---|---|
| `list_accounts` | Connected accounts, their addresses, and whether sign-in still works |
| `search` | Gmail query syntax; searches every account unless one is named |
| `read_thread` | A whole conversation as text (HTML converted), with attachments listed |
| `get_attachment` | Saves one attachment under `data/gmail-cache/` and returns the path |
| `list_labels` | System and user labels per account |
| `modify` | Add or remove labels: archive, mark read or unread, star, file under a label |
| `trash` | Move to Trash, or restore from it. There is no permanent delete |
| `create_draft` | Saves a draft in Gmail (reply threading included) |
| `list_drafts`, `delete_draft` | Drafts |
| `propose_email` | Stages a finished email in the Totem inbox |

Every id is `account:id`, so a result from one account can't be applied to another by
mistake.

## Why sending is not a tool

Google has no scope that allows drafts but not sending; `gmail.modify` allows both. The
limit is enforced in code. `gmail.send()` exists only for the inbox's accept path.
`doResolveInboxItem` refuses an `email` item's `accept` (send) or `draft` unless the click
came from the dashboard, even under an approval session, as it does for `imessage`.
Incoming email is untrusted text that an agent reads; keeping send behind the owner's
click means a message telling an agent to send something can't do so.

## The `email` inbox kind

`propose_email` resolves everything when it stages: the account, recipients, subject, and
for a reply the thread, `In-Reply-To` and `References`. It uses the same `prepareEmail` that
sending uses. The finished email is written to `inbox-prompts/P<N>.email.json`, so the
card shows exactly what will go out: From, To, Cc, Bcc, subject, plain-text body and the
quoted message it answers. `POST /api/inbox/resolve` takes `action: "accept"` (send),
`"draft"` (save to Gmail Drafts) or `"deny"`.
