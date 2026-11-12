# Away spans

Trips and days off. Every prompt knows about them, the calendar shows them as a band, and
non-urgent notifications wait while the owner is away.

## The data

One small JSON file, `data/away.json` (`AWAY_FILE`), mode 0600:

```json
{ "spans": [
  { "id": "…", "start": "2026-11-02", "end": "2026-11-05", "label": "Lisbon", "kind": "trip",
    "note": "optional", "source": "owner", "createdAt": "…", "updatedAt": "…" }
] }
```

- `start` and `end` are **inclusive local day keys** in the owner's time zone
  (`MORNING_BRIEFING_TZ`), the same shape as a task's due date. A one-day span has
  `start === end`.
- `kind` is `trip`, `off` (a day off or holiday) or `other`.
- `source` is `owner` for a span added in the dashboard, or `inbox P12` for one an agent
  proposed and the owner accepted.

`away/store.mjs` keeps the spans in memory, because the date block is built synchronously
for every prompt, and checks the file's mtime and size on every read: a hand edit takes
effect without a restart, and a write is applied on top of it rather than over it. Each row
read from disk is validated like a new one (real dates from 1970 to 2199, end on or after
start, at most 366 days, a label, a known kind, an id); a row that fails is dropped and
logged. A file that no longer parses is treated as empty and is never overwritten; writes
fail until it is fixed. Writes go to a temp file and are renamed into place. The same days
under the same name (any case) are one span: a second create is refused with
`AWAY_DUPLICATE` (409). Every create, update and delete goes to the action log.

The file is the owner's, edited through the dashboard. Agents must not edit it; they
propose.

## Who can write

- **The owner**, from the Overview: the schedule card's band (or "Add time away") opens an
  editor (`web/src/components/AwayEditor.tsx`; the app's `features/overview/AwaySheet.tsx`).
  It calls `GET/POST /api/away` and `GET/PATCH/DELETE /api/away/:id` (`away/http.mjs`), behind
  the usual auth gate. `GET /api/away` leaves out spans that already ended unless it gets
  `?all=1` or `?from=YYYY-MM-DD`.
- **Agents only propose.** `totem_away_list` reads; `totem_away_propose` stages an `away`
  inbox item with the dates, a label and the evidence (`why`). The span exists only once the
  owner accepts it in the inbox (AGENTS.md §5, confirm-only for anything inferred). The
  gateway re-serves both as `away__list` and `away__propose`. There is deliberately no
  write tool.
- **Only the dashboard accepts.** `doResolveInboxItem` refuses to accept an `away` item for
  anything but the dashboard, so an agent holding an approval session cannot confirm its
  own proposal.
- **Proposed once.** Dates that match a listed span are not staged, and neither are dates
  that already have an `away` inbox item, open, accepted or denied: a totem reading email
  every morning would otherwise ask about the same trip daily. The check runs inside the
  inbox queue, and the tool answers with `alreadyProposed: { id, status }`. Accepting a
  proposal whose span is already listed settles it ("already listed") instead of failing.

## In every prompt

`away/grounding.mjs` builds the date-grounding block (`temporalContext()` in `bridge.mjs`).
Each row of the 14-day table that falls in a span is marked `(AWAY: <label>)`, the label cut
to 30 characters. An `AWAY:` paragraph follows: which span the owner is in today (with "day N
of M") and what starts within 60 days, at most five spans with labels cut to 40 characters and
the rest as "+N more (away__list)"; one sentence not to schedule, date or plan reminders on
those days unless the owner names one; and one to propose, not assume, a trip found in an
email or the calendar. That last sentence is there even with no span listed ("AWAY: none
coming up"), because a fresh install is when it matters most. The block is in every prompt,
the phone's included, so the away part stays under about 1,000 characters however many
spans there are.

The table is built from day keys (`todayKey` once, then `addDays`), not by adding 24 hours
to an instant. The old way skipped a day on the night clocks spring forward.

## Notifications

Every notification category says what happens on an away day, in its `away` column in
`notify/categories.mjs`: `'send'` or `'hold'`. It is stated per row, not derived from the
quiet-hours column, so a new category has to decide. `'send'`: reminders the owner set, task
reminders, calendar alerts, Shortcut receipts and answers, birthdays, approvals, chat
answers and questions, job failures, outside alerts, a machine going offline, a failed
journal ingest. `'hold'`: digests, tasks due and overdue, goal nudges, news, usage, inbox
proposals, recommendations to decide again, a journal ingested. An entry queued with `quietHours: 'override'` is sent whatever
its category says, and a category with no `away` column is sent.

On an away day (the owner's local day, so it starts and ends at local midnight) a held
entry waits. The bridge registers `createAwayHold` (`away/hold.mjs`) with the dedupe gate's
`gate.addHold`. The gate puts a held entry back to pending, without spending an attempt,
until the next local morning (the end of quiet hours, 07:00 by default, or midnight when
quiet hours are off), and tags it `heldBy: 'away'`. That morning the gate asks again: still
away, it waits another night; back, it goes out. So a trip followed by a day off is one
absence, and a span deleted or cut short frees what it held the next morning. The drain
applies no quiet hours of its own, so releasing at midnight would wake the phone. A hold that
throws sends the entry (the gate's rule).

The first time an entry is held, the drain asks the dedupe gate whether it is already a
repeat (`admit(item, { reserve: false })`, which checks without reserving anything). A repeat
is suppressed then and logged like any other. Asked only at release, it would get through:
the gate's windows run from when the first copy was sent (48 hours for a story, 168 for a
key), and a trip outlasts them. Copies held side by side still meet the gate on release, and
only the first goes out.

A tagged entry skips the queue's missed-delivery cutoff (`claimDue` in `notify/store.mjs`):
every held nudge comes due at the same 07:00, and a bridge that is down then must not lose
the whole backlog. Its own `expiresAt` still bounds it, so nudges that only mean something on
their own day (a task due, usage, news) lapse while they wait. `claimDue` takes entries that
were never held first, so a reminder due at that 07:00 goes out on the first tick, not after
the backlog (ten a tick, which took it past the catch-up grace with 700 held).

Nothing distinct is thrown away on the way back. Of the tagged entries due, the drain drops
only older copies of the same notification (`releasedAfterAway`): of the digests, all but
the newest of each slot, because a digest restates the day; of anything else, only an exact
repeat of its `dedupeKey`. Two goal nudges, two usage warnings or two stories all arrive. A
nudge that was never held is never touched, even if it is due at the same instant.

Pushes that do not go through the queue are never held: a chat finishing or asking, a
Shortcut answer, a job failure, a fleet or CI alert.

## On the calendar

The dashboard's week, work-week and day views get an "away" row above the all-day row, with
one band across the days a span covers; the month view draws the band at the top of each
cell; the agenda tags the day heading and lists an away day even when it has no events. The
views refetch the spans with every calendar load, so a change made on another device shows
on the next one. The app's calendar mirrors all of it. The colour is `--away` (`colors.away`
in the app).
