// The chats panel as data, the way T3 Code's sidebar lists threads: one list of
// every chat, whatever project or folder it is filed in, on five shelves.
//
//   Pinned    chats he pinned, in pin order (newest first)
//   (list)    everything else still in play: finished, unread, waiting on him,
//             or just not settled yet; latest activity first
//   Working   chats with a reply running right now, newest first; one that
//             stops to ask him something moves up into the list
//   Snoozed   out of the way until a time, soonest first
//   Settled   done with, most recent first; one shelf for every project
//
// Nothing is filed away by project any more: a chat in a folder three levels
// down shows next to one at Home, with its place named on the row. A scope
// (one project and its folders, or Home) narrows the list when he asks for it.
// Totems' own chats are not listed; they live with their totems.
import type { ChatThread, Project } from './types'
import { activeAt, isSnoozed, settledAt } from './settle'

/** What the list shows: every chat, the ones in no project, or one project and its folders. */
export type SidebarScope = 'all' | 'home' | string

export interface SidebarLists {
  pinned: ChatThread[]
  inbox: ChatThread[]
  working: ChatThread[]
  snoozed: ChatThread[]
  settled: ChatThread[]
}

export interface SidebarOptions {
  now: number
  autoDays: number
  /** A reply is running in this chat. */
  live: (id: string) => boolean
  /** It is waiting on him (a question, an approval, the browser, a proposal): it belongs in the list, never under Working or Settled on its own. */
  needsYou?: (t: ChatThread) => boolean
  /** The chat on screen, which keeps its place while it is open (settle.ts). */
  openId?: string | null
  /** The chat that is open, listed even before its first message. */
  activeId?: string | null
  scope?: SidebarScope
  projects?: Project[]
}

/** Does this chat fall inside the scope? A chat in a deleted project counts as Home. */
export function inScope(t: Pick<ChatThread, 'projectId'>, scope: SidebarScope, projects: Project[]): boolean {
  if (scope === 'all') return true
  const p = t.projectId ? projects.find((x) => x.id === t.projectId) : undefined
  if (scope === 'home') return !p
  return !!p && (p.id === scope || p.parentId === scope)
}

/** A chat the list shows at all: it has been written in (or is open or running), and is not a totem's own. */
export function listed(t: ChatThread, activeId: string | null | undefined, live: (id: string) => boolean): boolean {
  if (t.totemId) return false
  return t.messages.length > 0 || (t.messageCount ?? 0) > 0 || t.id === activeId || live(t.id)
}

export function sidebarLists(threads: ChatThread[], o: SidebarOptions): SidebarLists {
  const { now, autoDays, live, needsYou = () => false, openId = null, activeId = null, scope = 'all', projects = [] } = o
  const out: SidebarLists = { pinned: [], inbox: [], working: [], snoozed: [], settled: [] }
  const settledOrder = new Map<string, number>()
  for (const t of threads) {
    if (!listed(t, activeId, live) || !inScope(t, scope, projects)) continue
    if (isSnoozed(t, now)) { out.snoozed.push(t); continue }
    // Waiting on him stays in play, whatever would settle it on its own (age, a finished
    // task, the agent's "done"); only his own Settle shelves it (settle.ts settledAt).
    const at = settledAt(t, now, autoDays, live(t.id), t.id === openId, needsYou(t))
    if (at) { settledOrder.set(t.id, at); out.settled.push(t); continue }
    if (t.pinned) out.pinned.push(t)
    else if (live(t.id) && !needsYou(t)) out.working.push(t)
    else out.inbox.push(t)
  }
  const recent = (a: ChatThread, b: ChatThread) => activeAt(b, now) - activeAt(a, now) || a.id.localeCompare(b.id)
  out.pinned.sort(recent)
  out.inbox.sort(recent)
  out.working.sort(recent)
  out.snoozed.sort((a, b) => (a.snoozedUntil || 0) - (b.snoozedUntil || 0))
  out.settled.sort((a, b) => (settledOrder.get(b.id) || 0) - (settledOrder.get(a.id) || 0) || a.id.localeCompare(b.id))
  return out
}

/** Where a chat lives, for its row: "Acme › Network refresh", "Acme", or '' at Home. */
export function placeLabel(t: Pick<ChatThread, 'projectId'>, projects: Project[]): string {
  const p = t.projectId ? projects.find((x) => x.id === t.projectId) : undefined
  if (!p) return ''
  const parent = p.parentId ? projects.find((x) => x.id === p.parentId) : undefined
  return parent ? `${parent.name} › ${p.name}` : p.name
}

/** The scope's name on its button. */
export function scopeLabel(scope: SidebarScope, projects: Project[]): string {
  if (scope === 'all') return 'All chats'
  if (scope === 'home') return 'Home'
  return projects.find((p) => p.id === scope)?.name || 'All chats'
}

/** A scope that still exists (a deleted project falls back to every chat). */
export function validScope(scope: string | null | undefined, projects: Project[]): SidebarScope {
  if (!scope || scope === 'all' || scope === 'home') return (scope as SidebarScope) || 'all'
  return projects.some((p) => p.id === scope) ? scope : 'all'
}
