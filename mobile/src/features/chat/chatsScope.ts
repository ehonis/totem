// What the drawer's chats list shows (web chat/ChatsNav.tsx's scope): every chat, the
// ones at Home, or one project with its folders. Kept per device under the web's key,
// read by the drawer, the shelf sheet and New chat, which starts a chat in the scoped
// project (else at Home), as the web's does. Its own small module so shell/nav.ts can
// reach it without the drawer's components.
import { useSyncExternalStore } from 'react'
import { getState, openProject } from '../../lib/chat/store'
import { validScope, type SidebarScope } from '../../lib/chat/sidebar'
import type { Project } from '../../lib/chat/types'

const SCOPE_KEY = 'totem.chats.scope'
const readScope = () => { try { return localStorage.getItem(SCOPE_KEY) || 'all' } catch { return 'all' } }
let scope: string = readScope()
const subs = new Set<() => void>()

export function setSidebarScope(next: SidebarScope) {
  scope = next
  try { localStorage.setItem(SCOPE_KEY, next) } catch { /* kept for this session */ }
  subs.forEach((fn) => fn())
}

/** The scope, or every chat once its project is gone. */
export function useSidebarScope(projects: Project[]): SidebarScope {
  const raw = useSyncExternalStore((fn) => { subs.add(fn); return () => { subs.delete(fn) } }, () => scope, () => scope)
  return validScope(raw, projects)
}

/** The scope a param names (the shelf sheet's), checked against the projects. */
export const scopeFrom = (raw: string | undefined, projects: Project[]) => validScope(raw ?? scope, projects)

/** Where New chat starts one: the project the list is scoped to, else Home. */
export function newChatInScope() {
  const s = validScope(scope, getState().projects)
  openProject(s !== 'all' && s !== 'home' ? s : null)
}
