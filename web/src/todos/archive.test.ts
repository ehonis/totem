import { describe, expect, it } from 'vitest'

import { groupArchive } from './archive'
import type { Todo } from './types'

const NOW = new Date(2026, 8, 16, 10, 0) // Wednesday 16 September 2026

function done(id: string, completedAt: Date | null, overrides: Partial<Todo> = {}): Todo {
  return {
    id, title: id, description: '', area: 'Personal', ventureTag: null, status: 'done', priority: 1,
    dueDate: null, recurrence: null, snoozedUntil: null, position: 0,
    outcome: 'completed', createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z',
    completedAt: completedAt ? completedAt.toISOString() : null,
    archivedAt: '2026-09-16T00:00:00.000Z', deletedAt: null, tags: [], notes: [], relations: [],
    externalLinks: [], syncState: { status: 'idle', pending: 0, conflicts: 0, exhausted: 0, missing: false, lastSuccessAt: null, lastError: null },
    ...overrides,
  }
}

describe('archive grouping', () => {
  it('buckets by day and names the recent ones in words', () => {
    const groups = groupArchive([
      done('today', new Date(2026, 8, 16, 9, 0)),
      done('also-today', new Date(2026, 8, 16, 8, 0)),
      done('yesterday', new Date(2026, 8, 15, 17, 0)),
      done('friday', new Date(2026, 8, 11, 17, 0)),
      done('august', new Date(2026, 7, 3, 17, 0)),
      done('last-year', new Date(2025, 10, 3, 17, 0)),
    ], 'day', NOW)

    expect(groups.map(group => group.label)).toEqual([
      'Today', 'Yesterday', 'Friday, Sep 11', 'Aug 3', 'Nov 3, 2025',
    ])
    expect(groups[0].todos.map(todo => todo.id)).toEqual(['today', 'also-today'])
  })

  it('groups weeks from Monday and names this week and last', () => {
    const groups = groupArchive([
      done('monday', new Date(2026, 8, 14, 9, 0)),
      done('wednesday', new Date(2026, 8, 16, 9, 0)),
      done('last-week', new Date(2026, 8, 10, 9, 0)),
      done('older', new Date(2026, 7, 26, 9, 0)),
    ], 'week', NOW)

    expect(groups.map(group => [group.label, group.todos.length])).toEqual([
      ['This week', 2], ['Last week', 1], ['Aug 24–30', 1],
    ])
  })

  it('names months without the year inside this year, and spells out other years', () => {
    const groups = groupArchive([
      done('september', new Date(2026, 8, 2, 9, 0)),
      done('august', new Date(2026, 7, 2, 9, 0)),
      done('last-december', new Date(2025, 11, 2, 9, 0)),
    ], 'month', NOW)

    expect(groups.map(group => group.label)).toEqual(['September', 'August', 'December 2025'])
  })

  it('groups by year, newest first', () => {
    const groups = groupArchive([
      done('old', new Date(2024, 1, 2, 9, 0)),
      done('new', new Date(2026, 1, 2, 9, 0)),
      done('mid', new Date(2025, 1, 2, 9, 0)),
    ], 'year', NOW)

    expect(groups.map(group => group.label)).toEqual(['2026', '2025', '2024'])
  })

  it('groups by when the work ended, not when the sweep filed it', () => {
    // Both were archived in the same 18:00 run; they were finished days apart.
    const groups = groupArchive([
      done('monday-work', new Date(2026, 8, 14, 11, 0), { archivedAt: '2026-09-16T18:00:00.000Z' }),
      done('today-work', new Date(2026, 8, 16, 11, 0), { archivedAt: '2026-09-16T18:00:00.000Z' }),
    ], 'day', NOW)

    expect(groups.map(group => group.label)).toEqual(['Today', 'Monday, Sep 14'])
  })

  it('falls back to the filing date, and keeps undated tasks in a trailing group', () => {
    const groups = groupArchive([
      done('no-completion', null, { archivedAt: '2026-09-15T18:00:00.000Z' }),
      done('no-dates', null, { archivedAt: null }),
      done('today', new Date(2026, 8, 16, 9, 0)),
    ], 'day', NOW)

    expect(groups.map(group => group.label)).toEqual(['Today', 'Yesterday', 'No date recorded'])
    expect(groups.at(-1)?.todos.map(todo => todo.id)).toEqual(['no-dates'])
  })

  it('returns nothing for an empty archive', () => {
    expect(groupArchive([], 'day', NOW)).toEqual([])
  })
})
