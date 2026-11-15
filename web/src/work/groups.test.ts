import { describe, expect, it } from 'vitest'
import { buildWork, chatsByTask, dueLabel, folderOrder, fromSheet, fromTodo, isOpenTodo, resolveFolders, resolveRef, type WorkTask } from './groups'
import { filterItems } from './ComboPicker'
import type { ChatThread, Project } from '../chat/types'
import type { Todo } from '../todos/types'

const project = (id: string, name: string, parentId?: string): Project => ({ id, name, ...(parentId ? { parentId } : {}) } as Project)
const task = (ref: string, title: string, extra: Partial<WorkTask> = {}): WorkTask => ({ ref, kind: 'local', title, dueDate: null, priority: 1, done: false, status: '', updatedAt: 0, ...extra })
const chat = (id: string, taskId: string | undefined, updatedAt: number, extra: Partial<ChatThread> = {}): ChatThread => ({
  id, kind: 'regular', taskId, createdAt: updatedAt, updatedAt, messages: [{ id: 'm', role: 'user', content: 'hi', createdAt: updatedAt }], ...extra,
} as ChatThread)
const OPTS = { sort: 'due', groupBy: 'folder', show: 'all', query: '' } as const

describe('work groups', () => {
  const projects = [project('p1', 'Cresco'), project('p2', 'Totem'), project('f1', 'Work tab', 'p2')]

  it('folders follow their project, in panel order', () => {
    expect(folderOrder([project('f1', 'Folder', 'p2'), project('p1', 'A'), project('p2', 'B')]).map((p) => p.id)).toEqual(['p1', 'p2', 'f1'])
  })

  it('groups by folder, projects in order, then No folder; empty groups are left out', () => {
    const tasks = [task('a', 'Lease'), task('b', 'Picker'), task('c', 'Loose'), task('d', 'Cert')]
    const groups = buildWork(tasks, [], projects, { a: 'p1', b: 'f1', d: 'p1', x: 'gone' }, OPTS)
    expect(groups.map((g) => g.key)).toEqual(['p1', 'f1', ''])
    expect(groups[1].parent?.id).toBe('p2')
    expect(groups[0].rows.map((r) => r.task.ref)).toEqual(['d', 'a'])
  })

  it('a filing whose project is gone reads as no folder', () => {
    const groups = buildWork([task('a', 'A')], [], projects, { a: 'deleted' }, OPTS)
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('')
  })

  it('sorts by due day, undated last, then priority', () => {
    const tasks = [task('a', 'No date', { priority: 4 }), task('b', 'Later', { dueDate: '2026-11-20' }), task('c', 'Soon', { dueDate: '2026-11-14' }), task('d', 'Soon urgent', { dueDate: '2026-11-14', priority: 4 })]
    const [g] = buildWork(tasks, [], [], {}, { ...OPTS, groupBy: 'none' })
    expect(g.rows.map((r) => r.task.ref)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('sorts by priority and by recent chat activity', () => {
    const tasks = [task('a', 'A', { priority: 2 }), task('b', 'B', { priority: 4 }), task('c', 'C', { priority: 3 })]
    expect(buildWork(tasks, [], [], {}, { ...OPTS, groupBy: 'none', sort: 'priority' })[0].rows.map((r) => r.task.ref)).toEqual(['b', 'c', 'a'])
    const threads = [chat('t1', 'a', 300), chat('t2', 'c', 100), chat('t3', 'a', 50)]
    const [g] = buildWork(tasks, threads, [], {}, { ...OPTS, groupBy: 'none', sort: 'activity' })
    expect(g.rows.map((r) => r.task.ref)).toEqual(['a', 'c', 'b'])
    expect(g.rows[0].chats.map((c) => c.id)).toEqual(['t1', 't3'])
  })

  it('shows only tasks with or without chats, and filters by task or chat title', () => {
    const tasks = [task('a', 'Lease abstract'), task('b', 'Renew cert')]
    const threads = [chat('t1', 'b', 10, { title: 'Certbot on the VM' })]
    expect(buildWork(tasks, threads, [], {}, { ...OPTS, show: 'linked' }).flatMap((g) => g.rows.map((r) => r.task.ref))).toEqual(['b'])
    expect(buildWork(tasks, threads, [], {}, { ...OPTS, show: 'unlinked' }).flatMap((g) => g.rows.map((r) => r.task.ref))).toEqual(['a'])
    expect(buildWork(tasks, threads, [], {}, { ...OPTS, query: 'certbot' }).flatMap((g) => g.rows.map((r) => r.task.ref))).toEqual(['b'])
  })

  it('leaves out done tasks and empty drafts', () => {
    const groups = buildWork([task('a', 'A', { done: true }), task('b', 'B')], [chat('t', 'b', 1, { messages: [] })], [], {}, OPTS)
    expect(groups[0].rows.map((r) => r.task.ref)).toEqual(['b'])
    expect(groups[0].rows[0].chats).toEqual([])
    expect(chatsByTask([chat('x', undefined, 1)]).size).toBe(0)
  })

  it('reads a todo and a sheet row onto one scale', () => {
    const todo = { id: 't', title: 'T', dueDate: '2026-11-14', priority: 3, status: 'todo', updatedAt: '2026-11-13T00:00:00Z', archivedAt: null, deletedAt: null, snoozedUntil: null } as unknown as Todo
    expect(fromTodo(todo)).toMatchObject({ ref: 't', kind: 'local', priority: 3, done: false })
    expect(fromSheet({ id: 'sheet:0:2:ab', row: 2, title: 'S', who: '', priority: 1, status: 'In Progress', dueDate: null, notes: '', url: 'u' })).toMatchObject({ kind: 'sheet', priority: 4, status: 'In Progress' })
    const now = new Date('2026-11-13T12:00:00')
    expect(isOpenTodo(todo, now)).toBe(true)
    expect(isOpenTodo({ ...todo, snoozedUntil: '2026-11-20T00:00:00Z' } as Todo, now)).toBe(false)
    expect(isOpenTodo({ ...todo, status: 'done' } as Todo, now)).toBe(false)
  })

  it('labels due days for a sidebar', () => {
    const now = new Date(2026, 10, 13, 12)
    expect(dueLabel('2026-11-12', now)).toEqual({ text: 'Overdue', tone: 'overdue' })
    expect(dueLabel('2026-11-13T09:00', now)).toEqual({ text: 'Today', tone: 'today' })
    expect(dueLabel('2026-11-14', now)).toEqual({ text: 'Tomorrow', tone: 'soon' })
    expect(dueLabel('2026-11-17', now)?.tone).toBe('soon')
    expect(dueLabel('2026-12-24', now)?.tone).toBe('later')
    expect(dueLabel(null, now)).toBeNull()
  })
})

describe('sheet rows that moved', () => {
  const sheet = (ref: string, title = 'S') => task(ref, title, { kind: 'sheet' })
  const tasks = [sheet('sheet:0:9:aaaa'), sheet('sheet:0:12:bbbb'), sheet('sheet:0:13:bbbb'), task('local', 'L')]

  it('a stored ref finds its row by tab and title when exactly one row matches', () => {
    expect(resolveRef('sheet:0:9:aaaa', tasks)).toBe('sheet:0:9:aaaa')
    expect(resolveRef('sheet:0:4:aaaa', tasks)).toBe('sheet:0:9:aaaa')
    expect(resolveRef('sheet:0:2:bbbb', tasks)).toBe('sheet:0:2:bbbb')
    expect(resolveRef('sheet:7:4:aaaa', tasks)).toBe('sheet:7:4:aaaa')
    expect(resolveRef('local', tasks)).toBe('local')
  })

  it('chats and filings follow a moved row; a current filing wins over a moved one', () => {
    expect(resolveFolders({ 'sheet:0:4:aaaa': 'p1' }, tasks)).toEqual({ 'sheet:0:9:aaaa': 'p1' })
    expect(resolveFolders({ 'sheet:0:4:aaaa': 'p1', 'sheet:0:9:aaaa': 'p2' }, tasks)).toEqual({ 'sheet:0:9:aaaa': 'p2' })
    const groups = buildWork(tasks, [chat('c', 'sheet:0:4:aaaa', 5)], [project('p1', 'P')], { 'sheet:0:4:aaaa': 'p1' }, OPTS)
    expect(groups[0].key).toBe('p1')
    expect(groups[0].rows[0].chats.map((c) => c.id)).toEqual(['c'])
  })

  it('a snoozed task is off the panel but not done', () => {
    const groups = buildWork([task('a', 'Snoozed', { hidden: true }), task('b', 'Open')], [], [], {}, OPTS)
    expect(groups[0].rows.map((r) => r.task.ref)).toEqual(['b'])
  })
})

describe('combo picker filter', () => {
  const items = [{ key: 'a', label: 'Cresco portal' }, { key: 'b', label: 'Work tab', keywords: 'Totem' }, { key: 'c', label: 'Café notes' }]
  it('matches every word, keywords included, ignoring case and accents', () => {
    expect(filterItems(items, '').map((i) => i.key)).toEqual(['a', 'b', 'c'])
    expect(filterItems(items, 'totem work').map((i) => i.key)).toEqual(['b'])
    expect(filterItems(items, 'CAFE').map((i) => i.key)).toEqual(['c'])
    expect(filterItems(items, 'nothing')).toEqual([])
  })
})
