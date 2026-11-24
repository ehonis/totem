// The owner's tasks and the shared sheet's action items on one scale (WorkTask), as
// the task badges on chat cards, a chat's task bar, the task card and the pickers read
// them, with the chats linked to each. Pure, and copied byte for byte to the app
// (mobile/src/lib/work/groups.ts).
import type { ChatThread, Project } from '../chat/types'
import type { SheetHiddenItem, SheetItem, SheetMark, Todo } from '../todos/types'

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
  /** A sheet row the owner marked done or snoozed in Totem (the sheet is untouched). */
  mark?: SheetMark
}

const SHEET_PRIORITY: Record<number, WorkTask['priority']> = { 1: 4, 2: 3, 3: 2 }

export function fromTodo(t: Todo): WorkTask {
  return {
    ref: t.id, kind: 'local', title: t.title, dueDate: t.dueDate, priority: t.priority,
    done: t.status === 'done', status: '', updatedAt: Date.parse(t.updatedAt) || 0,
    folderId: t.folderId ?? null, todo: t,
  }
}

/** A sheet row; one the owner marked (the feed's `hidden`) is done or snoozed here, as a task would be. */
export function fromSheet(i: SheetItem | SheetHiddenItem): WorkTask {
  const mark = 'mark' in i ? i.mark : undefined
  return {
    ref: i.id, kind: 'sheet', title: i.title, dueDate: i.dueDate, priority: i.priority ? SHEET_PRIORITY[i.priority] : 1,
    done: mark?.state === 'done', ...(mark?.state === 'snoozed' ? { hidden: true } : {}), status: i.status, url: i.url, updatedAt: 0,
    folderId: i.folderId ?? null, sheet: i, ...(mark ? { mark } : {}),
  }
}

/** What the snooze menu reads, for a local task or a sheet row. */
export function snoozeSubject(task: WorkTask): Pick<Todo, 'id' | 'title' | 'dueDate' | 'snoozedUntil'> {
  return task.todo ?? { id: task.ref, title: task.title, dueDate: task.dueDate, snoozedUntil: task.mark?.state === 'snoozed' ? task.mark.until ?? null : null }
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

const dueKey = (d: string | null) => (d ? d.slice(0, 16) : '\uffff')

/** Due day first (undated last), then the most urgent, then by title: the order a task picker lists them in. */
export function byDue(a: WorkTask, b: WorkTask): number {
  return dueKey(a.dueDate).localeCompare(dueKey(b.dueDate)) || b.priority - a.priority || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
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
