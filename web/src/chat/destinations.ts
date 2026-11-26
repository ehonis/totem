// Where a new chat goes, picked from the composer with `$`: `$harbor` puts the
// chat being started in the harbor folder, `$expense` starts it for that task
// (in the task's own folder, as "New chat for this task" does), and `$task` makes
// a new task right in the composer, then starts the chat for it, `$ghost` makes it
// a ghost chat (not kept: gone at midnight), and a name no place has yet
// (`$tax-returns`) offers a new folder or project by that name, `$opus` (any model
// or account name) picks the chat's model, `$pin` pins it from the start, and
// `$snooze` sends it now and keeps it out of the way until a time. In a ghost chat
// `$` offers one thing, the way out: `$regular` (or `$back`, `$keep`) makes it a
// chat that is kept, as the header's switch or Keep does. Pure, so the
// composer's menu and its tests read the same rules.
import type { ModelRow, Project, ProviderRow } from './types'
import type { WorkTask } from '../work/groups'
import { snoozePresets } from './settle'
import { visibleModels } from './models'

export type Destination =
  | { kind: 'home'; key: string; name: string }
  | { kind: 'project'; key: string; name: string; project: Project; parent?: Project }
  | { kind: 'task'; key: string; name: string; task: WorkTask }
  | { kind: 'new-task'; key: 'new-task'; name: 'New task' }
  | { kind: 'ghost'; key: 'ghost'; name: 'Ghost chat' }
  /** Out of a ghost chat: a kept chat at Home (not started yet), or Keep (started). */
  | { kind: 'leave-ghost'; key: 'leave-ghost'; name: string; started: boolean }
  /** A folder (in `parent`) or a top-level project, made by that name, then the chat starts in it. */
  | { kind: 'new-folder'; key: string; name: string; parent?: Project }
  /** A model to start on (no `modelId`: the account's own default). */
  | { kind: 'model'; key: string; name: string; provider: ProviderRow; modelId?: string; note?: string }
  | { kind: 'pin'; key: 'pin'; name: 'Pin it' }
  /** Send now, and keep it in Snoozed until `until`, even once the reply lands. */
  | { kind: 'snooze'; key: string; name: string; until: number; when: string }

/** What `$` takes for "make a new task": `$task`, `$new`, `$newtask`, from two letters on. */
const NEW_TASK_WORDS = ['task', 'new', 'new-task', 'newtask']
export const wantsNewTask = (term: string) => term.length >= 2 && NEW_TASK_WORDS.some((w) => w.startsWith(term))
const NEW_TASK: Destination = { kind: 'new-task', key: 'new-task', name: 'New task' }

/** What `$` takes for a ghost chat: `$gh…` for ghost, `$temp…`, `$inco…` (each word from its `min` letters). */
const GHOST_WORDS: Array<[string, number]> = [['ghost', 2], ['temporary', 4], ['incognito', 4]]
export const wantsGhost = (term: string) => GHOST_WORDS.some(([w, min]) => term.length >= min && w.startsWith(term))
const GHOST: Destination = { kind: 'ghost', key: 'ghost', name: 'Ghost chat' }

/** The way out of a ghost chat: `$regular`, `$back`, `$keep`, `$normal`, `$exit`, `$unghost`, `$leave`, `$ghost` again, from two letters. */
const LEAVE_GHOST_WORDS = ['regular', 'back', 'keep', 'normal', 'exit', 'unghost', 'leave', 'ghost', 'off']
export const wantsLeaveGhost = (term: string) => term.length >= 2 && LEAVE_GHOST_WORDS.some((w) => w.startsWith(term))

/**
 * A ghost chat's `$` menu: only the way out, for a bare `$` or a term that asks for it.
 * `started`: the chat has messages, so it is kept where it is (Keep) rather than moved.
 */
export function ghostDestinations(term: string, started: boolean): Destination[] {
  const t = term.toLowerCase()
  if (t && !wantsLeaveGhost(t)) return []
  return [{ kind: 'leave-ghost', key: 'leave-ghost', name: started ? 'Keep this chat' : 'Regular chat', started }]
}

