import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTaskDone } from './task-done.mjs'

const tasks = {
  open: { id: 'open', status: 'todo', completedAt: null },
  done: { id: 'done', status: 'done', completedAt: '2026-11-24T10:00:00.000Z' },
  binned: { id: 'binned', status: 'done', completedAt: '2026-11-24T10:00:00.000Z', deletedAt: '2026-11-24T11:00:00.000Z' },
}
const marks = {
  // The mark store re-keys a mark when its row moves (todos/sheet-marks.mjs); a chat keeps its old ref.
  'sheet:abc:9:0badc0de': { state: 'done', at: '2026-11-24T09:00:00.000Z' },
  'sheet:abc:14:feedf00d': { state: 'snoozed', at: '2026-11-24T09:00:00.000Z', until: '2026-12-01T09:00:00.000Z' },
}
const rowsNow = ['sheet:abc:9:0badc0de', 'sheet:abc:14:feedf00d']
const make = (extra = {}) => createTaskDone({ task: (id) => tasks[id] || null, sheetMarks: async () => marks, sheetRefs: async () => rowsNow, ...extra })

test('a chat says when its linked task was finished; open, deleted and missing tasks say nothing', async () => {
  const out = await make().decorate([
    { id: 'a', taskId: 'done' },
    { id: 'b', taskId: 'open', taskDoneAt: 5 },
    { id: 'c', taskId: 'binned' },
    { id: 'd', taskId: 'nowhere' },
    { id: 'e' },
  ])
  assert.equal(out[0].taskDoneAt, Date.parse('2026-11-24T10:00:00.000Z'))
  // Reopened since: the stale time goes, so the chat comes back by itself.
  assert.equal('taskDoneAt' in out[1], false)
  assert.equal('taskDoneAt' in out[2], false)
  assert.equal('taskDoneAt' in out[3], false)
  assert.deepEqual(out[4], { id: 'e' })
})

test('a sheet row counts once the owner marked it done, also after the row moved; a snooze does not', async () => {
  const out = await make().decorate([
    { id: 'a', taskId: 'sheet:abc:9:0badc0de' },
    { id: 'b', taskId: 'sheet:abc:12:0badc0de' },
    { id: 'c', taskId: 'sheet:abc:14:feedf00d' },
    { id: 'd', taskId: 'sheet:other:12:0badc0de' },
  ])
  const at = Date.parse('2026-11-24T09:00:00.000Z')
  assert.equal(out[0].taskDoneAt, at)
  assert.equal(out[1].taskDoneAt, at)
  assert.equal(out[2].taskDoneAt, undefined)
  assert.equal(out[3].taskDoneAt, undefined)
})

test('reads the sheet marks only when a chat names a row, and a failed read or task lookup settles nothing', async () => {
  let reads = 0
  const counting = make({ sheetMarks: async () => { reads++; return marks } })
  await counting.decorate([{ id: 'a', taskId: 'done' }])
  assert.equal(reads, 0)
  const broken = createTaskDone({ task: () => { throw new Error('db closed') }, sheetMarks: async () => { throw new Error('unreadable') } })
  const out = await broken.decorate([{ id: 'a', taskId: 'done' }, { id: 'b', taskId: 'sheet:abc:9:0badc0de' }])
  assert.equal(out[0].taskDoneAt, undefined)
  assert.equal(out[1].taskDoneAt, undefined)
  assert.equal(await make().one(null), null)
})

test('a moved row is matched among the sheet\'s current rows, never guessed between two with the same title', async () => {
  let reads = 0
  const twoAlike = createTaskDone({
    task: () => null,
    sheetMarks: async () => ({ 'sheet:abc:8:0badc0de': { state: 'done', at: '2026-11-24T09:00:00.000Z' } }),
    sheetRefs: async () => { reads++; return ['sheet:abc:8:0badc0de', 'sheet:abc:9:0badc0de'] },
  })
  const [moved] = await twoAlike.decorate([{ id: 'a', taskId: 'sheet:abc:3:0badc0de' }])
  assert.equal(moved.taskDoneAt, undefined)
  assert.equal(reads, 1)
  // An open row with no mark of its kind reads nothing.
  await twoAlike.decorate([{ id: 'b', taskId: 'sheet:abc:3:11111111' }])
  assert.equal(reads, 1)
})

test('rows that can\'t be had in time leave exact refs matching and moved ones unresolved', async () => {
  const slow = make({ sheetRefs: async () => null })
  const [exact, moved] = await slow.decorate([{ id: 'a', taskId: 'sheet:abc:9:0badc0de' }, { id: 'b', taskId: 'sheet:abc:12:0badc0de' }])
  assert.equal(exact.taskDoneAt, Date.parse('2026-11-24T09:00:00.000Z'))
  assert.equal(moved.taskDoneAt, undefined)
})
