import { describe, expect, it } from 'vitest'

import { filterTodos, optimisticMove, rollbackMove, sortTodos } from './state'
import type { Todo } from './types'

function todo(input: Partial<Todo> & Pick<Todo, 'id' | 'title'>): Todo {
  return {
    description: '', area: 'Personal', ventureTag: null, status: 'todo', priority: 1,
    dueDate: null, recurrence: null, snoozedUntil: null, position: 0,
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z',
    completedAt: null, archivedAt: null, deletedAt: null, tags: [], notes: [],
    relations: [], externalLinks: [], syncState: {
      status: 'idle', pending: 0, conflicts: 0, exhausted: 0, missing: false,
      lastSuccessAt: null, lastError: null,
    },
    ...input,
  }
}

const fixture: Todo[] = [
  todo({ id: 'b', title: 'Undated personal', priority: 1, position: 20 }),
  todo({ id: 'a', title: 'Urgent dated', priority: 4, dueDate: '2026-09-14', position: 10 }),
  todo({ id: 'c', title: 'High dated', priority: 3, dueDate: '2026-09-13', position: 30 }),
  todo({
    id: 'github-42', title: 'Fix access reader', position: 40,
    externalLinks: [{
      id: 'link-42', connector: 'github', externalId: '42',
      externalUrl: 'https://github.com/acme/acme/issues/42', sourceStatus: 'open',
      sourceSnapshot: null, lastSyncSnapshot: null, initialStatusSeeded: true,
      lastObservedAt: null, lastSyncedAt: null, missingAt: null,
      createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z',
    }],
  }),
]

describe('todo board state', () => {
  it('keeps manual order while alternate sorts leave stored positions untouched', () => {
    const short = fixture.slice(0, 3)
    expect(sortTodos(short, 'manual').map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(sortTodos(short, 'priority').map(item => item.id)).toEqual(['a', 'c', 'b'])
    expect(short.map(item => item.position)).toEqual([20, 10, 30])
  })

  it('puts undated work last and finds linked GitHub identifiers', () => {
    expect(sortTodos(fixture, 'due').at(-1)?.dueDate).toBeNull()
    expect(filterTodos(fixture, { search: 'acme#42' }).map(item => item.id)).toEqual(['github-42'])
  })

  it('applies several sort criteria in the order they are given', () => {
    const sameDate = [
      todo({ id: 'low-today', title: 'Low today', dueDate: '2026-09-15', priority: 1, position: 1 }),
      todo({ id: 'high-tomorrow', title: 'High tomorrow', dueDate: '2026-09-16', priority: 4, position: 2 }),
      todo({ id: 'high-today', title: 'High today', dueDate: '2026-09-15', priority: 4, position: 3 }),
    ]
    expect(sortTodos(sameDate, ['due', 'priority']).map(item => item.id)).toEqual([
      'high-today', 'low-today', 'high-tomorrow',
    ])
    expect(sortTodos(sameDate, ['priority', 'due']).map(item => item.id)).toEqual([
      'high-today', 'high-tomorrow', 'low-today',
    ])
  })

  it('optimistically moves and can restore the exact prior board', () => {
    const next = optimisticMove(fixture, 'a', 'doing', 0)
    expect(next.todos.find(item => item.id === 'a')?.status).toBe('doing')
    expect(rollbackMove(next.todos, next.rollback)).toEqual(fixture)
  })
})
