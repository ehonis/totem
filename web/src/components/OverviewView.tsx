import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useOwnerName } from '../useOwnerName'
import { getSettings, setSetting, useSettings } from '../settings'
import { getTodos, getCalendar, getBrain, getUsage, getAssistantUsage, getProductivity, getHabits, getGithubRepos, getAiUsage, getJobs, runJobNow, closeTodo, logHabit, AuthError } from '../api'
import { useAiUsageLive } from '../useAiUsageLive'
import BrainMiniMap from './BrainMiniMap'
import { pushError, pushSuccess } from '../toast'
import { DayModal, HabitCheckButton, HabitMetricInput, HabitMetricSection, QuotaDots, type DaySave } from './HabitsView'
import { QuotaMeter } from './AiUsagePanel'
import type { NavTarget } from '../router'
import {
  fmtInt, fmtUsd, relTime,
  CHANNEL_ORDER, CHANNEL_META,
  ACTIVITY_ORDER, ACTIVITY_META,
  ProductIcon, UsageChip, ComboActivityChart,
} from '../usageMeta'
import {
  Hi,
  CheckCircleIcon,
  CalendarDaysIcon,
  CircleStackIcon,
  BoltIcon,
  MapPinIcon,
  ChevronRightIcon,
  CodeBracketIcon,
  FireIcon,
  PlusIcon,
  MinusIcon,
  ChatBubbleLeftEllipsisIcon,
  ChartBarIcon,
  Bars3Icon,
  WarnIcon,
  ClockIcon,
  PlayIcon,
  ExclamationTriangleIcon,
} from '../icons'

const startOfDay = (d: Date | number | string) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
const isSameDay = (a: Date | number | string, b: Date | number | string) => startOfDay(a).getTime() === startOfDay(b).getTime()

