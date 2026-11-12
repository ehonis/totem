// The Productivity hub's per-tool numbers (#177). Run with
// `node --test mobile/src/features/productivity/glance.test.mjs`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// glance.ts imports Overview's date helpers the way Metro resolves them, without
// an extension; let node find the .ts file the same way.
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (err) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw err
    }
  },
})
const { calendarGlance, count, dayKeyOf, firstGlance, goalsGlance, habitsGlance, listsGlance, liveWeekGoals, tasksGlance } = await import('./glance.ts')

// Wednesday 4 November 2026, 14:00 local.
const NOW = new Date(2026, 10, 4, 14, 0)
const at = (h, m = 0, day = 4) => new Date(2026, 10, day, h, m).toISOString()

test('dayKeyOf is the local day', () => {
  assert.equal(dayKeyOf(NOW), '2026-11-04')
  assert.equal(dayKeyOf(new Date(2026, 0, 9, 23, 59)), '2026-01-09')
})

test('tasks: due today and overdue are counted apart, from the board when it is there', () => {
  const board = {
    todos: [
      { status: 'todo', dueDate: '2026-11-04' },
      { status: 'todo', dueDate: '2026-11-01' },
      { status: 'todo', dueDate: at(9) }, // a timed due today
      { status: 'todo', dueDate: '2026-11-05' },
      { status: 'todo', dueDate: null },
      { status: 'done', dueDate: '2026-11-04' },
      { status: 'todo', dueDate: '2026-11-03', deletedAt: '2026-11-03T10:00:00Z' },
      { status: 'todo', dueDate: '2026-11-03', archivedAt: '2026-11-03T10:00:00Z' },
    ],
  }
  const legacy = { todos: [{ due: '2026-11-04' }] }
  assert.deepEqual(tasksGlance(board, legacy, NOW), { today: 2, overdue: 1, open: 5 })
  // Only late ones: nothing is due today, and they are not counted as if it were.
  assert.deepEqual(tasksGlance({ todos: [{ status: 'todo', dueDate: '2026-11-02' }, { status: 'todo', dueDate: '2026-11-03' }] }, null, NOW),
    { today: 0, overdue: 2, open: 2 })
})

test('tasks: falls back to /api/todos, and says nothing without either', () => {
  const legacy = { todos: [{ due: '2026-11-04' }, { due: '2026-10-30' }, { due: null }, { due: '2026-12-01' }] }
  assert.deepEqual(tasksGlance(undefined, legacy, NOW), { today: 1, overdue: 1, open: 4 })
  assert.equal(tasksGlance(undefined, undefined, NOW), null)
  assert.equal(tasksGlance({ error: 'x' }, null, NOW), null)
})

test('calendar: events still to come or under way today, and the next to start', () => {
  const payload = {
    events: [
      { title: 'Standup', start: at(9), end: at(9, 30) }, // over
      { title: 'Review', start: at(13, 30), end: at(14, 30) }, // under way
      { title: 'Gym', start: at(18), end: at(19) },
      { title: 'Call', start: at(16), end: at(16, 30) },
      { title: 'Offsite', start: at(9, 0, 3), end: at(17, 0, 4) }, // began yesterday, ends today
      { title: 'Tomorrow', start: at(10, 0, 5), end: at(11, 0, 5) },
    ],
  }
  const g = calendarGlance(payload, NOW)
  assert.equal(g.left, 4)
  assert.deepEqual(g.next, { title: 'Call', start: at(16) })
  assert.equal(g.allDay, 0)
  assert.deepEqual(calendarGlance({ events: [] }, NOW), { left: 0, next: null, allDay: 0, allDayTitle: null })
  assert.equal(calendarGlance(undefined, NOW), null)
})

test('calendar: all-day events that cover today are counted on their own', () => {
  const payload = {
    events: [
      { title: 'Holiday', start: '2026-11-04', end: '2026-11-05', allDay: true },
      { title: 'Trip', start: '2026-11-02', end: '2026-11-06', allDay: true }, // spans today
      { title: 'Yesterday', start: '2026-11-03', end: '2026-11-04', allDay: true }, // end is exclusive
      { title: 'Friday', start: '2026-11-06', allDay: true },
    ],
  }
  assert.deepEqual(calendarGlance(payload, NOW), { left: 0, next: null, allDay: 2, allDayTitle: 'Holiday' })
})

