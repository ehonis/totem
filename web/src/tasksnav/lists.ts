// What the chats panel lists of the owner's tasks: the open ones by when they are
// due, the ones he snoozed (soonest back first), and the chats in play gathered
// under the task each works on. Pure; ChatsNav and tasksnav/parts.tsx draw it.
import { byDue, dueLabel, resolveRef, type WorkTask } from '../work/groups'
import { inScope, type SidebarScope } from '../chat/sidebar'
import type { ChatThread, Project } from '../chat/types'

export type TaskSectionId = 'overdue' | 'today' | 'soon' | 'later' | 'undated'
export interface TaskSection { id: TaskSectionId; label: string; tasks: WorkTask[] }

const ORDER: TaskSectionId[] = ['overdue', 'today', 'soon', 'later', 'undated']
const LABEL: Record<TaskSectionId, string> = { overdue: 'Overdue', today: 'Today', soon: 'Next 7 days', later: 'Later', undated: 'No date' }

/** Open and in sight: not done, not snoozed or archived. */
export const isListed = (t: WorkTask) => !t.done && !t.hidden

/** Open tasks under Overdue, Today, Next 7 days, Later and No date, each in due order; empty sections left out. */
export function taskSections(tasks: readonly WorkTask[], now: Date): TaskSection[] {
  const by = new Map<TaskSectionId, WorkTask[]>()
  for (const t of tasks) {
    if (!isListed(t)) continue
    const due = dueLabel(t.dueDate, now)
    const id: TaskSectionId = !due ? 'undated' : due.tone === 'soon' ? 'soon' : due.tone
    const list = by.get(id) || []
    list.push(t)
    by.set(id, list)
  }
  return ORDER.filter((id) => by.has(id)).map((id) => ({ id, label: LABEL[id], tasks: by.get(id)!.sort(byDue) }))
}

/** When a snoozed task or sheet row comes back, or null when it is not snoozed. */
export function wakeOf(t: WorkTask): string | null {
  if (t.todo) return t.todo.snoozedUntil
  return t.mark?.state === 'snoozed' ? t.mark.until ?? null : null
}

/** Tasks snoozed into the future, soonest back first (an archived task is hidden too, but is not snoozed). */
export function snoozedTasks(tasks: readonly WorkTask[], now: number): WorkTask[] {
  const at = (t: WorkTask) => Date.parse(wakeOf(t) || '') || 0
  return tasks.filter((t) => !t.done && t.hidden && at(t) > now).sort((a, b) => at(a) - at(b) || a.ref.localeCompare(b.ref))
}

/** What a task's chats are doing: one answering, one finished and waiting on him, or neither. */
export function taskActivity(chats: readonly ChatThread[] | undefined, live: (id: string) => boolean): 'live' | 'waiting' | null {
  if (!chats?.length) return null
  if (chats.some((c) => live(c.id))) return 'live'
  return chats.some((c) => c.needsReply) ? 'waiting' : null
}

/** The tasks filed inside the panel's scope (a task's folder stands where a chat's project does). */
export function scopedTasks(tasks: readonly WorkTask[], scope: SidebarScope, projects: Project[]): WorkTask[] {
  return scope === 'all' ? tasks.slice() : tasks.filter((t) => inScope({ projectId: t.folderId ?? undefined }, scope, projects))
}

export interface TaskGroup { task: WorkTask; chats: ChatThread[] }
/** A row of the "by task" list: a task with its chats in play, or a chat on no open task. */
export type PlayItem = { kind: 'task'; group: TaskGroup } | { kind: 'chat'; chat: ChatThread }

/**
 * The chats in play (in the order given: the panel's, latest first) gathered under
 * their open task. A task lands where its latest chat would; a chat with no task,
 * or whose task is done, snoozed, archived or unknown, stays a row of its own (a
 * snoozed task is listed under Snoozed tasks, never twice).
 */
export function playByTask(chats: readonly ChatThread[], tasks: readonly WorkTask[]): PlayItem[] {
  const open = new Map(tasks.filter(isListed).map((t) => [t.ref, t]))
  const groups = new Map<string, TaskGroup>()
  const out: PlayItem[] = []
  for (const c of chats) {
    const task = c.taskId ? open.get(resolveRef(c.taskId, tasks)) : undefined
    if (!task) { out.push({ kind: 'chat', chat: c }); continue }
    const g = groups.get(task.ref)
    if (g) { g.chats.push(c); continue }
    const fresh = { task, chats: [c] }
    groups.set(task.ref, fresh)
    out.push({ kind: 'task', group: fresh })
  }
  return out
}

/** Due today or before: the count on the Tasks switch. */
export function dueNow(sections: readonly TaskSection[]): number {
  return sections.filter((s) => s.id === 'overdue' || s.id === 'today').reduce((n, s) => n + s.tasks.length, 0)
}
