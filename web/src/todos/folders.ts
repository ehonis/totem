// Task folders on the web: a task is filed under one of the owner's chat projects
// or the folders inside them (`folderId`, todos/folders.mjs on the bridge), and an
// unfiled task is "Personal". Read from the chat store's project list, which the
// app loads at start, so the Tasks page and the chats panel name folders alike.
import { useEffect, useMemo } from 'react'
import { loadProjects, useChat } from '../chat/store'
import type { Project } from '../chat/types'
import type { FolderName } from './parse'

export const PERSONAL = 'Personal'

/** The project a task is filed under, if it still exists; null reads as Personal. */
export function folderFor(id: string | null | undefined, projects: readonly Project[]): Project | null {
  return (id && projects.find((p) => p.id === id)) || null
}

/** "Work - Northwind / r+d" for a folder, the name for a project, "Personal" for none. */
export function folderLabel(id: string | null | undefined, projects: readonly Project[]): string {
  const own = folderFor(id, projects)
  if (!own) return PERSONAL
  const parent = own.parentId ? projects.find((p) => p.id === own.parentId) : undefined
  return parent ? `${parent.name} / ${own.name}` : own.name
}

/** The names the quick-add line's #folder reads. */
export function folderNames(projects: readonly Project[]): FolderName[] {
  return projects.map((p) => ({ id: p.id, name: p.name, parentId: p.parentId ?? null }))
}

let asked = false

export function useFolders() {
  const projects = useChat((s) => s.projects)
  // The app reads them at start (initChat); a page opened on its own asks once.
  useEffect(() => { if (!asked && !projects.length) { asked = true; void loadProjects() } }, [projects.length])
  const names = useMemo(() => folderNames(projects), [projects])
  return { projects, names }
}