/** `$pin` from `$pi`. */
export const wantsPin = (term: string) => term.length >= 2 && 'pin'.startsWith(term)
const PIN: Destination = { kind: 'pin', key: 'pin', name: 'Pin it' }

/** `$snooze` from `$sn`, `$later`, `$remind` from three letters; `$snooze-tom` narrows to a time. */
const SNOOZE_WORDS: Array<[string, number]> = [['snooze', 2], ['later', 3], ['remind', 3]]
export const wantsSnooze = (term: string) => SNOOZE_WORDS.some(([w, min]) => term.length >= min && w.startsWith(term))
function snoozeRows(term: string, now: Date): Destination[] {
  const narrow = /^(?:snooze|later|remind)-(.+)$/.exec(term)?.[1]
  if (!narrow && !wantsSnooze(term)) return []
  return snoozePresets(now)
    .filter((p) => !narrow || matchScore(p.label, narrow) >= 0 && matchScore(p.label, narrow) <= 1)
    .map((p) => ({ kind: 'snooze', key: `snooze:${p.id}`, name: p.label, until: p.until, when: p.when }))
}

/** Models offered for one term, at most. */
const MODELS = 5
/** Account and model names are matched from this many letters (`$op` for Opus). */
const MODEL_MIN = 2

/** Words `$` keeps for itself, so typing one never offers a folder by that name. */
const RESERVED = [...NEW_TASK_WORDS, ...GHOST_WORDS.map(([w]) => w), ...SNOOZE_WORDS.map(([w]) => w), 'pin', 'home', 'folder', 'project', 'new-folder', 'new-project']
/** A name is offered as a new folder from this many letters, once no place matches it. */
const NEW_FOLDER_MIN = 3

/** The name a typed `$tax-returns` stands for: hyphens as spaces, a capital if he typed none. */
export function nameFromTerm(raw: string) {
  const name = raw.replace(/-+/g, ' ').trim()
  return name === name.toLowerCase() ? name.charAt(0).toUpperCase() + name.slice(1) : name
}

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
  /** Every account and the models it lists (as the model picker has them), for `$opus`. */
  models?: ReadonlyArray<{ provider: ProviderRow; models: readonly ModelRow[] }>
  /** Offer `$pin` and `$snooze` (they need a chat view that sends them). */
  startOptions?: boolean
  /** It is pinned already: no `$pin`. */
  pinned?: boolean
  now?: Date
}

const PLACES = 8
const TASKS = 8
/** A bare `$` shows this many places, so the tasks under them are in view too. */
const PLACES_BARE = 4

/**
 * The `$` menu's places (Home, projects, folders) then tasks, best matches first.
 * "New task" and "Ghost chat" lead when the term asks for them (`$task`, `$ghost`) and
 * sit between the places and the tasks for a bare `$`. A name that matches no place
 * ends the list with "New folder … in <project>" (in a project or folder) and "New
 * project …"; `raw` is the term as typed, for the name's capitals. None for a price
 * ("$40", "$4.99", "$1,000"): Enter should send it.
 */
export function rankDestinations(ctx: DestinationContext, term: string, raw = term): Destination[] {
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

  const found = tasks.slice(0, TASKS).map(({ task }): Destination => ({ kind: 'task', key: `t:${task.ref}`, name: task.title, task }))
  const shown = places.slice(0, t ? PLACES : PLACES_BARE).map((x) => x.d)
  const lead = [
    ...(wantsNewTask(t) ? [NEW_TASK] : []), ...(wantsGhost(t) ? [GHOST] : []),
    ...(ctx.startOptions && !ctx.pinned && wantsPin(t) ? [PIN] : []),
    ...(ctx.startOptions ? snoozeRows(t, ctx.now ?? new Date()) : []),
  ]
  if (!t) return [...shown, NEW_TASK, GHOST, ...found]
  const models = rankModels(ctx.models || [], t)
  // Only a name nothing has yet offers a new one; the folder the chat is in counts,
  // and so does a name the term is the start of ("$harb" is on its way to harbor), or a model's.
  const taken = lead.length > 0 || places.length > 0 || models.length > 0 || ctx.projects.some((p) => { const s = matchScore(p.name, t); return s === 0 || s === 1 })
  return [...lead, ...shown, ...models, ...found, ...(taken ? [] : newFolders(ctx, t, raw))]
}

