/**
 * The one form for "a number a goal tracks", and the draft shape behind it.
 *
 * It started life inside `GoalComposer`, where a goal's numbers could only ever be set
 * at the moment the goal was created — so a goal that turned out to be counting the
 * wrong thing had to be deleted and retyped. `GoalNumbers` now edits the same numbers on
 * a goal that already exists, and both surfaces have to agree about every one of these
 * fields: a unit picked here decides which Strava measure the server reads, and two
 * copies of that rule drifting apart is a goal scored in miles that says kilometres.
 *
 * So the fields live here once and the two callers differ only in what they do with the
 * drafts — the composer hands them to `POST /api/goals`, the editor diffs them against
 * what is already stored and sends only what changed.
 */
import React from 'react'
import { Hi, XMarkIcon } from '../icons'
import IconSelect from './IconSelect'
import { SPORT_OPTIONS } from './sportIcons'
import type { GoalMetric, GoalMetricSource } from './types'

export interface MetricDraft {
  /** The metric this draft edits. Absent on one being added. */
  id?: string
  label: string
  /**
   * Whether the label has been typed in. Until it has, the field mirrors the goal's
   * title — see `labelOf` — and this flag is what stops that mirroring the moment you
   * disagree with it. Always true for a metric that already exists: it has a real name.
   */
  labelDirty: boolean
  unit: string
  /** The unit came from the "Something else" row, so the free-text box is showing. */
  unitOther: boolean
  targetValue: string
  sourceKind: GoalMetricSource
  sport: string
  gearId: string
  /**
   * On a STEP's number only: the id of the number on the parent goal this one feeds,
   * or '' for one that stands alone.
   *
   * It is a plain field rather than a separate concept because feeding a total is a
   * property of the number, not a second kind of number — and because the alternative,
   * matching child to parent by label, is the thing `goal_metrics` was built to avoid:
   * "miles" one week and "miles run" the next silently stops counting.
   */
  rollsUpTo: string
}

export const emptyMetric = (): MetricDraft => ({
  label: '', labelDirty: false, unit: '', unitOther: false,
  targetValue: '', sourceKind: 'manual', sport: '', gearId: '', rollsUpTo: '',
})

/**
 * What to count, defaulted to the goal's own title.
 *
 * Nearly every goal with one number is that number — "50 miles biked" tracks miles
 * biked — so the honest default for "what to count" is what the goal is called, and
 * typing it a second time is a tax on the common case. It stays live while untouched,
 * because the title is usually still being edited when the number gets added.
 */
export const labelOf = (metric: MetricDraft, title: string) => (metric.labelDirty ? metric.label : title)

/**
 * Which Strava number a metric is actually after, read off the unit it counts in.
 *
 * Without this a goal in kilometres would quietly be scored in miles: the server's
 * default measure is `distanceMi`, and nothing on the form would have said otherwise.
 * The unit is already the user's statement of what they mean, so it is the right place
 * to read the answer from rather than a second dropdown asking the same thing twice.
 */
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

const MEASURE_WORDS: Record<string, string> = {
  distanceMi: 'distance in miles', distanceKm: 'distance in kilometres',
  movingMin: 'moving time in minutes', movingHours: 'moving time in hours',
  elevationFt: 'elevation in feet', count: 'the number of activities',
}

/** The `sourceConfig` a draft means, in the shape `goals/sources.mjs` normalizes. */
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

/**
 * Which sport option a stored filter belongs under.
 *
 * The picker offers Strava's sport *families* — "Running" means the trail run and the
 * treadmill run too — but a metric created by an agent may have stored an exact
 * `sport_type` instead ("Run", "GravelRide"), and the server accepts both. Showing such
 * a metric as "Any sport" would be a lie the next save made true, so the family is
 * resolved from the map the options endpoint hands over.
 *
 * Only the *display* is normalized. The editor sends a source config only when the form
 * actually changed, so a metric filtered on a single exact sport type keeps that filter
 * until someone picks something else on purpose.
 */
export function sportOptionFor(sport: unknown, families: Record<string, string[]> = {}): string {
  const wanted = typeof sport === 'string' ? sport.trim().toLowerCase() : ''
  if (!wanted) return ''
  if (SPORT_OPTIONS.some((o) => o.value === wanted)) return wanted
  for (const [family, sports] of Object.entries(families)) {
    if (sports.some((s) => s.toLowerCase() === wanted)) return family
  }
  return ''
}

/** Open an existing metric in the form, as the form would have produced it. */
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
    // The suggestions are not an enum, so a unit typed in once has to reopen in the
    // free-text box rather than silently reverting to "No unit" on the next save.
    unitOther: Boolean(unit) && !units.includes(unit),
    targetValue: String(metric.targetValue),
    sourceKind: metric.sourceKind,
    sport: sportOptionFor(config.sport, families),
    gearId: typeof config.gearId === 'string' ? config.gearId : '',
    rollsUpTo: metric.rollsUpToMetricId ?? '',
  }
}

