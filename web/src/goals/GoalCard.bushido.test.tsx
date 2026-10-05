/*
 * The Bushido toggle on a goal card.
 *
 * Bushido reads Totem's goals and shows the ones linked to it, so this button is
 * the whole of the "show it there" gesture — and the thing worth testing is that
 * it reports the EXISTING link when there is one. Getting that backwards produces
 * a button that links a second time instead of unlinking, which looks like it did
 * nothing and quietly accumulates duplicates.
 */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import GoalCard, { BushidoMark } from './GoalCard'
import type { Goal, GoalLink } from './types'

const goal = (links: GoalLink[]): Goal => ({
  id: 'g1', clientKey: null, title: '50 Miles Biked', notes: '',
  period: { type: 'week', start: '2026-09-13', end: '2026-09-19', key: '2026-09-13', label: 'Sep 13 – 19, 2026' },
  periodState: 'active', daysLeft: 5, completedAt: null, abandonedAt: null, abandoned: false, complete: false,
  postponedCount: 0, position: 0,
  createdAt: '2026-09-15T17:48:51.358Z', updatedAt: '2026-09-15T17:48:51.358Z',
  metrics: [], subGoals: [], links,
  progress: { fraction: 0.58, percent: 58, subGoalsDone: 0, subGoalsTotal: 0, subGoalsAbandoned: 0, complete: false },
})

const bushido: GoalLink = {
  id: 'link-1', kind: 'url', label: 'Bushido',
  url: 'https://bushido.example.com', todoId: null, todo: null, position: 0,
}

// What /api/app/config hands over when BUSHIDO_URL and BUSHIDO_LEGACY_HOSTS are set.
const HOSTS = ['bushido.example.com', 'pulse.example.com']

const props = {
  bushidoHosts: HOSTS,
  busy: false, onToggle: () => {}, onToggleStep: () => {}, onLog: () => {},
  onPostpone: () => {}, onDelete: () => {}, onAddStep: () => {},
}

/** The toggle lives in the card's overflow menu, with every other action. */
const openMenu = () => userEvent.click(screen.getByRole('button', { name: /^More actions for/ }))

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('the Bushido toggle', () => {
  it('reports no existing link when the goal is not in Bushido', async () => {
    const onToggleBushido = vi.fn()
    render(<GoalCard {...props} goal={goal([])} onToggleBushido={onToggleBushido} />)

    expect(screen.queryByText('Bushido')).toBeNull()
    await openMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Show in Bushido' }))
    expect(onToggleBushido).toHaveBeenCalledWith(null)
  })

  it('hands back the link itself when it is already there, so the caller can unlink it', async () => {
    const onToggleBushido = vi.fn()
    render(<GoalCard {...props} goal={goal([bushido])} onToggleBushido={onToggleBushido} />)

    // Linked is a state, so it reads as a chip whether or not the menu is open.
    expect(screen.getByText('Bushido')).toBeVisible()
    await openMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove from Bushido' }))
    expect(onToggleBushido).toHaveBeenCalledWith(expect.objectContaining({ id: 'link-1' }))
  })

  it('matches on the host, so an old name or a path still counts as linked', async () => {
    // Back-compat: links saved before the 2026-10-02 rename hold an earlier host,
    // and a strict string match would silently unlink every one of those goals.
    render(<GoalCard {...props} onToggleBushido={() => {}}
      goal={goal([{ ...bushido, url: 'https://pulse.example.com/goals' }])} />)
    await openMenu()
    expect(screen.getByRole('menuitem', { name: 'Remove from Bushido' })).toBeVisible()
  })

  it('does not list the Bushido link again as a bookmark', () => {
    // It is already a chip in the header. Twice is the same fact in two shapes.
    render(<GoalCard {...props} goal={goal([bushido])} onToggleBushido={() => {}} />)
    expect(screen.queryByRole('link', { name: /Bushido/ })).toBeNull()
  })

  it('still lists other links as bookmarks', () => {
    render(<GoalCard {...props} onToggleBushido={() => {}}
      goal={goal([bushido, { ...bushido, id: 'link-2', label: 'Strava', url: 'https://strava.com/x' }])} />)
    expect(screen.getByRole('link', { name: 'Strava' })).toBeVisible()
  })

  it('wears Bushido\'s own ECG mark, not a stock glyph', () => {
    // Traced off the app's favicon. Asserted on the path data because that is the
    // only part that makes it Bushido's mark rather than any heart-shaped stand-in —
    // and the tail ending above the baseline (8.47 < 12.32) is the trace's point.
    const { container } = render(
      <BushidoMark />, { container: document.body.appendChild(document.createElement('div')) })
    const d = container.querySelector('path')?.getAttribute('d') ?? ''
    expect(d).toBe('M2.5 12.32 H8.15 L9.82 6.54 L12.13 17.46 L14.05 10.78 H15.85 L17.65 8.47 H21.5')

    const chip = render(<GoalCard {...props} goal={goal([bushido])} onToggleBushido={() => {}} />)
    expect(chip.container.querySelector('.goal-chip.bushido path')).toHaveAttribute('d', d)
  })

  it('offers nothing at all when the caller does not handle it', async () => {
    render(<GoalCard {...props} goal={goal([])} />)
    await openMenu()
    expect(screen.queryByRole('menuitem', { name: /Bushido/ })).toBeNull()
  })

  it('shows no chip when Bushido is not configured, even for an old link', () => {
    // A fresh install has no BUSHIDO_URL: the sibling app is optional, so a link
    // that happens to point at it is just an ordinary bookmark.
    render(<GoalCard {...props} bushidoHosts={[]} goal={goal([bushido])} />)
    expect(screen.queryByTitle('Showing in Bushido')).toBeNull()
    expect(screen.getByRole('link', { name: 'Bushido' })).toBeVisible()
  })
})
