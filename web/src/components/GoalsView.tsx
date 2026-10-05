import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AuthError, addGoalMetric, addGoalStep, createGoal, deleteGoal, deleteGoalMetric, getGoalOptions,
  getGoals, linkGoal, logGoalMetric, postponeGoal, setGoalComplete, syncStrava, unlinkGoal,
  updateGoal, updateGoalMetric, getAppConfig,
} from '../api'
import type { AppConfig } from '../api'
import { ArrowPathIcon, ChevronLeftIcon, ChevronRightIcon, Hi, PlusIcon, Squares2X2Icon, TrophyIcon } from '../icons'
import GoalCard from '../goals/GoalCard'
import GoalComposer from '../goals/GoalComposer'
import GoalsOverview from '../goals/GoalsOverview'
import { PERIOD_LABELS } from '../goals/types'
import type { Goal, GoalMetricChanges, GoalOptions, GoalPeriod, GoalPeriodQuery, GoalPeriodShortcut, GoalPeriodType } from '../goals/types'

// No quarter: weekly plans rarely use them in them, and a tab that is always empty is a tab
// you learn to skip. The period type itself still exists in the schema and the API.
const PERIODS: GoalPeriodShortcut[] = ['this_week', 'next_week', 'this_month', 'this_year']

/**
 * The strip across the top is one control, not two.
 *
 * Overview sits in the same row as the periods because it answers the same question —
 * "which goals am I looking at" — and a separate toggle beside the tabs would imply it
 * is a mode you can be in *as well as* a period, which it isn't.
 */
type GoalTab = 'overview' | GoalPeriodShortcut

/** The type a shortcut names: `this_week` → `week`. */
const typeOf = (shortcut: GoalPeriodShortcut): GoalPeriodType => shortcut.split('_')[1] as GoalPeriodType

