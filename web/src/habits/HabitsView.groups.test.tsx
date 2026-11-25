/*
 * Sub-habits on the Habits page: a group is one card with its sub-habits inside,
 * counts as one row in the Today card, and its check marks every hand-logged
 * sub-habit (logged as `complete`, never a delta), with an Undo that puts the day
 * back exactly.
 */
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const TODAY = '2026-11-25'
const habit = (id: string, extra: any = {}) => ({
  id, name: id, description: '', color: '#5b8cff', cadence: 'daily', target: 1, metric: null,
  when: 'any', linkedApp: null, parentId: null, createdAt: '2026-01-01T00:00:00Z', archived: false, ...extra,
})
const payload = (entries: any = {}) => ({
  today: TODAY,
  palette: ['#5b8cff'],
  checkin: { lastShown: TODAY },
  habits: [
    habit('night', { name: 'Nightly routine' }),
    habit('stretch', { name: 'Stretch', parentId: 'night' }),
    habit('screens', { name: 'No screens', parentId: 'night' }),
    habit('read', { name: 'Read' }),
  ],
  entries,
})

const api = vi.hoisted(() => ({
  getHabits: vi.fn(),
  logHabit: vi.fn(),
}))
vi.mock('../api', async (orig) => ({
  ...(await orig<any>()),
  getHabits: api.getHabits,
  logHabit: api.logHabit,
}))
const toasts = vi.hoisted(() => ({ pushToast: vi.fn() }))
vi.mock('../toast', async (orig) => ({ ...(await orig<any>()), pushToast: toasts.pushToast }))

import HabitsView from '../components/HabitsView'

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Habits page with a group', () => {
  it('draws the group as one row holding its sub-habits', async () => {
    api.getHabits.mockResolvedValue(payload({ [TODAY]: { screens: { count: 1 } } }))
    render(<HabitsView onAuthError={() => {}} />)
    const group = await screen.findByRole('group', { name: 'Nightly routine: sub-habits' })
    expect(within(group).getByRole('button', { name: /^Stretch,/ })).toBeTruthy()
    expect(within(group).getByRole('button', { name: /^No screens,/ })).toBeTruthy()
    // Two rows (the group and Read), none done yet.
    expect(screen.getByRole('progressbar', { name: '0 of 2 habits done' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mark all of Nightly routine done, 1 of 2 so far' })).toBeTruthy()
  })

  it('marks the group done with one write, and Undo restores the sub-habits exactly', async () => {
    api.getHabits.mockResolvedValue(payload({ [TODAY]: { screens: { count: 1 } } }))
    api.logHabit.mockResolvedValue(payload({ [TODAY]: { screens: { count: 1 }, stretch: { count: 1 } } }))
    render(<HabitsView onAuthError={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /^Mark all of Nightly routine/ }))
    expect(api.logHabit).toHaveBeenCalledWith({ id: 'night', date: TODAY, complete: true })
    expect(await screen.findByRole('progressbar', { name: '1 of 2 habits done' })).toBeTruthy()
    const [, , options] = toasts.pushToast.mock.calls[toasts.pushToast.mock.calls.length - 1]
    options.action.onClick()
    expect(api.logHabit).toHaveBeenLastCalledWith({ id: 'night', date: TODAY, counts: { stretch: 0, screens: 1 } })
  })
})
