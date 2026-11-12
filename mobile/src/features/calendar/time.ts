// The calendar's pure date helpers (no React Native), shared by dates.ts and the
// agenda builder so `node --test` can run them.

export type CalViewId = 'day' | 'workweek' | 'week' | 'month' | 'year' | 'agenda'

const VIEW_IDS: CalViewId[] = ['day', 'workweek', 'week', 'month', 'year', 'agenda']

/** The phone opens on the agenda: today and the days after it, readable at 390pt. */
export const DEFAULT_VIEW: CalViewId = 'agenda'

/** A stored view choice back to a view, or the default when it is missing or stale. */
export function parseView(raw: unknown): CalViewId {
  return typeof raw === 'string' && (VIEW_IDS as string[]).includes(raw) ? (raw as CalViewId) : DEFAULT_VIEW
}

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
export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/**
 * The toolbar's title on a phone: short enough to sit beside the controls at
 * 390pt. The year only when it is not this one.
 */
export function compactTitle(view: CalViewId, anchor: Date, now = new Date(), weekStart = 0): string {
  const yearOf = (d: Date) => (d.getFullYear() !== now.getFullYear() ? `, ${d.getFullYear()}` : '')
  const md = (d: Date) => d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  if (view === 'year') return String(anchor.getFullYear())
  if (view === 'month') return anchor.toLocaleDateString([], { month: 'long', ...(anchor.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
  if (view === 'day') return `${anchor.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}${yearOf(anchor)}`
  const sow = startOfDay(anchor)
  sow.setDate(sow.getDate() - ((sow.getDay() - weekStart + 7) % 7))
  const s = view === 'agenda' ? startOfDay(anchor) : view === 'workweek' ? addDays(sow, weekStart === 0 ? 1 : 0) : sow
  const e = addDays(s, view === 'workweek' ? 4 : view === 'agenda' ? 13 : 6)
  const end = s.getMonth() === e.getMonth() ? String(e.getDate()) : md(e)
  return `${md(s)} – ${end}${yearOf(e)}`
}
