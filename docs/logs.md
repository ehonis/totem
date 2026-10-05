# Logs, approvals, and command output

Three things that only make sense together: a record of everything Totem does, a
gate an AI cannot open by itself, and the captured output of work it asked for.

## Why this exists

Opening the inbox to ChatGPT created a problem that instructions cannot solve.

The requirement was *"ChatGPT can accept inbox items, but it always has to ask me
and I have to approve — it can never run it itself."* The obvious implementation
is to write that in the `instructions` block and trust it. That does not work,
and it is worth being precise about why: **a tool call is the action.** There is
no moment between "ChatGPT decided" and "the thing happened" for an instruction
to intervene. A model that is confused, that has lost the thread of a long
conversation, or that has been prompt-injected by text it read in a calendar
invite will call `totem_resolve_inbox` and then report that it did so. The
instruction was followed right up until it wasn't, and by then the issue is filed.

So approval is a **two-party protocol with a secret the requester never sees**.
The model can ask. Only the owner can answer.

| Thing | Where |
|---|---|
| Approval grants | `logs/approvals.mjs`, state in `data/approvals.json` |
| Live runs | `logs/runs.mjs` — **in memory only** |
| Action log | `logs/store.mjs`, appended to `data/action-log.jsonl` |
| Command screening + runner | `bridge.mjs`, "Terminal command proposals" |
| Captured output | `data/outputs/<id>.json` |
| Tests | `logs/approvals.test.mjs`, `logs/runs.test.mjs` — `npm test` |
| UI | `web/src/components/LogsView.tsx`, the **Logs** tab |

---

## The approval gate

```
ChatGPT                          Totem                        the owner
   │ totem_request_approval ──────▶ lease: pending
   │                                 code: 733419 ───────────────▶ dashboard
   │◀── approvalSessionId, NO code                                notification
   │
   │ totem_resolve_inbox ─────────▶ authorize() → refused
   │◀── "still waiting on the owner's approval"
   │                                                    approve ◀─┤
   │ totem_resolve_inbox(P77) ────▶ authorize() → use 1; +1 hour
   │◀── accepted                     P77 runs
   │ totem_resolve_inbox(P78) ────▶ authorize() → use 2; +1 hour
   │◀── accepted                     P78 runs
```

The random `approvalSessionId` is explicit because `Mcp-Session-Id` names a
Streamable HTTP transport session, not a ChatGPT or Claude conversation. A client
may reconnect during one thread or reuse a connection in ways Totem cannot see.
The conversation keeps the explicit lease id and supplies it on every resolution.

The properties below are executable specifications in `logs/approvals.test.mjs`
and `logs/approval-controller.test.mjs`:

- **The requester never receives the code.** `request()` returns a public view
  with no `code` field; the code reaches the owner through the dashboard and the
  notification body only. There is no argument to any tool that returns it.
- **Reusable within one conversation.** An approved lease may authorize any
  number of staged inbox actions from the client that requested it. Each action
  retains its own proposal, output, correlation id, and audit row.
- **Sliding inactivity expiry.** Approval and every authorized use set the
  deadline to one hour in the future. Continuous work can continue; one quiet
  hour expires the lease. Expiry is persisted and evaluated under the store lock,
  so a restart cannot resurrect it.
- **Client-bound and revocable.** A ChatGPT lease cannot be presented by Claude.
  The owner can revoke an active lease in Logs, and later calls fail immediately.
- **Terminal decisions stick.** Denied, revoked, expired, and legacy per-item
  grants can never be revived into active conversation leases.
- **Concurrent use is serialized.** Every authorization increments `useCount`
  and slides the deadline under the same lock, so concurrent commands do not lose
  audit state.

Two other guards worth knowing about:

- **Explanations are mandatory.** `request()` rejects anything under 8 characters
  for either `explanation` (what this does) or `why` (why it should happen). The
  dashboard renders both as the primary content of the approval card, above the
  buttons. Approving an opaque id was the failure mode this removes.
- **Pending requests are capped at 10.** A model in a retry loop cannot bury the
  real decision under forty identical prompts. An identical request from the same
  client returns its existing pending lease.

**Denying also needs approval.** This is deliberate and slightly
counter-intuitive: silently clearing proposals the owner never read loses work just
as surely as accepting the wrong one. Both directions go through the gate.

