// The composer's unsent-task list (#179), under node's test runner.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createBody, createUnsentStore } from './unsent.ts'

function memory() {
  const items = new Map()
  return {
    items,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => items.set(k, v),
    removeItem: (k) => items.delete(k),
  }
}

test('a failure kept by a closed composer survives a write from an open one', () => {
  const disk = memory()
  // Two composers' views of the same list: the open one read it before A failed.
  const closed = createUnsentStore(() => disk, 'unsent')
  const open = createUnsentStore(() => disk, 'unsent')
  assert.deepEqual(open.list(), [])
  closed.put({ id: 'a', payload: { title: 'A' }, error: 'offline' })
  open.put({ id: 'b', payload: { title: 'B' }, error: 'offline' })
  assert.deepEqual(open.list().map((entry) => entry.id), ['a', 'b'])
  open.remove('b')
  assert.deepEqual(closed.list().map((entry) => entry.id), ['a'])
  assert.deepEqual(JSON.parse(disk.items.get('unsent')).map((entry) => entry.id), ['a'])
})

test('put updates an entry in place; remove of the last one clears storage', () => {
  const disk = memory()
  const store = createUnsentStore(() => disk, 'unsent')
  store.put({ id: 'a', payload: { title: 'A' }, error: 'offline' })
  store.put({ id: 'a', payload: { title: 'A' }, error: 'still offline' })
  assert.deepEqual(store.list(), [{ id: 'a', payload: { title: 'A' }, error: 'still offline' }])
  store.remove('a')
  assert.equal(disk.items.has('unsent'), false)
  assert.deepEqual(store.list(), [])
})

test('an entry stays until it is removed, so a retry that never answers loses nothing', () => {
  const disk = memory()
  createUnsentStore(() => disk, 'unsent').put({ id: 'a', payload: { title: 'A' }, error: 'offline' })
  // The app restarts mid-retry: a fresh store reads the entry back.
  assert.deepEqual(createUnsentStore(() => disk, 'unsent').list().map((entry) => entry.id), ['a'])
})

test('listeners hear every change, and list() is stable between writes', () => {
  const disk = memory()
  const store = createUnsentStore(() => disk, 'unsent')
  let calls = 0
  const stop = store.subscribe(() => { calls += 1 })
  const before = store.list()
  assert.equal(store.list(), before)
  store.put({ id: 'a', payload: {}, error: '' })
  store.remove('a')
  store.remove('missing')
  stop()
  store.put({ id: 'b', payload: {}, error: '' })
  assert.equal(calls, 2)
})

test('an entry can be claimed for sending once until it is released', () => {
  const store = createUnsentStore(() => memory(), 'unsent')
  const before = store.sending()
  assert.equal(store.claim('a'), true)
  // A second sheet, opened while the first request is out, is refused.
  assert.equal(store.claim('a'), false)
  assert.deepEqual(store.sending(), ['a'])
  assert.notEqual(store.sending(), before)
  store.release('a')
  assert.deepEqual(store.sending(), [])
  assert.equal(store.claim('a'), true)
})

test('unreadable storage reads as an empty list', () => {
  const disk = memory()
  disk.setItem('unsent', '{not json')
  assert.deepEqual(createUnsentStore(() => disk, 'unsent').list(), [])
  assert.deepEqual(createUnsentStore(() => null, 'unsent').list(), [])
})

test('a task kept by an older version is created locally: its share target, repo and "start now" are dropped', () => {
  const kept = { title: 'Ship it', description: '', area: 'Personal', ventureTag: null, priority: 2, dueDate: null, syncTarget: 'github', repo: 'acme/site', start: true }
  assert.deepEqual(createBody(kept), { title: 'Ship it', description: '', area: 'Personal', ventureTag: null, priority: 2, dueDate: null })
  assert.equal('syncTarget' in createBody({ title: 'x', syncTarget: 'local' }), false)
})