/** A number on the parent goal that a step's number is allowed to feed. */
export interface FeedOption {
  id: string
  label: string
  unit: string | null
}

/**
 * One metric's fields.
 *
 * `mirrorTitle` is the composer's behaviour only: on a goal that already exists the
 * label is a decision someone made, not a default still following the title around.
 */
export default function MetricFields({ metric, legend, units, mirrorTitle, feeds, onChange, onRemove, removeLabel }: {
  metric: MetricDraft
  legend: string
  /** The grouped unit suggestions from `/api/goals/options`. */
  units: [string, string[]][]
  mirrorTitle?: string
  /**
   * The parent goal's numbers this one may feed — passed only when the form is editing
   * a STEP, since a top-level goal has nothing above it to feed. Sourced parent numbers
   * are not offered: a connector already counts everything in the period, so feeding one
   * would count the same miles twice, and the server refuses it.
   */
  feeds?: FeedOption[]
  onChange: (change: Partial<MetricDraft>) => void
  onRemove: () => void
  removeLabel: string
}) {
  const label = mirrorTitle === undefined ? metric.label : labelOf(metric, mirrorTitle)

  return (
    <fieldset className="goal-composer-metric">
      <legend>{legend}</legend>

      <label className="field goal-composer-metric-label">
        What to count
        <input
          placeholder="Miles run" aria-label="Metric label" value={label}
          onChange={(e) => onChange({ label: e.target.value, labelDirty: true })}
        />
      </label>

      <label className="field">
        Target
        <input
          type="number" min="0" step="any" placeholder="100" aria-label="Target" value={metric.targetValue}
          onChange={(e) => onChange({ targetValue: e.target.value })}
        />
      </label>

      <label className="field">
        Unit
        <select
          aria-label="Unit" value={metric.unitOther ? '__other' : metric.unit}
          onChange={(e) => {
            const chosen = e.target.value
            if (chosen === '__other') onChange({ unitOther: true, unit: '' })
            else onChange({ unitOther: false, unit: chosen })
          }}
        >
          <option value="">No unit</option>
          {units.map(([group, groupUnits]) => (
            <optgroup key={group} label={group}>
              {groupUnits.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </optgroup>
          ))}
          {/* The unit list is suggestions, not an enum — goals/units.mjs accepts
              anything — so the form must not be the thing that makes it one. */}
          <option value="__other">Something else…</option>
        </select>
      </label>

      {metric.unitOther && (
        <label className="field goal-composer-metric-extra">
          What unit?
          <input
            autoFocus placeholder="chapters" aria-label="Custom unit" value={metric.unit}
            onChange={(e) => onChange({ unit: e.target.value })}
          />
        </label>
      )}

      <label className="field goal-composer-metric-source">
        Progress source
        <select
          aria-label="Where the number comes from" value={metric.sourceKind}
          onChange={(e) => {
            const sourceKind = e.target.value as GoalMetricSource
            // A Strava metric with no unit would render as a bare number and be
            // scored in miles anyway, so name the default rather than imply it.
            const unit = sourceKind !== 'manual' && !metric.unit && !metric.unitOther ? 'miles' : metric.unit
            onChange({ sourceKind, unit })
          }}
        >
          <option value="manual">I log it</option>
          <option value="strava_distance">From Strava</option>
          <option value="strava_gear_odometer">Bike odometer</option>
        </select>
      </label>

      {metric.sourceKind === 'strava_distance' && (
        <div className="field goal-composer-metric-extra">
          <span className="goal-composer-field-label">Sport</span>
          <IconSelect
            label="Sport" value={metric.sport} options={SPORT_OPTIONS}
            onChange={(sport) => onChange({ sport })}
          />
          {/* Families, not single workout types: "Running" counts the trail run and the
              treadmill run, "Cycling" counts the gravel ride and the trainer session. */}
          <p className="muted goal-composer-hint">
            Counting {MEASURE_WORDS[measureFor(metric.unit)]} in this period
            {metric.sport ? ', across every workout type in that sport' : ''}.
          </p>
        </div>
      )}

      {metric.sourceKind === 'strava_gear_odometer' && (
        <label className="field goal-composer-metric-extra">
          Gear ID
          <input
            placeholder="b1234…" aria-label="Gear id" value={metric.gearId}
            onChange={(e) => onChange({ gearId: e.target.value })}
          />
        </label>
      )}

      {feeds && feeds.length > 0 && (
        <label className="field goal-composer-metric-source">
          Counts toward
          <select
            aria-label="Number on the goal this feeds" value={metric.rollsUpTo}
            onChange={(e) => onChange({ rollsUpTo: e.target.value })}
          >
            <option value="">Just this step</option>
            {feeds.map((feed) => (
              <option key={feed.id} value={feed.id}>
                {feed.label}{feed.unit ? ` (${feed.unit})` : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      <button
        type="button" className="btn compact goal-composer-remove"
        onClick={onRemove}
        aria-label={removeLabel}
      ><Hi icon={XMarkIcon} size={14} /> Remove</button>
    </fieldset>
  )
}
