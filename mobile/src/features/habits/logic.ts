// The habit tracker's arithmetic, lifted out of web/src/components/HabitsView.tsx
// unchanged: cadence periods, streaks, the grid's intensity levels and the
// thermometer gauge. Everything works on the bridge's local "YYYY-MM-DD" strings —
// the bridge decides what "today" is, so nothing here calls new Date() for a day key.
import type { MetricConfig, MetricPart } from '../../lib/components/metricChart'

export type Cadence = 'daily' | 'weekly' | 'monthly'

export interface Habit {
  id: string
  name: string
  description: string
  color: string
  cadence: Cadence
  target: number // completions per cadence period
  metric: MetricConfig | null
  /** When it is answered: 'night' habits are done late and logged the next morning. */
  when?: HabitWhen
  /** A sibling app fills it in (Krakatoa, Bushido); it is never ticked by hand here. */
  linkedApp?: LinkedApp | null
  /** That app's address, from the bridge's env. */
  appUrl?: string | null
  createdAt: string
  archived: boolean
}

export type HabitWhen = 'any' | 'morning' | 'night'
export type LinkedApp = 'krakatoa' | 'bushido'
export const APP_NAME: Record<LinkedApp, string> = { krakatoa: 'Krakatoa', bushido: 'Bushido' }

/** `skipped`: answered "no" in the morning check-in (count stays 0). */
export interface Entry { count: number; skipped?: boolean; note?: string; value?: number | null; parts?: Record<string, number> }
export type Entries = Record<string, Record<string, Entry>> // date -> habitId -> entry

export interface HabitsPayload {
  today: string
  habits: Habit[]
  entries: Entries
  palette: string[]
  apps?: Record<LinkedApp, string | null>
  checkin?: { lastShown: string | null }
}

// The WHOOP-synced sleep habit isn't shown on the Habits tab: nobody logs it by
// hand, and Bushido is where it is read (web origin/main, isSyncedSleep).
export const isSyncedSleep = (h: { metric?: { source?: string } | null }) => h.metric?.source === 'whoop-sleep'

export const toDate = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export const toISO = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
export const addDays = (iso: string, n: number): string => {
  const d = toDate(iso)
  d.setDate(d.getDate() + n)
  return toISO(d)
}
export const dayLabel = (iso: string): string =>
  toDate(iso).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })

// Weeks run Monday–Sunday (matching the grid, goals and Bushido).
export const dayOfWeek = (iso: string): number => (toDate(iso).getDay() + 6) % 7
export const weekStartOf = (iso: string): string => addDays(iso, -dayOfWeek(iso))
const prevMonthOf = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function periodTotal(habit: Habit, entries: Entries, date: string): number {
  if (habit.cadence === 'weekly') {
    const start = weekStartOf(date)
    let t = 0
    for (let i = 0; i < 7; i++) t += entries[addDays(start, i)]?.[habit.id]?.count || 0
    return t
  }
  if (habit.cadence === 'monthly') {
    const ym = date.slice(0, 7)
    let t = 0
    for (const [d, day] of Object.entries(entries)) if (d.startsWith(ym)) t += day[habit.id]?.count || 0
    return t
  }
  return entries[date]?.[habit.id]?.count || 0
}

export const CADENCE_NOUN: Record<Cadence, string> = { daily: 'day', weekly: 'week', monthly: 'month' }
export const periodLabel = (cadence: Cadence): string => (cadence === 'weekly' ? 'this week' : 'this month')

// GitHub-style intensity: 0 = empty, then quartiles of count/target up to 4.
export function levelOf(count: number, target: number): number {
  if (!count) return 0
  const r = count / Math.max(target, 1)
  return r >= 1 ? 4 : r >= 0.75 ? 3 : r >= 0.5 ? 2 : 1
}
/** % of the habit colour mixed into the bg-3 cell, per level. */
export const LEVEL_MIX = [0, 32, 55, 78, 100]

