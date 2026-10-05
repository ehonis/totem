/**
 * Every horizon at once.
 *
 * The period tabs answer "what am I doing this week". They cannot answer the question
 * underneath it — whether the week is actually pointed at the year — because seeing two
 * periods means clicking between them and holding the first one in your head. This puts
 * the four windows side by side and colours them, so a year with nothing in it is
 * visible as an empty column rather than as a tab you didn't open.
 *
 * Read-only on purpose. Logging, completing and postponing all stay on the card in the
 * period view, where the goal is shown in full; an overview that could quietly complete
 * a yearly goal from a one-line summary would be a good way to complete the wrong one.
 * Every column header is a link into its period instead.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { AuthError, getGoals } from '../api'
import { ArrowRightIcon, Hi, TrophyIcon } from '../icons'
import { GOAL_DONE_ICON, goalIconFor } from './goalIcon'
import type { Goal, GoalPeriodShortcut } from './types'

const COLUMNS: { shortcut: GoalPeriodShortcut; type: string; title: string }[] = [
  { shortcut: 'this_week', type: 'week', title: 'This week' },
  { shortcut: 'this_month', type: 'month', title: 'This month' },
  { shortcut: 'this_year', type: 'year', title: 'This year' },
]

interface Column { goals: Goal[]; error: string }

function GoalLine({ goal }: { goal: Goal }) {
  const Glyph = goal.complete ? GOAL_DONE_ICON : goalIconFor(goal)
  const percent = goal.progress.percent
  return (
    <li className={`goals-overview-goal${goal.complete ? ' done' : ''}${goal.abandoned ? ' not-doing' : ''}`}>
      <Hi icon={Glyph} size={15} />
      <span className="goals-overview-goal-title" title={goal.title}>{goal.title}</span>
      <span className="goals-overview-goal-percent">
        {/* A goal with no numbers on it has no percentage, and a dash says that far
            better than a 0% bar, which reads as a goal being ignored. */}
        {percent === null ? <span className="muted">—</span> : `${percent}%`}
      </span>
      <span className="goals-overview-goal-bar">
        <span style={{ width: `${percent ?? 0}%` }} />
      </span>
    </li>
  )
}

function OverviewColumn({ column, data, loading, onOpen }: {
  column: (typeof COLUMNS)[number]
  data: Column | undefined
  loading: boolean
  onOpen: () => void
}) {
  const goals = data?.goals ?? []
  const done = goals.filter((g) => g.complete).length
  const window = goals[0]?.period
  const daysLeft = goals[0]?.daysLeft

  return (
    <section className={`goals-overview-col period-${column.type}`} aria-label={column.title}>
      <header className="goals-overview-head">
        <span className="goals-overview-dot" aria-hidden="true" />
        <h3>{column.title}</h3>
        <button type="button" className="btn compact goals-overview-open" onClick={onOpen}>
          Open <Hi icon={ArrowRightIcon} size={12} />
        </button>
      </header>

      {/* An empty window has no dates to name — the goals are what carry the period —
          so it says nothing here and lets the empty state below do the talking once. */}
      <p className="goals-overview-sub muted">
        {loading ? 'Loading…' : data?.error ? data.error : window ? (
          <>
            {window.label} · {done} of {goals.length} done
            {typeof daysLeft === 'number' && daysLeft >= 0 && <> · {daysLeft} day{daysLeft === 1 ? '' : 's'} left</>}
          </>
        ) : '\u00a0'}
      </p>

      {/* One bar for the whole window: the share of its goals that are finished. This is
          counting goals, not averaging their progress — half-done is not half-a-goal. */}
      <div className="goals-overview-total" role="img" aria-label={`${done} of ${goals.length} ${column.title.toLowerCase()} goals done`}>
        <span style={{ width: `${goals.length ? (done / goals.length) * 100 : 0}%` }} />
      </div>

      {goals.length === 0 && !loading
        ? <p className="goals-overview-empty muted"><Hi icon={TrophyIcon} size={18} /> Nothing set</p>
        : <ul className="goals-overview-list">{goals.map((goal) => <GoalLine key={goal.id} goal={goal} />)}</ul>}
    </section>
  )
}

export default function GoalsOverview({ onOpenPeriod, onAuthError, reloadKey = 0 }: {
  onOpenPeriod: (period: GoalPeriodShortcut) => void
  onAuthError: () => void
  /** Bumped by the view to re-fetch — after adding a goal, say. */
  reloadKey?: number
}) {
  const [columns, setColumns] = useState<Record<string, Column>>({})
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    // One request per window, in parallel and settled independently: a quarter that
    // fails should cost you the quarter column, not the whole page.
    const results = await Promise.all(COLUMNS.map(async (column) => {
      try {
        return [column.shortcut, { goals: (await getGoals(column.shortcut)).goals, error: '' }] as const
      } catch (cause) {
        if (cause instanceof AuthError) throw cause
        return [column.shortcut, { goals: [], error: cause instanceof Error ? cause.message : 'Could not load.' }] as const
      }
    })).catch((cause) => {
      if (cause instanceof AuthError) onAuthError()
      return [] as (readonly [string, Column])[]
    })
    setColumns(Object.fromEntries(results))
    setLoading(false)
  }, [onAuthError])

  useEffect(() => { void load() }, [load, reloadKey])

  return (
    <div className="goals-overview">
      {COLUMNS.map((column) => (
        <OverviewColumn
          key={column.shortcut}
          column={column}
          data={columns[column.shortcut]}
          loading={loading}
          onOpen={() => onOpenPeriod(column.shortcut)}
        />
      ))}
    </div>
  )
}
