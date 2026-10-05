import { describe, expect, it } from 'vitest'

import { goalIconFor } from './goalIcon'
import { BallIcon, BarbellIcon, BikeIcon, RunIcon } from './sportIcons'
import { BookOpenIcon, FlagIcon } from '../icons'
import type { Goal, GoalMetric } from './types'

const metric = (over: Partial<GoalMetric> = {}): GoalMetric => ({
  id: 'm', goalId: 'g', label: '', unit: null, targetValue: 1,
  ownValue: 0, rolledUpValue: 0, value: 0, fraction: 0, percent: 0,
  rollsUpToMetricId: null, feederCount: 0, unreadableFeederCount: 0,
  sourceKind: 'manual', sourceConfig: {}, sourceLabel: '', available: true,
  unavailableReason: null, readAt: null, position: 0, ...over,
})

const goal = (over: Partial<Goal> = {}) =>
  ({ title: '', notes: '', metrics: [], subGoals: [], ...over }) as Goal

describe('goalIconFor', () => {
  it('takes the configured Strava sport over anything the words suggest', () => {
    // The sport is structured data; the title is a sentence someone typed. When they
    // disagree, the one that was actually configured wins.
    expect(goalIconFor(goal({
      title: 'Ride to the running club',
      metrics: [metric({ sourceKind: 'strava_distance', sourceConfig: { sport: 'run' } })],
    }))).toBe(RunIcon)
  })

  it('reads a bike odometer as cycling without being told the sport', () => {
    expect(goalIconFor(goal({
      title: 'Wear out the gravel bike',
      metrics: [metric({ sourceKind: 'strava_gear_odometer', sourceConfig: { gearId: 'b1' } })],
    }))).toBe(BikeIcon)
  })

  it('falls back to the title, then to what the goal counts', () => {
    expect(goalIconFor(goal({ title: '50 Miles Biked' }))).toBe(BikeIcon)
    expect(goalIconFor(goal({ title: 'Finish the shelf', metrics: [metric({ label: 'chapters read' })] }))).toBe(BookOpenIcon)
  })

  it('prefers the sport rows over the desk rows when a title mentions both', () => {
    expect(goalIconFor(goal({ title: 'Bike to work every day' }))).toBe(BikeIcon)
  })

  it('searches notes only when the title says nothing', () => {
    expect(goalIconFor(goal({ title: 'Tuesdays', notes: 'Pickleball with Dad' }))).toBe(BallIcon)
    // A note must not outvote a title that already matched.
    expect(goalIconFor(goal({ title: 'Gym three times', notes: 'read a chapter after' }))).toBe(BarbellIcon)
  })

  it('flags a goal it cannot read rather than guessing', () => {
    expect(goalIconFor(goal({ title: 'Sort out the thing' }))).toBe(FlagIcon)
  })

  it('ignores an unfamiliar sport instead of throwing', () => {
    // `sourceConfig.sport` accepts an exact sport_type, which an MCP-created goal may
    // well hold — it simply isn't in the picker's family list.
    expect(goalIconFor(goal({
      title: 'Gravel season',
      metrics: [metric({ sourceKind: 'strava_distance', sourceConfig: { sport: 'GravelRide' } })],
    }))).toBe(FlagIcon)
  })
})
