export type TodoArea = 'Personal' | 'Ventures'
// Configured per install (Settings -> Tasks); any non-empty name.
export type VentureTag = string
export interface VentureTagConfig { name: string; color: string | null }
export type TodoStatus = 'todo' | 'doing' | 'done'
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
