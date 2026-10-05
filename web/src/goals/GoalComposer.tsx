import React, { useState } from 'react'
import { Hi, PlusIcon, XMarkIcon } from '../icons'
import MetricFields, { emptyMetric, labelOf, sourceConfigOf } from './metricFields'
import type { MetricDraft } from './metricFields'
import { PERIOD_LABELS } from './types'
import type { GoalOptions, GoalPeriodShortcut, NewGoalInput } from './types'

const COMPOSER_PERIODS: GoalPeriodShortcut[] = [
  'this_week', 'next_week', 'this_month', 'next_month',
  'this_year', 'next_year',
]

/**
 * Compose a goal.
 *
 * Deliberately shallow: a title, a period, and any numbers it tracks. Steps are added
 * on the card afterwards rather than here, because a goal with nine steps typed up
 * front is a form, and the thing this has to stay faster than is a paper notebook.
 *
 * The numbers themselves are `MetricFields`, shared with `GoalNumbers` — which edits
 * the same numbers once the goal exists, so nothing typed here is a decision you are
 * stuck with.
 */
export default function GoalComposer({ options, period, onCancel, onCreate, busy, error = '' }: {
  options: GoalOptions | null
  period: GoalPeriodShortcut
  onCancel: () => void
  onCreate: (input: NewGoalInput) => void
  busy: boolean
  error?: string
}) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [metrics, setMetrics] = useState<MetricDraft[]>([])
  const [selectedPeriod, setSelectedPeriod] = useState(period)

  const patch = (index: number, change: Partial<MetricDraft>) =>
    setMetrics((current) => current.map((m, j) => (index === j ? { ...m, ...change } : m)))

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return
    onCreate({
      title: trimmed,
      notes: notes.trim() || undefined,
      period: selectedPeriod,
      metrics: metrics
        .filter((m) => labelOf(m, trimmed).trim() && Number(m.targetValue) > 0)
        .map((m) => ({
          label: labelOf(m, trimmed).trim(),
          unit: m.unit.trim() || undefined,
          targetValue: Number(m.targetValue),
          sourceKind: m.sourceKind,
          sourceConfig: sourceConfigOf(m),
        })),
    })
  }

  const unitGroups = Object.entries(options?.units ?? {})

  return (
    <div className="modal-backdrop goal-composer-backdrop" onMouseDown={onCancel}>
      <form
        className="event-modal goal-composer" role="dialog" aria-modal="true" aria-labelledby="new-goal-title"
        onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') onCancel() }}
      >
        <div className="modal-head">
          <div>
            <div className="modal-kicker">Weekly, monthly, or yearly</div>
            <h2 id="new-goal-title">New goal</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="Close"><Hi icon={XMarkIcon} size={20} /></button>
        </div>

        <label className="field">
          Goal
          <input
            autoFocus value={title} placeholder="What do you want to be true by the end?"
            aria-label="Goal title" onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="field">
          Period
          <select aria-label="Goal period" value={selectedPeriod} onChange={(e) => setSelectedPeriod(e.target.value as GoalPeriodShortcut)}>
            {COMPOSER_PERIODS.map((value) => <option key={value} value={value}>{PERIOD_LABELS[value]}</option>)}
          </select>
        </label>

        <label className="field">
          Notes <span className="muted">Optional</span>
          <textarea value={notes} placeholder="Anything useful to remember" aria-label="Notes" onChange={(e) => setNotes(e.target.value)} />
        </label>

        {error && <p className="goals-error goal-composer-error" role="alert">{error}</p>}

        {metrics.map((metric, i) => (
          <MetricFields
            key={i} metric={metric} legend={`Number ${i + 1}`} units={unitGroups} mirrorTitle={title}
            onChange={(change) => patch(i, change)}
            onRemove={() => setMetrics(metrics.filter((_, j) => j !== i))}
            removeLabel={`Remove number ${i + 1}`}
          />
        ))}

        <div className="goal-composer-number-row">
          <button type="button" className="btn compact" onClick={() => setMetrics([...metrics, emptyMetric()])}><Hi icon={PlusIcon} size={13} /> Track a number</button>
          <p className="muted">No number means you mark it done yourself.</p>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !title.trim()}>{busy ? 'Adding…' : 'Add goal'}</button>
        </div>
      </form>
    </div>
  )
}
