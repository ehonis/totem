// The list's optimistic card actions (web/src/todos/TodoBoard.tsx move, reorder,
// snooze, reschedule, notDoing, setPriority, remove), over an API and a store handed in
// (boardActions.ts hands in the real ones; list.test.mjs hands in fakes). Each one
// changes the card first and puts it back if the bridge refuses, and resolves true once
// the bridge kept it, so the page can offer Undo. The undos (putBack, wake, restore) go
// through the same routes in reverse. A move never changes a card's position (the
// bridge's move does not either), so a card that is finished or reopened comes back
// where it was. No React Native here.
import type { Todo, TodoOutcome, TodoPatch } from '../../lib/todos/types'
import { moveBeside, rollsOnCompletion } from '../../lib/todos/board.ts'

type Moves = 'todo' | 'done'

export interface BoardApi {
  moveBoardTodo: (id: string, status: Moves, outcome?: TodoOutcome) => Promise<{ todo: Todo }>
  reorderBoardTodos: (status: Moves, orderedIds: string[]) => Promise<unknown>
  updateBoardTodo: (id: string, fields: TodoPatch) => Promise<{ todo: Todo }>
}
export interface BoardStore {
  todos: () => Todo[]
  setTodos: (next: Todo[] | ((current: Todo[]) => Todo[])) => void
  loadBoard: () => Promise<void>
  snoozeTodo: (id: string, until: string) => Promise<unknown>
  wakeTodo: (id: string) => Promise<unknown>
  removeTodo: (id: string) => Promise<unknown>
  restoreTodo: (id: string) => Promise<unknown>
}

const message = (cause: unknown, fallback: string) => cause instanceof Error && cause.message ? cause.message : fallback

/** Open (anything not done) or done: the only two places a task can be. */
const column = (todo: Pick<Todo, 'status'>): Moves => (todo.status === 'done' ? 'done' : 'todo')

export type BoardActions = ReturnType<typeof createBoardActions>

export function createBoardActions(api: BoardApi, store: BoardStore, setError: (message: string) => void) {
  const accept = (saved: Todo | undefined) => {
    if (saved) store.setTodos((current) => current.map((item) => (item.id === saved.id ? saved : item)))
  }
  /** Put one card back as it was, leaving every other card as it now is. */
  const restoreCard = (before: Todo) => store.setTodos((current) => current.some((item) => item.id === before.id)
    ? current.map((item) => (item.id === before.id ? before : item))
    : [...current, before])

  async function move(todo: Todo, status: Moves): Promise<boolean> {
    const before = store.todos().find((item) => item.id === todo.id) ?? todo
    // Stamp the finish the way the bridge will, so "done today" and Completed's order move with the tick, not the reply.
    const at = new Date().toISOString()
    store.setTodos((current) => current.map((item) => item.id !== todo.id ? item : status === 'done'
      ? { ...item, status, completedAt: item.completedAt ?? at, outcome: item.outcome ?? 'completed' }
      : { ...item, status, completedAt: null, outcome: null }))
    setError('')
    try {
      const { todo: saved } = await api.moveBoardTodo(todo.id, status)
      accept(saved)
      // Finishing a repeating task rolls its next occurrence on the bridge; fetch it.
      if (status === 'done' && rollsOnCompletion(todo)) await store.loadBoard()
      return true
    } catch (cause) {
      restoreCard(before)
      setError(message(cause, 'Task could not be moved.'))
      return false
    }
  }

  /**
   * Undo a move or a "not doing": the card as it was (status, place, outcome) at
   * once, then the same move back. Reopening clears the outcome on the bridge.
   */
  async function putBack(before: Todo): Promise<boolean> {
    restoreCard(before)
    setError('')
    try {
      const status = column(before)
      const { todo: saved } = await api.moveBoardTodo(before.id, status, status === 'done' ? before.outcome ?? undefined : undefined)
      // The bridge keeps a move's position, but say so here too: Undo puts the card exactly where it was.
      accept({ ...saved, position: before.position })
      return true
    } catch (cause) {
      setError(message(cause, 'Task could not be put back.'))
      void store.loadBoard()
      return false
    }
  }

  /**
   * Move a card past `neighbour`, the card drawn next to it: the column's manual order
   * puts it just past that card, so up and down follow what is on screen even with
   * filters hiding cards in between.
   */
  async function reorder(todo: Todo, direction: -1 | 1, neighbour: string | null) {
    const before = store.todos()
    const items = before.filter((item) => column(item) === column(todo))
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const ids = neighbour ? moveBeside(items.map((item) => item.id), todo.id, neighbour, direction) : null
    if (!ids) return
    const positions = new Map(ids.map((id, index) => [id, index * 1024]))
    store.setTodos(before.map((item) => (positions.has(item.id) ? { ...item, position: positions.get(item.id)! } : item)))
    try { await api.reorderBoardTodos(column(todo), ids) }
    catch (cause) { store.setTodos(before); setError(message(cause, 'Order could not be saved.')) }
  }

  async function snooze(todo: Todo, until: string): Promise<boolean> {
    setError('')
    try { await store.snoozeTodo(todo.id, until); return true }
    catch (cause) { setError(message(cause, 'Snooze could not be saved.')); return false }
  }

  async function wake(todo: Pick<Todo, 'id'>): Promise<boolean> {
    setError('')
    try { await store.wakeTodo(todo.id); return true }
    catch (cause) { setError(message(cause, 'Task could not be woken.')); return false }
  }

  /** A field changed in place (due date, priority): the card stays where it is drawn. */
  async function patch(todo: Todo, fields: TodoPatch, fallback: string) {
    const before = store.todos().find((item) => item.id === todo.id) ?? todo
    store.setTodos((current) => current.map((item) => (item.id === todo.id ? { ...item, ...fields } as Todo : item)))
    setError('')
    try { accept((await api.updateBoardTodo(todo.id, fields)).todo) }
    catch (cause) { restoreCard(before); setError(message(cause, fallback)) }
  }

  // Rescheduling keeps the card on the list, unlike snooze: it is just answerable later.
  const reschedule = (todo: Todo, dueDate: string | null) => patch(todo, { dueDate }, 'Due date could not be saved.')
  const setPriority = (todo: Todo, priority: Todo['priority']) => patch(todo, { priority }, 'Priority could not be saved.')

  // Not doing is a completion, not a deletion: the task leaves the list the same way
  // a finished one does, and says which of the two it was once it lands.
  async function notDoing(todo: Todo): Promise<boolean> {
    const before = store.todos().find((item) => item.id === todo.id) ?? todo
    const at = new Date().toISOString()
    store.setTodos((current) => current.map((item) => (item.id === todo.id
      ? { ...item, status: 'done' as const, outcome: 'not_doing' as const, completedAt: item.completedAt ?? at }
      : item)))
    setError('')
    try {
      accept((await api.moveBoardTodo(todo.id, 'done', 'not_doing')).todo)
      return true
    } catch (cause) {
      restoreCard(before)
      setError(message(cause, 'Task could not be marked as not doing.'))
      return false
    }
  }

  async function remove(todo: Todo): Promise<boolean> {
    setError('')
    try { await store.removeTodo(todo.id); return true }
    catch (cause) { setError(message(cause, 'Task could not be moved to the recycle bin.')); return false }
  }

  async function restore(todo: Pick<Todo, 'id'>): Promise<boolean> {
    setError('')
    try { await store.restoreTodo(todo.id); return true }
    catch (cause) { setError(message(cause, 'Task could not be restored.')); return false }
  }

  return { move, putBack, reorder, snooze, wake, reschedule, notDoing, setPriority, remove, restore }
}
