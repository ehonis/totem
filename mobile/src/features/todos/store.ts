// The board's data, shared by the Todos page and the screens it opens (task
// detail, new task, the lifecycle sheets). On the web these all lived inside
// TodosView's state; on a phone the detail and composer are their own routes,
// so the state moves into a small external store they all read.
import { useSyncExternalStore } from 'react'
import {
  deleteBoardTodo, getIssueStates, getSheetFeed, getTodoBoard, getTodoPreferences, isAccountChanged, peekTodoBoard, peekTodoPreferences,
  restoreBoardTodo, updateBoardTodo,
} from '../../lib/api'
import type { IssueState, SheetFeed, Todo, TodoPreferences } from '../../lib/todos/types'
import { freshRead } from './freshRead'
import { createIssueStatesLoader } from './issueLink'
import { readUntilStable } from './readUntilStable'

export interface BoardState {
  todos: Todo[]
  snoozed: Todo[]
  deleted: Todo[]
  // The archive is counted on every load but only fetched when it is opened: it grows
  // without bound, and the board does not need 158 finished tasks to render.
  archive: Todo[] | null
  archiveCount: number
  /** When each archived task finished, so "done today" still counts work filed away at the archive hour. */
  archivedCompletions: Pick<Todo, 'status' | 'outcome' | 'completedAt'>[]
  archiveLoading: boolean
  archiveError: string | null
  preferences: TodoPreferences
  loading: boolean
  loaded: boolean
  error: string
  /** The task the composer just made, so the board can bring it into view. */
  createdId: string | null
  /** The shared task sheet's open rows for the owner (GET /api/todos/sheet, read-only); null until first read. */
  sheet: SheetFeed | null
  /** Why the last read of the sheet failed outright (the bridge did not answer); the feed's own `error` is a failed read of the sheet. */
  sheetError: string
  /** Live open/closed state of the issues tasks link to, keyed "owner/repo#n". */
  issueStates: Record<string, IssueState>
}

let state: BoardState = {
  todos: [], snoozed: [], deleted: [], archive: null, archiveCount: 0, archivedCompletions: [], archiveLoading: false, archiveError: null,
  preferences: { autoArchiveDays: null, autoArchiveAt: null, recyclePurgeDays: null },
  loading: false, loaded: false, error: '', createdId: null,
  sheet: null, sheetError: '', issueStates: {},
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

/** The board as the GET cache last saw it (loadBoard's five reads), if it holds all of it. */
function cachedBoard(): Partial<BoardState> | null {
  const active = peekTodoBoard({ snoozed: false }), sleeping = peekTodoBoard({ snoozed: true })
  const recycle = peekTodoBoard({ deleted: true }), archived = peekTodoBoard({ archived: true })
  const prefs = peekTodoPreferences()
  if (!active || !sleeping || !recycle || !archived || !prefs) return null
  return {
    todos: active.todos, snoozed: sleeping.todos, deleted: recycle.todos,
    archiveCount: archived.todos.length, archivedCompletions: completions(archived.todos), preferences: prefs.preferences, loaded: true,
  }
}

const completions = (todos: Todo[]) => todos.map(({ status, outcome, completedAt }) => ({ status, outcome, completedAt }))

// Bumped by every local change to the lists a read replaces. A fetch that saw a change
// land while it was out answers for the board before that change, so readUntilStable
// fetches again instead of applying it, and the caller's promise waits for that.
let writes = 0
const wrote = () => { writes += 1 }

const fetchBoard = () => Promise.all([
  getTodoBoard({ snoozed: false }), getTodoBoard({ snoozed: true }),
  getTodoBoard({ deleted: true }), getTodoBoard({ archived: true }), getTodoPreferences(),
])

async function readBoard(): Promise<void> {
  const cached = state.loaded ? null : cachedBoard()
  set({ ...cached, loading: true, error: '' })
  try {
    await readUntilStable(fetchBoard, () => writes, ([active, sleeping, recycle, archived, prefs], stale) => {
      set((current) => ({
        todos: active.todos, snoozed: sleeping.todos, deleted: recycle.todos,
        archiveCount: archived.todos.length, archivedCompletions: completions(archived.todos),
        archive: current.archive && archived.todos,
        preferences: prefs.preferences, loaded: true,
      }))
      // Out of retries with changes still landing: show this board, and read once more after it (freshRead queues it).
      if (stale) void loadBoard()
    })
  } catch (cause) {
    if (!isAccountChanged(cause)) set({ error: cause instanceof Error ? cause.message : 'Tasks could not load.' })
  } finally {
    set({ loading: false })
  }
}

/**
 * Read the whole board. A call made while a read runs gets one more read after it
 * (freshRead), and a read only lands on a board no local change moved under it
 * (readUntilStable), so awaiting this always sees the caller's own writes.
 */
export const loadBoard = freshRead(readBoard)

export function setTodos(next: Todo[] | ((current: Todo[]) => Todo[])) {
  wrote()
  set((current) => ({ todos: typeof next === 'function' ? next(current.todos) : next }))
}

/** A saved task from anywhere (the detail sheet, a connector): replace it wherever it is. */
export function acceptTodo(next: Todo) {
  wrote()
  const swap = (list: Todo[]) => list.map((item) => (item.id === next.id ? next : item))
  set((current) => ({
    todos: swap(current.todos), snoozed: swap(current.snoozed), deleted: swap(current.deleted),
    archive: current.archive && swap(current.archive),
  }))
}

export function prependTodo(todo: Todo) {
  wrote()
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
    // A read that landed between the optimistic step and this reply may have put it back on the board: take it off again.
    wrote(); set((current) => ({ todos: current.todos.filter((item) => item.id !== id), snoozed: [todo, ...current.snoozed.filter((item) => item.id !== id)] }))
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
    wrote(); set((current) => ({ todos: current.todos.filter((item) => item.id !== id), deleted: [todo, ...current.deleted.filter((item) => item.id !== id)] }))
    return todo as Todo
  } catch (cause) {
    if (original) setTodos((current) => (current.some((todo) => todo.id === id) ? current : [...current, original]))
    throw cause
  }
}

