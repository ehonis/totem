import { describe, it, expect } from 'vitest'
import { sidebarLists, inScope, placeLabel, scopeLabel, validScope } from './sidebar'
import { DAY_MS, HOUR_MS } from './settle'
import type { ChatThread, Project } from './types'

const NOW = new Date(2026, 10, 24, 10, 0).getTime()
const msg = [{ id: 'm', role: 'user' as const, content: 'hi', createdAt: NOW - HOUR_MS }]
const chat = (id: string, extra: Partial<ChatThread> = {}): ChatThread => ({ id, kind: 'regular', messages: msg, createdAt: NOW - HOUR_MS, updatedAt: NOW - HOUR_MS, ...extra })
const project = (id: string, name: string, parentId?: string): Project => ({ id, name, instructions: '', fileCount: 0, chatCount: 0, createdAt: 0, updatedAt: 0, ...(parentId ? { parentId } : {}) }) as Project
const PROJECTS = [project('acme', 'Acme'), project('net', 'Network refresh', 'acme'), project('trips', 'Trips')]
const ids = (list: ChatThread[]) => list.map((t) => t.id)
const base = { now: NOW, autoDays: 3, live: () => false, projects: PROJECTS }

describe('the chats panel’s shelves', () => {
  it('lists every chat in every project and folder in one list, latest first', () => {
    const lists = sidebarLists([
      chat('home', { updatedAt: NOW - 3 * HOUR_MS }),
      chat('folder', { projectId: 'net', updatedAt: NOW - HOUR_MS }),
      chat('project', { projectId: 'trips', updatedAt: NOW - 2 * HOUR_MS }),
    ], base)
    expect(ids(lists.inbox)).toEqual(['folder', 'project', 'home'])
  })

  it('puts a running reply under Working, but one waiting on him stays in the list', () => {
    const live = (id: string) => id === 'run' || id === 'asks'
    const lists = sidebarLists([chat('run'), chat('asks'), chat('idle')], { ...base, live, needsYou: (t) => t.id === 'asks' })
    expect(ids(lists.working)).toEqual(['run'])
    expect(ids(lists.inbox).sort()).toEqual(['asks', 'idle'])
  })

  it('keeps pinned chats on top, and pinned wins over Working', () => {
    const lists = sidebarLists([chat('p', { pinned: true }), chat('q')], { ...base, live: (id) => id === 'p' })
    expect(ids(lists.pinned)).toEqual(['p'])
    expect(lists.working).toEqual([])
  })

  it('has one Settled shelf for every project, most recently settled first, and Snoozed soonest first', () => {
    const lists = sidebarLists([
      chat('old', { projectId: 'net', updatedAt: NOW - 5 * DAY_MS }),
      chat('by-hand', { projectId: 'trips', settledOverride: 'settled', settledAt: NOW - HOUR_MS }),
      chat('later', { snoozedUntil: NOW + 5 * HOUR_MS }),
      chat('soon', { projectId: 'acme', snoozedUntil: NOW + HOUR_MS }),
    ], base)
    expect(ids(lists.settled)).toEqual(['by-hand', 'old'])
    expect(ids(lists.snoozed)).toEqual(['soon', 'later'])
    expect(lists.inbox).toEqual([])
  })

  it('leaves out totems’ own chats and empty ones, but lists the open chat and a running one', () => {
    const lists = sidebarLists([
      chat('totem', { totemId: 'daily-brief' }),
      chat('empty', { messages: [] }),
      chat('summary', { messages: [], messageCount: 4 }),
      chat('open', { messages: [] }),
      chat('starting', { messages: [] }),
    ], { ...base, activeId: 'open', live: (id) => id === 'starting' })
    expect(ids(lists.inbox).sort()).toEqual(['open', 'summary'])
    expect(ids(lists.working)).toEqual(['starting'])
  })

  it('settles a chat once its linked task is done, and brings it back when the task is reopened', () => {
    const linked = chat('linked', { taskId: 'task-1', projectId: 'net' })
    expect(ids(sidebarLists([{ ...linked, taskDoneAt: NOW - 60_000 }], base).settled)).toEqual(['linked'])
    expect(ids(sidebarLists([linked], base).inbox)).toEqual(['linked'])
  })

  it('keeps a chat that waits on him in the list, whatever would settle it on its own, but not against his own Settle', () => {
    const asks = chat('asks', { taskId: 'task-1', taskDoneAt: NOW - 60_000, updatedAt: NOW - 5 * DAY_MS })
    const needsYou = (t: ChatThread) => t.id === 'asks'
    expect(ids(sidebarLists([asks], { ...base, needsYou }).inbox)).toEqual(['asks'])
    expect(ids(sidebarLists([{ ...asks, settledOverride: 'settled', settledAt: NOW - HOUR_MS }], { ...base, needsYou }).settled)).toEqual(['asks'])
  })

  it('keeps the chat on screen in place while it would otherwise settle', () => {
    const done = chat('done', { doneAt: NOW - 60_000 })
    expect(ids(sidebarLists([done], { ...base, openId: 'done' }).inbox)).toEqual(['done'])
    expect(ids(sidebarLists([done], base).settled)).toEqual(['done'])
  })
})

describe('the scope', () => {
  it('narrows to one project with its folders, or to Home, and a deleted project counts as Home', () => {
    expect(inScope({ projectId: 'net' }, 'acme', PROJECTS)).toBe(true)
    expect(inScope({ projectId: 'acme' }, 'acme', PROJECTS)).toBe(true)
    expect(inScope({ projectId: 'trips' }, 'acme', PROJECTS)).toBe(false)
    expect(inScope({ projectId: 'net' }, 'net', PROJECTS)).toBe(true)
    expect(inScope({ projectId: 'acme' }, 'net', PROJECTS)).toBe(false)
    expect(inScope({}, 'home', PROJECTS)).toBe(true)
    expect(inScope({ projectId: 'gone' }, 'home', PROJECTS)).toBe(true)
    expect(inScope({ projectId: 'trips' }, 'home', PROJECTS)).toBe(false)
    const lists = sidebarLists([chat('a', { projectId: 'net' }), chat('b')], { ...base, scope: 'acme' })
    expect(ids(lists.inbox)).toEqual(['a'])
  })

  it('names places and scopes, and forgets a scope whose project is gone', () => {
    expect(placeLabel({ projectId: 'net' }, PROJECTS)).toBe('Acme › Network refresh')
    expect(placeLabel({ projectId: 'trips' }, PROJECTS)).toBe('Trips')
    expect(placeLabel({}, PROJECTS)).toBe('')
    expect(scopeLabel('all', PROJECTS)).toBe('All chats')
    expect(scopeLabel('net', PROJECTS)).toBe('Network refresh')
    expect(validScope('gone', PROJECTS)).toBe('all')
    expect(validScope('net', PROJECTS)).toBe('net')
    expect(validScope(null, PROJECTS)).toBe('all')
  })
})
