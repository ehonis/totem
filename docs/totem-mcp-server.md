# Totem MCP Server — spec

**Status:** built and live; this document is the maintained design and operations reference.
**Goal:** let ChatGPT (priority), Claude.ai, and Claude Code talk to Totem as a first-class
system — read its real state, write through scoped tools, and escalate open-ended work into
the existing confirm-only inbox.

---

## 0. Naming — do not confuse these two

The repo already has an MCP component pointing the **other** way. Keep them straight:

| File | Direction | Role |
|---|---|---|
| `mcp-gateway.mjs` (exists) | Totem → apps | MCP **client** hub. Serves built-in local tasks beside configured Calendar / Plaud tools over **stdio** to the agent CLIs. |
| `/mcp` in `bridge.mjs` (this spec) | Clients → Totem | MCP **server**. Exposes Totem itself over **Streamable HTTP** to ChatGPT / Claude. |

They share nothing but the protocol. This one is the *front door*; that one is the *back door*.

---

## 1. Why this exists

Today Totem has two front doors — the iOS Shortcut (`/ask-text`) and the web dashboard — and
both require *being in Totem*. The stated use pattern is "I tell it to do things; I don't want
to build a chat interface." An MCP server inverts that: the chat interface becomes ChatGPT,
which you already have open, and Totem becomes the hands and the memory behind it.

Design consequence: **this is not a chat proxy.** A single `ask_totem` passthrough tool would
re-create the thing you don't want — slow, lossy, and the model can't reason about what came
back. Instead the server mirrors the `/api/*` direct-read surface as typed tools, so the cloud
model reads real structured state at ~200 ms and reasons over it itself.

This preserves the architecture's core rule: **direct reads, agent writes.**

---

## 2. Topology

```
ChatGPT / Claude.ai  (cloud, public internet)
   │  Streamable HTTP + OAuth 2.1 (DCR + PKCE)
   ▼
Cloudflare Access  ── managed OAuth, authorization server
   │  injects Cf-Access-Jwt-Assertion
   ▼
Cloudflare Tunnel  (cloudflared.service, already running)
   │  <your-host> → localhost:8787
   ▼
bridge.mjs  POST /mcp        ← new; validates the Access JWT
   ├── read tools   → existing direct readers (fetchTodos, readHabits, …)
   ├── write tools  → existing writers (createTodo, logHabit, …)
   └── escalate     → runAgent(…, channel:'mcp') → staged into data/brain/inbox.md
```

Nothing new is deployed. The tunnel, the hostname, and the Access app all already exist.

---

## 3. Transport

**`POST /mcp`** on the bridge — MCP Streamable HTTP, protocol version `2025-06-18`.

- Accept `application/json`; respond `application/json` for unary calls.
- SSE (`text/event-stream`) responses are **not** required for v1 — every tool here is a short
  request/response. Advertise no `logging` or `sampling` capability and the clients won't ask.
- `GET /mcp` returns `405`. No server-initiated streams in v1.
- Session: honour `Mcp-Session-Id` if a client sends one, but keep the server **stateless** —
  each call re-reads from disk/API. Simpler, and survives a bridge restart mid-conversation.
- `DELETE /mcp` → `204`, no-op.

Reuse the JSON-RPC framing already written in `mcp-gateway.mjs` (`serve()`, lines 392–439). It's
the same dispatch — `initialize` / `ping` / `tools/list` / `tools/call` — just over HTTP instead
of stdin. Factor that dispatch into a shared helper rather than copy-pasting it.

### Methods

| Method | Behavior |
|---|---|
| `initialize` | Returns `serverInfo` `{name: "totem", version}`, `capabilities: {tools:{}, resources:{}}`, and the `instructions` block from §5. |
| `ping` | `{}` |
| `tools/list` | Full tool table (§6). No pagination — it's ~20 tools. |
| `tools/call` | Dispatch. Tool failures return `{isError: true, content:[…]}`, **not** JSON-RPC errors, so the model sees the message and can recover. |
| `resources/list` / `resources/read` | The self-description documents (§5). |

---

## 4. Authentication

This is the part that actually gates the project, and the answer is **already sitting in your
infrastructure**.

### 4.1 The constraint

ChatGPT custom connectors require a public HTTPS endpoint speaking Streamable HTTP, authenticated
with **OAuth 2.1 including Dynamic Client Registration**, or not at all. **Static bearer tokens are
not accepted** — so `BRIDGE_SECRET` cannot be the auth story for the cloud clients.

With Cloudflare Access in front of `<your-host>`, Access answers non-browser
requests with a `302` to `<team>.cloudflareaccess.com`. Verified:

