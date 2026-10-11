// GoalsView's state (web/src/components/GoalsView.tsx), held outside the component
// so the composer, the numbers editor and the edit sheet — routes of their own on a
// phone — act on the same list the tab shows. The rules are the web's: every
// mutation answers with the whole goal and the card is patched from that; the
// ‹ › arrows ask the server for the window containing the day just outside the one
// on screen, so the calendar lives only in goals/periods.mjs.
import { useSyncExternalStore } from 'react'
import {
  AuthError, addGoalMetric, clearSecret, deleteGoalMetric, getAppConfig, getGoalOptions, getGoals,
  syncStrava, updateGoalMetric, type AppConfig,
} from '../../lib/api'
import type { Goal, GoalMetricChanges, GoalOptions, GoalPeriod, GoalPeriodShortcut, GoalPeriodType } from '../../lib/goals/types'

export type GoalTab = 'overview' | GoalPeriodShortcut

export interface GoalsState {
  tab: GoalTab
  anchor: { type: GoalPeriodType; start: string } | null
  window: GoalPeriod | null
  goals: Goal[]
  options: GoalOptions | null
  bushido: AppConfig['bushido']
  loading: boolean
  busy: boolean
  syncing: boolean
  error: string
  /** Bumped after a write so the overview re-reads its windows. */
  overviewKey: number
}

let state: GoalsState = {
  tab: 'this_week', anchor: null, window: null, goals: [], options: null, bushido: null,
  loading: true, busy: false, syncing: false, error: '', overviewKey: 0,
}
const listeners = new Set<() => void>()
const set = (patch: Partial<GoalsState>) => { state = { ...state, ...patch }; for (const fn of listeners) fn() }
export const getGoalsState = () => state

export function useGoals(): GoalsState {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn) }, () => state)
}

/** `this_week` → `week`. */
export const typeOf = (shortcut: GoalPeriodShortcut): GoalPeriodType => shortcut.split('_')[1] as GoalPeriodType
/** The composer's default and the arrows' unit when Overview is showing. */
export const periodOf = (s: GoalsState): GoalPeriodShortcut => (s.tab === 'overview' ? 'this_week' : s.tab)

const addDays = (key: string, n: number): string => {
  const d = new Date(`${key}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const message = (cause: unknown, fallback: string) => {
  if (cause instanceof AuthError) { clearSecret(); return 'Session expired' }
  return cause instanceof Error ? cause.message : fallback
}

let configAsked = false
let seq = 0

export async function load(): Promise<void> {
  if (!configAsked) { configAsked = true; getAppConfig().then((c) => set({ bushido: c.bushido })).catch(() => { configAsked = false }) }
  if (state.tab === 'overview') { set({ loading: false }); return }
  const query = state.anchor ?? state.tab
  const mine = ++seq
  set({ loading: true, error: '' })
  try {
    const [list, opts] = await Promise.all([getGoals(query), state.options ? Promise.resolve(state.options) : getGoalOptions()])
    if (mine !== seq) return // a newer tab or arrow press won
    set({ goals: list.goals, window: list.period, options: opts, loading: false })
  } catch (cause) {
    if (mine === seq) set({ error: message(cause, 'Goals could not load.'), loading: false })
  }
}

/** A tab always lands on its own window; a walk back does not survive a switch. */
export function pick(tab: GoalTab) { set({ tab, anchor: null, goals: tab === state.tab ? state.goals : [] }); void load() }

export function step(direction: -1 | 1) {
  const { window, tab } = state
  if (!window || tab === 'overview') return
  set({ anchor: { type: typeOf(tab), start: direction < 0 ? addDays(window.start, -1) : addDays(window.end, 1) } })
  void load()
}

export function resetAnchor() { set({ anchor: null }); void load() }

export const setError = (error: string) => set({ error })

/** Run a mutation; swap the answered goal into the list, or reload. */
export async function apply(run: () => Promise<{ goal?: Goal }>): Promise<boolean> {
  set({ busy: true, error: '' })
  try {
    const result = await run()
    if (result.goal) {
      const updated = result.goal
      set({ goals: state.goals.map((g) => (g.id === updated.id ? updated : g)) })
    } else {
      await load()
    }
    set({ overviewKey: state.overviewKey + 1 })
    return true
  } catch (cause) {
    set({ error: message(cause, 'That did not work.') })
    return false
  } finally { set({ busy: false }) }
}

/** Sequential on purpose: the last answer is the goal with every change in it. */
export const saveMetrics = (targetId: string, changes: GoalMetricChanges) => apply(async () => {
  let latest: Goal | undefined
  for (const id of changes.removed) latest = (await deleteGoalMetric(id)).goal
  for (const { id, patch } of changes.updated) latest = (await updateGoalMetric(id, patch)).goal
  for (const metric of changes.added) latest = (await addGoalMetric(targetId, metric)).goal
  return latest ? { goal: latest } : {}
})

/** Refresh means "make these numbers current": pull from Strava first, then reload. */
export async function refresh(): Promise<void> {
  set({ syncing: true })
  let note = ''
  try { await syncStrava() } catch (cause) {
    if (cause instanceof AuthError) { clearSecret(); set({ syncing: false }); return }
    note = cause instanceof Error ? cause.message : 'Strava did not answer.'
  }
  if (state.tab !== 'overview') await load()
  else set({ overviewKey: state.overviewKey + 1 })
  if (note && !state.error) set({ error: `Strava didn’t sync — ${note}. Showing the last numbers it gave.` })
  set({ syncing: false })
}

/** After the composer: land on the period the goal was filed under. */
export async function afterCreate(period: GoalPeriodShortcut) {
  set({ overviewKey: state.overviewKey + 1 })
  if (state.anchor || period !== state.tab) pick(period)
  else await load()
}

export const goalById = (id: string): Goal | undefined => state.goals.find((g) => g.id === id)
