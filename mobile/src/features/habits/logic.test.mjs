// The Habits page's new pure helpers (#180). Run with
// `node --test mobile/src/features/habits/logic.test.mjs`; node strips the types.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bestStreakOf, dayProgress, doneOn, recentDays, streakOf, withPending } from './logic.ts'

const habit = (over = {}) => ({
  id: 'h1', name: 'Read', description: '', color: '#5b8cff', cadence: 'daily', target: 1,
  metric: null, createdAt: '2026-01-01', archived: false, ...over,
})
const log = (pairs, id = 'h1') => {
  const entries = {}
  for (const [date, count, extra] of pairs) entries[date] = { ...(entries[date] || {}), [id]: { count, ...(extra || {}) } }
  return entries
}

test('bestStreakOf: the longest daily run, even when it is over', () => {
  const entries = log([
    ['2026-10-01', 1], ['2026-10-02', 1], ['2026-10-03', 1], ['2026-10-04', 1],
    ['2026-10-10', 1], ['2026-10-11', 1],
  ])
  assert.equal(streakOf(habit(), entries, '2026-10-11'), 2)
  assert.equal(bestStreakOf(habit(), entries, '2026-10-11'), 4)
})

test('bestStreakOf: a run across a month end is one run', () => {
  const entries = log([['2026-09-29', 1], ['2026-09-30', 1], ['2026-10-01', 1]])
  assert.equal(bestStreakOf(habit(), entries, '2026-10-05'), 3)
})

test('bestStreakOf: never below the current streak, and zero with nothing logged', () => {
  assert.equal(bestStreakOf(habit(), {}, '2026-10-05'), 0)
  const entries = log([['2026-10-04', 1], ['2026-10-05', 1]])
  assert.equal(bestStreakOf(habit(), entries, '2026-10-05'), 2)
})

test('bestStreakOf: weekly habits count weeks that met the quota', () => {
  const weekly = habit({ cadence: 'weekly', target: 2 })
  // Weeks starting Mon 2026-09-07, 09-14, 09-21 met; 09-28 missed; 10-05 met.
  const entries = log([
    ['2026-09-07', 1], ['2026-09-09', 1],
    ['2026-09-14', 2],
    ['2026-09-22', 1], ['2026-09-27', 1],
    ['2026-09-30', 1],
    ['2026-10-05', 1], ['2026-10-06', 1],
  ])
  assert.equal(bestStreakOf(weekly, entries, '2026-10-07'), 3)
})

test('bestStreakOf: monthly habits count months that met the quota', () => {
  const monthly = habit({ cadence: 'monthly', target: 1 })
  const entries = log([['2026-06-03', 1], ['2026-07-09', 1], ['2026-09-01', 1]])
  assert.equal(bestStreakOf(monthly, entries, '2026-09-15'), 2)
})

test('recentDays: seven days ending on the day asked, oldest first', () => {
  const entries = log([['2026-10-05', 1, { note: 'good' }], ['2026-10-03', 0, { skipped: true }]])
  const days = recentDays(habit(), entries, '2026-10-05')
  assert.equal(days.length, 7)
  assert.equal(days[0].date, '2026-09-29')
  assert.equal(days[6].date, '2026-10-05')
  assert.equal(days[6].level, 4)
  assert.equal(days[6].noted, true)
  assert.equal(days[4].skipped, true)
  assert.equal(days[5].level, 0)
})

test('recentDays: a multi-per-day habit fills by its share of the target', () => {
  const water = habit({ target: 8 })
  const days = recentDays(water, log([['2026-10-05', 4]]), '2026-10-05')
  assert.equal(days[6].level, 2)
})

test('doneOn: daily needs its target; weekly is done when logged that day or the week is met', () => {
  assert.equal(doneOn(habit({ target: 3 }), log([['2026-10-05', 2]]), '2026-10-05'), false)
  assert.equal(doneOn(habit({ target: 3 }), log([['2026-10-05', 3]]), '2026-10-05'), true)
  const weekly = habit({ cadence: 'weekly', target: 2 })
  const entries = log([['2026-10-05', 1]])
  assert.equal(doneOn(weekly, entries, '2026-10-05'), true)
  assert.equal(doneOn(weekly, entries, '2026-10-06'), false)
  const met = log([['2026-10-05', 1], ['2026-10-06', 1]])
  assert.equal(doneOn(weekly, met, '2026-10-08'), true)
})

test('dayProgress: one segment per habit, in order', () => {
  const a = habit({ id: 'a', color: '#111111' })
  const b = habit({ id: 'b', color: '#222222' })
  const entries = { '2026-10-05': { b: { count: 1 } } }
  const p = dayProgress([a, b], entries, '2026-10-05')
  assert.deepEqual(p, {
    done: 1, total: 2,
    segments: [{ id: 'a', color: '#111111', done: false }, { id: 'b', color: '#222222', done: true }],
  })
})

test('withPending: folds in-flight taps into a copy, leaving the original alone', () => {
  const entries = log([['2026-10-05', 1, { note: 'n' }]])
  const next = withPending(entries, { 'h1:2026-10-05': -1, 'h2:2026-10-04': 1 })
  assert.equal(next['2026-10-05'].h1.count, 0)
  assert.equal(next['2026-10-05'].h1.note, 'n')
  assert.equal(next['2026-10-04'].h2.count, 1)
  assert.equal(entries['2026-10-05'].h1.count, 1)
  assert.equal(withPending(entries, {}), entries)
})

test('withPending: a tick clears a skipped "No", and never goes below zero', () => {
  const entries = log([['2026-10-05', 0, { skipped: true }]])
  assert.equal(withPending(entries, { 'h1:2026-10-05': 1 })['2026-10-05'].h1.skipped, false)
  assert.equal(withPending(entries, { 'h1:2026-10-05': -3 })['2026-10-05'].h1.count, 0)
})

test('withPending: an id with a colon in it still splits on the date', () => {
  const next = withPending({}, { 'a:b:2026-10-05': 1 })
  assert.equal(next['2026-10-05']['a:b'].count, 1)
})
