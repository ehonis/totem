// The calendar's agenda days and toolbar titles, as the iPhone app builds them
// (mobile/src/features/calendar/agenda.ts and time.ts). Pure, so vitest runs it.
//
// An event goes under the day it starts, or under the range's first day when it
// started before. Today and tomorrow always get a heading when they are in range,
// even with nothing on them ("Nothing scheduled" is an answer), and so does any day
// away (being away is the news). Today's finished events are marked past, and
// `nowAt` says where the now line goes among them.
import { awayOn, dayKey, type AwaySpan } from '../away'

export type CalViewId = 'day' | 'workweek' | 'week' | 'month' | 'year' | 'agenda'
export const VIEW_IDS: CalViewId[] = ['day', 'workweek', 'week', 'month', 'year', 'agenda']

export const parseDate = (s: string | number | Date): Date => {
  if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(s)
}
const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const startOfWeek = (d: Date, weekStart: number) => {
  const x = startOfDay(d)
  x.setDate(x.getDate() - ((x.getDay() - weekStart + 7) % 7))
  return x
}

export interface AgendaEvent {
  ev: any
  /** Over: an earlier day's, or today's that has ended. */
  past: boolean
  /** Happening now. */
  ongoing: boolean
}

export interface AgendaDay {
  key: string
  date: Date
  heading: string
  today: boolean
  away: AwaySpan | null
  events: AgendaEvent[]
  /** Today only: the index the now line goes before (events.length = after all). -1 for none. */
  nowAt: number
}

export function dayHeading(d: Date, now = new Date()): string {
  if (sameDay(d, now)) return 'Today'
  if (sameDay(d, addDays(now, 1))) return 'Tomorrow'
  return d.toLocaleDateString([], { weekday: 'long' })
}

const order = (a: any, b: any) => {
  if (Boolean(a.allDay) !== Boolean(b.allDay)) return a.allDay ? -1 : 1
  const s = +parseDate(a.start) - +parseDate(b.start)
  return s || String(a.title ?? '').localeCompare(String(b.title ?? ''))
}

export function agendaDays(events: any[], away: AwaySpan[], range: [Date, Date], now = new Date()): AgendaDay[] {
  const [from, to] = range
  const byKey = new Map<string, any[]>()
  const ensure = (d: Date) => {
    const key = dayKey(d)
    if (!byKey.has(key)) byKey.set(key, [])
    return byKey.get(key)!
  }
  const first = startOfDay(from)
  for (const ev of events) {
    const start = parseDate(ev.start)
    ensure(start < first ? first : start).push(ev)
  }
  for (let d = first; d < to; d = addDays(d, 1)) {
    if (awayOn(away, dayKey(d))) ensure(d)
  }
  const today = startOfDay(now)
  for (const d of [today, addDays(today, 1)]) if (d >= first && d < to) ensure(d)

  const todayKey = dayKey(now)
  return [...byKey.keys()].sort().map((key) => {
    const [y, m, dd] = key.split('-').map(Number)
    const date = new Date(y, m - 1, dd)
    const isToday = key === todayKey
    const before = key < todayKey
    const list: AgendaEvent[] = byKey.get(key)!.sort(order).map((ev) => {
      if (before) return { ev, past: true, ongoing: false }
      if (!isToday || ev.allDay) return { ev, past: false, ongoing: isToday && Boolean(ev.allDay) }
      const start = parseDate(ev.start)
      const end = ev.end ? parseDate(ev.end) : start
      return { ev, past: end <= now, ongoing: start <= now && now < end }
    })
    let nowAt = -1
    if (isToday && list.some((e) => !e.ev.allDay)) {
      const next = list.findIndex((e) => !e.ev.allDay && !e.past)
      nowAt = next === -1 ? list.length : next
    }
    return { key, date, heading: dayHeading(date, now), today: isToday, away: awayOn(away, key), events: list, nowAt }
  })
}

/** The first and last day a week-shaped view shows. */
function spanOf(view: CalViewId, anchor: Date, weekStart: number): [Date, Date] {
  const sow = startOfWeek(anchor, weekStart)
  const s = view === 'agenda' ? startOfDay(anchor) : view === 'workweek' ? addDays(sow, weekStart === 0 ? 1 : 0) : sow
  return [s, addDays(s, view === 'workweek' ? 4 : view === 'agenda' ? 13 : 6)]
}

/**
 * The toolbar's title on a wide screen: "Nov 22 – 28, 2026". (Intl renders
 * `{ day, year }` without a month as "2026 (day: 28)", which the title once showed.)
 */
export function rangeTitle(view: CalViewId, anchor: Date, weekStart = 0): string {
  if (view === 'day') return anchor.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  if (view === 'year') return String(anchor.getFullYear())
  if (view === 'month') return anchor.toLocaleDateString([], { month: 'long', year: 'numeric' })
  const [s, e] = spanOf(view, anchor, weekStart)
  const sameYear = s.getFullYear() === e.getFullYear()
  const sFmt = s.toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
  const eFmt = s.getMonth() === e.getMonth() && sameYear
    ? `${e.getDate()}, ${e.getFullYear()}`
    : e.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
  return `${sFmt} – ${eFmt}`
}

/** The title at phone width, short enough to sit beside the controls (the app's). The year only when it is not this one. */
export function compactTitle(view: CalViewId, anchor: Date, now = new Date(), weekStart = 0): string {
  const yearOf = (d: Date) => (d.getFullYear() !== now.getFullYear() ? `, ${d.getFullYear()}` : '')
  const md = (d: Date) => d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  if (view === 'year') return String(anchor.getFullYear())
  if (view === 'month') return anchor.toLocaleDateString([], { month: 'long', ...(anchor.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
  if (view === 'day') return `${anchor.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}${yearOf(anchor)}`
  const [s, e] = spanOf(view, anchor, weekStart)
  const end = s.getMonth() === e.getMonth() ? String(e.getDate()) : md(e)
  return `${md(s)} – ${end}${yearOf(e)}`
}