/** Un-snooze: back on the board now (the same PATCH the detail sheet sends with no snooze time). */
export async function wakeTodo(id: string) {
  wrote()
  const original = state.snoozed.find((todo) => todo.id === id)
  set((current) => ({
    snoozed: current.snoozed.filter((todo) => todo.id !== id),
    todos: original && !current.todos.some((todo) => todo.id === id) ? [...current.todos, { ...original, snoozedUntil: null }] : current.todos,
  }))
  try {
    const { todo } = await updateBoardTodo(id, { snoozedUntil: null })
    wrote()
    set((current) => ({
      snoozed: current.snoozed.filter((item) => item.id !== id),
      todos: current.todos.some((item) => item.id === id) ? current.todos.map((item) => (item.id === id ? todo : item)) : [...current.todos, todo],
    }))
    return todo as Todo
  } catch (cause) {
    if (original) {
      wrote()
      set((current) => ({
        todos: current.todos.filter((todo) => todo.id !== id),
        snoozed: current.snoozed.some((todo) => todo.id === id) ? current.snoozed : [original, ...current.snoozed],
      }))
    }
    throw cause
  }
}

/** Out of the recycle bin and back where it was (the Undo after a delete, and the bin's Restore). */
export async function restoreTodo(id: string) {
  wrote()
  const original = state.deleted.find((todo) => todo.id === id)
  set((current) => ({
    deleted: current.deleted.filter((todo) => todo.id !== id),
    todos: original && !original.snoozedUntil && !current.todos.some((todo) => todo.id === id) ? [...current.todos, { ...original, deletedAt: null }] : current.todos,
  }))
  try {
    const { todo } = await restoreBoardTodo(id)
    // Onto the shelf the bridge now lists it on (a restored task may still be snoozed), and off the bin,
    // whatever a read that landed in between left there.
    const asleep = !!todo.snoozedUntil && new Date(todo.snoozedUntil).getTime() > Date.now()
    wrote()
    set((current) => ({
      deleted: current.deleted.filter((item) => item.id !== id),
      todos: asleep ? current.todos.filter((item) => item.id !== id) : [...current.todos.filter((item) => item.id !== id), todo],
      snoozed: asleep ? [todo, ...current.snoozed.filter((item) => item.id !== id)] : current.snoozed.filter((item) => item.id !== id),
    }))
    return todo as Todo
  } catch (cause) {
    if (original) {
      wrote()
      set((current) => ({
        todos: current.todos.filter((todo) => todo.id !== id),
        deleted: current.deleted.some((todo) => todo.id === id) ? current.deleted : [original, ...current.deleted],
      }))
    }
    throw cause
  }
}

/**
 * Read the task sheet's rows. Not ETag-cached (the bridge keeps it out of the GET
 * cache), so a phone that cannot reach the bridge keeps the rows it last read, and
 * says so once, quietly, under the list.
 */
let sheetRead: Promise<void> | null = null
async function readSheet(refresh: boolean) {
  // A first read that failed: clear the error while trying again, so the page shows it is trying.
  if (!state.sheet && state.sheetError) set({ sheetError: '' })
  try {
    const feed = await getSheetFeed({ refresh })
    set({ sheet: feed, sheetError: '' })
  } catch (cause) {
    if (!isAccountChanged(cause)) set({ sheetError: cause instanceof Error ? cause.message : 'The task sheet could not load.' })
  }
}
export function loadSheet({ refresh = false }: { refresh?: boolean } = {}): Promise<void> {
  // One read at a time unless asked to read the sheet again (pull to refresh, Try again).
  if (sheetRead && !refresh) return sheetRead
  const read: Promise<void> = readSheet(refresh).finally(() => { if (sheetRead === read) sheetRead = null })
  sheetRead = read
  return read
}

/**
 * The live state of linked issues; only asked for when a task on the board links one.
 * Failing quietly keeps the last good states. A call while a read is out gets one more
 * read after it (freshRead), so a link set since is answered for.
 */
export const loadIssueStates: () => Promise<void> = freshRead(createIssueStatesLoader(
  getIssueStates, () => state.issueStates, (issueStates) => set({ issueStates }),
))

export async function showArchive() {
  if (state.archive || state.archiveLoading) return
  set({ archiveLoading: true, archiveError: null })
  try {
    const { todos: archived } = await getTodoBoard({ archived: true })
    set({ archive: archived, archiveCount: archived.length, archivedCompletions: completions(archived) })
  } catch (cause) {
    set({ archiveError: cause instanceof Error ? cause.message : 'The archive could not load.' })
  } finally {
    set({ archiveLoading: false })
  }
}
