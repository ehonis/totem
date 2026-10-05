/**
 * Grouping for the archive.
 *
 * An empty Done column does not mean nothing was done — it means the six o'clock
 * sweep has already filed the day away. So the archive has to answer "when did I do
 * this", and the useful grain for that changes with the question: which day last
 * week, which week of the month, which month of the year.
 *
 * Grouping is by when the task *ended*, not when it was filed. Archiving is
 * bookkeeping that happens hours later and in bulk; a task finished at 16:00 belongs
 * to that afternoon even though it was swept at 18:00, and every task swept in the
 * same run would otherwise collapse into one indistinguishable pile.
 */
import type { Todo } from './types'

export type ArchivePeriod = 'day' | 'week' | 'month' | 'year'

export interface ArchiveGroup {
  key: string
  label: string
  todos: Todo[]
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** When a task ended, falling back to when it was filed for imported history. */
export function endedAt(todo: Todo): Date | null {
  const raw = todo.completedAt ?? todo.archivedAt
  if (!raw) return null
  const value = new Date(raw)
  return Number.isNaN(value.getTime()) ? null : value
}

function startOfDay(value: Date) {
  const day = new Date(value)
  day.setHours(0, 0, 0, 0)
  return day
}

/** Monday, because a week of work starts on one. */
function startOfWeek(value: Date) {
  const week = startOfDay(value)
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7))
  return week
}

function dayKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function bucket(value: Date, period: ArchivePeriod) {
  if (period === 'day') return { key: dayKey(value), at: startOfDay(value) }
  if (period === 'week') {
    const week = startOfWeek(value)
    return { key: `w${dayKey(week)}`, at: week }
  }
  if (period === 'month') {
    return { key: `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`, at: new Date(value.getFullYear(), value.getMonth(), 1) }
  }
  return { key: String(value.getFullYear()), at: new Date(value.getFullYear(), 0, 1) }
}

function label(at: Date, period: ArchivePeriod, now: Date) {
  if (period === 'year') return String(at.getFullYear())
  if (period === 'month') {
    return at.getFullYear() === now.getFullYear()
      ? MONTHS[at.getMonth()]
      : `${MONTHS[at.getMonth()]} ${at.getFullYear()}`
  }
  if (period === 'week') {
    const end = new Date(at)
    end.setDate(end.getDate() + 6)
    if (dayKey(at) === dayKey(startOfWeek(now))) return 'This week'
    const previous = startOfWeek(now)
    previous.setDate(previous.getDate() - 7)
    if (dayKey(at) === dayKey(previous)) return 'Last week'
    const sameMonth = at.getMonth() === end.getMonth()
    const from = `${MONTHS[at.getMonth()].slice(0, 3)} ${at.getDate()}`
    const to = sameMonth ? `${end.getDate()}` : `${MONTHS[end.getMonth()].slice(0, 3)} ${end.getDate()}`
    return `${from}–${to}`
  }
  const today = startOfDay(now)
  if (dayKey(at) === dayKey(today)) return 'Today'
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (dayKey(at) === dayKey(yesterday)) return 'Yesterday'
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][at.getDay()]
  const withinWeek = now.getTime() - at.getTime() < 7 * 24 * 60 * 60 * 1000
  const date = `${MONTHS[at.getMonth()].slice(0, 3)} ${at.getDate()}`
  if (withinWeek) return `${weekday}, ${date}`
  return at.getFullYear() === now.getFullYear() ? date : `${date}, ${at.getFullYear()}`
}

/**
 * Archived tasks bucketed by when they ended, newest bucket first and newest task
 * first inside each. Anything with no end date at all lands in one trailing group
 * rather than being dropped — an archived task with no timestamp is odd, but hiding
 * it would be worse than filing it under "undated".
 */
export function groupArchive(todos: Todo[], period: ArchivePeriod, now: Date = new Date()): ArchiveGroup[] {
  const groups = new Map<string, { at: Date | null; todos: Todo[] }>()
  for (const todo of todos) {
    const ended = endedAt(todo)
    const { key, at } = ended ? bucket(ended, period) : { key: 'undated', at: null }
    const group = groups.get(key) ?? { at, todos: [] }
    group.todos.push(todo)
    groups.set(key, group)
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      label: group.at ? label(group.at, period, now) : 'No date recorded',
      sortAt: group.at ? group.at.getTime() : -Infinity,
      todos: group.todos.sort((left, right) => (endedAt(right)?.getTime() ?? 0) - (endedAt(left)?.getTime() ?? 0)),
    }))
    .sort((left, right) => right.sortAt - left.sortAt)
    .map(({ key, label: text, todos: items }) => ({ key, label: text, todos: items }))
}
