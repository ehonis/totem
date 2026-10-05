import test from 'node:test'
import assert from 'node:assert/strict'
import { createSteering, progressNote, steerPrompt } from './steer.mjs'
import { applyEvent, renderTranscript } from './turn.mjs'
import { normalizePart } from './store.mjs'

test('a live streamer takes the steer straight into the turn', () => {
  const s = createSteering()
  const got = []
  s.attachLive((steer) => { got.push(steer.text); return true })
  assert.equal(s.send({ text: 'use the other repo' }), 'live')
  assert.deepEqual(got, ['use the other repo'])
  assert.equal(s.waiting, 0)
})

test('without a live streamer the attempt is interrupted and the steer waits', () => {
  const s = createSteering()
  let interrupted = 0
  const detach = s.attachInterrupt(() => { interrupted += 1 })
  assert.equal(s.send({ text: 'stop, wrong file' }), 'restart')
  assert.equal(s.send({ text: 'and check the tests' }), 'restart')
  assert.equal(interrupted, 2)
  detach()
  assert.deepEqual(s.take().map((x) => x.text), ['stop, wrong file', 'and check the tests'])
  assert.equal(s.waiting, 0)
})

test('a live streamer whose stdin has closed falls back to waiting', () => {
  const s = createSteering()
  s.attachLive(() => false)
  assert.equal(s.send({ text: 'late' }), 'restart')
  assert.equal(s.waiting, 1)
})

test('a closed run refuses steers', () => {
  const s = createSteering()
  s.close()
  assert.equal(s.send({ text: 'too late' }), null)
  assert.equal(s.waiting, 0)
})

test('detaching only removes the handler that attached', () => {
  const s = createSteering()
  const first = s.attachLive(() => true)
  s.attachLive(() => false)
  first()
  assert.equal(s.send({ text: 'x' }), 'restart')
})

test('the restart prompt carries what was done and the owner\'s words', () => {
  const msg = { content: 'Looking at the config first.', parts: [{ type: 'text', text: 'Looking at the config first.' }, { type: 'tool', title: 'Ran a command', detail: 'rm -rf build', status: 'running' }] }
  const note = progressNote(msg)
  assert.match(note, /Ran a command: rm -rf build \(cut off\)/)
  assert.match(note, /Looking at the config first/)
  const prompt = steerPrompt([{ text: 'don\'t delete build' }], { owner: 'Sam', progress: note })
  assert.match(prompt, /interrupted your reply/)
  assert.match(prompt, /Sam: don't delete build$/)
  assert.equal(progressNote({ parts: [] }), '')
})

test('a steer becomes a part where it landed, once', () => {
  const msg = { role: 'assistant', content: '', parts: [] }
  applyEvent(msg, { type: 'delta', text: 'Checking. ' })
  applyEvent(msg, { type: 'steer', steer: { id: 's1', text: 'look in src', via: 'live', createdAt: 5 } })
  applyEvent(msg, { type: 'steer', steer: { id: 's1', text: 'look in src', via: 'live', createdAt: 5 } })
  applyEvent(msg, { type: 'delta', text: 'Found it in src.' })
  assert.deepEqual(msg.parts.map((p) => p.type), ['text', 'steer', 'text'])
  assert.equal(msg.parts[1].via, 'live')
  // Text after a steer is a new run of text, not glued onto the one before it.
  assert.equal(msg.parts[2].text, 'Found it in src.')
  assert.equal(msg.content, 'Checking.\n\nFound it in src.')
  // It survives the thread store, which drops part types it does not know.
  assert.deepEqual(normalizePart(msg.parts[1]), { type: 'steer', id: 's1', text: 'look in src', via: 'live', createdAt: 5 })
  assert.equal(normalizePart({ type: 'steer', text: '  ' }), null)
  const replay = renderTranscript([{ role: 'user', content: 'find it' }, msg])
  assert.match(replay, /Checking\.\s+\[Owner, mid-reply: look in src\]\s+Found it in src\./)
})
