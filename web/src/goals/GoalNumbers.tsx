/**
 * Edit the numbers on a goal — or on one of its steps — that already exists.
 *
 * A step takes numbers because a step is usually where the number actually lives: the
 * goal is "complete cardio goals" and the countable thing is "2 bike rides" under it.
 * Same table, same three endpoints, same form; the only thing a step adds is a picker
 * for which of the goal's own numbers this one feeds.
 *
 * Until this, a goal's metrics were decided once at the moment of creation and never
 * again: the card could log against them and nothing else, so a goal counting the wrong
 * thing — the wrong sport, the wrong unit, a target set before you knew what the week
 * looked like — had to be deleted and retyped, taking whatever was logged with it.
 *
 * ## It saves a diff, not the form
 *
 * Every field here maps onto a separate endpoint (`POST /metrics`, `PATCH /metrics`,
 * `DELETE /metrics`), so the obvious implementation — send every metric on Save — would
 * rewrite rows nobody touched. That matters for one field in particular: `sourceConfig`
 * may hold a sport filter this picker cannot express (an exact `sport_type` like
 * `GravelRide`, which the API accepts and `sportOptionFor` can only show as its family).
 * Sending the form back would quietly widen that filter. So each draft is compared with
 * the draft it opened as, and a metric with nothing changed is not sent at all.
 *
 * ## Switching to a connector throws the logged number away
 *
 * The schema keeps a sourced metric's stored value at zero — the connector owns the
 * number — so handing a hand-logged metric to Strava discards what was logged. The
 * server reports it; this says so beforehand, because "it vanished" after the fact is
 * not consent.
 */
import React, { useState } from 'react'
import { Hi, PlusIcon, XMarkIcon } from '../icons'
import MetricFields, { draftOf, emptyMetric, measureFor, sourceConfigOf } from './metricFields'
import type { FeedOption, MetricDraft } from './metricFields'
import { formatAmount } from './types'
import type { Goal, GoalMetricChanges, GoalOptions, SubGoal } from './types'

/** Did anything the *source* depends on move? The measure rides on the unit. */
const sourceChanged = (draft: MetricDraft, was: MetricDraft) =>
  draft.sourceKind !== was.sourceKind
  || draft.sport !== was.sport
  || draft.gearId.trim() !== was.gearId.trim()
  || measureFor(draft.unit) !== measureFor(was.unit)

export function changesOf(drafts: MetricDraft[], originals: MetricDraft[]): GoalMetricChanges {
  const kept = new Set(drafts.map((d) => d.id).filter(Boolean) as string[])
  const changes: GoalMetricChanges = { added: [], updated: [], removed: [] }

  for (const was of originals) {
    if (was.id && !kept.has(was.id)) changes.removed.push(was.id)
  }

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
    // Source kind and config always travel together: the server reads the config in the
    // light of the kind, and a config sent without one is not a source change at all.
    if (sourceChanged(draft, was)) {
      patch.sourceKind = draft.sourceKind
      patch.sourceConfig = sourceConfigOf(draft)
    }
    // Null, not undefined, when it was detached: the server reads `undefined` as "leave
    // it alone", so a number taken off a total would keep feeding it.
    if (draft.rollsUpTo !== was.rollsUpTo) patch.rollsUpToMetricId = draft.rollsUpTo || null
    if (Object.keys(patch).length > 0) changes.updated.push({ id: draft.id, patch })
  }

  return changes
}

