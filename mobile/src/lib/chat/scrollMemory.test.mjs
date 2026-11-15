// node --test mobile/src/lib/chat/scrollMemory.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { anchorAt, capEntries, createScrollMemory, restorePlan, SCROLL_KEY } from './scrollMemory.ts'
import { markOpened, recentChats } from './recents.ts'

test('only the newest entries are kept', () => {
  const map = Object.fromEntries(Array.from({ length: 105 }, (_, i) => [`t${i}`, { atEnd: true, at: i }]))
  const kept = capEntries(map, 100)
  assert.equal(Object.keys(kept).length, 100)
  assert.ok(!('t0' in kept) && !('t4' in kept) && 't5' in kept && 't104' in kept)
})

test('the anchor is the first visible message and the offset into it', () => {
  const pos = (i) => [0, 300, 700][i]
  assert.deepEqual(anchorAt(['a', 'b', 'c'], 1, 420, pos), { anchorId: 'b', offset: 120 })
  assert.deepEqual(anchorAt(['a', 'b', 'c'], 9, 800, pos), { anchorId: 'c', offset: 100 })
  assert.equal(anchorAt([], 0, 0, pos), null)
})

test('a restore opens at the end, on the anchor, reads older pages, or gives up at the top', () => {
  assert.deepEqual(restorePlan(undefined, ['a']), { mode: 'end' })
  assert.deepEqual(restorePlan({ atEnd: true, anchorId: 'a', at: 1 }, ['a']), { mode: 'end' })
  assert.deepEqual(restorePlan({ atEnd: false, anchorId: 'b', offset: 40, at: 1 }, ['a', 'b']), { mode: 'anchor', index: 1, offset: 40 })
  assert.deepEqual(restorePlan({ atEnd: false, anchorId: 'old', at: 1 }, ['a'], { hasMore: true, pagesRead: 2 }), { mode: 'load' })
  assert.deepEqual(restorePlan({ atEnd: false, anchorId: 'old', at: 1 }, ['a'], { hasMore: true, pagesRead: 5 }), { mode: 'top' })
  assert.deepEqual(restorePlan({ atEnd: false, anchorId: 'old', at: 1 }, ['a'], { hasMore: false }), { mode: 'top' })
})

test('the memory saves, persists once it settles, and reads back', async () => {
  const store = new Map()
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  const mem = createScrollMemory(storage, () => 7)
  mem.save('t', { atEnd: false, anchorId: 'm', offset: 12 })
  assert.deepEqual(mem.get('t'), { atEnd: false, anchorId: 'm', offset: 12, at: 7 })
  mem.flush()
  assert.deepEqual(JSON.parse(store.get(SCROLL_KEY)).t.anchorId, 'm')
  assert.equal(createScrollMemory(storage).get('t').offset, 12)
  store.set(SCROLL_KEY, 'not json')
  assert.equal(createScrollMemory(storage).get('t'), undefined)
})

const chat = (id, extra = {}) => ({ id, kind: 'regular', createdAt: 1, updatedAt: 1, messages: [{ id: 'm', role: 'user', content: 'x', createdAt: 1 }], ...extra })

test('recent chats: drafts first, then the most recently opened or updated', () => {
  const threads = [
    chat('a', { updatedAt: 50 }),
    chat('b', { updatedAt: 10 }),
    chat('c', { updatedAt: 40 }),
    chat('d', { updatedAt: 90, totemId: 'x' }),
    chat('e', { updatedAt: 95, kind: 'temporary' }),
    chat('f', { updatedAt: 99, messages: [] }),
    chat('g', { updatedAt: 5, summary: true, messages: [], messageCount: 4 }),
  ]
  const rows = recentChats(threads, { drafts: { b: '  half a thought ', c: '   ' }, opened: { g: 80 }, now: 100 })
  assert.deepEqual(rows.map((r) => r.thread.id), ['b', 'g', 'a', 'c'])
  assert.equal(rows[0].draft, 'half a thought')
  assert.equal(rows[1].draft, null)
})

test('opened marks are capped', () => {
  let opened = {}
  for (let i = 0; i < 205; i++) opened = markOpened(opened, `t${i}`, i)
  assert.equal(Object.keys(opened).length, 200)
  assert.ok(!('t0' in opened) && 't204' in opened)
})