// Streaks in the habit's own unit. The still-in-progress current period never
// breaks the streak — this is a nightly retro, after all.
export function streakOf(habit: Habit, entries: Entries, today: string): number {
  let n = 0
  if (habit.cadence === 'weekly') {
    let ws = weekStartOf(today)
    if (periodTotal(habit, entries, ws) >= habit.target) n++
    ws = addDays(ws, -7)
    while (periodTotal(habit, entries, ws) >= habit.target) { n++; ws = addDays(ws, -7) }
    return n
  }
  if (habit.cadence === 'monthly') {
    let ym = today.slice(0, 7)
    if (periodTotal(habit, entries, `${ym}-01`) >= habit.target) n++
    ym = prevMonthOf(ym)
    while (periodTotal(habit, entries, `${ym}-01`) >= habit.target) { n++; ym = prevMonthOf(ym) }
    return n
  }
  let day = today
  if (!(entries[day]?.[habit.id]?.count)) day = addDays(day, -1)
  while (entries[day]?.[habit.id]?.count) { n++; day = addDays(day, -1) }
  return n
}

export function totalFor(habit: Habit, entries: Entries): number {
  let total = 0
  for (const day of Object.values(entries)) total += day[habit.id]?.count || 0
  return total
}

// A logged completion always shows at least this much of the tube, and an unmet
// period always leaves this much empty, so "nearly there" never looks like "done".
const MIN_BAR_FILL = 0.07

export interface Gauge { ratio: number; met: boolean }

export function periodGauge(target: number, count: number): Gauge {
  const t = Math.max(1, target)
  const met = count >= t
  const ratio = met ? 1
    : count > 0 ? Math.min(1 - MIN_BAR_FILL, Math.max(MIN_BAR_FILL, count / t))
    : 0
  return { ratio, met }
}

// ---- history grids ----
export const GRID_WEEKS = 52
export const weekStartsOf = (today: string, weeks = GRID_WEEKS): string[] => {
  const todayDow = dayOfWeek(today)
  return Array.from({ length: weeks }, (_, w) => addDays(today, -((weeks - 1 - w) * 7 + todayDow)))
}

export function monthLabelsForWeeks(weekStarts: string[]): { col: number; label: string }[] {
  const labels: { col: number; label: string }[] = []
  let prevMonth = -1
  weekStarts.forEach((ws, col) => {
    const m = toDate(ws).getMonth()
    if (m !== prevMonth) {
      labels.push({ col, label: toDate(ws).toLocaleDateString([], { month: 'short' }) })
      prevMonth = m
    }
  })
  if (labels.length >= 2 && labels[1].col - labels[0].col < 3) labels.shift()
  return labels
}

export interface MonthSegment { ym: string; label: string; weekCols: number; start: string; end: string }

export function monthSegmentsFromWeeks(weekStarts: string[], today: string): MonthSegment[] {
  const segs: MonthSegment[] = []
  weekStarts.forEach((ws) => {
    const ym = ws.slice(0, 7)
    const last = segs[segs.length - 1]
    if (last?.ym === ym) {
      last.weekCols++
      last.end = addDays(ws, 6)
    } else {
      segs.push({ ym, label: toDate(`${ym}-01`).toLocaleDateString([], { month: 'short' }), weekCols: 1, start: ws, end: addDays(ws, 6) })
    }
  })
  return segs.map((s) => {
    const [y, m] = s.ym.split('-').map(Number)
    const monthEnd = toISO(new Date(y, m, 0))
    let end = s.end > monthEnd ? monthEnd : s.end
    if (end > today) end = today
    return { ...s, end }
  })
}

/** One period per column in the weekly/monthly history. */
export interface PeriodColumn {
  key: string
  start: string
  end: string
  future: boolean
  count: number
  noted: boolean
  inCurrent: boolean
  label: string
}

export function weekColumns(habit: Habit, entries: Entries, today: string) {
  const weekStarts = weekStartsOf(today)
  const columns: PeriodColumn[] = weekStarts.map((weekStart) => {
    const weekEnd = addDays(weekStart, 6)
    const future = weekStart > today
    const count = future ? 0 : periodTotal(habit, entries, weekStart)
    let noted = false
    if (!future) for (let i = 0; i < 7; i++) if (entries[addDays(weekStart, i)]?.[habit.id]?.note) { noted = true; break }
    return {
      key: weekStart, start: weekStart, end: weekEnd, future, count, noted,
      inCurrent: today >= weekStart && today <= weekEnd,
      label: `Week of ${dayLabel(weekStart)}`,
    }
  })
  return { columns, labels: monthLabelsForWeeks(weekStarts).map((m) => ({ ...m, span: 3 })) }
}

