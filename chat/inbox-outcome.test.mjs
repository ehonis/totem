// Run with: node --test chat/inbox-outcome.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { chatRefMeta, chatRefOf, createInboxOutcomes, outcomeRoute, outcomeText, resultOf } from './inbox-outcome.mjs'
import { normalizeMessage } from './store.mjs'
import { applyEvent } from './turn.mjs'
import { runHeader } from '../mcp-gateway.mjs'

// The two chats a test works on; each reply staged one card.
function fakeThreads() {
  const chat = (id, card) => ({
    id, provider: 'claude', modelSettings: { modelId: 'claude-opus-5-5', effort: 'high' },
    messages: [
      { id: `${id}-u`, role: 'user', content: 'do it' },
      { id: `${id}-run`, role: 'assistant', content: 'Staged.', parts: [{ type: 'inbox', id: card, kind: 'email', title: 'Email Sam', status: 'pending' }] },
    ],
  })
  const store = new Map([['a', chat('a', 'P1')], ['b', chat('b', 'P2')]])
  return {
    store,
    get: async (id) => store.get(id) || null,
    update: async (id, fn) => { const t = store.get(id); fn(t); return t },
  }
}

function harness({ running = false, followUp = 'queue', steerTakes = true } = {}) {
  const threads = fakeThreads()
  const calls = { start: [], queue: [], steer: [] }
  const outcomes = createInboxOutcomes({
    threads,
    running: () => running,
    startTurn: async (turn) => { calls.start.push(turn) },
    steer: async (threadId, text) => { calls.steer.push({ threadId, text }); return steerTakes ? { id: 's' } : null },
    enqueue: async (turn) => { calls.queue.push(turn) },
    followUp: () => followUp,
    now: () => 1000,
  })
  return { threads, calls, outcomes }
}

// As the bridge's parser reads it: "key: value" segments after the title.
const parseMeta = (line) => Object.fromEntries(line.split('|').slice(3).map((s) => s.trim()).filter((s) => s.includes(':')).map((s) => [s.slice(0, s.indexOf(':')).trim(), s.slice(s.indexOf(':') + 1).trim()]))
const item = (meta) => ({ id: meta.id || 'P1', kind: 'email', title: 'Email Sam', meta })

test('the chat and run are written on the line and read back; outside a chat nothing is written', () => {
  const line = `- [ ] P1 | email | Email Sam | email: inbox-prompts/P1.email.json | ${chatRefMeta({ threadId: 'a', runId: 'a-run' }).join(' | ')} | src: claude`
  assert.deepEqual(chatRefOf(parseMeta(line)), { threadId: 'a', runId: 'a-run' })
  assert.deepEqual(chatRefMeta(null), [])
  assert.deepEqual(chatRefMeta({ threadId: 'a b|c', runId: 'r' }), [])
  assert.equal(chatRefOf(parseMeta('- [ ] P1 | todo | Milk | src: journal')), null)
})

test('accepting appends to the chat that staged it, and only that one, as a new turn', async () => {
  const { threads, calls, outcomes } = harness()
  assert.equal(await outcomes.report(item({ thread: 'a', run: 'a-run' }), { action: 'accept', stamp: 'confirmed 2026-11-04 → sent from me to sam (m1)' }), 'start')
  assert.equal(calls.start.length, 1)
  const turn = calls.start[0]
  assert.equal(turn.threadId, 'a')
  assert.deepEqual(turn.inbox, { id: 'P1', status: 'accepted' })
  assert.match(turn.text, /^\[Inbox P1 · email: Email Sam\] The owner accepted it\. Result: sent from me to sam \(m1\)\./)
  assert.equal(turn.provider, 'claude')
  assert.equal(turn.model, 'claude-opus-5-5')
  assert.equal(turn.effort, 'high')
  assert.equal(threads.store.get('a').messages[1].parts[0].status, 'accepted')
  assert.equal(threads.store.get('a').messages[1].parts[0].result, 'sent from me to sam (m1)')
  assert.equal(threads.store.get('b').messages[1].parts[0].status, 'pending')
  assert.equal(threads.store.get('b').messages.length, 2)
})

