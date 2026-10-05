// Run with: node --test notify/
//
// The failure this module exists to prevent is a notification that arrives at the
// wrong moment — at 3am, or an hour after it mattered, or four at once. Each of
// those is a silent trust-killer rather than an error, so they get real tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { localParts, zonedToUtc } from '../jobs/schedule.mjs'
import {
  normalizeQuietHours, normalizePlanSettings, inQuietHours, nextAllowedTime, applyQuietHours,
  spaceOut, deliveryState, lateSuffix, resolveTimeOn, dedupeKey, dayKey, DEFAULT_SLOTS,
  DEFAULT_PLAN_SETTINGS,
} from './schedule.mjs'

const TZ = 'America/New_York'
const wall = (ts) => {
  const p = localParts(ts, TZ)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}
const at = (s) => {
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/)
  return zonedToUtc({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] }, TZ)
}
const QUIET = { start: '22:00', end: '07:00' }

test('quiet hours that cross midnight are read as one window', () => {
  assert.equal(inQuietHours(at('2026-09-11 23:30'), QUIET, TZ), true)
  assert.equal(inQuietHours(at('2026-09-11 02:00'), QUIET, TZ), true)
  assert.equal(inQuietHours(at('2026-09-11 06:59'), QUIET, TZ), true)
  assert.equal(inQuietHours(at('2026-09-11 07:00'), QUIET, TZ), false)
  assert.equal(inQuietHours(at('2026-09-11 21:59'), QUIET, TZ), false)
})

test('a daytime-only quiet window still works', () => {
  const q = { start: '09:00', end: '17:00' }
  assert.equal(inQuietHours(at('2026-09-11 12:00'), q, TZ), true)
  assert.equal(inQuietHours(at('2026-09-11 08:59'), q, TZ), false)
  assert.equal(inQuietHours(at('2026-09-11 17:00'), q, TZ), false)
})

test('quiet hours equal to zero length mean no quiet hours, not silence forever', () => {
  // The trap this avoids is the mirror of an empty weekly day set in
  // jobs/schedule: a setting that can never deliver, which reads as a broken app.
  assert.equal(normalizeQuietHours({ start: '22:00', end: '22:00' }), null)
  assert.equal(inQuietHours(at('2026-09-11 23:30'), null, TZ), false)
})

test('nextAllowedTime moves forward to the end of quiet hours and never backwards', () => {
  assert.equal(wall(nextAllowedTime(at('2026-09-11 23:30'), QUIET, TZ)), '2026-09-12 07:00')
  assert.equal(wall(nextAllowedTime(at('2026-09-12 02:00'), QUIET, TZ)), '2026-09-12 07:00')
  // Already allowed: untouched.
  const noon = at('2026-09-11 12:00')
  assert.equal(nextAllowedTime(noon, QUIET, TZ), noon)
})

test('quiet-hours policy: defer shifts, override sends, suppress drops', () => {
  const t = at('2026-09-11 23:30')
  assert.equal(wall(applyQuietHours(t, 'defer', QUIET, TZ).deliverAt), '2026-09-12 07:00')
  assert.equal(applyQuietHours(t, 'defer', QUIET, TZ).action, 'defer')
  assert.equal(applyQuietHours(t, 'override', QUIET, TZ).deliverAt, t)
  assert.equal(applyQuietHours(t, 'suppress', QUIET, TZ).action, 'suppress')
  // Outside quiet hours every policy is simply a send.
  const noon = at('2026-09-11 12:00')
  assert.equal(applyQuietHours(noon, 'suppress', QUIET, TZ).action, 'send')
})

test('spaceOut keeps a burst of facts apart', () => {
  const now = at('2026-09-11 07:00')
  const out = spaceOut(
    [
      { id: 'a', deliverAt: at('2026-09-11 07:15'), quietHours: 'defer' },
      { id: 'b', deliverAt: at('2026-09-11 07:15'), quietHours: 'defer' },
      { id: 'c', deliverAt: at('2026-09-11 07:20'), quietHours: 'defer' },
    ],
    { minGapMinutes: 90, quietHours: QUIET, tz: TZ, now },
  )
  assert.deepEqual(out.map((x) => wall(x.deliverAt)), [
    '2026-09-11 07:15', '2026-09-11 08:45', '2026-09-11 10:15',
  ])
})

test('a slot already past becomes the next drain, not a delivery dated yesterday', () => {
  const now = at('2026-09-11 20:30')
  const out = spaceOut(
    [{ id: 'a', deliverAt: at('2026-09-11 07:15'), quietHours: 'defer' }],
    { minGapMinutes: 90, quietHours: QUIET, tz: TZ, now },
  )
  assert.equal(out[0].deliverAt, now)
})

