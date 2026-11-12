// The task list's shape, as pure functions, one copy for the web and the iPhone app:
// web/src/todos/board.ts is mirrored byte for byte to mobile/src/lib/todos/
// (mobile/src/features/todos/shared.test.mjs checks it). No React, React Native or
// DOM, so vitest and node's test runner both load it as is. Nothing here changes a
// task; it only decides where each one is drawn. A task is open or done.
import type { SheetFeed, SheetItem, Todo } from './types'
import { dateKey, isDayKey } from './format.ts'

/* ------------------------------------------------------------------ */
/* The grouped list: tasks and sheet rows by when they are due         */
/* ------------------------------------------------------------------ */

export type SectionKey = 'overdue' | 'today' | 'upcoming' | 'nodate'
export type ListItem = { kind: 'task'; todo: Todo } | { kind: 'sheet'; item: SheetItem }
export interface ListSection { key: SectionKey; items: ListItem[] }
export interface TaskList {
  /** In this order, each only when it has something in it. */
  sections: ListSection[]
  /** Finished tasks, most recently finished first. */
  completed: Todo[]
}

export const SECTION_ORDER: readonly SectionKey[] = ['overdue', 'today', 'upcoming', 'nodate']
export const SECTION_TITLE: Record<SectionKey, string> = { overdue: 'Overdue', today: 'Today', upcoming: 'Upcoming', nodate: 'No date' }

/** Which section a due date falls in, against today's day key. A value that is not a real day key has no date. */
export function sectionFor(dueDate: string | null, today: string): SectionKey {
  if (!isDayKey(dueDate)) return 'nodate'
  return dueDate < today ? 'overdue' : dueDate === today ? 'today' : 'upcoming'
}

/* ------------------------------------------------------------------ */
/* The task sheet: its name, and its priority beside a task's           */
/* ------------------------------------------------------------------ */

/** The sheet's name wherever it is shown: the feed's own title, else "Task sheet". */
export function sheetName(feed: SheetFeed | null | undefined): string {
  const title = feed && feed.configured ? feed.title?.trim() : ''
  return title || 'Task sheet'
}

/** A sheet row's priority as the sheet says it (the feed's 1, 2, 3). */
export const SHEET_PRIORITY_WORD: Record<1 | 2 | 3, 'High' | 'Medium' | 'Low'> = { 1: 'High', 2: 'Medium', 3: 'Low' }

/**
 * The task priority a sheet row's word ranks with, by meaning (a task says P1 Urgent,
 * P2 High, P3 Medium; stored inverted, so 4 is P1): High is P2, Medium P3, and Low is
 * in the P3 band too, so a P3 filter finds it. Blank is P4, no priority. Nothing on
 * the sheet is P1 Urgent. The list's order (urgency), a priority filter and a row's
 * colour all read this one mapping.
 */
export function sheetAsTaskPriority(priority: SheetItem['priority']): Todo['priority'] {
  return priority === 1 ? 3 : priority === 2 || priority === 3 ? 2 : 1
}

/**
 * Urgency as one scale, lower first: 1 for P1 Urgent to 3 for P3 Medium, a sheet row
 * at its task priority's place (sheetAsTaskPriority), with Low half a step after P3
 * so it follows Medium. A task's P4 is the default, "no priority", and ranks with a
 * sheet row whose priority is blank: last, where tasks then come first.
 */
export function urgency(item: ListItem): number {
  const priority = item.kind === 'task' ? item.todo.priority : sheetAsTaskPriority(item.item.priority)
  if (priority <= 1) return Number.POSITIVE_INFINITY
  return 5 - priority + (item.kind === 'sheet' && item.item.priority === 3 ? 0.5 : 0)
}

const dueOf = (item: ListItem) => {
  const due = item.kind === 'task' ? item.todo.dueDate : item.item.dueDate
  return isDayKey(due) ? due : null
}

/**
 * The order inside a section: due day (earliest first), then urgency, then tasks
 * before sheet rows, then a task's manual position or a sheet row's row number, and
 * the id last so equal rows never swap between renders.
 */
export function compareListItems(a: ListItem, b: ListItem): number {
  const dueA = dueOf(a)
  const dueB = dueOf(b)
  if (dueA !== dueB) {
    if (dueA === null) return 1
    if (dueB === null) return -1
    return dueA < dueB ? -1 : 1
  }
  const rankA = urgency(a)
  const rankB = urgency(b)
  if (rankA !== rankB) return rankA < rankB ? -1 : 1
  if (a.kind !== b.kind) return a.kind === 'task' ? -1 : 1
  if (a.kind === 'task' && b.kind === 'task') {
    return a.todo.position - b.todo.position || compareIds(a.todo.id, b.todo.id)
  }
  if (a.kind === 'sheet' && b.kind === 'sheet') {
    return a.item.row - b.item.row || compareIds(a.item.id, b.item.id)
  }
  return 0
}

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const finishedAt = (todo: Pick<Todo, 'completedAt' | 'updatedAt'>) => todo.completedAt ?? todo.updatedAt

