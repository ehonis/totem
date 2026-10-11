// The Settings gear's dot and the app icon's badge: the unread notification count, polled
// like App.tsx does on the web (a minute late on a dot is not worth a socket), and
// re-read on return to the app.
import { useEffect, useState } from 'react'
import { AppState, Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import { getNotificationHistory } from '../../lib/push'

/** The app icon's badge follows the unread count. */
function setBadge(unread: number) {
  if (Platform.OS === 'ios') Notifications.setBadgeCountAsync(unread).catch(() => {})
}

const subs = new Set<(n: number) => void>()
let last = 0

/** Re-read now (after marking read in the notification centre). */
export function refreshUnread() {
  getNotificationHistory().then((d) => { last = d.unread; setBadge(last); subs.forEach((fn) => fn(last)) }).catch(() => {})
}

export function useUnreadNotifications(): number {
  const [n, setN] = useState(last)
  useEffect(() => {
    subs.add(setN)
    refreshUnread()
    const timer = setInterval(refreshUnread, 60_000)
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refreshUnread() })
    return () => { subs.delete(setN); clearInterval(timer); sub.remove() }
  }, [])
  return n
}

/** The same count, without a second poll: for screens that sit beside the drawer's. */
export function useUnreadCount(): number {
  const [n, setN] = useState(last)
  useEffect(() => { subs.add(setN); return () => { subs.delete(setN) } }, [])
  return n
}
