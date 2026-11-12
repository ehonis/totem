// The Tasks page's data and every change it makes, kept apart from the page so the
// list, the detail pane and the keyboard all go through one set of actions.
//
// One board read (GET /api/todos/board) brings open, finished and snoozed tasks
// plus the archive, snooze and recycle-bin counts, so nothing downloads the archive
// to count it. The shared task sheet and the issue states load beside it and never
// hold the list up. Every change is drawn at once and put back if the bridge says
// no; the reversible ones (complete, not doing, snooze, delete) offer Undo in the
// dashboard's toast deck.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AuthError, addTodoNote, createBoardTodo, deleteBoardTodo, getIssueStates, getRecentCompletions,
  getSheetFeed, getTodoBoard, linkRelatedTodo, moveBoardTodo, restoreBoardTodo, setIssueLink,
  unlinkRelatedTodo, updateBoardTodo, bulkBoardTodos,
} from '../api'
import { pushError, pushToast } from '../toast'
import { afterDone, rollsOnCompletion, wakeLabel } from './board'
import { dateKey, dateLabel } from './format'
import type { IssueStatesResponse, SheetFeed, Todo, TodoBoardCounts, TodoOutcome, TodoPatch } from './types'

/** How long a ticked row stays in place, checked, before it leaves for Completed. */
export const DONE_BEAT_MS = 650
const UNDO_MS = 6000
const NO_COUNTS: TodoBoardCounts = { archived: 0, snoozed: 0, deleted: 0 }

const FIELD: Record<string, string> = {
  title: 'title', description: 'description', dueDate: 'due date', priority: 'priority', area: 'area',
  ventureTag: 'venture', recurrence: 'repeat', snoozedUntil: 'snooze', position: 'order', tags: 'tags',
}
/** "due date", or "change" for several fields at once. */
export const fieldName = (keys: readonly string[]) => (keys.length === 1 ? FIELD[keys[0]] ?? 'change' : keys.includes('area') ? 'area' : 'change')

export const quote = (title: string) => `“${title.length > 48 ? `${title.slice(0, 47)}…` : title}”`

const message = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message) || fallback

export interface TaskBoardState {
  todos: Todo[]
  counts: TodoBoardCounts
  /** Null until the first read answers; the page names the source from it. */
  sheet: SheetFeed | null
  /** The sheet route itself failed (the feed's own `error` is a failed read of the sheet). */
  sheetError: string
  issues: IssueStatesResponse | null
  /** Finished in the last day, archived or not, so "done today" survives the archive hour. */
  recentDone: Array<{ id: string; completedAt: string; outcome?: TodoOutcome | null }>
  loaded: boolean
  error: string
}

export interface UseTaskBoardOptions {
  onAuthError: () => void
  /** The page's clock, so tests can pin "today". */
  now?: () => Date
  beatMs?: number
}

