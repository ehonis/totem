// The list's card actions (boardActionsCore.ts) over a fake bridge and an in-memory
// store: a finish and its Undo put the card back exactly (status, outcome, position),
// and a refused move rolls back. node strips the module's types; no React Native.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createBoardActions } from './boardActionsCore.ts'
import { once } from './undo.ts'

let seq = 0
function todo(fields = {}) {
  seq += 1
  return {
    id: `t${seq}`, title: `Task ${seq}`, description: '', area: 'Personal', ventureTag: null, status: 'todo', priority: 1,
    dueDate: null, recurrence: null, snoozedUntil: null, position: seq * 1024, createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z', completedAt: null, outcome: null, archivedAt: null, deletedAt: null, tags: [], notes: [],
    relations: [], lists: [], externalLinks: [], issueLink: null,
    syncState: { status: 'idle', pending: 0, conflicts: 0, exhausted: 0, missing: false, lastSuccessAt: null, lastError: null },
    ...fields,
  }
}

/** A bridge that behaves like todos/service.mjs move (status and outcome change, position does not), or refuses. */
function setup(tasks, { refuse = false } = {}) {
  const server = new Map(tasks.map((t) => [t.id, structuredClone(t)]))
  let list = tasks.map((t) => structuredClone(t))
  const calls = []
  const errors = []
  const api = {
    async moveBoardTodo(id, status, outcome) {
      calls.push(['move', id, status, outcome])
      if (refuse) { const e = new Error('Internal Server Error'); e.status = 500; throw e }
      const was = server.get(id)
      const next = { ...was, status, outcome: status === 'done' ? outcome ?? was.outcome ?? 'completed' : null, completedAt: status === 'done' ? was.completedAt ?? '2026-11-04T10:00:00.000Z' : null }
      server.set(id, next)
      return { todo: structuredClone(next) }
    },
    async reorderBoardTodos(status, ids) { calls.push(['reorder', status, ids]) },
    async updateBoardTodo(id, fields) { const next = { ...server.get(id), ...fields }; server.set(id, next); return { todo: structuredClone(next) } },
  }
  const store = {
    todos: () => list,
    setTodos: (next) => { list = typeof next === 'function' ? next(list) : next },
    loadBoard: async () => { calls.push(['load']) },
    snoozeTodo: async () => {}, wakeTodo: async () => {}, removeTodo: async () => {},
    restoreTodo: async (id) => { calls.push(['restore', id]); if (calls.filter((c) => c[0] === 'restore').length > 1) throw new Error('Task is not in the recycle bin.') },
  }
  const actions = createBoardActions(api, store, (message) => { if (message) errors.push(message) })
  return { actions, calls, errors, list: () => list, server }
}

test('finishing a task and then Undo puts it back as it was: status, outcome and position', async () => {
  const card = todo({ position: 3072 })
  const { actions, list, errors } = setup([todo(), card, todo()])
  assert.equal(await actions.move(card, 'done'), true)
  const done = list().find((t) => t.id === card.id)
  assert.equal(done.status, 'done')
  assert.equal(done.outcome, 'completed')
  assert.equal(done.position, 3072, 'finishing never moves the card')
  assert.equal(await actions.putBack(card), true)
  const back = list().find((t) => t.id === card.id)
  assert.deepEqual([back.status, back.outcome, back.completedAt, back.position], ['todo', null, null, 3072])
  assert.deepEqual(errors, [])
})

test('not doing and its Undo restore the outcome too', async () => {
  const card = todo({ position: 512 })
  const { actions, list } = setup([card])
  assert.equal(await actions.notDoing(card), true)
  assert.deepEqual([list()[0].status, list()[0].outcome], ['done', 'not_doing'])
  assert.equal(await actions.putBack(card), true)
  assert.deepEqual([list()[0].status, list()[0].outcome, list()[0].position], ['todo', null, 512])
})

test('reopening a finished task keeps its place', async () => {
  const card = todo({ status: 'done', outcome: 'completed', completedAt: '2026-11-03T09:00:00.000Z', position: 99 })
  const { actions, list } = setup([card])
  assert.equal(await actions.move(card, 'todo'), true)
  assert.deepEqual([list()[0].status, list()[0].outcome, list()[0].position], ['todo', null, 99])
})

test('a refused move (500) rolls the card back and says why; other cards are untouched', async () => {
  const card = todo({ position: 2048 })
  const other = todo({ title: 'Other' })
  const { actions, list, errors } = setup([card, other], { refuse: true })
  assert.equal(await actions.move(card, 'done'), false)
  const back = list().find((t) => t.id === card.id)
  assert.deepEqual([back.status, back.outcome, back.completedAt, back.position], ['todo', null, null, 2048])
  assert.deepEqual(errors, ['Internal Server Error'])
  assert.equal(list().length, 2)
})

test('a double-tapped Undo restores once, so no false "could not be restored" appears', async () => {
  const card = todo()
  const { actions, calls, errors } = setup([card])
  const undo = once(() => { void actions.restore(card) })
  undo(); undo()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.filter((c) => c[0] === 'restore').length, 1)
  assert.deepEqual(errors, [])
})

test('reorder sends the open column with the card just past its neighbour', async () => {
  const a = todo({ position: 0 }), b = todo({ position: 1024 }), c = todo({ position: 2048 })
  const { actions, calls, list } = setup([a, b, c])
  await actions.reorder(c, -1, b.id)
  assert.deepEqual(calls.at(-1), ['reorder', 'todo', [a.id, c.id, b.id]])
  assert.deepEqual([...list()].sort((x, y) => x.position - y.position).map((t) => t.id), [a.id, c.id, b.id])
})
