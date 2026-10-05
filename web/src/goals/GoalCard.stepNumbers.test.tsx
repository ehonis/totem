/*
 * Numbers on a step.
 *
 * The case, in the owner's words: "this week I have 2 bike rides under a complete cardio
 * goal — let me attach a number, and let me attach several so I can see amount and miles
 * on the same step." The goal is the heading; the countable thing hangs off the step.
 *
 * Three rules live here. A step's numbers are edited through the same editor the goal's
 * are, opened from the step's own row. Several numbers on one step each get their own
 * bar. And a step's number may FEED one of the goal's — an explicit id, never a label
 * match — which is offered only for the goal's manual numbers, because a connector-fed
 * one already counts everything in the period.
 */
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import GoalCard from './GoalCard'
import type { Goal, GoalMetric, GoalOptions, SubGoal } from './types'

afterEach(cleanup)

const OPTIONS: GoalOptions = {
  periods: [],
  units: { Distance: ['miles', 'km'], Count: ['rides'] },
  allUnits: ['miles', 'km', 'rides'],
  sources: ['manual', 'strava_distance', 'strava_gear_odometer'],
  measures: ['distanceMi', 'distanceKm'],
  sports: ['ride', 'run'],
  sportFamilies: { ride: ['Ride', 'GravelRide'], run: ['Run', 'TrailRun'] },
}

const metric = (over: Partial<GoalMetric> = {}): GoalMetric => ({
  id: 'm1', goalId: 's1', label: 'rides', unit: 'rides', targetValue: 2,
  ownValue: 1, rolledUpValue: 0, value: 1, fraction: 0.5, percent: 50,
  rollsUpToMetricId: null, feederCount: 0, unreadableFeederCount: 0,
  sourceKind: 'manual', sourceConfig: {}, sourceLabel: 'logged by hand',
  available: true, unavailableReason: null, readAt: null, position: 0,
  ...over,
})

const step = (over: Partial<SubGoal> = {}): SubGoal => ({
  id: 's1', parentId: 'g1', title: '2 bike rides (10+ miles)', notes: '',
  completedAt: null, complete: false, abandonedAt: null, abandoned: false,
  position: 0, metrics: [], progress: { fraction: 0, percent: 0 },
  ...over,
})

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g1', clientKey: null, title: 'Complete cardio goals', notes: '',
  period: { type: 'week', start: '2026-09-21', end: '2026-09-27', key: '2026-09-21', label: 'Sep 21 – 27, 2026' },
  periodState: 'active', daysLeft: 6, completedAt: null, abandonedAt: null, abandoned: false, complete: false,
  postponedCount: 0, position: 0,
  createdAt: '2026-09-21T12:00:00.000Z', updatedAt: '2026-09-21T12:00:00.000Z',
  metrics: [], subGoals: [step()], links: [],
  progress: { fraction: 0, percent: 0, subGoalsDone: 0, subGoalsTotal: 1, subGoalsAbandoned: 0, complete: false },
  ...over,
})

function card(over: Partial<Goal> = {}, handlers: Record<string, unknown> = {}) {
  return render(<GoalCard
    goal={goal(over)} busy={false} options={OPTIONS}
    onToggle={vi.fn()} onToggleStep={vi.fn()} onLog={vi.fn()} onPostpone={vi.fn()}
    onDelete={vi.fn()} onAddStep={vi.fn()} {...handlers}
  />)
}

const stepRow = () => document.querySelector('.goal-step') as HTMLElement

describe('a step that tracks numbers', () => {
  it('shows every number it tracks, each with its own bar', () => {
    card({
      subGoals: [step({
        metrics: [
          metric({ id: 'count', label: 'rides', unit: 'rides', targetValue: 2, value: 1, percent: 50 }),
          metric({ id: 'miles', label: 'miles', unit: 'miles', targetValue: 20, value: 12.4, percent: 62 }),
        ],
        progress: { fraction: 0.56, percent: 56 },
      })],
    })

    const row = within(stepRow())
    expect(row.getByText('rides')).toBeVisible()
    expect(row.getByText('miles')).toBeVisible()
    expect(row.getAllByRole('img')).toHaveLength(2)
    expect(row.getByLabelText('50 percent of rides')).toBeVisible()
    expect(row.getByLabelText('62 percent of miles')).toBeVisible()
  })

  // A step with numbers is worth what those numbers say — goals/progress.mjs — so the
  // step states its own figure rather than reading as untouched until it is ticked.
  it('states how far through it is', () => {
    card({ subGoals: [step({ metrics: [metric()], progress: { fraction: 0.5, percent: 50 } })] })
    expect(within(stepRow()).getByText('50%')).toBeVisible()
  })

  it('logs against a step number the same way a goal number does', async () => {
    const user = userEvent.setup(), onLog = vi.fn()
    card({ subGoals: [step({ metrics: [metric()] })] }, { onLog })

    await user.click(screen.getByRole('button', { name: 'Add one rides' }))
    expect(onLog).toHaveBeenCalledWith('m1', { delta: 1 })
  })
})