/**
 * `$opus`, `$gpt-5`, `$codex`: models whose name or id the term starts or starts a word of
 * (favourites first), and an account named by the term, which starts on its own default.
 */
export function rankModels(accounts: NonNullable<DestinationContext['models']>, t: string): Destination[] {
  if (t.length < MODEL_MIN) return []
  // The account's own row leads its models (fav -1), then favourites, then the rest.
  const close = (name: string) => { const s = matchScore(name, t); return s === 0 || s === 1 ? s : -1 }
  const out: Array<{ d: Destination; s: number; fav: number; order: number }> = []
  let order = 0
  for (const { provider, models } of accounts) {
    const named = close(provider.name)
    const accountScore = named >= 0 ? named : close(provider.driver)
    if (accountScore >= 0) out.push({ d: { kind: 'model', key: `m:${provider.id}:`, name: `${provider.name} default`, provider, note: 'The account’s default model' }, s: accountScore, fav: -1, order: order++ })
    if (!provider.supportsModelPicker) continue
    for (const m of visibleModels([...models])) {
      const scores = [close(m.name || m.id), close(m.id)].filter((x) => x >= 0)
      if (!scores.length) continue
      out.push({ d: { kind: 'model', key: `m:${provider.id}:${m.id}`, name: m.name || m.id, provider, modelId: m.id, ...(m.note ? { note: m.note } : {}) }, s: Math.min(...scores), fav: m.favorite ? 0 : 1, order: order++ })
    }
  }
  out.sort((a, b) => a.s - b.s || a.fav - b.fav || a.order - b.order)
  return out.slice(0, MODELS).map((x) => x.d)
}

/** "New folder “Tax returns” in Acme" (in a project or one of its folders: one level only) and "New project “Tax returns”". */
function newFolders(ctx: DestinationContext, t: string, raw: string): Destination[] {
  if (t.length < NEW_FOLDER_MIN || !/[a-z]/.test(t) || RESERVED.some((w) => w.startsWith(t))) return []
  const name = nameFromTerm(raw).slice(0, 80)
  if (!name) return []
  const here = ctx.projectId ? ctx.projects.find((p) => p.id === ctx.projectId) : undefined
  const root = here?.parentId ? ctx.projects.find((p) => p.id === here.parentId) : here
  return [
    ...(root ? [{ kind: 'new-folder' as const, key: `new-folder:${root.id}`, name, parent: root }] : []),
    { kind: 'new-folder', key: 'new-project', name },
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

/**
 * Where the chat is once a destination is picked. A place keeps the task it is
 * being started for; a task takes its own folder, else stays where it is.
 */
export function placeAfter(d: Destination, now: { taskId: string | null; projectId: string | null }, taskHome: (ref: string) => string | null) {
  // "New task" and "New folder" move nothing until the task or folder exists (made first);
  // a model, a pin or a snooze changes how it starts, not where.
  if (d.kind === 'new-task' || d.kind === 'new-folder' || d.kind === 'model' || d.kind === 'pin' || d.kind === 'snooze') return now
  // A ghost chat lives at Home, outside any project or task, and leaving one stays there.
  if (d.kind === 'ghost' || d.kind === 'leave-ghost') return { taskId: null, projectId: null }
  if (d.kind === 'home') return { taskId: now.taskId, projectId: null }
  if (d.kind === 'project') return { taskId: now.taskId, projectId: d.project.id }
  return { taskId: d.task.ref, projectId: taskHome(d.task.ref) ?? now.projectId }
}