/** A day key moved by `n` days. Calendar arithmetic only, so no timezone can bend it. */
const addDays = (key: string, n: number): string => {
  const d = new Date(`${key}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export default function GoalsView({ onAuthError }: { onAuthError: () => void }) {
  const [goals, setGoals] = useState<Goal[]>([])
  // Bushido is an optional sibling app: null until BUSHIDO_URL is configured.
  const [bushido, setBushido] = useState<AppConfig['bushido']>(null)
  useEffect(() => { getAppConfig().then((c) => setBushido(c.bushido)).catch(() => {}) }, [])
  const [options, setOptions] = useState<GoalOptions | null>(null)
  const [tab, setTab] = useState<GoalTab>('this_week')
  /*
   * Where the ‹ › arrows have walked to, or null while the tab shows its own window.
   *
   * A tab names a window relative to today ("this week"), so the week that ended last
   * night vanished from it on Monday morning, taking with it the only place to see
   * what actually got done. The arrows step to any period of the tab's type, asking
   * the server for the window containing the day just outside the one on screen. The
   * client never learns where a week starts; it only knows "the day before" — so the
   * calendar lives in exactly one place, goals/periods.mjs, arrows or no arrows.
   */
  const [anchor, setAnchor] = useState<{ type: GoalPeriodType; start: string } | null>(null)
  // The window the list is showing, from the server. Held separately from the goals
  // because an empty week still needs a name and a pair of dates to step from.
  const [window, setWindow] = useState<GoalPeriod | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [composing, setComposing] = useState(false)
  const [syncing, setSyncing] = useState(false)
  // Bumped after a write so the overview re-reads all four windows; it holds its own
  // copy of the goals and has no way to know a card elsewhere changed.
  const [overviewKey, setOverviewKey] = useState(0)

  // Overview reads every window itself, so it has no single period. The composer and
  // the "add a goal" default still need one, and this week is the right guess there.
  const period: GoalPeriodShortcut = tab === 'overview' ? 'this_week' : tab
  const showing = tab !== 'overview'
  const query: GoalPeriodQuery = anchor ?? period
  const anchored = anchor !== null

  const load = useCallback(async () => {
    if (!showing) { setLoading(false); return }
    setLoading(true); setError('')
    try {
      const [list, opts] = await Promise.all([getGoals(query), options ? Promise.resolve(options) : getGoalOptions()])
      setGoals(list.goals)
      setWindow(list.period)
      setOptions(opts)
    } catch (cause) {
      if (cause instanceof AuthError) onAuthError()
      else setError(cause instanceof Error ? cause.message : 'Goals could not load.')
    } finally { setLoading(false) }
  }, [query, showing, options, onAuthError])

  useEffect(() => { void load() }, [tab, anchor])

  // Choosing a tab always lands on that tab's own window; a walk back is not a mode
  // that should survive switching from weeks to months.
  const pick = useCallback((next: GoalTab) => { setTab(next); setAnchor(null) }, [])

  // One period of the tab's type earlier or later than the one on screen.
  const step = useCallback((direction: -1 | 1) => {
    if (!window || !showing) return
    setAnchor({ type: typeOf(period), start: direction < 0 ? addDays(window.start, -1) : addDays(window.end, 1) })
  }, [window, showing, period])

  // Every mutation answers with the whole goal, so the list is patched from the server's
  // own shape rather than from a guess — which is what keeps a rolled-up total honest
  // after logging against a step.
  const apply = useCallback(async (run: () => Promise<{ goal?: Goal }>) => {
    setBusy(true); setError('')
    try {
      const result = await run()
      if (result.goal) {
        const updated = result.goal
        setGoals((current) => current.map((g) => (g.id === updated.id ? updated : g)))
      } else {
        await load()
      }
      setOverviewKey((n) => n + 1)
    } catch (cause) {
      if (cause instanceof AuthError) onAuthError()
      else setError(cause instanceof Error ? cause.message : 'That did not work.')
    } finally { setBusy(false) }
  }, [load, onAuthError])

  /*
   * Refresh means "make these numbers current", not "read the same cache again".
   *
   * A `strava_distance` metric resolves out of the local activity cache, which
   * `strava-sync` fills every few hours — so this morning's ride is genuinely not in the
   * number until that job runs, and a button that only re-read the cache would redraw the
   * identical figure and look broken. It pulls from Strava first.
   *
   * This is the one place allowed to spend an API read, and only because a person pressed
   * it. `goals/sources.mjs` still never syncs on its own: a dashboard left open on a
   * second monitor must not be able to burn a rate limit.
   *
   * A failed sync does not stop the reload. Strava may simply not be connected, and
   * refusing to show goals over that would be punishing the wrong thing — so the cached
   * numbers still render and the reason appears beside them.
   */
  const refresh = useCallback(async () => {
    setSyncing(true)
    let note = ''
    try {
      await syncStrava()
    } catch (cause) {
      if (cause instanceof AuthError) { onAuthError(); setSyncing(false); return }
      note = cause instanceof Error ? cause.message : 'Strava did not answer.'
    }
    if (showing) await load()
    else setOverviewKey((n) => n + 1)
    // Never over an error the reload itself raised — that one is the more useful of the two.
    if (note) setError((current) => current || `Strava didn’t sync — ${note}. Showing the last numbers it gave.`)
    setSyncing(false)
  }, [showing, load, onAuthError])

  /*
   * A round of metric edits, applied one endpoint at a time.
   *
   * Sequential rather than parallel, and deliberately so: each call answers with the
   * whole goal, so the last response is the one that reflects every earlier change.
   * Fired together, whichever landed last would win and the card would render a goal
   * missing the edits that finished first. Removals go before additions so a goal whose
   * numbers were swapped wholesale never briefly holds both.
   *
   * `targetId` is the goal's own id, or a step's. A step is a goal row, so the same
   * three endpoints take it and every answer is still the whole top-level goal — which
   * is what keeps the card's rolled-up total honest after editing a step's numbers.
   */
  const saveMetrics = useCallback((targetId: string, changes: GoalMetricChanges) => apply(async () => {
    let latest: Goal | undefined
    for (const id of changes.removed) latest = (await deleteGoalMetric(id)).goal
    for (const { id, patch } of changes.updated) latest = (await updateGoalMetric(id, patch)).goal
    for (const metric of changes.added) latest = (await addGoalMetric(targetId, metric)).goal
    return latest ? { goal: latest } : {}
  }), [apply])

  /*
   * In Bushido, or not. Linking is an ordinary `url` bookmark — see GoalCard — so
   * this needs no new endpoint: it is the link tools Totem already has, behind a
   * button instead of a URL field. Both calls return the updated goal, so `apply`
   * swaps the card in place and the chip flips without a reload.
   */
  const toggleBushido = useCallback((goal: Goal, current: { id: string } | null) => apply(() => (
    current
      ? unlinkGoal(current.id)
      : bushido ? linkGoal(goal.id, { kind: 'url', url: bushido.url, label: 'Bushido' }) : Promise.resolve({})
  )), [apply, bushido])

  /*
   * A goal you have stopped doing STAYS WHERE IT IS, crossed off.
   *
   * It used to drop to the bottom with the finished ones, which made "not doing this"
   * behave like a delete you could not see the result of — the card left the list, and
   * the thing you decided about was gone from the place you decided it. Crossed off in
   * place is the whole point: the decision is visible next to the week it was made
   * about, and it is one click to take back. It still is not counted among the done.
   */
  const { open, done, stopped } = useMemo(() => ({
    open: goals.filter((g) => !g.complete),
    done: goals.filter((g) => g.complete),
    stopped: goals.filter((g) => g.abandoned && !g.complete),
  }), [goals])

  const unit = typeOf(period)

  return (
    <div className="view goals">
      <div className="goals-head">
        <div className="goals-periods" role="tablist" aria-label="Goal period">
          <button
            role="tab" aria-selected={tab === 'overview'}
            className={`btn compact${tab === 'overview' ? ' on' : ''}`}
            onClick={() => pick('overview')}
          ><Hi icon={Squares2X2Icon} size={13} /> Overview</button>
          {PERIODS.map((p) => (
            <button
              key={p} role="tab" aria-selected={p === tab}
              className={`btn compact period-${typeOf(p)}${p === tab ? ' on' : ''}`}
              onClick={() => pick(p)}
            >{PERIOD_LABELS[p]}</button>
          ))}
        </div>
        <span className="goals-head-actions">
          <button
            className="btn compact"
            onClick={() => void refresh()}
            disabled={syncing}
            aria-label="Sync Strava and reload goals"
            title="Pull new activities from Strava, then reload"
          ><Hi icon={ArrowPathIcon} size={14} className={syncing ? 'spin' : ''} /></button>
          <button className="btn compact primary" onClick={() => { setError(''); setComposing((v) => !v) }}><Hi icon={PlusIcon} size={13} /> Goal</button>
        </span>
      </div>

      {window && showing && (
        <p className="goals-window muted">
          {/* The arrows walk to any period of this type — last week, the week before,
              the month before that — so a finished week stays somewhere it can be
              read, not just somewhere it once was. */}
          <button type="button" className="goals-window-step" onClick={() => step(-1)} aria-label={`Previous ${unit}`} title={`Previous ${unit}`}>
            <Hi icon={ChevronLeftIcon} size={13} />
          </button>
          <span className={`goals-window-label${anchored ? ' anchored' : ''}`}>{window.label}</span>
          <button type="button" className="goals-window-step" onClick={() => step(1)} aria-label={`Next ${unit}`} title={`Next ${unit}`}>
            <Hi icon={ChevronRightIcon} size={13} />
          </button>
          {anchored && (
            <button type="button" className="goals-window-reset" onClick={() => setAnchor(null)}>
              Back to {PERIOD_LABELS[period].toLowerCase()}
            </button>
          )}
          {goals.length > 0 && <span>· {done.length} of {goals.length} done</span>}
          {stopped.length > 0 && <span>· {stopped.length} not doing</span>}
        </p>
      )}

      {error && <p className="goals-error">{error}</p>}

      {composing && (
        <GoalComposer
          options={options} period={period} busy={busy} error={error}
          onCancel={() => setComposing(false)}
          onCreate={(input) => {
            void (async () => {
              setBusy(true); setError('')
              try {
                await createGoal(input)
                setComposing(false)
                setOverviewKey((n) => n + 1)
                // Land on the period the goal was filed under, so it is visible rather
                // than filed somewhere you have to go looking for it — which includes
                // walking back from an older week the arrows had opened.
                const target = input.period ?? period
                if (anchored || target !== tab) pick(target)
                else await load()
              } catch (cause) {
                if (cause instanceof AuthError) onAuthError()
                else setError(cause instanceof Error ? cause.message : 'That goal could not be added.')
              } finally { setBusy(false) }
            })()
          }}
        />
      )}

      {!showing ? (
        <GoalsOverview onOpenPeriod={pick} onAuthError={onAuthError} reloadKey={overviewKey} />
      ) : loading ? <p className="empty">Loading…</p> : goals.length === 0 ? (
        <div className="empty">
          <Hi icon={TrophyIcon} size={26} />
          <p>Nothing set for {anchored && window ? window.label : PERIOD_LABELS[period].toLowerCase()}.</p>
        </div>
      ) : (
        <>
          <div className="goals-list">
            {open.map((goal) => (
              <GoalCard
                key={goal.id} goal={goal} busy={busy} options={options}
                onToggle={() => apply(() => setGoalComplete(goal.id, !goal.complete))}
                onToggleStep={(id, complete) => apply(() => setGoalComplete(id, complete))}
                onLog={(metricId, patch) => apply(() => logGoalMetric(metricId, patch))}
                onPostpone={() => apply(async () => { await postponeGoal(goal.id); await load(); return {} })}
                onDelete={() => apply(async () => { await deleteGoal(goal.id); await load(); return {} })}
                onEdit={(patch) => apply(() => updateGoal(goal.id, patch))}
                onAbandon={(abandoned) => apply(() => updateGoal(goal.id, { abandoned }))}
                onAbandonStep={(id, abandoned) => apply(() => updateGoal(id, { abandoned }))}
                onRenameStep={(id, title) => apply(() => updateGoal(id, { title }))}
                onAddStep={(title) => apply(() => addGoalStep(goal.id, { title }))}
                onSaveMetrics={(changes) => saveMetrics(goal.id, changes)}
                onSaveStepMetrics={(stepId, changes) => saveMetrics(stepId, changes)}
                onToggleBushido={bushido ? (current) => toggleBushido(goal, current) : undefined}
                bushidoHosts={bushido?.hosts}
              />
            ))}
          </div>

          {done.length > 0 && (
            <div className="goals-done">
              {/* "Achieved", not "Done": the same list, named after what it is worth
                  rather than after the fact that it is no longer in the way. Only
                  finished goals land here — one you stopped is not an achievement, and
                  it stays up in the list crossed off. */}
              <h4 className="goals-done-head">
                <Hi icon={TrophyIcon} size={13} />
                Achieved
              </h4>
              <div className="goals-list">
                {done.map((goal) => (
                  <GoalCard
                    key={goal.id} goal={goal} busy={busy} options={options}
                    onToggle={() => apply(() => setGoalComplete(goal.id, !goal.complete))}
                    onToggleStep={(id, complete) => apply(() => setGoalComplete(id, complete))}
                    onLog={(metricId, patch) => apply(() => logGoalMetric(metricId, patch))}
                    onPostpone={() => apply(async () => { await postponeGoal(goal.id); await load(); return {} })}
                    onDelete={() => apply(async () => { await deleteGoal(goal.id); await load(); return {} })}
                    onEdit={(patch) => apply(() => updateGoal(goal.id, patch))}
                    onAbandon={(abandoned) => apply(() => updateGoal(goal.id, { abandoned }))}
                    onAbandonStep={(id, abandoned) => apply(() => updateGoal(id, { abandoned }))}
                onRenameStep={(id, title) => apply(() => updateGoal(id, { title }))}
                    onAddStep={(title) => apply(() => addGoalStep(goal.id, { title }))}
                    onSaveMetrics={(changes) => saveMetrics(goal.id, changes)}
                    onSaveStepMetrics={(stepId, changes) => saveMetrics(stepId, changes)}
                    onToggleBushido={bushido ? (current) => toggleBushido(goal, current) : undefined}
                bushidoHosts={bushido?.hosts}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
