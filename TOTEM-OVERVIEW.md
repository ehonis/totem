# Totem — What It Is and How I Use It

A shareable overview of my self-hosted personal assistant. Written for someone who wants to
build the same thing for themselves. No secrets, hostnames, or personal data here — every
account, path, and location below is a placeholder you'd fill in with your own.

---

## 1. The one-paragraph version

Totem is a personal assistant that runs 24/7 on a Linux box I own. I talk to it from my
phone (Action Button → dictate a sentence) or from a web dashboard on any device. It acts on
my behalf against my real accounts — task manager, calendar, code repos, a private notes
"second brain," and a habit tracker — and replies in plain text. There is no hosted service
in the middle: the box is reachable only over a private Tailscale network, authenticated with
a single bearer token. The "intelligence" is whichever coding-agent CLI I already pay for
(Cursor, Codex, Claude Code, or OpenCode), shelled out to per request, so there's no separate
API bill.

The important design idea: **it's a thin, boring bridge around agent CLIs I already have.**
The bridge is a single zero-dependency Node file. Everything expensive is a subscription I
was already buying.

---

## 2. Architecture

```
Phone (Action Button / Back Tap / Shortcut — type or dictate)
   │
   │  HTTPS POST over Tailscale, Authorization: Bearer <token>
   ▼
bridge  (single Node process on my Linux box, port 8787)
   │
   ├── serves the React web dashboard (chat + data views)
   ├── serves /api/* endpoints that read data DIRECTLY (no agent round-trip)
   │
   └── runAgent(): spawns the configured agent CLI as a subprocess
          cursor-agent -p  /  codex exec  /  claude -p  /  opencode run
             ├── task manager      (MCP)
             ├── calendar          (MCP)
             ├── voice recorder    (remote MCP)
             ├── notes / "brain"   (local Markdown + git)
             └── code repos        (shell + gh CLI)
   │
   ▼
plain-text reply → shown or spoken on the phone, or streamed into the web chat
```

Two front doors, one brain:

| Front door | Used for | Format |
|---|---|---|
| `POST /ask-text` | iOS Shortcut, quick captures, hands-free | plain text (no Markdown — it gets read aloud or shown in a popup) |
| Web dashboard | Follow-ups, browsing data, longer work | Markdown, streaming, with a live activity feed |

Everything else (scheduled jobs, briefings) runs on the same code path.

### Components

| Thing | What it is |
|---|---|
| `bridge.mjs` | The whole backend. Node ≥20, **zero npm dependencies**. HTTP endpoints, static file serving, schedulers, direct API clients. |
| `web/` | Vite + React + TypeScript + Tailwind dashboard, built to static files the bridge serves. |
| systemd **user** service | Keeps the bridge running, with lingering enabled so it boots without a login. |
| `.env` | All secrets and config. Loaded with `node --env-file=.env`. Gitignored. |
| `data/` | All runtime state — JSON files and append-only JSONL logs. Entirely gitignored. |
| MCP manifest | One canonical list of MCP servers that gets synced into each agent CLI's own config format. |

### Why an agent CLI instead of an API key

Cursor / Codex / Claude Code / OpenCode subscriptions include a headless mode
(`-p`, `exec`, `run`). Shelling out to those means:

- **No metered API bill.** I use the seat I already pay for.
- **MCP servers come free.** The CLI already knows how to speak MCP, so connecting a task
  manager or calendar is a config file, not code I have to write.
- **Swappable.** The dashboard has a Providers tab; changing the default provider takes
  effect on the next request with no restart. If one vendor gets slow or expensive, I switch.

The tradeoff: latency is whatever the CLI does (roughly 5–8 seconds round trip on a fast
model), and token streaming only works on providers that emit structured streaming output.

---

## 3. How I actually use it, day to day

This is the honest list — the features that survived contact with real use.

### Morning
A scheduled job generates a briefing once per local day at a set time. It reads my tasks,
both calendars, repo activity, weather (direct Open-Meteo call, no key), and a couple of news
headlines (Google News RSS, no key), and writes a short numbered summary. It's explicitly
forbidden from modifying anything. I read it on my phone or in the app when I get up. It
doesn't push a notification — it's there when I want it.

### Throughout the day — capture
This is the highest-value thing by far. Action Button → dictate → done:

> "Add a task to send the updated deck Friday morning, high priority"
> "What's on my calendar Thursday?"
> "Move my 2pm to 3:30"
> "What did I say I'd do about the vendor contract?"

It resolves relative dates ("this Thursday," "next week") against an explicit date table
injected into every prompt, because that was the single biggest source of early mistakes.
Replies come back as plain text and get shown or spoken.

