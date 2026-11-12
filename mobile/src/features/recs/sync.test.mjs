// Which bridge answer the Recs page draws when decisions overlap (#181, council S-F7).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRevisions, saveThenRefresh } from './sync.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setImmediate(r))

function decision(revisions, name, log) {
  const change = deferred()
  const fetch = deferred()
  const done = saveThenRefresh(revisions, {
    change: () => change.promise,
    saved: (r) => log.push(`saved ${r}`),
    refetch: () => fetch.promise,
    fresh: (ledger) => log.push(`drew ${ledger}`),
  })
  return { change, fetch, done }
}

test('two decisions landing out of order end on the later one\'s refetch', async () => {
  const revisions = createRevisions()
  const log = []
  const a = decision(revisions, 'A', log)
  const b = decision(revisions, 'B', log)
  // B lands first and refetches while A is still saving: its ledger shows A pending.
  b.change.resolve('B'); await tick()
  a.change.resolve('A'); await tick()
  b.fetch.resolve('ledger with A pending'); await tick()
  a.fetch.resolve('ledger with A and B decided'); await tick()
  await Promise.all([a.done, b.done])
  assert.deepEqual(log, ['saved B', 'saved A', 'drew ledger with A and B decided'])
})

test('a read that went out before a change landed is stale', () => {
  const revisions = createRevisions()
  const at = revisions.current()
  revisions.landed()
  assert.notEqual(at, revisions.current())
  const after = revisions.current()
  assert.equal(after, revisions.current())
})

test('one decision on its own draws its refetch', async () => {
  const log = []
  const a = decision(createRevisions(), 'A', log)
  a.change.resolve('A'); a.fetch.resolve('fresh')
  assert.deepEqual(await a.done, { result: 'A' })
  assert.deepEqual(log, ['saved A', 'drew fresh'])
})

test('a failed change rejects and moves nothing on', async () => {
  const revisions = createRevisions()
  const log = []
  const a = decision(revisions, 'A', log)
  a.change.reject(new Error('offline'))
  await assert.rejects(a.done, /offline/)
  assert.equal(revisions.current(), 0)
  assert.deepEqual(log, [])
})

test('a failed refetch still counts as saved', async () => {
  const log = []
  const a = decision(createRevisions(), 'A', log)
  a.change.resolve('A'); a.fetch.reject(new Error('timeout'))
  const out = await a.done
  assert.equal(out.result, 'A')
  assert.match(String(out.refreshError), /timeout/)
  assert.deepEqual(log, ['saved A'])
})