**What this does not defend against.** The owner approving something he didn't read.
The explanation requirement, plain-English rendering, inactivity deadline, and
visible Revoke control are aimed at that, but the last mile is his. If a card shows
`(not explained — do not approve)`, that is a proposal that came in without an
explanation and it should be denied on sight.

Existing pre-lease rows in `data/approvals.json` are not migrated or deleted.
They remain visible as audit history with `legacy:true`, but `authorize()` refuses
them. A fresh out-of-band decision is required after deploying this change.

---

## Terminal command proposals

A new inbox kind, `command`. `totem_propose_command` stages it; accepting runs
it. The command itself lives in `inbox-prompts/<id>.sh`, **not** on the inbox
line — `inbox.md` is pipe-delimited and a shell one-liner is mostly pipes, so
inlining it silently rewrote `a | b` into `a / b`, which is a different command.
The line points at the file, exactly as a prompt proposal does.

### Screening

Approval protects against a *bad* proposal. It does not protect against a
*catastrophic* one misread at 11pm. So a refusal list sits underneath it, and
these cannot be staged at all — not warned about, not approved with a scarier
dialog:

| Refused | Because |
|---|---|
| `rm -rf /`, `rm -rf ~` | recursive delete of a filesystem root or home |
| `dd of=/dev/…`, `mkfs` | raw device write, formatting |
| `curl … \| sh` | piping downloaded content into a shell |
| `sudo` | privilege escalation (and it needs a TTY here anyway) |
| `shutdown`, `reboot`, `poweroff` | taking the box down |
| `git push --force` | rewrites published history |
| `history -c`, `rm .bash_history` | erasing the record of what ran |
| `shred`, `chmod 777 /` | unrecoverable, or catastrophic permissions |
| credentials piped or POSTed to the network | exfiltration |

Screening runs **twice** — at stage time and again at accept time — so a proposal
made before a rule existed cannot sail through afterwards.

If the owner genuinely wants one of these, he runs it himself in the Terminal tab.
The tool tells the model to say so rather than looking for a way around it.

### Execution

`runProposedCommand` uses `spawn('/bin/bash', ['-lc', …])` rather than the PTY
sessions in `terminal/sessions.mjs`. Those are interactive shells for the owner; this
needs a clean exit code and a transcript a model can read back. See **Live runs**
below for why `spawn` and not `execFile`.

- **cwd** must be inside `$HOME`. Validated at stage time, so a bad path is the
  proposer's problem rather than a confusing failure after the owner says yes.
- **timeout** 60s default, 600s max, `SIGKILL` on expiry.
- **output** capped at 200KB retained per stream, written to
  `data/outputs/<id>.json` with the exit code, duration and cwd. The output id
  **is** the inbox id, so `P77` produces output `P77` and the model knows where to
  look without being told.
- **detached**, like prompt runs, because the dashboard is waiting on the resolve
  response. Accepting returns `running, output P77` in milliseconds — the run
  itself is then watchable in **Logs → Now running**.

---

## Live runs

The action log is written **after** an action, with the outcome already known.
That is the wrong shape for a command four minutes into a build, or an agent three
tool calls into a job. For those you need the opposite: partial state, updated as
it arrives. `logs/runs.mjs` is that, and it is deliberately **in memory only** —
a live run cannot outlive the process that spawned it, so persisting one would
just resurrect a ghost on restart.

```
running ──▶ registry (partial, in memory) ──▶ Now running panel, live tail
   │
   └─ finishes ──▶ data/outputs/<id>.json + action log   (durable)
                   registry entry lingers 30 min          ("what did that just print")
```

### Watching a command

`runProposedCommand` uses `spawn`, not `execFile`. `execFile` hands you the output
only once the process exits, which makes a long command completely opaque exactly
when you care most. Streaming the pipes into the registry gives a live tail.

The retained copy is still capped at 200KB per stream, but output keeps flowing to
the registry past that cap — the registry has its own tail-keeping buffer, so a
chatty command shows its most recent output rather than going silent at the limit.

### Watching an agent think

The four provider streamers already emitted `onActivity`, `onTool` and `onText`;
the web chat consumed them for live typing. `runAgent`'s wrappers simply never
forwarded them, so background runs could only ever be watched at nothing-at-all
granularity. Forwarding them was a one-line change per provider, and it is what
makes "see its thoughts live" possible at all.

Three streams, rendered differently on purpose:

