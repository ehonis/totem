// The chats panel's Tasks face, as data: the owner's open tasks and the shared
// sheet's action items, each with the chats linked to it, sorted and grouped by
// the chat project or folder it is filed under (the task's `folderId`; a sheet
// row's comes filed by the bridge). Pure, so the panel and its tests read the
// same rules.
import type { ChatThread, Project } from '../chat/types'
import type { SheetItem, Todo } from '../todos/types'

/** One thing the panel lists: a local task or a sheet row, on one scale. */
export interface WorkTask {
  /** A local task's id, or the sheet row's ("sheet:<gid>:<row>:<hash>"). */
  ref: string
  kind: 'local' | 'sheet'
  title: string
  /** "YYYY-MM-DD" (a local task may carry a time after it). */
  dueDate: string | null
  /** The task board's scale: 4 is the most urgent, 1 none. */
  priority: 1 | 2 | 3 | 4
  done: boolean
  /** Open but off the list for now: snoozed or archived. Still named by a chat's strip. */
  hidden?: boolean
  /** A sheet row's status words ("In Progress"); empty for a local task. */
  status: string
  /** The sheet row, for a sheet item. */
  url?: string
  /** When it last changed (local tasks); sheet rows have no clock. */
  updatedAt: number
  /** The chat project or folder it is filed under; null is Personal. */
  folderId: string | null
  /** The task itself, for a local one (the task card edits it). */
  todo?: Todo
  /** The row itself, for a sheet item. */
  sheet?: SheetItem
}

export type WorkSort = 'due' | 'priority' | 'activity' | 'title'
export type WorkGroupBy = 'folder' | 'none'
export type WorkShow = 'all' | 'linked' | 'unlinked'

export interface WorkRow {
  task: WorkTask
  /** Chats linked to it, the latest first. */
  chats: ChatThread[]
  /** The latest of its chats' activity, or its own last change. */
  lastActivity: number
}

export interface WorkGroup {
  /** The project or folder id, or '' for tasks filed nowhere (Personal). */
  key: string
  project: Project | null
  /** A folder's project, so the header can say where it is. */
  parent: Project | null
  rows: WorkRow[]
}

export interface WorkOptions {
  sort: WorkSort
  groupBy: WorkGroupBy
  show: WorkShow
  query: string
}

const SHEET_PRIORITY: Record<number, WorkTask['priority']> = { 1: 4, 2: 3, 3: 2 }

export function fromTodo(t: Todo): WorkTask {
  return {
    ref: t.id, kind: 'local', title: t.title, dueDate: t.dueDate, priority: t.priority,
    done: t.status === 'done', status: '', updatedAt: Date.parse(t.updatedAt) || 0,
    folderId: t.folderId ?? null, todo: t,
  }
}

export function fromSheet(i: SheetItem): WorkTask {
  return {
    ref: i.id, kind: 'sheet', title: i.title, dueDate: i.dueDate, priority: i.priority ? SHEET_PRIORITY[i.priority] : 1,
    done: false, status: i.status, url: i.url, updatedAt: 0,
    folderId: i.folderId ?? null, sheet: i,
  }
}

/** Open, not snoozed, not archived or deleted: what belongs on the panel. */
export function isOpenTodo(t: Todo, now: Date): boolean {
  if (t.status === 'done' || t.archivedAt || t.deletedAt) return false
  return !(t.snoozedUntil && Date.parse(t.snoozedUntil) > now.getTime())
}

// A sheet row's id is "sheet:<gid>:<row>:<hash of its title>": a row inserted or
// deleted above it changes the id. A stored ref (a chat's taskId, a filing) finds
// its row again by tab and title when exactly one row still matches. The bridge's
// findSheetItem (chat/task-link.mjs) reads stored refs the same way.
const SHEET_REF = /^sheet:([^:]+):\d+:([^:]+)$/

/** The ref a stored one names now; unchanged when it is current or cannot be matched. */
export function resolveRef(ref: string, tasks: readonly WorkTask[]): string {
  if (!ref.startsWith('sheet:') || tasks.some((t) => t.ref === ref)) return ref
  const m = SHEET_REF.exec(ref)
  if (!m) return ref
  const same = tasks.filter((t) => { const n = t.kind === 'sheet' && SHEET_REF.exec(t.ref); return !!n && n[1] === m[1] && n[2] === m[2] })
  return same.length === 1 ? same[0].ref : ref
}

