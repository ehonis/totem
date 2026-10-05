/*
 * What a finished goal looks like.
 *
 * The rule under these tests is one sentence: a goal you completed is an
 * accomplishment, not a resolved item. So the card must never render it the way a
 * list renders things it wants out of the way — and it must say what happened in
 * words, because the strikethrough that used to say it is gone on purpose.
 *
 * The colours and the glow live in styles.css and are not asserted here; the class
 * and the chip are the contract that stylesheet hangs off.
 */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import GoalCard from './GoalCard'
import type { Goal } from './types'

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g1', clientKey: null, title: '50 Miles Biked', notes: '',
  period: { type: 'week', start: '2026-09-13', end: '2026-09-19', key: '2026-09-13', label: 'Sep 13 – 19, 2026' },
  periodState: 'active', daysLeft: 5, completedAt: null, abandonedAt: null, abandoned: false, complete: false,
  postponedCount: 0, position: 0,
  createdAt: '2026-09-15T17:48:51.358Z', updatedAt: '2026-09-15T17:48:51.358Z',
  metrics: [], subGoals: [], links: [],
  progress: { fraction: 1, percent: 100, subGoalsDone: 0, subGoalsTotal: 0, subGoalsAbandoned: 0, complete: false },
  ...over,
})

const props = {
  busy: false, onToggle: () => {}, onToggleStep: () => {}, onLog: () => {},
  onPostpone: () => {}, onDelete: () => {}, onAddStep: () => {},
}

const card = () => document.querySelector('.goal-card') as HTMLElement

afterEach(cleanup)

describe('a completed goal', () => {
  it('says it was achieved, and when', () => {
    render(<GoalCard {...props} goal={goal({ complete: true, completedAt: '2026-09-16T14:02:00.000Z' })} />)
    // The date is formatted in the browser's locale, so the day is the assertable part.
    expect(screen.getByText(/^Achieved /)).toBeVisible()
    expect(screen.getByText(/16/)).toBeVisible()
  })

  it('still says achieved when the server has no timestamp for it', () => {
    render(<GoalCard {...props} goal={goal({ complete: true })} />)
    expect(screen.getByText('Achieved')).toBeVisible()
  })

  it('is not expired, whenever its week ended', () => {
    // Late is a thing that can happen to a goal you didn't finish. Finishing it in a
    // window that has since closed is still finishing it.
    render(<GoalCard {...props} goal={goal({ complete: true, periodState: 'expired' })} />)
    expect(screen.queryByText('expired')).toBeNull()
    expect(screen.getByText(/^Achieved/)).toBeVisible()
  })

  it('an unfinished goal in a closed window still says expired', () => {
    render(<GoalCard {...props} goal={goal({ periodState: 'expired' })} />)
    expect(screen.getByText('expired')).toBeVisible()
  })

  it('celebrates the moment it lands, not every time the page loads', () => {
    // A week with six finished goals would otherwise set the whole page off on every
    // render, which turns the flourish into wallpaper.
    const { rerender } = render(<GoalCard {...props} goal={goal({ complete: true })} />)
    expect(card().className).not.toContain('celebrate')

    rerender(<GoalCard {...props} goal={goal({ complete: false })} />)
    expect(card().className).not.toContain('celebrate')

    rerender(<GoalCard {...props} goal={goal({ complete: true })} />)
    expect(card().className).toContain('celebrate')
  })
})