describe('putting a number on a step', () => {
  it('opens the editor from the step row, named after the step', async () => {
    const user = userEvent.setup()
    card({}, { onSaveStepMetrics: vi.fn() })

    await user.click(screen.getByRole('button', { name: 'Track a number on 2 bike rides (10+ miles)' }))
    expect(screen.getByRole('dialog', { name: 'Numbers on “2 bike rides (10+ miles)”' })).toBeVisible()
  })

  it('offers no way in when the caller wired no handler', () => {
    card({ subGoals: [step({ metrics: [metric()] })] }, {})
    expect(screen.queryByRole('button', { name: /number on/i })).toBeNull()
  })

  it('reports the added number against the step, not the goal', async () => {
    const user = userEvent.setup()
    const onSaveStepMetrics = vi.fn()
    card({}, { onSaveStepMetrics })

    // The editor opens on the empty form, because a step with no numbers has nothing
    // else it could be opened for.
    await user.click(screen.getByRole('button', { name: 'Track a number on 2 bike rides (10+ miles)' }))
    await user.type(screen.getByLabelText('Metric label'), 'rides')
    await user.type(screen.getByLabelText('Target'), '2')
    await user.selectOptions(screen.getByLabelText('Unit'), 'rides')
    await user.click(screen.getByRole('button', { name: 'Save numbers' }))

    expect(onSaveStepMetrics).toHaveBeenCalledWith('s1', {
      added: [{
        label: 'rides', unit: 'rides', targetValue: 2, sourceKind: 'manual',
        sourceConfig: undefined, rollsUpToMetricId: undefined,
      }],
      updated: [], removed: [],
    })
  })
})

describe('feeding a number on the goal', () => {
  const parent = (over: Partial<GoalMetric> = {}) =>
    metric({ id: 'total', goalId: 'g1', label: 'total miles', unit: 'miles', targetValue: 100, ...over })

  it('offers the goal’s own manual numbers, and not its connector-fed ones', async () => {
    const user = userEvent.setup()
    card({
      metrics: [parent(), parent({ id: 'strava', label: 'Strava miles', sourceKind: 'strava_distance' })],
    }, { onSaveStepMetrics: vi.fn() })

    await user.click(screen.getByRole('button', { name: 'Track a number on 2 bike rides (10+ miles)' }))

    const picker = screen.getByLabelText('Number on the goal this feeds')
    expect(within(picker).getByRole('option', { name: 'total miles (miles)' })).toBeVisible()
    // A connector already counts every ride in the period; feeding it would count the
    // same miles twice, and the server refuses it.
    expect(within(picker).queryByRole('option', { name: /Strava miles/ })).toBeNull()
  })

  it('is not offered on the goal’s own numbers, which have nothing above them', async () => {
    const user = userEvent.setup()
    card({ metrics: [parent()] }, { onSaveMetrics: vi.fn(), onSaveStepMetrics: vi.fn() })

    await user.click(screen.getByRole('button', { name: 'More actions for Complete cardio goals' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit the numbers' }))
    expect(screen.queryByLabelText('Number on the goal this feeds')).toBeNull()
  })

  it('sends the parent metric id, never a label', async () => {
    const user = userEvent.setup()
    const onSaveStepMetrics = vi.fn()
    card({ metrics: [parent()] }, { onSaveStepMetrics })

    await user.click(screen.getByRole('button', { name: 'Track a number on 2 bike rides (10+ miles)' }))
    await user.type(screen.getByLabelText('Metric label'), 'bike miles')
    await user.type(screen.getByLabelText('Target'), '40')
    await user.selectOptions(screen.getByLabelText('Number on the goal this feeds'), 'total')
    await user.click(screen.getByRole('button', { name: 'Save numbers' }))

    expect(onSaveStepMetrics.mock.calls[0][1].added[0].rollsUpToMetricId).toBe('total')
  })

  // undefined would read as "leave it alone" at the server, so a number taken off a
  // total would quietly keep feeding it.
  it('detaches with an explicit null', async () => {
    const user = userEvent.setup()
    const onSaveStepMetrics = vi.fn()
    card({
      metrics: [parent()],
      subGoals: [step({ metrics: [metric({ id: 'bike', label: 'bike miles', rollsUpToMetricId: 'total' })] })],
    }, { onSaveStepMetrics })

    await user.click(screen.getByRole('button', { name: 'Edit the numbers on 2 bike rides (10+ miles)' }))
    await user.selectOptions(screen.getByLabelText('Number on the goal this feeds'), '')
    await user.click(screen.getByRole('button', { name: 'Save numbers' }))

    expect(onSaveStepMetrics).toHaveBeenCalledWith('s1', {
      added: [], removed: [], updated: [{ id: 'bike', patch: { rollsUpToMetricId: null } }],
    })
  })
})
