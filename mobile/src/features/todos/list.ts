// The Tasks page's rows, as pure functions over the shared list (lib/todos/board.ts
// buildList, the web's copy): open tasks and the task sheet's rows in one set of
// groups (Overdue, Today, Upcoming, No date), ordered by due day, priority, tasks
// before sheet rows, then manual position; and Completed folded into one row. A task
// is open or done. No React Native, so node's test runner loads it as is.
import type { SheetFeed, SheetItem, Todo, TodoArea, TodoQuery, VentureTag } from '../../lib/todos/types'
import { trimUrl } from './issueLink.ts'
import {
  SECTION_TITLE, buildList, clearScope, completedRows, dayKey, sectionFor, sheetAsTaskPriority, sheetName, urgency,
  type BoardRow, type ListItem, type SectionKey,
} from '../../lib/todos/board.ts'

// The sheet's name and its priority beside a task's are the shared list's (one mapping
// for the order, the filter and the colours), handed on so the app's screens import them here.
export { SHEET_PRIORITY_WORD, sheetAsTaskPriority, sheetName } from '../../lib/todos/board.ts'

export type SectionTone = 'overdue' | 'today' | 'upcoming' | 'quiet' | 'completed'
/** Which run of rows a row is drawn in; "Move up/down" stays inside it. */
export type RowSection = SectionKey | 'done'

export type Row =
  | Exclude<BoardRow<RowSection, SectionTone>, { kind: 'card' }>
  | { kind: 'card'; key: string; todo: Todo; section: RowSection }
  | { kind: 'sheet'; key: string; item: SheetItem; section: SectionKey }

const TONE: Record<SectionKey, SectionTone> = { overdue: 'overdue', today: 'today', upcoming: 'upcoming', nodate: 'quiet' }

/**
 * What the list shows. `scope` narrows to one area or to the sheet alone; the rest
 * are the task filters (state.ts filterTodos), which the sheet's rows follow where
 * they mean something for a row (search, priority, due).
 */
export type ListScope = '' | TodoArea | 'sheet'
export interface ListQuery {
  search?: string
  scope?: ListScope
  ventureTag?: VentureTag | ''
  /** A task's stored priority: 4 is P1. */
  priority?: Todo['priority'] | null
  due?: TodoQuery['due']
}

export const isFiltering = (query: ListQuery) =>
  Boolean(query.search?.trim() || query.scope || query.ventureTag || query.priority || query.due)

/** The task filter (state.ts filterTodos) a list query stands for, or null when it shows the sheet alone and no task at all. */
export function taskQuery(query: ListQuery): TodoQuery | null {
  if (query.scope === 'sheet') return null
  return { search: query.search, area: query.scope || '', ventureTag: query.ventureTag || '', priority: query.priority ?? null, due: query.due || '' }
}

/**
 * The sheet's rows under a query. A sheet row has no area or venture, so narrowing to
 * either hides them all; the priority filter matches by sheetAsTaskPriority (lib/todos/board.ts).
 */
export function visibleSheet(items: readonly SheetItem[], query: ListQuery, now: Date): SheetItem[] {
  if (query.scope === 'Personal' || query.scope === 'Ventures' || query.ventureTag) return []
  const needle = query.search?.trim().toLocaleLowerCase()
  const today = dayKey(now)
  return items.filter((item) => {
    if (query.priority && sheetAsTaskPriority(item.priority) !== query.priority) return false
    if (query.due) {
      const section = sectionFor(item.dueDate, today)
      if ((query.due === 'none' ? 'nodate' : query.due) !== section) return false
    }
    if (!needle) return true
    return [item.title, item.notes, item.who, item.status].join('\n').toLocaleLowerCase().includes(needle)
  })
}

export interface RowOptions {
  now: Date
  /** Completed is one folded row until opened. */
  completedOpen: boolean
  showAllDone: boolean
  archiveCount: number
  /** A search or filter is narrowing the list, so "all clear" would claim more than it can see. */
  filtered?: boolean
  doneLimit?: number
}

/** The page's rows: the "all clear" note when it applies, the due groups with sheet rows mixed in, then Completed. */
export function listRows(todos: readonly Todo[], sheet: readonly SheetItem[], options: RowOptions): Row[] {
  const { now } = options
  const list = buildList(todos, sheet, { now })
  const rows: Row[] = []
  const open = list.sections.flatMap((section) => section.items.map(itemDue))
  const clear = clearScope(open, open.length + list.completed.length, dayKey(now), { filtered: options.filtered })
  if (clear) rows.push({ kind: 'clear', key: 'clear', scope: clear })
  for (const section of list.sections) {
    rows.push({ kind: 'header', key: `h-${section.key}`, title: SECTION_TITLE[section.key], count: section.items.length, tone: TONE[section.key] })
    for (const item of section.items) {
      rows.push(item.kind === 'task'
        ? { kind: 'card', key: item.todo.id, todo: item.todo, section: section.key }
        : { kind: 'sheet', key: item.item.id, item: item.item, section: section.key })
    }
  }
  rows.push(...completedRows<RowSection, SectionTone>(list.completed, {
    completedOpen: options.completedOpen, showAllDone: options.showAllDone, manual: true,
    archiveCount: options.archiveCount, doneLimit: options.doneLimit,
  }, 'done', 'completed'))
  return rows
}

const itemDue = (item: ListItem) => ({ dueDate: item.kind === 'task' ? item.todo.dueDate : item.item.dueDate })

