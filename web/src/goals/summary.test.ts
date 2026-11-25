import { describe, expect, it } from 'vitest'
import { periodSummary } from './summary'
import type { Goal } from './types'

const goal = (over: Record<string, unknown> = {}) => ({ complete: false, abandoned: false, progress: { percent: 0 }, ...over }) as unknown as Goal

describe('periodSummary', () => {
  it('counts achieved over the goals still in play', () => {
    const s = periodSummary([
      goal({ complete: true, progress: { percent: 80 } }),
      goal({ progress: { percent: 50 } }),
      goal({ abandoned: true, progress: { percent: 10 } }),
      goal({ progress: { percent: null } }),
    ])
    expect(s).toMatchObject({ achieved: 1, counted: 3, notDoing: 1 })
    expect(s.ratio).toBeCloseTo(1 / 3)
    // 100 (achieved counts as full) and 50; the unreadable and the stopped ones are left out.
    expect(s.meanPercent).toBe(75)
  })

  it('counts a goal achieved after being stopped as achieved', () => {
    expect(periodSummary([goal({ complete: true, abandoned: true })])).toMatchObject({ achieved: 1, notDoing: 0 })
  })

  it('reads nothing set as zero, not as a division by zero', () => {
    expect(periodSummary([])).toEqual({ achieved: 0, counted: 0, notDoing: 0, ratio: 0, meanPercent: null })
  })
})
