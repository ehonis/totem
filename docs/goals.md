# Goals

Weekly, monthly, quarterly, and yearly goals, in Productivity → Goals (<kbd>G</kbd> <kbd>G</kbd>).

A goal is not a task. A task is a thing you do and then it is gone; a goal is a thing you
are trying to have *become true* by the end of a chosen period. The useful questions about a goal — how far
through am I, how many periods have I pushed this — do not exist for a task, which is why
this is its own model rather than a flag on `todos`.

It is deliberately single-user: no permission model and no sharing. Goals live in the
same `node:sqlite` database as tasks, and periods are computed on the box's local clock —
see "Dates" below.

## The rules that matter

**Sub-goals nest exactly one level, and hold no dates.** A step resolves its period from
its parent at read time. That is what makes "move to next week" a single row write no
matter how many steps hang off it, and it is why a step's window can never drift out of
step with its parent's — it hasn't got one. Enforced by triggers in the schema *and* by
the service, so neither a bug nor a hand-written `UPDATE` can produce a three-deep tree.

**A goal tracks several numbers at once — and so does a step.** Metrics are rows, not
columns, so a fitness goal counts miles run *and* miles biked. This is also why there is
no `tracking_type` column: a goal with no metrics is completion-tracked, so the two can
never contradict each other.

