// Native push: the same notifications the Home Screen web app gets, through APNs.
//
// The bridge decides what to send and when (notify/ — categories, quiet hours, the
// queue, the bell); the app only has to (1) hand the bridge its device token,
// (2) open the right screen when a notification is tapped, and (3) keep the icon's
// badge equal to the unread notification count. See the bridge's notify/apns.mjs.
import { useEffect } from 'react'
import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import { api, authHeaders } from '../lib/api'
import { bridgeFetch } from '../lib/connection'
import { openDashboardUrl } from '../features/notifications/openUrl'
import { refreshUnread } from '../features/notifications/useUnread'

// While the app is open a notification still shows as a banner (the Settings gear's dot
// updates too), the way Messages does it.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }),
})

export type PushStatus = 'unsupported' | 'undetermined' | 'denied' | 'registered' | 'failed'

/**
 * Ask for permission if it hasn't been asked (`prompt`), then register this phone's
 * token with the bridge. Safe to call on every launch: a token can change after a
 * restore or reinstall, and re-registering the same one only refreshes it.
 */
export async function registerForPush({ prompt = false } = {}): Promise<PushStatus> {
  if (Platform.OS !== 'ios' || !Device.isDevice) return 'unsupported'
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

function open(response: Notifications.NotificationResponse | null) {
  const data = (response?.notification.request.content.data || {}) as { url?: string; entryId?: string }
  if (!response) return
  // Opening from a notification is the strongest signal the bridge's ranking has.
  if (data.entryId) {
    bridgeFetch('/api/push/opened', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ entryId: data.entryId }),
    }).catch(() => {})
  }
  if (data.url) openDashboardUrl(data.url)
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
    return () => { sub.remove(); received.remove() }
  }, [])
}
