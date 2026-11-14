import assert from 'node:assert/strict'
import test from 'node:test'
import { buildForecast, buildPlan, paceOf, parseQuietHours, parseWhen, windowClass } from './forecast.mjs'

const M = 60_000
const H = 60 * M
const now = Date.UTC(2026, 10, 12, 17) // Thu 12:00 in New York
const tz = 'America/New_York'

/** A CLIProxy Claude login with live 5-hour and weekly meters. */
function login(id, { five, weekly, fiveReset = now + 3 * H, weeklyReset = now + 72 * H, plan = 'Max 20x', planSize = 20, ...rest }) {
  return {
    id: `claude:proxy:${id}.json`, backend: 'claude', label: `${id}.json`, displayName: id, source: 'cliproxy', plan, planSize,
    state: 'ok', fetchedAt: now,
    meters: [
      { key: 'session:', label: '5-hour limit', usedPct: 100 - five, remainingPct: five, resetsAt: fiveReset, windowMinutes: 300 },
      { key: 'weekly_all:', label: '7-day limit', usedPct: 100 - weekly, remainingPct: weekly, resetsAt: weeklyReset, windowMinutes: 10080 },
    ],
    ...rest,
  }
}

/** Readings every 15 minutes over the last `hours`, rising `fivePerHour` and `weeklyPerHour`. */
function rising(accountId, { hours = 3, fiveEnd, weeklyEnd, fivePerHour, weeklyPerHour, fiveReset = now + 3 * H, weeklyReset = now + 72 * H }) {
  const out = []
  for (let t = now - hours * H; t < now; t += 15 * M) {
    const back = (now - t) / H
    out.push({
      t, accountId, provider: 'claude', source: 'passive',
      windows: {
        five_hour: { used: 100 - fiveEnd - fivePerHour * back, resetAtMs: fiveReset, windowMinutes: null },
        seven_day: { used: 100 - weeklyEnd - weeklyPerHour * back, resetAtMs: weeklyReset, windowMinutes: null },
      },
    })
  }
  return out
}

const snap = (accounts) => ({ ok: true, updatedAt: now, providers: { claude: 'Claude', codex: 'Codex' }, accounts })

test('window classes come from the length, then the key', () => {
  assert.equal(windowClass(300), 'five')
  assert.equal(windowClass(10080), 'weekly')
  assert.equal(windowClass(43200), null)
  assert.equal(windowClass(null, 'seven_day'), 'weekly')
  assert.equal(windowClass(null, 'primary'), 'five')
})

test('pace counts from the high-water mark, restarts at a reset and needs 15 minutes', () => {
  const r = now + 10 * H
  // 10 → 20 → 19 (a passive reading a point under the active one) → 30: 20 points, not 21.
  const jitter = [{ t: now - 2 * H, used: 10, reset: r }, { t: now - H, used: 20, reset: r }, { t: now - 0.5 * H, used: 19, reset: r }, { t: now, used: 30, reset: r }]
  assert.equal(paceOf(jitter, { from: now - 2 * H, to: now }).gained, 20)
  // 80 before a reset, 15 after it: 15 gained across the reset, not -65.
  const reset = [{ t: now - 2 * H, used: 70, reset: now - H }, { t: now - 1.5 * H, used: 80, reset: now - H }, { t: now, used: 15, reset: now + 4 * H }]
  assert.equal(paceOf(reset, { from: now - 2 * H, to: now }).gained, 25)
  // The pair straddling `from` counts in proportion: half of a 10-point rise.
  const straddle = [{ t: now - 2 * H, used: 0, reset: r }, { t: now, used: 10, reset: r }]
  assert.equal(paceOf(straddle, { from: now - H, to: now }).gained, 5)
  assert.equal(paceOf([{ t: now - 5 * M, used: 1, reset: r }, { t: now, used: 2, reset: r }], { from: now - H, to: now }).perHour, null)
})

test('one login: its 5-hour window resets with room left, and the week runs out at its pace', () => {
  const a = login('solo', { five: 40, weekly: 50 })
  const samples = rising(a.id, { fiveEnd: 40, weeklyEnd: 50, fivePerHour: 10, weeklyPerHour: 1 })
  const out = buildForecast(snap([a]), samples, { now, tz })
  const acc = out.accounts[0]
  const five = acc.windows.find((w) => w.window === '5-hour')
  const weekly = acc.windows.find((w) => w.window === 'weekly')
  assert.equal(five.pacePctPerHour, 10)
  assert.equal(weekly.pacePctPerHour, 1)
  assert.equal(acc.weeklyPerFiveHourPoint, 0.1)
  // 40 left, 10/h for 3 h until the reset: ~10 left unused, and no run-out before it.
  assert.equal(five.runsOutAt, null)
  assert.ok(Math.abs(five.unusedAtResetPct - 10) <= 1, `unused ${five.unusedAtResetPct}`)
  // 50% of the week at 1 point an hour: ~50 h, well before the reset at 72 h.
  assert.ok(Math.abs(weekly.runsOutInHours - 50) <= 1, `weekly out in ${weekly.runsOutInHours}`)
  assert.ok(Math.abs(out.providers[0].allCappedInHours - 50) <= 1)
  assert.match(out.summary[0], /^Claude pool \(1 login\): 10 pool %\/h over the last 3 h/)
  assert.match(acc.summary, /weekly runs out 2026-11-14 /)
  assert.ok(out.method.length >= 5)
})

