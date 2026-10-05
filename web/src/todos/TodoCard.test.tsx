import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import TodoCard from './TodoCard'
import type { Todo } from './types'

function task(input: Partial<Todo> & Pick<Todo, 'id' | 'title'>): Todo {
  return {
    description: '', area: 'Ventures', ventureTag: 'Acme', status: 'todo', priority: 1,
    dueDate: '2026-09-15', recurrence: null, snoozedUntil: null, position: 0,
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z',
    outcome: null, completedAt: null, archivedAt: null, deletedAt: null, tags: [], notes: [], relations: [],
    externalLinks: [], lists: [], syncState: { status: 'idle', pending: 0, conflicts: 0, exhausted: 0, missing: false, lastSuccessAt: null, lastError: null },
    ...input,
  }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('todo card menus', () => {
  it('shows the latest timestamped note and routes add-note separately from editing', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn(), onAddNote = vi.fn()
    const todo = task({
      id: 'notes', title: 'Send approval email',
      notes: [
        { id: 'old', body: 'Drafted the email', createdAt: '2026-09-15T14:10:00.000Z' },
        { id: 'latest', body: 'Waiting for AC to approve it going out', createdAt: '2026-09-15T15:28:00.000Z' },
      ],
    })
    render(<TodoCard todo={todo} onOpen={onOpen} onAddNote={onAddNote} />)

    expect(screen.getByText('Waiting for AC to approve it going out')).toBeVisible()
    expect(screen.queryByText('Drafted the email')).toBeNull()
    expect(screen.getByText('Waiting for AC to approve it going out').closest('.todo-card-note')?.querySelector('time')).toHaveAttribute('datetime', '2026-09-15T15:28:00.000Z')
    await user.click(screen.getByRole('button', { name: 'Add a note to Send approval email' }))
    expect(onAddNote).toHaveBeenCalledWith(todo)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('offers the approved quick-snooze presets and sends an exact future timestamp', async () => {
    const user = userEvent.setup()
    const onSnooze = vi.fn()
    const todo = task({ id: 'task-1', title: 'Prepare launch notes' })
    render(<TodoCard todo={todo} now={() => new Date('2026-09-14T19:06:00.000Z')} onSnooze={onSnooze} />)

    await user.click(screen.getByRole('button', { name: 'Snooze Prepare launch notes' }))
    expect(screen.getByRole('menu', { name: 'Snooze Prepare launch notes' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: /In 1 hour/i })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: /This evening/i })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: /Tomorrow/i })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: /Next Monday/i })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Pick a date and time' })).toBeVisible()

    await user.click(screen.getByRole('menuitem', { name: /In 20 minutes/i }))
    expect(onSnooze).toHaveBeenCalledWith(todo, '2026-09-14T19:26:00.000Z')
    expect(screen.queryByRole('menu', { name: 'Snooze Prepare launch notes' })).toBeNull()
  })

  it.each([
    ['This evening', 2026, 8, 14, 18],
    ['Tomorrow', 2026, 8, 15, 9],
    ['Next Monday', 2026, 8, 21, 9],
  ] as const)('anchors %s to the approved local calendar time', async (label, year, month, day, hour) => {
    const user = userEvent.setup(), onSnooze = vi.fn()
    const todo = task({ id: `calendar-${label}`, title: 'Calendar anchor' })
    render(<TodoCard todo={todo} now={() => new Date(2026, 8, 14, 15, 6)} onSnooze={onSnooze} />)
    await user.click(screen.getByRole('button', { name: 'Snooze Calendar anchor' }))
    await user.click(screen.getByRole('menuitem', { name: new RegExp(label, 'i') }))
    const result = new Date(onSnooze.mock.calls[0][1])
    expect([result.getFullYear(), result.getMonth(), result.getDate(), result.getHours(), result.getMinutes()]).toEqual([year, month, day, hour, 0])
  })

  it.each([
    ['2026-10-05', 'A week before it\u2019s due', 2026, 8, 28],
    ['2026-09-19', 'Two days before it\u2019s due', 2026, 8, 17],
    ['2026-09-17', 'The day before it\u2019s due', 2026, 8, 16],
  ] as const)('offers a run-up snooze sized to the time left before %s', async (dueDate, label, year, month, day) => {
    const user = userEvent.setup(), onSnooze = vi.fn()
    const todo = task({ id: `run-up-${dueDate}`, title: 'Run up to the due date', dueDate })
    render(<TodoCard todo={todo} now={() => new Date(2026, 8, 14, 15, 6)} onSnooze={onSnooze} />)
    await user.click(screen.getByRole('button', { name: 'Snooze Run up to the due date' }))
    await user.click(screen.getByRole('menuitem', { name: new RegExp(label, 'i') }))
    const result = new Date(onSnooze.mock.calls[0][1])
    expect([result.getFullYear(), result.getMonth(), result.getDate(), result.getHours()]).toEqual([year, month, day, 9])
  })

  it('snoozes to the morning of the due date', async () => {
    const user = userEvent.setup(), onSnooze = vi.fn()
    const todo = task({ id: 'due-day', title: 'Land on the due date', dueDate: '2026-09-19' })
    render(<TodoCard todo={todo} now={() => new Date(2026, 8, 14, 15, 6)} onSnooze={onSnooze} />)
    await user.click(screen.getByRole('button', { name: 'Snooze Land on the due date' }))
    await user.click(screen.getByRole('menuitem', { name: /The day it\u2019s due/i }))
    expect(onSnooze).toHaveBeenCalledWith(todo, new Date(2026, 8, 19, 9, 0).toISOString())
  })

  it.each([
    ['tomorrow', '2026-09-15'],
    ['today', '2026-09-14'],
    ['in the past', '2026-09-10'],
  ] as const)('drops the run-up option when the task is due %s', async (_when, dueDate) => {
    const user = userEvent.setup()
    const todo = task({ id: `no-run-up-${dueDate}`, title: 'Too close to run up', dueDate })
    render(<TodoCard todo={todo} now={() => new Date(2026, 8, 14, 15, 6)} onSnooze={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Snooze Too close to run up' }))
    expect(screen.queryByRole('menuitem', { name: /before it\u2019s due/i })).toBeNull()
  })

  it('hides both due-date snoozes when nothing is due and when the due date has passed', async () => {
    const user = userEvent.setup()
    render(<TodoCard todo={task({ id: 'no-due', title: 'No due date', dueDate: null })} now={() => new Date(2026, 8, 14, 15, 6)} onSnooze={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Snooze No due date' }))
    expect(screen.queryByRole('menuitem', { name: /due/i })).toBeNull()
    cleanup()

    render(<TodoCard todo={task({ id: 'past-due', title: 'Overdue task', dueDate: '2026-09-10' })} now={() => new Date(2026, 8, 14, 15, 6)} onSnooze={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Snooze Overdue task' }))
    expect(screen.queryByRole('menuitem', { name: /due/i })).toBeNull()
  })

  it('accepts a custom local date and time from the snooze menu', async () => {
    const user = userEvent.setup(), onSnooze = vi.fn()
    const todo = task({ id: 'custom', title: 'Choose a custom time' })
    render(<TodoCard todo={todo} now={() => new Date(2026, 8, 14, 15, 6)} onSnooze={onSnooze} />)
    await user.click(screen.getByRole('button', { name: 'Snooze Choose a custom time' }))
    await user.click(screen.getByRole('button', { name: 'Pick a date and time' }))
    fireEvent.change(screen.getByLabelText('Custom snooze time'), { target: { value: '2026-09-18T11:30' } })
    await user.click(screen.getByRole('button', { name: 'Snooze until selected time' }))
    expect(onSnooze).toHaveBeenCalledWith(todo, new Date(2026, 8, 18, 11, 30).toISOString())
  })

  it('puts a reschedule shortcut on overdue cards only', async () => {
    const now = () => new Date(2026, 8, 14, 15, 6)
    const { unmount } = render(<TodoCard todo={task({ id: 'late', title: 'Overdue task', dueDate: '2026-09-10' })} now={now} onDueDate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Reschedule Overdue task' })).toBeVisible()
    unmount()

    render(<TodoCard todo={task({ id: 'today', title: 'Due today' })} now={now} onDueDate={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Reschedule Due today' })).toBeNull()
    cleanup()

    render(<TodoCard todo={task({ id: 'later', title: 'Due later', dueDate: '2026-09-20' })} now={now} onDueDate={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Reschedule Due later' })).toBeNull()
    cleanup()

    render(<TodoCard todo={task({ id: 'finished', title: 'Finished late', dueDate: '2026-09-10', status: 'done' })} now={now} onDueDate={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Reschedule Finished late' })).toBeNull()
  })

  it.each([
    ['Today', '2026-09-14'],
    ['Tomorrow', '2026-09-15'],
    ['Next week', '2026-09-21'],
  ] as const)('moves an overdue due date to %s', async (label, expected) => {
    const user = userEvent.setup(), onDueDate = vi.fn()
    const todo = task({ id: `move-${label}`, title: 'Overdue task', dueDate: '2026-09-10' })
    render(<TodoCard todo={todo} now={() => new Date(2026, 8, 14, 15, 6)} onDueDate={onDueDate} />)
    await user.click(screen.getByRole('button', { name: 'Reschedule Overdue task' }))
    expect(screen.getByRole('menu', { name: 'Reschedule Overdue task' })).toBeVisible()
    await user.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) }))
    expect(onDueDate).toHaveBeenCalledWith(todo, expected)
    expect(screen.queryByRole('menu', { name: 'Reschedule Overdue task' })).toBeNull()
  })

  it('reschedules from the overflow menu whether or not the task is overdue, including a custom date and removal', async () => {
    const user = userEvent.setup(), onDueDate = vi.fn()
    const todo = task({ id: 'overflow-due', title: 'Due later', dueDate: '2026-09-20' })
    render(<TodoCard todo={todo} now={() => new Date(2026, 8, 14, 15, 6)} onDueDate={onDueDate} />)

    await user.click(screen.getByRole('button', { name: 'More actions for Due later' }))
    await user.click(screen.getByRole('menuitem', { name: /^Due date…/ }))
    await user.click(screen.getByRole('menuitem', { name: /^Tomorrow/ }))
    expect(onDueDate).toHaveBeenCalledWith(todo, '2026-09-15')

    await user.click(screen.getByRole('button', { name: 'More actions for Due later' }))
    await user.click(screen.getByRole('menuitem', { name: /^Due date…/ }))
    await user.click(screen.getByRole('button', { name: 'Pick a due date' }))
    fireEvent.change(screen.getByLabelText('Custom due date'), { target: { value: '2026-10-02' } })
    await user.click(screen.getByRole('button', { name: 'Set due date' }))
    expect(onDueDate).toHaveBeenLastCalledWith(todo, '2026-10-02')

    await user.click(screen.getByRole('button', { name: 'More actions for Due later' }))
    await user.click(screen.getByRole('menuitem', { name: /^Due date…/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove due date' }))
    expect(onDueDate).toHaveBeenLastCalledWith(todo, null)
  })

  it('disables the option a task is already due on and hides removal when nothing is due', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<TodoCard todo={task({ id: 'already', title: 'Due tomorrow', dueDate: '2026-09-15' })} now={() => new Date(2026, 8, 14, 15, 6)} onDueDate={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'More actions for Due tomorrow' }))
    await user.click(screen.getByRole('menuitem', { name: /^Due date…/ }))
    expect(screen.getByRole('menuitem', { name: /^Tomorrow/ })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: /^Today/ })).toBeEnabled()
    unmount()

    render(<TodoCard todo={task({ id: 'none', title: 'No due date', dueDate: null })} now={() => new Date(2026, 8, 14, 15, 6)} onDueDate={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'More actions for No due date' }))
    await user.click(screen.getByRole('menuitem', { name: /^Due date…/ }))
    expect(screen.queryByRole('menuitem', { name: 'Remove due date' })).toBeNull()
  })

  it('routes move, priority, edit, and delete through the overflow menu', async () => {
    const user = userEvent.setup()
    const todo = task({ id: 'task-2', title: 'Review pricing' })
    const onMove = vi.fn(), onPriority = vi.fn(), onOpen = vi.fn(), onDelete = vi.fn()
    render(<TodoCard todo={todo} onMove={onMove} onPriority={onPriority} onOpen={onOpen} onDelete={onDelete} />)

    await user.click(screen.getByRole('button', { name: 'More actions for Review pricing' }))
    await user.click(screen.getByRole('menuitem', { name: /^Move…/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Move to Doing' }))
    expect(onMove).toHaveBeenCalledWith(todo, 'doing')

    await user.click(screen.getByRole('button', { name: 'More actions for Review pricing' }))
    await user.click(screen.getByRole('menuitem', { name: /^Priority/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Set priority to P1' }))
    expect(onPriority).toHaveBeenCalledWith(todo, 4)

    await user.click(screen.getByRole('button', { name: 'More actions for Review pricing' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit task' }))
    expect(onOpen).toHaveBeenCalledWith(todo)

    await user.click(screen.getByRole('button', { name: 'More actions for Review pricing' }))
    await user.click(screen.getByRole('menuitem', { name: 'Move task to recycle bin' }))
    expect(onDelete).toHaveBeenCalledWith(todo)
  })

  it('closes an open card menu with Escape', async () => {
    const user = userEvent.setup()
    render(<TodoCard todo={task({ id: 'task-3', title: 'Call venue' })} />)
    await user.click(screen.getByRole('button', { name: 'More actions for Call venue' }))
    expect(screen.getByRole('menu', { name: 'Actions for Call venue' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: 'Actions for Call venue' })).toBeNull()
  })
})

describe('not doing', () => {
  it('offers not doing as a way out of the overflow menu and reports it once', async () => {
    const user = userEvent.setup(), onNotDoing = vi.fn()
    const todo = task({ id: 'abandon', title: 'Read the changelog' })
    render(<TodoCard todo={todo} onNotDoing={onNotDoing} />)

    await user.click(screen.getByRole('button', { name: 'More actions for Read the changelog' }))
    await user.click(screen.getByRole('menuitem', { name: 'Not doing this' }))
    expect(onNotDoing).toHaveBeenCalledWith(todo)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('says so on the card and stops offering the option once it is taken', async () => {
    const user = userEvent.setup()
    const todo = task({ id: 'abandoned', title: 'Read the changelog', status: 'done', outcome: 'not_doing' })
    render(<TodoCard todo={todo} onNotDoing={vi.fn()} />)

    expect(screen.getByText('Not doing')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'More actions for Read the changelog' }))
    expect(screen.queryByRole('menuitem', { name: 'Not doing this' })).toBeNull()
  })

  it('leaves a completed task looking completed, not overdue', () => {
    const now = () => new Date(2026, 8, 16, 10, 0)
    const { unmount } = render(<TodoCard todo={task({ id: 'late', title: 'Late but open', dueDate: '2026-09-10' })} now={now} />)
    expect(screen.getByText('Sep 10').className).toContain('overdue')
    unmount()

    render(<TodoCard todo={task({ id: 'finished', title: 'Late but finished', dueDate: '2026-09-10', status: 'done', completedAt: '2026-09-16T09:00:00.000Z' })} now={now} />)
    const date = screen.getByText('Sep 10')
    expect(date.className).not.toContain('overdue')
    expect(date.className).not.toContain('today')
  })
})

describe('priority as urgency', () => {
  it.each([
    [4, '❗❗❗', 'P1'],
    [3, '❗❗', 'P2'],
    [2, '❗', 'P3'],
  ] as const)('marks stored priority %i with %s', (priority, marks, label) => {
    render(<TodoCard todo={task({ id: `p-${priority}`, title: 'Priority card', priority })} />)
    const badge = screen.getByLabelText(`${label} priority`)
    expect(badge).toHaveTextContent(marks)
    expect(badge).not.toHaveTextContent(/P[1-4]/)
  })

  it('leaves the quietest tasks unbadged, since most of the list is P4', () => {
    render(<TodoCard todo={task({ id: 'p4', title: 'No priority', priority: 1 })} />)
    expect(screen.queryByLabelText(/^P[1-4] priority$/)).toBeNull()
    expect(screen.queryByText('P4')).toBeNull()
  })

  it('still names the level where a name is what you need', async () => {
    const user = userEvent.setup()
    render(<TodoCard todo={task({ id: 'named', title: 'Priority card', priority: 4 })} onPriority={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'More actions for Priority card' }))
    await user.click(screen.getByRole('menuitem', { name: /^Priority…/ }))
    expect(screen.getByRole('menuitem', { name: 'Set priority to P3' })).toBeVisible()
  })
})
