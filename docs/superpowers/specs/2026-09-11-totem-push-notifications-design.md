# Totem Push Notifications Design

Status: Drafted 2026-09-11, pending approval

**Shipped (2026-09-15).** Phases 1–3 are live on the box and delivering to the owner's
iPhone: the PWA installs, the Settings test button works, and the `daily-digest` /
`evening-digest` jobs plan a day of notifications that the queue drains on the job tick,
revalidating each one before it goes out. Remaining: per-task `remindAt` (phase 4), the
notification centre bell, the feedback UI, and learned weights. 150 tests in `notify/`.

**Earlier note (2026-09-15).** Phase 1's server side:
`notify/schedule.mjs`, `notify/categories.mjs`, `notify/plan.mjs`, `notify/signals.mjs`
(birthdays, habits, metrics, goals, tasks), `notify/store.mjs` (queue, devices, ledger,
feedback log), `notify/push.mjs` (RFC 8291 + 8292, zero dependencies), and
`notify/cli.mjs`. 103 tests. Still not wired into `bridge.mjs`, so nothing can send
unprompted; `node notify/cli.mjs preview` and `keys` are the entry points. See "Rollout".

**Scope note.** Phase 1 — the notification structure and its internal API — was designed
before the local-first todo core landed. Everything task-shaped here remains a documented
extension point. The queue, categories, reminder primitive, and digest planner are designed
so wiring tasks in later means adding a caller, not reopening the design.

## Summary

Totem will speak first. Today every notification it raises dies in a JSON ring on the
box — `jobStore.notify()` writes `data/notifications.json` and the Jobs view is the only
place it is ever rendered. Nothing reaches the phone unless the owner opens the app and looks.

This adds a real delivery path: **Web Push into Totem as an installed iOS Home Screen web
app**. One notification pipeline carries everything worth interrupting for — a task
reminder, a calendar event about to start, a morning and evening digest, a birthday, a
habit whose streak ends tonight, a job that failed, an approval waiting on a code.

Two rules shape the whole design:

