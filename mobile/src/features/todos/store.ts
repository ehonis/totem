// The board's data, shared by the Todos page and the screens it opens (task
// detail, new task, the lifecycle sheets). On the web these all lived inside
// TodosView's state; on a phone the detail and composer are their own routes,
// so the state moves into a small external store they all read.
import { useSyncExternalStore } from 'react'
import { deleteBoardTodo, getTodoBoard, getTodoPreferences, updateBoardTodo } from '../../lib/api'
import type { Todo, TodoPreferences } from '../../lib/todos/types'

export interface BoardState {
  todos: Todo[]
  snoozed: Todo[]
  deleted: Todo[]
  // The archive is counted on every load but only fetched when it is opened: it grows
  // without bound, and the board does not need 158 finished tasks to render.
  archive: Todo[] | null
  archiveCount: number
  archiveLoading: boolean
  archiveError: string | null
  preferences: TodoPreferences
  loading: boolean
  loaded: boolean
  error: string
  /** The task the composer just made, so the board can bring it into view. */
  createdId: string | null
}

let state: BoardState = {
  todos: [], snoozed: [], deleted: [], archive: null, archiveCount: 0, archiveLoading: false, archiveError: null,
  preferences: { autoArchiveDays: null, autoArchiveAt: null, recyclePurgeDays: null },
  loading: false, loaded: false, error: '', createdId: null,
}
const listeners = new Set<() => void>()

function set(patch: Partial<BoardState> | ((current: BoardState) => Partial<BoardState>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  for (const listener of listeners) listener()
}

export function useBoard(): BoardState {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => state,
  )
}

export const getBoard = () => state

let inflight: Promise<void> | null = null
export function loadBoard(): Promise<void> {
  if (inflight) return inflight
  set({ loading: true, error: '' })
  inflight = (async () => {
    try {
      const [active, sleeping, recycle, archived, prefs] = await Promise.all([
        getTodoBoard({ snoozed: false }), getTodoBoard({ snoozed: true }),
        getTodoBoard({ deleted: true }), getTodoBoard({ archived: true }), getTodoPreferences(),
      ])
      set((current) => ({
        todos: active.todos, snoozed: sleeping.todos, deleted: recycle.todos,
        archiveCount: archived.todos.length,
        archive: current.archive && archived.todos,
        preferences: prefs.preferences, loaded: true,
      }))
    } catch (cause) {
      set({ error: cause instanceof Error ? cause.message : 'Tasks could not load.' })
    } finally {
      set({ loading: false })
      inflight = null
    }
  })()
  return inflight
}

export function setTodos(next: Todo[] | ((current: Todo[]) => Todo[])) {
  set((current) => ({ todos: typeof next === 'function' ? next(current.todos) : next }))
}

/** A saved task from anywhere (the detail sheet, a connector): replace it wherever it is. */
export function acceptTodo(next: Todo) {
  const swap = (list: Todo[]) => list.map((item) => (item.id === next.id ? next : item))
  set((current) => ({
    todos: swap(current.todos), snoozed: swap(current.snoozed), deleted: swap(current.deleted),
    archive: current.archive && swap(current.archive),
  }))
}

export function prependTodo(todo: Todo) {
  set((current) => ({ todos: [todo, ...current.todos.filter((item) => item.id !== todo.id)], createdId: todo.id }))
}

/** The board has shown the new task; later reloads leave the scroll alone. */
export function clearCreated() {
  if (state.createdId) set({ createdId: null })
}

export function findTodo(id: string): Todo | undefined {
  return state.todos.find((t) => t.id === id)
    ?? state.snoozed.find((t) => t.id === id)
    ?? state.archive?.find((t) => t.id === id)
    ?? state.deleted.find((t) => t.id === id)
}

export async function snoozeTodo(id: string, until: string) {
  const original = state.todos.find((todo) => todo.id === id)
  setTodos((current) => current.filter((todo) => todo.id !== id))
  try {
    const { todo } = await updateBoardTodo(id, { snoozedUntil: until })
    set((current) => ({ snoozed: [todo, ...current.snoozed.filter((item) => item.id !== id)] }))
    return todo as Todo
  } catch (cause) {
    if (original) setTodos((current) => (current.some((todo) => todo.id === id) ? current : [...current, original]))
    throw cause
  }
}

export async function removeTodo(id: string) {
  const original = state.todos.find((todo) => todo.id === id)
  setTodos((current) => current.filter((todo) => todo.id !== id))
  try {
    const { todo } = await deleteBoardTodo(id)
    set((current) => ({ deleted: [todo, ...current.deleted.filter((item) => item.id !== id)] }))
    return todo as Todo
  } catch (cause) {
    if (original) setTodos((current) => (current.some((todo) => todo.id === id) ? current : [...current, original]))
    throw cause
  }
}

export async function showArchive() {
  if (state.archive || state.archiveLoading) return
  set({ archiveLoading: true, archiveError: null })
  try {
    const { todos: archived } = await getTodoBoard({ archived: true })
    set({ archive: archived, archiveCount: archived.length })
  } catch (cause) {
    set({ archiveError: cause instanceof Error ? cause.message : 'The archive could not load.' })
  } finally {
    set({ archiveLoading: false })
  }
}
