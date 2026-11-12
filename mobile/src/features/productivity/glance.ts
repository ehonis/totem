// The Productivity hub's numbers: one glanceable count per tool, worked out from
// data the app already holds (a tool's in-memory store once its page has loaded,
// else the GET cache's peek*), never a bridge call of its own. The rules are
// Overview's (OverviewScreen.tsx), so given the same data the two count alike. A
// habits or goals answer from an earlier day or week says nothing rather than
// passing yesterday off as today. Known limits, both needing code outside the hub:
// a write made on Overview reaches a tool's store only when that page next loads,
// and a calendar answer carries no date range, so a days-old one can't be told apart.
// Pure, so glance.test.mjs can run it.
import { periodTotal } from '../../lib/components/overview/time'

/** Local "YYYY-MM-DD" for a moment. */
export function dayKeyOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** A due value is a date ("2026-11-04") or an RFC 3339 time; either way, its local day. */
const dueDay = (due: string) => (due.length <= 10 ? due.slice(0, 10) : dayKeyOf(new Date(due)))

export interface TasksGlance { today: number; overdue: number; open: number }

/**
 * Open tasks due today, and those already late. Reads the Tasks board (what the
 * Tasks page draws) when there is one, and Overview's /api/todos otherwise.
 */
export function tasksGlance(board: any, legacy: any, now: Date): TasksGlance | null {
  let open: Array<{ due: string | null }>
  if (Array.isArray(board?.todos)) {
    open = board.todos
      .filter((t: any) => t && t.status !== 'done' && !t.deletedAt && !t.archivedAt)
      .map((t: any) => ({ due: t.dueDate || null }))
  } else if (Array.isArray(legacy?.todos)) {
    open = legacy.todos.filter(Boolean).map((t: any) => ({ due: t.due || null }))
  } else return null
  const key = dayKeyOf(now)
  let today = 0, overdue = 0
  for (const t of open) {
    if (!t.due) continue
    const d = dueDay(t.due)
    if (d < key) overdue++
    else if (d === key) today++
  }
  return { today, overdue, open: open.length }
}

export interface CalendarGlance {
  /** Timed events today still to come or under way. */
  left: number
  /** The next timed one to start. */
  next: { title: string; start: string } | null
  /** All-day events that cover today, and the first one's title. */
  allDay: number
  allDayTitle: string | null
}

/** Today's events, including ones that began on an earlier day and run into today. */
export function calendarGlance(payload: any, now: Date): CalendarGlance | null {
  if (!Array.isArray(payload?.events)) return null
  const today = dayKeyOf(now)
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const allDay: any[] = []
  const left: any[] = []
  for (const ev of payload.events) {
    if (!ev?.start) continue
    if (ev.allDay) {
      // Google's all-day end is the day after the last one.
      const from = String(ev.start).slice(0, 10)
      const to = ev.end ? String(ev.end).slice(0, 10) : null
      if (from <= today && (to ? today < to : from === today)) allDay.push(ev)
      continue
    }
    const start = new Date(ev.start), end = new Date(ev.end || ev.start)
    if (start < dayEnd && end >= dayStart && end > now) left.push(ev)
  }
  const upcoming = left
    .filter((ev) => new Date(ev.start) > now)
    .sort((a, b) => +new Date(a.start) - +new Date(b.start))[0]
  return {
    left: left.length,
    next: upcoming ? { title: String(upcoming.title || 'Event'), start: upcoming.start } : null,
    allDay: allDay.length,
    allDayTitle: allDay.length ? String(allDay[0].title || 'Event') : null,
  }
}

export interface RatioGlance { done: number; total: number }

/** Habits done today, of those the owner logs by hand (the WHOOP sleep habit fills itself). */
export function habitsGlance(payload: any, now: Date): RatioGlance | null {
  if (!Array.isArray(payload?.habits)) return null
  // The bridge names its own today; an answer from an earlier day is not today's tally.
  if (payload.today && payload.today !== dayKeyOf(now)) return null
  const day: string = payload.today || dayKeyOf(now)
  const entries = payload.entries || {}
  const habits = payload.habits.filter((h: any) => h && !h.archived && h.metric?.source !== 'whoop-sleep')
  const left = habits.filter((h: any) => periodTotal(h, entries, day) < h.target && !(entries[day]?.[h.id]?.count > 0))
  return { done: habits.length - left.length, total: habits.length }
}

/** This week's goals done, of those still in play; nothing if the answer is for another week. */
export function goalsGlance(payload: any, now: Date): RatioGlance | null {
  if (!Array.isArray(payload?.goals)) return null
  const period = payload.period
  const today = dayKeyOf(now)
  if (period?.start && period?.end && (today < period.start || today > period.end)) return null
  const live = payload.goals.filter((g: any) => g && !g.abandoned)
  return { done: live.filter((g: any) => g.complete).length, total: live.length }
}

/**
 * The Goals page's store as a this-week answer, or null when it is showing
 * something else (the overview, another period, a week stepped back to).
 */
export function liveWeekGoals(state: any): { goals: any[]; period: any } | null {
  if (!state || state.tab !== 'this_week' || state.anchor || state.window?.type !== 'week') return null
  // Switching tabs empties the list before the week's answer lands; a refresh keeps it.
  if (state.loading && !state.goals?.length) return null
  return { goals: state.goals, period: state.window }
}

export interface ListsGlance { lists: number; open: number }

/** Unchecked items across every list. */
export function listsGlance(payload: any): ListsGlance | null {
  if (!Array.isArray(payload?.lists)) return null
  let open = 0
  for (const l of payload.lists) open += Math.max(0, (Number(l?.itemCount) || 0) - (Number(l?.checkedCount) || 0))
  return { lists: payload.lists.length, open }
}

/** The first candidate (freshest first) that `read` accepts; a missing or refused one falls through. */
export function firstGlance<T>(candidates: unknown[], read: (c: any) => T | null): T | null {
  for (const c of candidates) {
    const g = c ? read(c) : null
    if (g) return g
  }
  return null
}

/** Plural-aware "1 event" / "2 events". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
