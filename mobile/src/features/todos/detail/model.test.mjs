// The task page's pure rules (#179), under node's test runner.
import test from 'node:test'
import assert from 'node:assert/strict'
import { historyRows, serialQueue, textPatch, undoMove } from './model.ts'

const base = {
  id: 't1', title: 'Renew passport', description: '', area: 'Personal', ventureTag: null, status: 'todo', priority: 1,
  dueDate: null, recurrence: null, snoozedUntil: null, position: 0,
  createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z',
  completedAt: null, outcome: null, archivedAt: null, deletedAt: null,
  tags: [], notes: [], relations: [], lists: [], externalLinks: [],
  syncState: { status: 'idle', pending: 0, conflicts: 0, exhausted: 0, missing: false, lastSuccessAt: null, lastError: null },
}

test('textPatch sends only what changed', () => {
  assert.equal(textPatch({ title: 'Renew passport', description: '' }, base), null)
  assert.deepEqual(textPatch({ title: 'Renew passport now', description: '' }, base), { title: 'Renew passport now' })
  assert.deepEqual(textPatch({ title: 'Renew passport', description: 'Form DS-82' }, base), { description: 'Form DS-82' })
})

test('textPatch trims the title and never sends an empty one', () => {
  assert.equal(textPatch({ title: '  Renew passport  ', description: '' }, base), null)
  assert.equal(textPatch({ title: '   ', description: '' }, base), null)
  assert.deepEqual(textPatch({ title: '', description: 'kept' }, base), { description: 'kept' })
})

test('history: a new task has only its creation', () => {
  assert.deepEqual(historyRows(base).map((row) => row.key), ['created'])
})

test('history: events in order, with the outcome named', () => {
  const rows = historyRows({
    ...base,
    status: 'done', outcome: 'not_doing',
    completedAt: '2026-10-03T09:00:00.000Z',
    archivedAt: '2026-10-05T09:00:00.000Z',
    updatedAt: '2026-10-05T09:00:20.000Z',
    externalLinks: [{ lastSyncedAt: '2026-10-02T09:00:00.000Z' }, { lastSyncedAt: '2026-10-04T09:00:00.000Z' }],
  })
  assert.deepEqual(rows.map((row) => row.label), ['Created', 'Marked not doing', 'Last synced', 'Archived'])
  assert.equal(rows[2].at, '2026-10-04T09:00:00.000Z')
})

test('history: "Last edited" only when it is later news', () => {
  const edited = historyRows({ ...base, updatedAt: '2026-10-09T12:00:00.000Z' })
  assert.deepEqual(edited.map((row) => row.key), ['created', 'updated'])
  const same = historyRows({ ...base, completedAt: '2026-10-09T12:00:00.000Z', updatedAt: '2026-10-09T12:00:30.000Z' })
  assert.deepEqual(same.map((row) => row.key), ['created', 'completed'])
})

test('history: unreadable dates are left out rather than shown as Invalid Date', () => {
  assert.deepEqual(historyRows({ ...base, completedAt: 'nonsense', deletedAt: '' }).map((row) => row.key), ['created'])
})

test('undo puts a task back open, or back to its old outcome', () => {
  // A cached "doing" from before that status went is put back as open, never sent as doing.
  assert.deepEqual(undoMove({ status: 'doing', outcome: null }), { status: 'todo' })
  assert.deepEqual(undoMove({ status: 'todo', outcome: null }), { status: 'todo' })
  // Completed, then marked not doing: undo restores completed, not To Do.
  assert.deepEqual(undoMove({ status: 'done', outcome: 'completed' }), { status: 'done', outcome: 'completed' })
  assert.deepEqual(undoMove({ status: 'done', outcome: 'not_doing' }), { status: 'done', outcome: 'not_doing' })
})

test('serialQueue runs saves in order, past a failure', async () => {
  const enqueue = serialQueue()
  const order = []
  const slow = enqueue(async () => { await new Promise((r) => setTimeout(r, 20)); order.push('first'); return 1 })
  const failing = enqueue(async () => { order.push('second'); throw new Error('refused') })
  const fast = enqueue(async () => { order.push('third'); return 3 })
  assert.equal(await slow, 1)
  await assert.rejects(failing, /refused/)
  assert.equal(await fast, 3)
  assert.deepEqual(order, ['first', 'second', 'third'])
})