| Stream | Is | Shown as |
|---|---|---|
| `activity` | what it is DOING — "Running: ls -1", "Done: … (exit 0)" | accent, `▸` prefix |
| `tool` | the structured tool call | accent, dimmer |
| `text` | the prose it is generating, token by token | normal |
| `stdout` / `stderr` | command output | normal / amber |
| `system` | Totem itself, e.g. `[stopped by the owner]` | red italic |

Flattening these into one blob loses the distinction between what an agent *did*
and what it *said*, which is the whole value of watching.

### Polling, not SSE

`GET /api/runs/<id>?since=<seq>` returns only the chunks after `since`. Chunk
`seq` is a single monotonic counter across all runs, so ordering stays meaningful.

This is polling on purpose. A `since` cursor gives a tail that survives a page
refresh, a dropped connection, a laptop sleeping and a proxy timeout with no
reconnect logic whatsoever — the client just asks again from where it was. SSE
would need all of that for something designed to run for minutes.

The UI polls an open run at 1.5s and the run list at 3s while anything is live,
falling back to 15s when idle.

**One trap worth recording**, because it bit during the build: the cursor must be
a `ref`, not React state. As state it belongs in the polling effect's dependency
array, and then every poll that returned output tore the effect down and
immediately re-ran it — a tight request loop precisely while output was streaming.

### Stopping a run

`SIGTERM`, then `SIGKILL` after 3 seconds. A bare `SIGKILL` loses whatever the
process was about to print, and most things exit cleanly on the first signal.

`stop()` does **not** mark the run finished — the child's own `close` handler does,
which keeps exactly one code path for "how a run ends". It returns `false` when
there is nothing to stop (already finished, no abort handle, unknown id) so the
API can answer `409` honestly rather than pretending.

Eviction never removes a running entry, even under the size cap: a live process
with no registry entry is one nobody can see or stop.

## The action log

`data/action-log.jsonl`, one JSON object per action, newest last.

It exists alongside `data/assistant-usage.jsonl` rather than replacing it,
because they answer different questions:

| | `assistant-usage.jsonl` | `action-log.jsonl` |
|---|---|---|
| Question | how much is Totem used, by channel | what happened, and did it work |
| Written for | agent turns | every mutation |
| Keeps | channel, duration, 80-char preview | actor, target, status, why, detail, error |
| Feeds | the Usage graphs | the Logs tab |

They line up through `channel`, which uses the same vocabulary in both, so a
spike in a Usage graph can be expanded into the individual actions behind it.

Every entry carries:

```jsonc
{
  "id": "…", "ts": 1787755097171, "iso": "2026-08-26T14:38:17.171Z",
  "action": "inbox.accept",       // dotted verb; filters match on prefix
  "actor": "chatgpt",             // closed set — see ACTORS
  "status": "ok",                 // ok | error | denied | skipped
  "target": "P75",
  "summary": "accepted command proposal \"Check the working tree\" → …",
  "why": "To confirm what is uncommitted before deciding whether to commit",
  "detail": "{…}",                // arguments, exit codes, counts
  "correlationId": "P75",         // ties a whole chain together
  "ms": 27
}
```

`actor` is a closed set (`ethan`, `chatgpt`, `claude`, `cursor`, `agent`, `job`,
`system`, `unknown`) rather than a free string, because a free string becomes
forty spellings of "chatgpt" inside a week. Client names from MCP `initialize`
are normalised into it.

**`correlationId` is the useful one.** Pass an inbox id and you get the whole
story, including the attempts that were refused:

```
14:37:15  chatgpt  inbox.stage      ok      staged command proposal: git status --short | head -5
14:37:16  chatgpt  inbox.accept     denied  blocked: chatgpt tried to accept P75 without the owner's approval
14:37:25  chatgpt  approval.request ok      Accepting this runs git status --short in the totem repo…
14:38:17  ethan    approval.approve ok      approved: …
14:38:17  chatgpt  inbox.accept     ok      accepted command proposal → confirmed 2026-08-26 → running
14:38:17  chatgpt  command.run      ok      git status --short | head -5 → exit 0
```

Blocked attempts are logged as `denied`, not dropped. A model repeatedly trying
to act without approval is exactly the thing worth being able to see.

### Two implementation notes