test('spacing that pushes an entry into quiet hours defers it and keeps the gap', () => {
  const now = at('2026-09-11 21:00')
  const out = spaceOut(
    [
      { id: 'a', deliverAt: at('2026-09-11 21:00'), quietHours: 'defer' },
      { id: 'b', deliverAt: at('2026-09-11 21:00'), quietHours: 'defer' },
      { id: 'c', deliverAt: at('2026-09-11 21:00'), quietHours: 'defer' },
    ],
    { minGapMinutes: 90, quietHours: QUIET, tz: TZ, now },
  )
  const times = out.map((x) => wall(x.deliverAt))
  assert.equal(times[0], '2026-09-11 21:00')
  // 22:30 is inside quiet hours, so it defers to the morning; the third then has
  // to clear the gap from the deferred one, not from where it wanted to be.
  assert.equal(times[1], '2026-09-12 07:00')
  assert.equal(times[2], '2026-09-12 08:30')
  // Forward-only: the order the planner sorted them in survives.
  assert.ok(out[0].deliverAt < out[1].deliverAt && out[1].deliverAt < out[2].deliverAt)
})

test('a suppressed entry is reported, not silently lost', () => {
  const now = at('2026-09-11 23:00')
  const out = spaceOut(
    [{ id: 'a', deliverAt: at('2026-09-11 23:00'), quietHours: 'suppress' }],
    { minGapMinutes: 90, quietHours: QUIET, tz: TZ, now },
  )
  assert.equal(out[0].action, 'suppress')
  assert.equal(out[0].dropped, 'quiet-hours')
  assert.equal(out[0].deliverAt, null)
})

test('slots resolve as wall clock across the DST switches', () => {
  // Spring forward 2026-03-08, fall back 2026-11-01. 18:00 stays 18:00.
  assert.equal(wall(resolveTimeOn(at('2026-03-07 12:00'), '18:00', TZ, 1)), '2026-03-08 18:00')
  assert.equal(wall(resolveTimeOn(at('2026-10-31 12:00'), '18:00', TZ, 1)), '2026-11-01 18:00')
  // A 07:15 slot on the spring-forward day is after the missing hour and is real.
  assert.equal(wall(resolveTimeOn(at('2026-03-08 01:00'), DEFAULT_SLOTS.morning, TZ)), '2026-03-08 07:15')
})

test('deliveryState distinguishes pending, due, and too stale to bother', () => {
  const due = at('2026-09-11 15:00')
  const grace = 30 * 60_000
  assert.equal(deliveryState(due, due - 1, grace), 'pending')
  assert.equal(deliveryState(due, due, grace), 'due')
  assert.equal(deliveryState(due, due + grace, grace), 'due')
  assert.equal(deliveryState(due, due + grace + 1, grace), 'missed')
  assert.equal(deliveryState(NaN, due, grace), 'unscheduled')
})

test('a late delivery says when it was for, and a prompt one does not', () => {
  const due = at('2026-09-11 15:00')
  assert.equal(lateSuffix(due, due + 60_000, TZ), '')
  assert.equal(lateSuffix(due, due + 20 * 60_000, TZ), 'was due 3:00 PM')
})

test('plan settings clamp rather than reject', () => {
  assert.equal(normalizePlanSettings({ cap: -3 }).cap, 0)
  assert.equal(normalizePlanSettings({ cap: 999 }).cap, 20)
  assert.equal(normalizePlanSettings({}).cap, DEFAULT_PLAN_SETTINGS.cap)
  assert.equal(normalizePlanSettings({ minGapMinutes: 'nonsense' }).minGapMinutes, DEFAULT_PLAN_SETTINGS.minGapMinutes)
  assert.equal(normalizePlanSettings({ quietHours: null }).quietHours, null)
  assert.equal(normalizePlanSettings({ slots: { evening: '19:45' } }).slots.evening, '19:45')
  assert.equal(normalizePlanSettings({ slots: { evening: 'garbage' } }).slots.evening, '18:00')
})

test('dedupe keys separate the same kind of thing about different subjects', () => {
  assert.equal(dedupeKey({ category: 'habit.slipping', factKind: 'daily', subject: 'w', date: '2026-09-11' }),
    'habit.slipping:daily:w:2026-09-11')
  assert.notEqual(
    dedupeKey({ category: 'habit.slipping', factKind: 'daily', subject: 'w' }),
    dedupeKey({ category: 'habit.slipping', factKind: 'daily', subject: 'd' }),
  )
})

test('dayKey is the local day, not UTC', () => {
  // 23:30 in New York is already tomorrow in UTC; the plan must belong to today.
  assert.equal(dayKey(at('2026-09-11 23:30'), TZ), '2026-09-11')
})
