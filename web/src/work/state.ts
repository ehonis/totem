// The chats panel's Tasks face: the owner's tasks and the shared sheet's action
// items, each carrying the chat folder it is filed under, kept in one small store
// the panel, the task card, the composer's task strip and the pickers all read.
//
// Read on first use, again every minute while something is watching, when the
// window comes back into focus, and whenever the Tasks page or a chat's agent
// changes a task (todos/bus.ts). Every change is drawn at once, put back if the
// bridge says no, and told to the Tasks page, which reads again.
import { useSyncExternalStore } from 'react'
import * as todoApi from '../api'
import { AuthError, getSheetFeed, getTodo, getTodoBoard } from '../api'
import { pushError, pushToast } from '../toast'
import { getState as chatState } from '../chat/store'
import { announcing, onTasksChanged } from '../todos/bus'
import { wakeLabel } from '../todos/board'
import type { SheetFeed, Todo, TodoPatch } from '../todos/types'
import { fromSheet, fromTodo, isOpenTodo, resolveRef, type WorkTask } from './groups'

const createBoardTodo = announcing('work', todoApi.createBoardTodo)
const updateBoardTodo = announcing('work', todoApi.updateBoardTodo)
const moveBoardTodo = announcing('work', todoApi.moveBoardTodo)
const deleteBoardTodo = announcing('work', todoApi.deleteBoardTodo)
const restoreBoardTodo = announcing('work', todoApi.restoreBoardTodo)
const fileSheetRow = announcing('work', todoApi.fileSheetRow, { sheet: true })
const markSheetRow = announcing('work', todoApi.markSheetRow, { sheet: true })

export interface WorkState {
  /** Local tasks on the board (open, done and snoozed) plus sheet rows, by ref. */
  tasks: WorkTask[]
  /** The sheet's display name, when one is set up. */
  sheetName: string
  /** Where the sheet's rows land until filed, or null. */
  sheetFolder: string | null
  loaded: boolean
  error: string
}

let state: WorkState = { tasks: [], sheetName: '', sheetFolder: null, loaded: false, error: '' }
const subs = new Set<() => void>()
let onAuthError: () => void = () => {}

function set(patch: Partial<WorkState> | ((s: WorkState) => Partial<WorkState>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  subs.forEach((fn) => fn())
}

export const getWork = () => state

let watchers = 0
let timer = 0
let stopListening: (() => void) | null = null
const onFocus = () => { void loadWork() }

function subscribe(fn: () => void) {
  subs.add(fn)
  watchers += 1
  if (watchers === 1) {
    if (!state.loaded) void loadWork()
    timer = window.setInterval(() => { if (document.visibilityState === 'visible') void loadWork() }, 60_000)
    window.addEventListener('focus', onFocus)
    // The Tasks page or a chat's agent changed something: read again.
    stopListening = onTasksChanged('work', () => { void loadWork() })
  }
  return () => {
    subs.delete(fn)
    watchers -= 1
    if (watchers === 0) {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      stopListening?.()
      stopListening = null
    }
  }
}

export function useWork<T>(select: (s: WorkState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state))
}

/** App's sign-out, for a 401 on any of these reads. */
export function installWorkAuth(fn: () => void) { onAuthError = fn }

function fail(e: unknown, fallback: string) {
  if (e instanceof AuthError) { onAuthError(); return }
  pushError((e instanceof Error && e.message) || fallback)
}

// Local tasks that a chat links to but the board no longer lists (finished long
// ago and archived, say), read one by one so a chat can still name its task.
const fetchedExtra = new Set<string>()

let inflight: Promise<void> | null = null
let again = false
let changes = 0

const local = (todo: Todo, now = new Date()): WorkTask => ({ ...fromTodo(todo), hidden: todo.status !== 'done' && !isOpenTodo(todo, now) })

export function loadWork(): Promise<void> {
  // Asked again while a read is out (a change just landed): one more read after it.
  if (inflight) { again = true; return inflight }
  inflight = (async () => {
    const before = changes
    try {
      const [board, sheet] = await Promise.all([
        getTodoBoard(),
        getSheetFeed().catch(() => null as SheetFeed | null),
      ])
      // A change made while this read was out wins over what it read; read again after it.
      if (changes !== before) { again = true; return }
      const now = new Date()
      const todos = board.todos.filter((t) => !t.deletedAt).map((t) => local(t, now))
      const keep = state.tasks.filter((t) => t.kind === 'local' && fetchedExtra.has(t.ref) && !todos.some((l) => l.ref === t.ref))
      // Rows marked done or snoozed come too, so a chat can still name its row and the card can put it back.
      const rows = sheet?.configured ? [...sheet.items, ...(sheet.hidden ?? [])].map(fromSheet) : []
      set({
        tasks: [...todos, ...keep, ...rows],
        sheetName: sheet?.configured ? sheet.title || 'Shared sheet' : '',
        sheetFolder: sheet?.configured ? sheet.defaultFolderId ?? null : null,
        loaded: true,
        error: '',
      })
    } catch (e) {
      if (e instanceof AuthError) { onAuthError(); return }
      set({ loaded: true, error: (e instanceof Error && e.message) || 'Tasks could not be read.' })
    } finally {
      inflight = null
      if (again) { again = false; queueMicrotask(() => { void loadWork() }) }
    }
  })()
  return inflight
}

