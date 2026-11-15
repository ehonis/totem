// The chats panel's Tasks face: the owner's tasks, the shared sheet's action
// items and which chat folder each is filed under, kept in one small store the
// panel, the composer's task strip and the pickers all read.
//
// Read on first use, again every minute while something is watching and when the
// window comes back into focus. Every change is drawn at once and put back if the
// bridge says no, as the Tasks page does.
import { useSyncExternalStore } from 'react'
import { api, AuthError, createBoardTodo, getSheetFeed, getTodo, getTodoBoard, moveBoardTodo } from '../api'
import { pushError, pushToast } from '../toast'
import { getState as chatState } from '../chat/store'
import type { SheetFeed, Todo } from '../todos/types'
import { fromSheet, fromTodo, isOpenTodo, resolveFolders, resolveRef, type WorkTask } from './groups'

export interface WorkState {
  /** Local tasks on the board (open, done and snoozed) plus sheet rows, by ref. */
  tasks: WorkTask[]
  /** Task ref → project or folder id, as stored (a sheet row's ref may have moved since: resolveFolders). */
  folders: Record<string, string>
  /** The sheet's display name, when one is set up. */
  sheetName: string
  loaded: boolean
  error: string
}

let state: WorkState = { tasks: [], folders: {}, sheetName: '', loaded: false, error: '' }
const subs = new Set<() => void>()
let onAuthError: () => void = () => {}

function set(patch: Partial<WorkState> | ((s: WorkState) => Partial<WorkState>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  subs.forEach((fn) => fn())
}

export const getWork = () => state

let watchers = 0
let timer = 0
const onFocus = () => { void loadWork() }

function subscribe(fn: () => void) {
  subs.add(fn)
  watchers += 1
  if (watchers === 1) {
    if (!state.loaded) void loadWork()
    timer = window.setInterval(() => { if (document.visibilityState === 'visible') void loadWork() }, 60_000)
    window.addEventListener('focus', onFocus)
  }
  return () => {
    subs.delete(fn)
    watchers -= 1
    if (watchers === 0) { window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
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
let changes = 0

export function loadWork(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    const before = changes
    try {
      const [board, sheet, folders] = await Promise.all([
        getTodoBoard(),
        getSheetFeed().catch(() => null as SheetFeed | null),
        api<{ folders: Record<string, string> }>('/api/chat/task-folders').catch(() => ({ folders: state.folders })),
      ])
      // A change made while this read was out wins over what it read; read again after it.
      if (changes !== before) { queueMicrotask(() => { void loadWork() }); return }
      const now = new Date()
      const local = board.todos.filter((t) => !t.deletedAt).map((t) => ({ ...fromTodo(t), hidden: t.status !== 'done' && !isOpenTodo(t, now) }))
      const keep = state.tasks.filter((t) => t.kind === 'local' && fetchedExtra.has(t.ref) && !local.some((l) => l.ref === t.ref))
      const rows = sheet?.configured ? sheet.items.map(fromSheet) : []
      set({
        tasks: [...local, ...keep, ...rows],
        folders: folders.folders,
        sheetName: sheet?.configured ? sheet.title || 'Shared sheet' : '',
        loaded: true,
        error: '',
      })
    } catch (e) {
      if (e instanceof AuthError) { onAuthError(); return }
      set({ loaded: true, error: (e instanceof Error && e.message) || 'Tasks could not be read.' })
    } finally {
      inflight = null
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
      .then(({ todo }) => { if (!todo.deletedAt) set((s) => ({ tasks: [...s.tasks.filter((t) => t.ref !== ref), { ...fromTodo(todo), hidden: todo.status !== 'done' && !isOpenTodo(todo, new Date()) }] })) })
      .catch(() => { /* gone: the strip says so */ })
  }
  return null
}

function replaceTask(next: WorkTask) {
  changes += 1
  set((s) => ({ tasks: s.tasks.some((t) => t.ref === next.ref) ? s.tasks.map((t) => (t.ref === next.ref ? next : t)) : [next, ...s.tasks] }))
}

/** File a task under a project or folder, or take it out of any with null. */
export async function setTaskFolder(ref: string, projectId: string | null) {
  const before = state.folders
  // A filing stored under a sheet row's old ref would still name this row: drop it too.
  const moved = Object.keys(before).filter((k) => k !== ref && resolveRef(k, state.tasks) === ref)
  changes += 1
  set((s) => {
    const folders = { ...s.folders }
    for (const k of moved) delete folders[k]
    if (projectId) folders[ref] = projectId
    else delete folders[ref]
    return { folders }
  })
  const put = (key: string, value: string | null) => api<{ folders: Record<string, string> }>(`/api/chat/task-folders/${encodeURIComponent(key)}`, {
    method: 'PUT', body: JSON.stringify({ projectId: value }),
  })
  try {
    for (const k of moved) await put(k, null)
    const r = await put(ref, projectId)
    set({ folders: r.folders })
  } catch (e) {
    set({ folders: before })
    fail(e, 'The task could not be filed there.')
  }
}

const quote = (title: string) => `“${title.length > 48 ? `${title.slice(0, 47)}…` : title}”`

/** Mark a local task done, with Undo. Sheet rows are finished in the sheet. */
export async function completeTask(ref: string) {
  const before = state.tasks.find((t) => t.ref === ref)
  if (!before || before.kind !== 'local' || before.done) return
  replaceTask({ ...before, done: true })
  try {
    const { todo } = await moveBoardTodo(ref, 'done')
    replaceTask({ ...fromTodo(todo), done: true })
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
  if (!before || before.kind !== 'local') return
  replaceTask({ ...before, done: false })
  try {
    const { todo } = await moveBoardTodo(ref, 'todo')
    replaceTask({ ...fromTodo(todo), done: false })
  } catch (e) {
    replaceTask(before)
    fail(e, 'The task could not be reopened.')
  }
}

/** A new local task, filed under `projectId` when given. Returns it, or null on failure. */
export async function createTask(fields: { title: string; dueDate?: string | null; priority?: Todo['priority'] | null }, projectId: string | null = null): Promise<WorkTask | null> {
  try {
    const { todo } = await createBoardTodo({
      title: fields.title,
      ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
      ...(fields.priority ? { priority: fields.priority } : {}),
    })
    const task = fromTodo(todo)
    replaceTask(task)
    if (projectId) await setTaskFolder(task.ref, projectId)
    return task
  } catch (e) {
    fail(e, 'The task could not be added.')
    return null
  }
}

/** The project a new chat for this task opens in: its folder, else where its latest chat is. */
export function taskHome(ref: string): string | null {
  const own = resolveFolders(state.folders, state.tasks)[ref]
  const projects = chatState().projects
  if (own && projects.some((p) => p.id === own)) return own
  const latest = chatState().threads.filter((t) => t.taskId && resolveRef(t.taskId, state.tasks) === ref && t.projectId).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return latest?.projectId && projects.some((p) => p.id === latest.projectId) ? latest.projectId : null
}
