// Lists and the open todos they can link to, shared by the Lists page and the
// pushed list screen (web/src/components/ListsView.tsx kept both in one view).
import { useSyncExternalStore } from 'react'
import { getLists, getTodoBoard } from '../../lib/api'
import type { TotemList } from '../../lib/lists/types'
import type { Todo } from '../../lib/todos/types'

export interface ListsState {
  lists: TotemList[]
  todos: Todo[]
  loading: boolean
  loaded: boolean
  error: string
}

let state: ListsState = { lists: [], todos: [], loading: false, loaded: false, error: '' }
const listeners = new Set<() => void>()

export function setLists(patch: Partial<ListsState> | ((current: ListsState) => Partial<ListsState>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  for (const listener of listeners) listener()
}

export function useLists(): ListsState {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => state,
  )
}

let inflight: Promise<void> | null = null
export function loadLists(): Promise<void> {
  if (inflight) return inflight
  setLists({ loading: true, error: '' })
  inflight = (async () => {
    try {
      const [payload, board] = await Promise.all([getLists(), getTodoBoard({})])
      setLists({ lists: payload.lists, todos: board.todos, loaded: true })
    } catch (cause) {
      setLists({ error: cause instanceof Error ? cause.message : 'Lists could not load.' })
    } finally {
      setLists({ loading: false })
      inflight = null
    }
  })()
  return inflight
}

/** Put a list the bridge returned back in place. */
export function acceptList(list: TotemList) {
  setLists((current) => ({ lists: current.lists.map((value) => (value.id === list.id ? list : value)) }))
}