test('a spent week reads as spent until its reset, and the pool is blocked from now', () => {
  const a = login('done', { five: 100, weekly: 0, fiveReset: null, weeklyReset: now + 6 * H })
  const out = buildForecast(snap([a]), [], { now, tz })
  const weekly = out.accounts[0].windows.find((w) => w.window === 'weekly')
  assert.equal(weekly.spentNow, true)
  assert.equal(weekly.runsOutAt, null)
  assert.match(out.accounts[0].summary, /weekly spent until 2026-11-12 18:00/)
  assert.equal(out.providers[0].allCappedInHours, 0)
  assert.equal(out.providers[0].blockedSpans[0].hours, 6)
})

test('quiet hours and a zero future factor spend nothing', () => {
  const a = login('solo', { five: 40, weekly: 50 })
  const samples = rising(a.id, { fiveEnd: 40, weeklyEnd: 50, fivePerHour: 10, weeklyPerHour: 1 })
  const idle = buildForecast(snap([a]), samples, { now, tz, futureFactor: 0 })
  assert.equal(idle.accounts[0].windows[0].unusedAtResetPct, 40)
  // 12:00–15:00 local is quiet, so nothing is spent before the 5-hour reset at 15:00.
  const quiet = buildForecast(snap([a]), samples, { now, tz, quietHours: '12-15' })
  assert.equal(quiet.accounts[0].windows[0].unusedAtResetPct, 40)
  assert.equal(quiet.assumptions.quietHours, '12-15')
  assert.deepEqual(parseQuietHours('23-7'), { startHour: 23, endHour: 7 })
  assert.equal(parseQuietHours('7-7'), null)
})

test('a pool routes its pace to the login whose week resets first', () => {
  const soon = login('soon', { five: 100, weekly: 30, fiveReset: null, weeklyReset: now + 24 * H })
  const late = login('late', { five: 100, weekly: 90, fiveReset: null, weeklyReset: now + 120 * H })
  const samples = [
    ...rising(soon.id, { fiveEnd: 100, weeklyEnd: 30, fivePerHour: 0, weeklyPerHour: 0 }),
    ...rising(late.id, { fiveEnd: 100, weeklyEnd: 90, fivePerHour: 0, weeklyPerHour: 0 }),
  ]
  // A steady 10 pool %/h from the late login's history, with a 0.1 weekly ratio.
  for (const s of samples.filter((x) => x.accountId === late.id)) {
    const back = (now - s.t) / H
    s.windows.five_hour.used = 10 * (3 - back)
    s.windows.seven_day.used = 10 - back
  }
  const out = buildForecast(snap([soon, late]), samples, { now, tz, pace: 'recent' })
  const bySoon = out.accounts.find((a) => a.name === 'soon')
  const byLate = out.accounts.find((a) => a.name === 'late')
  // The soon login takes the spending first, so it runs dry before its reset; the late one is untouched until then.
  assert.ok(bySoon.windows.find((w) => w.window === 'weekly').runsOutAt)
  assert.ok(bySoon.windows.find((w) => w.window === '5-hour').runsOutInHours < 10)
  assert.equal(out.providers[0].accounts.length, 2)
  assert.equal(byLate.pooled, true)
})

test('the plan runs a job now where it fits, and otherwise after the reset that makes room', () => {
  const a = login('roomy', { five: 80, weekly: 60 })
  const b = login('spent', { five: 100, weekly: 0, fiveReset: null, weeklyReset: now + 6 * H })
  const now1 = buildPlan(snap([a, b]), [], { now, tz, size: 'medium' })
  assert.equal(now1.fits, true)
  assert.equal(now1.best.name, 'roomy')
  assert.equal(now1.best.startsNow, true)
  assert.match(now1.summary, /^Run a medium job \(~20% of one 5-hour window on the largest plan\) now on Claude through CLIProxy \(likely roomy\)\./)

  // A whole window fits nowhere now: the roomy login's 5-hour window refills in 3 h,
  // the spent login's week in 6 h.
  const big = buildPlan(snap([a, b]), [], { now, tz, size: 'full' })
  assert.equal(big.best.name, 'roomy')
  assert.equal(big.best.startsNow, false)
  assert.equal(big.best.startInHours, 3)
  assert.equal(big.best.startAtIso, new Date(now + 3 * H).toISOString())
  assert.match(big.best.why, /once its 5-hour window resets/)
  assert.match(big.summary, /at 2026-11-12 15:00 \(in 3 h\) on Claude .*nothing fits sooner/)
  assert.equal(big.alternatives[0].name, 'spent')
  assert.equal(big.alternatives[0].startInHours, 6)
  assert.match(big.alternatives[0].why, /once its weekly window resets/)
})

