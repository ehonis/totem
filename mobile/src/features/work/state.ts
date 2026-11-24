// The tasks chats link to, as data (web work/state.ts, rebuilt over the app's own
// task store): the owner's tasks and the shared sheet's rows as one list of
// WorkTasks (lib/work/groups.ts, the web's file byte for byte), read by the drawer's
// task badges, a chat's task strip and the link sheet, and the few changes those
// make. The board store (features/todos/store.ts) stays the one copy of the tasks,
// so the Tasks page, a task's page and the drawer always agree; nothing here keeps a
// second list.
//
// Every change is drawn at once and put back if the bridge says no. What can be
// taken back comes back as an UndoState for an inline Undo line: the
// phone shows error toasts only (mobile/AGENTS.md).
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { ApiError, createBoardTodo, getTodo, isAccountChanged } from '../../lib/api'
import { getState as chatState } from '../../lib/chat/store'
import { pushError } from '../../lib/toast'
import { rollsOnCompletion } from '../../lib/todos/board.ts'
import type { Todo } from '../../lib/todos/types'
import { fromSheet, fromTodo, isOpenTodo, resolveRef, type WorkTask } from '../../lib/work/groups'
import { boardActions } from '../todos/boardActions'
import { getBoard, loadBoard, loadSheet, markSheet, setTodos, useBoard, type BoardState } from '../todos/store'
import { quote, undoText } from '../todos/undo'
import type { UndoState } from '../todos/detail/bits'

export type { WorkTask }

const local = (todo: Todo, now = new Date()): WorkTask => ({ ...fromTodo(todo), hidden: todo.status !== 'done' && !isOpenTodo(todo, now) })

// Tasks a chat links to that the board does not list (finished long ago and
// archived, say), read one by one so a chat's strip can still name its task.
const extras = new Map<string, Todo>()
const asked = new Set<string>()
let extrasVersion = 0
const extrasSubs = new Set<() => void>()
const subscribeExtras = (fn: () => void) => { extrasSubs.add(fn); return () => { extrasSubs.delete(fn) } }
function addExtra(todo: Todo) {
  extras.set(todo.id, todo)
  extrasVersion += 1
  extrasSubs.forEach((fn) => fn())
}

/** Every task and sheet row the board knows, open or not. */
export function workTasks(board: Pick<BoardState, 'todos' | 'snoozed' | 'archive' | 'sheet'>, now = new Date()): WorkTask[] {
  const todos = [...board.todos, ...board.snoozed, ...(board.archive ?? [])].filter((t) => !t.deletedAt)
  const seen = new Set(todos.map((t) => t.id))
  const kept = [...extras.values()].filter((t) => !seen.has(t.id) && !t.deletedAt)
  const sheet = board.sheet?.configured ? [...board.sheet.items, ...(board.sheet.hidden ?? [])].map(fromSheet) : []
  return [...[...todos, ...kept].map((t) => local(t, now)), ...sheet]
}

/**
 * Read the board and the sheet once if nothing has yet (a chat's strip or the
 * picker opened before the Tasks page or the drawer). Later reads are
 * theirs: the Tasks page, and the drawer each time it opens on a card with a task.
 */