/** Whether a task is out of the list for now: binned, archived, or snoozed past `now`. */
function setAside(todo: Todo, now: Date) {
  if (todo.deletedAt || todo.archivedAt) return true
  if (!todo.snoozedUntil) return false
  const until = new Date(todo.snoozedUntil).getTime()
  return !Number.isNaN(until) && until > now.getTime()
}

/**
 * What needs doing, grouped Overdue, Today, Upcoming, No date, with the sheet's open
 * rows mixed in by the same rules, and finished tasks apart. Today is the local
 * calendar day of `now`. The caller filters (search, scope); binned, archived and
 * still-snoozed tasks are left out here too, so a stale copy cannot draw them.
 */
export function buildList(todos: readonly Todo[], sheet: readonly SheetItem[], opts: { now: Date }): TaskList {
  const today = dateKey(opts.now)
  const buckets: Record<SectionKey, ListItem[]> = { overdue: [], today: [], upcoming: [], nodate: [] }
  const completed: Todo[] = []
  for (const todo of todos) {
    if (setAside(todo, opts.now)) continue
    if (todo.status === 'done') completed.push(todo)
    else buckets[sectionFor(todo.dueDate, today)].push({ kind: 'task', todo })
  }
  for (const item of sheet) buckets[sectionFor(item.dueDate, today)].push({ kind: 'sheet', item })
  return {
    sections: SECTION_ORDER
      .filter((key) => buckets[key].length > 0)
      .map((key) => ({ key, items: buckets[key].sort(compareListItems) })),
    completed: byFinished(completed),
  }
}

/* ------------------------------------------------------------------ */
/* Rows the app's list draws around the groups                          */
/* ------------------------------------------------------------------ */

export type BoardRow<Section extends string, Tone extends string> =
  | { kind: 'header'; key: string; title: string; count: number; tone: Tone; collapsible?: boolean; open?: boolean }
  | { kind: 'card'; key: string; todo: Todo; section: Section }
  /** "All clear": nothing is open at all, or nothing is due today with work still ahead. */
  | { kind: 'clear'; key: string; scope: 'all' | 'today' }
  | { kind: 'more'; key: string; count: number }
  | { kind: 'archive'; key: string; count: number }

export interface CompletedOptions {
  /** Completed is one folded row until opened. */
  completedOpen: boolean
  /** An open Completed shows this many before "Show n more". */
  doneLimit?: number
  showAllDone: boolean
  /** Manual order: Completed reads most recently finished first, since a finished card's position carries nothing. */
  manual: boolean
  archiveCount: number
}

/** A local "YYYY-MM-DD". */
export const dayKey = dateKey

/** Finished tasks, most recently finished first, for a Completed drawn under manual order. */
export function byFinished<T extends Pick<Todo, 'completedAt' | 'updatedAt' | 'id'>>(done: readonly T[]): T[] {
  return [...done].sort((a, b) => compareIds(finishedAt(b), finishedAt(a)) || compareIds(a.id, b.id))
}

/**
 * Whether "All clear" belongs at the top, and for what: nothing open at all, or
 * nothing due today. `filtered`: a search or filter is narrowing the list, so it
 * would claim more than it can see.
 */
export function clearScope(open: readonly Pick<Todo, 'dueDate'>[], visible: number, today: string, options: { filtered?: boolean }): 'all' | 'today' | null {
  // No claim about the day from a partial view.
  if (options.filtered) return null
  if (!open.length) return visible ? 'all' : null
  const dueNow = open.some((item) => {
    const section = sectionFor(item.dueDate, today)
    return section === 'overdue' || section === 'today'
  })
  return dueNow ? null : 'today'
}

/** Completed as one folded header, its cards once opened (capped, with "Show n more"), and the archive link at its foot. */
export function completedRows<Section extends string, Tone extends string>(done: readonly Todo[], options: CompletedOptions, section: Section, tone: Tone): BoardRow<Section, Tone>[] {
  if (!done.length) return []
  const { completedOpen, showAllDone, manual, archiveCount } = options
  const doneLimit = options.doneLimit ?? 12
  const ordered = manual ? byFinished(done) : done
  const rows: BoardRow<Section, Tone>[] = [{ kind: 'header', key: 'h-done', title: 'Completed', count: done.length, tone, collapsible: true, open: completedOpen }]
  if (completedOpen) {
    const shown = showAllDone ? ordered : ordered.slice(0, doneLimit)
    for (const item of shown) rows.push({ kind: 'card', key: item.id, todo: item, section })
    if (shown.length < ordered.length) rows.push({ kind: 'more', key: 'more', count: ordered.length - shown.length })
    // The archive is where Completed goes next, so its link sits at the foot of an open Completed (and in the toolbar's "…").
    if (archiveCount > 0) rows.push({ kind: 'archive', key: 'archive', count: archiveCount })
  }
  return rows
}

