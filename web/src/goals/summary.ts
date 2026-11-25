// The Goals page's period summary, the app's (mobile/src/features/goals/summary.ts):
// how many goals were achieved and how far the rest have got, for the ring at the
// top of a period and each Overview horizon. Pure, with type-only imports.
import type { Goal } from './types'

export interface PeriodSummary {
  /** Goals marked complete. */
  achieved: number
  /** Goals still in play: everything but the ones he decided not to do. */
  counted: number
  notDoing: number
  /** achieved / counted, 0 when nothing is counted. */
  ratio: number
  /** The mean progress of the counted goals (an achieved one is 100), or null when none can be read. */
  meanPercent: number | null
}

export function periodSummary(goals: Goal[]): PeriodSummary {
  const inPlay = goals.filter((g) => g.complete || !g.abandoned)
  const achieved = inPlay.filter((g) => g.complete).length
  const percents = inPlay
    .map((g) => (g.complete ? 100 : g.progress.percent))
    .filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
  return {
    achieved,
    counted: inPlay.length,
    notDoing: goals.length - inPlay.length,
    ratio: inPlay.length ? achieved / inPlay.length : 0,
    meanPercent: percents.length ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length) : null,
  }
}
