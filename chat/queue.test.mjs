// node --test chat/queue.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveQueued, queueAfterRun } from './queue.mjs'
import { createThreadStore, normalizePart } from './store.mjs'
import { createChatRuns } from './runs.mjs'
import { steerPrompt, steerText } from './steer.mjs'
import { applyEvent } from './turn.mjs'

const q = (...ids) => ids.map((id) => ({ id, text: id }))
const ids = (list) => list.map((x) => x.id)

test('a queued message moves before another, or to the end', () => {
  assert.deepEqual(ids(moveQueued(q('a', 'b', 'c'), 'c', 'a')), ['c', 'a', 'b'])
  assert.deepEqual(ids(moveQueued(q('a', 'b', 'c'), 'a', null)), ['b', 'c', 'a'])
  assert.deepEqual(ids(moveQueued(q('a', 'b', 'c'), 'a', 'c')), ['b', 'a', 'c'])
  // Unknown ids leave the queue alone.
  assert.deepEqual(ids(moveQueued(q('a', 'b'), 'x', 'a')), ['a', 'b'])
  assert.deepEqual(ids(moveQueued(q('a', 'b'), 'a', 'x')), ['a', 'b'])
})

test('a finished run starts the next message; a stopped or failed one holds the queue', () => {
  const thread = { queue: q('a') }
  assert.equal(queueAfterRun(thread, 'done'), 'start')
  assert.equal(queueAfterRun(thread, 'stopped'), 'hold')
  assert.equal(queueAfterRun(thread, 'error'), 'hold')
  assert.equal(queueAfterRun({ ...thread, queueHeld: true }, 'done'), 'none')
  assert.equal(queueAfterRun({ queue: [] }, 'done'), 'none')
})

test('the thread store keeps the queue the bridge writes, never one a client sends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'totem-queue-'))
  const store = createThreadStore({ dir })
  const att = { id: 'upload1234', name: 'shot.png', mime: 'image/png', size: 10, kind: 'image' }
  await store.update('t1', (t) => {
    t.queue = [
      { id: 'q1', text: 'then do this', attachments: [att], provider: 'claude', modelSettings: { modelId: 'opus', bogus: 1 }, createdAt: 5 },
      { id: 'q2', text: '', attachments: [] }, // nothing to send: dropped
    ]
    t.queueHeld = true
  }, { create: { kind: 'regular' } })
  let t = await store.get('t1')
  assert.deepEqual(ids(t.queue), ['q1'])
  assert.deepEqual(t.queue[0].attachments, [att])
  assert.deepEqual(t.queue[0].modelSettings, { modelId: 'opus' })
  assert.equal(t.queueHeld, true)

  // A client PUT carries no queue of its own.
  await store.put('t1', { title: 'Renamed', queue: [{ id: 'evil', text: 'x' }], queueHeld: false })
  t = await store.get('t1')
  assert.deepEqual(ids(t.queue), ['q1'])
  // Nor does a brand-new thread a client creates.
  await store.put('t2', { messages: [], queue: [{ id: 'evil', text: 'x' }] })
  assert.equal((await store.get('t2')).queue, undefined)

  // An empty queue is never held.
  await store.update('t1', (t) => { t.queue = [] })
  t = await store.get('t1')
  assert.equal(t.queue, undefined)
  assert.equal(t.queueHeld, undefined)
  await rm(dir, { recursive: true, force: true })
})

test('a steer keeps its files, and one with only files is kept', () => {
  const att = { id: 'upload1234', name: 'shot.png', mime: 'image/png', size: 10, kind: 'image' }
  const msg = { role: 'assistant', content: 'working', parts: [] }
  applyEvent(msg, { type: 'steer', steer: { id: 's1', text: '', via: 'live', attachments: [att] } })
  assert.deepEqual(msg.parts[0].attachments, [att])
  assert.deepEqual(normalizePart(msg.parts[0]).attachments, [att])
  assert.equal(normalizePart({ type: 'steer', id: 's2', text: '' }), null)
})

test('a steer with files lists their paths for the agent', () => {
  const files = [{ name: 'shot.png', kind: 'image', size: 2048, path: '/data/uploads/shot.png' }]
  const words = steerText({ text: 'this one', files })
  assert.match(words, /shot\.png \(image, 2 KB\): \/data\/uploads\/shot\.png/)
  assert.match(words, /this one$/)
  assert.match(steerText({ text: '', files }), /sent only the attachments/)
  assert.match(steerPrompt([{ text: 'look', files }]), /Owner: ATTACHMENTS:[\s\S]*look/)
})

test('a run tells its end hook once it has ended', async () => {
  const ended = []
  const runs = createChatRuns({ onEnd: (run) => ended.push([run.threadId, run.outcome]) })
  runs.start('t1', { id: 'r1', execute: async ({ run }) => { run.outcome = 'done' } })
  assert.equal(runs.notify('t1', { type: 'queue', queue: [] }), true)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(ended, [['t1', 'done']])
  assert.equal(runs.notify('t1', { type: 'queue', queue: [] }), false)
})
