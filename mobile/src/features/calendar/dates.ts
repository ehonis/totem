// Date and layout helpers for Productivity → Calendar, ported from the top of
// web/src/components/CalendarView.tsx. Pure: no React, no fetch.
import { colors } from '../../theme'

// Loosely-shaped bridge JSON.
export type CalEvent = any

export const WEEK_START = 0 // 0 = Sunday (matches Google/Outlook default)
export const HOUR_PX = 44 // height of one hour row in time-grid views

// Google returns all-day events as a date-only string ("YYYY-MM-DD"). new Date()
// would read that as UTC midnight, which shifts to the previous day in negative-UTC
// timezones. Parse date-only values as a LOCAL date so they land on the right day.
export const parseDate = (s: string | number | Date): Date => {
  if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(s)
}

export const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
export const addMonths = (d: Date, n: number) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x }
export const startOfWeek = (d: Date, ws = WEEK_START) => {
  const x = startOfDay(d)
  x.setDate(x.getDate() - ((x.getDay() - ws + 7) % 7))
  return x
}
export const startOfMonth = (d: Date) => { const x = startOfDay(d); x.setDate(1); return x }
export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
export const isToday = (d: Date) => sameDay(d, new Date())
export const minsOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes()

export type CalViewId = 'day' | 'workweek' | 'week' | 'month' | 'year' | 'agenda'

export const VIEWS: { id: CalViewId; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'workweek', label: 'Work Week' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'agenda', label: 'Agenda' },
]

export const fmtTime = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const pad2 = (n: number) => String(n).padStart(2, '0')
export const toDateInput = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
export const toDateTimeInput = (d: Date) => `${toDateInput(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
/** "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" (local wall time) back to a Date. */
export const fromInput = (value: string): Date => {
  const [date, time] = value.split('T')
  const d = parseDate(date)
  if (time) {
    const [h, m] = time.split(':').map(Number)
    d.setHours(h || 0, m || 0, 0, 0)
  }
  return d
}
export const allDayEndForInput = (value?: string) => {
  if (!value) return ''
  const d = parseDate(value)
  d.setDate(d.getDate() - 1)
  return toDateInput(d)
}
export const allDayEndForApi = (value: string) => {
  const d = parseDate(value)
  d.setDate(d.getDate() + 1)
  return toDateInput(d)
}

export function eventTimeLabel(ev: CalEvent) {
  if (ev.allDay) return 'all day'
  const s = fmtTime(parseDate(ev.start))
  const e = ev.end ? fmtTime(parseDate(ev.end)) : ''
  return e ? `${s} – ${e}` : s
}

// The window of events to request from the API for a given view + anchor.
export function fetchRange(view: CalViewId, anchor: Date): [Date, Date] {
  if (view === 'day') return [startOfDay(anchor), addDays(startOfDay(anchor), 1)]
  if (view === 'week') { const s = startOfWeek(anchor); return [s, addDays(s, 7)] }
  if (view === 'workweek') { const s = startOfWeek(anchor); return [s, addDays(s, 7)] }
  if (view === 'agenda') return [startOfDay(anchor), addDays(startOfDay(anchor), 14)]
  if (view === 'month') {
    const s = startOfWeek(startOfMonth(anchor))
    return [s, addDays(s, 42)] // full 6-week grid
  }
  // year
  const s = new Date(anchor.getFullYear(), 0, 1)
  return [s, new Date(anchor.getFullYear() + 1, 0, 1)]
}

// Title shown in the toolbar for the current view + anchor.
export function rangeTitle(view: CalViewId, anchor: Date) {
  if (view === 'day') return anchor.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  if (view === 'year') return String(anchor.getFullYear())
  if (view === 'month') return anchor.toLocaleDateString([], { month: 'long', year: 'numeric' })
  // week / workweek / agenda
  const s = view === 'agenda' ? startOfDay(anchor)
    : view === 'workweek' ? addDays(startOfWeek(anchor), WEEK_START === 0 ? 1 : 0)
    : startOfWeek(anchor)
  const e = view === 'workweek' ? addDays(s, 4) : addDays(s, view === 'agenda' ? 13 : 6)
  const sameMonth = s.getMonth() === e.getMonth()
  const sameYear = s.getFullYear() === e.getFullYear()
  const sFmt = s.toLocaleDateString([], { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' })
  // The web asks Intl for { day, year } without a month, which it renders as
  // "2026 (day: 10)"; within one month the end is just "10, 2026".
  const eFmt = sameMonth
    ? `${e.getDate()}, ${e.getFullYear()}`
    : e.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
  return `${sFmt} – ${eFmt}`
}

/** The days a time grid shows. Empty for the non-grid views. */
export function gridDaysFor(view: CalViewId, anchor: Date): Date[] {
  if (view === 'day') return [startOfDay(anchor)]
  if (view === 'workweek') return Array.from({ length: 5 }, (_, i) => addDays(startOfWeek(anchor), i + (WEEK_START === 0 ? 1 : 0)))
  if (view === 'week') return Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i))
  return []
}

/** One step of ‹ › (or a swipe) for each view. */
export function stepAnchor(view: CalViewId, anchor: Date, dir: number): Date {
  if (view === 'day') return addDays(anchor, dir)
  if (view === 'week' || view === 'workweek') return addDays(anchor, dir * 7)
  if (view === 'month') return addMonths(anchor, dir)
  if (view === 'year') return addMonths(anchor, dir * 12)
  return addDays(anchor, dir * 14) // agenda
}

export interface PackedEvent { ev: CalEvent; s: number; e: number; col: number; cols: number }

// Greedy column packing for overlapping timed events within one day.
export function packDay(items: CalEvent[]): PackedEvent[] {
  const evs: any[] = items
    .map((e) => ({ ev: e, s: minsOfDay(parseDate(e.start)), e: Math.max(minsOfDay(parseDate(e.end || e.start)), minsOfDay(parseDate(e.start)) + 25) }))
    .sort((a, b) => a.s - b.s || a.e - b.e)
  const out: any[] = []
  let cluster: any[] = []
  let clusterEnd = -1
  const flush = () => {
    const columns: any[][] = []
    for (const it of cluster) {
      let placed = false
      for (let i = 0; i < columns.length; i++) {
        if (it.s >= columns[i][columns[i].length - 1].e) { columns[i].push(it); it.col = i; placed = true; break }
      }
      if (!placed) { columns.push([it]); it.col = columns.length - 1 }
    }
    for (const it of cluster) { it.cols = columns.length; out.push(it) }
    cluster = []; clusterEnd = -1
  }
  for (const it of evs) {
    if (cluster.length && it.s >= clusterEnd) flush()
    cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e)
  }
  if (cluster.length) flush()
  return out
}

// ---- account colours (.acct-0 … .acct-3) ----

const ACCT = [colors.accent, colors.accent2, '#3fb950', '#d29922']

function mix(fg: string, bg: string, pct: number) {
  const n = (h: string) => parseInt(h.replace('#', ''), 16)
  const a = n(fg)
  const b = n(bg)
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * pct + ((b >> shift) & 255) * (1 - pct))
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`
}

const FILLS = ACCT.map((c) => mix(c, colors.bg2, 0.26))

/** The account's solid colour: the bar and the block's left border. */
export const acctColor = (ev: CalEvent) => ACCT[(ev.accountIndex ?? 0) % 4]
/** `color-mix(in srgb, <acct> 26%, var(--bg-2))`: a chip or block's fill. */
export const acctFill = (ev: CalEvent) => FILLS[(ev.accountIndex ?? 0) % 4]
