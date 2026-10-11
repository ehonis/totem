// Opening a task from anywhere: the detail sheet, optionally straight at its note field.
import { router } from 'expo-router'
import type { Todo } from '../../lib/todos/types'

export function openTodo(todo: Pick<Todo, 'id'>, focus: 'details' | 'notes' = 'details') {
  router.push({ pathname: '/todo/[id]', params: { id: todo.id, ...(focus === 'notes' ? { focus } : {}) } })
}
