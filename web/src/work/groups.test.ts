import { describe, expect, it } from 'vitest'
import { byDue, chatsByTask, dueLabel, folderOrder, fromSheet, fromTodo, isOpenTodo, resolveRef, type WorkTask } from './groups'
import { filterItems } from './ComboPicker'
import type { ChatThread, Project } from '../chat/types'
import type { Todo } from '../todos/types'

const project = (id: string, name: string, parentId?: string): Project => ({ id, name, ...(parentId ? { parentId } : {}) } as Project)
const task = (ref: string, title: string, extra: Partial<WorkTask> = {}): WorkTask => ({ ref, kind: 'local', title, dueDate: null, priority: 1, done: false, status: '', updatedAt: 0, folderId: null, ...extra })
const chat = (id: string, taskId: string | undefined, updatedAt: number, extra: Partial<ChatThread> = {}): ChatThread => ({
  id, kind: 'regular', taskId, createdAt: updatedAt, updatedAt, messages: [{ id: 'm', role: 'user', content: 'hi', createdAt: updatedAt }], ...extra,
} as ChatThread)

describe('work groups', () => {
  const projects = [project('p1', 'Globex'), project('p2', 'Totem'), project('f1', 'Work tab', 'p2')]

  it('folders follow their project, in panel order', () => {
    expect(folderOrder([project('f1', 'Folder', 'p2'), project('p1', 'A'), project('p2', 'B')]).map((p) => p.id)).toEqual(['p1', 'p2', 'f1'])
  })

  it('lists each task\'s chats, latest first, leaving out empty drafts', () => {
    const threads = [chat('t1', 'a', 300), chat('t2', 'b', 100), chat('t3', 'a', 50), chat('d', 'b', 1, { messages: [] })]
    const linked = chatsByTask(threads, [task('a', 'A'), task('b', 'B')])
    expect(linked.get('a')?.map((c) => c.id)).toEqual(['t1', 't3'])
    expect(linked.get('b')?.map((c) => c.id)).toEqual(['t2'])
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

  it('orders a picker by due day, undated last, then priority', () => {
    const tasks = [task('a', 'No date', { priority: 4 }), task('b', 'Later', { dueDate: '2026-11-20' }), task('c', 'Soon', { dueDate: '2026-11-14' }), task('d', 'Soon urgent', { dueDate: '2026-11-14', priority: 4 })]
    expect([...tasks].sort(byDue).map((t) => t.ref)).toEqual(['d', 'c', 'b', 'a'])
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

  it('chats follow a moved row', () => {
    expect(chatsByTask([chat('c', 'sheet:0:4:aaaa', 5)], tasks).get('sheet:0:9:aaaa')?.map((c) => c.id)).toEqual(['c'])
  })
})

describe('combo picker filter', () => {
  const items = [{ key: 'a', label: 'Globex portal' }, { key: 'b', label: 'Work tab', keywords: 'Totem' }, { key: 'c', label: 'Café notes' }]
  it('matches every word, keywords included, ignoring case and accents', () => {
    expect(filterItems(items, '').map((i) => i.key)).toEqual(['a', 'b', 'c'])
    expect(filterItems(items, 'totem work').map((i) => i.key)).toEqual(['b'])
    expect(filterItems(items, 'CAFE').map((i) => i.key)).toEqual(['c'])
    expect(filterItems(items, 'nothing')).toEqual([])
  })
})
