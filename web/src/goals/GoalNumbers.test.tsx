/*
 * Editing the numbers on a goal that already exists.
 *
 * Two things these hold that are easy to lose. A goal may track more than one number,
 * and always could at creation — but until now not afterwards, so "add a second number"
 * meant deleting the goal. And the editor saves a DIFF: a metric nobody touched must
 * produce no request at all, because sending the form back would rewrite a sport filter
 * the picker cannot express into the family it merely resembles.
 */
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import GoalCard from './GoalCard'
import GoalNumbers from './GoalNumbers'
import type { Goal, GoalMetric, GoalOptions } from './types'

afterEach(cleanup)

const OPTIONS: GoalOptions = {
  periods: [],
  units: { Distance: ['miles', 'km'], Time: ['minutes'] },
  allUnits: ['miles', 'km', 'minutes'],
  sources: ['manual', 'strava_distance', 'strava_gear_odometer'],
  measures: ['distanceMi', 'distanceKm'],
  sports: ['ride', 'run'],
  // The real map from strava/shape.mjs, trimmed: what makes "Run" resolve to Running.
  sportFamilies: { ride: ['Ride', 'GravelRide'], run: ['Run', 'TrailRun', 'VirtualRun'] },
}

const metric = (over: Partial<GoalMetric> = {}): GoalMetric => ({
  id: 'm1', goalId: 'g1', label: 'Miles Run', unit: 'miles', targetValue: 50,
  ownValue: 0, rolledUpValue: 0, value: 12, fraction: 0.24, percent: 24,
  rollsUpToMetricId: null, feederCount: 0, unreadableFeederCount: 0,
  sourceKind: 'strava_distance', sourceConfig: { sport: 'Run', measure: 'distanceMi' },
  sourceLabel: 'Strava, runs in this period', available: true, unavailableReason: null,
  readAt: null, position: 0,
  ...over,
})

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g1', clientKey: null, title: '50 Miles Ran', notes: '',
  period: { type: 'week', start: '2026-09-13', end: '2026-09-19', key: '2026-09-13', label: 'Sep 13 – 19, 2026' },
  periodState: 'active', daysLeft: 3, completedAt: null, abandonedAt: null, abandoned: false, complete: false,
  postponedCount: 0, position: 0,
  createdAt: '2026-09-15T17:48:51.358Z', updatedAt: '2026-09-15T17:48:51.358Z',
  metrics: [metric()], subGoals: [], links: [],
  progress: { fraction: 0.24, percent: 24, subGoalsDone: 0, subGoalsTotal: 0, subGoalsAbandoned: 0, complete: false },
  ...over,
})

function editor(over: Partial<Goal> = {}, onSave = vi.fn()) {
  render(<GoalNumbers goal={goal(over)} options={OPTIONS} busy={false} onCancel={vi.fn()} onSave={onSave} />)
  return onSave
}

const numbered = (n: number) => screen.getByRole('group', { name: `Number ${n}` })

describe('editing the numbers on an existing goal', () => {
  it('opens with what is already stored, filled in', () => {
    editor()

    expect(screen.getByRole('dialog', { name: 'Numbers' })).toBeVisible()
    expect(screen.getByLabelText('Metric label')).toHaveValue('Miles Run')
    expect(screen.getByLabelText('Target')).toHaveValue(50)
    expect(screen.getByLabelText('Unit')).toHaveValue('miles')
    expect(screen.getByLabelText('Where the number comes from')).toHaveValue('strava_distance')
  })

  /*
   * The goals in the database were created by an agent and store the exact sport_type
   * "Run", not the family "run". Both count a trail run — matchesSport resolves the
   * family — but a picker that showed this as "Any sport" would be describing a filter
   * that isn't there, and the next save would make the description true.
   */
  it('shows a metric stored against an exact sport type under its family', () => {
    editor()
    expect(screen.getByRole('combobox', { name: 'Sport' })).toHaveTextContent('Running')
  })

  it('says a sport counts every workout type in it, which is the whole point of a family', () => {
    editor()
    expect(screen.getByText(/across every workout type in that sport/)).toBeVisible()
  })

  it('sends nothing for a metric nobody touched', async () => {
    const user = userEvent.setup()
    const onSave = editor()

    await user.click(screen.getByRole('button', { name: 'Save numbers' }))
    expect(onSave).toHaveBeenCalledWith({ added: [], updated: [], removed: [] })
  })

  it('patches only the fields that moved', async () => {
    const user = userEvent.setup()
    const onSave = editor()

    await user.clear(screen.getByLabelText('Target'))
    await user.type(screen.getByLabelText('Target'), '75')
    await user.click(screen.getByRole('button', { name: 'Save numbers' }))

    expect(onSave).toHaveBeenCalledWith({
      added: [], removed: [], updated: [{ id: 'm1', patch: { targetValue: 75 } }],
    })
  })

  it('sends the source kind alongside the config whenever the source moves', async () => {
    const user = userEvent.setup()
    const onSave = editor()

    await user.click(screen.getByRole('combobox', { name: 'Sport' }))
    await user.click(screen.getByRole('option', { name: 'Cycling' }))
    await user.click(screen.getByRole('button', { name: 'Save numbers' }))

    expect(onSave).toHaveBeenCalledWith({
      added: [], removed: [],
      updated: [{
        id: 'm1',
        patch: { sourceKind: 'strava_distance', sourceConfig: { sport: 'ride', measure: 'distanceMi' } },
      }],
    })
  })

  // The unit is where the Strava measure is read from, so changing it has to carry the
  // source with it or the goal keeps being scored in the old unit.
  it('re-reads the measure when the unit changes', async () => {
    const user = userEvent.setup()
    const onSave = editor()

    await user.selectOptions(screen.getByLabelText('Unit'), 'km')
    await user.click(screen.getByRole('button', { name: 'Save numbers' }))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      updated: [{
        id: 'm1',
        patch: {
          unit: 'km',
          sourceKind: 'strava_distance',
          sourceConfig: { sport: 'run', measure: 'distanceKm' },
        },
      }],
    }))
  })

  it('tracks a second number alongside the first', async () => {
    const user = userEvent.setup()
    const onSave = editor()

    await user.click(screen.getByRole('button', { name: 'Track a number' }))
    const second = numbered(2)
    await user.type(within(second).getByLabelText('Metric label'), 'Elevation')
    await user.type(within(second).getByLabelText('Target'), '3000')
    await user.selectOptions(within(second).getByLabelText('Unit'), '__other')
    await user.type(within(second).getByLabelText('Custom unit'), 'feet')
    await user.click(screen.getByRole('button', { name: 'Save numbers' }))

    expect(onSave).toHaveBeenCalledWith({
      removed: [], updated: [],
      added: [{ label: 'Elevation', unit: 'feet', targetValue: 3000, sourceKind: 'manual', sourceConfig: undefined }],
    })
  })

  it('drops a number it was asked to stop tracking', async () => {
    const user = userEvent.setup()
    const onSave = editor({ metrics: [metric(), metric({ id: 'm2', label: 'Rides', sourceKind: 'manual', sourceConfig: {} })] })

    await user.click(screen.getByRole('button', { name: 'Stop tracking Rides' }))
    await user.click(screen.getByRole('button', { name: 'Save numbers' }))

    expect(onSave).toHaveBeenCalledWith({ added: [], updated: [], removed: ['m2'] })
  })

  // Real data loss, so it is stated before it happens rather than reported after.
  it('warns before handing a hand-logged number to a connector', async () => {
    const user = userEvent.setup()
    editor({ metrics: [metric({ sourceKind: 'manual', sourceConfig: {}, ownValue: 12, value: 12 })] })

    expect(screen.queryByText(/discarded on save/)).toBeNull()
    await user.selectOptions(screen.getByLabelText('Where the number comes from'), 'strava_distance')
    expect(screen.getByText(/12 miles logged by hand/)).toBeVisible()
  })
})

