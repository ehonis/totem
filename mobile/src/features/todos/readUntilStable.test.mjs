// The board read's retry (readUntilStable.ts): a fetch that saw a local change land
// while it was out is never applied, and the caller waits for the fetch that was.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readUntilStable } from './readUntilStable.ts'

function gated() {
  const calls = []
  const fetch = () => new Promise((resolve) => { calls.push(resolve) })
  return { fetch, calls }
}
const tick = () => new Promise((r) => setImmediate(r))

test('a quiet board applies the first fetch', async () => {
  const { fetch, calls } = gated()
  const applied = []
  const read = readUntilStable(fetch, () => 0, (r) => applied.push(r))
  calls[0]('board')
  await read
  assert.deepEqual(applied, ['board'])
  // Tells a fresh board from a stale one.
  const flags = []
  const again = gated()
  const second = readUntilStable(again.fetch, () => 0, (_r, stale) => flags.push(stale))
  again.calls[0]('board')
  await second
  assert.deepEqual(flags, [false])
  assert.equal(calls.length, 1)
})

test('a change mid-fetch drops that result, and the caller waits for the next fetch', async () => {
  const { fetch, calls } = gated()
  let version = 0
  const applied = []
  let settled = false
  const read = readUntilStable(fetch, () => version, (r) => applied.push(r)).then(() => { settled = true })
  version += 1 // an optimistic tick lands while the first fetch is out
  calls[0]('stale')
  await tick()
  assert.equal(calls.length, 2, 'fetched again')
  assert.deepEqual(applied, [], 'the stale board is never applied')
  assert.equal(settled, false, 'and the caller is still waiting')
  calls[1]('fresh')
  await read
  assert.deepEqual(applied, ['fresh'])
  assert.equal(settled, true)
})

test('a board that keeps changing still loads after the last try', async () => {
  const { fetch, calls } = gated()
  let version = 0
  const applied = []
  const read = readUntilStable(fetch, () => version, (r, stale) => applied.push([r, stale]), 3)
  for (let i = 0; i < 3; i += 1) {
    version += 1
    calls[i](`read ${i + 1}`)
    await tick()
  }
  await read
  assert.equal(calls.length, 3)
  // Applied, and flagged stale so the store reads once more after it.
  assert.deepEqual(applied, [['read 3', true]])
})

test('a failed fetch rejects without applying anything', async () => {
  const applied = []
  await assert.rejects(readUntilStable(() => Promise.reject(new Error('offline')), () => 0, (r) => applied.push(r)), /offline/)
  assert.deepEqual(applied, [])
})
