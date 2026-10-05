// jobs/schedule.mjs — when does a job run next?
//
// Pure functions, no I/O, no clock of their own: every entry point takes the
// "now" it should reason from. That's what makes the scheduler testable, and it's
// the whole reason this is a separate module — the old schedulers compared a
// formatted "HH:MM" string against the current minute, so a job whose minute the
// box slept through simply never ran that day and nothing said so.
//
// Everything is computed in a real IANA timezone rather than the server's local
// time, because "every day at 07:30" means 07:30 where the owner is, across DST.

// A schedule is one of:
//   { type: 'daily',    time: 'HH:MM' }
//   { type: 'weekly',   time: 'HH:MM', days: [0..6] }   // 0 = Sunday, local
//   { type: 'interval', everyMinutes: 1..10080 }
//   { type: 'window',   from: 'HH:MM', to: 'HH:MM', everyMinutes: 1..1440, days: [0..6] }
export const SCHEDULE_TYPES = ['daily', 'weekly', 'interval', 'window']

const MIN_INTERVAL = 1
const MAX_INTERVAL = 7 * 24 * 60 // a week, in minutes
const MAX_WINDOW_STEP = 24 * 60  // a window never spans more than a day
const MINUTES_PER_DAY = 24 * 60
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function normalizeTime(value, fallback = '08:00') {
  const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return fallback
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) return fallback
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

// Coerce whatever the client sent into a schedule the engine can always compute
// from. Bad input degrades to a sane daily schedule rather than throwing, so a
// malformed saved job still runs instead of silently disappearing from the loop.
export function normalizeSchedule(raw, fallbackTime = '08:00') {
  const type = SCHEDULE_TYPES.includes(raw?.type) ? raw.type : 'daily'
  if (type === 'interval') {
    const n = Math.round(Number(raw?.everyMinutes))
    return {
      type: 'interval',
      everyMinutes: Number.isFinite(n) ? Math.min(Math.max(n, MIN_INTERVAL), MAX_INTERVAL) : 60,
    }
  }
  if (type === 'window') {
    const from = normalizeTime(raw?.from, normalizeTime(raw?.time, fallbackTime))
    // A window that ends before it starts is read as crossing midnight (22:00 to
    // 02:00 is a four-hour overnight window), because that is the only reading
    // under which the user's two times both survive. `to === from` is a window of
    // zero length, which is one slot — the same as a daily schedule, and it still
    // runs rather than becoming a schedule that can never fire.
    const to = normalizeTime(raw?.to, from)
    const n = Math.round(Number(raw?.everyMinutes))
    return {
      type: 'window',
      from,
      to,
      everyMinutes: Number.isFinite(n) ? Math.min(Math.max(n, MIN_INTERVAL), MAX_WINDOW_STEP) : 30,
      days: normalizeDays(raw?.days),
    }
  }
  const time = normalizeTime(raw?.time, fallbackTime)
  if (type === 'weekly') {
    return { type: 'weekly', time, days: normalizeDays(raw?.days) }
  }
  return { type: 'daily', time }
}

// No days selected would mean "never", which is a trap dressed as a schedule. An
// empty or unusable set means every day — same as daily, and it still runs.
function normalizeDays(raw) {
  const days = Array.isArray(raw)
    ? [...new Set(raw.map((d) => Math.round(Number(d))).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : []
  return days.length ? days : [0, 1, 2, 3, 4, 5, 6]
}

// How many minutes a window covers. 0 for a zero-length window (one slot).
function windowSpanMinutes(s) {
  const [fh, fm] = s.from.split(':').map(Number)
  const [th, tm] = s.to.split(':').map(Number)
  return ((th * 60 + tm) - (fh * 60 + fm) + MINUTES_PER_DAY) % MINUTES_PER_DAY
}

// How many times a window schedule fires per active day. Exported because "every
// 30 minutes from 7:00 to 11:30" is not obviously 10 runs, and a poll you are
// about to switch on is worth being able to count before you do.
export function windowSlotCount(schedule) {
  const s = normalizeSchedule(schedule)
  if (s.type !== 'window') return null
  return Math.floor(windowSpanMinutes(s) / s.everyMinutes) + 1
}

// ---------------------------------------------------------------------------
// Timezone math. Node ships full ICU, so Intl is the only tool needed — but it
// only converts *from* an instant, never *to* one. These three helpers invert it.
// ---------------------------------------------------------------------------

// Constructing an Intl.DateTimeFormat is orders of magnitude dearer than using
// one, and every zonedToUtc call needs three. Daily and weekly only ever walk ~9
// candidates so it never mattered; a window walks one per slot, so cache by zone.
const formatterCache = new Map()
function formatterFor(tz) {
  let f = formatterCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      weekday: 'short',
    })
    formatterCache.set(tz, f)
  }
  return f
}

