// The task page's pure rules (#179): which typed edits are worth a save, the
// history lines under the notes, and one-at-a-time saving. No React Native, so it
// runs under node's test runner.
import type { Todo, TodoOutcome, TodoPatch } from '../../../lib/todos/types'

export interface TextDrafts { title: string; description: string }

/**
 * The PATCH for what was typed into the title and description, or null when there
 * is nothing to send. An emptied title is not sent: a task needs one, so the field
 * goes back to the saved title instead.
 */
export function textPatch(drafts: TextDrafts, saved: Pick<Todo, 'title' | 'description'>): TodoPatch | null {
  const patch: TodoPatch = {}
  const title = drafts.title.trim()
  if (title && title !== saved.title) patch.title = title
  if (drafts.description !== saved.description) patch.description = drafts.description
  return Object.keys(patch).length ? patch : null
}

export interface HistoryRow { key: string; label: string; at: string }

const parses = (value: string | null | undefined): value is string => Boolean(value) && !Number.isNaN(new Date(value!).getTime())

/**
 * What has happened to the task, oldest first: created, finished (or set aside),
 * snoozed, archived, binned, last synced. "Edited" joins only when it says
 * something the other lines do not (a save more than a minute after the last event).
 */
export function historyRows(todo: Todo): HistoryRow[] {
  const rows: HistoryRow[] = []
  if (parses(todo.createdAt)) rows.push({ key: 'created', label: 'Created', at: todo.createdAt })
  if (parses(todo.completedAt)) rows.push({ key: 'completed', label: todo.outcome === 'not_doing' ? 'Marked not doing' : 'Completed', at: todo.completedAt })
  if (parses(todo.archivedAt)) rows.push({ key: 'archived', label: 'Archived', at: todo.archivedAt })
  if (parses(todo.deletedAt)) rows.push({ key: 'deleted', label: 'Moved to the recycle bin', at: todo.deletedAt })
  const synced = todo.externalLinks.map((link) => link.lastSyncedAt).filter(parses).sort().pop()
  if (synced) rows.push({ key: 'synced', label: 'Last synced', at: synced })
  rows.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  const latest = rows.length ? new Date(rows[rows.length - 1].at).getTime() : -Infinity
  if (parses(todo.updatedAt) && new Date(todo.updatedAt).getTime() - latest > 60_000) {
    rows.push({ key: 'updated', label: 'Last edited', at: todo.updatedAt })
  }
  return rows
}

/**
 * The move that puts a task back the way it was before a completion or "not doing":
 * open, or done with its old outcome. A task is open or done, so anything not done
 * (a status an older bridge or a cached answer still carries) is put back as open.
 */
export function undoMove(before: Pick<Todo, 'status' | 'outcome'>): { status: 'todo' | 'done'; outcome?: TodoOutcome } {
  return before.status === 'done' ? { status: 'done', outcome: before.outcome ?? 'completed' } : { status: 'todo' }
}

/**
 * Runs saves one after another, so an older answer never lands on top of a newer
 * one. A failed save does not stop the ones queued behind it.
 */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job)
    tail = run.catch(() => undefined)
    return run
  }
}
