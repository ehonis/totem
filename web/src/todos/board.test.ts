import { afterEach, describe, expect, it } from 'vitest'

import {
  afterDone, buildList, clearScope, compareListItems, rollsOnCompletion, sectionFor, sheetAsTaskPriority, sheetName, SHEET_PRIORITY_WORD, urgency,
  type ListItem, type TaskList,
} from './board'
import type { SheetItem, Todo } from './types'

// Wednesday 4 November 2026, 10:00 local.
const NOW = new Date(2026, 10, 4, 10, 0)

let seq = 0
function todo(fields: Partial<Todo> = {}): Todo {
  seq += 1
  return {
    id: `t${seq}`, title: `Task ${seq}`, description: '', area: 'Personal', ventureTag: null,
    status: 'todo', priority: 1, dueDate: null, recurrence: null, snoozedUntil: null, position: seq * 1024,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', completedAt: null, outcome: null,
    archivedAt: null, deletedAt: null, tags: [], notes: [], relations: [], lists: [], externalLinks: [],
    syncState: { status: 'idle', pending: 0, conflicts: 0, exhausted: 0, missing: false, lastSuccessAt: null, lastError: null },
    ...fields,
  }
}

function row(fields: Partial<SheetItem> & Pick<SheetItem, 'row'>): SheetItem {
  return {
    id: `sheet:0:${fields.row}:0000abcd`, title: `Row ${fields.row}`, who: 'Alex', priority: null,
    status: 'Not Started', dueDate: null, notes: '', url: `https://example.test/sheet#gid=0&range=B${fields.row}`,
    ...fields,
  }
}

const idOf = (item: ListItem) => (item.kind === 'task' ? item.todo.id : item.item.id)
/** Each section as `key: id id …`, the shape the list is drawn in. */
const shape = (list: TaskList) => list.sections.map((section) => `${section.key}: ${section.items.map(idOf).join(' ')}`)

/**
 * Run `fn` with the process in another time zone, so local-day rules meet a real
 * midnight and a real clock change. The zone must observe DST, or a test that means
 * to cross one would pass without crossing anything.
 */
const ORIGINAL_TZ = process.env.TZ
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})
function inNewYork() {
  process.env.TZ = 'America/New_York'
  const offsets = [new Date(2026, 0, 15, 12).getTimezoneOffset(), new Date(2026, 6, 15, 12).getTimezoneOffset()]
  expect(offsets, 'the runtime must honour TZ for these tests to mean anything').toEqual([300, 240])
}

