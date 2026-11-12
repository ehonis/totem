// The list's card actions (boardActionsCore.ts) over the real bridge calls and the
// shared board store.
import { moveBoardTodo, reorderBoardTodos, updateBoardTodo } from '../../lib/api'
import { createBoardActions, type BoardActions } from './boardActionsCore'
import { getBoard, loadBoard, removeTodo, restoreTodo, setTodos, snoozeTodo, wakeTodo } from './store'

export type { BoardActions }

export function boardActions(setError: (message: string) => void): BoardActions {
  return createBoardActions(
    { moveBoardTodo, reorderBoardTodos, updateBoardTodo },
    { todos: () => getBoard().todos, setTodos, loadBoard, snoozeTodo, wakeTodo, removeTodo, restoreTodo },
    setError,
  )
}
