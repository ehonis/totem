export type TodoArea = 'Personal' | 'Ventures'
// Configured per install (Settings -> Tasks); any non-empty name.
export type VentureTag = string
export interface VentureTagConfig { name: string; color: string | null }
// A task is open or done. The bridge still accepts 'doing' on input for old clients
// and stores it as 'todo'; nothing here names it (board.ts folds a cached one into open).
export type TodoStatus = 'todo' | 'done'
/** How a finished task ended: the work happened, or it never will. */
export type TodoOutcome = 'completed' | 'not_doing'
export type TodoSource = 'local' | 'github' | 'sheet'
export type TodoSort = 'manual' | 'priority' | 'due' | 'created' | 'updated'
export type TodoSortOrder = readonly TodoSort[]
export type TodoDueFilter = 'overdue' | 'today' | 'upcoming' | 'none'
export type SyncTarget = TodoSource

export interface TodoTag { id: string; name: string }
export interface TodoNote { id: string; body: string; createdAt: string }
export interface TodoRelation {
  id: string
  title: string
  status: TodoStatus
  area: TodoArea
  ventureTag: VentureTag | null
}

export interface TodoExternalLink {
  id: string
  connector: Exclude<TodoSource, 'local'> | string
  externalId: string
  externalUrl: string | null
  sourceStatus: string | null
  sourceSnapshot: unknown
  lastSyncSnapshot: unknown
  initialStatusSeeded: boolean
  lastObservedAt: string | null
  lastSyncedAt: string | null
  missingAt: string | null
  createdAt: string
  updatedAt: string
}

/** A task's plain GitHub issue link (PUT /api/todos/:id/issue-link); no sync behind it. */
export interface TodoIssueLink {
  connector: 'github'
  /** owner/repo */
  repo: string
  number: number
  url: string
}

/** Tasks off the board, counted by GET /api/todos/board rather than listed. */
export interface TodoBoardCounts { archived: number; snoozed: number; deleted: number }

export interface IssueState { state: 'open' | 'closed'; title: string; url: string }
/** GET /api/todos/issue-states. On a failed read: the last good states plus `error`. */
export interface IssueStatesResponse {
  fetchedAt: string | null
  /** Keyed "owner/repo#n". */
  states: Record<string, IssueState>
  error?: string
}

export type TodoSyncStatus = 'idle' | 'pending' | 'synced' | 'conflict' | 'missing' | 'error'
export interface TodoSyncState {
  status: TodoSyncStatus
  pending: number
  conflicts: number
  exhausted: number
  missing: boolean
  lastSuccessAt: string | null
  lastError: string | null
}

export interface Todo {
  id: string
  title: string
  description: string
  area: TodoArea
  ventureTag: VentureTag | null
  status: TodoStatus
  priority: 1 | 2 | 3 | 4
  dueDate: string | null
  recurrence: string | null
  snoozedUntil: string | null
  position: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
  /** How a finished task ended; null while it is still open. */
  outcome: TodoOutcome | null
  archivedAt: string | null
  deletedAt: string | null
  tags: TodoTag[]
  notes: TodoNote[]
  relations: TodoRelation[]
  /** Lightweight Lists that reference this task. Checking either side does not mutate the other. */
  lists: Array<{ id: string; title: string }>
  externalLinks: TodoExternalLink[]
  /** The task's GitHub issue, or null. */
  issueLink: TodoIssueLink | null
  syncState: TodoSyncState
}

export interface TodoQuery {
  search?: string
  outcome?: TodoOutcome | ''
  area?: TodoArea | ''
  ventureTag?: VentureTag | ''
  priority?: Todo['priority'] | null
  due?: TodoDueFilter | ''
  source?: TodoSource | ''
  status?: TodoStatus | ''
  sort?: TodoSort
  snoozed?: boolean
  archived?: boolean
  deleted?: boolean
}

export type TodoPatch = Partial<Pick<Todo,
  'title' | 'description' | 'area' | 'ventureTag' | 'priority' | 'dueDate' |
  'recurrence' | 'snoozedUntil' | 'position'
>> & { tags?: string[] }

export interface TodoConflict {
  id?: string
  todoId: string
  source: Exclude<TodoSource, 'local'>
  fields: string[]
  local?: Record<string, unknown>
  remote?: Record<string, unknown>
  message?: string
}

export interface ConnectorHealth {
  source: Exclude<TodoSource, 'local'>
  status: 'unavailable' | 'idle' | 'healthy' | 'ok' | 'syncing' | 'error' | 'conflict'
  pending: number
  exhausted: number
  conflicts: TodoConflict[] | number
  missing: number
  lastSuccessAt: string | null
  lastError: string | null
  recovery?: string | null
}

/**
 * One open row of the owner's shared action-items sheet (GET /api/todos/sheet): read
 * only, drawn among the tasks with no check circle. Only rows whose Who names one of
 * the configured assignees and whose Status is not Done arrive.
 */
export interface SheetItem {
  /** "sheet:<sheetGid>:<row>:<8-hex hash of the title>", stable while the row keeps its place and title. */
  id: string
  /** The row number in the sheet (data starts below the header row). */
  row: number
  title: string
  who: string
  /** High 1, Medium 2, Low 3; null when the cell is empty or says something else. Lower is more urgent. */
  priority: 1 | 2 | 3 | null
  /** As the sheet says it: "Not Started", "In Progress", never "Done". */
  status: string
  /** A "YYYY-MM-DD" day key, or null. */
  dueDate: string | null
  notes: string
  /** The row in the sheet ("…#gid=<gid>&range=B<row>"). */
  url: string
}

/** GET /api/todos/sheet. A failed read keeps the last good items, `stale: true`, with a scrubbed `error`. */
export type SheetFeed =
  | {
    configured: true
    /** Display name: TASK_SHEET_TITLE, else the spreadsheet's own title. Unset until a read succeeds, unless TASK_SHEET_TITLE names it. */
    title?: string
    url: string
    /** When the items were read (the last good read when `stale`); null until a read succeeds. */
    fetchedAt: string | null
    stale: boolean
    error: string | null
    items: SheetItem[]
  }
  | {
    configured: false
    /** Always empty. */
    items: SheetItem[]
    /** What to set to turn it on. */
    reason: string
  }

export interface TodoPreferences {
  autoArchiveDays: number | null
  /** Local "HH:MM": the daily hour completed tasks are filed into the archive. */
  autoArchiveAt: string | null
  recyclePurgeDays: number | null
}

export const priorityLabel = (priority: Todo['priority']) => `P${5 - priority}` as 'P1' | 'P2' | 'P3' | 'P4'

/**
 * Priority as urgency you can see without reading.
 *
 * "P3" is a code you have to know the direction of — and the direction is not
 * obvious, since the bigger number is the quieter task. Marks have no direction to
 * learn: more of them is louder, and the emoji carries its own red so the badge does
 * not depend on the card's colour scheme. P4 gets none at all, because "no priority"
 * is most of any list and a badge that says nothing is noise on every card that
 * wears it. `priorityLabel` stays the name for menus and screen readers.
 */
export const priorityMarks = (priority: Todo['priority']) => '\u2757'.repeat(priority - 1)

export function todoSource(todo: Todo): TodoSource {
  const connector = todo.externalLinks[0]?.connector
  return connector === 'github' || connector === 'sheet' ? connector : 'local'
}