- **Mutations are logged in the MCP dispatcher**, not in eleven handlers
  (`MCP_MUTATION_ACTIONS`). Adding a twelfth write tool cannot forget the audit
  trail. The tools that write their own richer entry — the stagers,
  `totem_resolve_inbox`, the command runner — are absent from that map on
  purpose, because a second line would be noise.
- **Credentials are redacted before the line hits disk** (`redactText`). The log
  is meant to be read, including by a cloud model through `totem_read_logs`, so
  a token that lands here is a token that leaves the box.

Writes are fire-and-forget and serialised: logging must never delay or break the
action it describes, and concurrent records must not interleave half-lines. The
file trims to the newest 8000 entries past ~8MB.

---

## API

| Route | Does |
|---|---|
| `GET /api/runs` | Live + recently finished runs, running first |
| `GET /api/runs/:id?since=` | One run plus only the chunks after `since` |
| `POST /api/runs/:id/stop` | SIGTERM then SIGKILL. `409` when there is nothing to stop |
| `GET /api/logs` | Newest first. `action` (prefix), `actor`, `status`, `since`, `correlationId`, `limit` |
| `GET /api/logs/summary` | Counts by status/action/actor over `?hours=` (default 24) |
| `GET /api/outputs` | Recent command outputs, newest first |
| `GET /api/outputs/:id` | One output in full: stdout, stderr, exit code, cwd |
| `GET /api/approvals` | Leases including pending activation codes — **this is the owner's view** |
| `POST /api/approvals/approve` | `{approvalSessionId}` or `{code}` |
| `POST /api/approvals/deny` | `{approvalSessionId \| code, reason?}` for a pending lease |
| `POST /api/approvals/revoke` | `{approvalSessionId, reason?}` for an active lease |

## MCP tools

| Tool | Does |
|---|---|
| `totem_propose_command` | Stage a command. Requires `explanation` + `why`. Does not run it |
| `totem_request_approval` | Request a conversation lease. Returns `approvalSessionId`, `pending`, no code, and a `tellOwner` sentence to relay |
| `totem_check_approval` | Poll one `approvalSessionId` for the owner's decision |
| `totem_resolve_inbox` | Accept/deny with the reusable `approvalSessionId`; each use slides expiry one hour. Returns `tellOwner` |
| `totem_read_logs` | The audit trail, filterable |
| `totem_get_output` | Works **during** a run (partial transcript, agent tool calls and prose) and after (full stdout/stderr/exit code). `since:<lastSeq>` for incremental polling. No id lists what is running now |

`tellOwner` is the sentence a client should pass on to the owner. Responses also carry it as
`tellEthan`, a deprecated alias with the same value, for clients written before the rename.

## Gotchas

- **Live runs do not survive a restart**, by design — neither do their child
  processes. A `systemctl restart` mid-command orphans nothing but does lose the
  partial transcript; the action log still records that the run started.
- **`num(null)` was 0, not the fallback.** `Number(null) === 0`, which is finite,
  so `num(v, fallback)` returned **0** for an explicitly-null value. This bit
  twice — as `limit=null` (endpoints silently returned empty pages) and as
  `timeoutMs: null` (a command was killed after 1 second instead of 60). `num()`
  now treats `null`, `undefined` and `''` as "not supplied". If you add a numeric
  option with a null-ish default, this is the failure you would otherwise chase.
- **`num()` vs query params.** `num(v, fallback)` is written for JSON bodies,
  where a missing key is `undefined` and `Number(undefined)` is `NaN` so the
  fallback fires. `URLSearchParams.get()` returns `null` for a missing param and
  `Number(null) === 0`, which is finite — so `num(q.get('limit'), 50)` silently
  returns **0** and the endpoint returns nothing. Use `qnum(q, 'limit', 50)`.
  This bit every new endpoint here before it was caught.
- **Deleting `data/approvals.json`** clears the audit trail of who approved what.
  Pending grants vanish, which fails closed — nothing becomes approved.
- **Deleting `data/action-log.jsonl`** loses history and nothing else; it is
  recreated on the next action.
- **An output id is an inbox id**, so re-using a `P` number (which happens if a
  line is hand-deleted from `inbox.md`) will overwrite the older output.
- **The approval code is in the notification body.** If `NOTIFY_WEBHOOK_URL` is
  set, codes go off-box to that endpoint. That is the point — it is how approval
  works from a phone — but it means the webhook is trusted.
