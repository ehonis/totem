// Taking a notification back once its chat has been read, the way WHOOP clears
// "off body" when the strap goes back on.
//
// APNs cannot delete a delivered notification, so the bridge sends a silent push
// naming the tags to clear (notify/apns.mjs apnsDismissPayload) and this task,
// woken in the background, dismisses them. iOS throttles silent pushes and never
// delivers one to an app swiped away, so `sweepStale` repeats the job whenever
// the app comes to the front.
//
// Defined at module scope and imported by index.ts before the router: a headless
// background launch runs the bundle without mounting the app.
import * as Notifications from 'expo-notifications'
import * as TaskManager from 'expo-task-manager'
import { getThreads } from '../lib/api'
import { getRuns } from '../lib/chat/api'
import { pendingQuestions } from '../lib/chat/questions'
import type { ChatThread } from '../lib/chat/types'

const TASK = 'totem-push-dismiss'

/**
 * What the bridge sent with a notification (notify/apns.mjs). expo-notifications
 * fills `content.data` from the payload's `body` key only; a push from a bridge
 * that predates that key carries its fields at the top level, in the raw payload.
 */
export function pushData(n: Notifications.Notification): Record<string, unknown> {
  const data = n.request.content.data as Record<string, unknown> | null
  if (data && Object.keys(data).length) return data
  const trigger = n.request.trigger as { payload?: Record<string, unknown> } | null
  return trigger?.payload || {}
}

const tagOf = (n: Notifications.Notification) => pushData(n).tag

async function dismissTags(tags: Set<string>) {
  if (!tags.size) return 0
  const shown = await Notifications.getPresentedNotificationsAsync()
  const gone = shown.filter((n) => tags.has(String(tagOf(n))))
  await Promise.all(gone.map((n) => Notifications.dismissNotificationAsync(n.request.identifier)))
  return gone.length
}

TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data }) => {
  const raw = data && 'data' in data ? (data.data as { dismiss?: unknown }).dismiss : null
  const tags = new Set(Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [])
  try {
    return (await dismissTags(tags))
      ? Notifications.BackgroundNotificationTaskResult.NewData
      : Notifications.BackgroundNotificationTaskResult.NoData
  } catch {
    return Notifications.BackgroundNotificationTaskResult.Failed
  }
})

Notifications.registerTaskAsync(TASK).catch(() => {})

/**
 * Dismiss chat notifications whose chat no longer waits on the owner: deleted,
 * or read with nothing running and no questions pending. A running chat keeps
 * its notification, since it may be asking for a hand in the browser.
 */
export async function sweepStale() {
  const shown = await Notifications.getPresentedNotificationsAsync()
  const ids = new Set(shown.map((n) => String(tagOf(n) || '')).filter((t) => t.startsWith('chat:')).map((t) => t.slice(5)))
  if (!ids.size) return
  const [{ threads }, { runs }] = await Promise.all([getThreads() as Promise<{ threads: ChatThread[] }>, getRuns()])
  const byId = new Map(threads.map((t) => [t.id, t]))
  const running = new Set(runs.filter((r) => r.status === 'running').map((r) => r.threadId))
  const stale = new Set<string>()
  for (const id of ids) {
    const t = byId.get(id)
    if (!t || (!t.needsReply && !running.has(id) && !pendingQuestions(t))) stale.add(`chat:${id}`)
  }
  await dismissTags(stale)
}
