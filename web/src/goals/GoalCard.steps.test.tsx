/*
 * A step you are not going to get to.
 *
 * The case: "follow up with Riley" happened, and a step hanging off it was an add-on —
 * something he'd have done if the week had gone differently, and now definitely won't.
 * Ticking it would claim work that never happened. Deleting it would lose the fact that
 * it was ever on the list. Leaving it open would hold the goal under 100% forever over
 * something already decided.
 *
 * So there is a third state, and these tests hold its two rules: it crosses the step out
 * WITHOUT removing it, and it takes the step out of the count rather than into the done
 * half of it. The colours live in styles.css; the class and the count are the contract.
 */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import GoalCard from './GoalCard'
import type { Goal, SubGoal } from './types'

const step = (over: Partial<SubGoal> = {}): SubGoal => ({
  id: 's1', parentId: 'g1', title: 'Send the deck as well', notes: '',
  completedAt: null, complete: false, abandonedAt: null, abandoned: false,
  position: 0, metrics: [], progress: { fraction: 0, percent: 0 },
  ...over,
})

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g1', clientKey: null, title: 'Follow up with Riley', notes: '',
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

const row = () => document.querySelector('.goal-step') as HTMLElement

afterEach(cleanup)

describe('a step that is not getting done', () => {
  it('can be stopped on its own, without touching the goal', async () => {
    const user = userEvent.setup(), onAbandonStep = vi.fn()
    card({ subGoals: [step()] }, { onAbandonStep })

    await user.click(screen.getByRole('button', { name: 'Not doing Send the deck as well' }))
    expect(onAbandonStep).toHaveBeenCalledWith('s1', true)
  })

  it('stays on the card, crossed off, rather than disappearing', () => {
    card({ subGoals: [step({ abandoned: true, abandonedAt: '2026-09-17T13:00:00.000Z' })] })
    expect(screen.getByText('Send the deck as well')).toBeVisible()
    expect(row().className).toContain('not-doing')
    expect(row().className).not.toContain('done')
  })

  it('offers to put it back, and keeps its tick either way', async () => {
    const user = userEvent.setup(), onAbandonStep = vi.fn(), onToggleStep = vi.fn()
    card({ subGoals: [step({ abandoned: true })] }, { onAbandonStep, onToggleStep })

    // Changing your mind and actually doing it is one click, not un-stop-then-tick.
    await user.click(screen.getByRole('button', { name: 'Mark Send the deck as well done' }))
    expect(onToggleStep).toHaveBeenCalledWith('s1', true)

    await user.click(screen.getByRole('button', { name: 'Start Send the deck as well again' }))
    expect(onAbandonStep).toHaveBeenCalledWith('s1', false)
  })

  it('is counted apart from the steps still in play', () => {
    card({
      subGoals: [step({ id: 'a', title: 'Call him', complete: true }), step({ id: 'b', abandoned: true })],
      progress: { fraction: 1, percent: 100, subGoalsDone: 1, subGoalsTotal: 1, subGoalsAbandoned: 1, complete: false },
    })
    // Not "1/2 steps": the goal landed, and the half it did not do was a decision.
    expect(screen.getByText('1/1 steps')).toBeVisible()
    expect(screen.getByText('1 step not doing')).toBeVisible()
  })

  it('offers nothing to press when the view has not wired it up', () => {
    card({ subGoals: [step()] })
    expect(screen.queryByRole('button', { name: /Not doing/ })).toBeNull()
  })
})

describe('renaming a step', () => {
  it('saves the new title on Enter', async () => {
    const user = userEvent.setup(), onRenameStep = vi.fn()
    card({ subGoals: [step()] }, { onRenameStep })

    await user.click(screen.getByRole('button', { name: 'Rename Send the deck as well' }))
    const input = screen.getByRole('textbox', { name: 'Rename Send the deck as well' })
    await user.clear(input)
    await user.type(input, 'Send the deck and the notes{Enter}')
    expect(onRenameStep).toHaveBeenCalledWith('s1', 'Send the deck and the notes')
  })

  it('writes nothing when Escape backs out or the title is unchanged', async () => {
    const user = userEvent.setup(), onRenameStep = vi.fn()
    card({ subGoals: [step()] }, { onRenameStep })

    await user.click(screen.getByRole('button', { name: 'Rename Send the deck as well' }))
    await user.type(screen.getByRole('textbox'), ' twice{Escape}')
    expect(screen.queryByRole('textbox')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Rename Send the deck as well' }))
    await user.type(screen.getByRole('textbox'), '{Enter}')
    expect(onRenameStep).not.toHaveBeenCalled()
  })

  it('offers no rename without a handler', () => {
    card({ subGoals: [step()] })
    expect(screen.queryByRole('button', { name: /^Rename/ })).toBeNull()
  })
})