If a request is genuinely ambiguous, it doesn't ask a question on the phone (a Shortcut popup
is a terrible place for a conversation). Instead it returns a link that opens a pre-loaded
chat thread in the web app with the original request and its question, so I can finish there.

### Throughout the day — the dashboard
Opened on a laptop or phone browser over the private network. Tabs:

- **Chat** — streaming conversation with the agent, with a live redacted feed of what commands
  it's running. Slash commands for common jobs, `$` commands for workflows.
- **Productivity** — tasks, calendar, and habits as three sub-apps.
- **Brain** — a force-directed graph of my private notes, built from folders, tags, and
  wiki-links.
- **Inbox** — confirm/deny queue (see below).
- **Code** — every repo I can reach, most-recently-pushed first.
- **Usage** — how much of each AI subscription's quota I've burned, with live meter bars, plus
  a "am I actually using this thing" chart of objects created and completed through Totem.
- **Settings / Providers / Connections** — switch agent backends, manage MCP servers.

The dashboard reads data **directly** — no agent round-trip — so pages load instantly. The
agent is only invoked for chat and for genuinely open-ended requests.

### Evening — habits
An in-house habit tracker, because I wanted GitHub-style contribution grids and full local
ownership. One JSON file is the single source of truth, with two front doors into it: the
app's check-in list (one tap per habit, +/- steppers for multi-count ones, per-day notes), and
just telling Totem "I read and hit the gym today." Habits support daily, weekly, or monthly
cadences — a gym habit is "3 per week," so the grid and streak math work on weeks, not days.

### Overnight — journal ingest
I own a small voice recorder that exposes a remote MCP server. Every night I talk through my
day into it. A scheduled job finds recordings since a stored watermark, keeps **only** my solo
journal entries (filtering out meetings and calls by speaker pattern and title), folds durable
facts into the notes repo, and stages any action items as a confirm-only checklist.

It never creates tasks or events on its own. The next morning's briefing surfaces the
proposals with stable IDs, and I reply "confirm 1, 3 / skip 2." That confirm-only design was
deliberate: an agent that silently creates tasks from ambient speech is a nightmare.

---

## 4. The parts worth stealing

If you build your own version, these are the decisions I'd repeat.

**Direct reads, agent writes.** Anything the dashboard shows is fetched by the bridge from the
real API. The agent is never in the read path. This is the difference between a dashboard that
loads in 200ms and one that takes 8 seconds and sometimes hallucinates.

**Inject a date table into every prompt.** Models are bad at "next Thursday." Every prompt gets
the current local date/time plus a 14-day weekday→ISO-date table and an instruction to verify
the pair before writing anything dated. This fixed nearly all date bugs.

**Channel-aware prompting.** A request carries a channel. Phone requests get rules saying
"finish the job, prefer sensible defaults, never ask questions, plain text only." Web requests
get "Markdown is fine, follow-up questions are fine." Same agent, different contract.

**One file per store, normalized on read.** Habits, provider config, and threads are each a
JSON file written atomically (temp file + rename). Because the agent is allowed to hand-edit
some of them, every read coerces and clamps every field rather than trusting the contents. It's
survived a lot of malformed writes.

**Confirm-only for anything inferred.** Anything derived from ambient input (voice notes) gets
staged for a yes/no, never actioned directly. The corollary: **do the work before the yes/no,
not after.** A proposal to file a GitHub issue stores the finished issue text, and the inbox card
shows exactly that plus the command it will run — so accepting is a single API call with nothing
left to interpret, and denying costs nothing but the staging.

**Track your own usage.** An append-only log of every request, plus every object created or
completed, answers "is this worth maintaining?" with data instead of vibes.

---

## 5. What you'd need to build the same

### Hardware / network
- **An always-on Linux machine.** A spare desktop, a NUC, an old laptop, a small VPS. Mine
  is a desktop that was already sitting there. Requirements are trivial — it's a Node process.
- **Tailscale** (free tier is plenty) on the box and on your phone. This is the whole security
  story: the bridge is never exposed to the public internet, and the phone reaches it over the
  private tailnet. Do not skip this and port-forward instead.

### Software
- Node ≥20 on the box.
- **At least one agent CLI you're already paying for**, authenticated headlessly:
  `cursor-agent`, `codex`, `claude`, or `opencode`. Verify it works non-interactively before
  building anything else — that's step one for a reason.
- MCP servers for whatever you want it to touch. Task manager and calendar are the two that
  matter. Most are one `npx` line in a config file.

### Accounts
- Your task manager's API token.
- A Google Cloud OAuth desktop client if you want calendar access (free; note the caveat below).
- A GitHub CLI login if you want repo access.

