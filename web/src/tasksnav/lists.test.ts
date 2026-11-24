import { describe, expect, it } from 'vitest'
import { playByTask, scopedTasks, snoozedTasks, taskActivity, taskSections } from './lists'
import type { WorkTask } from '../work/groups'
import type { ChatThread } from '../chat/types'

// Tuesday 24 November 2026, mid-afternoon.
const NOW = new Date(2026, 10, 24, 15, 0)
const task = (ref: string, f: Partial<WorkTask> = {}): WorkTask => ({
  ref, kind: 'local', title: ref, dueDate: null, priority: 1, done: false, status: '', updatedAt: 0, folderId: null, ...f,
})

describe('taskSections', () => {
  it('puts open tasks under when they are due, in due order, and leaves the rest out', () => {
    const sections = taskSections([
      task('later', { dueDate: '2026-12-20' }),
      task('undated'),
      task('today', { dueDate: '2026-11-24' }),
      task('overdue', { dueDate: '2026-11-20' }),
      task('friday', { dueDate: '2026-11-27' }),
      task('tomorrow', { dueDate: '2026-11-25' }),
      task('done', { dueDate: '2026-11-24', done: true }),
      task('snoozed', { dueDate: '2026-11-24', hidden: true }),
    ], NOW)
    expect(sections.map((s) => [s.label, s.tasks.map((t) => t.ref)])).toEqual([
      ['Overdue', ['overdue']], ['Today', ['today']], ['Next 7 days', ['tomorrow', 'friday']], ['Later', ['later']], ['No date', ['undated']],
    ])
  })

  it('sorts the most urgent first within a day', () => {
    const [today] = taskSections([task('low', { dueDate: '2026-11-24', priority: 1 }), task('high', { dueDate: '2026-11-24', priority: 4 })], NOW)
    expect(today.tasks.map((t) => t.ref)).toEqual(['high', 'low'])
  })
})

describe('snoozedTasks', () => {
  it('lists tasks and sheet rows snoozed into the future, soonest back first', () => {
    const todo = (until: string | null) => ({ snoozedUntil: until }) as WorkTask['todo']
    const list = snoozedTasks([
      task('week', { hidden: true, todo: todo('2026-12-01T15:00:00.000Z') }),
      task('row', { kind: 'sheet', hidden: true, mark: { state: 'snoozed', at: '', until: '2026-11-25T15:00:00.000Z' } }),
      task('lapsed', { hidden: true, todo: todo('2026-11-20T15:00:00.000Z') }),
      task('archived', { hidden: true, todo: todo(null) }),
      task('open', { todo: todo(null) }),
    ], NOW.getTime())
    expect(list.map((t) => t.ref)).toEqual(['row', 'week'])
  })
})

describe('taskActivity', () => {
  const chat = (id: string, needsReply = false) => ({ id, needsReply }) as ChatThread
  it('says a chat is answering before it says one is waiting', () => {
    expect(taskActivity([chat('a', true), chat('b')], (id) => id === 'b')).toBe('live')
    expect(taskActivity([chat('a', true)], () => false)).toBe('waiting')
    expect(taskActivity([chat('a')], () => false)).toBeNull()
    expect(taskActivity(undefined, () => false)).toBeNull()
  })
})

describe('playByTask', () => {
  const chat = (id: string, taskId?: string) => ({ id, taskId, messages: [{}] } as unknown as ChatThread)
  it('gathers chats under their open task where its latest chat stands, and keeps the rest as rows', () => {
    const tasks = [task('a'), task('b'), task('done', { done: true })]
    const items = playByTask([chat('1', 'a'), chat('2'), chat('3', 'b'), chat('4', 'a'), chat('5', 'done')], tasks)
    expect(items.map((i) => (i.kind === 'task' ? `${i.group.task.ref}:${i.group.chats.map((c) => c.id).join('+')}` : i.chat.id))).toEqual(['a:1+4', '2', 'b:3', '5'])
  })
  it('leaves a snoozed task\u2019s chats as rows, so the task is listed once (under Snoozed tasks)', () => {
    const items = playByTask([chat('1', 'z')], [task('z', { hidden: true })])
    expect(items.map((i) => i.kind)).toEqual(['chat'])
  })
  it('finds a sheet row again after a row was inserted above it', () => {
    const tasks = [task('sheet:7:12:abcd1234', { kind: 'sheet' })]
    const items = playByTask([chat('1', 'sheet:7:11:abcd1234')], tasks)
    expect(items[0].kind).toBe('task')
  })
})

describe('scopedTasks', () => {
  const projects = [{ id: 'p', name: 'P' }, { id: 'f', name: 'F', parentId: 'p' }, { id: 'q', name: 'Q' }] as any
  const tasks = [task('home'), task('inP', { folderId: 'p' }), task('inF', { folderId: 'f' }), task('inQ', { folderId: 'q' })]
  it('keeps a project with its folders, or Home, or everything', () => {
    expect(scopedTasks(tasks, 'p', projects).map((t) => t.ref)).toEqual(['inP', 'inF'])
    expect(scopedTasks(tasks, 'home', projects).map((t) => t.ref)).toEqual(['home'])
    expect(scopedTasks(tasks, 'all', projects)).toHaveLength(4)
  })
})