describe('buildList', () => {
  it('groups open tasks Overdue, Today, Upcoming, No date by the local day', () => {
    const list = buildList([
      todo({ id: 'none' }), todo({ id: 'late', dueDate: '2026-11-01' }), todo({ id: 'soon', dueDate: '2026-11-09' }),
      todo({ id: 'now', dueDate: '2026-11-04' }),
    ], [], { now: NOW })
    expect(shape(list)).toEqual(['overdue: late', 'today: now', 'upcoming: soon', 'nodate: none'])
    expect(list.completed).toEqual([])
  })

  it('omits empty sections and returns nothing for nothing', () => {
    expect(shape(buildList([todo({ id: 'a', dueDate: '2026-11-20' })], [], { now: NOW }))).toEqual(['upcoming: a'])
    expect(buildList([], [], { now: NOW })).toEqual({ sections: [], completed: [] })
  })

  it('folds a "doing" task into open, under its due date, never a section of its own', () => {
    const list = buildList([
      todo({ id: 'busy', status: 'doing', dueDate: '2026-11-04', priority: 1 }),
      todo({ id: 'plain', dueDate: '2026-11-04', priority: 1 }),
      todo({ id: 'busy-undated', status: 'doing' }),
    ], [], { now: NOW })
    expect(shape(list)).toEqual(['today: busy plain', 'nodate: busy-undated'])
    expect(list.sections.map((section) => section.key)).not.toContain('doing')
  })

  it('mixes sheet rows into the same sections by their due day', () => {
    const list = buildList([
      todo({ id: 'task-late', dueDate: '2026-11-02' }),
      todo({ id: 'task-later', dueDate: '2026-11-12' }),
    ], [
      row({ row: 7, id: 'row-late', dueDate: '2026-11-01' }),
      row({ row: 8, id: 'row-today', dueDate: '2026-11-04' }),
      row({ row: 9, id: 'row-soon', dueDate: '2026-11-06' }),
      row({ row: 10, id: 'row-undated' }),
    ], { now: NOW })
    expect(shape(list)).toEqual([
      'overdue: row-late task-late',
      'today: row-today',
      'upcoming: row-soon task-later',
      'nodate: row-undated',
    ])
  })

  it('orders a section by due day, then urgency, then tasks before sheet rows, then position', () => {
    const list = buildList([
      todo({ id: 'p4-first', dueDate: '2026-11-10', priority: 1, position: 0 }),
      todo({ id: 'p1', dueDate: '2026-11-10', priority: 4, position: 5000 }),
      todo({ id: 'p2-second', dueDate: '2026-11-10', priority: 3, position: 2048 }),
      todo({ id: 'p2-first', dueDate: '2026-11-10', priority: 3, position: 1024 }),
      todo({ id: 'earlier-day', dueDate: '2026-11-08', priority: 1 }),
    ], [
      row({ row: 30, id: 'high', dueDate: '2026-11-10', priority: 1 }),
      row({ row: 31, id: 'medium', dueDate: '2026-11-10', priority: 2 }),
      row({ row: 32, id: 'low', dueDate: '2026-11-10', priority: 3 }),
      row({ row: 33, id: 'no-priority', dueDate: '2026-11-10', priority: null }),
    ], { now: NOW })
    // P1 Urgent leads alone; a sheet High ranks with P2 High (tasks first), Medium with
    // P3 Medium, Low after P3. P4 is no priority, so it sits with the row that has none,
    // last, task first.
    expect(shape(list)).toEqual([
      'upcoming: earlier-day p1 p2-first p2-second high medium low p4-first no-priority',
    ])
  })

  it('breaks the last ties by position then id for tasks, row then id for sheet rows', () => {
    const list = buildList([
      todo({ id: 'b', position: 1024 }), todo({ id: 'a', position: 1024 }), todo({ id: 'c', position: 0 }),
    ], [row({ row: 12, id: 'r12' }), row({ row: 3, id: 'r3' })], { now: NOW })
    expect(shape(list)).toEqual(['nodate: c a b r3 r12'])
  })

  it('does not depend on the order it was given', () => {
    const tasks = [
      todo({ id: 'x', dueDate: '2026-11-05', priority: 2 }), todo({ id: 'y', dueDate: '2026-11-05', priority: 4 }),
      todo({ id: 'z', dueDate: '2026-11-03' }),
    ]
    const rows = [row({ row: 4, id: 'r', dueDate: '2026-11-05', priority: 1 })]
    const forward = shape(buildList(tasks, rows, { now: NOW }))
    expect(shape(buildList([...tasks].reverse(), rows, { now: NOW }))).toEqual(forward)
    expect(forward).toEqual(['overdue: z', 'upcoming: y r x'])
  })

  it('lists finished tasks apart, most recently finished first', () => {
    const list = buildList([
      todo({ id: 'old', status: 'done', completedAt: '2026-11-01T09:00:00.000Z' }),
      todo({ id: 'open' }),
      todo({ id: 'new', status: 'done', completedAt: '2026-11-04T09:00:00.000Z' }),
      // No completion stamp (an old row): its last update stands in.
      todo({ id: 'mid', status: 'done', completedAt: null, updatedAt: '2026-11-02T09:00:00.000Z' }),
      todo({ id: 'tie-b', status: 'done', completedAt: '2026-11-03T09:00:00.000Z' }),
      todo({ id: 'tie-a', status: 'done', completedAt: '2026-11-03T09:00:00.000Z' }),
    ], [], { now: NOW })
    expect(list.completed.map((item) => item.id)).toEqual(['new', 'tie-a', 'tie-b', 'mid', 'old'])
    expect(shape(list)).toEqual(['nodate: open'])
  })

  it('leaves out binned, archived and still-snoozed tasks, and takes a snooze back once it has run out', () => {
    const list = buildList([
      todo({ id: 'binned', deletedAt: '2026-11-03T00:00:00.000Z' }),
      todo({ id: 'archived', status: 'done', archivedAt: '2026-11-03T00:00:00.000Z' }),
      todo({ id: 'asleep', snoozedUntil: new Date(2026, 10, 4, 18).toISOString() }),
      todo({ id: 'awake', snoozedUntil: new Date(2026, 10, 4, 9).toISOString() }),
    ], [], { now: NOW })
    expect(shape(list)).toEqual(['nodate: awake'])
    expect(list.completed).toEqual([])
  })

  it('puts a sheet row whose date is not a real day under No date', () => {
    const list = buildList([], [
      row({ row: 5, id: 'garbled', dueDate: '11/23/2026' }),
      row({ row: 6, id: 'impossible', dueDate: '2026-02-30' }),
    ], { now: NOW })
    expect(shape(list)).toEqual(['nodate: garbled impossible'])
  })

  it('reads "today" from the local calendar across midnight', () => {
    const tasks = [todo({ id: 'wed', dueDate: '2026-11-04' }), todo({ id: 'thu', dueDate: '2026-11-05' })]
    expect(shape(buildList(tasks, [], { now: new Date(2026, 10, 4, 23, 59, 59) }))).toEqual(['today: wed', 'upcoming: thu'])
    expect(shape(buildList(tasks, [], { now: new Date(2026, 10, 5, 0, 0, 1) }))).toEqual(['overdue: wed', 'today: thu'])
  })

  it('keeps the local day in the evening, when UTC has already moved on', () => {
    inNewYork()
    // 21:00 in New York is 02:00 the next day in UTC: a UTC day key would call Thursday "today".
    const evening = new Date(2026, 10, 4, 21, 0)
    expect(evening.toISOString().slice(0, 10)).toBe('2026-11-05')
    const tasks = [todo({ id: 'wed', dueDate: '2026-11-04' }), todo({ id: 'thu', dueDate: '2026-11-05' })]
    expect(shape(buildList(tasks, [row({ row: 5, id: 'r-thu', dueDate: '2026-11-05' })], { now: evening })))
      .toEqual(['today: wed', 'upcoming: thu r-thu'])
  })

  it.each([
    // Spring forward: 8 March 2026 has 23 hours in New York.
    ['the 23-hour day', [2026, 2, 8], 23, '2026-03-07', '2026-03-08', '2026-03-09'],
    // Fall back: 1 November 2026 has 25 hours.
    ['the 25-hour day', [2026, 10, 1], 25, '2026-10-31', '2026-11-01', '2026-11-02'],
  ] as const)('holds the same "today" from the first to the last half hour of %s', (_day, [y, m, d], hours, before, today, after) => {
    inNewYork()
    const midnight = new Date(y, m, d).getTime()
    expect((new Date(y, m, d + 1).getTime() - midnight) / 3_600_000).toBe(hours)
    const tasks = [todo({ id: 'before', dueDate: before }), todo({ id: 'today', dueDate: today }), todo({ id: 'after', dueDate: after })]
    const expected = ['overdue: before', 'today: today', 'upcoming: after']
    expect(shape(buildList(tasks, [], { now: new Date(y, m, d, 0, 30) }))).toEqual(expected)
    expect(shape(buildList(tasks, [], { now: new Date(y, m, d, 23, 30) }))).toEqual(expected)
  })
})

