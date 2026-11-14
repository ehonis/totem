import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LANDING_TIMEOUT_MS, farIndex, finishLanding, goalAnchor, hitLanding, pendingLanding, pollLanding, requestLanding, subscribeLanding,
} from './landing.ts'

test('a landing waits only for its own kind, and drops out after the timeout', () => {
  requestLanding('task', 't1', { item: 'x', empty: '' }, 1000)
  assert.equal(pendingLanding('goal', 1000), null)
  assert.deepEqual(pendingLanding('task', 1000)?.extra, { item: 'x' })
  assert.equal(pendingLanding('task', 1000 + LANDING_TIMEOUT_MS + 1), null)
  const old = pendingLanding('task', 1000)
  requestLanding('task', 'new', {}, 2000)
  finishLanding(old)
  assert.equal(pendingLanding('task', 2000)?.id, 'new')
  requestLanding('task', null)
})

test('hitLanding maps a search target to what the screen looks for (the web\'s mapping)', () => {
  assert.deepEqual(hitLanding({ tab: 'chat', thread: 't', message: 'm' }), { kind: 'msg', id: 'm', extra: {} })
  assert.equal(hitLanding({ tab: 'chat', thread: 't' }), null)
  assert.deepEqual(hitLanding({ tab: 'productivity', app: 'lists', id: 'L', item: 'i' }), { kind: 'list', id: 'L', extra: { item: 'i' } })
  assert.deepEqual(hitLanding({ tab: 'productivity', app: 'goals', id: 'g', period: 'week', start: '2026-11-09', end: '2026-11-15' }),
    { kind: 'goal', id: 'g', extra: { period: 'week', start: '2026-11-09', end: '2026-11-15' } })
  assert.deepEqual(hitLanding({ tab: 'totems', totem: 'j', section: 'memory' }), { kind: 'totem', id: 'j', extra: { section: 'memory' } })
  assert.deepEqual(hitLanding({ tab: 'productivity', app: 'todos', id: 'x' }), { kind: 'task', id: 'x', extra: {} })
  assert.equal(hitLanding({ tab: 'productivity', app: 'habits' }), null)
})

test('goalAnchor steps to an earlier window only', () => {
  const extra = { period: 'week', start: '2026-11-09', end: '2026-11-15' }
  assert.equal(goalAnchor(extra, '2026-11-14'), null)
  assert.deepEqual(goalAnchor(extra, '2026-11-20'), { type: 'week', start: '2026-11-09' })
})

test('pollLanding keeps asking until the screen finds the item, then finishes it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  requestLanding('task', 'a', {}, 0)
  const landing = pendingLanding('task', 0)
  let shown = false
  const done = []
  pollLanding(landing, () => (shown ? 'a' : null), (key) => done.push(key), { now: () => 0 })
  t.mock.timers.tick(1000)
  assert.deepEqual(done, [])
  shown = true
  t.mock.timers.tick(150)
  assert.deepEqual(done, ['a'])
  assert.equal(pendingLanding('task', 0), null)
})

test('pollLanding gives up quietly at the timeout, and stops when told to', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let clock = 0
  requestLanding('goal', 'g', {}, 0)
  const done = []
  pollLanding(pendingLanding('goal', 0), () => null, (key) => done.push(key), { now: () => clock })
  clock = LANDING_TIMEOUT_MS
  t.mock.timers.tick(200)
  assert.deepEqual(done, [null])
  requestLanding('goal', 'h', {}, 0)
  const asked = []
  const stop = pollLanding(pendingLanding('goal', 0), () => { asked.push(1); return null }, () => done.push('late'), { now: () => 0 })
  t.mock.timers.tick(200)
  stop()
  const n = asked.length
  t.mock.timers.tick(5000)
  assert.equal(asked.length, n)
  assert.deepEqual(done, [null])
  requestLanding('goal', null)
})

test('farIndex: a target more than two screens of rows away jumps', () => {
  assert.equal(farIndex(59, 55, 3), false)
  assert.equal(farIndex(119, 6, 3), true)
  assert.equal(farIndex(0, 25, 10), true)
  assert.equal(farIndex(0, 12, 10), false)
})

// #266 round 2: a chat left or hidden mid-landing stops polling without finishing,
// and the app's chat held its end off for as long as the request stayed pending.
test('an abandoned landing drops itself at the timeout and tells its subscribers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let told = 0
  const off = subscribeLanding(() => { told += 1 })
  requestLanding('msg', 'm1', {}, 0)
  assert.equal(told, 1)
  t.mock.timers.tick(LANDING_TIMEOUT_MS + 60)
  assert.equal(told, 2)
  assert.equal(pendingLanding('msg', 0), null)
  // A newer request is not dropped by the older one's timer.
  requestLanding('msg', 'a', {}, 0)
  t.mock.timers.tick(LANDING_TIMEOUT_MS - 1000)
  requestLanding('msg', 'b', {}, 0)
  t.mock.timers.tick(1100)
  assert.equal(pendingLanding('msg', 0)?.id, 'b')
  off()
  requestLanding('msg', null)
})
