// Native push: the same notifications the Home Screen web app gets, through APNs.
//
// The bridge decides what to send and when (notify/ — categories, quiet hours, the
// queue, the bell); the app only has to (1) hand the bridge its device token,
// (2) open the right screen when a notification is tapped, (3) keep the icon's
// badge equal to the unread notification count, and (4) take down a chat's
// notification once the chat is read (pushDismiss.ts). See the bridge's notify/apns.mjs.
import { useEffect } from 'react'
import { AppState, Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import { api, authHeaders } from '../lib/api'
import { bridgeFetch, getBaseUrl } from '../lib/connection'
import { openDashboardUrl } from '../features/notifications/openUrl'
import { refreshUnread } from '../features/notifications/useUnread'
import { pushData, sweepStale } from './pushDismiss'

// While the app is open a notification still shows as a banner (the Settings gear's dot
// updates too), the way Messages does it.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }),
})

export type PushStatus = 'unsupported' | 'undetermined' | 'denied' | 'registered' | 'failed' | 'off'

// Settings → Notifications › Turn off. Launch registers again on every start, so
// switching push off on this phone has to be remembered here, not only on the
// bridge. It holds the server it was turned off for: another Totem still gets
// this phone registered.
const OFF_KEY = 'push_off'

export function pushTurnedOff(): boolean {
  try { return localStorage.getItem(OFF_KEY) === getBaseUrl() } catch { return false }
}

/**
 * Ask for permission if it hasn't been asked (`prompt`), then register this phone's
 * token with the bridge. Safe to call on every launch: a token can change after a
 * restore or reinstall, and re-registering the same one only refreshes it.
 */
export async function registerForPush({ prompt = false, turnOn = false } = {}): Promise<PushStatus> {
  if (Platform.OS !== 'ios' || !Device.isDevice) return 'unsupported'
  if (turnOn) {
    try { localStorage.removeItem(OFF_KEY) } catch { /* the next launch registers anyway */ }
  } else if (pushTurnedOff()) return 'off'
  let { status } = await Notifications.getPermissionsAsync()
  if (status === 'undetermined' && prompt) status = (await Notifications.requestPermissionsAsync()).status
  if (status === 'undetermined') return 'undetermined'
  if (status !== 'granted') return 'denied'
  try {
    const { data: token } = await Notifications.getDevicePushTokenAsync()
    await api('/api/push/native', {
      method: 'POST',
      body: JSON.stringify({
        token,
        label: `${Device.deviceName || Device.modelName || 'iPhone'} (app)`,
        // TestFlight and App Store builds get production tokens; a debug build gets sandbox ones.
        environment: __DEV__ ? 'sandbox' : 'production',
      }),
    })
    return 'registered'
  } catch {
    return 'failed'
  }
}

/**
 * Stop notifications to this phone: the bridge forgets its token (the web's
 * unsubscribe, with the native endpoint) and launches stop registering it.
 */
export async function turnOffPush(): Promise<void> {
  const { data: token } = await Notifications.getDevicePushTokenAsync()
  await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: `apns:${token}` }) })
  try { localStorage.setItem(OFF_KEY, getBaseUrl()) } catch { /* nothing to remember it in */ }
}

let lastTapAt = 0

/** True just after a notification opened the app, so nothing else takes the screen it opened. */
export const tappedNotificationRecently = (ms = 15_000) => Date.now() - lastTapAt < ms

function open(response: Notifications.NotificationResponse | null) {
  if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
  lastTapAt = Date.now()
  const data = pushData(response.notification)
  try {
    // Opening from a notification is the strongest signal the bridge's ranking has.
    if (typeof data.entryId === 'string' && data.entryId) {
      bridgeFetch('/api/push/opened', {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ entryId: data.entryId }),
      }).catch(() => {})
    }
    if (typeof data.url === 'string' && data.url) void openDashboardUrl(data.url)
  } catch {
    // A throw here runs inside a timer or a native callback, and kills a release build.
  }
  refreshUnread()
}

/** Mounted once inside the signed-in app. */
export function usePush() {
  useEffect(() => {
    if (Platform.OS !== 'ios') return
    // First launch after connecting asks once; after that this only refreshes the token.
    void registerForPush({ prompt: true })
    // Launched by tapping a notification: the navigator has just mounted, so defer a tick.
    const initial = Notifications.getLastNotificationResponse()
    if (initial) setTimeout(() => { open(initial); Notifications.clearLastNotificationResponse() }, 0)
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      open(r)
      Notifications.clearLastNotificationResponse()
    })
    // A notification arriving while open: the gear's dot and the badge catch up now.
    const received = Notifications.addNotificationReceivedListener(() => refreshUnread())
    // Chats read elsewhere while the silent dismissal didn't get through.
    const sweep = () => { sweepStale().catch(() => {}) }
    sweep()
    const active = AppState.addEventListener('change', (s) => { if (s === 'active') sweep() })
    return () => { sub.remove(); received.remove(); active.remove() }
  }, [])
}
