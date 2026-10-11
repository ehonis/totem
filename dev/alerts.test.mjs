import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { createAlertStore } from './alerts.mjs'
import { mapAlert, mapPosthog } from './ingest.mjs'

const dirs = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function store(clock) {
  const dir = mkdtempSync(join(tmpdir(), 'totem-dev-alerts-'))
  dirs.push(dir)
  const notified = []
  const alerts = createAlertStore({ file: join(dir, 'dev-alerts.json'), notify: async (n) => { notified.push(n) }, now: () => clock.t })
  return { alerts, notified }
}

test('the same source and key within an hour is recorded but not pushed again', async () => {
  const clock = { t: Date.parse('2026-10-09T10:00:00Z') }
  const { alerts, notified } = store(clock)
  assert.equal((await alerts.record({ source: 'posthog', title: 'Errors up', key: 'errors' })).notified, true)
  clock.t += 30 * 60_000
  assert.equal((await alerts.record({ source: 'posthog', title: 'Errors up again', key: 'errors' })).notified, false)
  assert.equal((await alerts.record({ source: 'other', title: 'Errors up', key: 'errors' })).notified, true, 'another source is its own alert')
  clock.t += 31 * 60_000
  assert.equal((await alerts.record({ source: 'posthog', title: 'Errors up', key: 'errors' })).notified, true, 'an hour after the last push it goes out again')

  assert.equal(notified.length, 3)
  const list = await alerts.list()
  assert.equal(list.length, 4, 'every alert is kept')
  assert.deepEqual(list.map((a) => a.delivered), [true, true, false, true])
})

test('the store keeps the last 200 alerts', async () => {
  const clock = { t: 0 }
  const { alerts } = store(clock)
  for (let i = 0; i < 205; i++) await alerts.record({ source: 's', title: `t${i}`, key: `k${i}` })
  const list = await alerts.list(500)
  assert.equal(list.length, 200)
  assert.equal(list[0].title, 't204')
})

test('PostHog webhook payloads become a title, body, link and key', () => {
  const exception = mapPosthog({
    event: {
      event: '$exception',
      url: 'https://posthog.example/project/1/events/abc',
      properties: { $exception_list: [{ type: 'TypeError', value: 'x is undefined' }], $exception_fingerprint: 'fp1' },
    },
    project: { name: 'Shop' },
  })
  assert.deepEqual(exception, { title: 'Shop: Exception: TypeError', body: 'x is undefined', url: 'https://posthog.example/project/1/events/abc', key: 'fp1' })

  const custom = mapPosthog({ event: { event: 'checkout_failed', properties: { plan: 'pro', $browser: 'Safari', amount: 20 } } })
  assert.deepEqual(custom, { title: 'checkout_failed', body: 'plan: pro, amount: 20', url: null, key: 'checkout_failed' })

  const legacy = mapPosthog({ text: 'Action fired\nby someone' })
  assert.equal(legacy.title, 'Action fired')
})

test('the generic shape wins, and unknown shapes fall back to a short JSON summary', () => {
  assert.deepEqual(mapAlert('cron', { title: 'Backup missed', body: 'nightly', url: 'https://example.com', key: 'b' }),
    { title: 'Backup missed', body: 'nightly', url: 'https://example.com', key: 'b' })
  const unknown = mapAlert('posthog', { weird: 'x'.repeat(1000) })
  assert.equal(unknown.title, 'Alert from posthog')
  assert.ok(unknown.body.length <= 300)
})
