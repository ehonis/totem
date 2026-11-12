import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeHistory } from '../cliproxy/history.mjs'
import {
  allBlockedIntervals, downsampleHistory, limitReport, localStamp, resetMs, summarizeCurrent, windowHits, windowPeriods,
} from './report.mjs'

const H = 3600_000
const D = 24 * H
const now = Date.UTC(2026, 10, 12, 12)
const tz = 'UTC'
const A = 'claude:proxy:a.json'
const B = 'claude:proxy:b.json'

// A Claude reading: five_hour and, when given, seven_day.
const reading = (t, five, fiveReset, week = null, weekReset = null, accountId = A) => ({
  t, accountId, provider: 'claude', source: 'passive',
  windows: {
    ...(five === null ? {} : { five_hour: { used: five, resetAtMs: fiveReset, windowMinutes: 300 } }),
    ...(week === null ? {} : { seven_day: { used: week, resetAtMs: weekReset, windowMinutes: 10080 } }),
  },
})

const range = { from: now - 21 * D, to: now, now, tz }

test('a capped 5-hour window counts once, however many readings sit at the cap, and is blocked until its reset', () => {
  const R1 = now - 20 * H
  const R2 = now - 10 * H
  const R3 = now + 2 * H
  const samples = [
    reading(R1 - 4 * H, 10, R1), reading(R1 - 3 * H, 50, R1), reading(R1 - 2 * H, 99, R1),
    reading(R1 - 1.5 * H, 100, R1), reading(R1 - H, 100, R1),
    reading(R2 - 4 * H, 20, R2), reading(R2 - 3 * H, 99.5, R2), reading(R2 - 2.9 * H, 100, R2),
    reading(now - 2 * H, 40, R3), reading(now - H, 99, R3),
  ]
  const report = limitReport(samples, range)
  const [account] = report.accounts
  const five = account.windows.find((w) => w.window === 'five_hour')
  assert.equal(five.hits, 3)
  assert.equal(five.periodsUsed, 3)
  assert.equal(five.blockedHours, 2 + 3 + 1) // the last one runs to now, not to its reset
  assert.equal(five.peakPct, 100)
  assert.equal(five.avgPeakPct, Math.round(((100 + 100 + 99) / 3) * 10) / 10)
  assert.deepEqual(five.recentHits[0], { cappedAt: localStamp(now - H, tz), resetAt: localStamp(R3, tz), blockedHours: 1, ongoing: true })
  assert.equal(five.recentHits[2].resetAt, localStamp(R1, tz))
  assert.match(account.summary, /hit the 5-hour cap 3 times in 1 day of readings \(of the 21 days asked for\), blocked ~6 h/)
})

test('5-hour and weekly blocks that overlap are counted once in the account total', () => {
  const R = now - 10 * H
  const W = now + 3 * D
  const samples = [
    reading(now - 22 * H, 99, now - 20 * H, 80, W),
    reading(R - 3 * H, 99, R, 99, W),
    reading(now - H, 30, now + 4 * H, 100, W),
  ]
  const [account] = limitReport(samples, range).accounts
  assert.equal(account.windows.find((w) => w.window === 'seven_day').blockedHours, 13)
  assert.equal(account.windows.find((w) => w.window === 'five_hour').blockedHours, 2 + 3)
  // [−22 h, −20 h] ∪ [−13 h, now]
  assert.equal(account.totalBlockedHours, 15)
  assert.match(account.summary, /weekly cap reached once, blocked ~13 h; ~15 h blocked in all/)
})

test('with no reset time, a fall in usage starts a new window and blocked time is the observed lower bound', () => {
  const samples = [
    reading(now - 10 * H, 50, null), reading(now - 9.5 * H, 99, null), reading(now - 9 * H, 100, null),
    reading(now - 8.5 * H, 10, null), reading(now - 8 * H, 20, null),
  ]
  const series = samples.map((s) => ({ t: s.t, used: s.windows.five_hour.used, reset: null }))
  const periods = windowPeriods(series, 5 * H)
  assert.equal(periods.length, 2)
  const hits = windowHits(periods, { end: now })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].resetKnown, false)
  assert.equal(hits[0].blockedMs, 0.5 * H)
  const five = limitReport(samples, range).accounts[0].windows[0]
  assert.equal(five.resetUnknownHits, 1)
  assert.equal(five.recentHits[0].resetAt, null)
})

test('a reading taken after its own reset is not a cap, and a reset in seconds is read as seconds', () => {
  const reset = now - 5 * H
  const samples = [reading(now - 4 * H, 100, reset), reading(now - 3 * H, 100, Math.floor((now + H) / 1000))]
  const [account] = limitReport(samples, range).accounts
  const five = account.windows[0]
  assert.equal(five.hits, 1)
  assert.equal(five.blockedHours, 3)
  assert.equal(resetMs(1_700_000_000), 1_700_000_000_000)
  assert.equal(resetMs(0), null)
})

