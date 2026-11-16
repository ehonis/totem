// Task folders (web/src/todos/folders.ts and byFolder.ts): every task, and every row
// of the task sheet, is filed under one of the owner's chat projects or the folders
// inside them (`folderId`, todos/folders.mjs on the bridge); an unfiled one, or one
// whose project was deleted, is "Personal". The Tasks page's scope chips, a row's
// folder label and the folder pickers all read these rules. Pure, with type-only
// imports, so node's test runner loads it as is.
import type { MenuAction } from '@react-native-menu/menu'
import type { ListItem } from '../../lib/todos/board.ts'
import type { FolderName } from '../../lib/todos/parse.ts'
import type { Project } from '../../lib/chat/types'

export const PERSONAL = 'Personal'

/** What these rules read of a chat project. */
export type Folder = Pick<Project, 'id' | 'name' | 'parentId'>

/** The project a task is filed under, if it still exists; null reads as Personal. */
export function folderFor<P extends Folder>(id: string | null | undefined, projects: readonly P[]): P | null {
  return (id && projects.find((p) => p.id === id)) || null
}

/** "Work / Client" for a folder, the name for a project, "Personal" for none. */
export function folderLabel(id: string | null | undefined, projects: readonly Folder[]): string {
  const own = folderFor(id, projects)
  if (!own) return PERSONAL
  const parent = own.parentId ? projects.find((p) => p.id === own.parentId) : undefined
  return parent ? `${parent.name} / ${own.name}` : own.name
}

/** Projects in the chats panel's order, each followed by its folders (web work/groups.ts folderOrder). */
export function folderOrder<P extends Folder>(projects: readonly P[]): P[] {
  const roots = projects.filter((p) => !p.parentId)
  return roots.flatMap((p) => [p, ...projects.filter((f) => f.parentId === p.id)])
}

/** The names the composer's #folder reads (lib/todos/parse.ts). */
export function folderNames(projects: readonly Folder[]): FolderName[] {
  return projects.map((p) => ({ id: p.id, name: p.name, parentId: p.parentId ?? null }))
}

/** An item's folder id, null when unfiled or its project is gone. */
export function itemFolder(item: ListItem, projects: readonly Folder[]): string | null {
  return folderFor(item.kind === 'task' ? item.todo.folderId : item.item.folderId, projects)?.id ?? null
}

/** The top-level project an item's folder sits in, or null. */
export function itemProject(item: ListItem, projects: readonly Folder[]): string | null {
  const own = folderFor(itemFolder(item, projects), projects)
  return own ? (own.parentId && projects.some((p) => p.id === own.parentId) ? own.parentId : own.id) : null
}

/**
 * What the Tasks page shows: everything (''), the unfiled ('personal'), the task
 * sheet's rows alone ('sheet'), or one top-level project with its folders.
 */
export type TaskScope = '' | 'personal' | 'sheet' | `folder:${string}`
export const folderScope = (id: string): TaskScope => `folder:${id}`
export const scopeFolder = (scope: TaskScope | undefined): string | null =>
  (scope && scope.startsWith('folder:') ? scope.slice('folder:'.length) : null)

/** Whether a scope shows an item. A project shows its own and its folders' tasks and sheet rows. */
export function inScope(item: ListItem, scope: TaskScope | undefined, projects: readonly Folder[]): boolean {
  if (!scope) return true
  if (scope === 'sheet') return item.kind === 'sheet'
  if (scope === 'personal') return itemFolder(item, projects) === null
  return itemProject(item, projects) === scopeFolder(scope)
}

/** A saved scope that no longer names anything (its project was deleted) shows everything. */
export function liveScope(scope: TaskScope, projects: readonly Folder[], projectsLoaded: boolean): TaskScope {
  const id = scopeFolder(scope)
  if (!id || !projectsLoaded) return scope
  const own = folderFor(id, projects)
  return own && !own.parentId ? scope : ''
}

export interface ScopeChip<P extends Folder = Folder> { id: TaskScope; label: string; count: number; project?: P | null }

/**
 * The chips above the list: All, Personal, one per top-level project with something
 * open in it (its folders' tasks and sheet rows count), in the chats panel's order,
 * plus the one picked, then the task sheet when it is set up.
 */
export function scopeChips<P extends Folder>(items: readonly ListItem[], projects: readonly P[], picked: TaskScope, sheet: { name: string; count: number } | null): ScopeChip<P>[] {
  const counts = new Map<string, number>()
  let personal = 0
  for (const item of items) {
    const p = itemProject(item, projects)
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1)
    else personal += 1
  }
  return [
    { id: '', label: 'All', count: items.length },
    { id: 'personal', label: PERSONAL, count: personal, project: null },
    ...projects
      .filter((p) => !p.parentId && (counts.has(p.id) || picked === folderScope(p.id)))
      .map((p): ScopeChip<P> => ({ id: folderScope(p.id), label: p.name, count: counts.get(p.id) ?? 0, project: p })),
    ...(sheet ? [{ id: 'sheet' as TaskScope, label: sheet.name, count: sheet.count }] : []),
  ]
}

/**
 * A row's folder label, or null when unfiled or where the chip already says it (the row is filed in
 * the project the page is scoped to).
 */
export function rowFolder(folderId: string | null | undefined, projects: readonly Folder[], scope: TaskScope | undefined): string | null {
  const own = folderFor(folderId, projects)
  // An unfiled task says nothing, as on the web: "Personal" on most rows is noise (its chip finds them).
  if (!own) return null
  const project = scopeFolder(scope)
  if (project && own.id === project) return null
  if (project && own.parentId === project) return own.name
  return folderLabel(own.id, projects)
}

const PICK = 'folder:'

/**
 * The folder picker as a native menu: Personal, then each project as an inline group
 * with its folders under it (the native menu keeps one level of nesting, so folders
 * are rows in their project's group, not a submenu).
 */
export function folderActions(projects: readonly Folder[], current: string | null | undefined): MenuAction[] {
  const on = folderFor(current, projects)?.id ?? null
  const row = (p: Folder, parent?: Folder): MenuAction => ({
    id: `${PICK}${p.id}`, title: p.name, subtitle: parent ? `In ${parent.name}` : undefined,
    image: parent ? 'folder' : 'folder.fill', state: on === p.id ? 'on' : 'off',
  })
  const roots = projects.filter((p) => !p.parentId)
  return [
    { id: `${PICK}none`, title: PERSONAL, subtitle: 'Not filed in a project', image: 'person', state: on === null ? 'on' : 'off' },
    ...roots.map((p): MenuAction => ({
      id: `group:${p.id}`, title: '', displayInline: true,
      subactions: [row(p), ...projects.filter((f) => f.parentId === p.id).map((f) => row(f, p))],
    })),
    ...(roots.length ? [] : [{ id: 'folder-empty', title: 'Make a chat project to file tasks in it', attributes: { disabled: true } } as MenuAction]),
  ]
}

/** The folder a picker row means: an id, null for Personal, or undefined when the row is not a folder. */
export function folderPicked(actionId: string): string | null | undefined {
  if (!actionId.startsWith(PICK)) return undefined
  const id = actionId.slice(PICK.length)
  return id === 'none' ? null : id
}
