# Recommendations

A ledger of what agents recommend, in Productivity → Recs (web and iPhone app).

When an agent tells the owner to do something (buy a thing, try a habit, change a
routine), it records the recommendation with its evidence and any cost. The owner decides it
in the dashboard: accept, decline or defer. An accepted one later gets a measured outcome.
Agents read the ledger before recommending, so they stop suggesting what the owner has
already declined, and can quote their own track record.

## The rules that matter

**No agent tool can decide.** An agent can record a recommendation and report its outcome;
it cannot accept, decline or defer one. `recs/service.mjs` refuses a decision unless the
call carries `via: 'dashboard'`, which only the HTTP adapter (`recs/http.mjs`) sets, and
`recs__record` refuses a `decision` field outright rather than ignoring it. That adapter is
behind the dashboard's sign-in, which also admits the `BRIDGE_SECRET` bearer (the iPhone app
uses it). So whoever holds `BRIDGE_SECRET` can decide, including an agent able to read
`.env`. Every decision is logged as the owner (`actor` is `OWNER_ACTOR` from `logs/store.mjs`)
with how it was authenticated in `detail.auth`: `session`, `bearer` or `proxy`.

**A recent decline is not suggested again unless something changed.** `recs__record`
refuses a recommendation like one the owner declined in the last 30 days, naming it and his
note, unless the call passes `changed` (what is different now). That note is stored and
shown on the card. It also refuses a duplicate of one still open (pending, deferred or
accepted: same direction, same subject terms), and returns the similar open ones as
`openSimilar`. The check runs before anything is written, so a refusal leaves nothing for
the owner to decline twice.

**The rule is in the instructions.** `recPromptRule` (`recs/mcp.mjs`) is in the gateway's
instructions (`recs__*`) and in the bridge's `/mcp` instructions (`totem_recs_*`): check the
ledger before recommending, and don't suggest again what was declined in the last 30 days
unless circumstances changed, then say what changed.

**A deferral comes back on its day, on the job tick.** Deferring takes `deferDays` (1–365);
the bridge turns it into `reviewOn` in its own time zone (`MORNING_BRIEFING_TZ`), so a device
in another zone cannot name a day that is already the bridge's today. On that day the
bridge's 30-second job tick (`resurfaceDeferredRecs`) puts each due rec back to pending,
stamps `resurfacedAt`, and sends it its own `rec.review` notification. A failed notification
is logged and costs only its own push; the rec is pending either way. There is no second
scheduler.

**Only an accepted recommendation has an outcome, and the owner's is final.** `worked`,
`partly` or `failed`, with a note. `outcomeBy` records who reported it: an agent's report is
labelled as such, and an agent cannot overwrite one the owner set. Moving an accepted rec
to another decision drops its outcome.

**Every write is audited once, in the service** (`rec.record`, `rec.decide`, `rec.outcome`,
`rec.resurface`).

## Fields

`id`, `title`, `body`, `evidence`, `costUsd`, `source` (`chat:<id>`, `totem:<id>`, or `owner`),
`createdAt`, `actBy` (YYYY-MM-DD after which it is no longer worth doing), `decision`
(`pending`, `accepted`, `declined`, `deferred`) with `decidedAt` and `decisionNote`,
`reviewOn` (the day a deferral comes back; set only by deferring), `outcome` with
`outcomeNote`, `outcomeAt` and `outcomeBy`, `changedNote`, and `resurfacedAt`.

## Hit rate

`stats` comes with every read. The hit rate is accepted recommendations measured as
`worked`, out of all measured; `partly` is shown beside it but is not a hit, and outcomes
agents reported are counted out loud. `stats.line` is the one line both views and agents
quote:

> 3 of 5 measured worked (60%), 1 partly, 2 reported by agents · 8 of 12 accepted · $140 committed · 2 waiting

## Similarity

Keyword overlap, no model. Words of two or more characters (so "D3" counts), folded:
plurals (`-s`, `-es`, `-ies`), `-ing` ("drinking" is "drink"), and a small list of common
rewordings (jog → run, cycling → bike, adjustable → standing). Filler and verbs like "buy",
"try" and "get" are dropped. Direction words (start, stop, increase, reduce, quit, keep, …)
are not subject terms, and two recommendations pointing opposite ways never match: "stop
taking vitamin D3" is not "start taking vitamin D3". "Lower" and "upper" are not direction
words; they name things ("lower body").

A match needs two shared subject terms, or the only one when the query has a single term.
It is ruled out when the query and the recommendation's title differ by exactly one swapped
detail: "lower body workout" is not "upper body workout", nor a 5k a 10k. The score is the
overlap measured against both sides, so one shared word in a long recommendation scores low.
Close paraphrases beyond the fold are left to the agent reading `recs__list`.

## Storage

The `recs` table in the task database (`data/todos.db`), added by migration 010. It lives
there, not in a file of its own, because it is the same kind of record as a task or a goal
and should be backed up, exported and restored with them. The export format is 4; a
format 3 export (taken before the table existed) still restores, with no recommendations.

## Surfaces

| Where | What |
|---|---|
| `GET /api/recs/ledger` | What the views show: `open` (every pending and deferred rec, never paged), one page of decided `history` (newest decision first; `limit`, and `before` from the last page's `nextBefore`), and `stats`. |
| `GET /api/recs` | Filtered reads: `?decision=` (repeatable), `source`, `similarTo`, `declinedWithinDays`, `limit`. Returns `{ recs, count, stats }`. |
| `POST /api/recs` | Record one as the owner (`source` defaults to `owner`; the recent-decline check does not apply). |
| `POST /api/recs/:id/decision` | `{ decision, note?, deferDays? }`. The only way to decide. |
| `POST /api/recs/:id/outcome` | `{ outcome, note? }`, as the owner. |
| `recs__record` | Gateway tool (`totem_recs_record` on `/mcp`). |
| `recs__list` | Gateway tool; `id` for one, or the filters above. |
| `recs__set_outcome` | Gateway tool; accepted recommendations only, reported as the agent's. |