test('habits: Overview’s rule for done, without archived or WHOOP-synced ones', () => {
  const payload = {
    today: '2026-11-04',
    habits: [
      { id: 'a', cadence: 'daily', target: 1 },
      { id: 'b', cadence: 'daily', target: 1 },
      { id: 'c', cadence: 'weekly', target: 2 }, // met earlier this week
      { id: 'd', cadence: 'daily', target: 1, archived: true },
      { id: 'e', cadence: 'daily', target: 1, metric: { source: 'whoop-sleep' } },
    ],
    entries: {
      '2026-11-02': { c: { count: 2 } },
      '2026-11-04': { a: { count: 1 }, d: { count: 1 } },
    },
  }
  assert.deepEqual(habitsGlance(payload, NOW), { done: 2, total: 3 })
  assert.equal(habitsGlance(null, NOW), null)
  // Yesterday's answer, read from disk the next morning, is not today's tally.
  assert.equal(habitsGlance({ ...payload, today: '2026-11-03' }, NOW), null)
})

test('goals: done of those still in play, only for the week it is', () => {
  const week = { type: 'week', start: '2026-11-02', end: '2026-11-08' }
  const goals = [{ complete: true }, { complete: false }, { complete: true, abandoned: true }, { complete: false }]
  assert.deepEqual(goalsGlance({ goals, period: week }, NOW), { done: 1, total: 3 })
  assert.deepEqual(goalsGlance({ goals }, NOW), { done: 1, total: 3 })
  // Last week's answer on Monday morning.
  assert.equal(goalsGlance({ goals, period: { start: '2026-10-26', end: '2026-11-01' } }, NOW), null)
  assert.equal(goalsGlance({}, NOW), null)
})

test('the Goals page store counts only while it shows this week', () => {
  const window = { type: 'week', start: '2026-11-02', end: '2026-11-08' }
  const goals = [{ complete: true }]
  assert.deepEqual(liveWeekGoals({ tab: 'this_week', anchor: null, window, goals, loading: false }), { goals, period: window })
  assert.equal(liveWeekGoals({ tab: 'this_month', anchor: null, window, goals, loading: false }), null)
  assert.equal(liveWeekGoals({ tab: 'this_week', anchor: { type: 'week', start: '2026-10-26' }, window, goals, loading: false }), null)
  assert.equal(liveWeekGoals({ tab: 'overview', anchor: null, window, goals, loading: false }), null)
  assert.equal(liveWeekGoals({ tab: 'this_week', anchor: null, window: null, goals: [], loading: true }), null)
  // Just switched from the month: the month's window is still there and the list is empty.
  assert.equal(liveWeekGoals({ tab: 'this_week', anchor: null, window: { type: 'month', start: '2026-11-01', end: '2026-11-30' }, goals: [], loading: true }), null)
  // A refresh of the week keeps showing it.
  assert.deepEqual(liveWeekGoals({ tab: 'this_week', anchor: null, window, goals, loading: true }), { goals, period: window })
})

test('lists: unchecked items across lists', () => {
  const payload = { lists: [{ itemCount: 5, checkedCount: 2 }, { itemCount: 3, checkedCount: 3 }, { itemCount: 1 }] }
  assert.deepEqual(listsGlance(payload), { lists: 3, open: 4 })
  assert.equal(listsGlance(undefined), null)
})

test('a stale store falls through to a fresher cached answer', () => {
  const habit = { id: 'a', cadence: 'daily', target: 1 }
  const lastNight = { today: '2026-11-03', habits: [habit], entries: {} } // the store, left open overnight
  const cached = { today: '2026-11-04', habits: [habit], entries: { '2026-11-04': { a: { count: 1 } } } }
  assert.deepEqual(firstGlance([lastNight, cached], (c) => habitsGlance(c, NOW)), { done: 1, total: 1 })
  assert.deepEqual(firstGlance([null, undefined, cached], (c) => habitsGlance(c, NOW)), { done: 1, total: 1 })
  assert.equal(firstGlance([lastNight, undefined], (c) => habitsGlance(c, NOW)), null)
})

test('count pluralises', () => {
  assert.equal(count(1, 'event'), '1 event')
  assert.equal(count(0, 'event'), '0 events')
  assert.equal(count(2, 'open item'), '2 open items')
})
