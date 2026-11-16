// Which task the task dialog shows (work/TaskCard.tsx), and the ways out of it
// that need App's router: a chat, a new chat for the task, the Tasks page.
// App installs the router once; the card, the chats panel, the composer's task
// strip and the Tasks page's pane all go through here.
//
// The open chat's own task is not a dialog: it is pinned at the chat's top right
// for as long as the chat is on screen (PinnedTask). Opening that task from
// anywhere (its strip, its row in the chats panel) unfolds and flashes the pinned
// panel instead of stacking a dialog over it.
import { useSyncExternalStore } from 'react'
import { setActive, startTaskDraft } from '../chat/store'
import { requestLanding } from '../landing'
import { taskHome } from './state'

let open: string | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((fn) => fn())

// Pinned task ref -> how to bring its panel forward.
const pinned = new Map<string, () => void>()

/** The chat on screen pins its task while mounted; the returned function unpins it. */
export function pinTask(ref: string, reveal: () => void): () => void {
  pinned.set(ref, reveal)
  return () => { if (pinned.get(ref) === reveal) pinned.delete(ref) }
}

export function openTaskCard(ref: string) {
  const reveal = pinned.get(ref)
  if (reveal) { reveal(); return }
  open = ref
  emit()
}
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
