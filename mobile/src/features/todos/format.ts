// The card's date arithmetic (web/src/todos/TodoCard.tsx), lifted out so the card,
// its native menus and the detail sheet share one copy.
import type { TodoStatus } from '../../lib/todos/types'

export const STATUS_LABEL: Record<TodoStatus, string> = { todo: 'To Do', doing: 'Doing', done: 'Done' }
export const SOURCE_LABEL = { local: 'Private', github: 'GitHub', sheet: 'Sheet' } as const

export function dateLabel(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(year, month - 1, day))
}

export function timeLabel(value: Date) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(value)
}

function dayTimeLabel(value: Date) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(value)
}

function dueDayLabel(value: Date) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(value)
}

// Nine in the morning on the due date: the last moment a snooze can end and still leave the day to work with.
function dueMorning(dueDate: string) {
  const [year, month, day] = dueDate.split('-').map(Number)
  return new Date(year, month - 1, day, 9, 0, 0, 0)
}

// A week of lead time when there is a week to spare, otherwise the largest shorter run-up that still lands in the future.
function leadDays(daysUntilDue: number) {
  if (daysUntilDue >= 8) return 7
  if (daysUntilDue >= 4) return 2
  if (daysUntilDue >= 2) return 1
  return 0
}

function dueTimes(now: Date, dueDate: string | null) {
  if (!dueDate) return []
  const due = dueMorning(dueDate)
  if (due <= now) return []
  const today = new Date(now)
  today.setHours(9, 0, 0, 0)
  const daysUntilDue = Math.round((due.getTime() - today.getTime()) / 86_400_000)
  const lead = leadDays(daysUntilDue)
  const options = []
  if (lead) {
    const runUp = new Date(due)
    runUp.setDate(runUp.getDate() - lead)
    const label = lead === 7 ? 'A week before it’s due' : lead === 2 ? 'Two days before it’s due' : 'The day before it’s due'
    options.push({ label, detail: dueDayLabel(runUp), value: runUp })
  }
  options.push({ label: 'The day it’s due', detail: dueDayLabel(due), value: due })
  return options
}

export function snoozeTimes(now: Date, dueDate: string | null = null) {
  const minutes = new Date(now.getTime() + 20 * 60_000)
  const hour = new Date(now.getTime() + 60 * 60_000)
  const evening = new Date(now)
  evening.setHours(18, 0, 0, 0)
  if (evening <= now) evening.setDate(evening.getDate() + 1)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  const nextMonday = new Date(now)
  const daysUntilMonday = (8 - nextMonday.getDay()) % 7 || 7
  nextMonday.setDate(nextMonday.getDate() + daysUntilMonday)
  nextMonday.setHours(9, 0, 0, 0)
  return [
    { label: 'In 20 minutes', detail: timeLabel(minutes), value: minutes },
    { label: 'In 1 hour', detail: timeLabel(hour), value: hour },
    { label: 'This evening', detail: timeLabel(evening), value: evening },
    { label: 'Tomorrow', detail: dayTimeLabel(tomorrow), value: tomorrow },
    { label: 'Next Monday', detail: dayTimeLabel(nextMonday), value: nextMonday },
    ...dueTimes(now, dueDate),
  ]
}

export function dateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

/** A local "YYYY-MM-DDTHH:mm" (the web's datetime-local value) for a Date. */
export function localDateTimeKey(value: Date) {
  return `${dateKey(value)}T${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
}

/** Parse a "YYYY-MM-DD" day key as local midnight. */
export function parseDateKey(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

// The quick reschedule set. A due date is a plain local calendar day, so these are day
// keys rather than instants — there is no time of day to preserve.
export function dueDateChoices(now: Date) {
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const nextWeek = new Date(now)
  nextWeek.setDate(nextWeek.getDate() + ((8 - nextWeek.getDay()) % 7 || 7))
  return [
    { label: 'Today', key: dateKey(now) },
    { label: 'Tomorrow', key: dateKey(tomorrow) },
    { label: 'Next week', key: dateKey(nextWeek) },
  ].map((option) => ({ ...option, detail: dateLabel(option.key) }))
}

export type DueTone = '' | 'overdue' | 'today' | 'upcoming'

// A finished task has no due state left to report. Leaving the date red said the
// task was late at a moment when lateness had stopped being a fact about it.
export function dueTone(value: string | null, now: Date, status: TodoStatus): DueTone {
  if (!value || status === 'done') return ''
  const key = dateKey(now)
  return value < key ? 'overdue' : value === key ? 'today' : 'upcoming'
}

/** "18:00" as the clock reads it where you are. */
export function archiveHourLabel(value: string) {
  const [hours, minutes] = value.split(':').map(Number)
  const at = new Date()
  at.setHours(hours, minutes, 0, 0)
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at)
}
