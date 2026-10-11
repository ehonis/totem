// The pure half of web/src/goals/metricFields.tsx and GoalNumbers.tsx: the draft a
// "number a goal tracks" is edited as, how a unit picks the Strava measure, and the
// diff a round of edits saves. Shared by the composer and the numbers editor so the
// two can never disagree about which measure a unit means.
import { SPORT_OPTIONS } from './sportIcons'
import type { GoalMetric, GoalMetricChanges, GoalMetricSource } from './types'

export interface MetricDraft {
  id?: string
  label: string
  /** Typed in. Until it is, the label mirrors the goal's title (see labelOf). */
  labelDirty: boolean
  unit: string
  /** The unit came from "Something else", so the free-text box is showing. */
  unitOther: boolean
  targetValue: string
  sourceKind: GoalMetricSource
  sport: string
  gearId: string
  /** On a step's number only: the parent number it feeds, or ''. */
  rollsUpTo: string
}

export const emptyMetric = (): MetricDraft => ({
  label: '', labelDirty: false, unit: '', unitOther: false,
  targetValue: '', sourceKind: 'manual', sport: '', gearId: '', rollsUpTo: '',
})

export const labelOf = (metric: MetricDraft, title: string) => (metric.labelDirty ? metric.label : title)

const MEASURE_BY_UNIT: Record<string, string> = {
  miles: 'distanceMi', mi: 'distanceMi',
  km: 'distanceKm', kilometers: 'distanceKm', kilometres: 'distanceKm',
  minutes: 'movingMin', mins: 'movingMin',
  hours: 'movingHours',
  feet: 'elevationFt', ft: 'elevationFt', flights: 'elevationFt',
  sessions: 'count', workouts: 'count', times: 'count', rides: 'count', runs: 'count',
  activities: 'count', laps: 'count',
}

export const measureFor = (unit: string) => MEASURE_BY_UNIT[unit.trim().toLowerCase()] ?? 'distanceMi'

export const MEASURE_WORDS: Record<string, string> = {
  distanceMi: 'distance in miles', distanceKm: 'distance in kilometres',
  movingMin: 'moving time in minutes', movingHours: 'moving time in hours',
  elevationFt: 'elevation in feet', count: 'the number of activities',
}

export const sourceConfigOf = (metric: MetricDraft): Record<string, unknown> | undefined => {
  if (metric.sourceKind === 'strava_distance') {
    return { sport: metric.sport || undefined, measure: measureFor(metric.unit) }
  }
  if (metric.sourceKind === 'strava_gear_odometer') {
    return {
      gearId: metric.gearId.trim(),
      measure: measureFor(metric.unit) === 'distanceKm' ? 'distanceKm' : 'distanceMi',
    }
  }
  return undefined
}

/** Which sport family a stored filter (maybe an exact sport_type) shows under. */
export function sportOptionFor(sport: unknown, families: Record<string, string[]> = {}): string {
  const wanted = typeof sport === 'string' ? sport.trim().toLowerCase() : ''
  if (!wanted) return ''
  if (SPORT_OPTIONS.some((o) => o.value === wanted)) return wanted
  for (const [family, sports] of Object.entries(families)) {
    if (sports.some((s) => s.toLowerCase() === wanted)) return family
  }
  return ''
}

export function draftOf(
  metric: GoalMetric,
  { units = [], families = {} }: { units?: string[]; families?: Record<string, string[]> } = {},
): MetricDraft {
  const unit = metric.unit ?? ''
  const config = metric.sourceConfig ?? {}
  return {
    id: metric.id,
    label: metric.label,
    labelDirty: true,
    unit,
    unitOther: Boolean(unit) && !units.includes(unit),
    targetValue: String(metric.targetValue),
    sourceKind: metric.sourceKind,
    sport: sportOptionFor(config.sport, families),
    gearId: typeof config.gearId === 'string' ? config.gearId : '',
    rollsUpTo: metric.rollsUpToMetricId ?? '',
  }
}

export interface FeedOption { id: string; label: string; unit: string | null }

const sourceChanged = (draft: MetricDraft, was: MetricDraft) =>
  draft.sourceKind !== was.sourceKind
  || draft.sport !== was.sport
  || draft.gearId.trim() !== was.gearId.trim()
  || measureFor(draft.unit) !== measureFor(was.unit)

/** Only what changed: an untouched metric is not sent at all (GoalNumbers.tsx). */
export function changesOf(drafts: MetricDraft[], originals: MetricDraft[]): GoalMetricChanges {
  const kept = new Set(drafts.map((d) => d.id).filter(Boolean) as string[])
  const changes: GoalMetricChanges = { added: [], updated: [], removed: [] }
  for (const was of originals) if (was.id && !kept.has(was.id)) changes.removed.push(was.id)
  for (const draft of drafts) {
    const label = draft.label.trim()
    const targetValue = Number(draft.targetValue)
    if (!label || !Number.isFinite(targetValue) || targetValue <= 0) continue
    if (!draft.id) {
      changes.added.push({
        label,
        unit: draft.unit.trim() || undefined,
        targetValue,
        sourceKind: draft.sourceKind,
        sourceConfig: sourceConfigOf(draft),
        rollsUpToMetricId: draft.rollsUpTo || undefined,
      })
      continue
    }
    const was = originals.find((o) => o.id === draft.id)
    if (!was) continue
    const patch: GoalMetricChanges['updated'][number]['patch'] = {}
    if (label !== was.label.trim()) patch.label = label
    if (draft.unit.trim() !== was.unit.trim()) patch.unit = draft.unit.trim() || null
    if (targetValue !== Number(was.targetValue)) patch.targetValue = targetValue
    if (sourceChanged(draft, was)) {
      patch.sourceKind = draft.sourceKind
      patch.sourceConfig = sourceConfigOf(draft)
    }
    if (draft.rollsUpTo !== was.rollsUpTo) patch.rollsUpToMetricId = draft.rollsUpTo || null
    if (Object.keys(patch).length > 0) changes.updated.push({ id: draft.id, patch })
  }
  return changes
}