function partsIn(ts, tz) {
  const p = formatterFor(tz).formatToParts(new Date(ts))
  const out = {}
  for (const part of p) out[part.type] = part.value
  return out
}

// The wall clock in `tz` at instant `ts`, reinterpreted as if it were UTC. The
// difference between this and `ts` is the zone's offset at that instant.
function wallClockAsUtc(ts, tz) {
  const p = partsIn(ts, tz)
  // 'en-CA' renders midnight as 24 rather than 00 in some ICU versions.
  const hour = Number(p.hour) % 24
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second))
}

function offsetMs(ts, tz) {
  return wallClockAsUtc(ts, tz) - ts
}

// Turn a local wall-clock date+time in `tz` into an instant. Two passes: the
// first guesses the offset from the naive timestamp, the second corrects it using
// the offset actually in force at the guessed instant — which is what makes the
// DST boundaries land right.
//
// The third step is the one that's easy to miss. On a spring-forward day the
// requested time may not exist at all (02:30 is skipped entirely), and the
// two-pass result then silently lands an hour *before* what was asked for —
// a 02:30 job firing at 01:30. So the answer is verified by formatting it back:
// if it doesn't read as the time requested, the request fell in the gap and is
// shifted forward instead, which is both what a person expects and what
// Temporal's 'compatible' disambiguation does.
//
// A time that happens twice (fall back) resolves to the first occurrence. Which
// one hardly matters — nextRunAfter is strictly increasing, so it can never hand
// back a slot it already returned — but first is the conventional choice.
export function zonedToUtc({ year, month, day, hour, minute }, tz) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  const coarse = offsetMs(naive, tz)
  const refined = offsetMs(naive - coarse, tz)
  const ts = naive - refined
  // Round-trips cleanly? Then the local time exists and this is it.
  if (wallClockAsUtc(ts, tz) === naive) return ts
  // It doesn't exist. Use the offset from before the transition, which pushes the
  // run past the gap by exactly the gap's length.
  return naive - coarse
}

export function localParts(ts, tz) {
  const p = partsIn(ts, tz)
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: DAY_ABBR.indexOf(p.weekday),
  }
}

// ---------------------------------------------------------------------------
// The one function everything else exists to support.
// ---------------------------------------------------------------------------

// The next instant strictly after `from` at which `schedule` fires.
// `lastRunAt` only matters for intervals, where "every 90 minutes" is measured
// from the previous run rather than from an arbitrary wall-clock grid.
export function nextRunAfter(schedule, from, tz, lastRunAt = null) {
  const s = normalizeSchedule(schedule)

  if (s.type === 'interval') {
    const step = s.everyMinutes * 60_000
    // Anchor on the last run so intervals don't restart their clock every time
    // the bridge restarts. Advance in whole steps until we're past `from`, which
    // also means a long outage schedules one next run, not a backlog of them.
    let next = (Number.isFinite(lastRunAt) && lastRunAt ? lastRunAt : from) + step
    if (next <= from) {
      const behind = Math.ceil((from - next + 1) / step)
      next += behind * step
    }
    return next
  }

  if (s.type === 'window') return nextWindowRunAfter(s, from, tz)

  const [hh, mm] = s.time.split(':').map(Number)
  const days = s.type === 'weekly' ? s.days : null
  const start = localParts(from, tz)

  // Walk forward a day at a time. Eight iterations covers "next matching weekday"
  // for any day set, plus one for today-already-passed.
  for (let i = 0; i <= 8; i++) {
    // Build the candidate date by stepping the *local* calendar day, then convert.
    const base = Date.UTC(start.year, start.month - 1, start.day + i)
    const d = new Date(base)
    const cand = zonedToUtc(
      { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: hh, minute: mm },
      tz,
    )
    if (cand <= from) continue
    if (days) {
      // Check the weekday of the resolved instant in the target zone, not of the
      // naive date — near midnight those can differ.
      const wd = localParts(cand, tz).weekday
      if (!days.includes(wd)) continue
    }
    return cand
  }
  // Unreachable for a normalized schedule (weekly always has >= 1 day), but a
  // scheduler that returns null would stall silently. Fall back to a day out.
  return from + 24 * 60 * 60_000
}