A **step** takes numbers the same way, and that is usually where they belong: the goal is
"complete cardio goals" and the countable thing is "2 bike rides (10+ miles)" under it.
One step can carry several — how many rides *and* how far — each with its own bar.
`goal_metrics.goal_id` has always pointed at a goal row and a step *is* a goal row, so
this costs no schema change; what it took was the surfaces admitting it
(`POST /api/goals/:stepId/metrics`, `totem_add_goal_metric` with a step id, the numbers
editor opening from the step's own row).

**A step with numbers is worth what those numbers say.** The goal's fraction averages its
own metrics with the share of its steps earned, and a step earns its share two ways: it is
worth 1 when somebody ticks it, and otherwise worth how far through its own numbers it is.
Reading a step at one ride of two as zero until the tick is what made putting a number on
a step pointless. Ticking still wins outright — completion is a person's statement and a
bar is not.

The one exception is the counted-once rule below, applied to the mean rather than to a
value: a step number that **rolls up** into one of the goal's own metrics is already inside
that metric's bar, so it does not also move the steps component. A step whose numbers all
feed the parent is worth only its tick.

**Rollup is an explicit edge, never a name match.** A step's metric feeds one on its
parent through `rolls_up_to_metric_id`; null means it stands alone, which is the usual
case now that a standalone step number counts on its own. Matching by label was
rejected for a concrete reason: an agent transcribing handwriting writes "miles" one week
and "miles run" the next, the second silently stops counting, the total just reads low,
and nothing anywhere says so. An explicit edge either exists or it doesn't.

The one place a label is accepted is at the door: an agent importing a photographed page
has no ids, so `rollsUpTo: "miles"` names the parent's metric and the service resolves it
to an id once — in `createGoal`, in `addSubGoal`, and in `addMetric`. A label that names
nothing **throws**. It used to be accepted and dropped on the two later paths, which is the
worst of the three outcomes: the caller is told it worked and the total quietly reads low.

**A contribution is counted exactly once.** A metric's stored `current_value` is its *own*
contribution. What gets displayed is that plus the values of everything feeding it, worked
out at read time in `goals/progress.mjs`. The rejected design was writing the total onto
the parent whenever a child changed — the same fact in two rows, which is two rows that
can disagree.

**Completion is always a human act.** A goal whose metrics all read 100% is *not*
complete until somebody marks it. That looks like friction and is the opposite: the point
of a goal is noticing you finished it, and a row that ticks itself is a row you never look
at again.

**"Not doing this" is a third state, on goals *and* on steps.** `abandoned_at`
(`todos/migrations/005-goal-abandoned.mjs`, set through `updateGoal`'s `abandoned` field,
reversible) records a decision made out loud, as against `postponed_count`, which records
what was quietly dropped. It is its own column rather than an outcome on `completed_at`
because "2 of 5 done" is the number read on a Sunday, and filing a decision under
completion would inflate it.

On a **step** it is the case the whole thing was built for: "follow up with Riley"
happened, and the step hanging off it — the add-on he would have done if the week had
gone differently — never will. Ticking it claims work that did not happen; leaving it open
holds the goal under 100% forever over something already decided. So an abandoned step
leaves the steps fraction entirely, neither numerator nor denominator: three steps, two
done, one decided against reads **2 of 2** with `subGoalsAbandoned: 1` beside it. What
that step already logged still rolls up — those miles happened, and deciding the step is
over does not un-ride them.

Neither one disappears. An abandoned goal stays in the live list crossed off, and an
abandoned step stays on its card crossed off, because dropping it to the bottom of the
page made "not doing this" behave like a delete whose result you could not see. The
decision has to stay readable next to the week it was made about, and it is one click to
take back.

**Nothing rolls a goal over.** An expired goal sits there reading expired until you
postpone it or close it out. No cron touches these tables. Auto-rolling would increment
`postponed_count` with no decision behind it, and that counter — never reset — is the one
thing in the database that says "you have quietly decided not to do this".

## Metrics that read themselves

A metric is `manual` by default. It can instead name a source, the same split habits
already run (`HABIT_METRIC_SOURCES` in `bridge.mjs`):

| `source_kind` | Reads | Bounded by the goal's period? |
|---|---|---|
| `manual` | you, or an agent on your behalf | n/a |
| `strava_distance` | the local Strava activity cache | **yes** |
| `strava_gear_odometer` | one bike's lifetime odometer | no — it is an odometer |

`source_config` is `{ sport?, gearId?, measure? }`, where `measure` is one of
`distanceMi` `distanceKm` `movingMin` `movingHours` `elevationFt` `count` — the field
names `mileage()` already produces, so "ride 150 miles this week", "ride 10 hours this
week" and "20 rides this quarter" differ by one string.

`sport` is a **family**, not a single workout type. `run` counts `Run`, `TrailRun` and
`VirtualRun`; `ride` counts the gravel ride, the trainer session and the e-bike. An exact
`sport_type` is accepted too and resolves to the same family — `matchesSport` in
`strava/shape.mjs` owns the map, and `/api/goals/options` publishes it as `sportFamilies`
so the web picker can show a metric stored as `"Run"` under Running rather than as "Any
sport". If a workout looks like it did not count, the filter is rarely the reason; the
cache usually is, which is why every sourced value carries the cache's `updatedAt` as its
`readAt` and the card prints "synced 3h ago" beside the source.

Three things are worth knowing:

- **Reads never hit the network.** `strava_distance` resolves out of the cache the seeded
  `strava-sync` job keeps current, and a whole page of goals costs one cache read. Only
  the gear odometer makes a call, behind a ten-minute memo.
- **Unreadable is not zero.** If Strava is not connected, the metric reports
  `available:false` with a reason, is dropped from the progress mean, and renders as
  "can't read". Scoring it zero would draw a disconnected connector as a week of doing
  nothing.
- **"Current" means current with the cache.** `strava-sync` runs every three hours by
  default (`STRAVA_SYNC_INTERVAL_MINUTES`), so this morning's activity may genuinely not
  be in the number yet. That is what `readAt` reports, and why it is the cache's stamp
  rather than the time of the read.

A sourced metric refuses a hand-written value (`METRIC_IS_SOURCED`), and nothing may roll
up *into* one — it already counts everything in the period, so feeding it as well would
count the same miles twice.

## Dates

Weeks run **Monday to Sunday in `MORNING_BRIEFING_TZ`**. They used to run Sunday to
Saturday; Monday-start weeks match how weekly plans are usually written and how the
optional Bushido app counts its quotas. Everything
on this box that has a week moved with it: `notify/signals.mjs` (weekly habit targets),
the habit grid, and `strava/shape.mjs` (mileage buckets). Two week-starts in one app is a
bug that only shows up on the first of a month, so they changed together.
`todos/migrations/007-goal-week-monday.mjs` slid every stored Sunday-start week goal
forward one day onto the Monday-start week it overlaps; reads match a goal to its window
by exact dates, so without that the old weeks would have belonged to no week at all.

Periods are local days, not UTC days. A multi-user service would have to pick one
timezone per user; here the whole box runs on one local clock, and a goal is a personal
deadline: if it is Sunday evening where you are, the week is over.

Periods are stored as two `YYYY-MM-DD` day keys, the same shape and the same CHECK
constraint as `todos.due_date`. Once "today" has been resolved to a local day key exactly
once, every other calculation is plain calendar arithmetic that no timezone can perturb —
which is why DST cannot move a week boundary.

The week's key is its start day rather than an ISO week number: a key that is also the
range's first day needs no second definition to stay honest, and it means the same thing
in every period type.

### Looking back

`last_week`, `last_month`, `last_quarter` and `last_year` resolve the period before the
current one (`previousPeriod()` is the pair to `nextPeriod()`), and `GET /api/goals` also
takes `type=week&start=<day>` — the period of that type containing that day. The list
response carries the resolved `period` beside the goals, so an empty window still has a
label and dates. The dashboard's ‹ › arrows use the explicit form, handing back the day
just outside the window on screen: the client never learns where a week starts, and can
still walk to any week there has ever been a goal in.

## Surfaces

- **Web** — Productivity → Goals. Period switcher, finished goals gathered under
  "Achieved" at the foot of the list, inline logging,
  and a compact goal dialog whose period field exposes this/next week, month, quarter, and year.
  A goal tracks as many numbers as it needs, and they are editable *after* creation —
  "Edit the numbers" on the card menu, or the Numbers button in the goal edit panel, opens
  `GoalNumbers`. **A step opens the same editor from its own row** (the chart glyph beside
  "not doing"), with one extra field: which of the goal's numbers this one feeds, offered
  only for the goal's *manual* metrics because a connector-fed one already counts
  everything in the period. A step with numbers states its own percentage beside its name.
  Both step controls are hover-revealed on a desktop and always visible on a touch screen,
  where there is no hover to reveal them with. It saves a diff rather than the form (`added` / `updated` / `removed`), so
  a metric nobody touched is never rewritten — which is what stops an exact `sport_type`
  filter the picker cannot express from being silently widened to its family.
  The refresh button **syncs Strava first**, then reloads: re-reading a cache that is three
  hours old would redraw the identical number and look broken. That button is the only
  thing in the goals stack allowed to spend an API read, and only because a person pressed
  it — `goals/sources.mjs` still never syncs on its own, so a dashboard left open cannot
  burn a rate limit. A failed sync never blocks the reload; the cached numbers render and
  the reason appears beside them.
- **HTTP** — `/api/goals*`, bearer-authed like everything else.
- **MCP** — 15 tools (`totem_get_goals`, `totem_create_goals`, …), `goals__*` on the
  gateway. This is a *primary* write surface, not a mirror: `create_goals` takes a whole
  weekly, monthly, quarterly, or yearly period with nested steps in one call and reports per-row failures, periods are named
  shortcuts resolved server-side so a model never derives a date, and `clientKey` makes
  re-importing the same notebook photo a no-op instead of a doubled week.
  `totem_add_goal_metric` takes a **step id** exactly as it takes a goal id (a step is a
  goal row), `totem_add_goal_step` carries the numbers in with the step, and a step's
  metrics come back under `subGoals[].metrics` with the step's own progress. `GOAL_RULES`
  tells the local agents the same thing, because "I rode 12 miles" should land on the step
  that names riding rather than on a number invented on the goal.
  A metric's source can be changed after the fact (`totem_log_goal_metric` with `sourceKind`) —
  switching to a connector discards whatever was logged by hand and says so in `discardedValue`,
  and a number with steps feeding it refuses the switch rather than double-counting.
- **CLI** — `node goals/cli.mjs list | review | find | add | log | complete | postpone`.
- **Agents** — `GOAL_RULES` in the system prompt. It tells them not to complete or
  postpone anything without asking, and that an unreadable metric is not zero.

## The Sunday review

A seeded weekly job (`goals-review`, Sundays 18:00 local, off by default —
`GOALS_REVIEW_ENABLED`) runs the `goals-review` skill. Sunday is now the *last* day of the
week, so `this_week` on Sunday evening is the week that is closing — which is what the
review was always meant to read. It reports what landed, what is
about to expire, what already has, and anything moved three or more times — and then
**asks**. It is forbidden from completing or postponing anything, because both of those
are decisions with a counter behind them.

`notify/signals.mjs` also has a `goalFacts` collector wired into `COLLECTORS`, raising
`goal.nearcomplete` and `goal.slipping` facts for the push layer when it lands. A goal
whose progress is unknown raises nothing: unknown is not behind.

## Deliberately not built

A cross-goal progress bar (one bar averaging the week — the arithmetic is in
`goals/progress.mjs` if it comes back), goal ↔ goal "related but separate" links, metric
history, per-goal weighting, and any second level of nesting. Each was cut to see the
structure work first.
