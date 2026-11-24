// The ways in and out of a task that need the router (web work/card.ts): its page,
// a new chat for it, one of its chats, and linking a chat to a task. On the web a
// task opens as a card over the page; on the phone it is the task's own page
// (todo/[id], a sheet over the drawer), which also lists its chats.
import { router } from 'expo-router'
import { startTaskDraft } from '../../lib/chat/store'
import { closeDrawer } from '../../shell/drawerGesture'
import { openChat } from '../../shell/nav'
import { taskHome } from './state'

/** The task's page: settings, description, and the chats working on it. A sheet row opens read-only. */
export function openTask(ref: string) {
  router.push({ pathname: '/todo/[id]', params: { id: ref } })
}

/** A new chat for the task, in its folder (or where its last chat is): linked on its first send. */
export function newTaskChat(ref: string) {
  startTaskDraft(ref, taskHome(ref))
  closeDrawer()
  router.navigate('/chat')
}

/** One of the task's chats, from its page: the page and the drawer under it close. */
export function openTaskChat(threadId: string) {
  closeDrawer()
  router.back()
  openChat(threadId)
}

/** A new chat for the task, from its page. */
export function newChatFromTaskPage(ref: string) {
  router.back()
  newTaskChat(ref)
}

/** Pick (or change, or drop) the task a chat works toward. */
export function pickChatTask(threadId: string) {
  router.push({ pathname: '/chat/task', params: { id: threadId } })
}
