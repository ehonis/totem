// Which task the floating task card shows (work/TaskCard.tsx), and the ways out of
// it that need App's router: a chat, a new chat for the task, the Tasks page.
// App installs the router once; the card, the chats panel, the composer's task
// strip and the Tasks page's pane all go through here.
import { useSyncExternalStore } from 'react'
import { setActive, startTaskDraft } from '../chat/store'
import { requestLanding } from '../landing'
import { taskHome } from './state'

let open: string | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((fn) => fn())

export function openTaskCard(ref: string) { open = ref; emit() }
export function closeTaskCard() { if (open !== null) { open = null; emit() } }
export function useTaskCard(): string | null {
  return useSyncExternalStore((fn) => { subs.add(fn); return () => { subs.delete(fn) } }, () => open)
}

interface Nav {
  /** App's navigate, for the chat and the Tasks page. */
  navigate: (target: 'chat' | { tab: 'productivity'; app: 'todos' }) => void
}
let nav: Nav | null = null

export function installTaskNav(n: Nav): () => void {
  nav = n
  return () => { if (nav === n) nav = null }
}

/** Open one of the task's chats. */
export function openTaskChat(threadId: string) {
  setActive(threadId)
  nav?.navigate('chat')
}

/** Start a new chat for the task, in its folder. */
export function newTaskChat(ref: string) {
  startTaskDraft(ref, taskHome(ref))
  nav?.navigate('chat')
}

/** Show the task on the Tasks page, scrolled to and flashed (landing.ts). */
export function showInTasks(ref: string) {
  if (!ref.startsWith('sheet:')) requestLanding('task', ref)
  nav?.navigate({ tab: 'productivity', app: 'todos' })
}