describe('list helpers', () => {
  it('sectionFor compares day keys', () => {
    expect(sectionFor('2026-11-03', '2026-11-04')).toBe('overdue')
    expect(sectionFor('2026-11-04', '2026-11-04')).toBe('today')
    expect(sectionFor('2026-11-05', '2026-11-04')).toBe('upcoming')
    expect(sectionFor(null, '2026-11-04')).toBe('nodate')
  })

  it('urgency ranks by meaning: High with P2, Medium with P3, Low after P3; P4 and a blank sheet priority are both last', () => {
    const task = (priority: Todo['priority']) => urgency({ kind: 'task', todo: todo({ priority }) })
    const sheet = (priority: 1 | 2 | 3 | null) => urgency({ kind: 'sheet', item: row({ row: 1, priority }) })
    expect(task(4)).toBe(1)
    expect(sheet(1)).toBe(task(3))
    expect(sheet(2)).toBe(task(2))
    expect(sheet(3)).toBeGreaterThan(task(2))
    expect(sheet(3)).toBeLessThan(task(1))
    expect(task(1)).toBe(Number.POSITIVE_INFINITY)
    expect(sheet(null)).toBe(Number.POSITIVE_INFINITY)
  })

  it('never ranks a sheet row with a task P1 Urgent', () => {
    const list = buildList([todo({ id: 'urgent', dueDate: '2026-11-10', priority: 4, position: 9000 })], [
      row({ row: 50, id: 'high', dueDate: '2026-11-10', priority: 1 }),
    ], { now: NOW })
    expect(shape(list)).toEqual(['upcoming: urgent high'])
  })

  it('lets a sheet row marked Low sit above a plain P4 task, and a plain task above an unmarked row', () => {
    const list = buildList([todo({ id: 'plain', dueDate: '2026-11-10', priority: 1 }), todo({ id: 'p3', dueDate: '2026-11-10', priority: 2 })], [
      row({ row: 40, id: 'unmarked', dueDate: '2026-11-10' }),
      row({ row: 41, id: 'low', dueDate: '2026-11-10', priority: 3 }),
      row({ row: 42, id: 'high', dueDate: '2026-11-10', priority: 1 }),
    ], { now: NOW })
    expect(shape(list)).toEqual(['upcoming: high p3 low plain unmarked'])
  })

  it('sectionFor files a value that is not a day key under No date', () => {
    for (const dueDate of ['11/09/2026', '2026-02-30', '']) expect(sectionFor(dueDate, '2026-11-04')).toBe('nodate')
  })

  it('compareListItems puts an undated item after a dated one', () => {
    const dated: ListItem = { kind: 'sheet', item: row({ row: 2, dueDate: '2026-12-01' }) }
    const undated: ListItem = { kind: 'task', todo: todo({ priority: 4 }) }
    expect(compareListItems(dated, undated)).toBeLessThan(0)
    expect(compareListItems(undated, dated)).toBeGreaterThan(0)
  })
})