test('the plan honours notBefore and deadlines, and says when a missed deadline would fit', () => {
  const b = login('spent', { five: 100, weekly: 0, fiveReset: null, weeklyReset: now + 6 * H })
  const late = buildPlan(snap([b]), [], { now, tz, size: 'small', withinHours: 2 })
  assert.equal(late.fits, false)
  assert.equal(late.afterDeadline.startInHours, 6)
  assert.match(late.summary, /^Nothing fits a small job .* before 2026-11-12 14:00 at the current pace\. The first fit after that is 2026-11-12 18:00/)

  const a = login('roomy', { five: 80, weekly: 60 })
  const later = buildPlan(snap([a]), [], { now, tz, size: 'small', notBefore: '2026-11-13 09:00' })
  assert.equal(later.best.startsNow, false)
  assert.equal(later.best.atEarliest, true)
  assert.equal(later.best.startAt, '2026-11-13 09:00')
  assert.match(later.summary, /the earliest asked for/)
})

test('a job bigger than any window is too big, scaled by plan size', () => {
  const max = login('max', { five: 100, weekly: 100 })
  const team = login('team', { five: 100, weekly: 100, plan: 'Team', planSize: 5 })
  const out = buildPlan(snap([max, team]), [], { now, tz, size: 'full' })
  // A whole Max 20x window is two Team windows (price weights 10 and 5).
  assert.equal(out.best.name, 'max')
  assert.deepEqual(out.tooBig.map((x) => [x.name, x.jobFiveHourPct]), [['team', 200]])
  const huge = buildPlan(snap([max]), [], { now, tz, fiveHourPct: 150 })
  assert.equal(huge.fits, false)
  assert.match(huge.summary, /bigger than one 5-hour window on every login: split it/)
})

test('at the same start, the plan prefers a login whose week would reset unused', () => {
  const idle = login('idle', { five: 100, weekly: 70, weeklyReset: now + 4 * H })
  const busy = login('busy', { five: 100, weekly: 70, weeklyReset: now + 100 * H })
  const out = buildPlan(snap([busy, idle]), [], { now, tz, size: 'small' })
  assert.equal(out.best.name, 'idle')
  assert.equal(out.best.spareBeforeResetPct, 70)
  assert.match(out.best.why, /~70% of its week would otherwise reset unused at 2026-11-12 16:00/)
})

test('logins without history are projected idle, and Cursor and switched-off logins are only listed', () => {
  const local = { ...login('local', { five: 50, weekly: 50 }), id: 'codex:default', backend: 'codex', source: 'local', plan: 'Pro', planSize: 1 }
  local.meters = [
    { key: 'primary', label: '5-hour', usedPct: 50, remainingPct: 50, resetsAt: now + H, windowMinutes: 300 },
    { key: 'secondary', label: 'weekly', usedPct: 50, remainingPct: 50, resetsAt: now + 50 * H, windowMinutes: 10080 },
  ]
  const off = { ...login('off', { five: 100, weekly: 100 }), disabled: true }
  const cursor = { id: 'cursor:default', backend: 'cursor', displayName: 'Cursor', source: 'local', meters: [{ key: 'included', label: 'Included usage', usedPct: 10, resetsAt: now + 400 * H, windowMinutes: 43200 }] }
  const out = buildForecast(snap([local, off, cursor]), [], { now, tz })
  assert.match(out.accounts[0].summary, /no recorded history, projected idle/)
  assert.equal(out.accounts[0].pooled, false)
  assert.deepEqual(out.unprojected.map((x) => [x.name, x.reason.split(' ')[0]]), [['off', 'switched'], ['Cursor', 'no']])
})

test('times parse as ISO with an offset or as local wall time in the owner\'s zone', () => {
  assert.equal(parseWhen('2026-11-13 09:00', tz), Date.UTC(2026, 10, 13, 14))
  assert.equal(parseWhen('2026-07-01 09:00', tz), Date.UTC(2026, 6, 1, 13))
  assert.equal(parseWhen('2026-11-13T09:00:00Z', tz), Date.UTC(2026, 10, 13, 9))
  assert.equal(parseWhen('soon', tz), null)
})
