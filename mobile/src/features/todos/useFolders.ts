// The folders a task can be filed under: the chat store's project list (loaded at
// start, and again by the Tasks page when it opens), so the Tasks page, the task
// pages and the chats drawer name folders alike (web todos/folders.ts useFolders).
import { useMemo } from 'react'
import { getState, useChat } from '../../lib/chat/store'
import { folderLabel, folderNames } from './folders'

export function useFolders() {
  const projects = useChat((s) => s.projects)
  const names = useMemo(() => folderNames(projects), [projects])
  return { projects, names }
}

/** A folder's name as the store knows it now, for a chat's context about a task. */
export const folderNameNow = (id: string | null | undefined) => folderLabel(id, getState().projects)
