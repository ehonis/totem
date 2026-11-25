// `$task` in a new chat's composer: the box becomes a task line. What is typed is
// read the way the Tasks page's quick-add line reads it (todos/parse.ts: "tomorrow",
// "p2", "#folder"), and the task is filed where the chat is being started unless a
// #folder says otherwise. Pure, so the composer and its tests read the same rules.
import { parseQuickAdd, type FolderName, type QuickAdd } from '../todos/parse'
import { plainRefs } from './refs'
import { messageText } from './editor/markdown'

export interface NewTaskFields {
  title: string
  dueDate: string | null
  priority: 1 | 2 | 3 | 4 | null
  /** Where the task is filed (and the chat for it starts); null is Personal. */
  folderId: string | null
}

/** The box's text as one line: a file chip reads as its name, lines run together. */
export const taskLine = (value: string) => plainRefs(messageText(value)).replace(/\s+/g, ' ').trim()

export function readNewTask(value: string, opts: { now: Date; folders: readonly FolderName[]; ignore: readonly string[]; projectId: string | null }): { parsed: QuickAdd; fields: NewTaskFields | null } {
  const parsed = parseQuickAdd(taskLine(value), { now: opts.now, folders: opts.folders, ignore: opts.ignore })
  const title = parsed.title.slice(0, 500).trim()
  if (!title) return { parsed, fields: null }
  return { parsed, fields: { title, dueDate: parsed.dueDate, priority: parsed.priority, folderId: parsed.folderId ?? opts.projectId } }
}
