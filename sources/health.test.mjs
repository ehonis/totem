import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deriveHealth, describeSourceId, failingNoticeKey, foldRun, markUnconfigured, needsNotice } from './health.mjs'
import { failingFacts, failingNotice } from './notice.mjs'

const T0 = Date.parse('2026-10-30T12:00:00.000Z')
const at = (min) => new Date(T0 + min * 60_000).toISOString()
const run = (min, ok, extra = {}) => ({ source: 'strava', startedAt: at(min), finishedAt: at(min), ok, error: ok ? null : 'HTTP 502', rows: null, ...extra })
const outage = (from, count, every = 10) => Array.from({ length: count }, (_, i) => run(from + i * every, false))

test('one failure is degraded, not failing, and raises nothing', () => {
  const { health, alerts } = deriveHealth([run(0, true, { rows: 12 }), run(10, false)])
  const h = health.get('strava')
  assert.equal(h.state, 'degraded')
  assert.equal(h.failures, 1)
  assert.equal(h.failingSince, at(10))
  assert.equal(h.lastOkAt, at(0))
  assert.equal(h.rows, 12)
  assert.deepEqual(alerts, [])
})

test('three failures over ten minutes is failing, alerts once, and keeps when the streak began', () => {
  const { health, alerts } = deriveHealth([run(0, true), ...outage(10, 5)])
  const h = health.get('strava')
  assert.equal(h.state, 'failing')
  assert.equal(h.failures, 5)
  assert.equal(h.failingSince, at(10))
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].lastRunAt, at(30))
})

test('a burst is not an outage: many failures inside ten minutes stay degraded', () => {
  const { health, alerts } = deriveHealth(outage(0, 8, 0.1))
  assert.equal(health.get('strava').state, 'degraded')
  assert.equal(health.get('strava').failures, 8)
  assert.deepEqual(alerts, [])
})

test('a working run recovers the source and clears the streak', () => {
  const { health } = deriveHealth([...outage(0, 3), run(30, true, { rows: 3 })])
  const h = health.get('strava')
  assert.equal(h.state, 'ok')
  assert.equal(h.failures, 0)
  assert.equal(h.failingSince, null)
  assert.equal(h.error, null)
  assert.equal(h.lastOkAt, at(30))
  assert.equal(h.lastErrorAt, at(20))
  assert.equal(h.rows, 3)
})

test('a flapping source (fail, fail, ok) stays degraded and is never announced', () => {
  const runs = []
  for (let i = 0; i < 60; i += 1) runs.push(run(i * 10, i % 3 === 2))
  const { health, alerts } = deriveHealth(runs)
  assert.equal(alerts.length, 0)
  assert.notEqual(health.get('strava').state, 'failing')
})

test('an outage that starts inside the cool-down is announced once the cool-down ends', () => {
  // Two long outages two hours apart: the first is announced at once, the second
  // when six hours have passed since that notice, while it is still failing.
  const runs = [...outage(0, 6), run(60, true), ...outage(180, 60)]
  const { alerts } = deriveHealth(runs)
  assert.equal(alerts.length, 2)
  assert.equal(alerts[0].lastRunAt, at(20))
  assert.equal(alerts[1].failingSince, at(180))
  assert.ok(Date.parse(alerts[1].lastRunAt) - Date.parse(alerts[0].lastRunAt) >= 6 * 60 * 60 * 1000)
})

test('a long outage is announced once however long it lasts', () => {
  const { alerts } = deriveHealth(outage(0, 300))
  assert.equal(alerts.length, 1)
})

test('a notice that was not sent is due again on the next failing run', () => {
  let h = null
  for (const r of outage(0, 3)) h = foldRun(h, r).health
  assert.equal(needsNotice(h, at(20)), true)
  // The store marks it only once the queue took it; unmarked, the next failure asks again.
  const next = foldRun(h, run(30, false))
  assert.equal(next.notify, true)
  assert.equal(needsNotice({ ...next.health, notifiedAt: at(30) }, at(40)), false)
})

test('sources fold independently', () => {
  const { health } = deriveHealth([run(0, false), run(1, true, { source: 'gmail:home' }), run(2, false)])
  assert.equal(health.get('strava').failures, 2)
  assert.equal(health.get('gmail:home').state, 'ok')
})

test('not set up ends a streak without counting as a failure', () => {
  let h = null
  for (const r of outage(0, 3)) h = foldRun(h, r).health
  const u = markUnconfigured(h, 'mcp:plaud', { at: at(40), reason: 'waiting for its sign-in' })
  assert.equal(u.state, 'unconfigured')
  assert.equal(u.failures, 0)
  assert.equal(u.failingSince, null)
  assert.equal(needsNotice(u, at(40)), false)
})

test('source ids read as names', () => {
  assert.equal(describeSourceId('gmail:home').label, 'Gmail · home')
  assert.equal(describeSourceId('strava').via, 'read through Bushido')
  assert.equal(describeSourceId('mystery').label, 'mystery')
})

test('the notice names the source and the goals it feeds, never the error, and is keyed per outage', () => {
  const { health } = deriveHealth(outage(0, 4).map((r) => ({ ...r, error: 'GET /x?q=private-thing HTTP 503' })))
  const h = health.get('strava')
  const n = failingNotice(h, { feeds: ['Ride 40 miles'] })
  assert.equal(n.title, 'Strava is failing')
  assert.ok(!n.body.includes('private-thing'))
  assert.match(n.body, /4 failed reads in a row over 30 min\. It feeds Ride 40 miles\. See Settings → Connections/)
  assert.equal(n.dedupeKey, `source:strava:failing:${at(0)}`)
  assert.deepEqual(n.revalidate, { factKey: n.dedupeKey })
  assert.equal(n.url, '/settings/connections')
})

test('a queued notice stays deliverable only while its source is still failing', () => {
  const failing = deriveHealth(outage(0, 4)).health.get('strava')
  const recovered = deriveHealth([...outage(0, 4), run(40, true)]).health.get('strava')
  assert.deepEqual(failingFacts([failing]).map((f) => f.revalidate.factKey), [failingNoticeKey(failing)])
  assert.deepEqual(failingFacts([recovered]), [])
  // The next outage is a different notice.
  const again = deriveHealth([...outage(0, 4), run(40, true), ...outage(50, 4)]).health.get('strava')
  assert.notEqual(failingNoticeKey(again), failingNoticeKey(failing))
})