1. **Anything that needs a reminder gets one.** Reminders are not a task feature; they are
   a primitive. A todo, a calendar event, a chat message ("remind me at 3 to call the
   dentist"), an MCP client, or a scheduled job can all put an entry on the same queue.
2. **The notification path never depends on an AI call succeeding.** Facts are collected
   deterministically in code. One AI call turns those facts into Totem's voice. If the
   model is logged out, rate-limited, or slow, the push still goes out in plain words.
3. **A day is planned, not summarised.** A single morning run routinely finds five things
   worth saying, and five things in one push is a push nobody reads. The digest run emits a
   *plan* — several notifications scheduled across the day at the times they actually
   matter — and re-checks each one before it fires, so "you're two away from finishing"
   never arrives after it has been finished.

This deliberately follows the local-first task cutover, whose initial scope omitted reminders:

> Task reminders are deliberately omitted. The system will not carry forward the removed
> reminder implementation or create an Apple Reminders/PWA bridge in this scope.

## Goals

- Deliver notifications to the owner's phone without him opening anything.
- One queue and one ledger for every kind of notification, not a new system per source.
- Reminders attachable to a todo, a calendar event, or nothing at all.
- A daily digest that reliably names the things a person would feel bad about missing —
  a birthday, an overdue commitment, a goal quietly slipping.
- A day's worth of nudges spread across the day rather than stacked into one push, with
  each one re-verified at send time so it is still true when it arrives.
- Nudges that push toward a finish, not only ones that report a slip.
- A way to tell it a notification was worthless, and a mechanism that visibly acts on that
  rather than filing it.
- Per-category control, quiet hours, and deduplication, so the thing stays trusted.
- Notifications tap through to the exact view that explains them.
- Failure is visible: a dead subscription says so rather than silently delivering nothing.

## Non-goals

- No native iOS app, no App Store, no Apple Developer Program membership.
- No Apple Reminders bridge and no Apple Push certificate of Totem's own — Web Push
  reaches APNs through the browser's own push service.
- No critical alerts, custom sounds, or bypassing Focus/Do Not Disturb. Web Push cannot do
  these, and a spec that implies otherwise sets up a missed alarm.
- No second scheduler. The job engine's tick drains the notification queue too.
- No SMS, email, or third-party push app as the primary channel. `NOTIFY_WEBHOOK_URL`
  stays as an optional escape hatch, not a supported product surface.
- No notification content that a person other than the owner should not see on a lock screen
  is exempted from this — lock-screen previews are the user's device setting, not Totem's.

## The platform constraint, stated once

iOS supports the Push API **only for a web app added to the Home Screen**. Push never
fires from a Safari tab, on any iOS version, including iOS 26 where Home Screen sites open
as web apps by default. Totem is currently loaded on the owner's phone as a website, so
step one of this work is making Totem installable and installing it.

Everything else on iOS follows from that one fact, and each consequence is a real failure
mode rather than trivia:

| Constraint | Consequence for this design |
|---|---|
| Push requires Home Screen install | Settings must detect standalone mode and show install instructions instead of a toggle that cannot work. |
| Permission is requested once, from a user gesture, and a denial is sticky until the app is removed and re-added | The toggle is an explicit button behind a screen that explains what will be sent. Never prompt on load. |
| Removing the web app from the Home Screen destroys the subscription and its storage, silently | The server treats `404`/`410` from the push service as "this device is gone" and drops it; the UI shows "no active device" rather than reporting success into the void. |
| Every push received must display a notification | The service worker always calls `showNotification`, including on a malformed or empty payload, with fallback text. Silent pushes risk the subscription being revoked. |
| Declarative Web Push (Safari 18.4+) displays a correctly shaped JSON payload without waking the service worker | Payloads are sent in declarative shape so the reliable path is used where available and the service worker handler is the fallback, not the requirement. |
| Delivery is best-effort via APNs and can be throttled | Nothing safety-critical rides on this channel, and the in-app notification centre remains the complete record. |
| An installed web app's storage is not subject to Safari's 7-day script-writable storage eviction | The pasted `BRIDGE_SECRET` survives in the installed app, but the app still re-prompts gracefully rather than showing a broken screen. |

Push delivery itself does not traverse the Cloudflare tunnel — the bridge calls Apple's
push service outbound, so Access is not in that path. Access and the bearer token are only
in the path when a notification is **tapped** and the app opens.

Sources: [Notificare on Home Screen requirement](https://notificare.com/blog/2024/09/16/web-push-in-ios-add-to-home-screen/),
[MagicBell PWA iOS limitations 2026](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide),
[MobiLoud PWAs on iOS 2026](https://www.mobiloud.com/blog/progressive-web-apps-ios/).

## Architecture

A new top-level `notify/` module, sitting beside `jobs/`, `logs/`, and `skills/` and
following the same shape: pure logic in one file, a store behind a write mutex in another,
dependencies injected rather than imported.

| Piece | File | Responsibility |
|---|---|---|
| Queue maths (pure, tested) | `notify/schedule.mjs` | Due-time resolution, lead times, quiet-hours shifting, dedupe keys, catch-up grace. |
| Queue + subscriptions + ledger | `notify/store.mjs` | `data/notifications.json` (the existing ring, extended), `data/push-subscriptions.json`, `data/notification-queue.json`. Atomic tmp-then-rename writes behind a mutex, as `jobs/store.mjs` does. |
| Web Push transport | `notify/push.mjs` | VAPID signing, payload encryption, per-subscription send, expiry handling, retry/backoff. |
| Signal collectors (pure) | `notify/signals.mjs` | Facts with a salience score, from tasks, calendar, habits, brain, jobs, inbox. |
| Digest composition | `notify/digest.mjs` | Rank and cap facts, fill the digest skill, fall back to a template. |
| Feedback + learned weights | `notify/feedback.mjs` | Append to `data/notification-feedback.jsonl`, derive `data/notification-weights.json`, expose the weights the ranker multiplies by. |
| Routes, wiring, queue drain | `bridge.mjs` | `/api/push/*`, `/api/notifications*`, and one `drainNotifications()` call inside the existing job tick. |
| Service worker | `web/public/sw.js` | Unbundled, stable path. `push`, `notificationclick`, `pushsubscriptionchange`. |
| Manifest + icons | `web/public/manifest.webmanifest`, `web/public/icons/` | Installability. |
| Client subscription | `web/src/push.ts` | Permission, subscribe, register, unregister, state reporting. |
| Settings UI | `web/src/components/NotificationsSettings.tsx` | Install state, permission, categories, quiet hours, devices, test push, learned weights and their reset. |
| Notification centre | `web/src/components/NotificationsPanel.tsx` | The bell that does not exist today. |

### Notifications move out of the job store

`jobs/store.mjs` currently owns `notify()`, the ring file, and the optional webhook. That
made sense when a failed job was the only thing that ever raised one. It no longer is.

Notifications move to `notify/store.mjs`, and `jobs/store.mjs` takes a `notify` function by
injection — the same dependency-injection pattern it already uses for `webhookUrl` and
`fetchImpl`. Every existing `jobStore.notify()` call site keeps working unchanged and
starts pushing for free. There must not end up being two ledgers.

### One scheduler, one tick

`docs/jobs.md` earns its "one store, one scheduler" line and this must not undo it.
`JOB_TICK_MS` is 30s; the same tick drains the notification queue. A reminder therefore
fires within 30 seconds of its time, which is the right resolution for "call the dentist
at 3" and is honest about not being an alarm clock.

Draining reuses the job engine's semantics rather than inventing new ones:

- **Claim then deliver then finish**, so a crash mid-send cannot double-deliver.
- **Catch-up grace**, defaulting to 30 minutes: a reminder the box was down for is
  delivered late and *marked late* in its body ("was due 2:00 PM"). Past the grace window
  it is dropped to the ledger only, because a 6-hour-stale "leave now" is worse than
  silence.
- **No backfill.** An outage that spans four queue entries delivers four entries once,
  not a burst per missed tick.

### Queue entry

```
{
  id, createdAt, deliverAt,           // deliverAt is UTC ms; wall-clock resolved in MORNING_BRIEFING_TZ
  category,                           // routing + user toggle + default priority
  title, body,                        // already-rendered text; the queue never holds a prompt
  url,                                // deep link, e.g. /productivity/todos?task=<id>
  dedupeKey,                          // collapses duplicates within a window
  source: { kind, id },               // 'task' | 'event' | 'habit' | 'person' | 'job' | 'adhoc' | 'digest'
  planId, planDate,                   // set when a digest run scheduled this entry
  revalidate: { collector, factKey }, // re-checked at claim time; a stale fact is dropped
  resolvedTitle,                      // optional: what to say instead if the fact became a win
  quietHours: 'defer' | 'suppress' | 'override',
  state, attempts, lastError, deliveredAt,
  openedAt,                           // set when the app is opened from this notification
  feedback                            // { vote, reasons[], at } once rated
}
```

Entries are rendered text by the time they reach the queue. Nothing waits until delivery
time to decide what it says — that would put an AI call on the critical path at the exact
moment latency is least acceptable.

### Categories

Each is independently toggleable, carries a default priority, and has its own quiet-hours
behaviour. This table is the product.

| Category | Fires when | Quiet hours | Example |
|---|---|---|---|
| `reminder.adhoc` | An explicit reminder time, from chat, MCP, or the UI | override | "Call the dentist" |
| `reminder.task` | A todo's `remindAt` | defer | "Renew the domain — due today" |
| `task.due` | Tasks due today, rolled into the morning digest rather than sent individually | — | folded into digest |
| `task.overdue` | A task passes two days overdue, once | defer | "3 tasks have been overdue since Monday" |
| `calendar.event` | Default 10 minutes before an event with a start time | override | "Standup in 10 minutes" |
| `calendar.dayahead` | Folded into the evening digest | — | folded into digest |
| `digest.morning` | The `daily-digest` job | defer | see below |
| `digest.evening` | The `evening-digest` job | defer | see below |
| `person.birthday` | A birthday in `data/brain/people/people.md`, on the day and 7 days ahead | defer | "Your mom's birthday is today — Marion, 60." |
| `habit.slipping` | A daily streak ends tonight if unlogged, or a weekly target is behind pace | defer | "Help the Business is 1 of 4 with two days left." |
| `goal.slipping` | Strava mileage or a metric habit trending away from its goal | defer | "Sleep performance has been under 85 for five nights." |
| `goal.nearcomplete` | A goal or weekly target is within reach with time left to act | defer | "You're one session off Help the Business for the week — there's still tonight." |
| `job.failed` | Any `notify({level:'error'})` — every existing call site | defer | "WHOOP sleep sync failed — token refresh 400" |
| `approval.pending` | The approval gate issues a code | override | already goes to the ledger; now it reaches the phone, which is the entire point of an out-of-band code |
| `inbox.proposal` | A proposal is staged by an MCP client | suppress | "ChatGPT queued a prompt for approval" |

`override` is reserved for things the owner explicitly asked to be interrupted by, plus the
approval code, which is useless if it arrives in the morning. Everything else defers to the
start of the next allowed window or folds into the next digest.

Quiet hours default to 22:00–07:00 in `MORNING_BRIEFING_TZ` and are editable in Settings.

### Deduplication

`dedupeKey` plus a window, checked at enqueue and again at claim:

- Same task reminder rescheduled: replace, do not stack.
- `habit.slipping` for one habit: at most once per day.
- `goal.slipping` for one goal: at most once per week — a nag that arrives daily is a nag
  that gets its permission revoked.
- `job.failed` for one job: at most once per hour, with a count ("failed 4 times").
- A category is capped at N deliveries per rolling hour; the overflow collapses into a
  single "and 5 more" entry that opens the notification centre.

## Reminders as a primitive

Four front doors, one queue. This mirrors how the Strava connector already exposes one
client four ways.

1. **UI** — a reminder control on a todo, on the calendar event sheet, and a standalone
   "remind me" composer in the notification centre.
2. **Chat / agent** — a `REMINDERS` paragraph in the agent prompt rules pointing at the
   API, so "remind me at 3 to call the dentist" works in web chat and from the iOS
   Shortcut, and so does "remind me an hour before my 1:1".
3. **MCP** — `totem_schedule_reminder({ at, text, url?, taskId?, eventId? })` and
   `totem_list_reminders` / `totem_cancel_reminder`, so ChatGPT and Claude can set one.
   Natural-language `at` is resolved server-side against `MORNING_BRIEFING_TZ` and the
   resolved absolute time is echoed back — a model that quietly means UTC is the obvious
   way for this to go wrong.
4. **Jobs** — a job's output can enqueue a reminder, which is how a nightly ingest can say
   "you agreed to send Nolan the photos" tomorrow morning rather than at 2am.

**Task reminders** add `remindAt` to the task schema from the todos design. Because that
spec is mid-implementation, this is additive and lands after the task core does:
recurrence-aware (completing a recurring task schedules the next occurrence's reminder),
cancelled on completion or archive, and rescheduled on a due-date change. An externally
owned task can carry a local reminder — reminding yourself is not mutating the source.

**Calendar reminders** are derived, not stored: the drain resolves the next N hours of
events from `fetchCalendar` and enqueues lead-time entries with a dedupe key of the event
id, so a moved meeting re-enqueues rather than firing at the old time.

## The digest plans a day, not a push

Two jobs, seeded like every other job and therefore renameable, reschedulable, and
deletable in Studio → Jobs:

- `daily-digest` — default 07:15, before the existing `daily-brief` job at 07:30. The
  brief is a page you read; the digest is what reaches the lock screen.
- `evening-digest` — default 20:30. Tomorrow's first commitment, anything still open, and
  the habits whose streak ends at midnight while there is still time to act.

Neither job sends a notification. **Both emit a plan**, and the queue sends it.

A single morning collection routinely finds five true things: a birthday, two tasks due, a
weekly habit at 3 of 4, and a meeting at 2pm. Rolled into one push, that is a paragraph
nobody reads on a lock screen. Spread across the day, each one arrives when it can still
change what the owner does — the birthday at 07:15 while there is time to call, the meeting at
13:50, the habit nudge at 18:00 when the evening is still salvageable.

### The plan

The digest runner is **collect facts → rank → schedule → enqueue**. The unit of output is a
`plan`: an ordered set of queue entries sharing a `planId` and a `planDate`.

```
{
  planId, planDate, generatedAt, source: 'daily-digest' | 'evening-digest',
  entries: [ { deliverAt, category, title, body, url, factRef, revalidate } ]
}
```

Scheduling rules, all configurable and all defaulted so the thing is pleasant on day one:

- **A daily cap**, default 4 planned notifications per day across both runs —
  counted against what has *already been delivered* that day, not per run. Facts beyond
  the cap stay in the notification centre and do not push. This is the setting that decides
  whether Totem is trusted or muted, so it is a first-class control in Settings, not a
  constant in the source.
- **Minimum spacing**, default 90 minutes between planned entries.
- **Each fact has a natural time**, which is the point of planning rather than batching:
  a birthday goes to the morning slot, a near-complete weekly target goes to early evening
  where there is still time to act on it, a slipping metric goes to the evening digest
  where it reads as reflection instead of nagging, a calendar lead-time goes to its own
  offset and is not part of the plan at all.
- **Slots respect quiet hours** and are shifted, never silently dropped.
- **Re-planning replaces.** A later run supersedes the undelivered entries of an earlier
  plan for the same `planDate` rather than adding to them. Without this, the evening run
  duplicates every morning fact still outstanding.

### Revalidation is what makes this safe

Every planned entry carries a `revalidate` reference: the collector and the fact key that
produced it. At claim time — seconds before sending, hours after planning — the drain
re-runs that collector and asks whether the fact still holds.

- Still true → send.
- No longer true → drop it, silently. The 18:00 "you're one session off" does not fire if
  the session was logged at 17:30.
- Turned into a win → optionally send the other copy. A `goal.nearcomplete` fact whose goal
  was completed during the day can carry a `resolvedTitle` ("Help the Business done for the
  week — four of four") that fires instead, capped to one per day so a good afternoon does
  not become a confetti cannon.

This is cheap precisely because the collectors are pure functions over files Totem already
reads. It is also the difference between a nudge that feels like attention and one that
feels like a broken robot.

### Facts expire, and late is not the same as harmless

Spacing and quiet hours only ever move an entry *later*. For most facts that is fine. For
some it is nonsense, and running the planner against real data is what made that obvious:
an evening run planned "your 18-day journal streak ends tonight", spacing pushed it past
22:00, quiet hours deferred it to 07:00 — arriving as advice about a streak that broke at
midnight.

So a fact may carry an `expiresAt`, and an entry scheduled past it is **dropped with reason
`too-late`** rather than delivered wrong. The deadline belongs to the fact, not the
category: a streak nudge expires at midnight tonight, a weekly target expires at the end of
the week (so it is still worth saying tomorrow), a birthday expires with the day it is
about. Dropped entries stay in the notification centre, which is where "why did I not get
told" gets answered.

### Signals are collected in code

Every collector is a pure function over already-available state, returning typed facts with
a salience score, a natural slot, and a revalidation key. Nothing is inferred by a model,
which is what makes "remember it's your mom's birthday" a guarantee rather than a hope.

| Collector | Reads | Produces |
|---|---|---|
| Birthdays | `data/brain/people/people.md` — the `Birthday YYYY-MM-DD` field already on each person line | Today's birthdays (pinned, morning slot) and 7-days-ahead warnings for people with a gift list in `reference/` |
| Habits | `data/habits.json` — `cadence`, `target`, and the date-keyed `entries` map | Daily streaks ending tonight (evening slot); weekly habits behind pace *and* within reach (`help-the-business`, target 4/week) |
| Metrics | Metric habits with a `goal` and `direction` | Sustained trend away from goal, e.g. sleep performance under 85; distance from goal when close |
| Calendar | `fetchCalendar` | First commitment, unusual early starts, conflicts, a free afternoon worth using |
| Fitness | Strava mileage cache, WHOOP sleep | Weekly mileage versus recent baseline and versus a target; a bad-sleep morning worth easing off for |
| System | Job run history, `inbox.md`, approvals | Failures since the last digest, proposals waiting |
| Tasks *(deferred)* | The task service from the todos design | Due today, overdue, still in Doing. Produces no facts until that service exists, which is the intended degraded state during phase 1. |

Goals get their own collector when goals exist as a first-class object. Until then the
weekly-target habits are the closest real thing and already support the shape — `target: 4`
with two logged on a Thursday is exactly "do two more to finish", computed from data on
disk with no model involved.

Salience decides what makes the cap; the natural slot decides when. Birthdays and pending
approvals are pinned above the ranker. Everything else competes.

### One AI call, off the critical path

The planned facts fill a new seed skill, `data/skills/daily-digest/SKILL.md`, so the voice
is an editable Markdown file like every other prompt Totem runs (`docs/skills.md`), not a
template literal in `bridge.mjs`. The skill is handed the whole plan at once and writes each
entry's one or two sentences in a single call — one call per digest run, not one per
notification. Its job is stated narrowly in its body: rewrite these facts in Totem's voice,
one short message per entry, add nothing, drop nothing.

Guards, all of them required:

- **A 90-second budget** (`DIGEST_AI_BUDGET_MS`). The original spec said 8 seconds; that
  was wrong, and in practice every run fell back to templates because an agent CLI does not
  cold-start a model in eight. The call happens at *plan* time, hours before the first
  notification is due, so a long budget costs only a slower digest job while a short one
  costs the voice on every single notification. On timeout, error, logged-out provider, or
  exhausted quota, the deterministic template ships instead, per entry. A digest is never
  skipped because an AI was down.
- **Structure assertion.** The response must return exactly one message per planned entry,
  and each must still contain its fact's key token (the person's name, the count, the habit
  name). Any entry that fails falls back to its template — one bad line does not lose the
  plan.
- **No tools.** The call has no tool access and reads no state beyond the plan it is handed,
  so it cannot go exploring or take action while writing a sentence — the same reasoning
  that made skill revision read-only.
- **Skipped when empty.** No facts means no plan and a `skipped` run, not a push that says
  "nothing to report".
- **Rendered at plan time, revalidated at send time.** The AI is never on the critical path
  of a delivery; by the time an entry is due, its text has existed for hours.

Cost is two AI calls a day on the default provider, regardless of how many notifications the
plan contains, visible in the AI usage panel like everything else.

## Feedback: teaching it what to send

A notification system that cannot be told "that was useless" gets muted instead of tuned.
Every delivered notification is rateable, and the rating changes what gets sent.

**Capture ships in phase 1. Nothing acts on it until phase 2.** The feedback log is the
training data the planner needs, and it only exists if it has been accumulating since the
first push. Rating is available from the day the bell exists, even though the only things
being rated at that point are job failures and test pushes.

### A thumb alone is not actionable

"I disliked this" does not say whether the fact was wrong, the timing was wrong, the
wording was wrong, or there were simply too many that day — and those four have opposite
fixes. So a downvote asks one optional follow-up, as chips, and the chip routes the signal:

| Reason | What it adjusts |
|---|---|
| *Not useful* | Salience weight for that fact kind, down. Fewer of these clear the daily cap. |
| *Wrong time* | The natural slot for that fact kind shifts toward when it was actually opened, or toward the next digest if it was never opened. |
| *Too many* | The per-category rolling cooldown lengthens, and the daily cap suggestion drops. |
| *Badly worded* | The entry joins the negative examples in the digest skill's prompt. Salience is untouched — the fact was right, the sentence was not. |
| *Already done it* | Treated as a revalidation miss, not a preference: the collector's staleness window tightens. This is a bug report, and it should read as one. |

An upvote is a single tap with no follow-up. The asymmetry is deliberate — asking for
detail on a good notification is a tax on the behaviour you want.

### Implicit signal is the stronger signal

Thumbs get used for a fortnight and then stop. Three things get recorded whether or not
anything is tapped, and they are worth more:

- **Opened.** `notificationclick` deep-links with the entry id, so the ledger records that
  this notification caused the app to open, and how long after delivery.
- **Ignored.** Delivered, never opened, and the app was used within the following hours
  anyway. That is a stronger negative than a dismissal, because it means it was seen and
  skipped.
- **Acted on.** The outcome the nudge existed for, computed from data Totem already holds:
  a `habit.slipping` nudge is *effective* if that habit was logged later the same day; a
  `goal.nearcomplete` nudge if the target was reached; a `reminder.task` if the task was
  completed. This is the only measure that answers "does nudging me actually work", and it
  needs no interaction at all.

Effectiveness by category is shown in Settings, because "these worked 4 times out of 5, and
these have never once worked" is the information that should decide what stays on — and it
lets the owner make that call himself rather than waiting for a weight to drift.

### How learning actually works

No fine-tuning, no model memory, no hidden state. Two mechanisms, and the split matters:

1. **Deterministic weights decide *what* is sent.** `notify/feedback.mjs` derives a
   per-fact-kind multiplier from the log — upvotes and effectiveness push it up, downvotes
   and ignores push it down — and the ranker multiplies salience by it. This is what
   changes behaviour, and it is a number in a file that can be read, explained, and reset.
2. **Examples decide *how* it is worded.** The digest skill's prompt carries a handful of
   recent upvoted and *badly worded*-downvoted entries as examples. This affects sentences
   only and can never affect selection, so a model cannot decide on its own to stop
   mentioning something.

Guardrails, because a system that silently learns to stay quiet is indistinguishable from
one that is broken:

- Weights are **bounded**, default 0.25×–2.0×. A category can become rare; it cannot be
  learned into silence.
- **Pinned facts are exempt.** Birthdays and pending approvals ignore weights entirely. No
  amount of feedback stops the birthday.
- **A cold start is neutral.** Fewer than a handful of ratings for a fact kind means a
  multiplier of exactly 1.0. No learning from a single grumpy Tuesday.
- **Decay.** Feedback older than ~90 days fades, so a preference from six months ago does
  not outvote last week.
- **Visible and reversible.** Settings lists every learned weight, what it is doing, and how
  many ratings produced it, with a per-kind and a global reset. Deleting
  `data/notification-weights.json` reverts everything, because it is derived — the log is
  the source of truth and is append-only.
- **Changes are announced.** When a weight crosses a threshold that will meaningfully reduce
  a category, that is itself worth one line in the next digest. Totem saying "I've stopped
  sending you sleep nudges, you downvoted four" is the difference between learning and
  quietly going deaf.

### Where it is rated

- **The notification centre (the bell)** is the primary surface: every entry has thumbs, and
  a downvote expands the reason chips inline.
- **The Logs tab** gains a notifications view alongside the existing action log — delivered,
  planned-but-dropped, and suppressed entries, each with its fact, its plan, its
  revalidation outcome, and its rating. This is the debugging surface when a notification
  did not arrive, and it answers "why did I not get told" in one place.
- **Notification action buttons** on the push itself, if iOS supports them for the installed
  web app — worth a device check, since support for `actions` has historically been partial
  on iOS and is unavailable under Declarative Web Push. If they do not work, the tap-through
  lands on the centre where the buttons live, and nothing is lost but a tap.

### Storage

`data/notification-feedback.jsonl` — append-only, one JSON object per event, matching the
house pattern of `data/action-log.jsonl` and `data/job-runs.jsonl`:

```
{ ts, entryId, category, factKind, planId, slot,
  event: 'delivered' | 'opened' | 'ignored' | 'acted' | 'vote',
  vote: 'up' | 'down' | null, reasons: [...] }
```

`data/notification-weights.json` is derived, recomputed on a schedule and on demand, and
safe to delete. Both are gitignored.

## Client

### Installability

`web/public/manifest.webmanifest`: name "Totem", `display: standalone`, `theme_color`
`#0f1115` to match the existing meta tag, `background_color`, `start_url: /overview`,
`scope: /`, and icons at 192/512 plus a maskable variant. The repo currently ships only
`web/public/favicon.png`, so real icons are a small asset task inside this work, not an
afterthought — a Home Screen icon is the thing he taps forty times a day.

`index.html` gains the manifest link and `apple-mobile-web-app-*` meta tags. Deep links
already work: `serveStatic` serves `index.html` for unknown paths, which the router needs
anyway.

### Service worker

Lives at `web/public/sw.js` so Vite copies it verbatim to a stable, unhashed path at the
origin root — a bundled and hashed service worker cannot control the scope it needs.

It is deliberately minimal. It caches nothing. Totem is a live dashboard behind an
authenticated API, and an offline cache of it would be a stale, confusing copy of a
personal assistant; the only thing worse than no offline mode is one that lies. Its whole
job is:

- `push` — parse the payload, always `showNotification` (fallback text if parsing fails),
  set the app badge from the unread count in the payload.
- `notificationclick` — focus an existing window and navigate it, or open the deep link.
- `pushsubscriptionchange` — re-subscribe and re-register with the bridge, then clear the
  badge state that no longer applies.

### Settings → Notifications

Truthful state, because a notification setting that lies is worse than no setting:

- **Install state** — "Totem is installed" or the iOS install steps with the caveat that
  push cannot work from a Safari tab.
- **Permission state** — granted / denied / default, with the warning that on iOS a denial
  sticks until the app is removed from the Home Screen and re-added.
- **Devices** — each subscription with its label, when it was registered, when it last
  received something, and a remove button. A subscription that the push service rejected is
  shown as expired, not quietly deleted.
- **Categories** — the table above, each with its own toggle and lead time where relevant.
- **Quiet hours** — start, end, and what each category does during them.
- **Send a test** — the first thing to reach for when it stops working.

### Notification centre

A bell in the app shell, badge-counted, backed by the ledger that already exists and is
currently only visible inside the Jobs view. Grouped by day, filterable by category, with
the full digest text and a deep link per entry. `markNotificationsRead` already exists.

## API

```
GET    /api/push/key                     -> { publicKey }        VAPID public key
POST   /api/push/subscribe               <- { subscription, label, userAgent }
POST   /api/push/unsubscribe             <- { endpoint }
GET    /api/push/subscriptions           -> devices with health
POST   /api/push/test                    -> sends to one or all devices
GET    /api/notifications                -> existing; gains category + cursor paging
POST   /api/notifications/read           -> existing
GET    /api/notification-settings        -> categories, quiet hours
POST   /api/notification-settings        <- patch
GET    /api/reminders                    -> pending queue entries
POST   /api/reminders                    <- { at, text, url?, taskId?, eventId? }
DELETE /api/reminders/:id
GET    /api/notification-plan            -> today's plan, delivered and pending
POST   /api/notification-plan/preview    -> run collectors + ranker without enqueuing
POST   /api/notifications/:id/feedback   <- { vote, reasons? }
GET    /api/notification-weights         -> learned weights, rating counts, effectiveness
POST   /api/notification-weights/reset   <- { factKind? }  omit to reset everything
```

`POST /api/notification-plan/preview` is the phase-1 development surface: it runs the
collectors and the scheduler and returns the plan it *would* have enqueued, so signals can
be built and tuned before anything is ever sent to a phone.

All bearer-authed against `BRIDGE_SECRET` like the rest of `/api/*`. `/api/push/key`
returns a public key and is harmless, but stays authed for consistency.

## Dependencies and secrets

Web Push requires VAPID signing (JWT, ECDSA P-256) and RFC 8291 payload encryption
(ECDH + HKDF + AES-128-GCM).

**Resolved: no dependency.** `notify/push.mjs` implements both specs on `node:crypto`
alone, and the repo keeps its two runtime deps. The original recommendation was to add
`web-push`, on the grounds that hand-rolled crypto fails silently behind a black-box push
service. What changed that is the test: RFC 8291 publishes a complete worked example in
Section 5 and Appendix A, and `notify/push.test.mjs` asserts against it byte for byte —
the ECDH agreement, `IKM`, `CEK`, `NONCE`, and the final encrypted body. A wire format
that reproduces the RFC's own ciphertext exactly is not guesswork, and the failure mode
the dependency was insurance against is the one the vector rules out.

What the vector cannot prove is that Apple accepts the request, which is why the device
checks below are not optional.

New env keys, documented in `.env.example` and `AGENTS.md`:

```
PUSH_ENABLED=true
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:ethan@...
```

Generated once with `node notify/cli.mjs keys`, which prints the three lines to paste.
**Rotating the private key invalidates every existing subscription** and every device must
re-subscribe — worth a line in the gotchas, because the symptom is silence, not an error.

`data/push-subscriptions.json` is gitignored: an endpoint plus its keys is enough to push
to the device.

## Failure handling

- A dead subscription (`404`/`410`) is dropped and surfaced in Settings as "expired —
  re-enable on that device".
- Other send failures retry with backoff, up to three attempts, then land in the ledger
  with the error visible. A notification that could not be delivered is still recorded.
- A failing push never fails the job or reminder that raised it. The camera and WHOOP
  runners already treat notification write failure as best-effort; sending inherits that.
- Queue drain is wrapped so one poisoned entry cannot stall the tick; the entry is marked
  failed and the drain continues.
- The AI digest call failing is a normal, tested path, not an incident.
- If `PUSH_ENABLED` is false or no VAPID keys are set, everything still writes to the
  ledger and the UI says push is off. No half-working state that looks on.

## Verification

Automated:

- `notify/schedule.mjs` — due-time resolution across both DST switches (the existing
  `jobs/schedule.mjs` tests are the model), quiet-hours deferral and override, catch-up
  grace, late-marking, dedupe windows, per-hour caps and collapsing.
- Queue store — claim/deliver/finish across a simulated restart, no double delivery, no
  burst backfill after an outage, atomic write under concurrent enqueue.
- Subscription store — register, duplicate endpoint, expiry on 410, removal.
- `notify/push.mjs` — payload shape for both declarative and service-worker paths; VAPID
  header signing against a known key (or `web-push`'s own vectors if the dep lands).
- Signal collectors against fixtures: a birthday today, a birthday in seven days, a leap
  day, a daily streak ending tonight, a weekly habit behind pace, an empty day producing
  no digest.
- Plan composition: ranking, the daily cap, minimum spacing, natural-slot assignment,
  quiet-hours shifting, pinned facts surviving, and re-planning superseding the undelivered
  entries of an earlier plan for the same date instead of duplicating them.
- Revalidation: a planned entry whose fact went false is dropped at claim time; one that
  became a win sends `resolvedTitle` at most once per day; a collector that throws during
  revalidation fails closed (drops the entry) rather than sending something stale.
- Digest rendering: the template fallback on AI timeout, per-entry fallback when one line
  fails its structure assertion, and the assertion rejecting a dropped birthday.
- Feedback: vote and reason chips append to the log and never mutate it in place; weight
  derivation is bounded at both ends, neutral under a cold start, decays with age, and is
  exactly reproducible from the log after deleting the derived file.
- Weights are applied by the ranker but never to pinned facts — a fact kind downvoted to the
  floor still sends a birthday.
- Effectiveness attribution: a habit logged after its nudge counts as acted; one logged
  before delivery does not; a nudge for a habit that is logged every day regardless does not
  accumulate false credit.
- `notificationclick` records `openedAt` against the right entry id, and an entry delivered
  but never opened while the app was used is recorded as ignored rather than unknown.
- Service worker handlers under a mocked `self`: malformed payload still shows a
  notification, click focuses an existing client, `pushsubscriptionchange` re-registers.

On the device, because none of the above proves iOS behaves:

1. Install Totem to the Home Screen; confirm Settings reports standalone and the toggle
   is enabled.
2. Grant permission, subscribe, send a test push; confirm it arrives with the right icon
   and title on the lock screen.
3. Tap it; confirm it opens the installed app on the deep-linked view, not a Safari tab.
4. Confirm the app icon badge reflects unread count and clears on read.
5. Schedule a reminder two minutes out and confirm arrival within the tick window.
6. Force a digest run and confirm three facts and correct content, including today's
   birthday.
7. Remove from the Home Screen, send again, and confirm the server marks the subscription
   expired rather than reporting success.
8. Re-add, re-subscribe, confirm recovery.
9. Rate a delivered notification up and then another down with a reason; confirm both land
   in the log and appear in the Logs notifications view.
10. Check whether notification action buttons render on the lock screen for the installed
    web app; if not, confirm the tap-through lands on the bell with the rating controls.

`AGENTS.md` (components table, env keys, status/roadmap, gotchas), `.env.example`,
`SETUP.md` (installing to the Home Screen is now part of first-time setup), and a new
`docs/notifications.md` must be updated in the same change as the behaviour they describe.

## Rollout

Phase 1 is what gets built now. The later phases are specified here so that phase 1's
interfaces are the right shape, not so that they ship together.

**Done, 2026-09-15 — phase 1's server side.** Everything below plus: `notify/store.mjs`
(the queue with claim/finish, plan supersede, dedupe-on-reschedule, catch-up grace,
expiry, device registry with expire-on-410, the ledger, and the append-only feedback log),
`notify/push.mjs` (RFC 8291 encryption and RFC 8292 VAPID with no dependencies, checked
against the RFC's own vector), real `taskFacts` against `todos/service.mjs`, and
`notify/cli.mjs keys`. 103 tests.

**Done, 2026-09-11 — the pure core.** `notify/schedule.mjs` (slots, quiet hours, spacing,
expiry, catch-up, dedupe keys), `notify/categories.mjs` (the routing table above, verbatim),
`notify/plan.mjs` (ranking, weights with pinned exemption, cap, supersede), and
`notify/signals.mjs` (birthdays parsed from `people.md`, daily streaks, weekly
near-target and behind-pace, metric trends; the task collector present and deliberately
empty). 51 tests in `notify/*.test.mjs`, wired into `npm test`. `node notify/cli.mjs
preview [--evening] [--at "YYYY-MM-DD HH:MM"] [--json]` prints the plan the digest would
build from live data. Nothing is wired into `bridge.mjs`, nothing touches the network, and
no subscription exists — this half cannot send, which is why it was safe to build while the
todo port holds `main`.

1. **Plumbing and the internal API — build now.** Manifest, icons, service worker, VAPID,
   subscription store, the queue and its drain inside the existing job tick, `/api/push/*`,
   `/api/notifications*`, `/api/reminders`, `/api/notification-plan/preview`, the Settings
   panel, test push, and the notification centre with a bell. Notifications move out of
   `jobs/store.mjs`. Every existing `notify()` call site starts reaching the phone — a
   failed WHOOP sync becomes visible without any new content being written. **Feedback
   capture ships here too** — thumbs and reason chips in the bell, the Logs notifications
   view, `openedAt` from `notificationclick`, and the append-only feedback log — even
   though no weights are applied yet. At the end of this phase Totem can be told to say
   anything at any time, by any caller, and it will, and every send is rateable.
2. **Digest and planning.** Signal collectors, ranker, the day plan, revalidation, the
   `daily-digest` skill, the two digest jobs, birthdays, habit slippage and near-completion.
   Weight derivation and the ranker multiplier turn on here, against feedback phase 1 has
   been collecting. Depends on nothing the todos work touches; the task collector simply
   returns no facts.
3. **Time-based.** Calendar lead-time alerts, ad-hoc reminders via UI, chat, and MCP.
4. **Tasks — deferred until the local task core lands.** `remindAt` on tasks with
   recurrence, reschedule, and cancel-on-complete; the `task.due` and `task.overdue`
   collectors; the reminder control in the todo detail sheet. This is a caller of the phase-1
   API, not a change to it. Nothing in phases 1–3 may be designed in a way that has to be
   reopened to add it.
5. **Goals.** When goals exist as a first-class object, they get a collector producing both
   `goal.slipping` and `goal.nearcomplete` facts. The weekly-target habits already exercise
   that shape, so the collector interface is proven before the goals feature exists.

## Acceptance criteria

- Totem is installable, installed on the owner's phone, and push arrives on the lock screen
  without the app being open.
- One queue, one ledger, one scheduler tick — no second timer and no second store.
- Every existing `notify()` call site reaches the phone without a new call site being
  written.
- A reminder can be set from a todo, the calendar, web chat, the iOS Shortcut, and MCP, and
  all five land in the same queue.
- The morning digest names a birthday on the day it occurs, every time, including when the
  AI call fails.
- A day with five notable facts produces several notifications spread across the day within
  the cap and spacing settings, not one long push and not five at once.
- A planned nudge whose fact stops being true before its send time does not arrive.
- A second digest run on the same day supersedes the first run's undelivered entries.
- No notification is sent during quiet hours except an `override` category.
- A duplicate, a rescheduled reminder, and a repeatedly failing job each produce one
  notification, not a stream.
- An expired subscription is reported as expired in Settings within one delivery attempt.
- Turning a category off stops it entirely, and the setting survives a bridge restart.
- Disabling push leaves the ledger, the bell, and every job working unchanged.
- Phase 1 ships with no dependency on the task service, and adding task reminders later
  requires a new caller of the reminder API and no change to the queue, categories, or
  delivery path.
- Every delivered notification can be rated from the bell, and every rating is visible in
  the Logs notifications view.
- A repeatedly downvoted fact kind becomes measurably rarer, is never silenced entirely, is
  explained in Settings with the rating count behind it, and is resettable in one click.
- No amount of negative feedback suppresses a birthday or a pending approval.
- Deleting the derived weights file restores neutral behaviour and loses no feedback.