test('a denial without a note is recorded in the chat and starts no run; with a note it does', async () => {
  const { threads, calls, outcomes } = harness()
  assert.equal(await outcomes.report(item({ thread: 'a', run: 'a-run' }), { action: 'deny', stamp: 'skipped 2026-11-04' }), 'record')
  assert.deepEqual(calls, { start: [], queue: [], steer: [] })
  const recorded = threads.store.get('a').messages[2]
  assert.equal(recorded.role, 'user')
  assert.deepEqual(recorded.inbox, { id: 'P1', status: 'denied' })
  assert.match(recorded.content, /The owner denied it/)
  assert.equal(threads.store.get('a').messages[1].parts[0].status, 'denied')

  const second = harness()
  assert.equal(await second.outcomes.report(item({ thread: 'a', run: 'a-run' }), { action: 'deny', note: '  wrong person  ' }), 'start')
  assert.match(second.calls.start[0].text, /The owner denied it\. Nothing was done\.\n\nThe owner's note: wrong person$/)
  assert.equal(second.threads.store.get('a').messages[1].parts[0].note, 'wrong person')
})

test('no run starts for a denial without a note even while a reply runs', async () => {
  for (const followUp of ['queue', 'steer']) {
    const { calls, outcomes } = harness({ running: true, followUp })
    await outcomes.report(item({ thread: 'a', run: 'a-run' }), { action: 'deny' })
    assert.deepEqual(calls, { start: [], queue: [], steer: [] })
  }
})

test('an agent resolving under an approval session updates the card but tells the chat nothing', async () => {
  const { threads, calls, outcomes } = harness()
  assert.equal(await outcomes.report(item({ thread: 'a', run: 'a-run' }), { action: 'accept', stamp: 'confirmed 2026-11-04 → running, output P1', tell: false }), 'card')
  assert.deepEqual(calls, { start: [], queue: [], steer: [] })
  assert.equal(threads.store.get('a').messages.length, 2)
  assert.equal(threads.store.get('a').messages[1].parts[0].status, 'accepted')
})

test('an item no chat staged is left as it was', async () => {
  const { threads, calls, outcomes } = harness()
  const snapshot = JSON.stringify([...threads.store])
  assert.equal(await outcomes.report(item({ src: 'journal' }), { action: 'accept' }), null)
  assert.equal(await outcomes.report(item({ thread: 'gone', run: 'x' }), { action: 'accept' }), null)
  assert.equal(await outcomes.reply(item({}), 'hello'), null)
  assert.deepEqual(calls, { start: [], queue: [], steer: [] })
  assert.equal(JSON.stringify([...threads.store]), snapshot)
})

test('while a reply runs: queued, or steered as the follow-up setting says, queued when a steer cannot land', async () => {
  const queued = harness({ running: true, followUp: 'queue' })
  assert.equal(await queued.outcomes.report(item({ thread: 'a', run: 'a-run' }), { action: 'accept' }), 'queue')
  assert.equal(queued.calls.queue[0].threadId, 'a')
  assert.deepEqual(queued.calls.queue[0].inbox, { id: 'P1', status: 'accepted' })

  const steered = harness({ running: true, followUp: 'steer' })
  assert.equal(await steered.outcomes.report(item({ thread: 'a', run: 'a-run' }), { action: 'draft' }), 'steer')
  assert.match(steered.calls.steer[0].text, /saved it as a draft/)

  const missed = harness({ running: true, followUp: 'steer', steerTakes: false })
  assert.equal(await missed.outcomes.report(item({ thread: 'a', run: 'a-run' }), { action: 'accept' }), 'queue')
})

test('a turn that loses the race to another start waits in the queue instead', async () => {
  const queued = []
  const busy = createInboxOutcomes({
    threads: fakeThreads(), running: () => false, steer: async () => null,
    startTurn: async () => { throw Object.assign(new Error('already answering'), { status: 409 }) },
    enqueue: async (turn) => { queued.push(turn) },
  })
  assert.equal(await busy.report(item({ thread: 'a', run: 'a-run' }), { action: 'accept' }), 'queue')
  assert.equal(queued.length, 1)
})

test('the running reply updates its own card, not the file it will overwrite', async () => {
  const threads = fakeThreads()
  const live = []
  const outcomes = createInboxOutcomes({
    threads, liveCard: (runId) => (runId === 'a-run' ? (patch) => { live.push(patch) } : null),
    running: () => true, startTurn: async () => {}, steer: async () => ({}), enqueue: async () => {}, followUp: () => 'steer', now: () => 5,
  })
  await outcomes.report(item({ thread: 'a', run: 'a-run' }), { action: 'accept' })
  assert.deepEqual(live, [{ id: 'P1', status: 'accepted', decidedAt: 5 }])
  assert.equal(threads.store.get('a').messages[1].parts[0].status, 'pending')
})

test('Reply leaves the proposal open and sends the words to its chat', async () => {
  const { threads, calls, outcomes } = harness()
  assert.equal(await outcomes.reply(item({ thread: 'a', run: 'a-run' }), 'make it shorter'), 'start')
  assert.match(calls.start[0].text, /still waiting for the owner's decision\] make it shorter$/)
  assert.deepEqual(calls.start[0].inbox, { id: 'P1', status: 'pending' })
  assert.equal(threads.store.get('a').messages[1].parts[0].status, 'pending')
})

test('routing and wording', () => {
  assert.equal(outcomeRoute({ status: 'denied', note: '', running: false }), 'record')
  assert.equal(outcomeRoute({ status: 'uncertain', note: '', running: false }), 'record')
  assert.equal(outcomeRoute({ status: 'accepted', note: '', running: false }), 'start')
  assert.equal(resultOf('uncertain 2026-11-04: it may have gone out'), 'it may have gone out')
  assert.match(outcomeText({ id: 'P3', kind: 'imessage', title: 'Message Sam' }, { status: 'uncertain', result: 'lost the reply' }), /may or may not have gone out \(lost the reply\)\. Check before trying again\./)
})

test('the card and the marker survive the thread store and the reply reducer', () => {
  const m = normalizeMessage({ id: 'r', role: 'assistant', content: '', parts: [{ type: 'inbox', id: 'P4', kind: 'email', title: 'Email Sam', status: 'accepted', note: 'ok', result: 'sent', decidedAt: 9, stray: 1 }] })
  assert.deepEqual(m.parts, [{ type: 'inbox', id: 'P4', kind: 'email', title: 'Email Sam', status: 'accepted', note: 'ok', result: 'sent', decidedAt: 9 }])
  assert.equal(normalizeMessage({ id: 'r', role: 'assistant', parts: [{ type: 'inbox', id: '../x' }] }).parts, undefined)
  assert.deepEqual(normalizeMessage({ id: 'u', role: 'user', content: 'x', inbox: { id: 'P4', status: 'denied' } }).inbox, { id: 'P4', status: 'denied' })
  assert.equal(normalizeMessage({ id: 'u', role: 'user', content: 'x', inbox: { id: 'P4', status: 'sent!' } }).inbox, undefined)

  const reply = { parts: [] }
  applyEvent(reply, { type: 'inbox', inbox: { id: 'P4', kind: 'email', title: 'Email Sam', status: 'pending' } })
  applyEvent(reply, { type: 'inbox', inbox: { id: 'P4', status: 'denied' } })
  assert.deepEqual(reply.parts, [{ type: 'inbox', id: 'P4', kind: 'email', title: 'Email Sam', status: 'denied' }])
})

test('the gateway names the chat run on its calls to the bridge, and only with a real token', () => {
  assert.deepEqual(runHeader({ TOTEM_RUN_TOKEN: 'tok' }), { 'x-totem-run': 'tok' })
  assert.deepEqual(runHeader({ TOTEM_BROWSER_TOKEN: 'cursor-tok' }), { 'x-totem-run': 'cursor-tok' })
  assert.deepEqual(runHeader({ TOTEM_BROWSER_TOKEN: '${env:TOTEM_BROWSER_TOKEN}' }), {})
  assert.deepEqual(runHeader({}), {})
})
