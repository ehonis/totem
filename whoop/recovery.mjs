/**
 * Normalize WHOOP recovery records into one score per physiological cycle.
 * WHOOP can return an older and a re-scored copy in the same window, so the
 * newest `updated_at` wins. Records with no state predate that field and are
 * accepted; an explicit non-SCORED state is never charted.
 */
export function indexRecoveryScores(records) {
  const scores = new Map()
  const updatedAt = new Map()
  for (const record of Array.isArray(records) ? records : []) {
    const cycleId = record?.cycle_id
    const raw = record?.score?.recovery_score
    if (cycleId === undefined || cycleId === null || raw === undefined || raw === null) continue
    if (record.score_state && record.score_state !== 'SCORED') continue
    const score = Number(raw)
    if (!Number.isFinite(score)) continue
    const stamp = Date.parse(record.updated_at)
    const priorStamp = updatedAt.get(cycleId)
    if (Number.isFinite(stamp) && Number.isFinite(priorStamp) && stamp < priorStamp) continue
    scores.set(cycleId, Math.min(100, Math.max(0, Math.round(score))))
    updatedAt.set(cycleId, Number.isFinite(stamp) ? stamp : -Infinity)
  }
  return scores
}