/** Every thread linked to each task, latest first. Empty drafts are not chats yet. */
export function chatsByTask(threads: readonly ChatThread[], tasks: readonly WorkTask[] = []): Map<string, ChatThread[]> {
  const out = new Map<string, ChatThread[]>()
  for (const t of threads) {
    if (!t.taskId || !t.messages?.length) continue
    const ref = resolveRef(t.taskId, tasks)
    const list = out.get(ref) || []
    list.push(t)
    out.set(ref, list)
  }
  for (const list of out.values()) list.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

const dueKey = (d: string | null) => (d ? d.slice(0, 16) : '￿')
const byTitle = (a: WorkRow, b: WorkRow) => a.task.title.localeCompare(b.task.title, undefined, { sensitivity: 'base' })

export function compareRows(sort: WorkSort): (a: WorkRow, b: WorkRow) => number {
  if (sort === 'title') return byTitle
  if (sort === 'activity') return (a, b) => b.lastActivity - a.lastActivity || byTitle(a, b)
  if (sort === 'priority') return (a, b) => b.task.priority - a.task.priority || dueKey(a.task.dueDate).localeCompare(dueKey(b.task.dueDate)) || byTitle(a, b)
  return (a, b) => dueKey(a.task.dueDate).localeCompare(dueKey(b.task.dueDate)) || b.task.priority - a.task.priority || byTitle(a, b)
}

/** Projects in the panel's order, each followed by its folders. */
export function folderOrder(projects: readonly Project[]): Project[] {
  const roots = projects.filter((p) => !p.parentId)
  return roots.flatMap((p) => [p, ...projects.filter((f) => f.parentId === p.id)])
}

/** A task's folder, if that project still exists. */
export function folderOf(task: Pick<WorkTask, 'folderId'>, projects: readonly Project[]): Project | null {
  const id = task.folderId
  return (id && projects.find((p) => p.id === id)) || null
}

function matches(task: WorkTask, chats: ChatThread[], query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (task.title.toLowerCase().includes(q) || task.status.toLowerCase().includes(q)) return true
  return chats.some((c) => (c.title || '').toLowerCase().includes(q))
}

/**
 * The panel's groups: by folder (projects in panel order, each folder after its
 * project, then Personal), or one group of everything. Groups with nothing in
 * them are left out.
 */
export function buildWork(
  tasks: readonly WorkTask[],
  threads: readonly ChatThread[],
  projects: readonly Project[],
  opts: WorkOptions,
): WorkGroup[] {
  const linked = chatsByTask(threads, tasks)
  const rows: Array<WorkRow & { folder: Project | null }> = []
  for (const task of tasks) {
    if (task.done || task.hidden) continue
    const chats = linked.get(task.ref) || []
    if (opts.show === 'linked' && !chats.length) continue
    if (opts.show === 'unlinked' && chats.length) continue
    if (!matches(task, chats, opts.query)) continue
    rows.push({ task, chats, lastActivity: Math.max(task.updatedAt, chats[0]?.updatedAt || 0), folder: folderOf(task, projects) })
  }
  const cmp = compareRows(opts.sort)
  const strip = ({ folder: _f, ...row }: WorkRow & { folder: Project | null }): WorkRow => row
  if (opts.groupBy === 'none') {
    return rows.length ? [{ key: '', project: null, parent: null, rows: rows.sort(cmp).map(strip) }] : []
  }
  const groups: WorkGroup[] = []
  for (const p of folderOrder(projects)) {
    const inside = rows.filter((r) => r.folder?.id === p.id)
    if (!inside.length) continue
    groups.push({ key: p.id, project: p, parent: p.parentId ? projects.find((x) => x.id === p.parentId) || null : null, rows: inside.sort(cmp).map(strip) })
  }
  const loose = rows.filter((r) => !r.folder)
  if (loose.length) groups.push({ key: '', project: null, parent: null, rows: loose.sort(cmp).map(strip) })
  return groups
}

/** Day key for "today" in the browser's zone. */
export function todayKey(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** "Overdue", "Today", "Tomorrow", "Fri", "Nov 28": short enough for a sidebar row. */
export function dueLabel(due: string | null, now: Date): { text: string; tone: 'overdue' | 'today' | 'soon' | 'later' } | null {
  if (!due) return null
  const day = due.slice(0, 10)
  const today = todayKey(now)
  if (day < today) return { text: 'Overdue', tone: 'overdue' }
  if (day === today) return { text: 'Today', tone: 'today' }
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.round((date.getTime() - start.getTime()) / 86_400_000)
  if (days === 1) return { text: 'Tomorrow', tone: 'soon' }
  if (days < 7) return { text: date.toLocaleDateString(undefined, { weekday: 'short' }), tone: 'soon' }
  return { text: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), tone: 'later' }
}