export default function GoalNumbers({ goal, step = null, options, busy, error = '', onCancel, onSave }: {
  goal: Goal
  /**
   * The step whose numbers are being edited, or null for the goal's own.
   *
   * One component for both because they are the same table and the same three
   * endpoints — a step IS a goal row, and `POST /api/goals/:id/metrics` does not care
   * which kind of row the id names. The only difference a step makes is that its
   * numbers may feed one of the goal's, which is the `feeds` list below.
   */
  step?: SubGoal | null
  options: GoalOptions | null
  busy: boolean
  error?: string
  onCancel: () => void
  onSave: (changes: GoalMetricChanges) => void
}) {
  const units = options?.allUnits ?? []
  const families = options?.sportFamilies ?? {}
  const target = step ?? goal
  // Only manual parent numbers: a connector-sourced one already counts everything in
  // the period, so feeding it would count the same ride twice and the server says so.
  const feeds: FeedOption[] | undefined = step
    ? goal.metrics.filter((m) => m.sourceKind === 'manual').map((m) => ({ id: m.id, label: m.label, unit: m.unit }))
    : undefined
  const [originals] = useState<MetricDraft[]>(() => target.metrics.map((m) => draftOf(m, { units, families })))
  // Opened on something that tracks nothing yet, it opens on the empty form rather than
  // on a dialog whose only content is a button that produces the form. `changesOf` skips
  // an untouched draft, so seeding one can never save anything nobody typed. `originals`
  // stays the stored set either way — it is the baseline the diff is taken against.
  const [drafts, setDrafts] = useState<MetricDraft[]>(originals.length ? originals : [emptyMetric()])

  const patch = (index: number, change: Partial<MetricDraft>) =>
    setDrafts((current) => current.map((m, j) => (index === j ? { ...m, ...change } : m)))

  /** Hand-logged numbers about to be handed to a connector, which discards them. */
  const discarding = drafts.filter((draft) => {
    if (draft.sourceKind === 'manual' || !draft.id) return false
    const was = originals.find((o) => o.id === draft.id)
    if (!was || was.sourceKind !== 'manual') return false
    return (target.metrics.find((m) => m.id === draft.id)?.ownValue ?? 0) > 0
  })

  /*
   * A metric that already exists, emptied out.
   *
   * `changesOf` skips an incomplete draft, which is right for a blank row nobody filled
   * in — but on a metric that is already stored it would mean clearing the label, hitting
   * Save, and watching nothing happen. Say so instead of dropping it on the floor.
   */
  const emptied = drafts.filter((d) => d.id && (!d.label.trim() || !(Number(d.targetValue) > 0)))

  const unitGroups = Object.entries(options?.units ?? {})

  return (
    <div className="modal-backdrop goal-composer-backdrop" onMouseDown={onCancel}>
      <form
        className="event-modal goal-composer" role="dialog" aria-modal="true" aria-labelledby="goal-numbers-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') onCancel() }}
        onSubmit={(event) => { event.preventDefault(); onSave(changesOf(drafts, originals)) }}
      >
        <div className="modal-head">
          <div>
            <div className="modal-kicker">{step ? `${goal.title} · step` : goal.title}</div>
            <h2 id="goal-numbers-title">{step ? `Numbers on “${step.title || 'this step'}”` : 'Numbers'}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="Close"><Hi icon={XMarkIcon} size={20} /></button>
        </div>

        {error && <p className="goals-error goal-composer-error" role="alert">{error}</p>}

        {drafts.map((metric, i) => (
          <MetricFields
            key={metric.id ?? `new-${i}`} metric={metric} legend={`Number ${i + 1}`} units={unitGroups}
            feeds={feeds}
            onChange={(change) => patch(i, change)}
            onRemove={() => setDrafts(drafts.filter((_, j) => j !== i))}
            removeLabel={`Stop tracking ${metric.label || `number ${i + 1}`}`}
          />
        ))}

        {discarding.length > 0 && (
          <p className="goals-error goal-composer-error" role="status">
            {discarding.map((d) => {
              const logged = target.metrics.find((m) => m.id === d.id)
              return `"${d.label}" has ${formatAmount(logged?.ownValue ?? 0, logged?.unit ?? null)} logged by hand`
            }).join('; ')}
            . A connector owns the number it feeds, so that will be discarded on save.
          </p>
        )}

        {emptied.length > 0 && (
          <p className="goals-error goal-composer-error" role="alert">
            A number needs a name and a target above zero. Remove it instead if you have
            stopped tracking it.
          </p>
        )}

        <div className="goal-composer-number-row">
          <button type="button" className="btn compact" onClick={() => setDrafts([...drafts, emptyMetric()])}>
            <Hi icon={PlusIcon} size={13} /> Track a number
          </button>
          <p className="muted">
            {step
              ? 'A step tracks as many as it needs — two bike rides and twenty miles on the same step, each with its own bar.'
              : 'A goal can track as many as it needs; each gets its own bar.'}
          </p>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || emptied.length > 0}>{busy ? 'Saving…' : 'Save numbers'}</button>
        </div>
      </form>
    </div>
  )
}
