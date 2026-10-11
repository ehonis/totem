// The board's optimistic card actions (web/src/todos/TodoBoard.tsx move, reorder,
// snooze, reschedule, notDoing, setPriority, remove), against the shared store.
// Each one changes the card first and puts it back if the bridge refuses.
import { ApiError, moveBoardTodo, reorderBoardTodos, updateBoardTodo } from '../../lib/api'
import { groupBoard, optimisticMove, rollbackMove } from '../../lib/todos/state'
import type { Todo, TodoStatus } from '../../lib/todos/types'
import { getBoard, removeTodo, setTodos, snoozeTodo } from './store'

const message = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback
const ownsCompletion = (cause: unknown, fallback: string) =>
  cause instanceof ApiError && cause.code === 'SOURCE_OWNS_COMPLETION' ? cause.message : message(cause, fallback)

export function boardActions(setError: (message: string) => void) {
  const todos = () => getBoard().todos

  async function move(todo: Todo, status: TodoStatus) {
    const groups = groupBoard(todos())
    const optimistic = optimisticMove(todos(), todo.id, status, groups[status].length)
    setTodos(optimistic.todos); setError('')
    try {
      const { todo: saved } = await moveBoardTodo(todo.id, status)
      if (saved) setTodos((current) => current.map((item) => (item.id === saved.id ? saved : item)))
    } catch (cause) {
      setTodos(rollbackMove(optimistic.todos, optimistic.rollback))
      setError(ownsCompletion(cause, 'Task could not be moved.'))
    }
  }

  async function reorder(todo: Todo, direction: -1 | 1) {
    const before = todos()
    const items = groupBoard(before)[todo.status]
    const from = items.findIndex((item) => item.id === todo.id)
    const to = Math.max(0, Math.min(items.length - 1, from + direction))
    if (from === to) return
    const ordered = [...items]
    ordered.splice(to, 0, ordered.splice(from, 1)[0])
    const positions = new Map(ordered.map((item, index) => [item.id, index * 1024]))
    setTodos(before.map((item) => (positions.has(item.id) ? { ...item, position: positions.get(item.id)! } : item)))
    try { await reorderBoardTodos(todo.status, ordered.map((item) => item.id)) }
    catch (cause) { setTodos(before); setError(message(cause, 'Order could not be saved.')) }
  }

  async function snooze(todo: Todo, until: string) {
    setError('')
    try { await snoozeTodo(todo.id, until) }
    catch (cause) { setError(message(cause, 'Snooze could not be saved.')) }
  }

  // Rescheduling keeps the card in place, unlike snooze: the task is still on the
  // board, it is just answerable later.
  async function reschedule(todo: Todo, dueDate: string | null) {
    const before = todos()
    setTodos(before.map((item) => (item.id === todo.id ? { ...item, dueDate } : item))); setError('')
    try {
      const { todo: saved } = await updateBoardTodo(todo.id, { dueDate })
      if (saved) setTodos((current) => current.map((item) => (item.id === saved.id ? saved : item)))
    } catch (cause) {
      setTodos(before)
      setError(message(cause, 'Due date could not be saved.'))
    }
  }

  // Not doing is a completion, not a deletion: the task leaves the board the same way
  // a finished one does, and says which of the two it was once it lands.
  async function notDoing(todo: Todo) {
    const before = todos()
    const optimistic = optimisticMove(before, todo.id, 'done', groupBoard(before).done.length)
    setTodos(optimistic.todos.map((item) => (item.id === todo.id ? { ...item, outcome: 'not_doing' as const } : item)))
    setError('')
    try {
      const { todo: saved } = await moveBoardTodo(todo.id, 'done', 'not_doing')
      if (saved) setTodos((current) => current.map((item) => (item.id === saved.id ? saved : item)))
    } catch (cause) {
      setTodos(before)
      setError(ownsCompletion(cause, 'Task could not be marked as not doing.'))
    }
  }

  async function setPriority(todo: Todo, priority: Todo['priority']) {
    const before = todos()
    setTodos(before.map((item) => (item.id === todo.id ? { ...item, priority } : item))); setError('')
    try {
      const { todo: saved } = await updateBoardTodo(todo.id, { priority })
      if (saved) setTodos((current) => current.map((item) => (item.id === saved.id ? saved : item)))
    } catch (cause) {
      setTodos(before)
      setError(message(cause, 'Priority could not be saved.'))
    }
  }

  async function remove(todo: Todo) {
    setError('')
    try { await removeTodo(todo.id) }
    catch (cause) { setError(message(cause, 'Task could not be moved to the recycle bin.')) }
  }

  return { move, reorder, snooze, reschedule, notDoing, setPriority, remove }
}
