// The calendar's agenda builder and view preference (#181). The app's modules
// import each other without extensions (Metro resolves them), so a tiny resolve
// hook tries `.ts` for a relative import node cannot find.
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx) } catch (e) {
    if (spec.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(spec)) return next(spec + '.ts', ctx)
    throw e
  }
}`))

const { agendaDays } = await import('./agenda.ts')
const { parseView, DEFAULT_VIEW, compactTitle } = await import('./time.ts')

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min)
const iso = (d) => d.toISOString()
const NOW = at(2026, 11, 4, 12, 30) // a Wednesday
const RANGE = [at(2026, 11, 4), at(2026, 11, 18)]

test('today and tomorrow always have a heading, even when empty', () => {
  const days = agendaDays([], [], RANGE, NOW)
  assert.deepEqual(days.map((d) => d.heading), ['Today', 'Tomorrow'])
  assert.equal(days[0].today, true)
  assert.equal(days[0].nowAt, -1, 'no timed events, no now line')
})

test('days with events, in order; all-day first, then by start', () => {
  const events = [
    { id: 'b', title: 'Lunch', start: iso(at(2026, 11, 6, 12)), end: iso(at(2026, 11, 6, 13)) },
    { id: 'a', title: 'Holiday', start: '2026-11-06', end: '2026-11-07', allDay: true },
    { id: 'c', title: 'Gym', start: iso(at(2026, 11, 6, 7)), end: iso(at(2026, 11, 6, 8)) },
  ]
  const days = agendaDays(events, [], RANGE, NOW)
  assert.deepEqual(days.map((d) => d.key), ['2026-11-04', '2026-11-05', '2026-11-06'])
  assert.deepEqual(days[2].events.map((e) => e.ev.id), ['a', 'c', 'b'])
  assert.equal(days[2].heading, at(2026, 11, 6).toLocaleDateString([], { weekday: 'long' }))
  assert.ok(days[2].events.every((e) => !e.past))
})

test("today's finished events are past, the now line sits before the next", () => {
  const events = [
    { id: 'done', title: 'Standup', start: iso(at(2026, 11, 4, 9)), end: iso(at(2026, 11, 4, 9, 15)) },
    { id: 'live', title: 'Workshop', start: iso(at(2026, 11, 4, 12)), end: iso(at(2026, 11, 4, 14)) },
    { id: 'later', title: 'Call', start: iso(at(2026, 11, 4, 16)), end: iso(at(2026, 11, 4, 17)) },
    { id: 'allday', title: 'Birthday', start: '2026-11-04', end: '2026-11-05', allDay: true },
  ]
  const [today] = agendaDays(events, [], RANGE, NOW)
  assert.deepEqual(today.events.map((e) => [e.ev.id, e.past, e.ongoing]), [
    ['allday', false, true], ['done', true, false], ['live', false, true], ['later', false, false],
  ])
  assert.equal(today.nowAt, 2)
})

test('after the last event the now line goes at the end', () => {
  const events = [{ id: 'x', title: 'Early', start: iso(at(2026, 11, 4, 8)), end: iso(at(2026, 11, 4, 9)) }]
  const [today] = agendaDays(events, [], RANGE, NOW)
  assert.equal(today.nowAt, 1)
})

test('an event that began before the range sits on its first day, and still counts as now', () => {
  const events = [
    { id: 'trip', title: 'Conference', start: '2026-11-02', end: '2026-11-06', allDay: true },
    { id: 'night', title: 'Night shift', start: iso(at(2026, 11, 3, 22)), end: iso(at(2026, 11, 4, 14)) },
  ]
  const [today] = agendaDays(events, [], RANGE, NOW)
  assert.equal(today.key, '2026-11-04')
  assert.deepEqual(today.events.map((e) => [e.ev.id, e.past, e.ongoing]), [['trip', false, true], ['night', false, true]])
  assert.equal(today.nowAt, 1)
})

test('away days get a heading and carry their span', () => {
  const span = { id: 's', start: '2026-11-10', end: '2026-11-11', label: 'Lisbon', kind: 'trip' }
  const days = agendaDays([], [span], RANGE, NOW)
  assert.deepEqual(days.map((d) => d.key), ['2026-11-04', '2026-11-05', '2026-11-10', '2026-11-11'])
  assert.equal(days[2].away.label, 'Lisbon')
  assert.equal(days[0].away, null)
})

test('a range that does not include today adds no empty today', () => {
  const days = agendaDays([], [], [at(2026, 12, 1), at(2026, 12, 15)], NOW)
  assert.deepEqual(days, [])
})

test('parseView falls back to the agenda', () => {
  assert.equal(DEFAULT_VIEW, 'agenda')
  assert.equal(parseView('month'), 'month')
  assert.equal(parseView('fortnight'), 'agenda')
  assert.equal(parseView(null), 'agenda')
})

test('compactTitle keeps the toolbar short and drops this year', () => {
  const md = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  assert.equal(compactTitle('week', NOW, NOW), `${md(at(2026, 11, 1))} – 7`)
  assert.equal(compactTitle('workweek', NOW, NOW), `${md(at(2026, 11, 2))} – 6`)
  assert.equal(compactTitle('agenda', NOW, NOW), `${md(at(2026, 11, 4))} – 17`)
  assert.equal(compactTitle('agenda', at(2026, 11, 25), NOW), `${md(at(2026, 11, 25))} – ${md(at(2026, 12, 8))}`)
  assert.equal(compactTitle('agenda', at(2026, 12, 25), NOW), `${md(at(2026, 12, 25))} – ${md(at(2027, 1, 7))}, 2027`)
  assert.equal(compactTitle('year', NOW, NOW), '2026')
  assert.equal(compactTitle('month', at(2027, 2, 3), NOW), at(2027, 2, 3).toLocaleDateString([], { month: 'long', year: 'numeric' }))
  assert.ok(!compactTitle('day', NOW, NOW).includes('2026'))
})