```
$ curl -sI https://<your-host>/health
HTTP/2 302
location: https://<team>.cloudflareaccess.com/cdn-cgi/access/login/…
www-authenticate: Cloudflare-Access resource_metadata="…/.well-known/cloudflare-access-protected-resource/health"
```

and that metadata document currently advertises exactly one auth method — `cloudflared`, the
interactive CLI flow. No cloud MCP client can complete that. **As of right now, ChatGPT cannot
connect to Totem.**

### 4.2 The fix — Access Managed OAuth

Cloudflare Access supports **Managed OAuth**: flip it on and Access stops sending `302` to
non-browser clients and instead returns `401` with a `WWW-Authenticate` header pointing at
RFC 8414 / RFC 9728 discovery endpoints. The client opens a browser, you log in with your normal
Access identity, and the client receives a real OAuth access token. Access enforces the same
policies as the browser login — it's a new transport for auth, not a bypass.

This means **zero OAuth code in `bridge.mjs`**. Cloudflare is the authorization server.

It is opt-in per application, so it must be turned on deliberately.

**Recommended: a separate Access application scoped to the `/mcp` path**, rather than enabling
Managed OAuth on the whole `<your-host>` app. Two reasons: the dashboard's browser
session behavior stays exactly as it is today, and the MCP surface gets its own policy, its own
session duration, and its own audit trail that you can revoke without logging yourself out of
Totem.

Configuration (API form; the dashboard equivalent is Zero Trust → Access controls →
Applications → Advanced settings → Managed OAuth):

```jsonc
{
  "oauth_configuration": {
    "enabled": true,
    "dynamic_client_registration": {
      "enabled": true,             // ChatGPT requires DCR
      "allowed_uris": [
        // ChatGPT's connector redirect URI — read the exact value off the
        // ChatGPT connector setup screen; do not guess it.
        "https://chatgpt.com/*",
        "https://claude.ai/*"
      ]
    },
    "grant": {
      "access_token_lifetime": "5m",
      "session_duration": "24h"
    }
  }
}
```

`GET` the existing app config first and `PUT` it back whole — a partial `PUT` overwrites the rest
of the application.

### 4.3 What the bridge must still do

Access being in front is not sufficient. `bridge.mjs` listens on `localhost:8787` and is reachable
over Tailscale, so `/mcp` is bypassable from inside the tailnet. The bridge validates independently:

1. If `Cf-Access-Jwt-Assertion` is present → verify it properly:
   - signature against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (JWKS,
     cached with a TTL, refetched on unknown `kid`),
   - `aud` equals the MCP application's AUD tag,
   - `iss`, `exp`, `nbf`,
   - `email` equals the single allowed identity.
   Node's built-in `crypto` verifies RS256 — this stays zero-dependency.
2. Else if `Authorization: Bearer <BRIDGE_SECRET>` matches → allow. This is the local/Tailscale
   path and how **Claude Code** connects (it can inject static headers; ChatGPT cannot).
3. Else → `401` with a `WWW-Authenticate` header. Do **not** fall through to the dashboard's
   `authorized()` behavior.

New env: `ACCESS_TEAM_DOMAIN`, `ACCESS_MCP_AUD`, `ACCESS_ALLOWED_EMAIL`. Add to `.env.example`.

Fail closed: if `ACCESS_MCP_AUD` is unset, refuse JWT auth entirely rather than accepting any JWT.

---

## 5. Self-description — "know everything about it, what it truly is"

An MCP client that only sees tool names doesn't understand Totem; it guesses. Three layers fix
that, and this is the highest-leverage part of the spec.

**Layer 1 — `instructions` at `initialize`.** Every client injects this into its system prompt.
Roughly 400 words, generated at startup, covering: what Totem is and where it runs; that reads
are direct and cheap so it should read freely; that writes are scoped and real; that anything
open-ended goes to a confirm-only queue and **will not happen until the owner approves it in the
dashboard**; the current local date + timezone; and the hard rule that it must never invent a
`P`-id or claim a proposal was actioned.

**Layer 2 — resources.** Read-only documents the client can pull on demand:

| URI | Source | Why |
|---|---|---|
| `totem://manual` | `AGENTS.md` | The full operating manual — the canonical "how it works". |
| `totem://overview` | `TOTEM-OVERVIEW.md` | The architecture and design-rationale doc. |
| `totem://state` | generated | Live snapshot: enabled providers, default provider/model, MCP connections + health, enabled schedulers, feature flags. |
| `totem://brain/{path}` | `data/brain/**` | Individual notes, via the existing `readBrainNote` path guard. |

`AGENTS.md` is 52 KB — serve it whole (clients chunk it themselves) but keep it out of
`instructions`.