// A task due value is either a date-only "YYYY-MM-DD" or an RFC3339 datetime.
// Date-only strings must NOT go through `new Date(str)` (parsed as UTC midnight,
// which lands a day early west of UTC), so split them into a local date.
const dueToDate = (due: string): Date => {
  if (typeof due === 'string' && due.length <= 10) {
    const [y, m, d] = due.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(due)
}

function dueChip(due: string) {
  if (!due) return null
  const today = startOfDay(new Date())
  const d = startOfDay(dueToDate(due))
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000)
  const cls = diff < 0 ? 'due-overdue' : diff === 0 ? 'due-today' : ''
  const hasTime = due.length > 10
  const label =
    diff < 0 ? dueToDate(due).toLocaleDateString([], { month: 'short', day: 'numeric' })
      : diff === 0 ? (hasTime ? dueToDate(due).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Today')
      : diff === 1 ? 'Tomorrow'
      : dueToDate(due).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  return <span className={`pill ${cls}`}>{label}</span>
}

function eventWhen(ev: any) {
  const d = new Date(ev.start)
  const today = new Date()
  const tom = new Date(); tom.setDate(today.getDate() + 1)
  const day =
    d.toDateString() === today.toDateString() ? 'Today'
      : d.toDateString() === tom.toDateString() ? 'Tomorrow'
      : d.toLocaleDateString([], { weekday: 'short' })
  const time = ev.allDay ? 'all day' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${day} · ${time}`
}

// ---- habit date + period helpers (local "YYYY-MM-DD" strings; the bridge owns
// what "today" is, matching HabitsView so the two views agree) ----
const habToDate = (iso: string): Date => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d) }
const habToISO = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const habAddDays = (iso: string, n: number): string => { const d = habToDate(iso); d.setDate(d.getDate() + n); return habToISO(d) }
const weekStartOf = (iso: string): string => habAddDays(iso, -habToDate(iso).getDay())

// Completions in the cadence period containing `date` (day / Sun–Sat week /
// calendar month) — the same rule HabitsView uses to decide "done".
function periodTotal(habit: any, entries: any, date: string): number {
  if (habit.cadence === 'weekly') {
    const start = weekStartOf(date)
    let t = 0
    for (let i = 0; i < 7; i++) t += entries[habAddDays(start, i)]?.[habit.id]?.count || 0
    return t
  }
  if (habit.cadence === 'monthly') {
    const ym = date.slice(0, 7)
    let t = 0
    for (const [d, day] of Object.entries<any>(entries)) if (d.startsWith(ym)) t += day[habit.id]?.count || 0
    return t
  }
  return entries[date]?.[habit.id]?.count || 0
}

// Wiring the board hands each card so it can be picked up and dropped. Absent on
// touch/narrow screens, where the tiles are a plain single-column stack.
interface TileDrag {
  id: string
  dragging: boolean
  dropTarget: boolean
  onStart: (id: string) => void
  onOver: (id: string) => void
  onDrop: (id: string) => void
  onEnd: () => void
  onNudge: (id: string, delta: number) => void
}

interface CardProps {
  icon: any
  title: string
  count?: any
  accent?: string
  onView?: () => void
  viewLabel?: string
  className?: string
  drag?: TileDrag | null
  children?: React.ReactNode
}

// A card shell with a titled header and an optional "view" affordance. The whole
// header is clickable when `onView` is set so the title reads as a doorway into
// the dedicated tab. When `drag` is supplied the card is also a board tile: it
// grows a grip handle and accepts drops from its siblings.
function Card({ icon, title, count, accent, onView, viewLabel = 'View all', className = '', drag, children }: CardProps) {
  const ref = useRef<HTMLElement>(null)
  const cls = [
    'ov-card',
    className,
    drag?.dragging ? 'dragging' : '',
    drag?.dropTarget ? 'drop-target' : '',
  ].filter(Boolean).join(' ')

  return (
    <section
      ref={ref}
      className={cls}
      onDragOver={drag ? (e) => { e.preventDefault(); drag.onOver(drag.id) } : undefined}
      onDrop={drag ? (e) => { e.preventDefault(); drag.onDrop(drag.id) } : undefined}
    >
      <header className="ov-card-head">
        <span className="ov-card-title">
          {drag && (
            <button
              type="button"
              className="ov-drag-handle"
              draggable
              // Drag the whole tile as the ghost, not the 20px grip itself.
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                if (ref.current) e.dataTransfer.setDragImage(ref.current, 28, 24)
                drag.onStart(drag.id)
              }}
              onDragEnd={drag.onEnd}
              // Arrow keys move the tile without a mouse, one slot at a time.
              onKeyDown={(e) => {
                const delta = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1
                  : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0
                if (!delta) return
                e.preventDefault()
                drag.onNudge(drag.id, delta)
              }}
              title="Drag to rearrange (or focus and use arrow keys)"
              aria-label={`Move the ${title} card`}
            >
              <Hi icon={Bars3Icon} size={15} />
            </button>
          )}
          <span className="ov-card-ico" style={accent ? { color: accent, background: `${accent}1f` } : undefined}>
            <Hi icon={icon} size={15} />
          </span>
          {title}
          {count != null && <span className="ov-card-count">{count}</span>}
        </span>
        {onView && (
          <button className="ov-card-link" onClick={onView}>
            {viewLabel}<Hi icon={ChevronRightIcon} size={14} />
          </button>
        )}
      </header>
      <div className="ov-card-body">{children}</div>
    </section>
  )
}

// ---- board layout ---------------------------------------------------------
// Every tile that can sit on the Home board, in factory order. A saved layout is
// reconciled against this list, so a tile added here later still appears (at the
// end) for someone who already dragged their board into shape, and a tile removed
// here disappears cleanly from their saved order.
// The activity tile always spans the full board width (its chart needs the room);
// that's expressed in CSS on `.ov-card.ov-activity` rather than tracked here.
const BOARD_TILES = ['habits', 'todos', 'activity', 'jobs', 'calendar', 'providers', 'repos', 'brain']

// Graphs pinned from the Habits tab get their own board tile, addressed by habit.
// The pin itself lives on the habit (so it follows the owner across devices); only
// where the tile sits is local.
const metricTileId = (habitId: string) => `metric:${habitId}`

function resolveOrder(saved: unknown, extra: string[] = []): string[] {
  const all = [...BOARD_TILES, ...extra]
  const seen = new Set<string>()
  // Tolerate anything localStorage hands back — a bad value just means defaults.
  const kept = (Array.isArray(saved) ? saved : []).filter((id) => all.includes(id) && !seen.has(id) && seen.add(id))
  return [...kept, ...all.filter((id) => !seen.has(id))]
}

// Dragging is desktop-only: HTML5 drag events don't fire from a touch, and the
// board is a single column on a phone anyway. `hover: hover` keeps the handle off
// touch tablets that are wide enough to pass the width check.
function useBoardDragging(): boolean {
  const query = '(min-width: 721px) and (hover: hover)'
  const [enabled, setEnabled] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setEnabled(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return enabled
}

// One habit in the overview's quick check-in — same tap-to-complete behaviour as
// the full Habits tab, trimmed to fit the card.
interface OvHabitRowProps {
  habit: any
  entry: any
  count: number
  periodCount: number
  busy: boolean
  onLog: (habit: any, delta: number) => void
  onValue: (habit: any, value: number | null) => void
  onNote: (habit: any) => void
}

function OvHabitRow({ habit, entry, count, periodCount, busy, onLog, onValue, onNote }: OvHabitRowProps) {
  const done = periodCount >= habit.target
  return (
    <div className={`habit-row ${done ? 'done' : ''}`}>
      <span className="habit-dot" style={{ background: habit.color }} />
      <div className="habit-row-main">
        <div className="habit-row-name">{habit.name}</div>
        {entry?.note && <div className="habit-row-sub">{entry.note}</div>}
      </div>
      {habit.cadence !== 'daily' && <QuotaDots habit={habit} count={periodCount} compact />}
      {habit.metric && <HabitMetricInput habit={habit} entry={entry} busy={busy} onValue={onValue} />}
      <button
        className={`icon-btn habit-note-btn ${entry?.note ? 'has-note' : ''}`}
        title={entry?.note ? `Note: ${entry.note}` : 'Add a note'}
        onClick={() => onNote(habit)}
      >
        <Hi icon={ChatBubbleLeftEllipsisIcon} size={17} />
      </button>
      {habit.cadence === 'daily' && habit.target > 1 ? (
        <div className="habit-stepper">
          <button className="habit-step" onClick={() => onLog(habit, -1)} disabled={busy || count <= 0} aria-label={`Undo one ${habit.name}`}>
            <Hi icon={MinusIcon} size={16} />
          </button>
          <span className="habit-count" style={count > 0 ? { color: habit.color } : undefined}>
            {count}<small>/{habit.target}</small>
          </span>
          <button className="habit-step" onClick={() => onLog(habit, +1)} disabled={busy} aria-label={`Log one ${habit.name}`}>
            <Hi icon={PlusIcon} size={16} />
          </button>
        </div>
      ) : (
        <HabitCheckButton habit={habit} count={count} periodCount={periodCount} busy={busy} onLog={onLog} />
      )}
    </div>
  )
}

// Usage lives partway down Settings ▸ Providers, so the tiles that say "Usage"
// deep-link to the section itself rather than dropping you at the top of Settings.
const USAGE_SECTION = { tab: 'settings', sub: 'providers', hash: 'usage' }
// The Jobs pane is Studio's second sub-tab. Its route id is still 'workflows' for
// the sake of existing links, even though the label reads Jobs.
const JOBS_SECTION = { tab: 'studio', sub: 'workflows' }

// Deliberately terser than the Jobs pane's wording: on the board there's room for
// "in 3h", not "Today 11:00 AM (in 3h 5m)".
function ovJobWhen(ts: number): string {
  const diff = ts - Date.now()
  if (diff < 0) return 'due now'
  const mins = Math.round(diff / 60000)
  if (mins < 60) return `in ${Math.max(mins, 1)}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}

interface OverviewViewProps {
  onNavigate: (target: NavTarget) => void
  onAuthError: () => void
}

export default function OverviewView({ onNavigate, onAuthError }: OverviewViewProps) {
  const [data, setData] = useState<any>({ todos: null, cal: null, brain: null, usage: null, assistant: null, prod: null, habits: null, github: null, jobs: null })
  const [errs, setErrs] = useState<any>({})
  const ownerName = useOwnerName()
  // Ids completed inline from the overview - filtered out optimistically so the
  // list reacts instantly while the close request is in flight.
  const [doneIds, setDoneIds] = useState<Set<any>>(() => new Set())
  const [habitBusy, setHabitBusy] = useState<Set<string>>(() => new Set())
  // Habit whose note/count is being edited from the overview card, if any.
  const [habitNote, setHabitNote] = useState<any>(null)
  // Live quota overlay: the board's Providers tile should drop as usage happens,
  // not wait for the next full board reload.
  const { data: liveAi } = useAiUsageLive({ onAuthError })
  useEffect(() => {
    if (!liveAi) return
    setData((d: any) => ({ ...d, ai: liveAi }))
  }, [liveAi])

  // --- board layout: tile order lives in settings, so it survives reloads ---
  const settings = useSettings()
  const canDrag = useBoardDragging()
  // Habits whose metric graph is pinned, in check-in order.
  const pinnedMetrics = useMemo(
    () => (data.habits?.habits || []).filter((h: any) => !h.archived && h.metric?.pinned),
    [data.habits],
  )
  const pinnedIds = useMemo(() => pinnedMetrics.map((h: any) => metricTileId(h.id)), [pinnedMetrics])
  const order = useMemo(() => resolveOrder(settings.overviewOrder, pinnedIds), [settings.overviewOrder, pinnedIds])
  const customized = order.join() !== [...BOARD_TILES, ...pinnedIds].join()
  const [draggedTile, setDraggedTile] = useState<string | null>(null)
  const [dropTile, setDropTile] = useState<string | null>(null)
  // The drag callbacks are stable across renders, so they read the current pins
  // from a ref rather than closing over a stale list.
  const pinnedRef = useRef<string[]>(pinnedIds)
  pinnedRef.current = pinnedIds

  // Move `id` to the slot `toId` currently occupies, shifting the rest along.
  const moveTile = useCallback((id: string, toId: string) => {
    setDraggedTile(null)
    setDropTile(null)
    if (!id || id === toId) return
    const next = resolveOrder(getSettings().overviewOrder, pinnedRef.current)
    const from = next.indexOf(id)
    const to = next.indexOf(toId)
    if (from < 0 || to < 0) return
    next.splice(to, 0, next.splice(from, 1)[0])
    setSetting('overviewOrder', next)
  }, [])

  // Keyboard equivalent: shift one slot in either direction.
  const nudgeTile = useCallback((id: string, delta: number) => {
    const cur = resolveOrder(getSettings().overviewOrder, pinnedRef.current)
    const to = cur.indexOf(id) + delta
    if (to < 0 || to >= cur.length) return
    moveTile(id, cur[to])
  }, [moveTile])

  const tileDrag = useCallback((id: string): TileDrag | null => (canDrag ? {
    id,
    dragging: draggedTile === id,
    dropTarget: Boolean(draggedTile && dropTile === id && draggedTile !== id),
    onStart: setDraggedTile,
    onOver: setDropTile,
    onDrop: (toId: string) => moveTile(draggedTile || '', toId),
    onEnd: () => { setDraggedTile(null); setDropTile(null) },
    onNudge: nudgeTile,
  } : null), [canDrag, draggedTile, dropTile, moveTile, nudgeTile])
  const [calScope, setCalScope] = useState('today') // 'today' | 'week'

  const load = useCallback(async () => {
    const run = async (key: string, fn: () => Promise<any>) => {
      try { return [key, await fn(), null] }
      catch (e: any) {
        if (e instanceof AuthError) { onAuthError(); return [key, null, 'auth'] }
        return [key, null, e.message]
      }
    }
    const results = await Promise.all([
      run('todos', getTodos),
      run('habits', () => getHabits()),
      run('cal', () => getCalendar(7)),
      run('prod', getProductivity),
      run('brain', getBrain),
      run('usage', getUsage),
      run('assistant', getAssistantUsage),
      run('github', () => getGithubRepos()),
      run('ai', () => getAiUsage()),
      run('jobs', () => getJobs()),
    ])
    const d: any = {}, e: any = {}
    for (const [k, v, err] of results) { d[k] = v; if (err) e[k] = err }
    setData(d); setErrs(e); setDoneIds(new Set())
  }, [onAuthError])

  useEffect(() => { load() }, [load])

  // Run a job straight from the board. Doesn't touch its schedule — the button is
  // for "is this thing working", which is the question the tile exists to answer.
  const [jobBusy, setJobBusy] = useState<string | null>(null)
  const runJob = useCallback(async (job: any) => {
    setJobBusy(job.id)
    try {
      const p = await runJobNow(job.id)
      setData((d: any) => ({ ...d, jobs: p }))
      if (p?.run?.status === 'error') pushError(`${job.name} failed: ${p.run.error}`)
      else pushSuccess(`${job.name} ran`)
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError()
      pushError(e.message || String(e))
    } finally {
      setJobBusy(null)
    }
  }, [onAuthError])

  const completeTodo = useCallback(async (id: string) => {
    setDoneIds((s) => new Set(s).add(id))
    try {
      await closeTodo(id)
      // Reflect the completion in the productivity feed without a full reload.
      setData((d: any) => (d.prod ? { ...d, prod: { ...d.prod, today: d.prod.today + 1, completed: (d.prod.completed || 0) + 1, total: d.prod.total + 1 } } : d))
    } catch (e) {
      if (e instanceof AuthError) { onAuthError(); return }
      // Roll the row back into view if the close didn't take.
      setDoneIds((s) => { const n = new Set(s); n.delete(id); return n })
    }
  }, [onAuthError])

  // One-tap habit logging from the overview. The bridge returns the full refreshed
  // habits payload, so we just swap it in; a per-habit busy flag stops double-taps.
  const logHabitDelta = useCallback(async (habit: any, delta: number) => {
    const today = data.habits?.today
    if (!today || habitBusy.has(habit.id)) return
    setHabitBusy((s) => new Set(s).add(habit.id))
    try {
      const payload = await logHabit({ id: habit.id, date: today, delta })
      setData((d: any) => ({ ...d, habits: payload }))
    } catch (e) {
      if (e instanceof AuthError) onAuthError()
    } finally {
      setHabitBusy((s) => { const n = new Set(s); n.delete(habit.id); return n })
    }
  }, [data.habits, habitBusy, onAuthError])

  // Same path for the habit's tracked number — logging one also ticks the day off.
  const logHabitValue = useCallback(async (habit: any, value: number | null) => {
    const today = data.habits?.today
    if (!today || habitBusy.has(habit.id)) return
    setHabitBusy((s) => new Set(s).add(habit.id))
    try {
      const payload = await logHabit({ id: habit.id, date: today, value, complete: value !== null })
      setData((d: any) => ({ ...d, habits: payload }))
    } catch (e) {
      if (e instanceof AuthError) onAuthError()
    } finally {
      setHabitBusy((s) => { const n = new Set(s); n.delete(habit.id); return n })
    }
  }, [data.habits, habitBusy, onAuthError])

  // Save from the note modal writes an exact count + note for the day (the same
  // call the Habits tab makes), then swaps in the refreshed payload.
  const saveHabitDay = useCallback(async ({ count, note, value, parts }: DaySave) => {
    if (!habitNote) return
    try {
      const payload = await logHabit({ id: habitNote.habit.id, date: habitNote.date, count, note, value, parts })
      setData((d: any) => ({ ...d, habits: payload }))
      setHabitNote(null)
    } catch (e) {
      if (e instanceof AuthError) { onAuthError(); return }
      throw e // the modal surfaces it inline
    }
  }, [habitNote, onAuthError])

  // Jobs, ordered so anything wrong is at the top: failures first, then the ones
  // that are on, then the rest. A board tile that buried a failure below six
  // healthy rows would be no better than the log line it replaces.
  const jobList = useMemo(() => {
    const all = data.jobs?.jobs || []
    const rank = (j: any) => (j.lastRun?.status === 'error' ? 0 : j.enabled ? 1 : 2)
    return [...all].sort((a: any, b: any) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 7)
  }, [data.jobs])

  const jobsSummary = useMemo(() => {
    const all = data.jobs?.jobs || []
    return {
      total: all.length,
      on: all.filter((j: any) => j.enabled).length,
      failing: all.filter((j: any) => j.lastRun?.status === 'error').length,
    }
  }, [data.jobs])

  const now = new Date()
  const today = startOfDay(now)

  // --- Todos ---
  const allTodos = useMemo(
    () => (data.todos?.todos || []).filter((t: any) => !doneIds.has(t.id)),
    [data.todos, doneIds],
  )
  const overdue = allTodos.filter((t: any) => t.due && startOfDay(dueToDate(t.due)) < today)
  const todayTasks = allTodos.filter((t: any) => t.due && startOfDay(dueToDate(t.due)).getTime() === today.getTime())
  const rest = allTodos.filter((t: any) => !overdue.includes(t) && !todayTasks.includes(t))
  const todoTop = [...overdue, ...todayTasks, ...rest].slice(0, 6)

  // --- Habits ---
  const habitDay = data.habits?.today || ''
  const habitEntries = data.habits?.entries || {}
  const activeHabits = (data.habits?.habits || []).filter((h: any) => !h.archived)
  const habitsShown = activeHabits.slice(0, 7)
  const habitsDone = activeHabits.filter((h: any) => periodTotal(h, habitEntries, habitDay) >= h.target).length

  // --- Calendar ---
  const events = data.cal?.events || []
  const sortedEvents = [...events].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  const eventsToday = sortedEvents.filter((ev) => isSameDay(ev.start, now))
  const calList = calScope === 'today' ? eventsToday : sortedEvents
  const calShown = calList.slice(0, 6)
  // The next event that hasn't started yet - highlighted as "up next".
  const nextEvent = sortedEvents.find((ev) => !ev.allDay && new Date(ev.start) > now)

  // --- Brain ---
  const nodes = data.brain?.nodes || []
  const links = data.brain?.links || []
  const notes = nodes.filter((n: any) => n.type === 'note')

  // --- Providers: spend from Totem's subscription data, live headroom from the
  // AI-usage poller (one entry per discovered profile) ---
  const services = (data.usage?.services || []).filter((s: any) => !s.error)
  const monthly = services.reduce((sum: number, s: any) => sum + (s.priceUsd || 0), 0)
  const aiAccounts = data.ai?.accounts || []
  const peakWindow = services
    .flatMap((s: any) => (s.usage?.windows || []).map((w: any) => ({ ...w, service: s.name })))
    .filter((w: any) => w.usedPercent != null)
    .sort((a: any, b: any) => b.usedPercent - a.usedPercent)[0]

  // --- Totem activity: productivity output (down) fused with AI chat (up) into
  // one diverging graph. Legends read off byKind / byChannel. ---
  const p = data.prod
  const a = data.assistant
  const prodKinds = p ? ACTIVITY_ORDER.map((id) => [id, p.byKind?.[id] || 0]).filter(([, n]) => n > 0) : []
  const aiChannels = a ? CHANNEL_ORDER.map((id) => [id, a.byChannel?.[id] || 0]).filter(([, n]) => n > 0) : []
  const hasActivity = (p && p.total > 0) || (a && a.total > 0)

  // --- GitHub (recent repos) ---
  const repos = data.github?.repos || []
  const recentRepos = repos.slice(0, 6) // already sorted most-recently-pushed by the bridge

  const hour = now.getHours()
  const part = hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  // Every tile's content, keyed by board id. The board renders these in the saved
  // order, so where a card sits is data rather than markup position.
  const tiles: Record<string, React.ReactNode> = {
    // Habits - one-tap check-in without leaving the overview.
    habits: (
      <Card
        icon={FireIcon}
        title="Habits"
        accent="#22c55e"
        count={data.habits ? `${habitsDone}/${activeHabits.length} today` : null}
        onView={() => onNavigate('habits')}
        drag={tileDrag('habits')}
      >
        {errs.habits ? <div className="muted inline-warn"><WarnIcon /> {errs.habits}</div>
          : !data.habits ? <div className="muted">Loading…</div>
          : !activeHabits.length ? <div className="ov-empty">No habits yet — track one from the Habits tab, or just ask Totem.</div>
          : (
            <div className="ov-habit-list">
              {habitsShown.map((h: any) => (
                <OvHabitRow
                  key={h.id}
                  habit={h}
                  entry={habitEntries[habitDay]?.[h.id]}
                  count={habitEntries[habitDay]?.[h.id]?.count || 0}
                  periodCount={periodTotal(h, habitEntries, habitDay)}
                  busy={habitBusy.has(h.id)}
                  onLog={logHabitDelta}
                  onValue={logHabitValue}
                  onNote={(habit) => setHabitNote({ habit, date: habitDay })}
                />
              ))}
              {activeHabits.length > habitsShown.length && (
                <button className="ov-more" onClick={() => onNavigate('habits')}>+{activeHabits.length - habitsShown.length} more →</button>
              )}
            </div>
          )}
      </Card>
    ),

    // Todos - quick-complete inline; click a row to manage it in full.
    todos: (
      <Card
        icon={CheckCircleIcon}
        title="Todos"
        accent="#2563eb"
        count={data.todos ? allTodos.length : null}
        onView={() => onNavigate('todos')}
        drag={tileDrag('todos')}
      >
        {errs.todos ? <div className="muted inline-warn"><WarnIcon /> {errs.todos}</div>
          : !data.todos ? <div className="muted">Loading…</div>
          : (
            <>
              <div className="ov-pills">
                <span className={`ov-stat-pill${overdue.length ? ' red' : ''}`}>{overdue.length} overdue</span>
                <span className="ov-stat-pill">{todayTasks.length} today</span>
              </div>
              {todoTop.length ? (
                <div className="ov-todo-list">
                  {todoTop.map((t) => (
                    <div className="ov-todo" key={t.id}>
                      <button
                        className={`ov-check p${5 - t.priority}`}
                        title="Mark complete"
                        aria-label="Mark complete"
                        onClick={() => completeTodo(t.id)}
                      />
                      <button className="ov-todo-open" onClick={() => onNavigate('todos')}>
                        <span className="ov-todo-text">{t.content}</span>
                        {dueChip(t.due)}
                      </button>
                    </div>
                  ))}
                </div>
              ) : <div className="ov-empty">All clear 🎉</div>}
            </>
          )}
      </Card>
    ),

    // Activity - what you actually get done through Totem: productivity objects
    // created and completed, with AI requests as a secondary line. Same
    // hover-to-inspect stacked graph as Settings ▸ Usage.
    activity: (
      <Card
        icon={BoltIcon}
        title="Totem activity"
        accent="#22c55e"
        count={(p || a) ? `${fmtInt((p?.total || 0) + (a?.total || 0))} all-time` : null}
        onView={() => onNavigate(USAGE_SECTION)}
        viewLabel="Usage"
        className="ov-activity"
        drag={tileDrag('activity')}
      >
        {(errs.prod && errs.assistant) ? <div className="muted inline-warn"><WarnIcon /> {errs.prod}</div>
          : (!p && !a) ? <div className="muted">Loading…</div>
          : !hasActivity ? <div className="muted">No activity logged yet — chat with Totem or create/complete a todo, habit, or event and it shows up here.</div>
          : (
            <>
              <div className="ov-activity-stats">
                <div className="ov-bignum up"><b>{fmtInt(a?.today || 0)}</b><small>AI chats today</small></div>
                <div className="ov-bignum up"><b>{fmtInt(a?.total || 0)}</b><small>AI all-time</small></div>
                <div className="ov-bignum down"><b>{fmtInt(p?.today || 0)}</b><small>actions today</small></div>
                <div className="ov-bignum down"><b>{fmtInt(p?.completed || 0)}</b><small>completed</small></div>
                <div className="ov-bignum down"><b>{fmtInt(p?.created || 0)}</b><small>created</small></div>
              </div>
              {/* AI usage graph and productivity graph fused: chats rise, work descends. */}
              <ComboActivityChart
                height={150}
                top={{ daily: a?.daily, order: CHANNEL_ORDER, meta: CHANNEL_META, label: 'AI chat', unit: 'request' }}
                bottom={{ daily: p?.daily, order: ACTIVITY_ORDER, meta: ACTIVITY_META, label: 'Productivity', unit: 'action' }}
              />
              <div className="ov-activity-legend">
                {aiChannels.length > 0 && (
                  <div className="chan-row">
                    <span className="usage-row-label">▲ AI chat</span>
                    {aiChannels.map(([id, n]) => (
                      <UsageChip key={id} sm color={CHANNEL_META[id]?.color} icon={CHANNEL_META[id]?.icon} label={CHANNEL_META[id]?.label || id} count={n} />
                    ))}
                    <button className="ov-inline-link" onClick={() => onNavigate(USAGE_SECTION)}>details →</button>
                  </div>
                )}
                {prodKinds.length > 0 && (
                  <div className="chan-row">
                    <span className="usage-row-label">▼ Productivity</span>
                    {prodKinds.map(([id, n]) => (
                      <UsageChip key={id} sm color={ACTIVITY_META[id]?.color} icon={ACTIVITY_META[id]?.icon} label={ACTIVITY_META[id]?.label || id} count={n} />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
      </Card>
    ),

    // Calendar - toggle Today/Week without leaving; click an event to open it.
    calendar: (
      <Card
        icon={CalendarDaysIcon}
        title="Calendar"
        count={data.cal ? (calScope === 'today' ? eventsToday.length : events.length) : null}
        onView={() => onNavigate('calendar')}
        viewLabel="Open"
        drag={tileDrag('calendar')}
      >
        {errs.cal ? <div className="muted inline-warn"><WarnIcon /> {errs.cal}</div>
          : !data.cal ? <div className="muted">Loading…</div>
          : (
            <>
              <div className="ov-seg">
                <button className={`seg ${calScope === 'today' ? 'active' : ''}`} onClick={() => setCalScope('today')}>Today</button>
                <button className={`seg ${calScope === 'week' ? 'active' : ''}`} onClick={() => setCalScope('week')}>This week</button>
              </div>
              {calShown.length ? (
                <div className="ov-event-list">
                  {calShown.map((ev) => (
                    <button className={`ov-event${nextEvent && ev.id === nextEvent.id ? ' is-next' : ''}`} key={ev.id} onClick={() => onNavigate('calendar')}>
                      <span className={`bar acct-${(ev.accountIndex ?? 0) % 4}`} />
                      <span className="ov-event-main">
                        <span className="ov-event-title">{ev.title}</span>
                        {ev.location && <span className="ov-event-loc"><Hi icon={MapPinIcon} size={11} />{ev.location}</span>}
                      </span>
                      <span className="ov-event-when">
                        {nextEvent && ev.id === nextEvent.id && <span className="ov-next-tag">Up next</span>}
                        {calScope === 'today'
                          ? (ev.allDay ? 'all day' : new Date(ev.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
                          : eventWhen(ev)}
                      </span>
                    </button>
                  ))}
                  {calList.length > calShown.length && (
                    <button className="ov-more" onClick={() => onNavigate('calendar')}>+{calList.length - calShown.length} more →</button>
                  )}
                </div>
              ) : <div className="ov-empty">{calScope === 'today' ? 'Nothing scheduled today.' : 'Nothing scheduled this week.'}</div>}
            </>
          )}
      </Card>
    ),

    // Jobs - every scheduled thing, whether it ran, and what broke if it didn't.
    // This tile is the answer to "I made a job and it never ran": an enabled job
    // with no next run, or a failed last run, is visible from the home screen
    // instead of buried in a log nobody reads.
    jobs: (
      <Card
        icon={ClockIcon}
        title="Jobs"
        count={jobsSummary.total ? `${jobsSummary.on} on` : null}
        accent={jobsSummary.failing ? '#f0506e' : undefined}
        onView={() => onNavigate(JOBS_SECTION)}
        viewLabel="Manage"
        drag={tileDrag('jobs')}
      >
        {errs.jobs ? <div className="muted inline-warn"><WarnIcon /> {errs.jobs}</div>
          : !data.jobs ? <div className="muted">Loading…</div>
          : !jobList.length ? <div className="ov-empty">No jobs yet.</div>
          : (
            <div className="ov-job-list">
              {jobList.map((j: any) => {
                const run = j.lastRun
                const failed = run?.status === 'error'
                return (
                  <React.Fragment key={j.id}>
                    <div className={`ov-job ${j.enabled ? '' : 'off'}`}>
                      <span className={`run-pill ${
                        !j.enabled ? 'idle'
                          : run?.status === 'running' ? 'running'
                          : failed ? 'bad'
                          : run?.status === 'skipped' ? 'warn'
                          : run?.status === 'ok' ? 'good' : 'idle'
                      }`}>
                        {!j.enabled ? 'off'
                          : run?.status === 'running' ? 'running'
                          : failed ? 'failed'
                          : run?.status === 'skipped' ? 'skipped'
                          : run?.status === 'ok' ? 'ok' : 'never run'}
                      </span>
                      <span className="ov-job-name" title={j.scheduleLabel}>{j.name}</span>
                      <span className="ov-job-when">
                        {j.enabled
                          ? (j.nextRunAt ? ovJobWhen(j.nextRunAt) : 'not scheduled')
                          : j.scheduleLabel}
                      </span>
                      <button
                        className="icon-btn small ov-job-run"
                        disabled={jobBusy === j.id || run?.status === 'running'}
                        onClick={() => runJob(j)}
                        title={`Run ${j.name} now`}
                      >
                        <Hi icon={PlayIcon} size={12} />
                      </button>
                    </div>
                    {failed && <div className="ov-job-err">{run.error}</div>}
                  </React.Fragment>
                )
              })}
            </div>
          )}
      </Card>
    ),

    // Provider usage - live headroom straight from the AI-usage poller (one row
    // per profile, tightest window first), with monthly spend from Totem's own
    // subscription data, which the poller doesn't track.
    providers: (
      <Card
        icon={BoltIcon}
        title="Providers"
        count={data.usage ? `${fmtUsd(monthly)}/mo` : null}
        onView={() => onNavigate(USAGE_SECTION)}
        viewLabel="Usage"
        drag={tileDrag('providers')}
      >
        {!data.ai ? <div className="muted">Loading…</div>
          : !data.ai.ok ? (
            <div className="muted inline-warn"><WarnIcon /> {data.ai.error}</div>
          ) : !aiAccounts.length ? <div className="ov-empty">No AI accounts discovered.</div>
          : (
            <div className="ov-quota-list">
              {aiAccounts.map((acct: any) => {
                // The window closest to running out is the one worth showing here.
                const tightest = [...(acct.meters || [])]
                  .filter((m: any) => m.remainingPct != null)
                  .sort((a: any, b: any) => a.remainingPct - b.remainingPct)[0]
                return (
                  <div className="prov-block" key={acct.id}>
                    <div className="prov-head">
                      <span className="usage-name"><ProductIcon id={acct.backend} title={acct.backend} />{acct.displayName || acct.label}</span>
                      {acct.plan && <span className="pill usage-plan">{acct.plan}</span>}
                    </div>
                    {tightest
                      ? <QuotaMeter meter={tightest} compact />
                      : <div className="muted prov-note">{acct.status === 'ok' ? 'No windows reported.' : acct.error || acct.status}</div>}
                  </div>
                )
              })}
            </div>
          )}
      </Card>
    ),

    // Recent repos - most-recently-pushed across every org; click into Code.
    repos: (
      <Card
        icon={CodeBracketIcon}
        title="Repositories"
        count={data.github ? repos.length : null}
        onView={() => onNavigate('code')}
        viewLabel="Browse"
        drag={tileDrag('repos')}
      >
        {errs.github ? <div className="muted inline-warn"><WarnIcon /> {errs.github}</div>
          : !data.github ? <div className="muted">Loading…</div>
          : !repos.length ? <div className="ov-empty">No repositories found.</div>
          : (
            <div className="ov-repo-list">
              {recentRepos.map((r: any) => (
                <a className="ov-repo" key={r.fullName} href={r.url} target="_blank" rel="noreferrer">
                  <span className="ov-repo-main">
                    <span className="ov-repo-name"><span className="ov-repo-owner">{r.owner}/</span>{r.name}</span>
                    {r.language && <span className="ov-repo-lang">{r.language}</span>}
                  </span>
                  <span className="ov-repo-when">{relTime(new Date(r.pushedAt).getTime())}</span>
                </a>
              ))}
            </div>
          )}
      </Card>
    ),

    brain: (
      <Card
        icon={CircleStackIcon}
        title="Brain"
        count={data.brain ? notes.length : null}
        onView={() => onNavigate('brain')}
        drag={tileDrag('brain')}
      >
        {errs.brain ? <div className="muted inline-warn"><WarnIcon /> {errs.brain}</div>
          : !data.brain ? <div className="muted">Loading…</div>
          : !nodes.length ? <div className="ov-empty">No notes yet.</div>
          : (
            <>
              <BrainMiniMap nodes={nodes} links={links} height={190} />
              <div className="muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 6 }}>
                {notes.length} notes · {links.length} links
              </div>
            </>
          )}
      </Card>
    ),
  }

  // One tile per pinned habit graph — the same chart the Habits tab draws, at
  // tile size. Clicking through lands on the habit it belongs to.
  for (const h of pinnedMetrics) {
    tiles[metricTileId(h.id)] = (
      <Card
        icon={ChartBarIcon}
        title={h.metric.label}
        accent={h.color}
        onView={() => onNavigate('habits')}
        drag={tileDrag(metricTileId(h.id))}
      >
        {errs.habits ? <div className="muted inline-warn"><WarnIcon /> {errs.habits}</div>
          : <HabitMetricSection habit={h} entries={habitEntries} today={habitDay} compact days={30} />}
      </Card>
    )
  }

  return (
    <div className="view overview">
      <div className="view-head">
        <div>
          <h1 style={{ marginBottom: 2 }}>{ownerName ? `${part}, ${ownerName}` : part}</h1>
          <div className="muted" style={{ fontSize: 13 }}>
            {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
        </div>
        <div className="ov-head-actions">
          {canDrag && customized && (
            <button className="btn compact" onClick={() => setSetting('overviewOrder', [])} title="Put the cards back in their default order">
              Reset layout
            </button>
          )}
          <button className="btn" onClick={load}>Refresh</button>
        </div>
      </div>

      {/* The board. Tiles render in the saved order; on desktop each one can be
          dragged by its grip onto another tile's slot. */}
      <div className={`ov-board${draggedTile ? ' dragging' : ''}`}>
        {order.map((id) => (
          <React.Fragment key={id}>{tiles[id]}</React.Fragment>
        ))}
      </div>

      {habitNote && (
        <DayModal
          habit={habitNote.habit}
          date={habitNote.date}
          entry={habitEntries[habitNote.date]?.[habitNote.habit.id]}
          onClose={() => setHabitNote(null)}
          onSave={saveHabitDay}
        />
      )}
    </div>
  )
}