test("Fable's passive seven_day_oi window reaches the report as weekly Fable, and does not block the account", () => {
  const files = [{ name: 'a.json', provider: 'claude', auth_index: '1' }]
  const body = { samples: [
    { t: now - 2 * H, auth_index: '1', provider: 'claude', windows: { five_hour: { used: 20, reset_at: now + H }, seven_day_oi: { used: 100, reset_at: now + D } } },
    { t: now - H, auth_index: '1', provider: 'claude', windows: { five_hour: { used: 30, reset_at: now + H }, seven_day_oi: { used: 100, reset_at: now + D } } },
  ] }
  const { samples } = normalizeHistory(body, files, now)
  const [account] = limitReport(samples, range).accounts
  const fable = account.windows.find((w) => w.window === 'seven_day_fable')
  assert.equal(fable.label, 'weekly Fable')
  assert.equal(fable.scope, 'model')
  assert.equal(fable.hits, 1)
  assert.equal(account.totalBlockedHours, 0)
  assert.match(account.summary, /never reached a cap .*weekly Fable cap reached once/)
})

test('gaps with no readings are reported, not filled in', () => {
  const samples = [reading(now - 30 * H, 10, now - 26 * H), reading(now - 2 * H, 20, now + 3 * H)]
  const { coverage } = limitReport(samples, { ...range, from: now - 2 * D }).accounts[0]
  assert.equal(coverage.readings, 2)
  assert.equal(coverage.coveredDays, 1.3)
  // Before the first reading the account has no history yet; that is coverage, not a gap.
  assert.equal(coverage.gapCount, 1)
  assert.equal(coverage.gapHours, 28)
  assert.deepEqual(coverage.longestGaps, [{ from: localStamp(now - 30 * H, tz), to: localStamp(now - 2 * H, tz), hours: 28 }])
})

test('the provider is all-blocked only while every reporting account is', () => {
  const all = allBlockedIntervals([
    { since: 0, blocked: [[0, 2 * H]] },
    { since: 0, blocked: [[H, 3 * H]] },
  ])
  assert.deepEqual(all, [[H, 2 * H]])
  // An account that has not reported yet does not hold the others up.
  assert.deepEqual(allBlockedIntervals([{ since: 0, blocked: [[0, 2 * H]] }, { since: 5 * H, blocked: [] }]), [[0, 2 * H]])

  const samples = [
    reading(now - 5 * H, 99, now - 3 * H), reading(now - 4 * H, 99, now - 2 * H, null, null, B),
  ].sort((a, b) => a.t - b.t)
  const report = limitReport(samples, range)
  const claude = report.providers.find((p) => p.provider === 'claude')
  assert.equal(claude.accountsWithHistory, 2)
  assert.equal(claude.capHits, 2)
  assert.equal(claude.accountBlockedHours, 4)
  assert.equal(claude.allAccountsBlockedHours, 1)
})

test('busiest days and hours add up the rise of the 5-hour window', () => {
  const day = Date.UTC(2026, 10, 10)
  const samples = [
    reading(day + 9 * H, 10, day + 13 * H), reading(day + 10 * H, 60, day + 13 * H), reading(day + 11 * H, 99, day + 13 * H),
    reading(day + 14 * H, 5, day + 18 * H),
  ]
  const { busiest } = limitReport(samples, range).accounts[0]
  assert.deepEqual(busiest.days[0], { date: '2026-11-10', pointsSpent: 104, caps: 1 })
  assert.deepEqual(busiest.hoursOfDay[0], { hours: '10:00–11:00', pointsSpent: 50 })
  assert.deepEqual(busiest.capsReachedByHour, [{ hours: '11:00–12:00', caps: 1 }])
})

test('accounts tracked live with no history are named, with why', () => {
  const report = limitReport([], { ...range, known: [
    { id: 'cursor:default', backend: 'cursor', displayName: 'Cursor', source: 'local' },
    { id: 'codex:proxy:c.json', backend: 'codex', displayName: 'work', source: 'cliproxy' },
  ] })
  assert.equal(report.noHistory.length, 2)
  assert.match(report.noHistory[0].reason, /Cursor is read live only/)
  assert.match(report.noHistory[1].reason, /No readings/)
  assert.deepEqual(report.summary, ['No usage history was recorded in this range.'])
})

test('history is bucketed to the peak of each window and stays under the point budget', () => {
  const samples = []
  for (let t = now - 7 * D; t < now; t += 5 * 60_000) samples.push(reading(t, (t / 60_000) % 100, null))
  const out = downsampleHistory(samples, { from: now - 7 * D, to: now, tz, names: new Map([[A, 'Work']]), maxPoints: 200 })
  assert.equal(out.accounts.length, 1)
  assert.equal(out.accounts[0].name, 'Work')
  assert.ok(out.accounts[0].points.length <= 200)
  assert.ok(out.bucketMinutes >= 15)
  assert.ok(out.accounts[0].points.every((p) => typeof p.at === 'string' && p.five_hour >= 0))
})

