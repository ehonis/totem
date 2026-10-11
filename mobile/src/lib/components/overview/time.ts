// Date helpers for the Overview. Habit days and task due dates are local
// "YYYY-MM-DD" strings; never hand those to `new Date(str)`, which reads them as
// UTC midnight and lands a day early west of Greenwich.

export const startOfDay = (d: Date | number | string) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }

export const isoToDate = (iso: string): Date => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

export const dateToIso = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const addDays = (iso: string, n: number): string => { const d = isoToDate(iso); d.setDate(d.getDate() + n); return dateToIso(d) }

/** Due values are a date-only string or a full RFC3339 datetime. */
export const dueToDate = (due: string): Date => (due.length <= 10 ? isoToDate(due) : new Date(due))

/** Whole days from today to `due` (negative = overdue). */
export const dueDiff = (due: string): number =>
  Math.round((startOfDay(dueToDate(due)).getTime() - startOfDay(new Date()).getTime()) / 86400000)

export function dueLabel(due: string): string {
  const diff = dueDiff(due)
  const d = dueToDate(due)
  if (diff === 0) return due.length > 10 ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Today'
  if (diff === -1) return 'Yesterday'
  if (diff === 1) return 'Tomorrow'
  if (diff < 0 && diff > -7) return `${-diff} days ago`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export const clock = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** "in 25m", "in 3h", "in 2d". */
export function until(ts: number): string {
  const diff = ts - Date.now()
  if (diff <= 0) return 'now'
  const mins = Math.round(diff / 60000)
  if (mins < 60) return `in ${Math.max(mins, 1)}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}

// Weeks run Monday to Sunday (since 2026-09-20) — the same rule HabitsView uses.
const weekStartOf = (iso: string): string => addDays(iso, -((isoToDate(iso).getDay() + 6) % 7))

/** Completions in the cadence period containing `date`. */
export function periodTotal(habit: any, entries: any, date: string): number {
  if (habit.cadence === 'weekly') {
    const start = weekStartOf(date)
    let t = 0
    for (let i = 0; i < 7; i++) t += entries[addDays(start, i)]?.[habit.id]?.count || 0
    return t
  }
  if (habit.cadence === 'monthly') {
    const ym = date.slice(0, 7)
    let t = 0
    for (const [d, day] of Object.entries<any>(entries)) if (d.startsWith(ym)) t += day?.[habit.id]?.count || 0
    return t
  }
  return entries[date]?.[habit.id]?.count || 0
}
