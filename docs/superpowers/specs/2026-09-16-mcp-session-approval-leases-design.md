# MCP Session Approval Leases

## Goal

Replace Totem's single-use, per-inbox-item MCP approvals with an explicit reusable
conversation lease. The owner approves once, and that conversation may resolve any
number of approval-gated inbox proposals until the lease has been inactive for one
hour or the owner revokes it.

## Why the lease is explicit

`Mcp-Session-Id` identifies a Streamable HTTP transport session, not a Totem or
ChatGPT conversation. A client may reconnect during one conversation or reuse a
connection in ways Totem cannot observe. Totem therefore must not treat the
transport identifier as the approval boundary.

The server creates a random `approvalSessionId` when a conversation requests
approval. The MCP client receives that identifier and supplies it to subsequent
approval checks and inbox resolutions. Possession alone is inert while the lease
is pending; the owner still has to approve it through the authenticated dashboard or
by reading the one-time code back to the conversation.

## Scope

An approved lease authorizes the actions that already pass through
`totem_resolve_inbox`:

- running a staged shell command;
- launching a staged coding-agent prompt;
- accepting another staged inbox proposal; and
- denying a staged inbox proposal.

It does not add approval gates to ordinary MCP writes such as task, calendar,
habit, note, goal, or Strava operations. Their existing behavior is unchanged.
The hard command refusal list also remains authoritative: a lease can authorize a
staged command, but it cannot make an otherwise forbidden command stage or run.

## Lease lifecycle

Lease statuses are `pending`, `approved`, `denied`, `expired`, and `revoked`.

1. `totem_request_approval` creates a pending conversation lease and returns its
   random `approvalSessionId` without returning the one-time code.
2. The owner approves the lease in Logs or reads the code to the conversation. The
   lease becomes approved and its inactivity deadline becomes one hour from that
   decision.
3. `totem_resolve_inbox` supplies `approvalSessionId`. Immediately before the
   proposed action begins, Totem atomically verifies the lease, records the use,
   increments its use count, and moves the inactivity deadline to one hour from
   that use.
4. Any number of uses are allowed while the lease remains active. Failed actions
   still count as activity if authorization succeeded, because Totem attempted
   the authorized operation.
5. If the deadline passes, the lease expires lazily at the next read or use. It
   cannot be revived; the conversation requests a new lease.
6. The owner may revoke an approved lease at any time. Revocation is immediate and
   permanent. A pending lease may still be denied.

There is no absolute lifetime cap. Continuous activity keeps the lease alive, as
requested; inactivity for one hour always ends it.

## Persistence and compatibility

`logs/approvals.mjs` remains the single serialized JSON store and locking boundary.
Existing rows in `data/approvals.json` are read as legacy per-item grants. They stay
visible as audit history, but they cannot authorize a session action after the new
server starts. No destructive data migration is required.

New lease rows store the random ID, status, requester/client name, human-readable
purpose, one-time code, request/decision/use timestamps, inactivity deadline,
use count, and optional denial/revocation reason. The requester-facing view never
contains the code; the owner-facing dashboard view may expose it only while the
lease is pending.

The MCP tool surface changes in place:

- `totem_request_approval` requests a conversation lease rather than permission
  for one proposal and returns `approvalSessionId`.
- `totem_check_approval` looks up that identifier.
- `totem_resolve_inbox` requires that identifier for every MCP resolution and may
  additionally accept the one-time code on the first use.

The server version is bumped so clients with cached schemas refresh the tools.
Tool instructions and output metadata must describe the reusable lease and the
one-hour inactivity behavior without implying that `Mcp-Session-Id` is the trust
boundary.

## Dashboard and audit trail

Logs shows pending requests first and active leases beside them. An active lease
displays the requesting client, purpose, use count, last activity, and time left.
The action button changes from Deny to Revoke after approval. Recently denied,
revoked, and expired leases remain visible in the existing history section.

Approving, denying, revoking, and each authorized inbox resolution continue to
write action-log records. Every proposal keeps its own correlation ID and output,
so one broad lease does not collapse multiple commands into an opaque audit row.
The inbox resolution record also identifies the lease used.

## Failure behavior

Authorization fails closed when the lease identifier is absent, unknown, pending,
denied, revoked, expired, or malformed. The result tells the MCP client whether to
wait, stop, or request a new lease. A wrong one-time code cannot approve a lease.
Concurrent uses are serialized through the existing store lock so deadline and use
count updates cannot overwrite one another.

If an inbox item disappeared or was already resolved, the lease remains active;
the failed target lookup does not revoke an otherwise valid conversation. If the
bridge restarts, the persisted deadline and status preserve the lease.

## Testing

Store tests cover inert requests, hidden codes, approval, multiple authorized
uses, sliding expiration, inactivity expiry, revocation, denial, wrong codes,
concurrent uses, legacy-row rejection, persistence, and owner/requester views.

Bridge/MCP tests cover the updated schemas and metadata, session IDs flowing from
request through check and resolve, repeated proposal resolutions under one lease,
blocked resolution without a valid lease, code approval on first use, audit-log
linkage, and the MCP server version bump. Dashboard tests cover pending, active,
expired, and revoked rendering plus the revoke action.

## Documentation

The same change updates `AGENTS.md`, `docs/logs.md`, and
`docs/totem-mcp-server.md` so no maintained document continues to describe
approvals as single-use or pinned to one inbox item.
