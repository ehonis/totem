// node --test chat/thread-pages.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createThreadStore, threadSummary, threadWindow, SUMMARY_TEXT } from './store.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'totem-pages-'))
const msgs = (turns) => Array.from({ length: turns }, (_, i) => [
  { id: `u${i}`, role: 'user', content: `question ${i}` },
  { id: `a${i}`, role: 'assistant', content: `answer ${i}`, status: 'done' },
]).flat()

test('the latest window holds the last N turns, and earlier pages walk back to the start', () => {
  const all = msgs(25)
  const first = threadWindow(all, { turns: 10 })
  assert.deepEqual(first.messages.map((m) => m.id).slice(0, 2), ['u15', 'a15'])
  assert.equal(first.messages.length, 20)
  assert.equal(first.hasMore, true)
  assert.equal(first.before, 'u15')
  const second = threadWindow(all, { turns: 10, before: first.before })
  assert.equal(second.messages[0].id, 'u5')
  assert.equal(second.messages.at(-1).id, 'a14')
  const third = threadWindow(all, { turns: 10, before: second.before })
  assert.equal(third.messages[0].id, 'u0')
  assert.equal(third.hasMore, false)
  assert.equal(third.before, null)
  assert.equal([...third.messages, ...second.messages, ...first.messages].length, all.length)
})

test('a window is capped by messages and bytes but never empty', () => {
  const totem = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, role: 'assistant', content: 'run' }))
  const w = threadWindow(totem, { maxMessages: 30 })
  assert.equal(w.messages.length, 30)
  assert.equal(w.before, 'r170')
  const huge = [{ id: 'u', role: 'user', content: 'x' }, { id: 'big', role: 'assistant', content: 'y'.repeat(5000) }]
  const one = threadWindow(huge, { maxBytes: 100 })
  assert.deepEqual(one.messages.map((m) => m.id), ['big'])
  assert.equal(one.hasMore, true)
  assert.deepEqual(threadWindow([], {}).messages, [])
  assert.deepEqual(threadWindow(huge, { before: 'missing' }), { messages: [], hasMore: false, before: null })
})

test('a summary keeps the last turn, cut, and only what waits on the owner', () => {
  const t = {
    id: 't', title: 'x', updatedAt: 5,
    messages: [
      ...msgs(3),
      { id: 'u9', role: 'user', content: 'last' },
      { id: 'a9', role: 'assistant', content: 'z'.repeat(SUMMARY_TEXT + 50), parts: [
        { type: 'tool', id: 'p1', status: 'done' },
        { type: 'approval', id: 'p2', status: 'pending' },
        { type: 'questions', id: 'p3', status: 'answered' },
      ] },
    ],
  }
  const s = threadSummary(t)
  assert.equal(s.summary, true)
  assert.equal(s.messageCount, 8)
  assert.deepEqual(s.messages.map((m) => m.id), ['u9', 'a9'])
  assert.equal(s.messages[1].content.length, SUMMARY_TEXT + 1)
  assert.deepEqual(s.messages[1].parts.map((p) => p.id), ['p2'])
  assert.equal(s.firstUserText, 'question 0')
  assert.equal(s.title, 'x')
  assert.equal(t.messages.length, 8, 'the thread itself is untouched')
})

test('a card still waiting from an earlier turn stays in the summary, as a stub', () => {
  const t = {
    id: 't', updatedAt: 1,
    messages: [
      { id: 'u0', role: 'user', content: 'draft an email' },
      { id: 'a0', role: 'assistant', content: 'Here it is', parts: [{ type: 'inbox', id: 'card', status: 'pending' }, { type: 'tool', id: 'x', status: 'done' }] },
      { id: 'u1', role: 'user', content: 'change the subject' },
      { id: 'a1', role: 'assistant', content: 'Changed' },
    ],
  }
  const s = threadSummary(t)
  assert.deepEqual(s.messages.map((m) => m.id), ['a0', 'u1', 'a1'])
  assert.equal(s.messages[0].content, '')
  assert.deepEqual(s.messages[0].parts.map((p) => p.id), ['card'])
})

test('summaries are cached by file and follow every write and delete', async () => {
  const dir = await tmp()
  const store = createThreadStore({ dir })
  await store.update('a', (t) => { t.messages.push(...msgs(2)) }, { create: {} })
  await store.update('b', (t) => { t.messages.push(...msgs(1)) }, { create: {} })
  let list = await store.summaries()
  assert.deepEqual(list.map((t) => t.id).sort(), ['a', 'b'])
  const cachedA = list.find((t) => t.id === 'a')
  assert.equal((await store.summaries()).find((t) => t.id === 'a'), cachedA, 'unchanged file, same summary')
  await store.update('a', (t) => { t.messages.push({ id: 'new', role: 'user', content: 'again' }); t.updatedAt = Date.now() + 1000 })
  list = await store.summaries()
  assert.equal(list[0].id, 'a')
  assert.equal(list[0].messages.at(-1).id, 'new')
  assert.equal(list[0].messageCount, 5)
  // A file changed behind the store's back (another process) is read again too.
  await writeFile(join(dir, 'b.json'), JSON.stringify({ id: 'b', title: 'outside', messages: [], updatedAt: 1 }))
  assert.equal((await store.summaries()).find((t) => t.id === 'b').title, 'outside')
  await store.remove('b')
  assert.deepEqual((await store.summaries()).map((t) => t.id), ['a'])
  await rm(dir, { recursive: true, force: true })
})

test('page reads one window with the chat around it', async () => {
  const dir = await tmp()
  const store = createThreadStore({ dir })
  await store.update('p', (t) => { t.messages.push(...msgs(12)); t.title = 'Paged' }, { create: {} })
  const p = await store.page('p', { turns: 10 })
  assert.equal(p.title, 'Paged')
  assert.equal(p.messageCount, 24)
  assert.equal(p.messages.length, 20)
  assert.deepEqual(p.history, { hasMore: true, before: 'u2' })
  const older = await store.page('p', { turns: 10, before: p.history.before })
  assert.deepEqual(older.messages.map((m) => m.id), ['u0', 'a0', 'u1', 'a1'])
  assert.deepEqual(older.history, { hasMore: false, before: null })
  assert.equal(await store.page('nope'), null)
  await rm(dir, { recursive: true, force: true })
})
