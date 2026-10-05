import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import TodoBoard from './TodoBoard'
import TodoComposer from './TodoComposer'
import { ApiError } from '../api'
import type { Todo } from './types'

function task(input: Partial<Todo> & Pick<Todo, 'id' | 'title'>): Todo {
  return {
    description: '', area: 'Personal', ventureTag: null, status: 'todo', priority: 1,
    dueDate: null, recurrence: null, snoozedUntil: null, position: 0,
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z',
    outcome: null, completedAt: null, archivedAt: null, deletedAt: null, tags: [], notes: [], relations: [],
    externalLinks: [], lists: [], syncState: { status: 'idle', pending: 0, conflicts: 0, exhausted: 0, missing: false, lastSuccessAt: null, lastError: null },
    ...input,
  }
}

const fixture = [
  task({ id: 'todo', title: 'Plan route', status: 'todo' }),
  task({ id: 'doing', title: 'Build route', status: 'doing' }),
  task({ id: 'done', title: 'Check route', status: 'done' }),
]

afterEach(cleanup)

describe('local todo board', () => {
  it('renders three status columns on desktop and one selected segment on mobile', () => {
    const { unmount } = render(<TodoBoard initialTodos={fixture} viewport="desktop" />)
    expect(screen.getAllByRole('region', { name: /to do|doing|done/i })).toHaveLength(3)
    unmount()
    render(<TodoBoard initialTodos={fixture} viewport="mobile" />)
    expect(screen.getByRole('tablist', { name: 'Task status' })).toBeVisible()
    expect(screen.getAllByRole('region')).toHaveLength(1)
  })

  it('defaults the composer to private and requires Ventures plus one tag for Sheet sync', async () => {
    const user = userEvent.setup()
    render(<TodoComposer />)
    expect(screen.getByRole('checkbox', { name: 'Sync with Action Items' })).not.toBeChecked()
    await user.type(screen.getByLabelText('Task'), 'Follow up')
    await user.click(screen.getByRole('checkbox', { name: 'Sync with Action Items' }))
    await user.click(screen.getByRole('button', { name: 'Create task' }))
    expect(screen.getByText(/choose Ventures and a venture tag/i)).toBeVisible()
  })

  it('rolls back a rejected source-owned completion and names the source', async () => {
    const sheet = task({
      id: 'sheet', title: 'Meeting follow-up', status: 'doing', area: 'Ventures', ventureTag: 'Acme',
      externalLinks: [{ id: 'sheet-link', connector: 'sheet', externalId: 'sheet', externalUrl: 'https://docs.google.com/spreadsheets/d/sheet', sourceStatus: 'In Progress', sourceSnapshot: null, lastSyncSnapshot: null, initialStatusSeeded: true, lastObservedAt: null, lastSyncedAt: null, missingAt: null, createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z' }],
    })
    render(<TodoBoard initialTodos={[sheet]} viewport="desktop" onMove={async () => {
      throw new ApiError('Complete this task in the Action Items sheet.', 409, 'SOURCE_OWNS_COMPLETION', { source: 'sheet' })
    }} />)
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Meeting follow-up' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Move…/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Done' }))
    expect(await screen.findByText(/complete this task in the Action Items sheet/i)).toBeVisible()
    expect(screen.getByText('Meeting follow-up')).toBeVisible()
    expect(screen.getByRole('region', { name: 'Doing' })).toHaveTextContent('Meeting follow-up')
  })

  it('caps the Done preview at twelve and reveals the remainder', async () => {
    const user = userEvent.setup()
    const done = Array.from({ length: 13 }, (_, index) => task({ id: `done-${index}`, title: `Done ${index}`, status: 'done', position: index }))
    render(<TodoBoard initialTodos={done} viewport="desktop" />)
    expect(screen.getAllByTestId('done-card')).toHaveLength(12)
    await user.click(screen.getByRole('button', { name: 'Show 1 more' }))
    expect(screen.getAllByTestId('done-card')).toHaveLength(13)
  })

  it('keeps a rescheduled card on the board, shows the new due date, and rolls back on failure', async () => {
    const user = userEvent.setup()
    let rejectDueDate: (cause: Error) => void = () => {}
    const onDueDate = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectDueDate = reject }))
    render(<TodoBoard
      initialTodos={[task({ id: 'late', title: 'Prepare launch notes', dueDate: '2026-09-10' })]}
      viewport="desktop"
      now={() => new Date(2026, 8, 14, 15, 6)}
      onDueDate={onDueDate}
    />)

    await user.click(screen.getByRole('button', { name: 'Reschedule Prepare launch notes' }))
    await user.click(screen.getByRole('menuitem', { name: /^Tomorrow/ }))
    expect(onDueDate).toHaveBeenCalledWith('late', '2026-09-15')
    expect(screen.getByText('Prepare launch notes')).toBeVisible()
    expect(screen.getByRole('region', { name: 'To Do' }).querySelector('time.todo-due')).toHaveAttribute('datetime', '2026-09-15')

    rejectDueDate(new Error('Due date could not be saved.'))
    expect(await screen.findByText('Due date could not be saved.')).toBeVisible()
    expect(screen.getByRole('region', { name: 'To Do' }).querySelector('time.todo-due')).toHaveAttribute('datetime', '2026-09-10')
  })

  it('hides a snoozed card immediately and restores it when the update fails', async () => {
    const user = userEvent.setup()
    let rejectSnooze: (cause: Error) => void = () => {}
    const onSnooze = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSnooze = reject }))
    render(<TodoBoard
      initialTodos={[task({ id: 'later', title: 'Prepare launch notes' })]}
      viewport="desktop"
      now={() => new Date('2026-09-14T19:06:00.000Z')}
      onSnooze={onSnooze}
    />)

    await user.click(screen.getByRole('button', { name: 'Snooze Prepare launch notes' }))
    await user.click(screen.getByRole('menuitem', { name: /In 20 minutes/i }))
    expect(screen.queryByText('Prepare launch notes')).toBeNull()
    expect(onSnooze).toHaveBeenCalledWith('later', '2026-09-14T19:26:00.000Z')

    rejectSnooze(new Error('Snooze could not be saved.'))
    expect(await screen.findByText('Snooze could not be saved.')).toBeVisible()
    expect(screen.getByText('Prepare launch notes')).toBeVisible()
  })
})

