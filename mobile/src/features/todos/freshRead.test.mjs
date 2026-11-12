// loadBoard's coalescing (freshRead.ts): a call made while a read runs waits for a
// read that starts after it, never the one already in flight.
import test from 'node:test'
import assert from 'node:assert/strict'
import { freshRead } from './freshRead.ts'

function gatedLoad() {
  const started = []
  const load = () => new Promise((resolve, reject) => { started.push({ resolve, reject }) })
  return { load, started }
}

test('the first call starts a read; a call during it waits for a second read, which starts only after the first', async () => {
  const { load, started } = gatedLoad()
  const read = freshRead(load)
  const first = read()
  assert.equal(started.length, 1)
  let secondDone = false
  const second = read().then(() => { secondDone = true })
  assert.equal(started.length, 1, 'the second read waits for the first to finish')
  started[0].resolve()
  await first
  await new Promise((r) => setImmediate(r))
  assert.equal(started.length, 2, 'then a fresh read starts')
  assert.equal(secondDone, false, 'and the caller waits for it, not the stale one')
  started[1].resolve()
  await second
  assert.equal(secondDone, true)
})

test('calls in the same window share one follow-up read', async () => {
  const { load, started } = gatedLoad()
  const read = freshRead(load)
  void read()
  const a = read(), b = read(), c = read()
  assert.equal(a, b); assert.equal(b, c)
  started[0].resolve()
  await new Promise((r) => setImmediate(r))
  assert.equal(started.length, 2)
  started[1].resolve()
  await Promise.all([a, b, c])
  // Idle again: the next call starts straight away.
  void read()
  assert.equal(started.length, 3)
})

test('a failed read still lets the follow-up run', async () => {
  const { load, started } = gatedLoad()
  const read = freshRead(load)
  const first = read().catch(() => 'failed')
  const second = read()
  started[0].reject(new Error('offline'))
  assert.equal(await first, 'failed')
  await new Promise((r) => setImmediate(r))
  assert.equal(started.length, 2)
  started[1].resolve()
  await second
})

test('a read started in the gap after the first never runs alongside the follow-up', async () => {
  const { load, started } = gatedLoad()
  const read = freshRead(load)
  const first = read()
  const queued = read()
  // A continuation of the first read calls again before the queued follow-up gets its turn.
  let third
  first.then(() => { third = read() })
  started[0].resolve()
  await new Promise((r) => setImmediate(r))
  assert.equal(started.length, 2, 'one follow-up read, not two at once')
  started[1].resolve()
  await Promise.all([queued, third])
})