export function useTaskBoard({ onAuthError, now = () => new Date(), beatMs = DONE_BEAT_MS }: UseTaskBoardOptions) {
  const [state, setState] = useState<TaskBoardState>({
    todos: [], counts: NO_COUNTS, sheet: null, sheetError: '', issues: null, recentDone: [], loaded: false, error: '',
  })
  // Ticked rows waiting out their beat: drawn checked, still in their group.
  const [ticking, setTicking] = useState<ReadonlySet<string>>(new Set())
  // The task just created, for the list to scroll to and flash.
  const [revealId, setRevealId] = useState<string | null>(null)
  const latest = useRef(state)
  latest.current = state
  const authError = useRef(onAuthError)
  authError.current = onAuthError
  const nowRef = useRef(now)
  nowRef.current = now
  // Bumped by every local change, so a read that started before one does not draw over it.
  const changes = useRef(0)
  // Each task's edit count (see update).
  const edits = useRef(new Map<string, number>())
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const fail = useCallback((cause: unknown, fallback: string) => {
    if (cause instanceof AuthError) { authError.current(); return }
    pushError(message(cause, fallback))
  }, [])

  const set = useCallback((patch: Partial<TaskBoardState> | ((current: TaskBoardState) => Partial<TaskBoardState>)) => {
    if (!mounted.current) return
    setState((current) => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) }))
  }, [])

  const setTodos = useCallback((fn: (todos: Todo[]) => Todo[]) => {
    changes.current += 1
    set((current) => ({ todos: fn(current.todos) }))
  }, [set])

  const replace = useCallback((next: Todo) => setTodos((todos) => {
    const found = todos.some((todo) => todo.id === next.id)
    return found ? todos.map((todo) => (todo.id === next.id ? next : todo)) : [next, ...todos]
  }), [setTodos])

  const loadIssues = useCallback(async () => {
    try { set({ issues: await getIssueStates() }) } catch (cause) {
      if (cause instanceof AuthError) authError.current()
      // A missing issue-state reader leaves the links as plain links.
    }
  }, [set])

  const loadSheet = useCallback(async (refresh = false) => {
    try { set({ sheet: await getSheetFeed({ refresh }), sheetError: '' }) } catch (cause) {
      if (cause instanceof AuthError) { authError.current(); return }
      set({ sheetError: message(cause, 'The task sheet could not be read.') })
    }
  }, [set])

  const loadBoard = useCallback(async (): Promise<Todo[] | null> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = changes.current
      try {
        const [board, recent] = await Promise.all([
          getTodoBoard(),
          getRecentCompletions(1).catch(() => ({ todos: [] as TaskBoardState['recentDone'] })),
        ])
        // A change landed while this was in flight: its copy would undo it on screen.
        if (changes.current !== before && attempt < 2) continue
        set({ todos: board.todos, counts: board.counts ?? NO_COUNTS, recentDone: recent.todos, loaded: true, error: '' })
        if (board.todos.some((todo) => todo.issueLink)) void loadIssues()
        return board.todos
      } catch (cause) {
        if (cause instanceof AuthError) { authError.current(); return null }
        set({ error: message(cause, 'Tasks could not load.'), loaded: true })
        return null
      }
    }
    return null
  }, [loadIssues, set])

  const load = useCallback(async () => {
    await Promise.all([loadBoard(), loadSheet()])
  }, [loadBoard, loadSheet])

  useEffect(() => { void load() }, [load])

  // Being present means the list is today's: read again when the window comes back.
  useEffect(() => {
    let last = Date.now()
    const back = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 30_000) return
      last = Date.now()
      void load()
    }
    document.addEventListener('visibilitychange', back)
    window.addEventListener('focus', back)
    return () => { document.removeEventListener('visibilitychange', back); window.removeEventListener('focus', back) }
  }, [load])

  const undoable = (text: string, undo: () => unknown) =>
    pushToast(text, 'info', { duration: UNDO_MS, action: { label: 'Undo', onClick: () => { void undo() } } })

  const find = (id: string) => latest.current.todos.find((todo) => todo.id === id)

  /**
   * Put a task back as it was before a finish, a not-doing or a snooze. Only what the
   * action changed goes to the bridge: a move only when the task is now finished (an
   * Undo of a snooze writes no "moved to To do" line), and the snooze only if it differs.
   */
  const putBack = useCallback(async (before: Todo) => {
    const now = find(before.id) ?? before
    replace(before)
    try {
      let saved: Todo | undefined
      if (now.status === 'done' && before.status !== 'done') saved = (await moveBoardTodo(before.id, 'todo')).todo
      if ((saved ?? now).snoozedUntil !== before.snoozedUntil) saved = (await updateBoardTodo(before.id, { snoozedUntil: before.snoozedUntil })).todo
      if (saved) replace(saved)
    } catch (cause) {
      fail(cause, 'The task could not be put back.')
      void loadBoard()
    }
  }, [fail, loadBoard, replace])

  const complete = useCallback(async (todo: Todo) => {
    const before = find(todo.id) ?? todo
    if (before.status === 'done' || ticking.has(todo.id)) return
    const ids = new Set(latest.current.todos.map((item) => item.id))
    setTicking((current) => new Set(current).add(todo.id))
    const beat = new Promise((resolve) => setTimeout(resolve, beatMs))
    try {
      const [{ todo: saved }] = await Promise.all([moveBoardTodo(todo.id, 'done'), beat])
      replace(saved)
      set((current) => ({ recentDone: [...current.recentDone.filter((item) => item.id !== saved.id), { id: saved.id, completedAt: saved.completedAt ?? new Date().toISOString(), outcome: saved.outcome }] }))
      // A repeating task rolled its next occurrence on the bridge: read it in.
      const after = rollsOnCompletion(before) ? (await loadBoard()) ?? latest.current.todos : latest.current.todos
      const next = afterDone(before, ids, after)
      if (next.kind === 'undo') undoable(`Done: ${quote(before.title)}`, () => putBack(before))
      else pushToast(next.dueDate ? `Done. The next ${quote(before.title)} is due ${dateLabel(next.dueDate)}.` : `Done: ${quote(before.title)}`, 'info')
    } catch (cause) {
      fail(cause, 'The task could not be completed.')
    } finally {
      setTicking((current) => { const next = new Set(current); next.delete(todo.id); return next })
    }
  }, [beatMs, fail, loadBoard, putBack, replace, set, ticking])

  const reopen = useCallback(async (todo: Todo) => {
    const before = find(todo.id) ?? todo
    replace({ ...before, status: 'todo', outcome: null, completedAt: null })
    set((current) => ({ recentDone: current.recentDone.filter((item) => item.id !== todo.id) }))
    try { replace((await moveBoardTodo(todo.id, 'todo')).todo) } catch (cause) {
      replace(before)
      fail(cause, 'The task could not be reopened.')
    }
  }, [fail, replace, set])

  const notDoing = useCallback(async (todo: Todo) => {
    const before = find(todo.id) ?? todo
    replace({ ...before, status: 'done', outcome: 'not_doing', completedAt: new Date().toISOString() })
    try {
      replace((await moveBoardTodo(todo.id, 'done', 'not_doing')).todo)
      undoable(`Not doing ${quote(before.title)}`, () => putBack(before))
    } catch (cause) {
      replace(before)
      fail(cause, 'The task could not be marked as not doing.')
    }
  }, [fail, putBack, replace])

  const snooze = useCallback(async (todo: Todo, until: Date) => {
    const before = find(todo.id) ?? todo
    const at = until.toISOString()
    replace({ ...before, snoozedUntil: at })
    try {
      replace((await updateBoardTodo(todo.id, { snoozedUntil: at })).todo)
      undoable(`Snoozed until ${wakeLabel(until, nowRef.current())}`, () => putBack(before))
    } catch (cause) {
      replace(before)
      fail(cause, 'The snooze could not be saved.')
    }
  }, [fail, putBack, replace])

  const wake = useCallback(async (todo: Todo) => {
    const before = find(todo.id) ?? todo
    replace({ ...before, snoozedUntil: null })
    try {
      replace((await updateBoardTodo(todo.id, { snoozedUntil: null })).todo)
    } catch (cause) {
      replace(before)
      fail(cause, 'The task could not be woken.')
    }
  }, [fail, replace])

  const restore = useCallback(async (todo: Todo) => {
    try {
      const { todo: saved } = await restoreBoardTodo(todo.id)
      replace(saved)
      set((current) => ({ counts: { ...current.counts, deleted: Math.max(0, current.counts.deleted - 1) } }))
      return saved
    } catch (cause) {
      fail(cause, 'The task could not be restored.')
      return null
    }
  }, [fail, replace, set])

  const remove = useCallback(async (todo: Todo) => {
    const before = find(todo.id) ?? todo
    setTodos((todos) => todos.filter((item) => item.id !== todo.id))
    try {
      await deleteBoardTodo(todo.id)
      set((current) => ({ counts: { ...current.counts, deleted: current.counts.deleted + 1 } }))
      undoable('Moved to the recycle bin', () => restore(before))
    } catch (cause) {
      replace(before)
      fail(cause, 'The task could not be moved to the recycle bin.')
    }
  }, [fail, replace, restore, set, setTodos])


  /**
   * One field (or a few) changed in the pane or by a shortcut: drawn at once, put back
   * on refusal. Each task counts its edits, so a slow answer to an older edit never
   * draws over a newer one, and a refusal puts back only the fields it touched (and
   * only when no later edit of that task has gone out since).
   */
  const update = useCallback(async (todo: Todo, patch: TodoPatch) => {
    const before = find(todo.id) ?? todo
    const seq = (edits.current.get(todo.id) ?? 0) + 1
    edits.current.set(todo.id, seq)
    const keys = Object.keys(patch) as Array<keyof TodoPatch>
    replace({ ...before, ...patch } as Todo)
    try {
      const { todo: saved } = await updateBoardTodo(todo.id, patch)
      if (edits.current.get(todo.id) === seq) replace(saved)
      return saved
    } catch (cause) {
      if (edits.current.get(todo.id) === seq) {
        const current = find(todo.id)
        if (current) {
          const back: Partial<Todo> = {}
          for (const key of keys) if (key in before) (back as Record<string, unknown>)[key] = (before as unknown as Record<string, unknown>)[key]
          replace({ ...current, ...back })
        }
      }
      if (cause instanceof AuthError) authError.current()
      else pushError(`The ${fieldName(keys)} was not saved: ${message(cause, 'the bridge refused it')}`)
      return null
    }
  }, [replace])

  /** The note being typed for each task, kept across switching tasks and closing the pane. */
  const noteDrafts = useRef(new Map<string, string>())
  const noteDraft = useCallback((id: string) => noteDrafts.current.get(id) ?? '', [])
  const setNoteDraft = useCallback((id: string, text: string) => {
    if (text) noteDrafts.current.set(id, text); else noteDrafts.current.delete(id)
  }, [])

  const create = useCallback(async (fields: TodoPatch & { title: string }) => {
    try {
      const { todo } = await createBoardTodo(fields)
      replace(todo)
      setRevealId(todo.id)
      return todo
    } catch (cause) {
      fail(cause, 'The task could not be added.')
      return null
    }
  }, [fail, replace])

  const linkIssue = useCallback(async (todo: Todo, url: string | null) => {
    try {
      const { todo: saved } = await setIssueLink(todo.id, url)
      replace(saved)
      if (saved.issueLink) void loadIssues()
      return { ok: true as const }
    } catch (cause) {
      if (cause instanceof AuthError) { authError.current(); return { ok: false as const, error: '' } }
      return { ok: false as const, error: message(cause, 'The link could not be saved.') }
    }
  }, [loadIssues, replace])

  const addNote = useCallback(async (todo: Todo, body: string) => {
    try {
      const { note } = await addTodoNote(todo.id, body)
      const current = find(todo.id) ?? todo
      replace({ ...current, notes: [...current.notes, note] })
      return true
    } catch (cause) {
      fail(cause, 'The note could not be added.')
      return false
    }
  }, [fail, replace])

  const relate = useCallback(async (todo: Todo, otherId: string, on: boolean) => {
    try { replace((on ? await linkRelatedTodo(todo.id, otherId) : await unlinkRelatedTodo(todo.id, otherId)).todo) } catch (cause) {
      fail(cause, 'The relation could not be saved.')
    }
  }, [fail, replace])

  /** Select mode: one bridge call for many tasks, then a fresh read. */
  const bulk = useCallback(async (ids: string[], operation: 'complete' | 'priority' | 'snooze' | 'delete', value?: unknown) => {
    if (!ids.length) return
    const before = ids.map(find).filter(Boolean) as Todo[]
    try {
      await bulkBoardTodos(ids, operation, value)
      await loadBoard()
      const n = ids.length
      const what = `${n.toLocaleString()} task${n === 1 ? '' : 's'}`
      if (operation === 'complete') {
        // A repeating task rolled its next occurrence on the bridge; reopening it would
        // leave two copies, so Undo reopens only the others and says where the rest went.
        // Tasks already finished before were not changed: nothing rolled, nothing to reopen.
        const finishing = before.filter((todo) => todo.status !== 'done')
        const rolled = new Set(finishing.filter(rollsOnCompletion).map((todo) => todo.id))
        const plain = finishing.map((todo) => todo.id).filter((id) => !rolled.has(id))
        const repeat = rolled.size ? `${rolled.size.toLocaleString()} repeating task${rolled.size === 1 ? '' : 's'} rolled to ${rolled.size === 1 ? 'its' : 'their'} next date` : ''
        if (!plain.length) pushToast(repeat ? `Done: ${what}. ${repeat[0].toUpperCase()}${repeat.slice(1)}.` : `Done: ${what}`, 'info')
        else undoable(repeat ? `Done: ${what}; ${repeat}` : `Done: ${what}`, async () => { await bulkBoardTodos(plain, 'move', 'todo'); await loadBoard() })
      }
      else if (operation === 'delete') undoable(`Moved ${what} to the recycle bin`, async () => { await bulkBoardTodos(ids, 'restore'); await loadBoard() })
      else if (operation === 'snooze') undoable(`Snoozed ${what}`, async () => { await Promise.all(before.map((todo) => updateBoardTodo(todo.id, { snoozedUntil: todo.snoozedUntil }))); await loadBoard() })
      else pushToast(`Updated ${what}`, 'info')
    } catch (cause) {
      fail(cause, 'No tasks were changed.')
      void loadBoard()
    }
  }, [fail, loadBoard])

  // "Done today": finished today and not "not doing", from the board, plus anything
  // the archive hour has already filed away (by id, so nothing counts twice).
  const today = dateKey(now())
  const doneTodayCount = useMemo(() => {
    const ids = new Set<string>()
    const onBoard = new Set(state.todos.map((todo) => todo.id))
    for (const todo of state.todos) {
      if (todo.status === 'done' && todo.outcome !== 'not_doing' && todo.completedAt && dateKey(new Date(todo.completedAt)) === today) ids.add(todo.id)
    }
    for (const item of state.recentDone) {
      if (!onBoard.has(item.id) && item.outcome !== 'not_doing' && item.completedAt && dateKey(new Date(item.completedAt)) === today) ids.add(item.id)
    }
    return ids.size
  }, [state.todos, state.recentDone, today])

  return {
    ...state, ticking, revealId, doneTodayCount,
    clearReveal: () => setRevealId(null),
    load, loadBoard, loadSheet,
    complete, reopen, notDoing, snooze, wake, remove, restore, update, create, linkIssue, addNote, relate, bulk,
    noteDraft, setNoteDraft,
  }
}

export type TaskBoard = ReturnType<typeof useTaskBoard>
