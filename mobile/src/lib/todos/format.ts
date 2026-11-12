// The task list's date words and day arithmetic, one copy for the web and the iPhone
// app: web/src/todos/format.ts is mirrored byte for byte to mobile/src/lib/todos/
// (mobile/src/features/todos/shared.test.mjs checks it). Pure: no React, React Native
// or DOM, so vitest and node's test runner both load it as is.
//
// A due date is a plain local calendar day ("YYYY-MM-DD"), so day arithmetic steps
// day keys (addDays) and never adds 24 hours to an instant: on the night the clocks
// spring forward, "now + 24 h" lands two calendar days later.
import type { TodoStatus } from './types'

export const STATUS_LABEL: Record<TodoStatus, string> = { todo: 'To Do', done: 'Done' }
export const SOURCE_LABEL = { local: 'Private', github: 'GitHub', sheet: 'Sheet' } as const

const pad = (value: number) => String(value).padStart(2, '0')
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/

/** The local calendar day of an instant, as "YYYY-MM-DD". */
export function dateKey(value: Date) {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

/** Whether a value is a "YYYY-MM-DD" day key naming a real day (not "2026-02-30"). */
export function isDayKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const at = parseDateKey(value)
  return at !== null && dateKey(at) === value
}

/** Parse a "YYYY-MM-DD" day key as local midnight. */
export function parseDateKey(value: string): Date | null {
  const match = DAY_KEY.exec(value)
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

/**
 * The day key `days` calendar days after `key` (negative goes back). Counted at local
 * noon, so a zone whose clocks change at midnight cannot push it into the wrong day.
 */
export function addDays(key: string, days: number) {
  const match = DAY_KEY.exec(key)
  if (!match) throw new RangeError(`Not a day key: ${key}`)
  return dateKey(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days, 12))
}

/** A local "YYYY-MM-DDTHH:mm" (the web's datetime-local value) for a Date. */
export function localDateTimeKey(value: Date) {
  return `${dateKey(value)}T${pad(value.getHours())}:${pad(value.getMinutes())}`
}

/** "Nov 12" for a day key. */
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

export interface SnoozeTime { label: string; detail: string; value: Date }

function dueTimes(now: Date, dueDate: string | null): SnoozeTime[] {
  if (!dueDate) return []
  const due = dueMorning(dueDate)
  if (due <= now) return []
  const today = new Date(now)
  today.setHours(9, 0, 0, 0)
  // Rounded, so a 23- or 25-hour day between them still counts as one day.
  const daysUntilDue = Math.round((due.getTime() - today.getTime()) / 86_400_000)
  const lead = leadDays(daysUntilDue)
  const options: SnoozeTime[] = []
  if (lead) {
    const runUp = new Date(due)
    runUp.setDate(runUp.getDate() - lead)
    const label = lead === 7 ? 'A week before it’s due' : lead === 2 ? 'Two days before it’s due' : 'The day before it’s due'
    options.push({ label, detail: dueDayLabel(runUp), value: runUp })
  }
  options.push({ label: 'The day it’s due', detail: dueDayLabel(due), value: due })
  return options
}

/**
 * The snooze presets: two short ones counted in minutes (an instant is right there),
 * then this evening, tomorrow and next Monday stepped by calendar day, then a run-up
 * to the due date when the task has one still ahead.
 */
export function snoozeTimes(now: Date, dueDate: string | null = null): SnoozeTime[] {
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

// The quick reschedule set. A due date is a plain local calendar day, so these are day
// keys rather than instants: there is no time of day to preserve.
export function dueDateChoices(now: Date) {
  const today = dateKey(now)
  return [
    { label: 'Today', key: today },
    { label: 'Tomorrow', key: addDays(today, 1) },
    { label: 'Next week', key: addDays(today, (8 - now.getDay()) % 7 || 7) },
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

/** A row's due words: "Overdue · Oct 30", "Today", "Tomorrow", "Nov 12". A finished task gets the plain date. */
export function dueText(dueDate: string, now: Date, status: TodoStatus = 'todo') {
  const tone = dueTone(dueDate, now, status)
  if (tone === 'today') return 'Today'
  if (tone === 'overdue') return `Overdue · ${dateLabel(dueDate)}`
  return tone === 'upcoming' && dueDate === addDays(dateKey(now), 1) ? 'Tomorrow' : dateLabel(dueDate)
}

/** "18:00" as the clock reads it where you are. */
export function archiveHourLabel(value: string) {
  const [hours, minutes] = value.split(':').map(Number)
  const at = new Date()
  at.setHours(hours, minutes, 0, 0)
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at)
}
