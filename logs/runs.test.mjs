// Run with: node --test logs/runs.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRunRegistry } from './runs.mjs'

const startCommand = (reg, id = 'P1', extra = {}) =>
  reg.start({ id, kind: 'command', label: 'git status', actor: 'chatgpt', ...extra })

test('a started run is listed as running with no output yet', () => {
  const reg = createRunRegistry()
  const run = startCommand(reg)
  assert.equal(run.status, 'running')
  assert.equal(run.lastSeq, 0)
  assert.equal(reg.anyRunning(), true)
  assert.equal(reg.list().length, 1)
})

test('the since cursor returns only new chunks', () => {
  const reg = createRunRegistry()
  startCommand(reg)
  reg.append('P1', { text: 'first\n' })
  reg.append('P1', { text: 'second\n' })

  const all = reg.get('P1', { since: 0 })
  assert.equal(all.chunks.length, 2)

  // Poll again from where we left off: a tail, not the whole buffer.
  const tail = reg.get('P1', { since: all.lastSeq })
  assert.equal(tail.chunks.length, 0)

  reg.append('P1', { text: 'third\n' })
  const next = reg.get('P1', { since: all.lastSeq })
  assert.equal(next.chunks.length, 1)
  assert.equal(next.chunks[0].text, 'third\n')
})

test('chunk seqs are globally monotonic across runs', () => {
  const reg = createRunRegistry()
  startCommand(reg, 'P1')
  startCommand(reg, 'P2')
  const a = reg.append('P1', { text: 'a' })
  const b = reg.append('P2', { text: 'b' })
  const c = reg.append('P1', { text: 'c' })
  assert.ok(a < b && b < c, 'a shared counter keeps ordering meaningful across runs')
})

test('the buffer keeps the tail and admits it truncated', () => {
  const reg = createRunRegistry({ maxChunkBytes: 40 })
  startCommand(reg)
  for (let i = 0; i < 20; i++) reg.append('P1', { text: `line-${i}\n` })
  const run = reg.get('P1', { since: 0 })
  assert.ok(run.truncated, 'dropping output silently would be a lie')
  assert.ok(run.chunks.length < 20)
  // What survives is the END of the output, which is the useful half.
  assert.match(run.chunks[run.chunks.length - 1].text, /line-19/)
})

test('unknown streams fall back rather than corrupting the styling contract', () => {
  const reg = createRunRegistry()
  startCommand(reg)
  reg.append('P1', { stream: 'nonsense', text: 'x' })
  assert.equal(reg.get('P1', { since: 0 }).chunks[0].stream, 'stdout')
})

test('appending to an unknown or finished-and-swept run is a no-op, not a throw', () => {
  const reg = createRunRegistry()
  assert.equal(reg.append('nope', { text: 'x' }), null)
  assert.equal(reg.get('nope'), null)
  assert.equal(reg.finish('nope', { status: 'ok' }), null)
})

test('finishing records the outcome and keeps the transcript readable', () => {
  let clock = 1000
  const reg = createRunRegistry({ now: () => clock })
  startCommand(reg)
  reg.append('P1', { text: 'output\n' })
  clock = 3500
  const done = reg.finish('P1', { status: 'ok', exitCode: 0 })
  assert.equal(done.status, 'ok')
  assert.equal(done.exitCode, 0)
  assert.equal(done.ms, 2500)
  assert.equal(reg.anyRunning(), false)
  // Still readable afterwards — that is the "recently finished" case.
  assert.equal(reg.get('P1', { since: 0 }).chunks.length, 1)
})

test('finished runs are swept after the grace period, running ones never', () => {
  let clock = 1000
  const reg = createRunRegistry({ now: () => clock, keepFinishedMs: 1000 })
  startCommand(reg, 'done')
  startCommand(reg, 'live')
  reg.finish('done', { status: 'ok', exitCode: 0 })

  clock += 5000
  const ids = reg.list().map((r) => r.id)
  assert.deepEqual(ids, ['live'], 'the finished run aged out, the live one stayed')
})

test('eviction never removes a running run', () => {
  let clock = 1000
  const reg = createRunRegistry({ now: () => clock, maxRuns: 3 })
  startCommand(reg, 'live')
  for (let i = 0; i < 10; i++) {
    clock += 10
    startCommand(reg, `done-${i}`)
    reg.finish(`done-${i}`, { status: 'ok', exitCode: 0 })
  }
  const ids = reg.list().map((r) => r.id)
  assert.ok(ids.includes('live'), 'a live process with no registry entry is unstoppable and invisible')
  assert.ok(ids.length <= 4)
})

test('running runs sort ahead of finished ones', () => {
  let clock = 1000
  const reg = createRunRegistry({ now: () => clock })
  startCommand(reg, 'old-done')
  reg.finish('old-done', { status: 'ok', exitCode: 0 })
  clock += 100
  startCommand(reg, 'live')
  assert.equal(reg.list()[0].id, 'live')
})

test('stop invokes abort, notes it in the transcript, and leaves finishing to the child', () => {
  let aborted = 0
  const reg = createRunRegistry()
  startCommand(reg, 'P1', { abort: () => { aborted++ } })
  assert.equal(reg.get('P1').canStop, true)

  assert.equal(reg.stop('P1'), true)
  assert.equal(aborted, 1)
  // One code path for "how a run ends": the child's close handler, not stop().
  assert.equal(reg.get('P1').status, 'running')
  assert.match(reg.get('P1', { since: 0 }).chunks.at(-1).text, /stopped by the owner/)
})

test('stop is honest when there is nothing to stop', () => {
  const reg = createRunRegistry()
  startCommand(reg, 'no-abort')                       // no abort fn supplied
  assert.equal(reg.get('no-abort').canStop, false)
  assert.equal(reg.stop('no-abort'), false)

  startCommand(reg, 'finished', { abort: () => {} })
  reg.finish('finished', { status: 'ok', exitCode: 0 })
  assert.equal(reg.stop('finished'), false)
  assert.equal(reg.stop('never-existed'), false)
})

test('a stop that throws is reported as failure, not propagated', () => {
  const reg = createRunRegistry()
  startCommand(reg, 'P1', { abort: () => { throw new Error('already dead') } })
  assert.equal(reg.stop('P1'), false)
})

test('restarting the same id replaces the old transcript', () => {
  const reg = createRunRegistry()
  startCommand(reg, 'P1')
  reg.append('P1', { text: 'from the first run\n' })
  reg.finish('P1', { status: 'error', exitCode: 1 })

  startCommand(reg, 'P1')
  const run = reg.get('P1', { since: 0 })
  assert.equal(run.status, 'running')
  assert.equal(run.chunks.length, 0, 'a re-accepted proposal starts a fresh transcript')
  assert.equal(run.exitCode, null)
})

test('agent runs carry provider and model, and mixed streams keep their labels', () => {
  const reg = createRunRegistry()
  reg.start({ id: 'P9', kind: 'agent', label: 'Refactor the poller', actor: 'chatgpt', provider: 'codex', model: 'gpt-5.5' })
  reg.append('P9', { stream: 'activity', text: 'Reading ai-usage/poller.mjs' })
  reg.append('P9', { stream: 'text', text: 'I will start by' })
  reg.append('P9', { stream: 'tool', text: 'Edited files' })

  const run = reg.get('P9', { since: 0 })
  assert.equal(run.provider, 'codex')
  assert.equal(run.model, 'gpt-5.5')
  assert.deepEqual(run.chunks.map((c) => c.stream), ['activity', 'text', 'tool'])
})
