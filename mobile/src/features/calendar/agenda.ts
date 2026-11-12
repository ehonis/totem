// The agenda's days, built once from the range's events and away spans. Pure, so
// `node --test` runs it.
//
// An event goes under the day it starts, or under the range's first day when it
// started before (a trip that began Sunday is still on Today). Today and tomorrow
// always get a heading when they are in range, even with nothing on them
// ("Nothing scheduled" is an answer), and so does any day away (being away is
// the news). Today's events that are over are marked past, and
// `nowAt` says where the now line goes among them.
import { awayOn, dayKey, type AwaySpan } from '../../lib/away'
import { addDays, parseDate, sameDay, startOfDay } from './time'

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