export function monthColumns(habit: Habit, entries: Entries, today: string) {
  const segments = monthSegmentsFromWeeks(weekStartsOf(today), today)
  const columns: PeriodColumn[] = segments.map((seg) => {
    const future = seg.start > today
    const count = future ? 0 : periodTotal(habit, entries, seg.start)
    let noted = false
    if (!future) for (const [d, day] of Object.entries(entries)) if (d.startsWith(seg.ym) && day[habit.id]?.note) { noted = true; break }
    return {
      key: seg.ym,
      // The whole calendar month, so tapping the column can land on the 1st–5th too.
      start: `${seg.ym}-01`, end: seg.end, future, count, noted,
      inCurrent: today.startsWith(seg.ym),
      label: toDate(`${seg.ym}-01`).toLocaleDateString([], { month: 'long', year: 'numeric' }),
    }
  })
  return {
    columns,
    labels: columns.map((c, col) => ({ col, span: 1, label: toDate(`${c.key}-01`).toLocaleDateString([], { month: 'short' }) })),
  }
}

// ---- the habit form's metric half, kept as loose strings while typed ----
export interface MetricDraft {
  on: boolean
  label: string
  unit: string
  min: string
  max: string
  goal: string
  decimals: string
  direction: 'higher' | 'lower'
  chart: 'line' | 'bar'
  source: 'manual' | 'whoop-sleep'
  pinned: boolean
  parts: string
}

const PART_COLORS = ['#5b8cff', '#7c5cff', '#2dd4bf', '#f0506e', '#e3b341', '#40c463', '#fb923c', '#22d3ee']

export function metricDraftFrom(metric: MetricConfig | null | undefined): MetricDraft {
  return {
    on: Boolean(metric),
    label: metric?.label || '',
    unit: metric?.unit || '',
    min: metric?.min != null ? String(metric.min) : '',
    max: metric?.max != null ? String(metric.max) : '',
    goal: metric?.goal != null ? String(metric.goal) : '',
    decimals: String(metric?.decimals ?? 0),
    direction: metric?.direction === 'lower' ? 'lower' : 'higher',
    chart: metric?.chart === 'bar' ? 'bar' : 'line',
    source: metric?.source === 'whoop-sleep' ? 'whoop-sleep' : 'manual',
    pinned: metric?.pinned === true,
    parts: (metric?.parts || []).map((p) => p.label).join(', '),
  }
}

// Parts keep their key/colour when their label survives an edit, so renaming
// doesn't orphan the numbers already logged.
export function metricFromDraft(draft: MetricDraft, existing: MetricPart[] = []): MetricConfig | null {
  if (!draft.on || !draft.label.trim()) return null
  const num = (s: string): number | null => {
    const t = s.trim()
    if (!t) return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
  const byLabel = new Map(existing.map((p) => [p.label.toLowerCase(), p]))
  const parts = draft.parts.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8)
    .map((label, i) => {
      const prior = byLabel.get(label.toLowerCase())
      return {
        key: prior?.key || label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `part-${i + 1}`,
        label,
        color: prior?.color || PART_COLORS[i % PART_COLORS.length],
      }
    })
  return {
    label: draft.label.trim(),
    unit: draft.unit.trim(),
    min: num(draft.min),
    max: num(draft.max),
    goal: num(draft.goal),
    decimals: Math.min(Math.max(Number(draft.decimals) || 0, 0), 2),
    direction: draft.direction,
    chart: draft.chart,
    source: draft.source,
    pinned: draft.pinned,
    parts,
  }
}

/** `color-mix(in srgb, <hex> pct%, <base hex>)`, for the grid's intensity levels. */
export function mixHex(hex: string, base: string, pct: number): string {
  const parse = (h: string) => {
    const s = h.replace('#', '')
    const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s.slice(0, 6), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const a = parse(hex)
  const b = parse(base)
  const p = pct / 100
  const c = a.map((v, i) => Math.round(v * p + b[i] * (1 - p)))
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