// A window fires on a wall-clock grid anchored at `from`: 07:00, 07:30, 08:00 …
// up to and including `to`. Anchoring on the grid rather than on the last run
// (which is what `interval` does) is the whole point — a poll you asked to happen
// at half past every hour should still be at half past after a restart, and the
// slots should be the same ten instants every morning.
//
// Each slot is resolved as a wall-clock time in `tz`, not as `from + k * step` in
// milliseconds, so a window containing a DST switch keeps its posted times
// instead of sliding an hour. Slots past midnight roll into the following day,
// which is what makes an overnight window work.
function nextWindowRunAfter(s, from, tz) {
  const [fh, fm] = s.from.split(':').map(Number)
  const fromMin = fh * 60 + fm
  const span = windowSpanMinutes(s)
  const maxK = Math.floor(span / s.everyMinutes)
  const start = localParts(from, tz)

  // `i` steps the day the window *starts* on, so an overnight window belongs to
  // the day it began — Friday 22:00–02:00 runs on a Friday, not partly Saturday.
  // Nine days covers any day set, plus one for a window already finished today.
  for (let i = -1; i <= 8; i++) {
    const base = new Date(Date.UTC(start.year, start.month - 1, start.day + i))
    const dayStart = zonedToUtc(
      { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate(), hour: fh, minute: fm },
      tz,
    )
    // The day set is checked against the resolved start instant, not the naive
    // date, for the same reason the weekly branch does it: near midnight in a
    // zone with an offset they can disagree.
    if (!s.days.includes(localParts(dayStart, tz).weekday)) continue
    for (let k = 0; k <= maxK; k++) {
      const minute = fromMin + k * s.everyMinutes
      const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + Math.floor(minute / MINUTES_PER_DAY)))
      const cand = zonedToUtc(
        {
          year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
          hour: Math.floor((minute % MINUTES_PER_DAY) / 60), minute: minute % 60,
        },
        tz,
      )
      if (cand > from) return cand
    }
  }
  // Unreachable for a normalized window (days always has >= 1 entry), but a
  // scheduler that returns null would stall silently.
  return from + 24 * 60 * 60_000
}

// Human wording for the UI and for log lines.
export function describeSchedule(schedule) {
  const s = normalizeSchedule(schedule)
  if (s.type === 'interval') {
    const n = s.everyMinutes
    if (n % (24 * 60) === 0) {
      const d = n / (24 * 60)
      return d === 1 ? 'Every 24 hours' : `Every ${d} days`
    }
    if (n % 60 === 0) {
      const h = n / 60
      return h === 1 ? 'Every hour' : `Every ${h} hours`
    }
    if (n > 60) return `Every ${Math.floor(n / 60)}h ${n % 60}m`
    return n === 1 ? 'Every minute' : `Every ${n} minutes`
  }
  if (s.type === 'window') {
    const every = describeStep(s.everyMinutes)
    const range = `${formatTime(s.from)}\u2013${formatTime(s.to)}`
    const when = s.to === s.from ? formatTime(s.from) : range
    const scope = describeDays(s.days, { plural: true })
    const body = s.to === s.from ? `at ${when}` : `${every}, ${when}`
    return scope ? `${scope}, ${body}` : body.charAt(0).toUpperCase() + body.slice(1)
  }
  const at = formatTime(s.time)
  if (s.type === 'weekly') {
    return `${describeDays(s.days) || 'Every day'} at ${at}`
  }
  return `Every day at ${at}`
}

// "Weekdays" / "Mon, Wed, Fri" / null when it's simply every day. Shared by the
// weekly and window wordings so the same day set never reads two different ways.
function describeDays(days, { plural = false } = {}) {
  const d = days || []
  if (d.length >= 7) return null
  if (d.length === 5 && [1, 2, 3, 4, 5].every((x) => d.includes(x))) return 'Weekdays'
  if (d.length === 2 && d.includes(0) && d.includes(6)) return 'Weekends'
  // "Every Friday at 9:00" reads well; "Every Friday, every hour" does not, so a
  // window asks for the plural form instead.
  if (d.length === 1) return plural ? `${DAY_NAMES[d[0]]}s` : `Every ${DAY_NAMES[d[0]]}`
  return d.map((x) => DAY_ABBR[x]).join(', ')
}

// "every 30 minutes" / "every hour" / "every 1h 30m" — lower case, for use inside
// a longer sentence.
function describeStep(n) {
  if (n % 60 === 0) {
    const h = n / 60
    return h === 1 ? 'every hour' : `every ${h} hours`
  }
  if (n > 60) return `every ${Math.floor(n / 60)}h ${n % 60}m`
  return n === 1 ? 'every minute' : `every ${n} minutes`
}

function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  const suffix = h < 12 ? 'AM' : 'PM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`
}

// A job is due when its scheduled instant has arrived. `graceMs` is how long
// after the fact a missed run is still worth doing — the fix for the old
// exact-minute compare, where a restart across the scheduled minute lost the run
// with no trace. Beyond the grace window the run is abandoned deliberately and
// reported as skipped, so a box that was off for a week doesn't fire a week of
// backlogged agent prompts on boot.
export function dueState(nextRunAt, now, graceMs) {
  if (!Number.isFinite(nextRunAt)) return 'unscheduled'
  if (now < nextRunAt) return 'pending'
  if (now - nextRunAt <= graceMs) return 'due'
  return 'missed'
}