export function useWorkLoaded(wanted = true) {
  const { loaded, loading, sheet, sheetError } = useBoard()
  useEffect(() => {
    if (!wanted) return
    if (!loaded && !loading) void loadBoard()
    if (!sheet && !sheetError) void loadSheet()
  }, [wanted]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** The list the badges, the pickers and the chat's strip read. */
export function useWorkTasks(): WorkTask[] {
  const board = useBoard()
  const version = useSyncExternalStore(subscribeExtras, () => extrasVersion)
  return useMemo(() => workTasks(board), [board.todos, board.snoozed, board.archive, board.sheet, version]) // eslint-disable-line react-hooks/exhaustive-deps
}

export const sheetTitle = (board: Pick<BoardState, 'sheet'>) => (board.sheet?.configured ? board.sheet.title || 'Shared sheet' : '')

/** A task by a stored ref (a chat's taskId); a local one the board does not list is read in the background. */
export function useTask(stored: string | null | undefined): WorkTask | null {
  const tasks = useWorkTasks()
  const { loaded } = useBoard()
  const ref = stored ? resolveRef(stored, tasks) : null
  const task = ref ? tasks.find((t) => t.ref === ref) ?? null : null
  useWorkLoaded(!!stored)
  useEffect(() => {
    if (!ref || task || !loaded || ref.startsWith('sheet:') || asked.has(ref)) return
    asked.add(ref)
    getTodo(ref)
      .then(({ todo }) => { if (!todo.deletedAt) addExtra(todo) })
      // Gone (404): the strip says so. Any other failure (a phone off the network) is asked again on the next mount.
      .catch((cause) => { if (!(cause instanceof ApiError && cause.status === 404)) asked.delete(ref) })
  }, [ref, task, loaded])
  return task
}

function current(ref: string): WorkTask | undefined {
  const tasks = workTasks(getBoard())
  const resolved = resolveRef(ref, tasks)
  return tasks.find((t) => t.ref === resolved)
}

const say = (message: string) => { if (message) pushError(message) }
const actions = () => boardActions(say)
const message = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback)
let undoIds = 0
const undo = (text: string, run?: () => void): UndoState => ({ id: ++undoIds, text, ...(run ? { action: { label: 'Undo', run } } : {}) })

/** Done: a task is finished, a sheet row is done for the owner only (the sheet is unchanged). */
export async function completeTask(ref: string): Promise<UndoState | null> {
  const task = current(ref)
  if (!task || task.done) return null
  if (task.kind === 'sheet') {
    try { await markSheet(task.ref, 'done') }
    catch (cause) { if (!isAccountChanged(cause)) pushError(message(cause, 'The row could not be marked.')); return null }
    return undo(`Done: ${quote(task.title)}. The sheet is unchanged.`, () => { void markSheet(task.ref, null).catch((cause) => pushError(message(cause, 'The row could not be put back.'))) })
  }
  const todo = task.todo!
  // The board's actions work on its open list; a snoozed or archived task finished from a chat's strip is read back.
  const onBoard = getBoard().todos.some((t) => t.id === todo.id)
  if (!(await actions().move(todo, 'done'))) return null
  if (!onBoard) void loadBoard()
  // A repeating task rolled its next one on the bridge: reopening this one would leave two.
  if (rollsOnCompletion(todo)) return undo(undoText('done', todo, { followUp: { kind: 'next', dueDate: null } }).text)
  return undo(undoText('done', todo).text, () => { void actions().putBack(todo) })
}

/** A new local task, filed under `folderId` when given. Returns it, or null when the bridge said no. */
export async function createTask(fields: { title: string; dueDate?: string | null; priority?: Todo['priority'] | null }, folderId: string | null): Promise<WorkTask | null> {
  try {
    const { todo } = await createBoardTodo({
      title: fields.title,
      ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
      ...(fields.priority ? { priority: fields.priority } : {}),
      ...(folderId ? { folderId } : {}),
    })
    // Onto the board as it is, without the Tasks page's "bring the new task into view".
    setTodos((list) => [todo, ...list.filter((t) => t.id !== todo.id)])
    return local(todo)
  } catch (cause) {
    if (!isAccountChanged(cause)) pushError(message(cause, 'The task could not be added.'))
    return null
  }
}

/** The project a new chat for this task opens in: its folder, else where its latest chat is. */
export function taskHome(ref: string): string | null {
  const tasks = workTasks(getBoard())
  const resolved = resolveRef(ref, tasks)
  const own = tasks.find((t) => t.ref === resolved)?.folderId
  const { projects, threads } = chatState()
  if (own && projects.some((p) => p.id === own)) return own
  const latest = threads.filter((t) => t.taskId && resolveRef(t.taskId, tasks) === resolved && t.projectId).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return latest?.projectId && projects.some((p) => p.id === latest.projectId) ? latest.projectId : null
}
