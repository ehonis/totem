// Run with: node --test jobs/
//
// The schedule engine is the one part of the job system where a silent
// off-by-one means a job never runs, which is the exact failure this whole
// change exists to remove. So it gets real tests, including the DST boundaries.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeSchedule, normalizeTime, nextRunAfter, describeSchedule, dueState, localParts, zonedToUtc,
  windowSlotCount,
} from './schedule.mjs'

const TZ = 'America/New_York'

// Read an instant back as a local wall clock, so assertions read like the UI.
const wall = (ts) => {
  const p = localParts(ts, TZ)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}
const at = (s) => {
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/)
  return zonedToUtc({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] }, TZ)
}

test('normalizeTime rejects nonsense and keeps valid times', () => {
  assert.equal(normalizeTime('7:5'), '08:00')
  assert.equal(normalizeTime('07:05'), '07:05')
  assert.equal(normalizeTime('7:05'), '07:05')
  assert.equal(normalizeTime('24:00'), '08:00')
  assert.equal(normalizeTime('23:59'), '23:59')
  assert.equal(normalizeTime('11:60'), '08:00')
  assert.equal(normalizeTime(undefined, '11:00'), '11:00')
})

test('normalizeSchedule never produces a schedule that cannot fire', () => {
  // An empty weekly day set would mean "never" — it must widen to every day.
  assert.deepEqual(normalizeSchedule({ type: 'weekly', time: '09:00', days: [] }).days, [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(normalizeSchedule({ type: 'weekly', time: '09:00', days: [9, -1, 3, 3] }).days, [3])
  assert.equal(normalizeSchedule({ type: 'garbage' }).type, 'daily')
  assert.equal(normalizeSchedule({ type: 'interval', everyMinutes: 0 }).everyMinutes, 1)
  assert.equal(normalizeSchedule({ type: 'interval', everyMinutes: 999999 }).everyMinutes, 7 * 24 * 60)
  assert.equal(normalizeSchedule({ type: 'interval', everyMinutes: 'x' }).everyMinutes, 60)
})

test('daily: picks today when the time is still ahead, tomorrow when it has passed', () => {
  const sched = { type: 'daily', time: '11:00' }
  assert.equal(wall(nextRunAfter(sched, at('2026-08-18 07:55'), TZ)), '2026-08-18 11:00')
  assert.equal(wall(nextRunAfter(sched, at('2026-08-18 11:30'), TZ)), '2026-08-19 11:00')
})

test('daily: the scheduled minute itself is not re-fired', () => {
  // Strictly-after is what stops a job from running twice inside one minute.
  const sched = { type: 'daily', time: '11:00' }
  assert.equal(wall(nextRunAfter(sched, at('2026-08-18 11:00'), TZ)), '2026-08-19 11:00')
})

test('daily: crosses a month and a year boundary', () => {
  assert.equal(wall(nextRunAfter({ type: 'daily', time: '06:30' }, at('2026-08-31 09:00'), TZ)), '2026-09-01 06:30')
  assert.equal(wall(nextRunAfter({ type: 'daily', time: '06:30' }, at('2026-12-31 09:00'), TZ)), '2027-01-01 06:30')
})

test('daily: a 07:30 job stays at 07:30 local through a full year of DST', () => {
  // Asserted as a property rather than against hardcoded transition dates, which
  // is the part a human gets wrong: over 365 consecutive runs the wall clock must
  // never budge off 07:30, while exactly one gap shortens to 23h and one
  // stretches to 25h as the clocks move.
  const sched = { type: 'daily', time: '07:30' }
  let ts = nextRunAfter(sched, at('2026-06-01 09:00'), TZ)
  const gaps = []
  for (let i = 0; i < 365; i++) {
    const next = nextRunAfter(sched, ts, TZ)
    const p = localParts(next, TZ)
    assert.equal(`${p.hour}:${p.minute}`, '7:30', `drifted on iteration ${i}`)
    gaps.push((next - ts) / 3_600_000)
    ts = next
  }
  assert.equal(gaps.filter((g) => g === 23).length, 1, 'exactly one spring-forward day')
  assert.equal(gaps.filter((g) => g === 25).length, 1, 'exactly one fall-back day')
  assert.equal(gaps.filter((g) => g === 24).length, 363)
})

test('daily: a time inside the spring-forward gap still fires that day', () => {
  // 02:30 does not exist on 2027-03-14 in New York. Skipping the day would be a
  // silently-lost run, so it resolves forward into the hour that does exist.
  const next = nextRunAfter({ type: 'daily', time: '02:30' }, at('2027-03-13 12:00'), TZ)
  const p = localParts(next, TZ)
  assert.equal(p.day, 14)
  assert.equal(p.hour, 3)
  assert.equal(p.minute, 30)
})

test('daily: an ambiguous fall-back time never repeats a slot', () => {
  // 01:30 happens twice on 2026-11-01. Whichever is chosen, the following call
  // must move on rather than hand back the second occurrence of the same slot.
  const sched = { type: 'daily', time: '01:30' }
  const first = nextRunAfter(sched, at('2026-10-31 12:00'), TZ)
  const second = nextRunAfter(sched, first, TZ)
  assert.ok(second > first, 'next run must strictly advance')
  assert.equal(localParts(second, TZ).day, 2)
})

test('weekly: finds the next selected weekday', () => {
  // 2026-08-18 is a Tuesday.
  const monWedFri = { type: 'weekly', time: '09:00', days: [1, 3, 5] }
  assert.equal(wall(nextRunAfter(monWedFri, at('2026-08-18 10:00'), TZ)), '2026-08-19 09:00')
  assert.equal(wall(nextRunAfter(monWedFri, at('2026-08-19 10:00'), TZ)), '2026-08-21 09:00')
  // Friday after the run wraps to Monday.
  assert.equal(wall(nextRunAfter(monWedFri, at('2026-08-21 10:00'), TZ)), '2026-08-24 09:00')
})

test('weekly: a single weekday lands a full week later, not tomorrow', () => {
  const sundays = { type: 'weekly', time: '20:00', days: [0] }
  const first = nextRunAfter(sundays, at('2026-08-18 10:00'), TZ)
  assert.equal(wall(first), '2026-08-23 20:00')
  assert.equal(wall(nextRunAfter(sundays, first, TZ)), '2026-08-30 20:00')
})

test('weekly: earlier today still counts when the time has not passed', () => {
  const tuesdays = { type: 'weekly', time: '23:00', days: [2] }
  assert.equal(wall(nextRunAfter(tuesdays, at('2026-08-18 07:00'), TZ)), '2026-08-18 23:00')
})

test('weekly: a near-midnight slot is matched on the resolved instant', () => {
  const sched = { type: 'weekly', time: '00:05', days: [1] } // Mondays
  assert.equal(wall(nextRunAfter(sched, at('2026-08-18 07:00'), TZ)), '2026-08-24 00:05')
})

test('interval: measured from the last run so restarts do not reset the clock', () => {
  const sched = { type: 'interval', everyMinutes: 90 }
  const now = at('2026-08-18 08:00')
  const lastRun = at('2026-08-18 07:30')
  assert.equal(wall(nextRunAfter(sched, now, TZ, lastRun)), '2026-08-18 09:00')
  // With no history it starts one interval out from now.
  assert.equal(wall(nextRunAfter(sched, now, TZ, null)), '2026-08-18 09:30')
})

test('interval: a long outage schedules one next run, not a backlog', () => {
  const sched = { type: 'interval', everyMinutes: 60 }
  const lastRun = at('2026-08-15 08:00') // three days ago
  const now = at('2026-08-18 08:10')
  const next = nextRunAfter(sched, now, TZ, lastRun)
  assert.ok(next > now, 'must be in the future')
  assert.equal(wall(next), '2026-08-18 09:00')
})

test('dueState separates a run worth catching up from one worth abandoning', () => {
  const grace = 2 * 60 * 60_000 // two hours
  const t = at('2026-08-18 11:00')
  assert.equal(dueState(t, t - 60_000, grace), 'pending')
  assert.equal(dueState(t, t, grace), 'due')
  // Bridge restarted 40 minutes late: the old code lost this run entirely.
  assert.equal(dueState(t, t + 40 * 60_000, grace), 'due')
  assert.equal(dueState(t, t + 3 * 60 * 60_000, grace), 'missed')
  assert.equal(dueState(null, t, grace), 'unscheduled')
})

test('describeSchedule reads like the UI label', () => {
  assert.equal(describeSchedule({ type: 'daily', time: '07:30' }), 'Every day at 7:30 AM')
  assert.equal(describeSchedule({ type: 'daily', time: '00:05' }), 'Every day at 12:05 AM')
  assert.equal(describeSchedule({ type: 'daily', time: '12:00' }), 'Every day at 12:00 PM')
  assert.equal(describeSchedule({ type: 'weekly', time: '09:00', days: [1, 2, 3, 4, 5] }), 'Weekdays at 9:00 AM')
  assert.equal(describeSchedule({ type: 'weekly', time: '09:00', days: [0, 6] }), 'Weekends at 9:00 AM')
  assert.equal(describeSchedule({ type: 'weekly', time: '20:00', days: [0] }), 'Every Sunday at 8:00 PM')
  assert.equal(describeSchedule({ type: 'weekly', time: '20:00', days: [1, 4] }), 'Mon, Thu at 8:00 PM')
  assert.equal(describeSchedule({ type: 'weekly', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6] }), 'Every day at 8:00 AM')
  assert.equal(describeSchedule({ type: 'interval', everyMinutes: 1 }), 'Every minute')
  assert.equal(describeSchedule({ type: 'interval', everyMinutes: 30 }), 'Every 30 minutes')
  assert.equal(describeSchedule({ type: 'interval', everyMinutes: 60 }), 'Every hour')
  assert.equal(describeSchedule({ type: 'interval', everyMinutes: 240 }), 'Every 4 hours')
  assert.equal(describeSchedule({ type: 'interval', everyMinutes: 90 }), 'Every 1h 30m')
  assert.equal(describeSchedule({ type: 'interval', everyMinutes: 1440 }), 'Every 24 hours')
})

test('every schedule type advances monotonically over a year of iterations', () => {
  // The property that actually matters: whatever the schedule, repeatedly asking
  // for "the next run after the one you just gave me" must never stall or go
  // backwards. A stall is a job that stops running and says nothing.
  for (const sched of [
    { type: 'daily', time: '07:30' },
    { type: 'daily', time: '02:30' },
    { type: 'daily', time: '01:30' },
    { type: 'weekly', time: '09:00', days: [1, 3, 5] },
    { type: 'weekly', time: '00:00', days: [0] },
    { type: 'interval', everyMinutes: 97 },
    { type: 'window', from: '07:00', to: '11:30', everyMinutes: 30 },
    { type: 'window', from: '01:00', to: '04:00', everyMinutes: 30 },   // straddles both DST switches
    { type: 'window', from: '22:00', to: '02:00', everyMinutes: 45 },   // crosses midnight
    { type: 'window', from: '09:00', to: '17:00', everyMinutes: 7, days: [1, 2, 3, 4, 5] },
    { type: 'window', from: '09:00', to: '09:00', everyMinutes: 30 },   // zero-length: one slot
  ]) {
    let ts = at('2026-01-01 00:00')
    for (let i = 0; i < 400; i++) {
      const next = nextRunAfter(sched, ts, TZ, ts)
      assert.ok(next > ts, `${JSON.stringify(sched)} stalled at iteration ${i}`)
      ts = next
    }
  }
})

// ---------------------------------------------------------------------------
// Windows — "poll every 30 minutes between 07:00 and 11:30".
//
// The failure mode this type invites is a schedule that looks like a poll but
// silently fires once, or fires forever past the end of its window. Both are
// tested by walking the actual slots rather than by asserting on one call.
// ---------------------------------------------------------------------------

const WHOOP = { type: 'window', from: '07:00', to: '11:30', everyMinutes: 30 }

test('a window fires on a wall-clock grid anchored at `from`, and stops at `to`', () => {
  let ts = at('2026-09-09 06:00')
  const fired = []
  for (let i = 0; i < 11; i++) {
    ts = nextRunAfter(WHOOP, ts, TZ)
    fired.push(wall(ts))
  }
  assert.deepEqual(fired, [
    '2026-09-09 07:00', '2026-09-09 07:30', '2026-09-09 08:00', '2026-09-09 08:30',
    '2026-09-09 09:00', '2026-09-09 09:30', '2026-09-09 10:00', '2026-09-09 10:30',
    '2026-09-09 11:00', '2026-09-09 11:30',
    // 12:00 is past `to`, so the eleventh run is tomorrow's first slot, not a
    // continuation of the interval. This is the difference from type 'interval'.
    '2026-09-10 07:00',
  ])
})

test('a window is a grid, not an offset from the last run', () => {
  // Asking from 08:10 must land on 08:30 — the grid — and NOT on 08:40, which is
  // what measuring from "now" would give. This is what keeps the slots the same
  // ten instants every morning regardless of restarts or a late run.
  assert.equal(wall(nextRunAfter(WHOOP, at('2026-09-09 08:10'), TZ)), '2026-09-09 08:30')
  assert.equal(wall(nextRunAfter(WHOOP, at('2026-09-09 08:29'), TZ)), '2026-09-09 08:30')
  // lastRunAt is accepted for signature compatibility and must be ignored here.
  assert.equal(wall(nextRunAfter(WHOOP, at('2026-09-09 08:10'), TZ, at('2026-09-09 08:05'))), '2026-09-09 08:30')
})

test('a window past its end waits for the next active day', () => {
  assert.equal(wall(nextRunAfter(WHOOP, at('2026-09-09 11:31'), TZ)), '2026-09-10 07:00')
  assert.equal(wall(nextRunAfter(WHOOP, at('2026-09-09 23:59'), TZ)), '2026-09-10 07:00')
  // 2026-09-11 is a Friday; weekdays-only skips the weekend entirely.
  const weekdays = { ...WHOOP, days: [1, 2, 3, 4, 5] }
  assert.equal(wall(nextRunAfter(weekdays, at('2026-09-11 12:00'), TZ)), '2026-09-14 07:00')
})

test('a window that crosses midnight belongs to the day it started on', () => {
  // Friday 22:00-02:00 hourly: the 00:00 and 01:00 slots land on Saturday but are
  // part of Friday's window, so a Friday-only schedule still fires them.
  const overnight = { type: 'window', from: '22:00', to: '02:00', everyMinutes: 60, days: [5] }
  let ts = at('2026-09-11 21:00') // a Friday
  const fired = []
  for (let i = 0; i < 6; i++) {
    ts = nextRunAfter(overnight, ts, TZ)
    fired.push(wall(ts))
  }
  assert.deepEqual(fired, [
    '2026-09-11 22:00', '2026-09-11 23:00', '2026-09-12 00:00',
    '2026-09-12 01:00', '2026-09-12 02:00',
    '2026-09-18 22:00', // the following Friday, not Saturday
  ])
  // Asked mid-window, after midnight, it must find the slot from yesterday's
  // window rather than jumping a week.
  assert.equal(wall(nextRunAfter(overnight, at('2026-09-12 00:30'), TZ)), '2026-09-12 01:00')
})

test('a window keeps its posted times across both DST switches', () => {
  const w = { type: 'window', from: '01:00', to: '04:00', everyMinutes: 30 }
  // Spring forward: 02:00 and 02:30 do not exist. They resolve forward onto
  // 03:00/03:30, which already have slots, and the strictly-increasing contract
  // collapses the duplicates rather than firing twice.
  let ts = at('2026-03-08 00:30')
  const spring = []
  for (let i = 0; i < 5; i++) { ts = nextRunAfter(w, ts, TZ); spring.push(wall(ts)) }
  assert.deepEqual(spring, ['2026-03-08 01:00', '2026-03-08 01:30', '2026-03-08 03:00', '2026-03-08 03:30', '2026-03-08 04:00'])
  // Fall back: 01:00 and 01:30 happen twice. Each slot is the first occurrence,
  // so the window still fires seven times and never goes backwards.
  ts = at('2026-11-01 00:30')
  const fall = []
  for (let i = 0; i < 7; i++) { ts = nextRunAfter(w, ts, TZ); fall.push(wall(ts)) }
  assert.deepEqual(fall, [
    '2026-11-01 01:00', '2026-11-01 01:30', '2026-11-01 02:00', '2026-11-01 02:30',
    '2026-11-01 03:00', '2026-11-01 03:30', '2026-11-01 04:00',
  ])
})

test('normalizeSchedule cannot produce a window that never fires', () => {
  const s = normalizeSchedule({ type: 'window' })
  assert.equal(s.from, '08:00')
  assert.equal(s.to, '08:00')          // no end given: a single slot, not "never"
  assert.equal(s.everyMinutes, 30)
  assert.deepEqual(s.days, [0, 1, 2, 3, 4, 5, 6])
  // Zero or negative steps would be an infinite slot list.
  assert.equal(normalizeSchedule({ type: 'window', everyMinutes: 0 }).everyMinutes, 1)
  assert.equal(normalizeSchedule({ type: 'window', everyMinutes: -5 }).everyMinutes, 1)
  // A step longer than a day would put the second slot outside any window.
  assert.equal(normalizeSchedule({ type: 'window', everyMinutes: 99999 }).everyMinutes, 24 * 60)
  // An empty day set widens rather than saving something that can never fire.
  assert.deepEqual(normalizeSchedule({ type: 'window', days: [] }).days, [0, 1, 2, 3, 4, 5, 6])
  // `time` is accepted as an alias for `from`, so a daily job converted to a
  // window in the UI keeps the time it already had.
  assert.equal(normalizeSchedule({ type: 'window', time: '07:15' }).from, '07:15')
})

test('windowSlotCount says how many runs a window really is', () => {
  assert.equal(windowSlotCount(WHOOP), 10)
  assert.equal(windowSlotCount({ type: 'window', from: '07:00', to: '11:00', everyMinutes: 60 }), 5)
  assert.equal(windowSlotCount({ type: 'window', from: '22:00', to: '02:00', everyMinutes: 60 }), 5)
  assert.equal(windowSlotCount({ type: 'window', from: '09:00', to: '09:00', everyMinutes: 30 }), 1)
  // A step that does not divide the span stops before overshooting `to`.
  assert.equal(windowSlotCount({ type: 'window', from: '07:00', to: '08:00', everyMinutes: 25 }), 3)
  assert.equal(windowSlotCount({ type: 'daily', time: '07:00' }), null)
})

test('describeSchedule reads a window back as a sentence', () => {
  assert.equal(describeSchedule(WHOOP), 'Every 30 minutes, 7:00 AM\u201311:30 AM')
  assert.equal(describeSchedule({ ...WHOOP, days: [1, 2, 3, 4, 5] }), 'Weekdays, every 30 minutes, 7:00 AM\u201311:30 AM')
  assert.equal(describeSchedule({ ...WHOOP, days: [0, 6] }), 'Weekends, every 30 minutes, 7:00 AM\u201311:30 AM')
  assert.equal(describeSchedule({ ...WHOOP, days: [5] }), 'Fridays, every 30 minutes, 7:00 AM\u201311:30 AM')
  assert.equal(describeSchedule({ type: 'window', from: '22:00', to: '02:00', everyMinutes: 60 }), 'Every hour, 10:00 PM\u20132:00 AM')
  assert.equal(describeSchedule({ type: 'window', from: '09:00', to: '09:00', everyMinutes: 30 }), 'At 9:00 AM')
})
