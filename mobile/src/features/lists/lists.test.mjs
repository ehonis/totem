// The Lists page's pure helpers (#181): node strips the types; nothing here needs React Native.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanItemText, isPending, listProgress, pendingItem, splitItems, withChecked, withPending, withText, withoutItems,
} from './items.ts'
import { createUndoQueue } from './undoQueue.ts'

const item = (id, position, checked = false, text = id) => ({
  id, listId: 'l1', text, checked, position, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
})
const list = (items) => ({
  id: 'l1', title: 'Groceries', position: 0, createdAt: '', updatedAt: '',
  itemCount: items.length, checkedCount: items.filter((i) => i.checked).length, items, linkedTodos: [],
})

test('splitItems puts open items first and checked after, each in position order', () => {
  const { open, checked } = splitItems([item('c', 2, true), item('a', 0), item('d', 3), item('b', 1, true)])
  assert.deepEqual(open.map((i) => i.id), ['a', 'd'])
  assert.deepEqual(checked.map((i) => i.id), ['b', 'c'])
})

test('withChecked flips one item and recounts', () => {
  const before = list([item('a', 0), item('b', 1)])
  const after = withChecked(before, 'b', true)
  assert.equal(after.checkedCount, 1)
  assert.equal(after.items.find((i) => i.id === 'b').checked, true)
  assert.equal(before.items[1].checked, false, 'the original is untouched')
  assert.equal(withChecked(after, 'b', false).checkedCount, 0)
})

test('withText changes only that item', () => {
  const after = withText(list([item('a', 0), item('b', 1)]), 'a', 'Oat milk')
  assert.deepEqual(after.items.map((i) => i.text), ['Oat milk', 'b'])
})

test('withoutItems hides removals waiting to be sent and recounts', () => {
  const before = list([item('a', 0, true), item('b', 1), item('c', 2)])
  const after = withoutItems(before, new Set(['a', 'c']))
  assert.deepEqual(after.items.map((i) => i.id), ['b'])
  assert.equal(after.itemCount, 1)
  assert.equal(after.checkedCount, 0)
  assert.equal(withoutItems(before, new Set()), before, 'nothing hidden returns the same list')
})

test('pendingItem lands after the last position and is recognisable', () => {
  const draft = pendingItem('l1', 'Eggs', 7, [item('a', 4), item('b', 9)])
  assert.equal(draft.position, 10)
  assert.equal(isPending(draft), true)
  assert.equal(isPending(item('a', 0)), false)
  const shown = withPending(list([item('a', 0)]), [draft, { ...draft, id: 'pending:8', listId: 'other' }])
  assert.deepEqual(shown.items.map((i) => i.text), ['a', 'Eggs'])
  assert.equal(shown.itemCount, 2)
})

test('listProgress', () => {
  assert.deepEqual(listProgress({ itemCount: 0, checkedCount: 0 }), { label: 'Empty', ratio: 0, done: false })
  assert.deepEqual(listProgress({ itemCount: 4, checkedCount: 1 }), { label: '1 of 4', ratio: 0.25, done: false })
  assert.equal(listProgress({ itemCount: 3, checkedCount: 3 }).done, true)
  assert.equal(listProgress({ itemCount: 2, checkedCount: 5 }).label, '2 of 2', 'clamped')
})

test('cleanItemText trims and folds whitespace', () => {
  assert.equal(cleanItemText('  two   apples \n'), 'two apples')
  assert.equal(cleanItemText('   '), null)
})

function fakeTimers() {
  let seq = 0
  const due = new Map()
  return {
    setTimeout: (fn, ms) => { const id = ++seq; due.set(id, { fn, ms }); return id },
    clearTimeout: (id) => { due.delete(id) },
    fire: () => { for (const [id, t] of [...due]) { due.delete(id); t.fn() } },
    count: () => due.size,
  }
}

test('undo queue: a removal commits when its window closes', () => {
  const timers = fakeTimers()
  const q = createUndoQueue(timers)
  const sent = []
  q.schedule('a', () => { sent.push('a') }, 5000)
  assert.deepEqual([...q.pending()], ['a'])
  assert.deepEqual(sent, [])
  timers.fire()
  assert.deepEqual(sent, ['a'])
  assert.equal(q.pending().size, 0)
})

test('undo queue: undo cancels and nothing is sent', () => {
  const timers = fakeTimers()
  const q = createUndoQueue(timers)
  const sent = []
  let notified = 0
  q.subscribe(() => { notified++ })
  q.schedule('a', () => { sent.push('a') }, 5000)
  assert.equal(q.undo('a'), true)
  assert.equal(q.undo('a'), false)
  timers.fire()
  assert.deepEqual(sent, [])
  assert.equal(timers.count(), 0)
  assert.equal(notified, 2)
})

test('undo queue: flush sends everything still waiting, once', () => {
  const timers = fakeTimers()
  const q = createUndoQueue(timers)
  const sent = []
  q.schedule('a', () => { sent.push('a') }, 5000)
  q.schedule('b', () => { sent.push('b') }, 5000)
  q.flush()
  timers.fire()
  assert.deepEqual(sent, ['a', 'b'])
  assert.equal(q.pending().size, 0)
})
