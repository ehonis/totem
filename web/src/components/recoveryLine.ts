export const RECOVERY_RED = '#f0506e'
export const RECOVERY_YELLOW = '#e3b341'
export const RECOVERY_GREEN = '#3fb950'

/** WHOOP zones: red 0–33, yellow 34–66, green 67–100. */
export function recoveryColor(score: number): string {
  if (score >= 67) return RECOVERY_GREEN
  if (score >= 34) return RECOVERY_YELLOW
  return RECOVERY_RED
}

/**
 * SVG gradient stops positioned on the recovery line's vertical score domain.
 * The one-point transitions preserve WHOOP's exact zones while softening the
 * stroke where a curve crosses 33→34 or 66→67.
 */
export function recoveryGradientStops(series: Array<{ stats?: Record<string, number> }>) {
  const scores = series
    .map((day) => day.stats?.recovery)
    .filter((score): score is number => Number.isFinite(score))
  if (!scores.length) return [] as Array<{ offset: string; color: string }>
  const lo = Math.min(...scores)
  const hi = Math.max(...scores)
  if (lo === hi) {
    const color = recoveryColor(lo)
    return [{ offset: '0%', color }, { offset: '100%', color }]
  }
  const stop = (score: number, color = recoveryColor(score)) => ({
    offset: `${Number((((score - lo) / (hi - lo)) * 100).toFixed(3))}%`,
    color,
  })
  const boundaries = [
    { score: 33, color: RECOVERY_RED },
    { score: 34, color: RECOVERY_YELLOW },
    { score: 66, color: RECOVERY_YELLOW },
    { score: 67, color: RECOVERY_GREEN },
  ].filter(({ score }) => score > lo && score < hi)
  return [stop(lo), ...boundaries.map(({ score, color }) => stop(score, color)), stop(hi)]
}