/** A task by ref; a local one the board does not list is read in the background. */
export function findTask(stored: string | undefined | null): WorkTask | null {
  if (!stored) return null
  const ref = resolveRef(stored, state.tasks)
  const found = state.tasks.find((t) => t.ref === ref)
  if (found) return found
  if (state.loaded && !ref.startsWith('sheet:') && !fetchedExtra.has(ref)) {
    fetchedExtra.add(ref)
    getTodo(ref)
      .then(({ todo }) => { if (!todo.deletedAt) set((s) => ({ tasks: [...s.tasks.filter((t) => t.ref !== ref), local(todo)] })) })
      .catch(() => { /* gone: the strip says so */ })
  }
  return null
}

function replaceTask(next: WorkTask) {
  changes += 1
  set((s) => ({ tasks: s.tasks.some((t) => t.ref === next.ref) ? s.tasks.map((t) => (t.ref === next.ref ? next : t)) : [next, ...s.tasks] }))
}

const quote = (title: string) => `“${title.length > 48 ? `${title.slice(0, 47)}…` : title}”`

// Each local task's edit count: a slow answer to an older edit never draws over a newer one.
const edits = new Map<string, number>()

/**
 * Change a local task's fields (due date, priority, folder, note…): drawn at once,
 * put back if the bridge refuses. Returns the saved task, or null.
 */
export async function updateTask(ref: string, patch: TodoPatch): Promise<Todo | null> {
  const before = state.tasks.find((t) => t.ref === ref)
  if (!before?.todo) return null
  const seq = (edits.get(ref) ?? 0) + 1
  edits.set(ref, seq)
  replaceTask(local({ ...before.todo, ...patch } as Todo))
  try {
    const { todo } = await updateBoardTodo(ref, patch)
    if (edits.get(ref) === seq) replaceTask(local(todo))
    return todo
  } catch (e) {
    if (edits.get(ref) === seq) replaceTask(before)
    fail(e, 'The change was not saved.')
    return null
  }
}

/** File a task under a project or folder, or make it Personal with null. */
export async function setTaskFolder(ref: string, projectId: string | null) {
  const task = state.tasks.find((t) => t.ref === resolveRef(ref, state.tasks))
  if (!task) return
  if (task.kind === 'local') { await updateTask(task.ref, { folderId: projectId }); return }
  replaceTask({ ...task, folderId: projectId, ...(task.sheet ? { sheet: { ...task.sheet, folderId: projectId, folderDefault: false } } : {}) })
  try {
    await fileSheetRow(task.ref, projectId)
    void loadWork()
  } catch (e) {
    replaceTask(task)
    fail(e, 'The task could not be filed there.')
  }
}

/**
 * Mark a sheet row done or snoozed for the owner only, or put it back with null:
 * kept in Totem, never written to the sheet. Drawn at once, with Undo.
 */
export async function markSheet(ref: string, next: 'done' | 'snoozed' | null, until: Date | null = null) {
  const before = state.tasks.find((t) => t.ref === resolveRef(ref, state.tasks))
  if (!before || before.kind !== 'sheet') return
  const mark = next ? { state: next, at: new Date().toISOString(), ...(next === 'snoozed' && until ? { until: until.toISOString() } : {}) } : undefined
  const { mark: _old, hidden: _hidden, ...plain } = before
  replaceTask({ ...plain, done: next === 'done', ...(next === 'snoozed' ? { hidden: true } : {}), ...(mark ? { mark } : {}) })
  try {
    await markSheetRow(before.ref, next, until)
    // A snooze that has run out since is no mark to put back.
    const prior = before.mark?.state === 'snoozed' && !(before.mark.until && new Date(before.mark.until) > new Date()) ? null : before.mark ?? null
    const undo = { label: 'Undo', onClick: () => { void markSheet(before.ref, prior?.state ?? null, prior?.until ? new Date(prior.until) : null) } }
    if (next === 'done') pushToast(`Done: ${quote(before.title)}. The sheet is unchanged.`, 'info', { action: undo })
    else if (next === 'snoozed' && until) pushToast(`Snoozed until ${wakeLabel(until, new Date())}`, 'info', { action: undo })
    void loadWork()
  } catch (e) {
    replaceTask(before)
    fail(e, next ? 'The row could not be marked.' : 'The row could not be put back.')
  }
}

