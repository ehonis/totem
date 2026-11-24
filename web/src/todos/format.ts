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

function dayTimeLabel(value: Date) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(value)
}

export interface SnoozeTime { label: string; detail: string; value: Date }

// Nine in the morning `days` calendar days from now: stepped by day key, never by 24 hours,
// so the night the clocks change still lands on the right morning.
function morningIn(now: Date, days: number) {
  const at = new Date(now)
  at.setDate(at.getDate() + days)
  at.setHours(9, 0, 0, 0)
  return at
}

function dayDateTimeLabel(value: Date) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(value)
}

/**
 * The snooze presets, the three the owner reaches for: tomorrow, three days and a
 * whole week, each to nine in the morning. Anything else is the menu's own time picker.
 */
export function snoozeTimes(now: Date): SnoozeTime[] {
  const tomorrow = morningIn(now, 1)
  const three = morningIn(now, 3)
  const week = morningIn(now, 7)
  return [
    { label: 'Tomorrow', detail: dayTimeLabel(tomorrow), value: tomorrow },
    { label: 'For 3 days', detail: dayTimeLabel(three), value: three },
    // A week on is the same weekday as today, so it names the date.
    { label: 'For a week', detail: dayDateTimeLabel(week), value: week },
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
