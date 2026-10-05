/*
 * The overflow menu on a goal card.
 *
 * Deleting a goal used to be a red button present on every card at all times, which
 * is backwards: it is the action you want least often and the one you can least
 * afford to hit by accident. These tests hold the shape that replaced it — nothing
 * destructive on show, and editing reachable at all, which it previously was not.
 */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import GoalCard from './GoalCard'
import type { Goal } from './types'

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g1', clientKey: null, title: 'Lift twice at L.A. Fitness', notes: 'upper and lower',
  period: { type: 'week', start: '2026-09-13', end: '2026-09-19', key: '2026-09-13', label: 'Sep 13 – 19, 2026' },
  periodState: 'active', daysLeft: 5, completedAt: null, abandonedAt: null, abandoned: false, complete: false,
  postponedCount: 0, position: 0,
  createdAt: '2026-09-15T17:48:51.358Z', updatedAt: '2026-09-15T17:48:51.358Z',
  metrics: [], subGoals: [], links: [],
  progress: { fraction: 0, percent: 0, subGoalsDone: 0, subGoalsTotal: 0, subGoalsAbandoned: 0, complete: false },
  ...over,
})

function card(over: Partial<Goal> = {}, handlers: Record<string, unknown> = {}) {
  return render(<GoalCard
    goal={goal(over)} busy={false}
    onToggle={vi.fn()} onToggleStep={vi.fn()} onLog={vi.fn()} onPostpone={vi.fn()}
    onDelete={vi.fn()} onAddStep={vi.fn()} {...handlers}
  />)
}

afterEach(cleanup)

