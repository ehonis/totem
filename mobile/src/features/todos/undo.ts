// What the Tasks page says after a change it can take back, in the inline Undo line
// at the foot of the list (detail/bits.tsx UndoLine), never in a toast: the phone shows
// error toasts only. One line at a time; a newer change replaces the older line, and
// its Undo is the only one on offer. Pure, so node's test runner loads it.
import type { Todo } from '../../lib/todos/types'
import { dateLabel } from '../../lib/todos/format.ts'
import type { DoneFollowUp } from '../../lib/todos/board.ts'

/** Long enough to read and reach; the line's own timer (UndoLine) is the same. */
export const UNDO_MS = 8000

/** How long the Undo line stays up while a screen reader runs: VoiceOver is moved onto it and needs time to reach and read it. */
export const UNDO_READER_MS = 120_000

/**
 * How long the Undo line stays up: UNDO_MS, or two minutes while a screen reader runs.
 * The next change replaces it sooner, and VoiceOver's escape gesture dismisses it.
 */
export function undoLineTimeout(screenReader: boolean): number {
  return screenReader ? UNDO_READER_MS : UNDO_MS
}

export const quote = (title: string) => `“${title.length > 48 ? `${title.slice(0, 47)}…` : title}”`

export type UndoKind = 'done' | 'snooze' | 'notDoing' | 'delete'
export interface UndoLineText { text: string; undoable: boolean }

/**
 * The words for a change, and whether it offers Undo. A finished repeating task that
 * rolled its next occurrence (afterDone) offers none: reopening it would leave two
 * copies, so the line names the next due date instead.
 */
export function undoText(kind: UndoKind, todo: Pick<Todo, 'title'>, extra: { followUp?: DoneFollowUp; until?: string } = {}): UndoLineText {
  if (kind === 'done') {
    const follow = extra.followUp
    if (follow?.kind === 'next') {
      return { text: follow.dueDate ? `Done. The next ${quote(todo.title)} is due ${dateLabel(follow.dueDate)}.` : `Done: ${quote(todo.title)}`, undoable: false }
    }
    return { text: `Done: ${quote(todo.title)}`, undoable: true }
  }
  if (kind === 'snooze') return { text: extra.until ? `Snoozed until ${extra.until}` : `Snoozed ${quote(todo.title)}`, undoable: true }
  if (kind === 'notDoing') return { text: `Not doing ${quote(todo.title)}`, undoable: true }
  return { text: `${quote(todo.title)} moved to the recycle bin`, undoable: true }
}

/**
 * A press that runs once: the Undo line's button, so a double tap cannot send the
 * same undo twice (a second restore of a task already restored answers with an error).
 */
export function once(run: () => void): () => boolean {
  let used = false
  return () => {
    if (used) return false
    used = true
    run()
    return true
  }
}