describe('the task sheet beside tasks', () => {
  it('maps a sheet priority to the task priority it ranks with: High P2, Medium and Low P3, blank P4', () => {
    expect(([1, 2, 3, null] as const).map(sheetAsTaskPriority)).toEqual([3, 2, 2, 1])
    expect(SHEET_PRIORITY_WORD).toEqual({ 1: 'High', 2: 'Medium', 3: 'Low' })
  })

  it('names the sheet by its feed title, else "Task sheet"', () => {
    expect(sheetName({ configured: true, title: ' Ops Board ', url: 'x', fetchedAt: null, stale: false, error: null, items: [] })).toBe('Ops Board')
    expect(sheetName({ configured: true, url: 'x', fetchedAt: null, stale: false, error: 'boom', items: [] })).toBe('Task sheet')
    expect(sheetName({ configured: false, items: [], reason: 'Set it' })).toBe('Task sheet')
    expect(sheetName(null)).toBe('Task sheet')
  })
})

describe('finishing a repeating task', () => {
  const issueLink = { connector: 'github', externalId: 'acme/site#12', externalUrl: 'https://github.com/acme/site/issues/12', lastSyncedAt: null } as unknown as Todo['externalLinks'][number]

  it('rolls any repeating task with a due date, an issue-linked one too (nothing owns completion)', () => {
    expect(rollsOnCompletion(todo({ recurrence: 'weekly', dueDate: '2026-11-04' }))).toBe(true)
    expect(rollsOnCompletion(todo({ recurrence: 'weekly', dueDate: '2026-11-04', externalLinks: [issueLink] }))).toBe(true)
    expect(rollsOnCompletion(todo({ recurrence: 'weekly', dueDate: null }))).toBe(false)
    expect(rollsOnCompletion(todo({ dueDate: '2026-11-04' }))).toBe(false)
  })

  it('offers no Undo for an issue-linked weekly task, and names its next date', () => {
    const weekly = todo({ id: 'w', title: 'Weekly review', recurrence: 'weekly', dueDate: '2026-11-04', externalLinks: [issueLink] })
    const next = todo({ id: 'n', title: 'Weekly review', recurrence: 'weekly', dueDate: '2026-11-11', externalLinks: [] })
    expect(afterDone(weekly, new Set(['w']), [{ ...weekly, status: 'done' }, next])).toEqual({ kind: 'next', dueDate: '2026-11-11' })
    expect(afterDone(todo({ id: 'p', externalLinks: [issueLink] }), new Set(['p']), [])).toEqual({ kind: 'undo' })
  })
})

describe('clearScope', () => {
  it('says all clear with nothing open, today clear with only later work, and nothing from a filtered view', () => {
    expect(clearScope([], 3, '2026-11-04', {})).toBe('all')
    expect(clearScope([], 0, '2026-11-04', {})).toBeNull()
    expect(clearScope([{ dueDate: '2026-11-10' }], 1, '2026-11-04', {})).toBe('today')
    expect(clearScope([{ dueDate: '2026-11-04' }], 1, '2026-11-04', {})).toBeNull()
    expect(clearScope([{ dueDate: '2026-11-01' }], 1, '2026-11-04', {})).toBeNull()
    expect(clearScope([], 3, '2026-11-04', { filtered: true })).toBeNull()
  })
})