**Layer 3 — the date table.** `buildPrompt()` already injects a 14-day weekday→ISO table because
that was the single biggest source of early mistakes. Cloud models have exactly the same problem
and no access to that prompt. Put the same table in `instructions`, and have every tool that
accepts a date echo back the resolved absolute date in its response so drift is visible.

---

## 6. Tool surface

Namespace with a `totem_` prefix — ChatGPT shows tools from all connectors in one list.

Every tool response is `content: [{type:"text", text: <compact JSON>}]`. Prefer compact JSON over
prose: the cloud model is the one doing the reasoning, so give it data, not sentences.

### 6.1 Reads — direct, no agent, no confirmation

Straight wrappers over functions that already exist in `bridge.mjs`.

| Tool | Args | Backed by |
|---|---|---|
| `totem_get_tasks` | `filter?`, `project?`, `includeCompleted?`, `days?` | `fetchTodos` / `fetchCompletedTodos` |
| `totem_get_projects` | — | `fetchProjects` |
| `totem_get_calendar` | `from?`, `to?`, `account?` | `/api/calendar` reader |
| `totem_get_habits` | `days?` | `readHabits` |
| `totem_get_inbox` | `state?: open\|all` | `readInboxItems` |
| `totem_search_brain` | `query`, `limit?` | brain index |
| `totem_read_note` | `path` | `readBrainNote` (keeps the `inbox-prompts/` guard) |
| `totem_get_repos` | `limit?` | `/api/github/repos` cache |
| `totem_get_usage` | `kind?: ai\|assistant\|activity` | `/api/ai-usage`, `/api/assistant-usage` |
| `totem_get_status` | — | providers, MCP health, schedulers, flags |

Two deliberate choices. `totem_search_brain` is search-first rather than list-everything —
a graph of notes blows the context window if dumped. And every read returns a `fetchedAt`
timestamp so the model can tell fresh data from something it saw earlier in the conversation.

### 6.2 Scoped writes — real, immediate, narrow — **BUILT**

Bounded operations with no interpretation left in them. Each maps to one existing writer.

| Tool | Args | Maps to |
|---|---|---|
| `totem_create_task` | `content`, `dueString?`, `due?`, `priority?`, `labels?`, `projectId?`, `description?` | `createTodo` |
| `totem_update_task` | `id`, `complete?`, fields | `updateTodo`, then `closeTodo` when `complete` |
| `totem_create_event` | `title`, `when`, `description?`, `account?` | `createCalendarEvent` |
| `totem_update_event` | `id`, `title`, `start`, `end`, `allDay?`, `location?`, `description?` | `updateCalendarEvent` |
| `totem_log_habit` | `id`, `date?`, `count?`, `delta?`, `complete?`, `note?`, `value?` | `logHabitRecord` |
| `totem_write_note` | `path`, `markdown`, `mode: append\|create` | `writeBrainNote`. **No overwrite** |

Guardrails, as shipped:

- **`totem_write_note` cannot overwrite.** `append` (creates if absent) and `create` (refuses if
  the path exists) only. Not a flag that defaults off — the mode simply does not exist, so a remote
  model clobbering the second brain is impossible rather than merely discouraged. Editing a note in
  place stays a dashboard/local-agent job.
- **Path confinement** reuses `readBrainNote`'s guard: inside `MEMORY_ROOT`, `.md` only, and
  `inbox.md` / `inbox-prompts/` excluded. Verified against both `../` traversal and `inbox.md`.
- **No deletes.** Not tasks, not habits, not notes, not events.

Three deviations from the original spec, all deliberate:

1. **`totem_complete_task` folded into `totem_update_task`** as a `complete` flag, to keep the tool
   count down. Fields are applied *before* the close, so a combined edit-and-complete is unambiguous.
2. **Calendar writes are in.** The spec deferred them on multi-account alias routing. That blocker
   turned out to be already solved: `totem_get_calendar` returns composite `account:eventId` ids
   and `updateCalendarEvent` resolves the account from them, so an edit round-trips to the right
   calendar without any new mapping. Verified create → update → delete across the `personal`
   account. Deletion is not exposed as a tool but is reachable through §6.5 if needed.
3. **`totem_resolve_inbox` is NOT built**, closing open item §9.3. Letting the cloud model approve
   proposals — including the escalations it staged itself — would defeat the confirm-only design in
   §6.3 and let it spend agent quota unattended. Approval stays in the dashboard.

**Known gap: no idempotency keys.** The spec called for an `idempotencyKey` on every write with a
TTL'd `data/mcp-idempotency.json` map. Not built. A cloud client that retries on timeout will
therefore create a duplicate task or a duplicate note block. This is the one specced guardrail that
is missing, and it is the most likely source of day-to-day annoyance.

### 6.3 Escalation — a prompt in the inbox, confirm-only — **BUILT, REDESIGNED**