describe('the archive under Done', () => {
  const archived = [
    task({ id: 'a1', title: 'Shipped the connector', status: 'done', completedAt: '2026-09-16T11:00:00.000Z', archivedAt: '2026-09-16T18:00:00.000Z' }),
    task({ id: 'a2', title: 'Filed the expenses', status: 'done', completedAt: '2026-09-14T11:00:00.000Z', archivedAt: '2026-09-16T18:00:00.000Z' }),
  ]

  it('stays closed until asked, then loads and groups by day', async () => {
    const user = userEvent.setup(), onShowArchive = vi.fn()
    const { rerender } = render(<TodoBoard
      initialTodos={[]} viewport="desktop" now={() => new Date(2026, 8, 16, 20, 0)}
      archiveCount={158} archiveHour="18:00" onShowArchive={onShowArchive}
    />)

    expect(screen.queryByText('Shipped the connector')).toBeNull()
    expect(screen.getByRole('button', { name: /158 archived/ })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: /158 archived/ }))
    expect(onShowArchive).toHaveBeenCalledWith(true)

    rerender(<TodoBoard
      initialTodos={[]} viewport="desktop" now={() => new Date(2026, 8, 16, 20, 0)}
      archive={archived} archiveCount={158} archiveHour="18:00" onShowArchive={onShowArchive}
    />)
    expect(screen.getByRole('region', { name: 'Today' })).toHaveTextContent('Shipped the connector')
    expect(screen.getByRole('region', { name: 'Monday, Sep 14' })).toHaveTextContent('Filed the expenses')
  })

  it('regroups the same tasks by month on request', async () => {
    const user = userEvent.setup()
    render(<TodoBoard
      initialTodos={[]} viewport="desktop" now={() => new Date(2026, 8, 16, 20, 0)}
      archive={archived} archiveCount={2} onShowArchive={() => {}}
    />)

    await user.click(screen.getByRole('button', { name: /2 archived/ }))
    await user.click(screen.getByRole('button', { name: 'Month' }))
    expect(screen.getByRole('region', { name: 'September' })).toHaveTextContent('Shipped the connector')
    expect(screen.queryByRole('region', { name: 'Today' })).toBeNull()
  })

  it('shows the archive hour so an empty Done column explains itself', () => {
    render(<TodoBoard initialTodos={[]} viewport="desktop" archiveCount={158} archiveHour="18:00" onShowArchive={() => {}} />)
    expect(screen.getByTitle(/archived at/i)).toBeVisible()
  })

  it('offers no archive control when nothing has been archived', () => {
    render(<TodoBoard initialTodos={[]} viewport="desktop" archiveCount={0} onShowArchive={() => {}} />)
    expect(screen.queryByRole('button', { name: /archived/ })).toBeNull()
  })
})

describe('not doing from the board', () => {
  it('moves the task to Done marked not doing, and puts it back if the save fails', async () => {
    const user = userEvent.setup()
    let rejectIt: (cause: Error) => void = () => {}
    const onNotDoing = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectIt = reject }))
    render(<TodoBoard initialTodos={[task({ id: 'skip', title: 'Read the changelog' })]} viewport="desktop" onNotDoing={onNotDoing} />)

    await user.click(screen.getByRole('button', { name: 'More actions for Read the changelog' }))
    await user.click(screen.getByRole('menuitem', { name: 'Not doing this' }))
    expect(onNotDoing).toHaveBeenCalledWith('skip')
    expect(screen.getByRole('region', { name: 'Done' })).toHaveTextContent('Read the changelog')
    expect(screen.getByText('Not doing')).toBeVisible()

    rejectIt(new Error('Task could not be marked as not doing.'))
    expect(await screen.findByText('Task could not be marked as not doing.')).toBeVisible()
    expect(screen.getByRole('region', { name: 'To Do' })).toHaveTextContent('Read the changelog')
  })
})
