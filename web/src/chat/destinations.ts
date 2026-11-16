// Where a new chat goes, picked from the composer with `$`: `$harbor` puts the
// chat being started in the harbor folder, `$expense` starts it for that task
// (in the task's own folder, as "New chat for this task" does). Pure, so the
// composer's menu and its tests read the same rules.
import type { Project } from './types'
import type { WorkTask } from '../work/groups'

export type Destination =
  | { kind: 'home'; key: string; name: string }
  | { kind: 'project'; key: string; name: string; project: Project; parent?: Project }
  | { kind: 'task'; key: string; name: string; task: WorkTask }

/** A name as `$` reaches it: lower case, every run of other characters one hyphen. */
export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/**
 * How well a name answers the typed term: 0 the name starts with it, 1 a word in
 * it does, 2 it is somewhere in the name, 3 only in its project's name ("$acme"
 * finds the Work - Acme folders); -1 not at all. An empty term matches everything.
 */
export function matchScore(name: string, term: string, parent?: string): number {
  if (!term) return 0
  const s = slug(name)
  if (s.startsWith(term)) return 0
  if (`-${s}`.includes(`-${term}`)) return 1
  if (s.includes(term) || s.replace(/-/g, '').includes(term.replace(/-/g, ''))) return 2
  if (parent && slug(`${parent}-${name}`).includes(term)) return 3
  return -1
}

export interface DestinationContext {
  projects: readonly Project[]
  tasks: readonly WorkTask[]
  /** The project or folder the new chat is in now (null: Home). */
  projectId: string | null
  /** The task it is being started for, if any. */
  taskId: string | null
}

const PLACES = 8
const TASKS = 8
/** A bare `$` shows this many places, so the tasks under them are in view too. */
const PLACES_BARE = 4

/**
 * The `$` menu's places (Home, projects, folders) then tasks, best matches first.
 * None for a price ("$40", "$4.99", "$1,000"): Enter should send it.
 */
export function rankDestinations(ctx: DestinationContext, term: string): Destination[] {
  if (/^\d[\d.,]*$/.test(term)) return []
  const t = term.toLowerCase()
  const byId = new Map(ctx.projects.map((p) => [p.id, p]))
  const places: Array<{ d: Destination; s: number; order: number }> = []
  if (ctx.projectId) {
    const s = matchScore('Home', t)
    if (s >= 0) places.push({ d: { kind: 'home', key: 'home', name: 'Home' }, s, order: -1 })
  }
  // Projects in the order the chats panel lists them (most recent first), each followed by its folders.
  const tops = ctx.projects.filter((p) => !p.parentId).slice().sort((a, b) => b.updatedAt - a.updatedAt)
  let order = 0
  for (const top of tops) {
    for (const p of [top, ...ctx.projects.filter((f) => f.parentId === top.id).sort((a, b) => a.name.localeCompare(b.name))]) {
      order += 1
      if (p.id === ctx.projectId) continue
      const parent = p.parentId ? byId.get(p.parentId) : undefined
      const s = matchScore(p.name, t, parent?.name)
      if (s >= 0) places.push({ d: { kind: 'project', key: `p:${p.id}`, name: p.name, project: p, ...(parent ? { parent } : {}) }, s, order })
    }
  }
  places.sort((a, b) => a.s - b.s || a.order - b.order)

  // Open tasks the list shows (not done, snoozed or archived), soonest due first, then the sheet's.
  const tasks = ctx.tasks
    .filter((x) => !x.done && !x.hidden && x.ref !== ctx.taskId)
    .map((task) => ({ task, s: matchScore(task.title, t) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s
      || (a.task.kind === b.task.kind ? 0 : a.task.kind === 'local' ? -1 : 1)
      || dueOrder(a.task) - dueOrder(b.task)
      || b.task.updatedAt - a.task.updatedAt)

  return [
    ...places.slice(0, t ? PLACES : PLACES_BARE).map((x) => x.d),
    ...tasks.slice(0, TASKS).map(({ task }): Destination => ({ kind: 'task', key: `t:${task.ref}`, name: task.title, task })),
  ]
}

const dueOrder = (t: WorkTask) => (t.dueDate ? Date.parse(t.dueDate.slice(0, 10)) || Infinity : Infinity)

/**
 * The message with the `$…` token at `[start, end)` taken out, and where the
 * caret goes: "fix $cre the map" → "fix the map", caret after "fix ".
 */
export function stripToken(value: string, start: number, end: number) {
  let before = value.slice(0, start)
  let after = value.slice(end)
  if (/\s$/.test(before) && /^\s/.test(after)) after = after.replace(/^[ \t]+/, '')
  else if (!before.trim()) after = after.replace(/^[ \t]+/, '')
  if (!after.trim()) before = before.replace(/[ \t]+$/, '')
  return { value: before + after, caret: before.length }
}

/** Where a new chat's words are kept: ChatView's draft key for a chat not started yet. */
export function draftKeyFor(place: { taskId: string | null; projectId: string | null; kind?: string }) {
  return place.taskId ? `new:task:${place.taskId}` : place.projectId ? `new:project:${place.projectId}` : `new:${place.kind || 'regular'}`
}

/**
 * The drafts once a new chat's words move from one place to another: added under
 * what was already waiting there, never over it.
 */
export function moveDraft(drafts: Record<string, string>, from: string, to: string, text: string): Record<string, string> {
  const next = { ...drafts }
  const kept = from === to ? '' : next[to] || ''
  delete next[from]
  const joined = [kept, text].filter((s) => s.trim()).join('\n')
  if (joined) next[to] = joined
  else delete next[to]
  return next
}

/**
 * Where the chat is once a destination is picked. A place keeps the task it is
 * being started for; a task takes its own folder, else stays where it is.
 */
export function placeAfter(d: Destination, now: { taskId: string | null; projectId: string | null }, taskHome: (ref: string) => string | null) {
  if (d.kind === 'home') return { taskId: now.taskId, projectId: null }
  if (d.kind === 'project') return { taskId: now.taskId, projectId: d.project.id }
  return { taskId: d.task.ref, projectId: taskHome(d.task.ref) ?? now.projectId }
}
