// Lists and the open todos they can link to, shared by the Lists page and the
// pushed list screen (web/src/components/ListsView.tsx kept both in one view).
import { useSyncExternalStore } from 'react'
import { getLists, getTodoBoard, isAccountChanged, peekLists, peekTodoBoard } from '../../lib/api'
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

/** The state now, for code that runs outside a render (after a reload, say). */
export const getListsState = (): ListsState => state

export function useLists(): ListsState {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => state,
  )
}

let inflight: Promise<void> | null = null
let inflightAt = 0
let inflightToken = 0
// A load older than this is treated as stuck (a socket iOS froze in the background
// never answers): Retry starts a fresh one instead of waiting on it for ever.
const STUCK_MS = 15_000
export function loadLists(): Promise<void> {
  if (inflight && Date.now() - inflightAt < STUCK_MS) return inflight
  const token = ++inflightToken
  inflightAt = Date.now()
  // The first load draws the cached lists at once while the bridge is asked.
  const payload = state.loaded ? undefined : peekLists()
  const board = state.loaded ? undefined : peekTodoBoard({})
  setLists({ ...(payload && board ? { lists: payload.lists, todos: board.todos, loaded: true } : {}), loading: true, error: '' })
  inflight = (async () => {
    try {
      const [payload, board] = await Promise.all([getLists(), getTodoBoard({})])
      // A stuck load that answers after a newer one began must not overwrite it.
      if (token === inflightToken) setLists({ lists: payload.lists, todos: board.todos, loaded: true, error: '' })
    } catch (cause) {
      // A newer load took over: its answer is the one that counts.
      if (token === inflightToken && !isAccountChanged(cause)) setLists({ error: cause instanceof Error ? cause.message : 'Lists could not load.' })
    } finally {
      if (token === inflightToken) {
        setLists({ loading: false })
        inflight = null
      }
    }
  })()
  return inflight
}

/** Put a list the bridge returned back in place. */
export function acceptList(list: TotemList) {
  setLists((current) => ({ lists: current.lists.map((value) => (value.id === list.id ? list : value)) }))
}