/** Open tasks and sheet rows due today or already late, unfiltered: the "N left today" in the status line. */
export function leftToday(todos: readonly Todo[], sheet: readonly SheetItem[], now: Date): number {
  return buildList(todos, sheet, { now }).sections
    .filter((section) => section.key === 'overdue' || section.key === 'today')
    .reduce((sum, section) => sum + section.items.length, 0)
}

/** The earliest date among rows drawn under Upcoming, task or sheet row. */
export function nextDue(rows: readonly Row[]): string | null {
  let soonest: string | null = null
  for (const row of rows) {
    if (row.kind !== 'card' && row.kind !== 'sheet') continue
    if (row.section !== 'upcoming') continue
    const due = row.kind === 'card' ? row.todo.dueDate : row.item.dueDate
    if (due && (!soonest || due < soonest)) soonest = due
  }
  return soonest
}

/**
 * For each open task, the task drawn above and below it that only its manual position
 * puts there: the same section, due day and priority. Past a different date or
 * priority (or a sheet row) the list's order is not the owner's to change, so "Move
 * up/down" has nowhere to go. Completed reads newest first and never reorders.
 */
export function orderNeighbours(rows: readonly Row[]): Map<string, { up: string | null; down: string | null }> {
  const out = new Map<string, { up: string | null; down: string | null }>()
  let last: Extract<Row, { kind: 'card' }> | null = null
  for (const row of rows) {
    if (row.kind !== 'card' || row.section === 'done') { last = null; continue }
    const same = last && last.section === row.section && last.todo.dueDate === row.todo.dueDate
      && urgency({ kind: 'task', todo: last.todo }) === urgency({ kind: 'task', todo: row.todo }) ? last : null
    out.set(row.todo.id, { up: same ? same.todo.id : null, down: null })
    if (same) out.get(same.todo.id)!.down = row.todo.id
    last = row
  }
  return out
}

/** How long a ticked card stays on screen before it leaves: long enough to see it, and to take it back (the web's DONE_BEAT_MS). */
export const DONE_BEAT_MS = 650

/**
 * What a right swipe does: the same as the check circle. An open task is done (after
 * the circle's beat), a finished one reopens. There is no other status to move to.
 */
export function swipeRight(todo: Pick<Todo, 'status'>): { to: 'done' | 'todo'; label: 'Done' | 'Reopen' } {
  return todo.status === 'done' ? { to: 'todo', label: 'Reopen' } : { to: 'done', label: 'Done' }
}

/** The spoken status of a card: only what is not the default. */
export function spokenState(todo: Pick<Todo, 'status' | 'outcome'>): string | null {
  if (todo.outcome === 'not_doing') return 'not doing'
  return todo.status === 'done' ? 'done' : null
}

/** "owner/repo#12", the key GET /api/todos/issue-states answers under. */
export const issueKey = (link: { repo: string; number: number }) => `${link.repo}#${link.number}`

/** A task's issue link, from the DTO, or a cached answer from before the field existed: null. */
export const issueLinkOf = (todo: Pick<Todo, 'issueLink'>) => todo.issueLink ?? null

/** What the sheet line under the list says, or null when the rows say it themselves. */
export function sheetNote(feed: SheetFeed | null, loadError: string): { tone: 'quiet' | 'problem'; text: string } | null {
  const name = sheetName(feed)
  if (!feed) return loadError ? { tone: 'problem', text: `${name} could not load. Tap to try again.` } : null
  if (!feed.configured) return null
  if (feed.error || feed.stale || loadError) {
    return feed.fetchedAt
      ? { tone: 'problem', text: `${name} could not refresh; last read ${clock(feed.fetchedAt)}. Tap to try again.` }
      : { tone: 'problem', text: `${name} could not load. Tap to try again.` }
  }
  return feed.items.length ? null : { tone: 'quiet', text: `Nothing open in ${name} is assigned to you.` }
}

/**
 * What the list says when it shows the sheet alone and has no row to draw.
 * `configured` is the feed's own answer, or null when there is none yet: still
 * reading, or the read failed, which is not the same as "not set up".
 */
export function sheetOnlyEmpty(name: string, configured: boolean | null, loadError: string): { title: string; body: string } {
  if (configured === true) return { title: `Nothing in ${name} for you`, body: 'No open row is assigned to you, or none fits this search.' }
  if (configured === false) return { title: 'The task sheet is not set up', body: 'Choose the sheet in Settings → Tasks › Task sheet, and its rows join this list.' }
  return loadError
    ? { title: `${name} could not be read`, body: `${loadError}\nPull down to try again.` }
    : { title: `Reading ${name}…`, body: 'Its rows join this list once they arrive.' }
}

const clock = (iso: string) => {
  const at = new Date(iso)
  const sameDay = dayKey(at) === dayKey(new Date())
  return new Intl.DateTimeFormat(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at)
}

/**
 * A sheet note cut into plain runs and links, so the links can be tapped while the
 * text stays one selectable block. Only http(s) URLs; a trailing full stop or comma, or
 * a closing bracket the URL did not open, is the sentence's, not the link's (trimUrl).
 */
export function linkParts(text: string): { text: string; url?: string }[] {
  const parts: { text: string; url?: string }[] = []
  let at = 0
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    const url = trimUrl(match[0])
    const start = match.index ?? 0
    if (start > at) parts.push({ text: text.slice(at, start) })
    parts.push({ text: url, url })
    at = start + url.length
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}