describe('goal card actions', () => {
  it('keeps delete out of sight until the menu is opened', async () => {
    const user = userEvent.setup()
    card({}, { onEdit: vi.fn(), onAbandon: vi.fn() })

    expect(screen.queryByRole('menuitem', { name: 'Delete goal' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'More actions for Lift twice at L.A. Fitness' }))
    expect(screen.getByRole('menuitem', { name: 'Delete goal' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: 'Edit goal' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: 'Not doing this' })).toBeVisible()
  })

  it('edits the title and notes in place and reports both', async () => {
    const user = userEvent.setup(), onEdit = vi.fn()
    card({}, { onEdit, onAbandon: vi.fn() })

    await user.click(screen.getByRole('button', { name: 'More actions for Lift twice at L.A. Fitness' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit goal' }))

    const title = screen.getByLabelText('Goal title')
    expect(title).toHaveValue('Lift twice at L.A. Fitness')
    await user.clear(title)
    await user.type(title, 'Lift three times')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onEdit).toHaveBeenCalledWith({ title: 'Lift three times', notes: 'upper and lower' })
    expect(screen.queryByLabelText('Goal title')).toBeNull()
  })

  it('abandons an edit on Cancel, leaving the goal as it was', async () => {
    const user = userEvent.setup(), onEdit = vi.fn()
    card({}, { onEdit })

    await user.click(screen.getByRole('button', { name: 'More actions for Lift twice at L.A. Fitness' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit goal' }))
    await user.type(screen.getByLabelText('Goal title'), ' and again')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Lift twice at L.A. Fitness' })).toBeVisible()
  })

  it('refuses to save a goal with no title left', async () => {
    const user = userEvent.setup(), onEdit = vi.fn()
    card({}, { onEdit })

    await user.click(screen.getByRole('button', { name: 'More actions for Lift twice at L.A. Fitness' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit goal' }))
    await user.clear(screen.getByLabelText('Goal title'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('marks a goal as not doing, and offers the way back once it is', async () => {
    const user = userEvent.setup(), onAbandon = vi.fn()
    const { unmount } = card({}, { onAbandon })
    await user.click(screen.getByRole('button', { name: 'More actions for Lift twice at L.A. Fitness' }))
    await user.click(screen.getByRole('menuitem', { name: 'Not doing this' }))
    expect(onAbandon).toHaveBeenCalledWith(true)
    unmount()

    card({ abandoned: true, abandonedAt: '2026-09-16T10:00:00.000Z' }, { onAbandon })
    expect(screen.getByText('not doing')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'More actions for Lift twice at L.A. Fitness' }))
    await user.click(screen.getByRole('menuitem', { name: 'Start doing this again' }))
    expect(onAbandon).toHaveBeenLastCalledWith(false)
  })

  it('closes the menu on Escape', async () => {
    const user = userEvent.setup()
    card({}, { onEdit: vi.fn() })

    await user.click(screen.getByRole('button', { name: 'More actions for Lift twice at L.A. Fitness' }))
    expect(screen.getByRole('menu')).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('offers only what the caller wired up', async () => {
    const user = userEvent.setup()
    card()

    await user.click(screen.getByRole('button', { name: 'More actions for Lift twice at L.A. Fitness' }))
    expect(screen.queryByRole('menuitem', { name: 'Edit goal' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Not doing this' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Delete goal' })).toBeVisible()
  })
})

describe('the card carries no loose buttons', () => {
  it('keeps step and move on in the menu, and shows their controls only once chosen', async () => {
    const user = userEvent.setup(), onAddStep = vi.fn(), onPostpone = vi.fn()
    card({}, { onAddStep, onPostpone })

    expect(screen.queryByRole('button', { name: /^Step$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Move on' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'More actions for Lift twice at L.A. Fitness' }))
    await user.click(screen.getByRole('menuitem', { name: 'Add a step' }))
    await user.type(screen.getByLabelText('New step'), 'Upper body{Enter}')
    expect(onAddStep).toHaveBeenCalledWith('Upper body')

    await user.click(screen.getByRole('button', { name: 'More actions for Lift twice at L.A. Fitness' }))
    await user.click(screen.getByRole('menuitem', { name: 'Move to the next week' }))
    // Still confirmed: the postponed count is a record of a decision.
    expect(screen.getByText('Move to the next week?')).toBeVisible()
    await user.click(screen.getByRole('button', { name: /^Move/ }))
    expect(onPostpone).toHaveBeenCalled()
  })

  it('puts the percentage at the end of the bar and the check where it used to be', () => {
    const { container } = card({
      metrics: [{
        id: 'm1', label: 'Miles Biked', unit: 'miles', targetValue: 50, value: 30.9,
        percent: 62, sourceKind: 'strava_distance', sourceLabel: 'Strava, Rides in this period',
        available: true, unavailableReason: null, rolledUpValue: 0, feederCount: 0,
        unreadableFeederCount: 0, rollsUpToMetricId: null,
      }] as Goal['metrics'],
      progress: { fraction: 0.62, percent: 62, subGoalsDone: 0, subGoalsTotal: 0, subGoalsAbandoned: 0, complete: false },
    })

    // The number sits in the bar's own row, not in the header beside the title.
    const row = container.querySelector('.goal-bar-row')
    expect(row?.querySelector('.goal-percent')?.textContent).toBe('62%')
    expect(container.querySelector('.goal-card-head .goal-percent')).toBeNull()
    // And the check has moved to the header's right-hand tools.
    expect(container.querySelector('.goal-card-tools .goal-check.big')).not.toBeNull()
  })

  it('gives a goal with several numbers a bar of its own rather than borrowing one', () => {
    const metric = (id: string, percent: number) => ({
      id, label: id, unit: 'miles', targetValue: 10, value: percent / 10, percent,
      sourceKind: 'manual', sourceLabel: null, available: true, unavailableReason: null,
      rolledUpValue: 0, feederCount: 0, unreadableFeederCount: 0, rollsUpToMetricId: null,
    })
    const { container } = card({
      metrics: [metric('one', 20), metric('two', 80)] as Goal['metrics'],
      progress: { fraction: 0.5, percent: 50, subGoalsDone: 0, subGoalsTotal: 0, subGoalsAbandoned: 0, complete: false },
    })

    expect(container.querySelector('.goal-total .goal-percent')?.textContent).toBe('50%')
    expect(container.querySelectorAll('.goal-percent')).toHaveLength(1)
  })
})

describe('notes on a goal', () => {
  it('opens a note box straight from the menu, without walking past the title', async () => {
    const user = userEvent.setup(), onEdit = vi.fn()
    card({ notes: '' }, { onEdit })

    await user.click(screen.getByRole('button', { name: 'More actions for Lift twice at L.A. Fitness' }))
    await user.click(screen.getByRole('menuitem', { name: 'Add a note' }))

    expect(screen.queryByLabelText('Goal title')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Lift twice at L.A. Fitness' })).toBeVisible()
    await user.type(screen.getByLabelText('Goal note'), 'Skipped Thursday, knee')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onEdit).toHaveBeenCalledWith({ title: 'Lift twice at L.A. Fitness', notes: 'Skipped Thursday, knee' })
  })

  it('offers to edit the note it already has, opened with that text', async () => {
    const user = userEvent.setup(), onEdit = vi.fn()
    card({ notes: 'upper and lower' }, { onEdit })

    expect(screen.getByText('upper and lower')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'More actions for Lift twice at L.A. Fitness' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit note' }))

    const note = screen.getByLabelText('Goal note')
    expect(note).toHaveValue('upper and lower')
    await user.type(note, ' — and a swim')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onEdit).toHaveBeenCalledWith({ title: 'Lift twice at L.A. Fitness', notes: 'upper and lower — and a swim' })
  })

  it('keeps Enter for newlines in a note rather than saving on it', async () => {
    const user = userEvent.setup(), onEdit = vi.fn()
    card({ notes: '' }, { onEdit })

    await user.click(screen.getByRole('button', { name: 'More actions for Lift twice at L.A. Fitness' }))
    await user.click(screen.getByRole('menuitem', { name: 'Add a note' }))
    await user.type(screen.getByLabelText('Goal note'), 'one{Enter}two')

    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Goal note')).toHaveValue('one\ntwo')
  })
})
