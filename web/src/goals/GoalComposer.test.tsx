import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import GoalComposer from './GoalComposer'
import type { GoalOptions } from './types'

afterEach(cleanup)

const OPTIONS: GoalOptions = {
  periods: [],
  units: { Distance: ['miles', 'km'], Learning: ['chapters'] },
  allUnits: ['miles', 'km', 'chapters'],
  sources: ['manual', 'strava_distance', 'strava_gear_odometer'],
  measures: ['distanceMi', 'distanceKm'],
}

describe('goal composer', () => {
  it('opens as a dialog and offers monthly and yearly periods', () => {
    render(<GoalComposer options={null} period="this_week" busy={false} onCancel={() => {}} onCreate={() => {}} />)

    expect(screen.getByRole('dialog', { name: 'New goal' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'This month' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'Next month' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'This year' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'Next year' })).toBeVisible()
  })

  it('submits the selected yearly period', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    render(<GoalComposer options={null} period="this_month" busy={false} onCancel={() => {}} onCreate={onCreate} />)

    await user.type(screen.getByLabelText('Goal title'), 'Finish the annual plan')
    await user.selectOptions(screen.getByLabelText('Goal period'), 'this_year')
    await user.click(screen.getByRole('button', { name: 'Add goal' }))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Finish the annual plan',
      period: 'this_year',
    }))
  })

  it('defaults what to count to the goal title, and keeps following it until edited', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    render(<GoalComposer options={OPTIONS} period="this_week" busy={false} onCancel={() => {}} onCreate={onCreate} />)

    await user.type(screen.getByLabelText('Goal title'), '50 Miles Biked')
    await user.click(screen.getByRole('button', { name: 'Track a number' }))
    expect(screen.getByLabelText('Metric label')).toHaveValue('50 Miles Biked')

    // Still mirroring, because the title is usually still being edited at this point.
    await user.type(screen.getByLabelText('Goal title'), ' This Week')
    expect(screen.getByLabelText('Metric label')).toHaveValue('50 Miles Biked This Week')

    await user.type(screen.getByLabelText('Target'), '50')
    await user.click(screen.getByRole('button', { name: 'Add goal' }))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      metrics: [expect.objectContaining({ label: '50 Miles Biked This Week' })],
    }))
  })

  it('stops mirroring the title once the label is typed in', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    render(<GoalComposer options={OPTIONS} period="this_week" busy={false} onCancel={() => {}} onCreate={onCreate} />)

    await user.type(screen.getByLabelText('Goal title'), 'Get fit')
    await user.click(screen.getByRole('button', { name: 'Track a number' }))
    await user.clear(screen.getByLabelText('Metric label'))
    await user.type(screen.getByLabelText('Metric label'), 'Miles run')
    await user.type(screen.getByLabelText('Goal title'), ' this year')

    expect(screen.getByLabelText('Metric label')).toHaveValue('Miles run')
    await user.type(screen.getByLabelText('Target'), '100')
    await user.click(screen.getByRole('button', { name: 'Add goal' }))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      metrics: [expect.objectContaining({ label: 'Miles run' })],
    }))
  })

  it('offers units as a grouped dropdown with a free-text escape hatch', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    render(<GoalComposer options={OPTIONS} period="this_week" busy={false} onCancel={() => {}} onCreate={onCreate} />)

    await user.type(screen.getByLabelText('Goal title'), 'Read more')
    await user.click(screen.getByRole('button', { name: 'Track a number' }))

    const unit = screen.getByLabelText('Unit')
    expect(screen.getByRole('option', { name: 'miles' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'chapters' })).toBeVisible()

    // The suggestions are not an enum — goals/units.mjs takes anything — so the form
    // must not turn them into one.
    await user.selectOptions(unit, '__other')
    await user.type(screen.getByLabelText('Custom unit'), 'podcasts')
    await user.type(screen.getByLabelText('Target'), '12')
    await user.click(screen.getByRole('button', { name: 'Add goal' }))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      metrics: [expect.objectContaining({ unit: 'podcasts' })],
    }))
  })

  it('picks the sport from an icon list and reads the Strava measure off the unit', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    render(<GoalComposer options={OPTIONS} period="this_week" busy={false} onCancel={() => {}} onCreate={onCreate} />)

    await user.type(screen.getByLabelText('Goal title'), '200 km biked')
    await user.click(screen.getByRole('button', { name: 'Track a number' }))
    await user.selectOptions(screen.getByLabelText('Where the number comes from'), 'strava_distance')

    // A Strava metric with no unit would be scored in miles by the server's default,
    // so the composer names that default rather than leaving it implied.
    expect(screen.getByLabelText('Unit')).toHaveValue('miles')
    await user.selectOptions(screen.getByLabelText('Unit'), 'km')

    await user.click(screen.getByRole('combobox', { name: 'Sport' }))
    await user.click(screen.getByRole('option', { name: 'Cycling' }))
    expect(screen.getByRole('combobox', { name: 'Sport' })).toHaveTextContent('Cycling')

    await user.type(screen.getByLabelText('Target'), '200')
    await user.click(screen.getByRole('button', { name: 'Add goal' }))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      metrics: [expect.objectContaining({
        unit: 'km',
        sourceKind: 'strava_distance',
        sourceConfig: { sport: 'ride', measure: 'distanceKm' },
      })],
    }))
  })
})