### Cost
Effectively zero beyond subscriptions I already had. No hosted database, no API keys with
meters, no paid services anywhere in the stack. Weather and news are free public endpoints
called directly.

### Effort
The bridge is one large file. If you're comfortable with Node and HTTP, a useful Phase 1
(bridge + Shortcut + task manager) is a weekend. Everything after that was incremental — I
added the calendar, the dashboard, habits, and the journal ingest one at a time over a couple
of months.

---

## 6. Setup outline

Phased so you're never blocked on the whole thing working.

**Phase 1 — talk to it.**
1. Generate a bearer secret (`openssl rand -hex 24`), put it in `.env`.
2. Verify one agent CLI runs headless: `<cli> "say hello in 3 words"`.
3. Run the bridge in the foreground, hit `/health`, then `/ask-text` with curl.
4. Bring up Tailscale on the box and phone.
5. Build the iOS Shortcut: **Ask for Input** (text — the keyboard mic key gives you dictation
   for free) → **Get Contents of URL** (POST to `http://<tailscale-name>:8787/ask-text`, with
   an `Authorization: Bearer <secret>` header and a JSON body) → **Show Result** or **Speak
   Text**. Assign it to the Action Button and/or a Back Tap.
6. Install as a systemd user service and enable lingering so it survives reboots.

**Phase 2 — give it hands.** Add MCP servers for your task manager and calendar. Verify each
CLI can actually see the tools before assuming the agent can use them.

**Phase 3 — the dashboard and the scheduled jobs.** Everything else is optional and additive.

---

## 7. Known gotchas

These cost me real time. In rough order of how annoying they were.

- **systemd's PATH is not your shell's PATH.** The service starts fine and then every request
  fails "command not found," because `~/.local/bin` and the nvm bin directory aren't there.
  Set `Environment=PATH=…` explicitly in the unit file and pin the Node version in `ExecStart`.

- **OAuth callbacks want to land on localhost — the box's localhost.** Any MCP server using
  OAuth will open a browser and expect a redirect to `127.0.0.1`. If you approve it on your
  phone, that callback goes nowhere. You need a browser running on the box, or an SSH tunnel
  from your laptop. Worse, one of mine wanted the *same port* the bridge uses, so I have to
  stop the service to complete its login. Build a "paste the failed callback URL here and I'll
  replay it locally" helper — I did, and it's saved me repeatedly.

- **MCP sync is config, not shared auth.** You can write the same server definition into four
  CLIs' config files, but each keeps its own OAuth token store. Local servers with an env-var
  token work immediately; remote OAuth servers need a per-CLI login.

- **Google OAuth apps in "Testing" mode.** Only accounts listed as test users can authenticate,
  and refresh tokens expire on a timer while the app stays in testing. Push it to production
  once you're stable, or you'll be re-authenticating forever.

- **APIs get deprecated under you.** One vendor's REST v2 started returning HTTP 410 mid-project
  and I had to move to their new paginated API, where a timed task's clock time is embedded in
  the date field rather than being its own property. Budget for this.

- **Date-only strings are a trap.** `new Date("2026-07-28")` parses as UTC midnight and renders
  a day early in any timezone behind UTC. Parse date-only strings manually into local
  components. This bit me in the UI, not the backend.

- **Blast radius is real.** The agent runs with full shell access and a GitHub CLI login. Anyone
  holding the bearer token can push code, open PRs, and run workflows on my behalf. That's an
  acceptable tradeoff for a single-user tool on a private network, and it's exactly why it's
  never publicly exposed. Decide this deliberately rather than discovering it later.

- **Volatile logs.** systemd's journal defaults to non-persistent storage, so there was nothing
  to backfill when I added usage tracking. If you want history, write your own append-only log
  from day one.

---

## 8. What I'd tell you before you start

**Start with capture, not chat.** The thing I use fifty times a week is "press a button, say a
sentence, it lands in the right place." The conversational dashboard is genuinely useful but
it's the second thing, not the first.

**Keep the agent out of the read path.** Every feature that made the agent responsible for
displaying data got slower and less trustworthy. Every feature where the bridge read the API
directly and the agent only handled writes got better.

**Don't let it act on inferences.** Confirm-only staging for anything derived rather than
explicitly requested. The one time I considered auto-creating tasks from voice transcripts, the
preview output convinced me otherwise within a day.

**Write the ops doc as you go.** I keep a single long operating manual in the repo with a rule
at the top: any change that alters behavior updates that file in the same commit. Six months in,
that file is the reason I can still safely change things — and it's what a coding agent reads
first when I ask it to extend the system.

**It's fine that it's one big file.** Zero dependencies means zero supply-chain surface, no
lockfile drift, and it still starts instantly. Reach for a framework when something actually
hurts.