/**
 * Finished today, not counting "not doing": the number the board is proud of. Pass
 * the archive too, or filing finished tasks away at the archive hour takes the day's
 * count with them.
 */
export function doneToday(todos: readonly Pick<Todo, 'status' | 'outcome' | 'completedAt'>[], now: Date) {
  const today = dayKey(now)
  return todos.filter((todo) => todo.status === 'done' && todo.outcome !== 'not_doing' && !!todo.completedAt && dayKey(new Date(todo.completedAt)) === today).length
}

/** When the first snoozed task comes back, if any is still asleep. */
export function nextWake(snoozed: readonly Pick<Todo, 'snoozedUntil'>[], now: Date): Date | null {
  let soonest: number | null = null
  for (const todo of snoozed) {
    if (!todo.snoozedUntil) continue
    const at = new Date(todo.snoozedUntil).getTime()
    if (Number.isNaN(at) || at <= now.getTime()) continue
    if (soonest === null || at < soonest) soonest = at
  }
  return soonest === null ? null : new Date(soonest)
}

/** Snoozed tasks, the soonest back first. */
export function byWake<T extends Pick<Todo, 'snoozedUntil' | 'id'>>(snoozed: readonly T[]): T[] {
  const at = (todo: T) => (todo.snoozedUntil ? new Date(todo.snoozedUntil).getTime() : Number.POSITIVE_INFINITY)
  return [...snoozed].sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id))
}

/** "6:00 PM" today, "tomorrow 9:00 AM", "Mon 9:00 AM" within the week, "Nov 12" after: read mid-sentence ("Back …", "Snoozed until …"). */
export function wakeLabel(at: Date, now: Date) {
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at)
  // Rounded, so a 23- or 25-hour day between them still counts as one day.
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000)
  if (days <= 0) return time
  if (days === 1) return `tomorrow ${time}`
  if (days < 7) return `${new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(at)} ${time}`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at)
}

function startOfDay(value: Date) {
  const day = new Date(value)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/** The task a repeating one rolled into when it was finished (todos/service.mjs applyStatusChange), found among tasks that were not there before. */
export function rolledOccurrence(before: Pick<Todo, 'id' | 'title' | 'recurrence'>, beforeIds: ReadonlySet<string>, after: readonly Todo[]): Todo | null {
  if (!before.recurrence) return null
  return after.find((todo) => !beforeIds.has(todo.id) && todo.id !== before.id && todo.status === 'todo'
    && todo.title === before.title && todo.recurrence === before.recurrence) ?? null
}

/**
 * Whether finishing a task rolls its next occurrence on the bridge
 * (todos/service.mjs applyStatusChange): any repeating task with a due date. Nothing
 * owns completion any more, so an issue link or a link left by the retired sheet sync
 * does not stop it.
 */
export const rollsOnCompletion = (todo: Pick<Todo, 'recurrence' | 'dueDate'>) => Boolean(todo.recurrence && todo.dueDate)

/**
 * What finishing a task offers afterwards. Undo goes through the same move back,
 * except for a task that rolled: its next occurrence now exists and rolls only once
 * (rolled_from is unique), so a reopen would leave two copies. That one says when
 * the next is due instead.
 */
export type DoneFollowUp = { kind: 'undo' } | { kind: 'next'; dueDate: string | null }
export function afterDone(before: Todo, beforeIds: ReadonlySet<string>, after: readonly Todo[]): DoneFollowUp {
  if (!rollsOnCompletion(before)) return { kind: 'undo' }
  return { kind: 'next', dueDate: rolledOccurrence(before, beforeIds, after)?.dueDate ?? null }
}

/** Tomorrow at nine, the snooze most reached for; before five in the morning that is "this morning", not 28 hours away. */
export function morningSnooze(now: Date): { label: string; value: Date } {
  const at = new Date(now)
  at.setHours(9, 0, 0, 0)
  if (now.getHours() >= 5) at.setDate(at.getDate() + 1)
  return { label: now.getHours() >= 5 ? 'Tomorrow' : 'This morning', value: at }
}

/**
 * A status column's manual order with one task moved beside another: before it
 * going up, after it going down. The board draws a view (filtered, grouped), so
 * "up" means past the card you can see above, not past one hidden in between.
 */
export function moveBeside(ids: readonly string[], id: string, neighbour: string, direction: -1 | 1): string[] | null {
  if (id === neighbour || !ids.includes(id) || !ids.includes(neighbour)) return null
  const rest = ids.filter((item) => item !== id)
  const at = rest.indexOf(neighbour) + (direction > 0 ? 1 : 0)
  const next = [...rest.slice(0, at), id, ...rest.slice(at)]
  return next.every((item, index) => item === ids[index]) ? null : next
}