describe('getting to the numbers from the card', () => {
  const card = (handlers: Record<string, unknown>) => render(<GoalCard
    goal={goal()} busy={false} options={OPTIONS}
    onToggle={vi.fn()} onToggleStep={vi.fn()} onLog={vi.fn()} onPostpone={vi.fn()}
    onDelete={vi.fn()} onAddStep={vi.fn()} {...handlers}
  />)

  it('opens the editor from the menu', async () => {
    const user = userEvent.setup()
    card({ onSaveMetrics: vi.fn() })

    await user.click(screen.getByRole('button', { name: 'More actions for 50 Miles Ran' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit the numbers' }))
    expect(screen.getByRole('dialog', { name: 'Numbers' })).toBeVisible()
  })

  // "Edit a goal" and "edit what it counts" are one intention, and the menu item alone
  // left the edit panel looking like the whole of editing.
  it('opens the editor from the goal edit panel too', async () => {
    const user = userEvent.setup()
    card({ onEdit: vi.fn(), onSaveMetrics: vi.fn() })

    await user.click(screen.getByRole('button', { name: 'More actions for 50 Miles Ran' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit goal' }))
    await user.click(screen.getByRole('button', { name: 'Numbers' }))
    expect(screen.getByRole('dialog', { name: 'Numbers' })).toBeVisible()
  })

  it('offers nothing when the caller wired no handler', async () => {
    const user = userEvent.setup()
    card({})

    await user.click(screen.getByRole('button', { name: 'More actions for 50 Miles Ran' }))
    expect(screen.queryByRole('menuitem', { name: 'Edit the numbers' })).toBeNull()
  })

  it('reports the edits to the caller', async () => {
    const user = userEvent.setup()
    const onSaveMetrics = vi.fn()
    card({ onSaveMetrics })

    await user.click(screen.getByRole('button', { name: 'More actions for 50 Miles Ran' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit the numbers' }))
    await user.clear(screen.getByLabelText('Metric label'))
    await user.type(screen.getByLabelText('Metric label'), 'Trail and road miles')
    await user.click(screen.getByRole('button', { name: 'Save numbers' }))

    expect(onSaveMetrics).toHaveBeenCalledWith({
      added: [], removed: [], updated: [{ id: 'm1', patch: { label: 'Trail and road miles' } }],
    })
    expect(screen.queryByRole('dialog', { name: 'Numbers' })).toBeNull()
  })
})

describe('an existing number left incomplete', () => {
  // changesOf skips it, which is right for a blank row nobody filled in and wrong here:
  // clearing a stored metric's name and saving would otherwise appear to do nothing.
  it('refuses to save rather than silently dropping the edit', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<GoalNumbers goal={goal()} options={OPTIONS} busy={false} onCancel={vi.fn()} onSave={onSave} />)

    await user.clear(screen.getByLabelText('Metric label'))
    expect(screen.getByRole('button', { name: 'Save numbers' })).toBeDisabled()
    expect(screen.getByText(/needs a name and a target above zero/)).toBeVisible()

    await user.type(screen.getByLabelText('Metric label'), 'Miles Run')
    expect(screen.getByRole('button', { name: 'Save numbers' })).toBeEnabled()
  })
})