/** Mark a task done, with Undo; a sheet row is done for the owner only (markSheet). */
export async function completeTask(ref: string) {
  const before = state.tasks.find((t) => t.ref === ref)
  if (before?.kind === 'sheet' && !before.done) { await markSheet(ref, 'done'); return }
  if (!before || before.kind !== 'local' || before.done) return
  replaceTask({ ...before, done: true })
  try {
    const { todo } = await moveBoardTodo(ref, 'done')
    replaceTask({ ...local(todo), done: true })
    pushToast(`Done: ${quote(before.title)}`, 'info', { action: { label: 'Undo', onClick: () => { void reopenTask(ref) } } })
    // A repeating task rolled its next occurrence on the bridge.
    void loadWork()
  } catch (e) {
    replaceTask(before)
    fail(e, 'The task could not be marked done.')
  }
}

export async function reopenTask(ref: string) {
  const before = state.tasks.find((t) => t.ref === ref)
  if (before?.kind === 'sheet') { await markSheet(ref, null); return }
  if (!before || before.kind !== 'local') return
  replaceTask({ ...before, done: false })
  try {
    const { todo } = await moveBoardTodo(ref, 'todo')
    replaceTask({ ...local(todo), done: false })
  } catch (e) {
    replaceTask(before)
    fail(e, 'The task could not be reopened.')
  }
}

/** Snooze a task until `until`, or wake it with null; Undo puts the old snooze back. */
export async function snoozeTask(ref: string, until: Date | null) {
  if (state.tasks.find((t) => t.ref === ref)?.kind === 'sheet') { await markSheet(ref, until ? 'snoozed' : null, until); return }
  const before = state.tasks.find((t) => t.ref === ref)?.todo
  if (!before) return
  const saved = await updateTask(ref, { snoozedUntil: until ? until.toISOString() : null })
  if (saved && until) {
    pushToast(`Snoozed until ${wakeLabel(until, new Date())}`, 'info', { action: { label: 'Undo', onClick: () => { void updateTask(ref, { snoozedUntil: before.snoozedUntil }) } } })
  }
}

/** Move a local task to the recycle bin, with Undo. */
export async function deleteTask(ref: string) {
  const before = state.tasks.find((t) => t.ref === ref)
  if (!before || before.kind !== 'local') return
  changes += 1
  set((s) => ({ tasks: s.tasks.filter((t) => t.ref !== ref) }))
  try {
    await deleteBoardTodo(ref)
    pushToast('Moved to the recycle bin', 'info', {
      action: { label: 'Undo', onClick: () => { void restoreBoardTodo(ref).then(({ todo }) => replaceTask(local(todo))).catch((e) => fail(e, 'The task could not be restored.')) } },
    })
  } catch (e) {
    replaceTask(before)
    fail(e, 'The task could not be moved to the recycle bin.')
  }
}

/** A new local task, filed under `projectId` when given. Returns it, or null on failure. */
export async function createTask(fields: { title: string; dueDate?: string | null; priority?: Todo['priority'] | null }, projectId: string | null = null): Promise<WorkTask | null> {
  try {
    const { todo } = await createBoardTodo({
      title: fields.title,
      ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
      ...(fields.priority ? { priority: fields.priority } : {}),
      ...(projectId ? { folderId: projectId } : {}),
    })
    const task = local(todo)
    replaceTask(task)
    return task
  } catch (e) {
    fail(e, 'The task could not be added.')
    return null
  }
}

/** The project a new chat for this task opens in: its folder, else where its latest chat is. */
export function taskHome(ref: string): string | null {
  const own = state.tasks.find((t) => t.ref === resolveRef(ref, state.tasks))?.folderId
  const projects = chatState().projects
  if (own && projects.some((p) => p.id === own)) return own
  const latest = chatState().threads.filter((t) => t.taskId && resolveRef(t.taskId, state.tasks) === ref && t.projectId).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return latest?.projectId && projects.some((p) => p.id === latest.projectId) ? latest.projectId : null
}

/** The store's subscription, for a reader that watches only while it is on screen (the composer's `$` menu). */
export { subscribe as subscribeWork }
