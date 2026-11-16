// The Tasks page by folder: which tasks and sheet rows a scope chip shows, the chips
// themselves, and the list grouped by folder instead of by day. A folder is one of
// the owner's chat projects or the folders inside them; unfiled is Personal. Pure,
// so the page and its tests read the same rules.
import type { Project } from '../chat/types'
import { folderOrder } from '../work/groups'
import type { ListItem, ListSection } from './board'
import { folderFor } from './folders'
import type { Scope } from './QuickAdd'

/** An item's folder id, null when unfiled or its project is gone. */
export function itemFolder(item: ListItem, projects: readonly Project[]): string | null {
  return folderFor(item.kind === 'task' ? item.todo.folderId : item.item.folderId, projects)?.id ?? null
}

/** The top-level project an item's folder sits in, or null. */
export function itemProject(item: ListItem, projects: readonly Project[]): string | null {
  const own = folderFor(itemFolder(item, projects), projects)
  return own ? (own.parentId && projects.some((p) => p.id === own.parentId) ? own.parentId : own.id) : null
}

export const folderScope = (id: string): Scope => `folder:${id}`
export const scopeFolder = (scope: Scope): string | null => (scope.startsWith('folder:') ? scope.slice('folder:'.length) : null)

/**
 * Whether a scope (and, inside a project, one of its folders) shows an item. All
 * shows everything; Personal the unfiled; a project its own and its folders'
 * tasks and sheet rows; the sheet only its rows.
 */
export function inScope(item: ListItem, scope: Scope, sub: string | null, projects: readonly Project[]): boolean {
  if (scope === 'all') return true
  if (scope === 'sheet') return item.kind === 'sheet'
  if (scope === 'personal') return itemFolder(item, projects) === null
  const project = scopeFolder(scope)
  if (itemProject(item, projects) !== project) return false
  return !sub || itemFolder(item, projects) === sub
}

export interface FolderChip { id: Scope; project: Project | null; label: string; count: number }

/** One chip per top-level project with something open in it, in the chats panel's order, plus the one picked. */
export function projectChips(items: readonly ListItem[], projects: readonly Project[], picked: Scope): FolderChip[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    const p = itemProject(item, projects)
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  return projects
    .filter((p) => !p.parentId && (counts.has(p.id) || picked === folderScope(p.id)))
    .map((p) => ({ id: folderScope(p.id), project: p, label: p.name, count: counts.get(p.id) ?? 0 }))
}

/** Inside a project: one chip per folder of it with something open in it. */
export function subfolderChips(items: readonly ListItem[], projects: readonly Project[], project: string | null): Array<{ id: string; project: Project; count: number }> {
  if (!project) return []
  const counts = new Map<string, number>()
  for (const item of items) {
    const f = itemFolder(item, projects)
    if (f && f !== project) counts.set(f, (counts.get(f) ?? 0) + 1)
  }
  return projects.filter((p) => p.parentId === project && counts.has(p.id)).map((p) => ({ id: p.id, project: p, count: counts.get(p.id)! }))
}

export interface FolderSection {
  /** The folder's id, or '' for Personal. */
  key: string
  project: Project | null
  /** A folder's project, for its heading. */
  parent: Project | null
  items: ListItem[]
}

/**
 * The day groups regrouped by folder: projects in the chats panel's order, each
 * followed by its folders, then Personal. Inside a folder the items keep the day
 * order (overdue, today, upcoming, no date).
 */
export function groupByFolder(sections: readonly ListSection[], projects: readonly Project[]): FolderSection[] {
  const buckets = new Map<string, ListItem[]>()
  for (const section of sections) {
    for (const item of section.items) {
      const key = itemFolder(item, projects) ?? ''
      const list = buckets.get(key) ?? []
      list.push(item)
      buckets.set(key, list)
    }
  }
  const out: FolderSection[] = []
  for (const p of folderOrder(projects)) {
    const items = buckets.get(p.id)
    if (items?.length) out.push({ key: p.id, project: p, parent: p.parentId ? projects.find((x) => x.id === p.parentId) ?? null : null, items })
  }
  const loose = buckets.get('')
  if (loose?.length) out.push({ key: '', project: null, parent: null, items: loose })
  return out
}