The original design had `totem_escalate` run an agent *immediately* to author finished
`todo`/`calendar`/`github` proposals, then stage those. That is superseded. What shipped stages **the
prompt itself** as a new inbox kind, and the agent runs only after the owner accepts:

```jsonc
{
  "name": "totem_queue_prompt",
  "arguments": {
    "title":    "string, required — the line the owner sees in the inbox",
    "prompt":   "string, required — the full self-contained brief for the agent",
    "provider":  "codex | claude | cursor | opencode",   // required
    "model":     "string, optional — must be current; see the model gate below",
    "reasoning": "low | medium | high | xhigh | max | ultra — codex and claude only",
    "why":       "string, optional — why this needed a coding agent"
  }
}
```

Why this is better: nothing runs before the yes/no, so a bad escalation costs nothing, and the thing
the owner approves is the thing that will run rather than a summary of it. It also means `dryRun` is
unnecessary — staging *is* the dry run.

- **New inbox kind `prompt`**, destination "Agent run". Same `P<N>` sequence, same `- [ ]`/`- [x]`
  semantics, same file. The brief goes to `inbox-prompts/P<N>.md`; the details drop-down previews it
  along with the chosen provider and that provider's live login state.
- **Accepting** force-checks provider health, then runs `runAgent(brief, 'inbox', {provider, model})`
  **detached** — the HTTP resolve returns `started on codex/gpt-5.6-sol (medium)` in milliseconds while the run
  continues. On completion the output lands in `inbox-prompts/P<N>-result.md` and raises a
  server-side notification; on failure the notification carries the error. Cursor's `cursorModel` vs
  everyone else's `bareModelId` quirk is handled inside the runner.
- **Staging is serialised** through the same queue as accept/deny, because both rewrite `inbox.md`
  and an append racing a resolve would drop one of the two edits.

#### The model gate

A cloud model asked to name a model id will name one from training, and those go stale faster than
anything else in this system. Codex does not reject a retired id in a way anyone notices either: it
returns a 400 for the turn, emits no assistant message, and **exits 0**. On 2026-09-08 that put P86
in the log as a successful 7-second agent run whose recorded output was the MCP auth warnings from
stderr, having built nothing.

So the id is never trusted:

- `listCodexModels()` reads `~/.codex/models_cache.json` — the catalog the CLI itself refreshes from
  the server — and keeps only `visibility: "list"` entries in the **newest generation** it
  advertises. That is Sol / Terra / Luna today and follows the CLI's own picker as models ship, with
  no code change. `CODEX_MODEL_ALLOWLIST` overrides it. Claude Code publishes no catalog, so its
  three aliases (`opus`, `fable`, `sonnet` → Opus 5, Fable 5.1, Sonnet 5) are seeded; aliases always
  resolve to the current version, so they never go stale either.
- `resolveModelChoice(provider, model, effort)` is the single gate. **Strict** for anything being
  staged or proposed: an unknown id throws with `validModels` attached, so the caller can retry in
  one round trip instead of getting a bare refusal. **Lenient** at run time (`runAgent`, the web
  chat, `startInboxPromptRun`): it falls back to the live default and logs, so a hand-edited or
  pre-gate inbox line still runs — and the run is labelled and recorded with the model that
  *actually* ran, not the one the line asked for.
- A saved model preference for an id no longer in a closed catalog is dropped from
  `listChatModels()`, so neither the Providers picker nor `totem_list_models` can offer it.
- Reasoning level rides alongside as `effort`: `-c model_reasoning_effort=` for codex, `--effort` for
  claude. It is validated against that specific model's `supported_reasoning_levels` (Luna has no
  `ultra`, for instance), defaults to the model's own default, and is written onto the inbox line so
  the approval names it.
- A run that finishes with no assistant message now **throws** rather than returning stderr as the
  reply. That is what made a failure look like a success; nothing else would have caught it.

### 6.4 Provider selection — usage-aware — **BUILT**

`totem_pick_provider` exists because "pick a provider" is otherwise a guess. It returns the owner's
priority order with live login health and live subscription headroom, and names a recommendation.
It also carries each provider's live model catalog with per-model reasoning levels, so the caller
can choose a model in the same round trip — a second call to learn the catalog is a call it would
skip in favour of guessing.
`totem_queue_prompt` re-checks the choice at stage time and **refuses** with the better provider
named rather than staging something that will fail on accept.

Priority: **codex → claude → cursor → opencode** by default. The order is a preference about
which subscription background work should spend first, not a judgement about capability; adjust
it to your own plans. Opencode is last and unmetered — it is also `runAgent`'s existing throttle
fallback.