test('the live summary keeps names and numbers and leaves credentials behind; no reading is no data', () => {
  const secret = 'sk-ant-oat01-' + 'x'.repeat(40)
  const snapshot = {
    updatedAt: now - 60_000,
    providers: { claude: 'Claude', cursor: 'Cursor' },
    proxy: { configured: true, reachable: true },
    accounts: [
      {
        id: A, backend: 'claude', label: 'a.json', displayName: 'Work', plan: 'max', source: 'cliproxy',
        state: 'limited', headroomPct: 0, limitedUntil: now + H, fetchedAt: now - 60_000,
        home: '/home/someone/.claude', authFile: '/home/someone/.claude/.credentials.json', accessToken: secret,
        detailUrl: 'https://claude.ai/settings/usage', error: `refresh failed: Bearer ${secret}`,
        meters: [
          { key: 'session:', label: '5-hour limit', usedPct: 100, remainingPct: 0, resetsAt: now + H, windowMinutes: 300 },
          { key: 'weekly_all:', label: '7-day limit', usedPct: 80, remainingPct: 20, resetsAt: now + 2 * D },
          { key: 'weekly_scoped:Fable', label: 'Fable', usedPct: null, remainingPct: null, resetsAt: null },
        ],
      },
      { id: 'cursor:default', backend: 'cursor', label: 'default', state: 'ok', headroomPct: 70, meters: [{ key: 'total', label: 'Included usage', usedPct: 30, remainingPct: 70, resetsAt: Math.floor((now + 9 * D) / 1000) }] },
    ],
    pools: [{ backend: 'claude', total: 1, usable: 0, limited: 1, errors: 0, disabled: 0, headroomPct: null, nextBackAt: now + H }],
  }
  const out = summarizeCurrent(snapshot, { tz, now, redact: (s) => s.replaceAll(secret, '[redacted]') })
  const [claude, cursor] = out.accounts
  assert.deepEqual(claude.meters.map((m) => m.status), ['spent', 'low', 'no data'])
  assert.equal(claude.meters[2].usedPct, null)
  assert.equal(claude.meters[2].scope, 'model')
  assert.match(claude.summary, /limited \(5-hour limit spent\) until 2026-11-12 13:00/)
  assert.equal(cursor.meters[0].resetsAt, localStamp(now + 9 * D, tz))
  assert.equal(out.pools[0].nextBackAt, localStamp(now + H, tz))
  const text = JSON.stringify(out)
  assert.doesNotMatch(text, /sk-ant|credentials\.json|\/home\/someone|accessToken|detailUrl/)
  assert.deepEqual(summarizeCurrent(snapshot, { tz, now, provider: 'cursor' }).accounts.map((a) => a.id), ['cursor:default'])
})

test('an idle login\'s fresh 0% windows are not periods, and a window reset early ends its block at its last reading', () => {
  // Codex, idle, reports "resets in 5 h" at 0% on every reading; then a capped window
  // is replaced by a new one an hour before its reset (a reset credit).
  const codex = (t, used, reset) => ({ t, accountId: 'codex:proxy:c.json', provider: 'codex', source: 'active',
    windows: { primary: { used, resetAtMs: reset, windowMinutes: 300 } } })
  const samples = [
    codex(now - 12 * H, 0, now - 7 * H), codex(now - 11 * H, 0, now - 6 * H), codex(now - 10 * H, 0, now - 5 * H),
    codex(now - 8 * H, 40, now - 4 * H), codex(now - 7 * H, 100, now - 4 * H), codex(now - 6 * H, 100, now - 4 * H),
    codex(now - 5 * H, 0, now), codex(now - 4 * H, 30, now),
  ]
  const [account] = limitReport(samples, range).accounts
  const primary = account.windows[0]
  assert.equal(primary.label, '5-hour')
  assert.equal(primary.periodsUsed, 2)
  assert.equal(primary.avgPeakPct, 65)
  assert.equal(primary.hits, 1)
  assert.equal(primary.endedEarlyHits, 1)
  assert.equal(primary.blockedHours, 1)
  assert.deepEqual(primary.recentHits[0], { cappedAt: localStamp(now - 7 * H, tz), resetAt: null, blockedHours: 1, ongoing: false, endedEarly: true })
  assert.match(account.summary, /^Codex \(c\.json\): hit the 5-hour cap once/)
})

test('a provider whose accounts were never capped together says another was always free', () => {
  const samples = [reading(now - 5 * H, 99, now - 4 * H), reading(now - 3 * H, 99, now - 2 * H, null, null, B)]
  const claude = limitReport(samples, range).providers[0]
  assert.equal(claude.allAccountsBlockedHours, 0)
  assert.match(claude.summary, /never all capped at the same time/)
})