- **`chatgpt` is an alias for `codex`**, along with `openai`, `gpt`, `anthropic`, `claude-code` and
  others. A cloud model calls itself ChatGPT and has no reason to know the CLI id; making it guess
  produced exactly the errors this alias table removes.
- **Headroom is the *binding* meter** — the tightest one — because a provider with 90% of its weekly
  budget and 2% of its 5-hour budget cannot take work now. `minRemainingPct` defaults to 20.
- **Model-scoped meters** (Claude's "7-day Fable") gate one model, not the provider, so they are
  reported but never gate. Reported under `scopedMeters`.
- **An unreadable quota is not free quota.** The usage poller returning HTTP 429 is a poller
  failure, not an exhausted plan, so the provider stays eligible — stranding work on a poller hiccup
  would be worse — but the candidate is flagged `quotaUnknown` with a note saying so, rather than
  silently reading as healthy.
- Health is **force-checked**, never served from the 10-minute cache. A stale "ready" is the wrong
  thing to spend an agent run on.

### 6.5 The other wired connections — **BUILT**

Totem is already an MCP *client* to Google Calendar, Plaud, GitHub and Vercel via
`mcp-gateway.mjs`. The same `Gateway` class now runs in-process inside the bridge, so an external
client reaches all of them through this one connection.

| Tool | Does |
|---|---|
| `totem_list_connections` | Servers + health + tool **names**. With `{server}`, that server's full input schemas. `{refresh:true}` reconnects. |
| `totem_call_connection` | `{server, tool, arguments}` → dispatched downstream. Accepts an already-namespaced `server__tool` too. |

**Progressive discovery, not aggregation.** The downstreams currently expose ~146 tools. Merging
them into `tools/list` would hand a cloud model 146 schemas on every connection — more context than
the entire rest of this server — so the listing returns names first and schemas only for the server
asked about. An unknown tool name comes back with that server's real tool list attached, so a wrong
guess self-corrects in one round trip.

The pool is cached for 10 minutes and swapped-then-closed on refresh, so a concurrent call never
lands on a gateway whose child processes have just been killed. Gated on `mcpMode === 'gateway'`;
with MCP off, both tools say so instead of failing obscurely.

### 6.6 Acting on the inbox, and the audit trail — **BUILT**

§6.2 shipped without `totem_resolve_inbox` on the grounds that letting the model
approve its own escalations defeats the confirm-only design. That is now built, but
with the approval moved out of the model's reach rather than trusted to it. Full
design in **`docs/logs.md`**; the short version:

| Tool | Does |
|---|---|
| `totem_propose_command` | Stages a shell command as a new `command` inbox kind. Does not run it |
| `totem_request_approval` | Requests a conversation lease. Returns a random `approvalSessionId`, `pending`, and **no code** |
| `totem_check_approval` | Polls that `approvalSessionId` for his decision |
| `totem_resolve_inbox` | Accept/deny with the reusable `approvalSessionId`; refuses unless its lease is active |
| `totem_read_logs` | The action log, filterable, `correlationId` to follow one chain |
| `totem_get_output` | stdout/stderr/exit code of a command that ran |

The reason this is not just an instruction: **a tool call is the action.** There is
no moment between "the model decided" and "it happened" in which prose can
intervene. So the lease is created pending and carries a one-time activation code
that goes only to the owner. After approval, the requesting client may reuse its random
`approvalSessionId` for any number of staged inbox actions. Every authorized use
atomically increments `useCount` and moves the inactivity deadline one hour ahead;
one quiet hour or manual revocation ends the lease permanently. `Mcp-Session-Id`
is transport metadata, not this trust boundary. `logs/approvals.test.mjs` and
`logs/approval-controller.test.mjs` specify the state machine and real resolution
path.

Both `totem_queue_prompt` and `totem_propose_command` now **require** an
`explanation` and a `why`, rejected below 8 characters. These are not metadata:
they are rendered as the body of the approval card, above the buttons. Denying
needs approval too, because quietly clearing the queue loses work as surely as
accepting the wrong thing.

Commands are screened by a refusal list (privilege escalation, filesystem
destruction, piping the internet into a shell, credential exfiltration, force-push,
history erasure) at **both** stage and accept time. Those cannot be staged at all.

The lease does not make inbox resolution idempotent. The inbox still owns that:
once a proposal is resolved it is no longer open, so a retry cannot run it again.
The additive writes in §6.2 are still unprotected; see §9.6.

### 6.8 Tool annotations and output schemas — **BUILT**

Every MCP client applies **pessimistic defaults** to any hint a server omits:
`readOnlyHint` defaults false, `destructiveHint` true, `openWorldHint` true. We
declared none, so ChatGPT rendered `totem_get_projects` — a two-line read — as
**PUBLIC WRITE · OPEN WORLD · DESTRUCTIVE · OUTPUT SCHEMA RECOMMENDED**. That was
not a client bug; it was the spec's fail-safe behaviour meeting a server that said
nothing about itself.

All 27 tools now carry a `title`, all four annotation hints stated explicitly, and
an `outputSchema`. The classification lives in one table, `MCP_TOOL_META`, so the
whole safety matrix is reviewable as a unit rather than scattered across 27
literals.

| Preset | readOnly | destructive | idempotent | openWorld | Used by |
|---|---|---|---|---|---|
| `readLocal` | ✔ | ✘ | ✔ | ✘ | habits, brain, inbox, logs, outputs, status, usage, models, approvals |
| `readRemote` | ✔ | ✘ | ✔ | ✔ | tasks, calendar, projects, repos, connections |
| `addRemote` | ✘ | ✘ | ✘ | ✔ | `create_task`, `create_event` |
| `editRemote` | ✘ | ✔ | ✔ | ✔ | `update_task`, `update_event` |
| `appendLocal` | ✘ | ✘ | ✘ | ✘ | `write_note` |
| `editLocal` | ✘ | ✔ | ✘ | ✘ | `log_habit` |
| `stageLocal` | ✘ | ✘ | ✘ | ✘ | `queue_prompt`, `propose_command` |

Three tools are marked individually because no preset fits:

- **`request_approval`** — writes (a lease), but **idempotent** for an identical
  pending request from the same client, which returns the existing lease instead
  of asking the owner twice. That is real behaviour, not a hint.
- **`resolve_inbox`** — `destructive` and `openWorld`, because accepting is the
  moment the real world changes: it files the issue, runs the command, starts the
  agent. The reusable lease does not change the proposal's non-idempotent nature.
- **`call_connection`** — the downstream tool is unknowable from here and many of
  them write, so it is marked as the most dangerous thing it could be.

Two judgement calls worth recording:

- **`write_note` is non-destructive**, honestly, because overwrite is not a mode
  that exists (§6.2). The no-overwrite decision pays off twice: once in safety,
  once in the tool not having to warn about something it cannot do.
- **`openWorldHint` tracks "does this leave the box"**, not "is the entity set
  unbounded". Reading a configured third-party connection is `openWorld: true`,
  while local tasks, habits, and brain notes are false.

**Declaring an `outputSchema` obliges the server to conform to it** — the spec's
wording is MUST. `mcpResult` therefore returns `structuredContent` alongside the
existing serialised-JSON text block (kept for backwards compatibility, and built
from the same object so the two cannot drift). Schemas describe third-party object
shapes but leave them open rather than pinning fields we do not control; the only
universally required field is `fetchedAt`, which `mcpResult` always stamps.

Validating real results against the declared schemas caught two lies immediately,
which is the argument for doing it rather than eyeballing:

1. `list_models` returns `models` as an **array**; the schema said object.
2. `update_task` returns `todo: null` when only completing — the description even
   said so, while the type said `object`.

A **boot assertion** enforces the contract: the bridge refuses to start if a tool
has no entry, is missing any of the four hints, claims to be both read-only and
destructive, or declares an `outputSchema` that does not require `fetchedAt`. A
test would be weaker, because the failure mode here is silent — an unclassified
tool just quietly inherits the scary defaults.

### 6.9 Strava — **BUILT** (2026-09-07)

Thirteen `totem_strava_*` tools expose the Strava connector (`strava/client.mjs`, full write-up
in `docs/strava.md`). They exist here rather than behind `totem_call_connection` because Strava is
not an MCP server of its own: the bridge holds the grant, so the bridge is the server.

| Tool | Preset | Does |
|---|---|---|
| `totem_strava_get_status` | `readLocal` | connected / as whom / scopes / rate-limit headroom / cache state |
| `totem_strava_get_athlete` | `readRemote` | profile + bikes/shoes with odometers + Strava's 4-week/YTD/all-time totals (+ zones on request) |
| `totem_strava_get_activities` | `readRemote` | the list, windowed and sport-filtered; `source: cache` reads the mirror |
| `totem_strava_get_activity` | `readRemote` | one activity in full; laps / zones / efforts / streams / comments / kudos opt-in |
| `totem_strava_get_gear` | `readRemote` | bikes and shoes — "miles on my bike" lives here |
| `totem_strava_get_mileage` | `readLocal` | roll-ups by day/week/month/year/sport/family/gear/all from the cache (refreshes if > 30 min) |
| `totem_strava_get_routes` / `_segments` / `_clubs` | `readRemote` | the rest of the API |
| `totem_strava_update_activity` | `editRemote` | rename / describe / re-gear / commute / trainer / hide |
| `totem_strava_create_activity` | `addRemote` | a manual activity |
| `totem_strava_update_athlete` | `editRemote` | weight |
| `totem_strava_sync` | custom: not read-only, not destructive, idempotent, open-world | refresh the local mirror; `full` is resumable |

Two decisions worth recording. **`get_mileage` is `readLocal`** even though it may trigger a sync:
the sync is best-effort and the answer comes from disk either way, and marking it open-world would
make the cheapest, most-called fitness tool look like the one that spends budget. **Every
quantity is in both unit systems** and the `instructions` FITNESS paragraph tells the model to
quote miles/mph/feet unless asked, because a cloud model doing its own metre→mile arithmetic is a
new place for it to be wrong. `totem://state` gained a `fitness` block naming the WHOOP and Strava
states and tool lists. `serverInfo.version` is **2.1.0**.

### 6.9b Goals — **BUILT**

Fifteen tools (`totem_get_goals`, `totem_create_goals`, `totem_log_goal_metric`, …) covering the
whole surface, because MCP is a *primary* write path for goals rather than a mirror of the UI: the
authoring case is a model reading a photo of a paper notebook, unattended. Three affordances exist
for exactly that. `totem_create_goals` takes a **whole period in one call** with steps and metrics
nested inline and reports per-row failures rather than refusing the batch. **Periods are named
shortcuts** (`this_week`, `next_week`, …) resolved from the server's clock, so a model never has to
know today's date, the week-start convention and the timezone and get all three right.
**`clientKey`** makes re-running the same import an update instead of a silently doubled week.

The annotations are the inverse of the task tools, deliberately: a goal *write* never leaves the
box (`openWorldHint: false`), while a goal *read* can reach Strava to resolve a connector-fed
metric, so the reads are the open ones.

Three rules are stated in the `instructions` block rather than left to inference, because each one
is a thing a helpful model would otherwise get wrong: completion is the owner's to assert and is never
implied by a full bar; postponing increments a counter that is never reset and must not move
without him asking; and `available:false` is an unreadable connector, not zero progress.
`totem://state` gained a `goals` block with counts and the tool list. `totem_update_goal`'s
`abandoned` takes a step id as well as a goal's — a step decided against leaves the steps count
rather than reading as undone, so a goal that landed with one add-on he never got to can still be
100%. A **step holds numbers of its own**, several at once: `totem_add_goal_metric` takes a step id
(`subGoals[].id`) exactly as it takes a goal's, `totem_add_goal_step` carries the numbers in with
the step, and `rollsUpTo` resolves against the parent's existing labels on both — where it used to be
accepted and silently dropped. A step with numbers counts how far through them it is, so the goal
moves as they are logged rather than only when the step is ticked. `serverInfo.version` is
**2.8.0**, and the gateway's is **1.3.0** — a client holding the old list has no way to know any of
these exist, which is what those fields are for.

### 6.9c Lists — **BUILT**

Nine tools expose lightweight checklists end to end: `totem_get_lists`, list
create/update/delete, bulk item add, item update/delete, and todo link/unlink. Create accepts a
whole grocery or packing list in one call, while item update is the small frequent path for
checking something off. `list_todos` is relational only: an item and a task never complete one
another. All reads and writes stay in local SQLite (`openWorldHint: false`), and service-owned
action logging records each mutation once. The same tools are available to local agents under the
gateway's `lists__*` namespace.

### 6.10 Versioning and protocol negotiation — **BUILT**

`serverInfo.version` is **2.9.0**. 2.9.0 renamed the field that carries a sentence for the
owner — on `totem_request_approval`, `totem_resolve_inbox` and `totem_queue_prompt` — to
**`tellOwner`**. The old name, `tellEthan`, is still sent with the same value as a deprecated
alias so existing clients keep working; read `tellOwner`. The version tracks this server's surface,
not the app's `package.json` (still 1.0.0, and a separate concern): 11 read-only
tools became 27 covering writes, a proposal queue, shell commands behind an
approval gate, and the audit trail. A client holding 1.0.0's tool list is looking
at a materially different server, and this is the field that says so. `title` was
added alongside it for display.

**A version bump does not invalidate any client's cache.** `serverInfo` is
informational; no client keys its tool cache on it, and ChatGPT's is keyed on the
connector. Re-syncing the connector remains the only way to pick up new tools.

Negotiation was also wrong. The code read:

```js
protocolVersion: params?.protocolVersion || MCP_PROTOCOL_VERSION,
```

with a comment claiming it echoed the client's revision "when we can speak it" —
but nothing checked. A client negotiating `2026-07-28` was told we speak it. Now
`MCP_SUPPORTED_PROTOCOLS` holds the revisions actually implemented
(`2025-06-18`, `2025-03-26`, `2024-11-05`); anything else negotiates down to
`2025-06-18` and logs that it did. `2026-07-28` is deliberately absent — parts of
it are unverified here, and claiming an unimplemented revision is worse than
negotiating down to one that works.

### 6.11 Explicitly not built

| Not built | Why |
|---|---|
| `totem_shell` / `gh` passthrough | The blast-radius section of the overview exists for a reason. Escalation gets shell access *behind* a confirmation; the cloud model doesn't get it directly. |
| Chat proxy / thread tools | You don't want a chat interface, and this would rebuild one. |
| Provider/MCP config writes | Remote reconfiguration of the agent backend is a foothold, not a feature. Dashboard only. |
| ~~`totem_resolve_inbox`~~ | **Now built** behind an out-of-band approval gate. See §6.6. |
| Deletes of any kind | Route through the dashboard, or `totem_call_connection` where the downstream offers it. |
| Idempotency keys | Specced, not built for additive writes. See §6.2. Note `update_task`/`update_event` are marked `idempotentHint: true`, so a retry is safe there. |

---

## 7. Observability

- Add `mcp` to `USAGE_CHANNELS` so the Usage tab counts it alongside `http` / `web` / `morning` /
  `journal` / `plaud-meetings`. This answers "am I actually using the connector" with data.
- Log every `tools/call` to `data/assistant-usage.jsonl`: tool name, client name from
  `initialize`'s `clientInfo`, duration, ok/error. Arguments are **not** logged verbatim — they
  contain personal content; log a length and a short redacted preview, reusing the existing
  redaction helper (`bridge.mjs:391`).
- Surface connector health in the dashboard's Connections view: last call, tool call counts,
  whether Managed OAuth is currently answering.

---

## 8. Build order

Each phase is independently useful and independently testable.

**Phase 1 — protocol, locally.** `POST /mcp` with bearer auth only, `initialize` / `tools/list` /
`tools/call`, and three read tools. Test with Claude Code over Tailscale (it can send static
headers). No Cloudflare changes yet. This proves the framing before auth is in the way.

**Phase 2 — self-description.** `instructions`, the resources, the date table, `totem_get_status`,
`totem_list_models`. Test by asking Claude Code "what is Totem and what can you do with it" and
reading the answer critically — if it's wrong or vague, the `instructions` block is wrong.

**Phase 3 — remaining reads + Access JWT validation.** Full read surface. Add JWKS verification,
still reachable by bearer for local clients.

**Phase 4 — go public.** Create the `/mcp`-scoped Access application, enable Managed OAuth + DCR,
add the connector in ChatGPT developer mode. Verify a `401` + `WWW-Authenticate` (not a `302`) is
what an unauthenticated cloud client sees. **This is the phase most likely to need iteration** —
the DCR `allowed_uris` value must come off ChatGPT's actual connector screen.

**Phase 5 — scoped writes. DONE**, with the no-overwrite guard from day one. Idempotency keys were
dropped from the phase and are still outstanding; see §6.2.

**Phase 6 — escalation. DONE**, but redesigned: `totem_queue_prompt` stages the prompt itself as a
new inbox kind and runs it on accept, which makes `dryRun` unnecessary. Shipped alongside
`totem_pick_provider` (§6.4) and the connection pass-through (§6.5), neither of which was in the
original phasing.

Per the standing rule in `AGENTS.md`: every phase updates `AGENTS.md` in the same commit, and §9's
roadmap gets a line for this.

---

## 9. Open items

1. **`allowed_uris` for DCR** — must be read off ChatGPT's connector setup screen at build time.
   Guessing produces a redirect-URI mismatch that looks like a generic connection failure.
2. **Access AUD tag** — created with the new `/mcp` application; unknown until then.
3. ~~**`totem_resolve_inbox`**~~ — **decided: omitted.** Approval stays in the dashboard, so the
   model cannot approve its own escalations. §6.2.
6. **Idempotency keys** — still missing for the *additive* writes in §6.2, so a cloud client retrying
   on timeout will duplicate a task or a note block. Inbox proposals are removed when resolved, so a
   retried accept finds no open proposal even though its approval lease remains active. §6.6.
7. **Approval fatigue.** The gate is only as good as the reading. If approval cards start getting
   waved through, the honest fix is fewer proposals, not a weaker gate.
4. **ChatGPT connector review** — some connectors are rejected at add-time with
   "connector is not safe". If that fires, the fallback is Claude.ai first, which is less strict.
5. **Whether reads should also be gated.** This spec lets the cloud model read your entire second
   brain, calendar, and task list. That's the point, but it means the content lands in ChatGPT's
   conversation history and retention. Worth deciding deliberately rather than discovering later.
